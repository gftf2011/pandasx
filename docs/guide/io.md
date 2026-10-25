# Input / output

Every reader takes a **source**: a file path, a `URL`, a `Buffer` / `Uint8Array`, or — for text formats — the content itself. Writers take an optional path; without one they return the content (a string or a `Buffer`).

| Format | Read | Write | Needs |
|---|---|---|---|
| CSV / TSV / fixed width | `readCsv`, `readCsvAsync`, `readCsvChunks`, `readTable`, `readFwf` | `toCsv` | — |
| JSON / JSON Lines | `readJson`, `readJsonAsync` | `toJson` | — |
| HTML tables | `readHtml`, `readHtmlAsync` | `toHtml` | — |
| XML | `readXml`, `readXmlAsync` | `toXml` | — |
| SQL | `readSql`, `readSqlQuery`, `readSqlTable`, `readSqlChunks` | `toSql` | `node:sqlite` built in; any driver |
| Excel (.xlsx) | `readExcel` | `toExcel`, `ExcelWriter` | `exceljs` |
| Parquet | `readParquet` | `toParquet` | `hyparquet` / `hyparquet-writer` |
| Feather / Arrow IPC | `readFeather`, `fromArrow` | `toFeather`, `toArrow` | `apache-arrow` |
| HDF5 (pandas `HDFStore`) | `readHdf`, `hdfKeys` | `toHdf` | `h5wasm` |
| Markdown / LaTeX / records | — | `toMarkdown`, `toLatex`, `toRecords`, `toDict` | — |

The binary formats load their library on first use; install only the ones you need:

```sh
npm install exceljs              # Excel
npm install hyparquet hyparquet-writer   # Parquet
npm install apache-arrow         # Feather / Arrow
npm install h5wasm               # HDF5
```

Files are interchangeable with pandas: a Parquet, Feather, Excel or HDF5 file written by one opens in the other with the same dtypes and index (with the few exceptions listed in [Differences](./differences)).

### Brotli and CVE-2026-111497 (Node2Shell)

