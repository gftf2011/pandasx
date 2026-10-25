# pandasx examples

Runnable scripts covering every feature of [pandasx](https://www.npmjs.com/package/pandasx), written against the package published on npm, exactly as you would use it in your own project. They share a small dataset of a café chain in [`data/`](data): 180 sales, 5 stores and two weeks of hourly temperature readings.

For explanations, see the [documentation](https://gftf2011.github.io/pandasx/).

## Run them

Requires Node.js 22.23.4+, 24.22.1+ or 26.12.1+. Node runs TypeScript files directly.

```bash
cd examples
```

```bash
npm install
```

```bash
npm start
```

`npm start` runs all examples in order and prints their output. Every example also has its own command (listed in the table below):

```bash
npm run groupby
```

```bash
npm run io:binary
```

| Command | Runs |
|---|---|
| `npm start` / `npm run all` | All 20 examples, with their output |
| `npm run all:quiet` | All examples, printing only ✓ / ✖ per file |
| `npm run basics` | 01–04: Series, DataFrame, selection, missing data |
| `npm run analysis` | 05–11: computation, text, categories, dtypes, groupby, reshaping, combining |
| `npm run time` | 12–13: dates, resampling and windows |
| `npm run io` | 14–16: text formats, SQL, binary formats |
| `npm run visual` | 17–19: plotting, styling, display options |
| `npm run check` | Typecheck, then run every example (fails if any fails) |
| `npm run typecheck` | Check the examples against the package's type definitions |
| `npm run clean` | Delete the `output/` folder |

`npm start -- 09 12` runs only the examples whose names start with those prefixes, and `node 09-groupby.ts` runs a file directly. Files written by the examples (CSV, Excel, Parquet, SVG charts, HTML reports...) go to `output/`.

## Contents

| File | Command | What it shows |
|---|---|---|
| [01-series.ts](01-series.ts) | `npm run series` | Creating a Series, label / position access, vectorised arithmetic, alignment, reductions |
| [02-dataframe.ts](02-dataframe.ts) | `npm run dataframe` | Building frames, `readCsv`, `info`, `describe`, the index, adding / renaming / dropping columns, iteration |
| [03-selection.ts](03-selection.ts) | `npm run selection` | `get`, `loc`, `iloc`, `at`, `iat`, boolean masks, `query` / `eval`, `filter`, `selectDtypes`, assignment and enlargement |
| [04-missing-data.ts](04-missing-data.ts) | `npm run missing-data` | `isna`, `dropna`, `fillna`, `ffill` / `bfill`, `interpolate`, `where` / `mask`, nullable dtypes |
| [05-computation.ts](05-computation.ts) | `npm run computation` | Arithmetic, statistics, cumulative ops, sorting, ranking, `valueCounts`, duplicates, correlation, `apply` / `map` / `pipe` |
| [06-text.ts](06-text.ts) | `npm run text` | The `.str` accessor: cleaning, searching, splitting, extracting, formatting, dummies |
| [07-categories.ts](07-categories.ts) | `npm run categories` | `category` dtype, ordered categories, the `.cat` accessor, `cut`, `qcut`, intervals |
| [08-dtypes.ts](08-dtypes.ts) | `npm run dtypes` | Inference, `astype`, `convertDtypes`, `Int64` / `Float64` / `boolean`, `bigint`, `Timedelta`, `Period`, memory |
| [09-groupby.ts](09-groupby.ts) | `npm run groupby` | Aggregations, named aggregation, several keys, `transform`, `filter`, `apply`, per-group ranks and windows |
| [10-reshaping.ts](10-reshaping.ts) | `npm run reshaping` | `pivotTable`, `pivot`, `crosstab`, MultiIndex rows and columns, `stack` / `unstack`, `melt`, dummies, `explode` |
| [11-combining.ts](11-combining.ts) | `npm run combining` | `merge`, `join`, `concat`, `mergeAsof`, `mergeOrdered`, `combineFirst`, `update`, `compare` |
| [12-dates-and-times.ts](12-dates-and-times.ts) | `npm run dates` | `toDatetime`, date ranges, the `.dt` accessor, offsets, time zones, date-string indexing |
| [13-resample-and-windows.ts](13-resample-and-windows.ts) | `npm run resample` | `resample` (down and up), `asfreq`, `rolling`, `expanding`, `ewm` |
| [14-io-text-formats.ts](14-io-text-formats.ts) | `npm run io:text` | CSV (options, chunks, gzip), fixed width, JSON / JSON Lines, HTML, XML, Markdown, LaTeX |
| [15-io-sql.ts](15-io-sql.ts) | `npm run io:sql` | `toSql`, `readSql`, `readSqlTable`, `readSqlChunks` with Node's built-in SQLite |
| [16-io-binary-formats.ts](16-io-binary-formats.ts) | `npm run io:binary` | Excel (several sheets, styles), Parquet (compression), Feather / Arrow, HDF5 |
| [17-plotting.ts](17-plotting.ts) | `npm run plotting` | SVG charts: line, area, bar, barh, hist, kde, box, scatter, hexbin, pie, subplots |
| [18-styling.ts](18-styling.ts) | `npm run styling` | `df.style`: formats, highlights, gradients, bars, HTML / LaTeX / Excel export |
| [19-display-options.ts](19-display-options.ts) | `npm run display` | How frames print, `setOption`, `optionContext`, `toString`, `info`, `memoryUsage` |
| [20-sales-report.ts](20-sales-report.ts) | `npm run report` | End to end: load, clean, merge, KPIs, trends, exports (CSV, Excel, HTML chart) |

## Optional dependencies

Excel, Parquet, Feather and HDF5 need optional packages (`exceljs`, `hyparquet` + `hyparquet-writer`, `apache-arrow`, `h5wasm`). They are already listed in this folder's `package.json`; in your own project, install only the ones you use.
