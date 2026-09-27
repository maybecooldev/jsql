import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { emptySchema, isMixed, observe, typeOf } from '../src/schema.ts';
import { Aggregator } from '../src/table.ts';
import { renderNdjson, renderSchema, table } from '../src/format.ts';

function agg(records: Array<Record<string, unknown>>, options = {}) {
  const aggregator = new Aggregator(options);
  for (const record of records) aggregator.add(record);
  return aggregator.finish();
}

const SALES = [
  { country: 'BR', amount: 10, cached: true },
  { country: 'BR', amount: 20, cached: false },
  { country: 'US', amount: 5, cached: false },
  { country: 'US', amount: 7, cached: true },
  { country: 'PT', amount: 3, cached: false },
];

describe('schema inference', () => {
  test('typeOf classifies the basics', () => {
    assert.equal(typeOf(1), 'number');
    assert.equal(typeOf('a'), 'string');
    assert.equal(typeOf(true), 'boolean');
    assert.equal(typeOf(null), 'null');
    assert.equal(typeOf([]), 'array');
    assert.equal(typeOf({}), 'object');
    assert.equal(typeOf(NaN), 'null');
  });

  test('tracks presence per column', () => {
    const result = agg([{ a: 1 }, { a: 2 }, { b: 'x' }]);
    const byName = Object.fromEntries(result.schema.columns.map((c) => [c.name, c]));
    assert.equal(byName.a.present, 2);
    assert.equal(byName.b.present, 1);
  });

  test('null values do not count as present', () => {
    const result = agg([{ a: null }, { a: 1 }]);
    const [column] = result.schema.columns;
    assert.equal(column.present, 1);
    assert.deepEqual(column.types, ['number']);
  });

  test('records min and max for numeric columns', () => {
    const result = agg(SALES);
    const amount = result.schema.columns.find((c) => c.name === 'amount')!;
    assert.equal(amount.min, 3);
    assert.equal(amount.max, 20);
  });

  test('flags a column seen with two types', () => {
    const result = agg([{ a: 1 }, { a: 'one' }]);
    const [column] = result.schema.columns;
    assert.ok(isMixed(column));
    assert.deepEqual(column.types, ['number', 'string']);
  });

  test('a clean column is not mixed', () => {
    const result = agg(SALES);
    assert.ok(result.schema.columns.every((c) => !isMixed(c)));
  });

  test('empty input produces an empty schema', () => {
    const result = agg([]);
    assert.equal(result.total, 0);
    assert.equal(result.schema.recordCount, 0);
    assert.deepEqual(result.schema.columns, []);
  });

  test('observe mutates and returns the same schema', () => {
    const schema = emptySchema();
    assert.equal(observe(schema, { a: 1 }), schema);
  });
});

describe('filtering', () => {
  test('counts total and matched separately', () => {
    const result = agg(SALES, { filter: 'amount > 5' });
    assert.equal(result.total, 5);
    assert.equal(result.matched, 3);
  });

  test('filtering composes with grouping', () => {
    const result = agg(SALES, { filter: 'cached == false', groupBy: 'country' });
    assert.equal(result.groups.length, 3);
    assert.equal(
      result.groups.find((g) => g.key === 'BR')!.count,
      1,
    );
  });

  test('schema is computed over all records, not just matches', () => {
    // A field that only appears in filtered-out rows is still part of the shape
    const result = agg([{ a: 1, b: 1 }, { a: 2 }], { filter: 'a > 1' });
    assert.deepEqual(
      result.schema.columns.map((c) => c.name).sort(),
      ['a', 'b'],
    );
  });
});

