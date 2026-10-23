# Missing data

Missing values follow pandas' rules: `NaN` for `float64`, `null` for strings, dates, objects and the nullable dtypes (`Int64`, `Float64`, `boolean`). `null`, `undefined` and `NaN` in input data all become missing. Aggregations skip missing values unless you pass `{ skipna: false }`.

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([1, null, 3, NaN]);
console.log(s.toArray(), s.sum(), s.mean(), s.count());
console.log(s.sum({ skipna: false }));
console.log(pd.isna(null), pd.isna(NaN), pd.notna(0));
```

```text
[ 1, NaN, 3, NaN ] 4 2 2
NaN
true true true
```

## Detecting

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, null, 3], b: ['x', 'y', null] });
console.log(df.isna());
console.log(df.notna().all().toArray());
console.log(df.count());
```

```text
       a      b
0  false  false
1   true  false
2  false   true
[ false, false ]
a  2
b  2
dtype: int64
```

## Filling

`fillna` takes a value, a Series (aligned) or `{ column: value }`. `ffill` / `bfill` propagate valid values, optionally up to a limit of consecutive fills:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, null, null, 4], b: ['x', null, 'z', null] });
console.log(df.fillna({ a: 0, b: '?' }));
console.log(df.ffill());
console.log(df.get('a').bfill(1).toArray());
console.log(df.get('a').ffill(1).toArray());
```

```text
     a  b
0  1.0  x
1  0.0  ?
2  0.0  z
3  4.0  ?
     a  b
0  1.0  x
1  1.0  x
2  1.0  z
3  4.0  z
[ 1, NaN, 4, 4 ]
[ 1, 1, NaN, 4 ]
```

## Dropping

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, null, 3], b: [null, null, 6], c: [7, 8, 9] });
console.log(df.dropna());                         // rows with any NA
console.log(df.dropna({ how: 'all', subset: ['a', 'b'] }).index.toArray());
console.log(df.dropna({ thresh: 2 }).index.toArray());
console.log(df.dropna({ axis: 1 }).columns);      // columns
```

```text
     a    b  c
2  3.0  6.0  9
[ 0, 2 ]
[ 0, 2 ]
[ 'c' ]
```

## Interpolating

`interpolate` supports `linear` (default), `time`, `index`/`values`, `nearest`, `zero`, `pad`, `bfill`, `quadratic`, `cubic`, `spline`, `polynomial` (with `order`), `pchip` and `akima`, plus `limit`, `limitDirection` and `limitArea` — the same edge behaviour as pandas/scipy.

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([null, 1, null, null, 4, null]);
console.log(s.interpolate().toArray());
console.log(s.interpolate({ limitDirection: 'both' }).toArray());
console.log(s.interpolate({ limit: 1 }).toArray());

const curve = new pd.Series([0, 1, null, 9, 16]);
console.log(curve.interpolate({ method: 'quadratic' }).toArray());

const dated = new pd.Series([0, null, 30], { index: pd.toDatetime(['2024-01-01', '2024-01-02', '2024-01-04']).toArray() as Date[] });
console.log(dated.interpolate({ method: 'time' }).toArray());
```

```text
[ NaN, 1, 2, 3, 4, 4 ]
[ 1, 1, 2, 3, 4, 4 ]
[ NaN, 1, 2, NaN, 4, 4 ]
[ 0, 1, 4, 9, 16 ]
[ 0, 10, 30 ]
```

## Replacing and masking

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([1, -999, 3, -999]);
console.log(s.replace(-999, null).toArray());
console.log(s.where(s.gt(0), 0).toArray());
console.log(s.mask(s.lt(0)).toArray());
```

```text
[ 1, NaN, 3, NaN ]
[ 1, 0, 3, 0 ]
[ 1, NaN, 3, NaN ]
```
