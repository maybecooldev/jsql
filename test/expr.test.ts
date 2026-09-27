import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { compile, evaluate, parse, tokenize, ExprError } from '../src/expr.ts';

const record = {
  age: 30,
  name: 'Ada',
  country: 'BR',
  active: true,
  tags: ['beta', 'urgent'],
  profile: { city: 'Recife', score: 4.5 },
  missing: null,
};

function run(source: string) {
  return evaluate(parse(source), record);
}

describe('literals and fields', () => {
  test('numbers, strings, booleans', () => {
    assert.equal(run('42'), 42);
    assert.equal(run('-7'), -7);
    assert.equal(run('3.5e2'), 350);
    assert.equal(run('"hi"'), 'hi');
    assert.equal(run("'hi'"), 'hi');
    assert.equal(run('true'), true);
    assert.equal(run('null'), null);
  });

  test('field access, including nested', () => {
    assert.equal(run('age'), 30);
    assert.equal(run('profile.city'), 'Recife');
    assert.equal(run('profile.nope'), undefined);
  });

  test('escapes in strings', () => {
    assert.equal(evaluate(parse('"a\\nb"'), record), 'a\nb');
    assert.equal(evaluate(parse('"say \\"hi\\""'), record), 'say "hi"');
  });
});

describe('operators', () => {
  test('comparison', () => {
    assert.equal(run('age > 18'), true);
    assert.equal(run('age >= 30'), true);
    assert.equal(run('age < 18'), false);
    assert.equal(run('name != "Bob"'), true);
  });

  test('equality coerces across types like a shell would', () => {
    assert.equal(run('age == "30"'), true);
    assert.equal(run('active == true'), true);
  });

  test('and/or short-circuit and respect precedence', () => {
    // and binds tighter than or, so this is `age>18 and (country=="BR" or country=="PT")`
    assert.equal(run('age > 18 and country == "BR" or country == "PT"'), true);
    assert.equal(run('country == "PT" and age > 18 or country == "BR"'), true);
    assert.equal(run('age > 40 and country == "BR"'), false);
  });

  test('not binds tighter than and', () => {
    assert.equal(run('not active and age > 18'), false);
  });

  test('explicit parentheses override precedence', () => {
    assert.equal(run('(age > 40 or country == "BR") and active'), true);
  });

  test('arithmetic', () => {
    assert.equal(run('1 + 2 * 3'), 7);
    assert.equal(run('(1 + 2) * 3'), 9);
    assert.equal(run('7 % 3'), 1);
  });

  test('division by zero yields null instead of Infinity', () => {
    assert.equal(run('1 / 0'), null);
  });

  test('C-style aliases', () => {
    assert.equal(run('age >= 18 && country == "BR"'), true);
    assert.equal(run('age < 18 || country == "BR"'), true);
  });
});

describe('word operators', () => {
  test('contains works on arrays and strings', () => {
    assert.equal(run('tags contains "urgent"'), true);
    assert.equal(run('tags contains "nope"'), false);
    assert.equal(run('name contains "Ad"'), true);
  });

  test('in tests membership in a list literal', () => {
    assert.equal(run('age in [18, 30, 65]'), true);
    assert.equal(run('age in [18, 65]'), false);
  });

  test('matches tests a regular expression', () => {
    assert.equal(run('name matches "^A"'), true);
    assert.equal(run('name matches "^B"'), false);
  });

  test('startsWith and endsWith', () => {
    assert.equal(run('name startsWith "A"'), true);
    assert.equal(run('name endsWith "a"'), true);
  });
});

describe('functions', () => {
  test('string functions', () => {
    assert.equal(run('lower(name)'), 'ada');
    assert.equal(run('upper(name)'), 'ADA');
    assert.equal(run('len(name)'), 3);
  });

  test('len on an array counts elements', () => {
    assert.equal(run('len(tags)'), 2);
  });

  test('coalesce skips null and undefined', () => {
    assert.equal(run('coalesce(missing, name)'), 'Ada');
    assert.equal(run('coalesce(nope, alsonope, "fallback")'), 'fallback');
  });

  test('numeric helpers', () => {
    assert.equal(run('abs(0 - 7)'), 7);
    assert.equal(run('round(profile.score)'), 5);
    assert.equal(run('round(profile.score, 1)'), 4.5);
  });
});

describe('errors', () => {
  test('unterminated string is rejected', () => {
    assert.throws(() => parse('name == "Ada'), ExprError);
  });

  test('unknown function is rejected at evaluation', () => {
    assert.throws(() => run('nope(name)'), /unknown function/);
  });

  test('unbalanced parenthesis is rejected', () => {
    assert.throws(() => parse('(age > 1'), ExprError);
  });

  test('stray character is rejected', () => {
    assert.throws(() => parse('age @ 3'), ExprError);
  });

  test('invalid regex is reported, not thrown raw', () => {
    assert.throws(() => run('name matches "["'), /invalid regular expression/);
  });
});

describe('truthiness', () => {
  const cases: Array<[string, boolean]> = [
    ['0', false],
    ['1', true],
    ['""', false],
    ['"x"', true],
    ['"false"', false],
    ['"0"', false],
    ['[]', false],
    ['[1]', true],
    ['null', false],
  ];
  for (const [source, expected] of cases) {
    test(`${source || 'empty'} is ${expected ? 'truthy' : 'falsy'}`, () => {
      assert.equal(compile(source)(record), expected);
    });
  }
});

describe('compile', () => {
  test('returns a reusable predicate', () => {
    const isBR = compile('country == "BR"');
    assert.equal(isBR({ country: 'BR' }), true);
    assert.equal(isBR({ country: 'US' }), false);
  });

  test('short-circuits before the right side is evaluated', () => {
    // `profile.nope.deep` would be a crash if evaluated eagerly
    assert.equal(compile('missing != null and missing.deep == 1')(record), false);
  });
});

describe('tokenizer', () => {
  test('counts positions for error messages', () => {
    const tokens = tokenize('age >= 18');
    assert.deepEqual(
      tokens.slice(0, 3).map((t) => t.type),
      ['ident', 'op', 'number'],
    );
  });
});
