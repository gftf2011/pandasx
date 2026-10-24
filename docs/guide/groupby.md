# Group by

`groupby` splits rows into groups, applies a function to each, and combines the results — pandas' split-apply-combine.

```ts
const sales = new pd.DataFrame({
  region: ['N', 'S', 'N', 'S', 'N', 'E'],
  product: ['a', 'a', 'b', 'b', 'a', 'b'],
  units: [10, 5, 7, 3, 2, 4],
  price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5],
});
```

## Aggregating

```ts run
import * as pd from 'pandasx';
const sales = new pd.DataFrame({ region: ['N', 'S', 'N', 'S', 'N', 'E'], product: ['a', 'a', 'b', 'b', 'a', 'b'], units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5] });

console.log(sales.groupby('region').sum());
console.log(sales.groupby('region').get('units').mean());
console.log(sales.groupby('region').size());
```

```text
        units  price
region
E           4    2.5
N          19    6.0
S           8    3.0
E  4.000000
N  6.333333
S  4.000000
Name: units, dtype: float64
E  1
N  3
S  2
Name: size, dtype: int64
```

Group keys become the index (sorted). Keys with missing values are dropped unless `{ dropna: false }`; `{ sort: false }` keeps first-appearance order and `{ asIndex: false }` returns keys as columns.

Built-in reductions: `sum`, `prod`, `mean`, `median`, `std`, `var`, `sem`, `min`, `max`, `count`, `size`, `first`, `last`, `nunique`, `any`, `all`, `quantile`, `idxmin`, `idxmax`, `describe`, `ohlc`.

### `agg`

```ts run
import * as pd from 'pandasx';
const sales = new pd.DataFrame({ region: ['N', 'S', 'N', 'S', 'N', 'E'], product: ['a', 'a', 'b', 'b', 'a', 'b'], units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5] });
const g = sales.groupby('region');

console.log(g.agg({ units: 'sum', price: ['min', 'max'] }));                   // MultiIndex columns
console.log(g.agg({ total: ['units', 'sum'], top: ['price', 'max'] }));        // named aggregation
console.log(g.get('units').agg((s) => (s.max() as number) - (s.min() as number)));
console.log(g.get(['units', 'price']).agg(['mean', 'count']).flattenColumns());
```

```text
        units  price
          sum    min  max
region
E           4    2.5  2.5
N          19    1.5  3.0
S           8    1.0  2.0
        total  top
region
E           4  2.5
N          19  3.0
S           8  2.0
E  0
N  8
S  2
Name: units, dtype: int64
        units_mean  units_count  price_mean  price_count
region
E         4.000000            1         2.5            1
N         6.333333            3         2.0            3
S         4.000000            2         1.5            2
```

A list of functions produces MultiIndex columns `(column, function)`, exactly like pandas; `flattenColumns()` joins them into `units_mean`-style names, and `column(['price', 'min'])` selects one.

## Several keys, functions, Series and levels

```ts run
import * as pd from 'pandasx';
const sales = new pd.DataFrame({ region: ['N', 'S', 'N', 'S', 'N', 'E'], product: ['a', 'a', 'b', 'b', 'a', 'b'], units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5] });

const byTwo = sales.groupby(['region', 'product']).get('units').sum();
console.log(byTwo);                         // tuple (MultiIndex) labels
console.log(byTwo.get(['N', 'a']));
console.log(sales.groupby((label) => ((label as number) % 2 === 0 ? 'even row' : 'odd row')).get('units').sum());
console.log(sales.get('units').groupby(sales.get('product')).sum());
console.log(sales.setIndex(['region', 'product']).groupby(null, { level: 'product' }).get('units').sum());
```

```text
E  b   4
N  a  12
N  b   7
S  a   5
S  b   3
Name: units, dtype: int64
12
even row  19
odd row   12
Name: units, dtype: int64
a  17
b  14
Name: units, dtype: int64
a  17
b  14
Name: units, dtype: int64
```

## Transform, filter and apply

```ts run
import * as pd from 'pandasx';
const sales = new pd.DataFrame({ region: ['N', 'S', 'N', 'S', 'N', 'E'], product: ['a', 'a', 'b', 'b', 'a', 'b'], units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5] });
const g = sales.groupby('region');

// transform: same shape as the input
sales.set('share', sales.get('units').div(g.get('units').transform('sum')));
console.log(sales.get(['region', 'units', 'share']).round(2));

// filter: keep whole groups
console.log(g.filter((d) => d.length > 1).get('region').unique());

// apply: any function of the group
console.log(g.apply((d) => d.get('units').max()));
```

```text
   region  units  share
0       N     10   0.53
1       S      5   0.62
2       N      7   0.37
3       S      3   0.38
4       N      2   0.11
5       E      4   1.00
[ 'N', 'S' ]
E   4
N  10
S   5
dtype: int64
```

## Per-group transforms

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ k: ['a', 'b', 'a', 'b', 'a'], v: [1, 10, 2, 20, 3] });
const g = df.groupby('k').get('v');

console.log(new pd.DataFrame({
  v: df.get('v'),
  cumsum: g.cumsum(),
  shift: g.shift(),
  diff: g.diff(),
  rank: g.rank({ ascending: false }),
  n: df.groupby('k').cumcount(),
}));
console.log(df.groupby('k').nth(-1));
console.log(df.groupby('k').head(1));
```

```text
    v  cumsum  shift  diff  rank  n
0   1       1    NaN   NaN     3  0
1  10      10    NaN   NaN     2  0
2   2       3    1.0   1.0     2  1
3  20      30   10.0  10.0     1  1
4   3       6    2.0   1.0     1  2
   k   v
3  b  20
4  a   3
   k   v
0  a   1
1  b  10
```

Also available per group: `cumprod`, `cummax`, `cummin`, `pctChange`, `ffill`, `bfill`, `fillna`, `ngroup`, `sample`, `getGroup(key)` and iteration with `for (const [key, frame] of df.groupby('k'))`.

## Windows and resampling per group

`rolling`, `expanding`, `ewm` and `resample` work on groups and return results indexed by `(group key, original label)`:

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ k: ['a', 'a', 'b', 'a', 'b', 'b'], v: [1, 2, 3, 4, 5, 6] });

console.log(df.groupby('k').get('v').rolling(2).mean());
console.log(df.groupby('k').get('v').expanding().sum().toArray());
```

```text
a  0  NaN
a  1  1.5
a  3  3.0
b  2  NaN
b  4  4.0
b  5  5.5
Name: v, dtype: float64
[ 1, 3, 7, 3, 8, 14 ]
```
