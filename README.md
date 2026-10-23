# pandasjs

[pandas](https://pandas.pydata.org/)-style `Series` and `DataFrame` for Node.js, written in TypeScript.

- **Columnar, typed storage**: numbers and dates in `Float64Array`, booleans in `Uint8Array`, categories in `Int32Array`.
- **Faithful to the pandas API**, with camelCase names (`sort_values` → `sortValues`, `read_csv` → `readCsv`).
- **Checked against real pandas**: 214 parity cases (`npm run parity`) plus fixtures written by pandas 3.1.
- **No required dependencies.** Excel, Parquet, Feather and HDF5 use optional packages that only the people who need them install.

```bash
npm install pandasjs
```

Requires Node.js ≥ 22.18.

## Example

```ts
import * as pd from 'pandasjs';

const df = new pd.DataFrame({
  region: ['SP', 'RJ', 'SP', 'MG', 'RJ', 'SP'],
  product: ['coffee', 'coffee', 'tea', 'coffee', 'tea', 'coffee'],
  quantity: [10, 4, 0, 7, 12, 25],
  price: [12.5, 13, 8, 11.9, 7.5, 12.5],
});
// or: const df = pd.readCsv('sales.csv', { parseDates: ['date'] });

const summary = df
  .query('quantity > 0')
  .assign({ revenue: (d) => d.get('quantity').mul(d.get('price')) })
  .groupby('region')
  .agg({ revenue: 'sum', quantity: ['mean', 'max'] })
  .sortValues(['revenue', 'sum']);

console.log(summary);
//         revenue  quantity
//             sum      mean  max
// region
// MG         83.3       7.0    7
// RJ        142.0       8.0   12
// SP        437.5      17.5   25
```

## From pandas to pandasjs

Python overloads `[]` and operators. JavaScript can't, so those forms become methods:

| pandas (Python) | pandasjs |
|---|---|
| `df['a']`, `df[['a','b']]`, `df[mask]` | `df.get('a')`, `df.get(['a','b'])`, `df.get(mask)` |
| `df['c'] = v` | `df.set('c', v)` |
| `df.loc['x', 'a']`, `df.loc['x':'z']` | `df.loc('x', 'a')`, `df.loc(pd.slice('x', 'z'))` |
| `df.loc[mask, 'a'] = 0` | `df.setLoc(mask, 'a', 0)` (also `setIloc`, `setAt`, `setIat`) |
| `s + 1`, `s == 1`, `(a > 1) & ~b` | `s.add(1)`, `s.eq(1)`, `a.gt(1).and(b.not())` |
| `df.query('a > 1 and b == "x"')` | `df.query('a > 1 and b == "x"')` (same syntax) |
| `df.groupby('k')['v'].sum()` | `df.groupby('k').get('v').sum()` |
| `df[('price', 'min')]` (MultiIndex columns) | `df.column(['price', 'min'])` |
| `pd.option_context('display.precision', 2)` | `pd.optionContext({ 'display.precision': 2 }, () => ...)` |
| `df.plot.bar()` (matplotlib) | `df.plot.bar()` → SVG |

## Features

**Dtypes**: `int64`, `float64`, `bool`, the nullable `Int64`, `Float64` and `boolean` (Kleene logic), `string`, `category` (with the `.cat` accessor), time-zone-aware `datetime`, `timedelta`, `period`, `bigint` (exact integers beyond 2^53) and `object`. `convertDtypes` is included.

**Selection and assignment**: `get`, `loc`, `iloc`, `at`, `iat`, `xs` and their `set*` counterparts, with enlargement on new labels; `query` and `eval` with string expressions (`and`/`or`/`not`, `in`, chained comparisons, `@variables`, backtick-quoted names, `name.str.startswith(...)`).

**Statistics**: the usual aggregations plus `sem`, `skew`, `kurt`, `quantile` (every interpolation), `rank` (5 methods), `corr` (Pearson, Spearman and Kendall), `cov`, `corrwith`, `autocorr`, `describe`, `valueCounts`, `mode` and the cumulative operations.

**Missing data**: `isna`, `fillna`, `dropna`, `ffill`, `bfill` and `interpolate` (linear, time, index, nearest, zero, quadratic, cubic, spline, polynomial, pchip and akima, with `limit`, `limitDirection` and `limitArea`).

**Strings**: the full `.str` accessor, including `split` and `extract` with `expand`, `extractall`, `findall`, `getDummies`, `wrap`, `translate` and `normalize`.

**Time series**: `rolling` (row-count or time-based, with `center`, `closed` and `winType`), `expanding`, `ewm`, `resample` (calendar and fixed frequencies, `closed`, `label`, `origin`, `ohlc` and upsampling), `asfreq`, `shift` with `freq`, and offsets (`B`, `W-MON`, `ME`, `MS`, `QE`, `YS`, `BME`, `SME`, `DateOffset`). Also `dateRange`, `bdateRange`, `periodRange`, `timedeltaRange`, `toDatetime` (with `format`, `errors`, `utc`, `dayfirst` and `unit`), `toTimedelta`, IANA time zones (`tzLocalize`/`tzConvert`, DST-aware), the full `.dt` accessor, `atTime`, `betweenTime` and `truncate`.

**GroupBy**: group by column, Series, array, function or index level; `agg` (list, dict or named aggregation), `transform`, `filter`, `apply`, `shift`, `diff`, `rank`, `cumsum`, `nth`, `quantile`, `describe`, `ohlc`, and per-group `rolling`/`expanding`/`ewm`/`resample`.

**MultiIndex and reshaping**: MultiIndex rows and columns (`fromTuples`, `fromProduct`, `droplevel`, `swaplevel`, `xs`, partial `loc`), `stack`, `unstack`, `pivot`, `pivotTable` (with `margins`), `crosstab`, `melt`, `wideToLong`, `explode`, `getDummies`/`fromDummies`, `cut`/`qcut` (with `Interval`), `factorize`, `merge` (including on the index), `mergeAsof`, `mergeOrdered`, `join`, `concat`, `combineFirst`, `update` and `compare`.

**Input and output**:

| Format | Read | Write | Needs |
|---|---|---|---|
| CSV, TSV, fixed-width | `readCsv`, `readCsvAsync`, `readCsvChunks` (streaming), `readTable`, `readFwf` | `toCsv` | nothing |
| JSON and JSON Lines | `readJson`, `readJsonAsync` | `toJson` | nothing |
| HTML | `readHtml` | `toHtml`, `df.style.toHtml()` | nothing |
| XML | `readXml` | `toXml` | nothing |
| SQL | `readSql`, `readSqlQuery`, `readSqlTable`, `readSqlChunks` | `toSql` | `node:sqlite` (built in), better-sqlite3, pg or mysql2 |
| Excel `.xlsx` | `readExcel` | `toExcel`, `ExcelWriter` | `exceljs` |
| Parquet | `readParquet` | `toParquet` | `hyparquet`, `hyparquet-writer` |
| Feather / Arrow | `readFeather`, `fromArrow` | `toFeather`, `toArrow` | `apache-arrow` |
| HDF5 | `readHdf` (fixed and table formats) | `toHdf` (table format) | `h5wasm` |
| LaTeX, Markdown | | `toLatex`, `toMarkdown` | nothing |

Compression (gzip, zstd, brotli, deflate and zip) is detected from the file extension or the leading bytes. URLs are read with the `*Async` variants.

**Display**: `console.log` prints like pandas, including hiding middle columns to fit `display.width`. There are `setOption`, `getOption`, `resetOption` and `optionContext`, plus `info()` and `memoryUsage()`.

**Plots** (`df.plot`, returns SVG): line, bar, barh, hist, box, kde, area, pie, scatter, hexbin and `subplots`. Charts use a palette validated for color-vision deficiency, automatic light and dark themes, a native tooltip on every mark and direct labels. With `path: 'x.html'`, the output is a page with the chart and the data table.

**Styler** (`df.style`): `highlightMax`, `highlightMin`, `highlightNull`, `highlightBetween`, `highlightQuantile`, `backgroundGradient`, `textGradient`, `bar`, `format` (with Python's format mini-language, e.g. `'$ {:,.2f}'`), `map`, `apply`, `hide`, `setCaption`, `setTableStyles`, `toHtml`, `toLatex` and `toExcel` with colors.

## Differences from pandas

- **Column labels are unique strings.** A MultiIndex column is a tuple of strings: `df.columnIndex` shows the tuples, while `df.columns` joins the parts with the `\u001f` character. For flat names such as `price_min`, use `flattenColumns()`.
- **No secondary y axis in plots.** This is a design choice: two axes with different scales mislead readers. Use `subplots`.
- **More than 8 series in one chart throws** instead of reusing colors. Select fewer columns or use `subplots`. Pie charts fold the extra slices into "Other".
- **`rolling(..., { winType }).std()/.var()`** slides the weights with the window. pandas assigns weights by absolute position, which is inconsistent with its own weighted `mean`.
- **Asynchronous I/O**: Excel, Parquet, Feather, HDF5 and SQL return a `Promise`, because the libraries underneath are asynchronous.
- **HDF5** writing only supports the `table` format, without MultiIndex rows yet. Categories written to Parquet are read back by pandas as strings.
- Booleans print as `true`/`false` in `console.log`. Exports (HTML, XML and CSV) use `True`/`False`, like pandas.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
PANDAS_PYTHON=/path/to/venv/bin/python npm run parity
```

The parity suite compares every case with real pandas; it needs a Python with pandas, scipy, pyarrow, tables, openpyxl and lxml. `parity/fixtures.py` regenerates the files in `test/fixtures`.

## Releasing

Bump `version` in `package.json` (e.g. `npm version patch`), push to `main`, then run **Actions → Publish to npm → Run workflow**. The workflow fails if that version is already on npm. It authenticates with npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers): on npmjs.com the package lists `gftf2011/pandasjs` with workflow `publish.yml` as its trusted publisher, so no token is stored.

## License

MIT