[CVE-2026-111497](https://nodejs.org/en/blog/vulnerability) is an out-of-bounds write in the Brotli decoder bundled with Node.js: crafted Brotli data can crash the process or run code. It is fixed in Node.js **22.23.4, 24.22.1 and 26.12.1**; Node.js 20 and older have no fix.

pandasx decompresses Brotli in four places: `.br` files (or `compression: 'brotli'`), `readCsvChunks` streams, Parquet files with Brotli pages, and URLs whose server answers with `Content-Encoding: br`. The last two happen without asking for Brotli, so on a vulnerable Node.js every one of them throws before the data reaches the decoder:

```text
Error: Refusing to decompress Brotli data (Parquet BROTLI page): the Brotli decoder in Node.js 24.21.0 is vulnerable to CVE-2026-111497 (Node2Shell). Upgrade to Node.js 22.23.4, 24.22.1, 26.12.1 or later, or set PANDASX_ALLOW_VULNERABLE_BROTLI=1 if you trust the data.
```

Upgrade Node.js to lift it. If you cannot and the data comes from a source you control, set `PANDASX_ALLOW_VULNERABLE_BROTLI=1`. Writing Brotli is not affected.

## CSV

```ts run
import * as pd from 'pandasx';

const text = `id;city;amount;when
1;São Paulo;1.234,50;2024-03-01
2;Lisboa;NA;2024-03-02
3;Porto;980,00;2024-03-05
`;
const df = pd.readCsv(text, { sep: ';', decimal: ',', thousands: '.', indexCol: 'id', parseDates: ['when'] });
console.log(df);
console.log(df.dtypes);
console.log(df.toCsv());
```

```text
         city  amount        when
id
1   São Paulo  1234.5  2024-03-01
2      Lisboa     NaN  2024-03-02
3       Porto   980.0  2024-03-05
city      string
amount   float64
when    datetime
dtype: string
id,city,amount,when
1,São Paulo,1234.5,2024-03-01
2,Lisboa,,2024-03-02
3,Porto,980.0,2024-03-05
```

Useful options: `header`, `names`, `usecols`, `dtype`, `naValues`, `nrows`, `skiprows`, `skipfooter`, `comment`, `quotechar`, `escapechar`, `trueValues` / `falseValues`, `dateFormat`, `onBadLines` and `encoding`. Compression (`.gz`, `.zst`, `.br`, `.zip`, …) is inferred from the extension or the file's magic bytes, both when reading and writing.

### Big files and URLs

```ts
// Process a large file in pieces of 100 000 rows
for (const chunk of pd.readCsv('big.csv.gz', { chunksize: 100_000 })) {
  total += chunk.get('amount').sum() as number;
}

// Stream from the network (fetch); chunks arrive as the download progresses
for await (const chunk of pd.readCsvChunks('https://example.com/data.csv', { chunksize: 50_000 })) { /* … */ }

const df = await pd.readCsvAsync(new URL('https://example.com/data.csv'));
```

## JSON

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, 2], b: ['x', null] }, { index: ['r1', 'r2'] });
console.log(df.toJson());                         // orient 'columns' (pandas default)
console.log(df.toJson(undefined, { orient: 'records' }));
console.log(df.toJson(undefined, { orient: 'split' }));
console.log(df.toJson(undefined, { orient: 'records', lines: true }));
console.log(pd.readJson('[{"a":1,"b":"x"},{"a":2}]'));
```

```text
{"a":{"r1":1,"r2":2},"b":{"r1":"x","r2":null}}
[{"a":1,"b":"x"},{"a":2,"b":null}]
{"columns":["a","b"],"index":["r1","r2"],"data":[[1,"x"],[2,null]]}
{"a":1,"b":"x"}
{"a":2,"b":null}

   a     b
0  1     x
1  2  null
```

`orient` is one of `columns`, `records`, `index`, `split`, `values` or `table`. JSON Lines (`lines: true`) can be read in chunks too.

## HTML and XML

```ts run
import * as pd from 'pandasx';

const html = `<table id="prices">
  <thead><tr><th>item</th><th>price</th></tr></thead>
  <tbody><tr><td>pen</td><td>1.50</td></tr><tr><td>ink</td><td>12.00</td></tr></tbody>
</table>`;
const [prices] = pd.readHtml(html, { attrs: { id: 'prices' } });
console.log(prices);

const xml = `<shop><item sku="1"><name>pen</name><qty>3</qty></item><item sku="2"><name>ink</name><qty>1</qty></item></shop>`;
console.log(pd.readXml(xml));
console.log(pd.readXml(xml, { xpath: "//item[@sku='2']" }).get('name').toArray());
console.log(prices.toXml());
```

```text
   item  price
0   pen    1.5
1   ink   12.0
   sku  name  qty
0    1   pen    3
1    2   ink    1
[ 'ink' ]
<?xml version='1.0' encoding='utf-8'?>
<data>
  <row>
    <index>0</index>
    <item>pen</item>
    <price>1.5</price>
  </row>
  <row>
    <index>1</index>
    <item>ink</item>
    <price>12.0</price>
  </row>
</data>
```

`toHtml` writes a pandas-style `<table class="dataframe">`; use [`df.style`](./styling) for conditional formatting.

## SQL

`readSql` and `toSql` accept a SQLite file path (opened with Node's built-in `node:sqlite`), a synchronous connection with `prepare()` (`node:sqlite`, `better-sqlite3`) or an async one with `query()` (`pg`, `mysql2`):

```ts run
import * as pd from 'pandasx';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla'], score: [9.5, 7.0, 8.25] });
console.log(await df.toSql('scores', db, { index: false }));

