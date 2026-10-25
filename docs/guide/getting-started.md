# Getting started

pandasx brings pandas' `Series` and `DataFrame` to Node.js. If you know pandas, you already know most of pandasx — names are camelCase and a few Python-only syntaxes become methods (see [Coming from pandas](./coming-from-pandas)).

## Installation

```bash
npm install pandasx
```

pandasx needs **Node.js 22.23.4+, 24.22.1+ or 26.12.1+** (earlier releases have the [Node2Shell](./io#brotli-and-cve-2026-111497-node2shell) Brotli bug) and has no required dependencies. Some file formats use optional packages that you install only if you need them:

| Format | Install |
|---|---|
| Excel (`.xlsx`) | `npm install exceljs` |
| Parquet | `npm install hyparquet hyparquet-writer` |
| Feather / Arrow | `npm install apache-arrow` |
| HDF5 | `npm install h5wasm` |

If you call a reader whose package is missing, the error tells you exactly what to install.

## Your first DataFrame

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({
  city: ['São Paulo', 'Rio', 'Recife', 'Curitiba'],
  population: [12.4, 6.7, 1.6, 1.9],
  coastal: [false, true, true, false],
});

console.log(df);
console.log(df.dtypes);
```

```text
        city  population  coastal
0  São Paulo        12.4    false
1        Rio         6.7     true
2     Recife         1.6     true
3   Curitiba         1.9    false
city         string
population  float64
coastal        bool
dtype: string
```

`console.log` prints frames the way pandas does. Columns are typed: `population` is stored in a `Float64Array`, `coastal` in a `Uint8Array`.

## A typical analysis

```ts run
import * as pd from 'pandasx';

const sales = new pd.DataFrame({
  region: ['North', 'South', 'North', 'East', 'South', 'North'],
  product: ['coffee', 'coffee', 'tea', 'coffee', 'tea', 'coffee'],
  quantity: [10, 4, 0, 7, 12, 25],
  price: [12.5, 13, 8, 11.9, 7.5, 12.5],
});

const summary = sales
  .query('quantity > 0')
  .assign({ revenue: (d) => d.get('quantity').mul(d.get('price')) })
  .groupby('region')
  .agg({ revenue: 'sum', quantity: 'mean' })
  .sortValues('revenue', { ascending: false });

console.log(summary);
```

```text
        revenue  quantity
region
North     437.5      17.5
South     142.0       8.0
East       83.3       7.0
```

## Reading files

Readers mirror pandas' `read_*` functions:

```ts
const df = pd.readCsv('sales.csv', { parseDates: ['date'], indexCol: 'id' });
const big = pd.readCsvChunks('huge.csv.gz', { chunksize: 100_000 }); // async iterator
const xlsx = await pd.readExcel('report.xlsx', { sheetName: 'data' });
```

See [Reading & writing data](./io) for every format.

## TypeScript

pandasx ships its own type declarations. Methods return precise types (`Series`, `DataFrame`, `DataFrameGroupBy`, …) and options objects are fully typed, so your editor can autocomplete everything. Values inside a Series are typed as `unknown`, because a column's dtype is only known at run time — cast when you need a specific type:

```ts
const total = df.get('population').sum();        // number
const first = df.get('city').iat(0) as string;   // unknown → string
```

## Next steps

- [Data structures & dtypes](./data-structures): Series, DataFrame, Index and every dtype.
- [Selecting & assigning](./selection): `get`, `loc`, `iloc`, `query` and in-place assignment.
- [Group by](./groupby), [Reshaping](./reshaping) and [Time series](./time-series) for analysis.
- The [API reference](/api/) documents every method and option.
- The [examples folder](https://github.com/gftf2011/pandasx/tree/main/examples) has 20 runnable scripts, one per feature area, on a shared dataset.
