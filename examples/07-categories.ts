// Categorical data: compact codes, ordered categories and the .cat accessor.
// Run: node 07-categories.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { dtype: { category: 'category', store: 'category' } });

title('Category dtype from read_csv');
console.log(sales.get('category').dtype, sales.get('category').cat.categories);
console.log(sales.get('category').cat.codes.head(5).toArray());
console.log('memory, string vs category:', sales.get('product').memoryUsage({ deep: true }), sales.get('product').astype('category').memoryUsage({ deep: true }));

title('Ordered categories');
const sizes = pd.categorical(['M', 'S', 'L', 'M', 'XL'], { categories: ['S', 'M', 'L', 'XL'], ordered: true });
console.log(sizes.sortValues().toArray());
console.log(sizes.ge('L').toArray(), sizes.min(), sizes.max());
console.log(sizes.valueCounts());           // keeps category order, unused ones count 0

title('Managing categories');
const cat = new pd.Series(['coffee', 'tea', 'coffee']).astype('category');
console.log(cat.cat.renameCategories({ coffee: 'café', tea: 'chá' }).toArray());
console.log(cat.cat.addCategories(['juice']).cat.categories);
console.log(cat.cat.removeCategories(['tea']).toArray());
console.log(cat.cat.setCategories(['tea', 'coffee'], { ordered: true }).sortValues().toArray());
console.log(cat.cat.reorderCategories(['tea', 'coffee']).cat.categories);
console.log(cat.cat.asOrdered().cat.ordered);
console.log(cat.cat.addCategories(['juice']).cat.removeUnusedCategories().cat.categories);

title('Grouping by a categorical follows category order');
const units = new pd.Series([3, 1, 4, 1, 5]);
const level = pd.categorical(['high', 'low', 'high', 'mid', 'mid'], { categories: ['low', 'mid', 'high'], ordered: true });
console.log(units.groupby(level).sum());

title('Binning numbers into categories: cut and qcut');
const ticket = sales.get('units').mul(sales.get('unit_price'));
const band = pd.cut(ticket, [0, 15, 30, 100], { labels: ['small', 'medium', 'large'] });
console.log(band.valueCounts());
console.log(pd.cut(ticket, 4).cat.categories.map(String));
console.log(pd.qcut(ticket, 4).valueCounts().sortIndex());
console.log(pd.qcut(ticket, [0, 0.5, 0.9, 1], { labels: ['bottom 50%', 'next 40%', 'top 10%'] }).valueCounts());

title('Intervals');
const bins = pd.intervalRange(0, { end: 30, freq: 10 });
console.log(bins.toArray().map(String));
const iv = new pd.Interval(0, 15, 'right');
console.log(iv.contains(15), iv.contains(0), iv.length, String(iv));
