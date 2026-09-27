/**
 * Schema inference over a stream of records.
 *
 * JSONL has no schema, so the useful thing a tool can do is tell you what
 * shape the data actually has — including the disagreements. A field that is
 * a number in 9,998 rows and a string in 2 is a bug in the producer, and
 * that is exactly the kind of thing a schema tool should surface rather than
 * quietly coerce away.
 */

export type ColumnType = 'number' | 'string' | 'boolean' | 'null' | 'object' | 'array';

export interface ColumnStats {
  name: string;
  /** Number of records in which the field was present and non-null. */
  present: number;
  /** Types observed, in first-seen order. More than one means mixed. */
  types: ColumnType[];
  min?: number;
  max?: number;
  /** For string columns, the longest value seen. */
  longest?: number;
  /** The field name spelling that appeared most often. */
  canonical: string;
  /** How many distinct spellings this field has been seen under. */
  spellings: Set<string>;
}

export interface Schema {
  columns: ColumnStats[];
  recordCount: number;
  malformedLines: number[];
}

const EMPTY: Schema = { columns: [], recordCount: 0, malformedLines: [] };

export function typeOf(value: unknown): ColumnType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? 'number' : 'null';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

/**
 * Merge a single record into a schema.
 *
 * A per-statement schema object is carried through the whole file rather than
 * a two-pass approach: these files routinely do not fit in memory, and a
 * second read of a growing log is not always possible.
 */
export function observe(schema: Schema, record: Record<string, unknown>): Schema {
  schema.recordCount++;
  const byName = new Map(schema.columns.map((c) => [c.name, c]));

  for (const [key, value] of Object.entries(record)) {
    const type = typeOf(value);
    if (type === 'null') continue;

    let column = byName.get(key);
    if (!column) {
      column = {
        name: key,
        present: 0,
        types: [],
        canonical: key,
        spellings: new Set([key]),
      };
      schema.columns.push(column);
      byName.set(key, column);
    }

    column.present++;
    column.spellings.add(key);
    if (!column.types.includes(type)) column.types.push(type);
    if (column.spellings.size > 1) {
      // Prefer the spelling that occurs most; ties go to the shorter name so
      // the result does not depend on insertion order.
      const best = [...column.spellings].sort(
        (a, b) => a.length - b.length || a.localeCompare(b),
      )[0];
      column.canonical = best;
    }

    if (type === 'number') {
      const n = value as number;
      column.min = column.min === undefined ? n : Math.min(column.min, n);
      column.max = column.max === undefined ? n : Math.max(column.max, n);
    } else if (type === 'string') {
      column.longest = Math.max(column.longest ?? 0, (value as string).length);
    }
  }

  return schema;
}

export function emptySchema(): Schema {
  return { columns: [], recordCount: 0, malformedLines: [] };
}

export { EMPTY as EMPTY_SCHEMA };

/** True when a column has been seen with more than one type. */
export function isMixed(column: ColumnStats): boolean {
  return column.types.length > 1;
}

export function typeLabel(column: ColumnStats): string {
  return column.types.join('|') || 'null';
}
