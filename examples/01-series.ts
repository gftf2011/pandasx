// Series: a one-dimensional labelled array.
// Run: node 01-series.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

title('Creating a Series');
const prices = new pd.Series([6.5, 9.0, 9.5, 11.0], {
  index: ['espresso', 'cappuccino', 'latte', 'cold brew'],
  name: 'price',
});
console.log(prices);
console.log('dtype:', prices.dtype, '| length:', prices.length, '| name:', prices.name);

title('From an object (keys become the index)');
console.log(new pd.Series({ SP: 46.6, RJ: 17.5, MG: 21.4 }, { name: 'population_millions' }));

title('Label and position access');
console.log('latte:', prices.get('latte'));
console.log('first:', prices.iat(0));
console.log('slice by label (inclusive):', prices.loc(pd.slice('cappuccino', 'latte')).toArray());
console.log('by position:', prices.iloc([0, -1]).toArray());

title('Vectorised arithmetic (methods replace Python operators)');
console.log('with 10% tax:', prices.mul(1.1).round(2).toArray());
console.log('price > 9:', prices.gt(9).toArray());
console.log('boolean mask:', prices.loc(prices.gt(9)).index.toArray());

title('Alignment on the index');
const discount = new pd.Series([0.5, 1.0], { index: ['latte', 'espresso'] });
console.log(prices.sub(discount));                                  // NaN where a label is missing
console.log(prices.sub(discount, { fillValue: 0 }).toArray());     // treat a missing side as 0

title('Reductions');
console.log({ sum: prices.sum(), mean: prices.mean(), min: prices.min(), max: prices.max(), idxmax: prices.idxmax() });

title('Conversion');
console.log(prices.toArray());
console.log(prices.toDict());
console.log(prices.toFrame());
