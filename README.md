# jsql

Query JSONL without loading it.

`jq` reads a whole document into memory. A 40GB log does not fit, and by the
time you know that, the process is already gone. `jsql` streams: it reads one
line at a time and keeps only the accumulators, so a `group-by` over a file
larger than memory costs a few hundred megabytes and finishes.

It also infers the schema on the way through, which is usually the first thing
you want to know about a log you did not produce.

```
$ jsql sales.jsonl --schema
6 record(s), 6 field(s)

FIELD    TYPE           PRESENT  RANGE         FLAGS
-------  -------------  -------  ------------  -----
amount   number|string  6        3..20         MIXED
cached   boolean        6        -             -
country  string         6        max 2 chars   -
id       number         6        1..6          -
tags     array          6        -             -
ts       string         6        max 20 chars  -
```

That `MIXED` on `amount` is the point. One record out of six has a string where
the rest have a number, and a naive `sum(amount)` either crashes or silently
skips it. `jsql` says so before you write the query.

## Install

```sh
npm install -g jsql
```

Requires Node 22.6 or newer. It runs TypeScript directly via Node's built-in
type stripping, so there is no build step and no dependencies at all.

## Usage

```
jsql [options] <file.jsonl>
cat data.jsonl | jsql [options] -
```

| Option | Meaning |
| --- | --- |
| `-f, --filter <expr>` | keep records where the expression is true |
| `-g, --group-by <expr>` | group by an expression |
| `-s, --select <list>` | expressions to output, `expr as name` to rename |
| `--count` | print the number of matching records, or per-group counts |
| `--sum/--avg/--min/--max <field>` | aggregate a numeric field (repeatable) |
| `--limit <n>` | keep only the first n groups |
| `--schema` | print the inferred schema |
| `--format <fmt>` | `table`, `ndjson` or `schema` |
| `--max-line <bytes>` | skip lines longer than this (default 1 MiB) |

```sh
# how many errors, by country
jsql events.jsonl -f 'status >= 400' -g country --count

# total bytes served per country, three aggregates at once
jsql events.jsonl -g country -s 'country, bytes_sum, bytes_avg' --sum bytes --avg bytes

# project matching rows
jsql events.jsonl -f 'country == "BR" and not cached' -s 'id, upper(path) as path'

# pipe straight into another tool
jsql events.jsonl -f 'tags contains "mobile"' | jq -r .id
```

Aggregates are keyed `<field>_<op>`, so `--sum bytes --avg bytes` on one group
gives you `bytes_sum` and `bytes_avg` side by side rather than one overwriting
the other.

## The expression language

A deliberate subset of what you already type into `jq` and SQL REPLs.

```
age >= 18 and country == "BR"
not archived and tags contains "beta"
country in ["BR", "PT"]
name matches "^ada"
coalesce(nickname, name) != ""
round(profile.score, 1)
```

- **Literals** — `42`, `-7`, `3.5e2`, `"text"`, `'text'`, `true`, `null`
- **Fields** — `name`, `profile.city`
- **Comparison** — `==` `!=` `<` `<=` `>` `>=`
- **Logic** — `and` `or` `not`, plus `&&` `||` `!`
- **Words** — `contains` `in` `matches` `startsWith` `endsWith`
- **Arithmetic** — `+` `-` `*` `/` `%`
- **Functions** — `lower` `upper` `trim` `len` `abs` `round` `coalesce`
  `number` `string` `startsWith` `endsWith` `contains`

Precedence follows the usual reading: `not` binds tightest, then arithmetic,
then comparison, then `and`, then `or`. So
`a > 1 and b == 2 or c == 3` means `(a > 1 and b == 2) or (c == 3)`.

`and` and `or` short-circuit, which is what makes `missing != null and
missing.deep == 1` safe.

Equality compares loosely, the way a shell does: `age == "30"` is true when
`age` is `30`. Comparison operators use numbers when both sides look numeric
and fall back to string comparison otherwise — which is why `amount > 6` is
true for the string `"not-a-number"`. That is intentional and is exactly the
kind of thing `--schema` exists to warn you about.

## How it works

- `src/schema.ts` — infers field types, presence, ranges, and flags columns
  seen with more than one type. Carried in a single object through the whole
  file rather than a two-pass read, because these files are often live logs
  that grow while you read them.
- `src/expr.ts` — hand-written lexer plus a Pratt parser, so precedence is a
  table rather than an `if` chain.
- `src/table.ts` — streaming aggregation. Only accumulators are retained, so
  memory is O(groups), not O(file).
- `src/format.ts` — table, NDJSON and schema rendering.

```sh
git clone https://github.com/maybecooldev/jsql
cd jsql
npm test
```

64 tests, no dependencies.

## Known limits

- `matches` compiles the pattern into a `RegExp`, so a pathological pattern
  can backtrack badly. Do not point it at untrusted input.
- No joins, no sorting of the output, no nested grouping.
- Objects and arrays are treated as opaque values. `profile.city` reads
  through an object, but there is no way to flatten or unnest one.
- A line that is valid JSON but not an object (a bare number, an array) is
  skipped silently. `--schema` shows you how many records survived, which is
  the intended way to notice.

## License

MIT
