// Display: how console.log renders frames, and the pandas-style display options.
// Run: node 19-display-options.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')).div(3));

title('Default: long frames are truncated, wide frames hide middle columns');
console.log(sales);

title('setOption / getOption / resetOption');
pd.setOption('display.max_rows', 6);
pd.setOption('display.precision', 2);
pd.setOption('display.width', 120);
console.log(sales);
console.log('max_rows =', pd.getOption('display.max_rows'));
pd.resetOption('all');

title('optionContext: temporary settings');
pd.optionContext({ 'display.max_columns': 3, 'display.show_dimensions': true }, () => console.log(sales.head(3)));
pd.optionContext({ 'display.float_format': (v: number) => `R$ ${v.toFixed(2)}` }, () => console.log(sales.get(['store', 'revenue']).head(3)));
pd.optionContext({ 'display.chop_threshold': 0.01 }, () => console.log(new pd.Series([1e-4, 0.5, -1e-5])));
pd.optionContext({ 'display.max_colwidth': 8 }, () => console.log(new pd.Series(['a very long product description'])));

title('pd.options is the live object (camelCase keys)');
pd.options.maxRows = 4;
console.log(sales.get(['date', 'store']));
pd.resetOption('all');

title('Per-call rendering with toString');
console.log(sales.head(3).toString({ index: false, columns: ['store', 'product', 'revenue'] }));
console.log(sales.head(2).toString({ header: false, naRep: '-' }));

title('Inspection helpers');
console.log(sales.info());
console.log(sales.memoryUsage({ deep: true }));
console.log('shape', sales.shape, 'size', sales.size, 'columns', sales.columns.length);
