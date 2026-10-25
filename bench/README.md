# Benchmarks

Times the same ten operations in pandasx and in other JavaScript dataframe libraries:

| Library | Language | Notes |
|---|---|---|
| [pandasx](https://github.com/gftf2011/pandasx) | TypeScript | imported from `../src`, so it measures the working tree |
| [Arquero](https://idl.uw.edu/arquero/) | JavaScript | columnar, expression-based |
| [danfo.js](https://danfo.jsdata.org/) | JavaScript | pandas-like API |
| [Data-Forge](https://github.com/data-forge/data-forge-ts) | JavaScript | lazy, row-oriented |

Polars (nodejs-polars) is deliberately left out: it is a Rust engine with Node bindings, not a JavaScript library.

## Running

```bash
npm ci
```

```bash
npm run bench
```

Options: `--rows 10000,100000` (default `100000,1000000`), `--runs 3` (default 5) and `--tools pandasx,arquero`. The run writes [`results.md`](results.md) and [`results.json`](results.json) and fails if any two libraries computed different results.

## Method

- **Data** ([`data.mjs`](data.mjs)): a seeded synthetic table with columns `id` (int), `key` (1,000 distinct strings), `cat` (10 distinct strings), `x`, `y` (floats) and `n` (int), plus a 1,000-row lookup table on `key` for the join. It is written to a temporary CSV that every library reads.
- **Isolation**: each library runs in its own process, so one library's heap and JIT state cannot affect another.
- **Timing** ([`harness.mjs`](harness.mjs)): one warm-up run, then the median of 5 runs (3 when a run takes over 2 s, 1 over 10 s), with a garbage collection before each run.
- **Same answer**: every task returns a check value (row count, number of groups, first id after sorting, mean of `x`) and the runner compares them across libraries.
- **Materialized results**: Arquero's `filter` / `orderby` and Data-Forge's lazy pipelines are forced (`reify()`, `bake()`) inside the timed region, so every library does the full work.

| Task | What it does |
|---|---|
| `read_csv` | parse the CSV file into a frame |
| `construct` | build a frame from six JavaScript arrays |
| `filter` | rows where `x > 0.5 and cat == 'c3'` |
| `sort` | sort all rows by `x` |
| `groupby` | group by `key` (1,000 groups), sum of `x` and mean of `y` |
| `merge` | inner join with the 1,000-row lookup table on `key` |
| `arithmetic` | new column `z = x * y + n` |
| `stats` | mean and standard deviation of `x` |
| `value_counts` | counts of `cat` |
| `to_csv` | serialize the whole frame to a CSV string |

Adapter notes:

- **danfo.js**: the `danfojs` package's `readCSV` only fetches URLs in Node, so `read_csv` does what it does internally (Papa Parse with the same options, then `new DataFrame(rows)`). `danfojs-node` only adds native TensorFlow bindings, which these operations do not use.
- **Arquero**: `aq.table(columns)` wraps the given arrays without copying them, so `construct` is close to free.
