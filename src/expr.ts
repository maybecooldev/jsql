/**
 * A small expression language for filtering records.
 *
 * Syntax is a deliberate subset of what people already type into `jq` and
 * SQL REPLs, so that a query written for one is readable here:
 *
 *   age >= 18 and country == "BR"
 *   not archived and tags contains "beta"
 *   age in [18, 21, 65]
 *   name matches "^ada"
 *   coalesce(nickname, name) != ""
 *
 * Implemented as a hand-written lexer plus a Pratt parser. A precedence-climbing
 * table is a handful more lines than a hack that splits on `and`, and it is the
 * difference between `a or b and c` meaning what the reader expects.
 */

export class ExprError extends Error {}

type TokenType =
  | 'number'
  | 'string'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbrack'
  | 'rbrack'
  | 'comma'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

/** Binding powers, loosest first. */
const BINARY_PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  contains: 4,
  in: 4,
  matches: 4,
  startsWith: 4,
  endsWith: 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const WORD_OPERATORS = new Set([
  'and',
  'or',
  'not',
  'contains',
  'in',
  'matches',
  'startsWith',
  'endsWith',
  'true',
  'false',
  'null',
]);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          value +=
            { n: '\n', t: '\t', r: '\r' }[next as 'n' | 't' | 'r'] ??
            (next === quote || next === '\\' ? next : '\\' + next);
          i += 2;
          continue;
        }
        value += input[i++];
      }
      if (i >= input.length) throw new ExprError(`unterminated string at position ${tokens.length}`);
      i++;
      tokens.push({ type: 'string', value, pos: i });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const start = i;
      if (input[i] === '-') i++;
      while (i < input.length && /[0-9.eE]/.test(input[i])) {
        // Stop before an 'e' that is not part of an exponent.
        if (/[eE]/.test(input[i]) && !/[0-9+-]/.test(input[i + 1] ?? '')) break;
        i++;
      }
      const raw = input.slice(start, i);
      const num = Number(raw);
      if (Number.isNaN(num)) throw new ExprError(`invalid number: ${raw}`);
      tokens.push({ type: 'number', value: raw, pos: start });
      continue;
    }

    if (/[A-Za-z_.]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_.]/.test(input[i])) i++;
      const word = input.slice(start, i);
      if (word === 'not' || WORD_OPERATORS.has(word)) {
        tokens.push({ type: 'op', value: word, pos: start });
      } else {
        tokens.push({ type: 'ident', value: word, pos: start });
      }
      continue;
    }

    const two = input.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }

    const single: Record<string, TokenType> = {
      '(': 'lparen',
      ')': 'rparen',
      '[': 'lbrack',
      ']': 'rbrack',
      ',': 'comma',
    };
    if (single[ch]) {
      tokens.push({ type: single[ch], value: ch, pos: i });
      i++;
      continue;
    }

    if ('+-*/%<>!'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }

    throw new ExprError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Expr =
  | { kind: 'literal'; value: unknown }
  | { kind: 'field'; path: string[] }
  | { kind: 'unary'; op: string; operand: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'list'; items: Expr[] };

const ALIASES: Record<string, string> = { '&&': 'and', '||': 'or', '!': 'not' };

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  /** How many tokens have been consumed so far. */
  position(): number {
    return this.index;
  }

  private expect(type: TokenType, what: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new ExprError(`expected ${what} but found ${JSON.stringify(token.value || 'end of input')}`);
    }
    return this.next();
  }

  parse(): Expr {
    const expr = this.parseExpression(0);
    if (this.peek().type !== 'eof') {
      throw new ExprError(`unexpected ${JSON.stringify(this.peek().value)}`);
    }
    return expr;
  }

  private parseExpression(minPrecedence: number): Expr {
    let left = this.parsePrefix();

    for (;;) {
      const token = this.peek();
      if (token.type !== 'op') break;
      const op = ALIASES[token.value] ?? token.value;
      const precedence = BINARY_PRECEDENCE[op];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const right = this.parseExpression(precedence + 1);
      left = { kind: 'binary', op, left, right };
    }

    return left;
  }

  private parsePrefix(): Expr {
    const token = this.next();

    if (token.type === 'number') return { kind: 'literal', value: Number(token.value) };
    if (token.type === 'string') return { kind: 'literal', value: token.value };
    if (token.type === 'lparen') {
      const inner = this.parseExpression(0);
      this.expect('rparen', ')');
      return inner;
    }
    if (token.type === 'lbrack') {
      const items: Expr[] = [];
      if (this.peek().type !== 'rbrack') {
        do {
          items.push(this.parseExpression(0));
        } while (this.peek().type === 'comma' && this.next());
      }
      this.expect('rbrack', ']');
      return { kind: 'list', items };
    }
    if (token.type === 'op' && token.value === 'not') {
      return { kind: 'unary', op: 'not', operand: this.parseExpression(3) };
    }
    if (token.type === 'op' && (token.value === 'true' || token.value === 'false')) {
      return { kind: 'literal', value: token.value === 'true' };
    }
    if (token.type === 'op' && token.value === 'null') {
      return { kind: 'literal', value: null };
    }
    if (token.type === 'ident') {
      if (this.peek().type === 'lparen') {
        this.next();
        const args: Expr[] = [];
        if (this.peek().type !== 'rparen') {
          do {
            args.push(this.parseExpression(0));
          } while (this.peek().type === 'comma' && this.next());
        }
        this.expect('rparen', ')');
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'field', path: token.value.split('.') };
    }

    throw new ExprError(`unexpected ${JSON.stringify(token.value || 'end of input')}`);
  }
}

