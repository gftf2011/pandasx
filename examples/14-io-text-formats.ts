// Text formats: CSV (options, chunks, compression), JSON / JSON Lines, HTML, XML, Markdown and LaTeX.
// Run: node 14-io-text-formats.ts   (files are written to ./output)
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);
const out = (name: string) => new URL(`output/${name}`, import.meta.url).pathname;
mkdirSync(out(''), { recursive: true });

title('CSV: reading with options');
const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), {
  parseDates: ['date'],
  usecols: ['date', 'store', 'product', 'units', 'unit_price'],
  dtype: { store: 'category' },
  nrows: 50,
});
console.log(sales.head(3));
console.log(sales.dtypes);

title('CSV: European format from a string');
const euro = `produto;preço;vendido em
Café;1.234,50;01/03/2024
Chá;NA;02/03/2024
`;
console.log(pd.readCsv(euro, { sep: ';', decimal: ',', thousands: '.', parseDates: ['vendido em'], dateFormat: '%d/%m/%Y' }));

title('CSV: writing, with compression inferred from the extension');
const summary = sales.groupby('store').agg({ units: 'sum', unit_price: 'mean' }).round(2);
summary.toCsv(out('summary.csv'));
summary.toCsv(out('summary.csv.gz'));
console.log(readFileSync(out('summary.csv'), 'utf8'));
console.log('gzip size:', statSync(out('summary.csv.gz')).size, 'bytes');
console.log(pd.readCsv(out('summary.csv.gz'), { indexCol: 'store' }).equals(pd.readCsv(out('summary.csv'), { indexCol: 'store' })));
console.log(summary.toCsv(undefined, { sep: ';', floatFormat: '%.1f', index: false }));

title('CSV: large files in chunks');
let total = 0, chunks = 0;
for (const chunk of pd.readCsv(new URL('data/sales.csv', import.meta.url), { chunksize: 50 })) {
  total += chunk.get('units').sum() as number;
  chunks++;
}
console.log({ chunks, total });

title('Fixed-width and tab-separated');
const fwf = `id  city          area
SP01São Paulo      120
RJ01Rio de Janeiro 140
`;
console.log(pd.readFwf(fwf, { colspecs: [[0, 4], [4, 18], [18, 22]] }));
console.log(pd.readTable('a\tb\n1\t2\n'));

title('JSON');
const stores = pd.readJson(new URL('data/stores.json', import.meta.url));
console.log(stores.head(2).toJson(undefined, { orient: 'records' }));
console.log(stores.head(2).get(['store', 'area_m2']).toJson(undefined, { orient: 'split' }));
console.log(stores.setIndex('store').get(['area_m2']).head(2).toJson(undefined, { orient: 'index' }));
stores.toJson(out('stores.jsonl'), { orient: 'records', lines: true });
console.log(readFileSync(out('stores.jsonl'), 'utf8').split('\n')[0]);
console.log(pd.readJson(out('stores.jsonl'), { lines: true }).shape);

title('HTML tables');
const html = `<html><body>
<table id="menu"><thead><tr><th>item</th><th>price</th></tr></thead>
<tbody><tr><td>Latte</td><td>9.50</td></tr><tr><td>Chai</td><td>8.50</td></tr></tbody></table>
<table><tr><th>x</th></tr><tr><td>1</td></tr></table>
</body></html>`;
const tables = pd.readHtml(html);
console.log(tables.length, 'tables');
console.log(pd.readHtml(html, { attrs: { id: 'menu' } })[0]);
summary.toHtml(out('summary.html'));
console.log(summary.head(2).toHtml().split('\n').slice(0, 6).join('\n'));

title('XML');
const xml = `<?xml version="1.0"?>
<menu>
  <item sku="1"><name>Latte</name><price>9.5</price></item>
  <item sku="2"><name>Chai</name><price>8.5</price></item>
</menu>`;
console.log(pd.readXml(xml));
console.log(pd.readXml(xml, { xpath: "//item[@sku='2']" }).get('name').toArray());
console.log(summary.head(1).toXml());

title('Markdown and LaTeX');
console.log(summary.head(3).toMarkdown());
console.log(summary.head(2).toLatex({ caption: 'Units per store' }));

title('Records and dicts');
console.log(summary.head(2).toRecords());
console.log(summary.head(2).toDict('index'));
