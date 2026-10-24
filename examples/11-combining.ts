// Combining data: merge, join, concat, mergeAsof, mergeOrdered, combineFirst, update, compare.
// Run: node 11-combining.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
const stores = pd.readJson(new URL('data/stores.json', import.meta.url));
const perStore = sales.groupby('store').get('units').sum().resetIndex();

title('merge: database-style joins');
console.log(pd.merge(perStore, stores.get(['store', 'city', 'area_m2']), { on: 'store' }));
const targets = new pd.DataFrame({ store: ['SP01', 'RJ01', 'CWB01'], target: [150, 120, 50] });
console.log(perStore.merge(targets, { how: 'left' }));
console.log(perStore.merge(targets, { how: 'outer', indicator: true }));
console.log(perStore.merge(targets, { how: 'inner', validate: '1:1' }));

title('merge with different key names, suffixes and the index');
const managers = new pd.DataFrame({ code: ['SP01', 'RJ01'], units: [3, 4] });
console.log(pd.merge(perStore, managers, { leftOn: 'store', rightOn: 'code', suffixes: ['_sold', '_staff'] }));
const areas = stores.setIndex('store').get(['area_m2']);
console.log(pd.merge(perStore, areas, { leftOn: 'store', rightIndex: true }));
console.log(perStore.merge(new pd.DataFrame({ size: ['S', 'L'] }), { how: 'cross' }).head(4));

title('join: align on the index');
const left = perStore.setIndex('store');
console.log(left.join(stores.setIndex('store').get(['state'])));
console.log(left.join(targets.setIndex('store'), { how: 'inner' }));

title('concat: stack frames vertically or side by side');
const jan = sales.get(sales.get('date').dt.month.eq(1)).head(2);
const feb = sales.get(sales.get('date').dt.month.eq(2)).head(2);
console.log(pd.concat([jan, feb], { ignoreIndex: true }).get(['date', 'store', 'units']));
console.log(pd.concat([jan.get(['store', 'units']), new pd.DataFrame({ store: ['XX'], extra: [1] })], { join: 'inner' }));
console.log(pd.concat([perStore.get('units'), perStore.get('units').mul(2).rename('double')], { axis: 1 }).head(2));

title('mergeAsof: nearest earlier quote for each trade');
const trades = new pd.DataFrame({
  time: pd.toDatetime(['2024-03-01 10:00:01', '2024-03-01 10:00:03', '2024-03-01 10:00:07']),
  product: ['latte', 'latte', 'espresso'],
  qty: [2, 1, 3],
});
const prices = new pd.DataFrame({
  time: pd.toDatetime(['2024-03-01 10:00:00', '2024-03-01 10:00:02', '2024-03-01 10:00:05', '2024-03-01 10:00:06']),
  product: ['latte', 'latte', 'espresso', 'latte'],
  price: [9.5, 9.7, 6.5, 9.9],
});
console.log(pd.mergeAsof(trades, prices, { on: 'time', by: 'product' }));
console.log(pd.mergeAsof(trades, prices, { on: 'time', by: 'product', direction: 'forward' }));
console.log(pd.mergeAsof(trades, prices, { on: 'time', by: 'product', tolerance: '1s' }));

title('mergeOrdered: ordered outer join with forward fill');
const a = new pd.DataFrame({ day: [1, 3, 5], stock: [10, 8, 6] });
const b = new pd.DataFrame({ day: [2, 3, 4], delivered: [5, 0, 7] });
console.log(pd.mergeOrdered(a, b, { on: 'day', fillMethod: 'ffill' }));

title('combineFirst, update and compare');
const counted = new pd.DataFrame({ stock: [10, null, 4] }, { index: ['latte', 'chai', 'espresso'] });
const estimate = new pd.DataFrame({ stock: [9, 6, 5, 12] }, { index: ['latte', 'chai', 'espresso', 'croissant'] });
console.log(counted.combineFirst(estimate));                    // fill holes and add missing labels
const corrected = counted.copy();
corrected.update(new pd.DataFrame({ stock: [11] }, { index: ['latte'] }));  // in place, aligned
console.log(corrected);
console.log(counted.compare(corrected));