export function parse(source: string): Expr {
  return new Parser(tokenize(source)).parse();
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type Record_ = Record<string, unknown>;

export function lookup(record: Record_, path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  lower: (v) => String(v ?? '').toLowerCase(),
  upper: (v) => String(v ?? '').toUpperCase(),
  trim: (v) => String(v ?? '').trim(),
  len: (v) => (Array.isArray(v) ? v.length : v === null || v === undefined ? 0 : String(v).length),
  abs: (v) => Math.abs(asNumber(v) ?? 0),
  round: (v, d) => {
    const factor = 10 ** (asNumber(d) ?? 0);
    return Math.round((asNumber(v) ?? 0) * factor) / factor;
  },
  coalesce: (...args) => args.find((a) => a !== null && a !== undefined) ?? null,
  number: (v) => asNumber(v),
  string: (v) => (v === null || v === undefined ? '' : String(v)),
  startsWith: (v, p) => String(v ?? '').startsWith(String(p ?? '')),
  endsWith: (v, p) => String(v ?? '').endsWith(String(p ?? '')),
  contains: (v, p) =>
    Array.isArray(v) ? v.includes(p) : String(v ?? '').includes(String(p ?? '')),
};

export function evaluate(expr: Expr, record: Record_): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'field':
      return lookup(record, expr.path);
    case 'list':
      return expr.items.map((item) => evaluate(item, record));
    case 'unary': {
      const value = evaluate(expr.operand, record);
      if (expr.op === 'not') return !truthy(value);
      throw new ExprError(`unknown unary operator ${expr.op}`);
    }
    case 'call': {
      const fn = FUNCTIONS[expr.name];
      if (!fn) throw new ExprError(`unknown function ${expr.name}()`);
      return fn(...expr.args.map((arg) => evaluate(arg, record)));
    }
    case 'binary':
      return applyBinary(expr, record);
  }
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0';
  return Boolean(value);
}

function applyBinary(expr: Extract<Expr, { kind: 'binary' }>, record: Record_): unknown {
  const { op } = expr;

  // Short-circuit before evaluating the right side, so `a != null and a.b` is safe.
  if (op === 'and') {
    return truthy(evaluate(expr.left, record)) ? truthy(evaluate(expr.right, record)) : false;
  }
  if (op === 'or') {
    return truthy(evaluate(expr.left, record)) || truthy(evaluate(expr.right, record));
  }

  const left = evaluate(expr.left, record);
  const right = evaluate(expr.right, record);

  switch (op) {
    case '==':
      return looseEqual(left, right);
    case '!=':
      return !looseEqual(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = asNumber(left);
      const b = asNumber(right);
      if (a === null || b === null) {
        const x = String(left ?? '');
        const y = String(right ?? '');
        return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
      }
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    }
    case 'contains':
      return FUNCTIONS.contains!(left, right);
    case 'startsWith':
      return FUNCTIONS.startsWith!(left, right);
    case 'endsWith':
      return FUNCTIONS.endsWith!(left, right);
    case 'in':
      return Array.isArray(right) && right.some((item) => looseEqual(item, left));
    case 'matches':
      try {
        return new RegExp(String(right)).test(String(left ?? ''));
      } catch {
        throw new ExprError(`invalid regular expression: ${String(right)}`);
      }
    case '+':
      return asNumber(left)! + asNumber(right)!;
    case '-':
      return asNumber(left)! - asNumber(right)!;
    case '*':
      return asNumber(left)! * asNumber(right)!;
    case '/':
      return asNumber(right) === 0 ? null : asNumber(left)! / asNumber(right)!;
    case '%':
      return asNumber(right) === 0 ? null : asNumber(left)! % asNumber(right)!;
    default:
      throw new ExprError(`unknown operator ${op}`);
  }
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined) return right === null || right === undefined;
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}

export interface Projection {
  name: string;
  expr: Expr;
}

/**
 * Parse a projection list: `a, b, sum(x) as total`.
 *
 * Splitting on commas by hand would break on `coalesce(a, b)`, so the
 * tokenizer does the work: split on top-level commas only, and treat `as` as
 * a rename rather than part of the expression.
 */
export function parseSelect(source: string): Projection[] {
  const tokens = tokenize(source);
  const projections: Projection[] = [];
  let index = 0;

  while (index < tokens.length) {
    const parser = new Parser(tokens.slice(index));
    const expr = parser.parseExpression(0);
    index += parser.position();

    let name = expr.kind === 'field' ? expr.path.join('.') : `col${projections.length + 1}`;

    const rest = tokens[index];
    if (rest?.type === 'ident' && rest.value === 'as') {
      const alias = tokens[index + 1];
      if (!alias || alias.type !== 'ident') {
        throw new ExprError('expected a name after `as`');
      }
      name = alias.value;
      index += 2;
    }

    projections.push({ name, expr });

    if (tokens[index]?.type === 'comma') {
      index++;
      continue;
    }
    break;
  }

  return projections;
}

/** Parse and compile once, then run against many records. */
export function compile(source: string): (record: Record_) => boolean {
  const expr = parse(source);
  return (record) => truthy(evaluate(expr, record));
}
