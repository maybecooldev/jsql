#!/usr/bin/env node
/**
 * jsql — query JSONL without loading it.
 */

import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { renderNdjson, renderSchema, renderTable } from './format.ts';
import { Aggregator, type Operation } from './table.ts';
import { ExprError } from './expr.ts';

const USAGE = `jsql — query JSONL without loading it

usage
  jsql [options] <file.jsonl>
  cat data.jsonl | jql [options] -

options
  -f, --filter <expr>     keep records where <expr> is true
  -g, --group-by <expr>   group by an expression
  -s, --select <cols>     comma-separated expressions to output per group
      --count             print only the number of matching records
      --sum <field>       add up a numeric field (repeatable)
      --avg <field>       average a numeric field (repeatable)
      --min <field>       smallest value of a field (repeatable)
      --max <field>       largest value of a field (repeatable)
      --limit <n>         keep only the first n groups
      --schema            print the inferred schema instead of results
      --format <fmt>      table (default), ndjson, schema
      --max-line <bytes>  skip lines longer than this (default 1048576)
  -h, --help              show this
  -v, --version           show the version

examples
  jsql events.jsonl --schema
  jsql events.jsonl -f 'status >= 400' --count
  jsql events.jsonl -g country -s 'sum(bytes) as bytes' --sum bytes
  jsql events.jsonl -f 'country == "BR" and not cached' --format ndjson
`;

interface Args {
  positionals: string[];
  filter?: string;
  groupBy?: string;
  select?: string;
  count: boolean;
  sums: string[];
  avgs: string[];
  mins: string[];
  maxs: string[];
  limit?: string;
  schema: boolean;
  format: string;
  maxLine: string;
  help: boolean;
  version: boolean;
}

function parseCli(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      filter: { type: 'string', short: 'f' },
      'group-by': { type: 'string', short: 'g' },
      select: { type: 'string', short: 's' },
      count: { type: 'boolean', default: false },
      sum: { type: 'string', multiple: true, default: [] },
      avg: { type: 'string', multiple: true, default: [] },
      min: { type: 'string', multiple: true, default: [] },
      max: { type: 'string', multiple: true, default: [] },
      limit: { type: 'string' },
      schema: { type: 'boolean', default: false },
      format: { type: 'string', default: '' },
      'max-line': { type: 'string', default: '1048576' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  return {
    positionals,
    filter: values.filter,
    groupBy: values['group-by'],
    select: values.select,
    count: values.count,
    sums: values.sum,
    avgs: values.avg,
    mins: values.min,
    maxs: values.max,
    limit: values.limit,
    schema: values.schema,
    format: values.format || (values.schema ? 'schema' : ''),
    maxLine: values['max-line'] ?? '1048576',
    help: values.help,
    version: values.version,
  } as Args;
}

function operations(args: Args): Operation[] {
  const ops: Operation[] = [];
  for (const field of args.sums) ops.push({ kind: 'sum', field });
  for (const field of args.avgs) ops.push({ kind: 'avg', field });
  for (const field of args.mins) ops.push({ kind: 'min', field });
  for (const field of args.maxs) ops.push({ kind: 'max', field });
  return ops;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const target = args.positionals[0];
  if (!target) {
    process.stderr.write(`error: expected a file or -\n\n${USAGE}`);
    return 2;
  }

  const maxLine = Number(args.maxLine);
  let aggregator: Aggregator;
  try {
    aggregator = new Aggregator({
      filter: args.filter,
      groupBy: args.groupBy,
      select: args.select,
      limit: args.limit ? Number(args.limit) : undefined,
      operations: operations(args),
    });
  } catch (error) {
    const where = error instanceof ExprError ? `in your expression: ${error.message}` : (error as Error).message;
    process.stderr.write(`error: ${where}\n`);
    return 2;
  }

  const input =
    target === '-'
      ? process.stdin
      : createReadStream(target, { encoding: 'utf-8', highWaterMark: 1024 * 256 });

  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber++;
      if (line.length === 0) continue;
      if (line.length > maxLine) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
      aggregator.add(record as Record<string, unknown>);
    }
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 1;
  }

  const result = aggregator.finish();

  if (args.count) {
    // With a group-by, "count" means how many rows landed in each group —
    // that is the question a grouped query is usually asking.
    process.stdout.write(
      result.grouped
        ? result.groups.map((g) => `${g.key} ${g.count}`).join('\n') + '\n'
        : `${result.matched}\n`,
    );
    return 0;
  }

  const format = args.format || (args.groupBy ? 'table' : 'ndjson');
  try {
    if (format === 'schema') process.stdout.write(renderSchema(result) + '\n');
    else if (format === 'table') process.stdout.write(renderTable(result) + '\n');
    else process.stdout.write(renderNdjson(result) + '\n');
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 1;
  }

  return 0;
}

export { ExprError };

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