console.log(await pd.readSql('SELECT * FROM scores WHERE score > ? ORDER BY score DESC', db, { params: [8] }));
console.log(await pd.readSqlTable('scores', db, { indexCol: 'name' }));
```

```text
3
    name  score
0    Ana   9.50
1  Carla   8.25
       score
name
Ana     9.50
Bruno   7.00
Carla   8.25
```

`toSql` options: `ifExists` (`'fail'`, `'replace'`, `'append'`), `index`, `indexLabel`, `dtype` (SQL types per column), `chunksize` and `dialect` (`sqlite`, `postgres`, `mysql`, `generic`, inferred from the connection). Readers take `params`, `indexCol`, `parseDates`, `columns`, `dtype`, and `readSqlChunks` streams a query in frames of `chunksize` rows.

```ts
import pg from 'pg';
const client = new pg.Client(process.env.DATABASE_URL);
await client.connect();
const orders = await pd.readSql('SELECT * FROM orders WHERE created_at > $1', client, { params: ['2024-01-01'], parseDates: ['created_at'] });
```

## Excel

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ product: ['pen', 'ink'], units: [3, 1], when: pd.toDatetime(['2024-03-01', '2024-03-02']) });
const bytes = await df.toExcel(undefined, { sheetName: 'sales', index: false });

console.log(await pd.readExcel(bytes, { sheetName: 'sales' }));

const book = await new pd.ExcelWriter()
  .write(df, { sheetName: 'a', index: false })
  .write(df.head(1), { sheetName: 'b', index: false })
  .close();
console.log(Object.keys(await pd.readExcel(book, { sheetName: null })));
```

```text
   product  units        when
0      pen      3  2024-03-01
1      ink      1  2024-03-02
[ 'a', 'b' ]
```

`readExcel` options: `sheetName` (name, position, a list or `null` for all), `header` (several rows give MultiIndex columns), `names`, `indexCol`, `usecols` (names or letters like `'A:C,E'`), `skiprows`, `nrows`, `dtype`, `naValues`. Writing supports `startrow` / `startcol`, `naRep`, `floatFormat`, `datetimeFormat` and `freezePanes`.

## Parquet, Feather and Arrow

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ id: [1, 2, 3], score: [0.5, null, 0.25], tag: pd.categorical(['a', 'b', 'a']) });

const parquet = await df.toParquet(undefined, { compression: 'zstd' });
console.log(await pd.readParquet(parquet, { columns: ['id', 'tag'] }));

const feather = await df.toFeather();
console.log((await pd.readFeather(feather)).dtypes);
```

```text
   id  tag
0   1    a
1   2    b
2   3    a
id        int64
score   float64
tag    category
dtype: string
```

`fromArrow(table)` / `toArrow(df)` convert to and from an `apache-arrow` `Table` for zero-copy hand-off to other Arrow tools.

## HDF5

```ts
await df.toHdf('store.h5', 'sales');          // pandas HDFStore 'table' format
console.log(await pd.hdfKeys('store.h5'));    // [ '/sales' ]
const back = await pd.readHdf('store.h5', 'sales');
```

Files written by pandas' `df.to_hdf(path, key=...)` in either the `fixed` or the `table` format read back with their index, dtypes and column names; files written by pandasx open with `pd.read_hdf` in pandas.

## Other exports

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, 2], b: ['x', 'y'] });
console.log(df.toMarkdown());
console.log(df.toLatex());
console.log(df.toRecords());
console.log(df.toDict('list'));
```

```text
|    |   a | b   |
|---:|----:|:----|
|  0 |   1 | x   |
|  1 |   2 | y   |
\begin{tabular}{lrl}
\toprule
 & a & b \\
\midrule
0 & 1 & x \\
1 & 2 & y \\
\bottomrule
\end{tabular}

[ { a: 1, b: 'x' }, { a: 2, b: 'y' } ]
{ a: [ 1, 2 ], b: [ 'x', 'y' ] }
```