describe('grouping and aggregation', () => {
  test('groups by field and counts rows', () => {
    const result = agg(SALES, { groupBy: 'country' });
    const counts = Object.fromEntries(result.groups.map((g) => [g.key, g.count]));
    assert.deepEqual(counts, { BR: 2, PT: 1, US: 2 });
  });

  test('groups come back sorted by key', () => {
    const result = agg(SALES, { groupBy: 'country' });
    assert.deepEqual(
      result.groups.map((g) => g.key),
      ['BR', 'PT', 'US'],
    );
  });

  test('without a group-by each record is its own group', () => {
    // This is what makes `--filter` + `--select` a projection over matching
    // rows rather than a collapse of the whole file.
    const result = agg(SALES);
    assert.equal(result.grouped, false);
    assert.equal(result.groups.length, SALES.length);
    assert.equal(result.matched, 5);
  });

  test('an ungrouped result exposes the record fields', () => {
    const result = agg(SALES);
    assert.equal(result.groups[0].value.country, 'BR');
    assert.equal(result.groups[0].value.amount, 10);
  });

  test('an ungrouped projection keeps the matching rows', () => {
    const result = agg(SALES, { filter: 'country == "US"', select: 'amount, cached' });
    assert.deepEqual(
      result.groups.map((g) => g.value),
      [
        { amount: 5, cached: false },
        { amount: 7, cached: true },
      ],
    );
  });

  test('sum, min, max and avg', () => {
    const result = agg(SALES, {
      groupBy: 'country',
      operations: [
        { kind: 'sum', field: 'amount' },
        { kind: 'min', field: 'amount' },
        { kind: 'max', field: 'amount' },
        { kind: 'avg', field: 'amount' },
      ],
    });
    const br = result.groups.find((g) => g.key === 'BR')!.value;
    // Aggregates are keyed <field>_<op> so several can coexist on one group.
    assert.equal(br.amount_sum, 30);
    assert.equal(br.amount_min, 10);
    assert.equal(br.amount_max, 20);
    assert.equal(br.amount_avg, 15);
  });

  test('non-numeric values are skipped rather than coerced to zero', () => {
    const result = agg([{ a: 'x' }, { a: 4 }], {
      groupBy: 'a',
      operations: [{ kind: 'sum', field: 'a' }],
    });
    const withNumber = result.groups.find((g) => g.value.a === 4)!;
    assert.equal(withNumber.value.a_sum, 4);
  });

  test('a group with no numeric values at all aggregates to null', () => {
    const result = agg([{ a: 'x' }], {
      groupBy: 'a',
      operations: [{ kind: 'sum', field: 'a' }],
    });
    assert.equal(result.groups[0].value.a_sum, null);
  });

  test('one field is accumulated once regardless of how many aggregates use it', () => {
    // Regression: summing the same field for sum/avg/min/max must not add it
    // four times over.
    const result = agg(SALES, {
      groupBy: 'country',
      operations: [
        { kind: 'sum', field: 'amount' },
        { kind: 'avg', field: 'amount' },
        { kind: 'min', field: 'amount' },
        { kind: 'max', field: 'amount' },
      ],
    });
    assert.equal(result.groups.find((g) => g.key === 'BR')!.value.amount_sum, 30);
  });

  test('limit truncates the group list', () => {
    const result = agg(SALES, { groupBy: 'country', limit: 2 });
    assert.equal(result.groups.length, 2);
  });

  test('select projects only the requested columns', () => {
    const result = agg(SALES, { groupBy: 'country', select: 'coalesce(nope, "none") as country' });
    assert.deepEqual(Object.keys(result.groups[0].value), ['country']);
    assert.equal(result.groups[0].value.country, 'none');
  });

  test('select splits on top-level commas only', () => {
    const result = agg(SALES, {
      groupBy: 'country',
      operations: [{ kind: 'sum', field: 'amount' }],
      select: 'country, coalesce(nope, "x") as fallback, amount_sum',
    });
    assert.deepEqual(Object.keys(result.groups[0].value), ['country', 'fallback', 'amount_sum']);
    assert.equal(result.groups[0].value.amount_sum, 30);
  });

  test('select without `as` names a plain field after itself', () => {
    const result = agg(SALES, { groupBy: 'country', select: 'country, amount_sum' });
    assert.equal(result.groups[0].value.country, 'BR');
  });
});

describe('formatting', () => {
  test('ndjson emits one object per group', () => {
    const result = agg(SALES, { groupBy: 'country' });
    const lines = renderNdjson(result).split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).count, 2);
  });

  test('schema output names every column', () => {
    const output = renderSchema(agg(SALES));
    assert.match(output, /country/);
    assert.match(output, /amount/);
    assert.match(output, /5 record\(s\)/);
  });

  test('table pads columns to a consistent width', () => {
    const lines = table(['A', 'BBBB'], [['x', 'y']]);
    assert.equal(lines.length, 3);
    assert.equal(lines[1], '-  ----');
  });

  test('an empty result renders without throwing', () => {
    const result = agg([], { groupBy: 'country' });
    assert.equal(renderNdjson(result), '');
  });
});
