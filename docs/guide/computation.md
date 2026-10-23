# Computation & statistics

## Arithmetic and comparisons

Operators are methods (`add`, `sub`, `mul`, `div`, `floordiv`, `mod`, `pow`, `neg` and the reversed `radd`, `rsub`, …). Operands can be scalars, arrays, Series (aligned on the index) or DataFrames (aligned on both axes):

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, 2, 3], b: [10, 20, 30] });
console.log(df.mul(2));
console.log(df.get('b').div(df.get('a')).toArray());
console.log(df.get('a').rsub(10).toArray());
console.log(df.gt(2));
```

```text
   a   b
0  2  20
1  4  40
2  6  60
[ 10, 10, 10 ]
[ 9, 8, 7 ]
       a     b
0  false  true
1  false  true
2   true  true
```

Integer arithmetic stays `int64` when the result is integral, like numpy: `add`, `sub`, `mul` keep integers and `div` always returns floats.

## Aggregations

Series reductions return a scalar; DataFrame reductions return a Series (per column, or per row with `{ axis: 1 }`). Numeric reductions skip non-numeric columns.

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, 2, 3, 4], b: [2.5, 3.5, null, 10], s: ['x', 'y', 'z', 'w'] });
console.log(df.sum());
console.log(df.mean({ axis: 1 }).toArray());
console.log(df.get('a').std(), df.get('a').var({ ddof: 0 }), df.get('a').sem());
console.log(df.get('b').median(), df.get('b').quantile([0.25, 0.75]).toArray());
console.log(df.get('a').skew(), df.get('b').kurt());
console.log(df.max().toArray(), df.idxmax().toArray());
console.log(df.agg(['min', 'max']));
```

```text
a  10
b  16
dtype: int64
[ 1.75, 2.75, 3, 7 ]
1.2909944487358056 1.25 0.6454972243679028
3.5 [ 3, 6.75 ]
0 NaN
[ 4, 10, 'z' ] [ 3, 3 ]
     a     b  s
min  1   2.5  w
max  4  10.0  z
```

Available reductions: `sum`, `prod`, `mean`, `median`, `std`, `var`, `sem`, `min`, `max`, `count`, `nunique`, `quantile` (`linear`, `lower`, `higher`, `midpoint`, `nearest`), `skew`, `kurt`, `idxmin`, `idxmax`, `any`, `all`, `mode`, and `agg` with a name, function, list or `{ column: func }`.

## describe

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ height: [1.62, 1.75, 1.81, 1.69], team: ['a', 'b', 'a', 'a'] });
console.log(df.describe());
console.log(df.get('team').describe());
```

```text
         height
count  4.000000
mean   1.717500
std    0.081394
min    1.620000
25%    1.672500
50%    1.720000
75%    1.765000
max    1.810000
count   4
unique  2
top     a
freq    3
Name: team, dtype: object
```

## Cumulative and window-free transforms

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([3, 1, 4, 1, 5]);
console.log(s.cumsum().toArray(), s.cummax().toArray());
console.log(s.diff().toArray(), s.pctChange().toArray());
console.log(s.shift(2).toArray(), s.shift(-1, { fillValue: 0 }).toArray());
console.log(new pd.Series([1.234, -5.678]).round(1).toArray(), new pd.Series([-2, 3]).abs().toArray());
console.log(s.clip(2, 4).toArray());
```

```text
[ 3, 4, 8, 9, 14 ] [ 3, 3, 4, 4, 5 ]
[ NaN, -2, 3, -3, 4 ] [ NaN, -0.6666666666666666, 3, -0.75, 4 ]
[ NaN, NaN, 3, 1, 4 ] [ 1, 4, 1, 5, 0 ]
[ 1.2, -5.7 ] [ 2, 3 ]
[ 3, 2, 4, 2, 4 ]
```

For moving windows (`rolling`, `expanding`, `ewm`) see [Time series](./time-series#windows).

## Applying functions

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, 2], b: [3, 4] });
console.log(df.get('a').map((v) => (v as number) * 100).toArray());
console.log(new pd.Series(['x', 'y']).map({ x: 'ex', y: 'why' }).toArray());
console.log(df.apply((col) => col.sum()));                         // per column
console.log(df.apply((row) => ({ ratio: (row.a as number) / (row.b as number) }), { axis: 1 }));
console.log(df.map((v) => `<${v}>`));                              // element-wise
```

```text
[ 100, 200 ]
[ 'ex', 'why' ]
a  3
b  7
dtype: int64
      ratio
0  0.333333
1  0.500000
     a    b
0  <1>  <3>
1  <2>  <4>
```

## Sorting and ranking

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ team: ['b', 'a', 'b', 'a'], pts: [10, 30, 20, null] });
console.log(df.sortValues(['team', 'pts'], { ascending: [true, false] }));
console.log(df.sortValues('pts', { naPosition: 'first' }).index.toArray());
console.log(df.sortIndex({ ascending: false }).index.toArray());
console.log(df.nlargest(2, 'pts').get('pts').toArray());
console.log(df.get('pts').rank().toArray());
console.log(df.get('pts').rank({ method: 'dense', ascending: false }).toArray());
```

```text
   team   pts
1     a  30.0
3     a   NaN
2     b  20.0
0     b  10.0
[ 3, 0, 2, 1 ]
[ 3, 2, 1, 0 ]
[ 30, 20 ]
[ 1, 3, 2, NaN ]
[ 3, 1, 2, NaN ]
```

`rank` supports `average`, `min`, `max`, `first` and `dense`, plus `naOption` (`keep`, `top`, `bottom`) and `pct`.

## Counting, uniques and duplicates

```ts run
import * as pd from 'pandasx';

const s = new pd.Series(['a', 'b', 'a', 'c', 'a']);
console.log(s.valueCounts());
console.log(s.valueCounts({ normalize: true }).toArray());
console.log(s.unique(), s.nunique(), pd.factorize(s));

const df = new pd.DataFrame({ k: [1, 1, 2], v: ['x', 'x', 'y'] });
console.log(df.duplicated().toArray(), df.dropDuplicates().length);
console.log(df.valueCounts());
```

```text
a  3
b  1
c  1
Name: count, dtype: int64
[ 0.6, 0.2, 0.2 ]
[ 'a', 'b', 'c' ] 3 [ [ 0, 1, 0, 2, 0 ], [ 'a', 'b', 'c' ] ]
[ false, true, false ] 2
1  x  2
2  y  1
Name: count, dtype: int64
```

## Correlation and covariance

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ x: [1, 2, 3, 4, 5], y: [2, 1, 4, 3, 7], z: [5, 4, 3, 2, 1] });
console.log(df.corr());
console.log(df.get('x').corr(df.get('y'), { method: 'spearman' }));
console.log(df.get('x').corr(df.get('y'), { method: 'kendall' }));
console.log(df.cov().round(2));
console.log(df.get('y').autocorr());
```

```text
           x          y          z
x   1.000000   0.824163  -1.000000
y   0.824163   1.000000  -0.824163
z  -1.000000  -0.824163   1.000000
0.8
0.6
      x     y     z
x   2.5   3.0  -2.5
y   3.0   5.3  -3.0
z  -2.5  -3.0   2.5
0.15491933384829668
```
