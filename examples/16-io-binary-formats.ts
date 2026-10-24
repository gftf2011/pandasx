// Binary formats: Excel, Parquet, Feather / Arrow and HDF5.
// Each needs its optional package: exceljs, hyparquet + hyparquet-writer, apache-arrow, h5wasm.
// Run: node 16-io-binary-formats.ts   (files are written to ./output)
import { mkdirSync, statSync } from 'node:fs';
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);
const out = (name: string) => new URL(`output/${name}`, import.meta.url).pathname;
mkdirSync(out(''), { recursive: true });

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'], dtype: { category: 'category' } });
const stores = pd.readJson(new URL('data/stores.json', import.meta.url)).setIndex('store');
const monthly = pd.pivotTable(
  sales.assign({ month: (d) => d.get('date').dt.strftime('%Y-%m'), revenue: (d) => d.get('units').mul(d.get('unit_price')) }),
  { index: 'store', columns: 'month', values: 'revenue', aggfunc: 'sum' },
).round(2);

title('Excel: one sheet');
await stores.toExcel(out('stores.xlsx'), { sheetName: 'stores', freezePanes: [1, 1] });
console.log(await pd.readExcel(out('stores.xlsx'), { sheetName: 'stores', indexCol: 'store' }));

title('Excel: several sheets with ExcelWriter, then read them all');
await new pd.ExcelWriter(out('report.xlsx'))
  .write(sales.head(20), { sheetName: 'sales', index: false, datetimeFormat: 'dd/mm/yyyy hh:mm' })
  .write(monthly, { sheetName: 'monthly', floatFormat: '#,##0.00' })
  .write(stores, { sheetName: 'stores', startrow: 2 })
  .close();
const book = await pd.readExcel(out('report.xlsx'), { sheetName: null });
console.log(Object.keys(book));
console.log(book.monthly);
console.log(await pd.readExcel(out('report.xlsx'), { sheetName: 'sales', usecols: 'A:C', nrows: 3 }));

title('Excel: styled table (colors survive in the workbook)');
await monthly.style.highlightMax({ axis: 1, color: '#d6f5e6' }).format('{:,.2f}').toExcel(out('styled.xlsx'));
console.log('styled.xlsx', statSync(out('styled.xlsx')).size, 'bytes');

title('Parquet: compressed, columnar, with dtypes and index');
for (const compression of ['snappy', 'zstd', 'gzip'] as const) {
  await sales.toParquet(out(`sales-${compression}.parquet`), { compression });
  console.log(compression.padEnd(6), statSync(out(`sales-${compression}.parquet`)).size, 'bytes');
}
const fromParquet = await pd.readParquet(out('sales-zstd.parquet'));
console.log(fromParquet.dtypes);
console.log(fromParquet.equals(sales));
console.log(await pd.readParquet(out('sales-zstd.parquet'), { columns: ['store', 'units'], rowStart: 0, rowEnd: 3 }));
await stores.toParquet(out('stores.parquet'));
console.log((await pd.readParquet(out('stores.parquet'))).index.toArray());

title('Feather (Arrow IPC) and Arrow tables');
await sales.toFeather(out('sales.feather'));
const fromFeather = await pd.readFeather(out('sales.feather'), { columns: ['date', 'store', 'units'] });
console.log(fromFeather.head(3));
const table = await pd.toArrow(stores.resetIndex());
console.log(table.numRows, 'rows,', table.schema.fields.map((f) => `${f.name}: ${f.type}`).join(', '));
console.log(pd.fromArrow(table).head(2));

title('HDF5 (pandas HDFStore)');
await sales.toHdf(out('store.h5'), 'sales');
await stores.toHdf(out('store.h5'), 'stores');
console.log(await pd.hdfKeys(out('store.h5')));
const fromHdf = (await pd.readHdf(out('store.h5'), 'stores')) as pd.DataFrame;
console.log(fromHdf);
