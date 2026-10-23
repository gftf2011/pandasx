# Combining data

## merge

`merge` is a database-style hash join. `how` is `inner` (default), `left`, `right`, `outer` or `cross`:

```ts run
import * as pd from 'pandasx';

const customers = new pd.DataFrame({ id: [1, 2, 3], name: ['Ana', 'Bruno', 'Carla'] });
const orders = new pd.DataFrame({ id: [2, 3, 3, 4], total: [20, 30, 31, 40] });

console.log(pd.merge(customers, orders, { on: 'id' }));
console.log(customers.merge(orders, { how: 'outer', indicator: true }));
```

```text
   id   name  total
0   2  Bruno     20
1   3  Carla     30
2   3  Carla     31
   id   name  total      _merge
0   1    Ana    NaN   left_only
1   2  Bruno   20.0        both
2   3  Carla   30.0        both
3   3  Carla   31.0        both
4   4   null   40.0  right_only
```

Options: `on`, `leftOn` / `rightOn`, `leftIndex` / `rightIndex`, `suffixes` (default `['_x', '_y']`), `indicator`, `sort` and `validate` (`'1:1'`, `'1:m'`, `'m:1'`, `'m:m'`).

```ts run
import * as pd from 'pandasx';

const a = new pd.DataFrame({ key: ['x', 'y'], v: [1, 2] });
const b = new pd.DataFrame({ k2: ['y', 'x'], v: [20, 10] });
console.log(pd.merge(a, b, { leftOn: 'key', rightOn: 'k2' }));

const prices = new pd.DataFrame({ price: [9.5, 3.2] }, { index: ['x', 'y'] });
console.log(pd.merge(a, prices, { leftOn: 'key', rightIndex: true }));
```

```text
   key  v_x  k2  v_y
0    x    1   x   10
1    y    2   y   20
   key  v  price
0    x  1    9.5
1    y  2    3.2
```

## join

`join` aligns on the index:

```ts run
import * as pd from 'pandasx';

const left = new pd.DataFrame({ a: [1, 2, 3] }, { index: ['x', 'y', 'z'] });
const right = new pd.DataFrame({ b: [20, 30] }, { index: ['y', 'z'] });
console.log(left.join(right));
console.log(left.join(right, { how: 'inner' }));
```

```text
   a     b
x  1   NaN
y  2  20.0
z  3  30.0
   a   b
y  2  20
z  3  30
```

## concat

```ts run
import * as pd from 'pandasx';

const jan = new pd.DataFrame({ day: [1, 2], sales: [10, 12] });
const feb = new pd.DataFrame({ day: [1], sales: [9], returns: [1] });
console.log(pd.concat([jan, feb], { ignoreIndex: true }));
console.log(pd.concat([jan, feb], { join: 'inner' }).columns);
console.log(pd.concat([new pd.Series([1, 2], { name: 'a' }), new pd.Series([3, 4], { name: 'b' })], { axis: 1 }));
```

```text
   day  sales  returns
0    1     10      NaN
1    2     12      NaN
2    1      9      1.0
[ 'day', 'sales' ]
   a  b
0  1  3
1  2  4
```

## Ordered and nearest-key joins

`mergeAsof` matches each left row with the nearest right key (`backward`, `forward` or `nearest`), optionally within groups (`by`) and a `tolerance` — typical for trades and quotes:

```ts run
import * as pd from 'pandasx';

const trades = new pd.DataFrame({ time: [1, 3, 5, 8], ticker: ['A', 'B', 'A', 'A'], qty: [10, 20, 30, 40] });
const quotes = new pd.DataFrame({ time: [2, 3, 6, 9], ticker: ['A', 'A', 'B', 'A'], bid: [1.0, 2.0, 3.0, 4.0] });
console.log(pd.mergeAsof(trades, quotes, { on: 'time' }));
console.log(pd.mergeAsof(trades, quotes, { on: 'time', by: 'ticker', direction: 'nearest' }));

const a = new pd.DataFrame({ k: [1, 3, 5], a: [1, 2, 3] });
const b = new pd.DataFrame({ k: [2, 3, 4], b: [7, 8, 9] });
console.log(pd.mergeOrdered(a, b, { on: 'k', fillMethod: 'ffill' }));
```

```text
   time  ticker_x  qty  ticker_y  bid
0     1         A   10      null  NaN
1     3         B   20         A  2.0
2     5         A   30         A  2.0
3     8         A   40         B  3.0
   time  ticker  qty  bid
0     1       A   10    1
1     3       B   20    3
2     5       A   30    2
3     8       A   40    4
   k    a    b
0  1  1.0  NaN
1  2  1.0  7.0
2  3  2.0  8.0
3  4  2.0  9.0
4  5  3.0  9.0
```

## Patching and comparing

```ts run
import * as pd from 'pandasx';

const a = new pd.DataFrame({ x: [1, null, 3] });
const b = new pd.DataFrame({ x: [10, 20, 30, 40] });
console.log(a.combineFirst(b).get('x').toArray());   // fill holes (and new labels) from b

const c = a.copy();
c.update(new pd.DataFrame({ x: [99] }, { index: [1] }));
console.log(c.get('x').toArray());                   // in place, aligned on labels

const old = new pd.DataFrame({ a: [1, 2, 3], b: ['x', 'y', 'z'] });
const now = new pd.DataFrame({ a: [1, 5, 3], b: ['x', 'y', 'q'] });
console.log(old.compare(now));
```

```text
[ 1, 20, 3, 40 ]
[ 1, 99, 3 ]
      a            b
   self  other  self  other
1   2.0    5.0  null   null
2   NaN    NaN     z      q
```
