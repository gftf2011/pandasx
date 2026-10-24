// Computation: arithmetic, statistics, sorting, ranking, counting, correlation and apply.
// Run: node 05-computation.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] })
  .fillna({ discount: 0 });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')).mul(sales.get('discount').rsub(1)).round(2));

title('Element-wise arithmetic and comparisons');
console.log(sales.get(['units', 'unit_price', 'discount', 'revenue']).head(3));
console.log(sales.get('units').floordiv(2).head(3).toArray(), sales.get('units').mod(2).head(3).toArray(), sales.get('units').pow(2).head(3).toArray());
console.log(sales.get(['units', 'unit_price']).gt(5).head(3));

title('Descriptive statistics');
const revenue = sales.get('revenue');
console.log({ sum: revenue.sum(), mean: revenue.mean(), median: revenue.median(), std: revenue.std(), sem: revenue.sem() });
console.log({ skew: revenue.skew(), kurt: revenue.kurt(), min: revenue.min(), max: revenue.max() });
console.log(revenue.quantile([0.1, 0.5, 0.9]).toArray());
console.log(revenue.quantile(0.5, { interpolation: 'lower' }), revenue.quantile(0.5, { interpolation: 'higher' }));
console.log(sales.get(['units', 'revenue']).agg(['min', 'max', 'mean']));
console.log(sales.get(['units', 'revenue']).mean({ axis: 1 }).head(3).toArray());
console.log(sales.get('product').describe());

title('Cumulative and window-free transforms');
const daily = new pd.Series([120, 135, 128, 160, 172]);
console.log(daily.cumsum().toArray(), daily.cummax().toArray(), daily.cumprod().toArray());
console.log(daily.diff().toArray(), daily.pctChange().round(3).toArray());
console.log(daily.shift(1).toArray(), daily.shift(-1, { fillValue: 0 }).toArray());
console.log(daily.clip(125, 165).toArray(), new pd.Series([-1.26, 2.5]).abs().round(1).toArray());

title('Sorting');
console.log(sales.sortValues(['store', 'revenue'], { ascending: [true, false] }).get(['store', 'product', 'revenue']).head(4));
console.log(sales.nlargest(3, 'revenue').get(['product', 'revenue']));
console.log(sales.nsmallest(2, 'revenue').get(['product', 'revenue']));
console.log(sales.setIndex('date').sortIndex({ ascending: false }).index.toArray().slice(0, 2));

title('Ranking');
const scores = new pd.Series([88, 92, 88, 75, null], { index: ['ana', 'bruno', 'carla', 'diego', 'elisa'] });
console.log(new pd.DataFrame({
  average: scores.rank(),
  min: scores.rank({ method: 'min' }),
  dense: scores.rank({ method: 'dense', ascending: false }),
  first: scores.rank({ method: 'first' }),
  pct: scores.rank({ pct: true }),
}));

title('Counting, unique values and duplicates');
console.log(sales.get('product').valueCounts().head(3));
console.log(sales.get('category').valueCounts({ normalize: true }).round(3));
console.log(sales.get(['store', 'category']).valueCounts().head(3));
console.log(sales.get('store').unique(), sales.get('store').nunique());
console.log(pd.factorize(sales.get('payment').head(5)));
console.log('duplicated (store, product):', sales.duplicated({ subset: ['store', 'product'] }).sum());
console.log(sales.dropDuplicates({ subset: ['product'] }).get('product').toArray());

title('Correlation and covariance');
const metrics = new pd.DataFrame({
  units: sales.get('units'),
  unit_price: sales.get('unit_price'),
  revenue: sales.get('revenue'),
});
console.log(metrics.corr().round(3));
console.log(metrics.corr({ method: 'spearman' }).round(3));
console.log(sales.get('units').corr(sales.get('revenue'), { method: 'kendall' }));
console.log(metrics.cov().round(2));
console.log(daily.autocorr());

title('apply, map and pipe');
console.log(sales.get('unit_price').map((v) => `R$ ${(v as number).toFixed(2)}`).head(3).toArray());
console.log(sales.get('payment').map({ card: 'Card', pix: 'PIX', cash: 'Cash' }).head(3).toArray());
console.log(metrics.apply((col) => (col.max() as number) - (col.min() as number)));               // per column
console.log((metrics.head(3).apply((row) => (row.revenue as number) / (row.units as number), { axis: 1 }) as pd.Series).toArray()); // per row
console.log(metrics.head(2).map((v) => Math.round(v as number)));                                  // element-wise
const addMargin = (d: pd.DataFrame, rate: number) => d.assign({ margin: (x) => x.get('revenue').mul(rate).round(2) });
console.log(metrics.head(3).pipe(addMargin, 0.35));                                              // chain custom steps
