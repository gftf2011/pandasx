// Group by: split-apply-combine.
// Run: node 09-groupby.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] }).fillna({ discount: 0 });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')).mul(sales.get('discount').rsub(1)).round(2));

title('One key, built-in reductions');
const byStore = sales.groupby('store');
console.log(byStore.get('revenue').sum().round(2));
console.log(byStore.size());
console.log(byStore.get(['units', 'revenue']).mean().round(2));
console.log(byStore.get('product').nunique());

title('agg: lists, dicts and named aggregation');
console.log(byStore.agg({ revenue: ['sum', 'mean'], units: 'max' }).round(2));                 // MultiIndex columns
console.log(byStore.agg({ total: ['revenue', 'sum'], tickets: ['revenue', 'count'], biggest: ['revenue', 'max'] }));
console.log(byStore.get('revenue').agg(['min', 'median', 'max']));
console.log(byStore.get('revenue').agg((s) => (s.max() as number) - (s.min() as number)));    // custom reducer
console.log(byStore.agg({ revenue: ['sum', 'mean'] }).flattenColumns().columns);

title('Several keys -> MultiIndex');
const byStoreCategory = sales.groupby(['store', 'category']).get('revenue').sum().round(2);
console.log(byStoreCategory.head(6));
console.log('SP01 / coffee:', byStoreCategory.get(['SP01', 'coffee']));
console.log(byStoreCategory.unstack({ fillValue: 0 }));

title('Grouping options');
console.log(sales.groupby('payment', { dropna: false }).size());             // keep the NA group
console.log(sales.groupby('store', { sort: false }).size().index.toArray()); // first-appearance order
console.log(sales.groupby('store', { asIndex: false }).get('units').sum().head(2)); // keys as a column

title('Group by a function, a Series or an index level');
console.log(sales.get('revenue').groupby(sales.get('date').dt.month).sum().round(2));
console.log(sales.groupby((i) => ((i as number) < 90 ? 'first half' : 'second half')).get('units').sum());
console.log(sales.setIndex(['store', 'product']).groupby(null, { level: 'product' }).get('units').sum().head(3));

title('transform: results aligned with the original rows');
sales.set('store_share', sales.get('revenue').div(byStore.get('revenue').transform('sum')).round(4));
sales.set('vs_store_mean', sales.get('revenue').sub(byStore.get('revenue').transform('mean')).round(2));
console.log(sales.get(['store', 'revenue', 'store_share', 'vs_store_mean']).head(4));

title('filter and apply');
const bigStores = sales.groupby('store').filter((g) => (g.get('revenue').sum() as number) > 1000);
console.log(bigStores.get('store').unique());
console.log(sales.groupby('store').apply((g) => g.nlargest(1, 'revenue').get('product').iat(0)));

title('Per-group cumulative operations, ranking and position');
const first = sales.head(8).copy();
const g = first.groupby('store').get('revenue');
console.log(new pd.DataFrame({
  store: first.get('store'),
  revenue: first.get('revenue'),
  cumsum: g.cumsum(),
  rank: g.rank({ ascending: false }),
  previous: g.shift(),
  n: first.groupby('store').cumcount(),
}));
console.log(sales.groupby('store').head(1).get(['store', 'product']));
console.log(sales.groupby('store').nth(-1).get(['store', 'product']));
console.log(sales.groupby('store').getGroup('BH01').length);

title('describe and quantile per group');
console.log(byStore.get('revenue').describe().round(1));
console.log(byStore.get('revenue').quantile(0.9).round(2));

title('Iterating over groups');
for (const [key, frame] of sales.groupby('category')) console.log(key, frame.length, 'rows');

title('Windows per group');
const temps = pd.readCsv(new URL('data/temperatures.csv', import.meta.url), { parseDates: ['time'] });
console.log(temps.groupby('sensor').get('celsius').rolling(3).mean().round(2).head(4));
