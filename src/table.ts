/**
 * Streaming aggregation.
 *
 * Everything here works one record at a time and keeps only the accumulators
 * in memory. A group-by over a 40GB log should use a few hundred megabytes,
 * not 40GB, and the row counter should never be a reason to buffer.
 */

import { compile, evaluate, parse, parseSelect, truthy, type Projection, type Record_ } from './expr.ts';
import { emptySchema, observe, type Schema } from './schema.ts';

export interface Aggregate {
  kind: 'count';
}

export interface Sum {
  kind: 'sum' | 'min' | 'max' | 'avg';
  field: string;
}

export type Operation = Aggregate | Sum;

export interface Options {
  filter?: string;
  groupBy?: string;
  operations?: Operation[];
  select?: string;
  limit?: number;
}

export interface Group {
  key: string;
  value: Record_;
  count: number;
  /** Sum/min/max/avg accumulators, keyed by field name. */
  stats: Map<string, { sum: number; count: number; min: number; max: number }>;
}

export interface Result {
  schema: Schema;
  groups: Group[];
  total: number;
  matched: number;
  /** False when no --group-by was given, in which case each record is its own group. */
  grouped: boolean;
}

const NUMERIC_OPS = new Set(['sum', 'min', 'max', 'avg']);

export class Aggregator {
  private readonly filterFn: ((record: Record_) => boolean) | undefined;
  private readonly groupExpr: ReturnType<typeof parse> | undefined;
  private readonly groupBySource: string | null;
  private readonly projections: Projection[] | undefined;
  /** Distinct fields to accumulate, so one field is summed once, not once per op. */
  private readonly statFields: string[];
  private readonly schema = emptySchema();
  private readonly groups = new Map<string, Group>();
  private total = 0;
  private matched = 0;

  private readonly options: Options;

  constructor(options: Options = {}) {
    this.options = options;
    this.filterFn = options.filter ? compile(options.filter) : undefined;
    this.groupExpr = options.groupBy ? parse(options.groupBy) : undefined;
    this.projections = options.select?.trim() ? parseSelect(options.select) : undefined;
    this.statFields = [
      ...new Set(
        (options.operations ?? [])
          .filter((operation) => operation.kind !== 'count')
          .map((operation) => operation.field),
      ),
    ];
    this.groupBySource = options.groupBy ?? null;
  }

  add(record: Record_): void {
    this.total++;
    observe(this.schema, record);

    if (this.filterFn && !this.filterFn(record)) return;
    this.matched++;

    // With no grouping expression every record is its own group, so that
    // `--filter` plus `--select` behaves like a projection over the matching
    // rows rather than collapsing the file into one aggregate.
    const key = this.groupExpr ? renderKey(evaluate(this.groupExpr, record)) : `@${this.groups.size}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { key, value: {}, count: 0, stats: new Map() };
      this.groups.set(key, group);
    }
    group.count++;

    // Keep the grouping key addressable, so `--select country` works on a
    // group and `country_sum` style projections have something to sit on.
    if (this.groupBySource) {
      group.value[this.groupBySource] = evaluate(this.groupExpr!, record);
    } else {
      // Ungrouped: the group's value is the record itself, so `--select` has
      // real fields to project.
      Object.assign(group.value, record);
    }

    for (const field of this.statFields) {
      const value = evaluate(parse(field), record);
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const acc = group.stats.get(field) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
      acc.sum += value;
      acc.count++;
      acc.min = Math.min(acc.min, value);
      acc.max = Math.max(acc.max, value);
      group.stats.set(field, acc);
    }
  }

  finish(): Result {
    const groups = [...this.groups.values()].map((group) => {
      // Aggregates land under `<field>_<op>` so several can coexist on one
      // group instead of overwriting each other.
      const value: Record_ = { ...group.value };
      for (const operation of this.options.operations ?? []) {
        if (operation.kind === 'count') continue;
        const acc = group.stats.get(operation.field);
        const key = `${operation.field}_${operation.kind}`;
        value[key] = !acc
          ? null
          : operation.kind === 'sum'
            ? acc.sum
            : operation.kind === 'min'
              ? acc.min
              : operation.kind === 'max'
                ? acc.max
                : acc.sum / acc.count;
      }
      if (this.projections) {
        const picked: Record_ = {};
        for (const projection of this.projections) {
          picked[projection.name] = evaluate(projection.expr, value);
        }
        return { ...group, value: picked };
      }
      return { ...group, value };
    });

    const grouped = Boolean(this.groupExpr);
    const sorted = grouped
      ? [...groups].sort((a, b) => String(a.key).localeCompare(String(b.key)))
      : groups;

    return {
      schema: this.schema,
      groups: this.options.limit ? sorted.slice(0, this.options.limit) : sorted,
      total: this.total,
      matched: this.matched,
      grouped,
    };
  }
}

function renderKey(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export { NUMERIC_OPS };
export type { Record_ };
export { truthy };
