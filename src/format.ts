/**
 * Rendering: a table for humans, NDJSON for pipes, plain values for --count.
 */

import type { Result } from './table.ts';
import { isMixed, typeLabel, type ColumnStats } from './schema.ts';

export function renderSchema(result: Result): string {
  const lines: string[] = [];
  lines.push(`${result.total} record(s), ${result.schema.columns.length} field(s)`);
  if (result.schema.malformedLines.length) {
    lines.push(`${result.schema.malformedLines.length} malformed line(s)`);
  }
  lines.push('');

  const rows = result.schema.columns
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((column) => [
      column.name,
      typeLabel(column),
      String(column.present),
      rangeLabel(column),
      flagLabel(column),
    ]);

  lines.push(...table(['FIELD', 'TYPE', 'PRESENT', 'RANGE', 'FLAGS'], rows));
  return lines.join('\n');
}

function rangeLabel(column: ColumnStats): string {
  if (column.min !== undefined) {
    const same = column.min === column.max;
    return same ? String(column.min) : `${column.min}..${column.max}`;
  }
  if (column.longest !== undefined) return `max ${column.longest} chars`;
  return '-';
}

function flagLabel(column: ColumnStats): string {
  const flags: string[] = [];
  if (isMixed(column)) flags.push('MIXED');
  if (column.spellings.size > 1) flags.push('ALIASED');
  return flags.join(' ') || '-';
}

export function renderTable(result: Result): string {
  if (result.groups.length === 0) return '(no rows)';

  const columns = new Set<string>();
  for (const group of result.groups) {
    for (const key of Object.keys(group.value)) columns.add(key);
    if (result.grouped) columns.add('count');
  }

  // The synthetic group key carries no meaning when nothing was grouped, so
  // it only earns a column when there is a real key to show.
  const keyed = result.grouped;
  const header = [...(keyed ? ['GROUP'] : []), ...columns];
  const names = [...columns].filter((name) => name !== 'GROUP');
  const rows = result.groups.map((group) => [
    ...(keyed ? [group.key] : []),
    ...names.map((name) =>
      name === 'count' ? String(group.count) : stringify(group.value[name]),
    ),
  ]);

  return table(header, rows).join('\n');
}

export function renderNdjson(result: Result): string {
  return result.groups
    .map((group) =>
      // Without a group-by each group is one record, so a synthetic count of 1
      // would just be noise in the output.
      JSON.stringify(result.grouped ? { ...group.value, count: group.count } : group.value),
    )
    .join('\n');
}

export function stringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Fixed-width table with a separator under the header. */
export function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
      .join('  ')
      .trimEnd();

  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}
