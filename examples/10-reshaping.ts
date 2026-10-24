// Reshaping: MultiIndex, pivot tables, stack/unstack, melt, dummies and explode.
// Run: node 10-reshaping.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] }).fillna({ discount: 0 });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')).round(2));
sales.set('month', sales.get('date').dt.strftime('%Y-%m'));

title('pivotTable');
console.log(pd.pivotTable(sales, { index: 'store', columns: 'category', values: 'revenue', aggfunc: 'sum', margins: true, fillValue: 0 }).round(1));
console.log(pd.pivotTable(sales, { index: 'month', values: ['units', 'revenue'], aggfunc: { units: 'sum', revenue: 'mean' } }).round(2));
console.log(pd.pivotTable(sales, { index: ['store', 'category'], columns: 'month', values: 'units', aggfunc: 'sum' }).head(4));

title('pivot (no aggregation)');
const monthly = sales.groupby(['month', 'store']).get('revenue').sum().resetIndex();
console.log(monthly.pivot({ index: 'month', columns: 'store', values: 'revenue' }).round(0));

title('crosstab');
console.log(pd.crosstab(sales.get('store'), sales.get('payment'), { margins: true }));
console.log(pd.crosstab(sales.get('store'), sales.get('category'), { normalize: 'index' }).round(2));
console.log(pd.crosstab(sales.get('store'), sales.get('category'), { values: sales.get('revenue'), aggfunc: 'sum' }).round(0));

title('MultiIndex rows');
const multi = sales.groupby(['store', 'category']).get('revenue').sum().round(2).toFrame();
console.log(multi.head(4));
console.log(multi.index.names, multi.index.nlevels);
console.log(multi.loc('RJ01'));                                  // partial key drops the level
console.log(multi.xs('tea', { level: 'category' }));
console.log(multi.swaplevel().sortIndex().head(3));
console.log(multi.droplevel('category').index.toArray().slice(0, 3));
console.log(multi.index.getLevelValues('category').toArray().slice(0, 3));
console.log(pd.MultiIndex.fromProduct([['SP01', 'RJ01'], ['coffee', 'tea']], { names: ['store', 'category'] }).toArray());
console.log(pd.MultiIndex.fromTuples([['a', 1], ['b', 2]]).toArray());

title('stack and unstack');
const wide = multi.get('revenue').unstack({ fillValue: 0 });
console.log(wide);
console.log(wide.stack().head(4));
console.log(multi.get('revenue').unstack({ level: 0 }).head(2));

title('MultiIndex columns');
const stats = sales.groupby('store').agg({ revenue: ['sum', 'mean'], units: ['sum'] }).round(1);
console.log(stats);
console.log(stats.columnIndex.toArray());
console.log(stats.get('revenue'));                               // top level -> sub-frame
console.log(stats.column(['revenue', 'mean']).toArray());
console.log(stats.flattenColumns().columns);

title('melt and wideToLong');
const scorecard = new pd.DataFrame({ store: ['SP01', 'RJ01'], q1: [4.5, 4.1], q2: [4.7, 4.0] });
const long = scorecard.melt({ idVars: ['store'], varName: 'quarter', valueName: 'rating' });
console.log(long);
console.log(long.pivot({ index: 'store', columns: 'quarter', values: 'rating' }));
const yearly = new pd.DataFrame({ store: ['SP01', 'RJ01'], sales2023: [100, 80], sales2024: [130, 95] });
console.log(pd.wideToLong(yearly, 'sales', 'store', 'year'));

title('Dummies (one-hot) and back');
const dummies = pd.getDummies(sales.get(['store', 'payment']).head(4), { columns: ['payment'] });
console.log(dummies);
console.log(pd.fromDummies(pd.getDummies(new pd.Series(['tea', 'coffee', 'tea']))));

title('explode list-like cells');
const orders = new pd.DataFrame({ order: [1, 2, 3], items: [['latte', 'croissant'], [], ['espresso']] });
console.log(orders.explode('items'));

title('Transpose');
console.log(pd.pivotTable(sales, { index: 'category', values: 'revenue', aggfunc: 'sum' }).round(0).T);
