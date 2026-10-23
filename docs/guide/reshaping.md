# Reshaping & MultiIndex

## MultiIndex

A MultiIndex has tuple labels and one name per level. You get one from `setIndex([...])`, from grouping by several keys, or from the constructors:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({
  region: ['N', 'N', 'S', 'S'], year: [2023, 2024, 2023, 2024], sales: [10, 12, 7, 9],
}).setIndex(['region', 'year']);

console.log(df);
console.log(df.index.names, df.index.levels);
console.log(df.loc('N'));                 // partial key drops the matched level
console.log(df.loc(['S', 2024]));         // full key → one row
console.log(df.xs(2023, { level: 'year' }));
console.log(df.swaplevel().sortIndex());
console.log(pd.MultiIndex.fromProduct([['a', 'b'], [1, 2]], { names: ['letter', 'n'] }).toArray());
```

```text
              sales
region  year
N       2023     10
N       2024     12
S       2023      7
S       2024      9
[ 'region', 'year' ] [ [ 'N', 'S' ], [ 2023, 2024 ] ]
      sales
year
2023     10
2024     12
sales  9
Name: S,2024, dtype: int64
        sales
region
N          10
S           7
              sales
year  region
2023  N          10
2023  S           7
2024  N          12
2024  S           9
[ [ 'a', 1 ], [ 'a', 2 ], [ 'b', 1 ], [ 'b', 2 ] ]
```

Level helpers work on rows and, with `{ axis: 1 }`, on columns: `droplevel`, `swaplevel`, `reorderLevels`, `xs`, plus `groupby(null, { level })` and `index.getLevelValues(level)`.

### MultiIndex columns

Aggregations with lists, `unstack`, `pivotTable` with several values and `compare` produce columns labelled by tuples:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ k: ['a', 'b', 'a'], x: [1, 2, 3], y: [4.5, 5, 6] });
const out = df.groupby('k').agg(['sum', 'max']);
console.log(out);
console.log(out.columnIndex.toArray());
console.log(out.get('x'));               // sub-frame for the top level
console.log(out.column(['y', 'max']).toArray());
console.log(out.flattenColumns().columns);
```

```text
     x          y
   sum  max   sum  max
k
a    4    3  10.5  6.0
b    2    2   5.0  5.0
[ [ 'x', 'sum' ], [ 'x', 'max' ], [ 'y', 'sum' ], [ 'y', 'max' ] ]
   sum  max
k
a    4    3
b    2    2
[ 6, 5 ]
[ 'x_sum', 'x_max', 'y_sum', 'y_max' ]
```

## stack and unstack

```ts run
import * as pd from 'pandasx';

const s = new pd.DataFrame({ region: ['N', 'N', 'S'], product: ['a', 'b', 'a'], units: [10, 7, 5] })
  .groupby(['region', 'product']).get('units').sum();

const wide = s.unstack({ fillValue: 0 });
console.log(wide);
console.log(wide.stack());
console.log(s.unstack({ level: 0 }));
```

```text
product   a  b
region
N        10  7
S         5  0
N  a  10
N  b   7
S  a   5
S  b   0
dtype: int64
region    N    S
product
a        10  5.0
b         7  NaN
```

## pivot and pivotTable

`pivot` reshapes without aggregating (duplicates throw); `pivotTable` aggregates, with optional margins:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({
  region: ['N', 'S', 'N', 'S', 'N', 'E'], product: ['a', 'a', 'b', 'b', 'a', 'b'],
  units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5],
});

console.log(df.iloc([0, 1, 2, 3]).pivot({ index: 'region', columns: 'product', values: 'units' }));
console.log(pd.pivotTable(df, { index: 'region', columns: 'product', values: 'units', aggfunc: 'sum', margins: true, fillValue: 0 }));
console.log(pd.pivotTable(df, { index: 'region', values: ['units', 'price'], aggfunc: { units: 'sum', price: 'max' } }));
```

```text
product   a  b
region
N        10  7
S         5  3
product   a   b  All
region
E         0   4    4
N        12   7   19
S         5   3    8
All      17  14   31
        price  units
region
E         2.5      4
N         3.0     19
S         2.0      8
```

`crosstab` counts combinations of factors, optionally normalised:

```ts run
import * as pd from 'pandasx';

const region = new pd.Series(['N', 'S', 'N', 'S', 'N'], { name: 'region' });
const product = new pd.Series(['a', 'a', 'b', 'b', 'a'], { name: 'product' });
console.log(pd.crosstab(region, product, { margins: true }));
console.log(pd.crosstab(region, product, { normalize: 'index' }).round(2));
```

```text
product  a  b  All
region
N        2  1    3
S        1  1    2
All      3  2    5
product     a     b
region
N        0.67  0.33
S        0.50  0.50
```

## melt and wideToLong

```ts run
import * as pd from 'pandasx';

const wide = new pd.DataFrame({ id: [1, 2], q1: [10, 20], q2: [30, 40] });
console.log(wide.melt({ idVars: ['id'], varName: 'quarter', valueName: 'sales' }));

const panel = new pd.DataFrame({ id: [1, 2], sales2023: [5, 6], sales2024: [7, 8] });
console.log(pd.wideToLong(panel, 'sales', 'id', 'year'));
```

```text
   id  quarter  sales
0   1       q1     10
1   2       q1     20
2   1       q2     30
3   2       q2     40
          sales
id  year
1   2023      5
2   2023      6
1   2024      7
2   2024      8
```

## Encoding and binning

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ color: ['red', 'blue', 'red'], n: [1, 2, 3] });
console.log(pd.getDummies(df, { columns: ['color'] }));

const ages = new pd.Series([3, 17, 25, 42, 67, 90]);
console.log(pd.cut(ages, [0, 18, 65, 120], { labels: ['child', 'adult', 'senior'] }).toArray());
console.log(pd.cut(ages, 3).cat.categories.map(String));
console.log(pd.qcut(ages, 4).cat.categories.map(String));
```

```text
   n  color_blue  color_red
0  1       false       true
1  2        true      false
2  3       false       true
[ 'child', 'child', 'adult', 'adult', 'senior', 'senior' ]
[ '(2.913, 32.0]', '(32.0, 61.0]', '(61.0, 90.0]' ]
[ '(2.999, 19.0]', '(19.0, 33.5]', '(33.5, 60.75]', '(60.75, 90.0]' ]
```

## Exploding lists

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ order: [1, 2, 3], items: [['pen', 'ink'], [], ['paper']] });
console.log(df.explode('items'));
```

```text
   order  items
0      1    pen
0      1    ink
1      2   null
2      3  paper
```

## transpose

`df.T` swaps rows and columns.
