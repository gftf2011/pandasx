# Benchmarks

How fast is pandasx next to other JavaScript dataframe libraries? The benchmark in [`bench/`](https://github.com/gftf2011/pandasx/tree/main/bench) runs the same ten operations in each of them, on the same data, and checks that every library computed the same result.

| Tool | Version | Language |
|---|---|---|
| pandasx | 0.1.5 | TypeScript |
| [Arquero](https://idl.uw.edu/arquero/) | 8.0.3 | JavaScript |
| [danfo.js](https://danfo.jsdata.org/) | 1.2.0 | JavaScript |
| [Data-Forge](https://github.com/data-forge/data-forge-ts) | 1.10.5 | JavaScript |

Polars (nodejs-polars) is left out on purpose: it is a Rust engine with Node bindings, not a JavaScript library.

Machine: Apple M2 (8 cores, 8 GB), macOS, Node.js 24.21. Times are medians, lower is better, and **bold** marks the fastest library.

## Results

### 100,000 rows

| Task | pandasx | Arquero | danfo.js | Data-Forge |
|---|---:|---:|---:|---:|
| `read_csv` | 107 ms | **82 ms** | 212 ms | 247 ms |
| `construct` | 15 ms | **<0.1 ms** | 21 ms | 112 ms |
| `filter` | 9.1 ms | **7.7 ms** | 49 ms | 12 ms |
| `sort` | **20 ms** | 47 ms | 2.19 s | 181 ms |
| `groupby` | **18 ms** | 24 ms | 91 ms | 130 ms |
| `merge` | **19 ms** | 22 ms | 79 ms | 52 ms |
| `arithmetic` | **0.7 ms** | 3.4 ms | 95 ms | 63 ms |
| `stats` | **1.5 ms** | 4.7 ms | 22 ms | 31 ms |
| `value_counts` | **7.3 ms** | 12 ms | 12 ms | 37 ms |
| `to_csv` | 124 ms | 85 ms | **52 ms** | 147 ms |

### 1,000,000 rows

| Task | pandasx | Arquero | danfo.js | Data-Forge |
|---|---:|---:|---:|---:|
| `read_csv` | 1.17 s | **975 ms** | 2.32 s | 3.29 s |
| `construct` | 174 ms | **<0.1 ms** | 294 ms | 1.11 s |
| `filter` | **38 ms** | 41 ms | 512 ms | 112 ms |
| `sort` | **125 ms** | 721 ms | 168 s | 2.11 s |
| `groupby` | **132 ms** | 202 ms | 701 ms | 3.04 s |
| `merge` | **155 ms** | 219 ms | 1.04 s | 527 ms |
| `arithmetic` | **17 ms** | 19 ms | 1.10 s | 1.05 s |
| `stats` | **32 ms** | 34 ms | 196 ms | 235 ms |
| `value_counts` | **55 ms** | 125 ms | 116 ms | 357 ms |
| `to_csv` | 1.26 s | 949 ms | **574 ms** | 2.12 s |

## Reading the numbers

- **pandasx is the fastest at 7 of the 10 tasks at 1 million rows**: filtering, sorting, group by, joins, arithmetic, statistics and `valueCounts`. Its typed columns (`Float64Array`, `Uint8Array` masks, category codes) are processed by plain loops, and single-key sorts use a radix sort, 5.8× faster than Arquero's.
- **Arquero leads at CSV parsing** (1.0 s against 1.2 s) and at `construct`, which is almost free in Arquero because `aq.table()` uses the given arrays without copying them. pandasx copies them into typed columns.
- **danfo.js is the fastest at `to_csv`**, but slows down sharply with size elsewhere: it took 168 s to sort 1 million rows.
- **Data-Forge's row-at-a-time objects** make group by and arithmetic 20–60× slower than pandasx.

## The tasks

| Task | What it does |
|---|---|
| `read_csv` | parse the CSV file into a frame |
| `construct` | build a frame from six JavaScript arrays |
| `filter` | rows where `x > 0.5 and cat == 'c3'` |
| `sort` | sort all rows by `x` |
| `groupby` | group by `key` (1,000 groups), sum of `x` and mean of `y` |
| `merge` | inner join with a 1,000-row lookup table on `key` |
| `arithmetic` | new column `z = x * y + n` |
| `stats` | mean and standard deviation of `x` |
| `value_counts` | counts of `cat` |
| `to_csv` | serialize the whole frame to a CSV string |

In pandasx, the tasks are:

```ts
import * as pd from 'pandasx';

const df = pd.readCsv('data.csv');
df.get(df.get('x').gt(0.5).and(df.get('cat').eq('c3')));
df.sortValues('x');
df.groupby('key').agg({ x: 'sum', y: 'mean' });
pd.merge(df, lookup, { on: 'key' });
df.assign({ z: (d) => d.get('x').mul(d.get('y')).add(d.get('n')) });
df.get('x').mean();
df.get('x').std();
df.get('cat').valueCounts();
df.toCsv();
```

## Method

- **Data**: a seeded synthetic table with columns `id` (int), `key` (1,000 distinct strings), `cat` (10 distinct strings), `x`, `y` (floats) and `n` (int), written to a CSV that every library reads.
- **Isolation**: each library runs in its own process.
- **Timing**: one warm-up run, then the median of 5 runs (3 when a run takes over 2 s, 1 over 10 s), with a garbage collection before each run.
- **Same answer**: every task returns a check value (row count, number of groups, first id after sorting, mean of `x`), and the run fails if two libraries disagree.
- **Full work**: lazy results are materialized inside the timed region: Arquero's `filter` / `orderby` with `reify()`, Data-Forge's pipelines with `bake()`.
- **danfo.js** `readCSV` only fetches URLs in Node, so `read_csv` does what it does internally: Papa Parse with the same options, then `new DataFrame(rows)`.

The numbers depend on the machine; run the benchmark on yours:

```bash
cd bench && npm ci
```

```bash
npm run bench
```

`--rows 10000,100000` changes the sizes, `--runs 3` the number of runs and `--tools pandasx,arquero` the libraries.
