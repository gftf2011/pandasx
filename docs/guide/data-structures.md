# Data structures & dtypes

## Series

A `Series` is a one-dimensional labelled array: typed values plus an `Index`.

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([4.5, 2, null, 8], { index: ['a', 'b', 'c', 'd'], name: 'score' });
console.log(s);
console.log(s.dtype, s.length, s.index.toArray());
console.log(s.toArray());
```

```text
a  4.5
b  2.0
c  NaN
d  8.0
Name: score, dtype: float64
float64 4 [ 'a', 'b', 'c', 'd' ]
[ 4.5, 2, NaN, 8 ]
```

You can build a Series from an array, a typed array, or an object (keys become the index):

```ts run
import * as pd from 'pandasx';

console.log(new pd.Series({ apples: 3, pears: 5 }));
console.log(new pd.Series(['1', '2'], { dtype: 'int64' }).dtype);
```

```text
apples  3
pears   5
dtype: int64
int64
```

## DataFrame

A `DataFrame` is a table of typed columns sharing one row index. Build it from columns, from records, or from rows:

```ts run
import * as pd from 'pandasx';

const byColumns = new pd.DataFrame({ name: ['Ana', 'Bruno'], age: [31, 28] });
const byRecords = new pd.DataFrame([{ name: 'Ana', age: 31 }, { name: 'Bruno' }]);
const byRows = new pd.DataFrame([['Ana', 31], ['Bruno', 28]], { columns: ['name', 'age'], index: ['r1', 'r2'] });

console.log(byColumns);
console.log(byRecords);
console.log(byRows);
console.log(byRows.shape, byRows.columns);
```

```text
    name  age
0    Ana   31
1  Bruno   28
    name   age
0    Ana  31.0
1  Bruno   NaN
     name  age
r1    Ana   31
r2  Bruno   28
[ 2, 2 ] [ 'name', 'age' ]
```

Series passed as columns are **aligned on their index**, and scalars are broadcast:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({
  x: new pd.Series([1, 2], { index: ['a', 'b'] }),
  y: new pd.Series([30], { index: ['b'] }),
  label: 'const',
});
console.log(df);
```

```text
   x     y  label
a  1   NaN  const
b  2  30.0  const
```

Useful attributes and conversions:

| | |
|---|---|
| `df.shape`, `df.length`, `df.size`, `df.empty` | dimensions |
| `df.columns`, `df.index`, `df.dtypes` | labels and types |
| `df.values` | rows as arrays |
| `df.toRecords()` / `df.toDict(orient)` | plain JS objects |
| `df.T` / `df.transpose()` | swap rows and columns |
| `df.info()`, `df.describe()` | summaries |
| `df.copy()`, `df.equals(other)` | copying and comparing |

## Index

Row labels live in an `Index`. The default is `0 … n-1`; any column can become the index with `setIndex`, and `resetIndex` moves it back:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ id: ['x7', 'k2'], value: [10, 20] }).setIndex('id');
console.log(df);
console.log(df.index.name, df.index.toArray());
console.log(df.resetIndex());
```

```text
    value
id
x7     10
k2     20
id [ 'x7', 'k2' ]
   id  value
0  x7     10
1  k2     20
```

Several columns produce a **MultiIndex** (tuple labels) — see [Reshaping & MultiIndex](./reshaping).

## Dtypes

| dtype | Values | Missing value | Storage |
|---|---|---|---|
| `int64` | integers | — (becomes `float64` when NA appears) | `Float64Array` |
| `float64` | numbers | `NaN` | `Float64Array` |
| `bool` | booleans | — (becomes `object` when NA appears) | `Uint8Array` |
| `Int64`, `Float64` | nullable numbers | `null` | `Float64Array` |
| `boolean` | nullable booleans (Kleene logic) | `null` | `Float64Array` |
| `string` | text | `null` | array |
| `category` | values from a fixed set | `null` | `Int32Array` of codes |
| `datetime` | `Date` (optionally time-zone aware) | `null` (NaT) | `Float64Array` (epoch ms) |
| `timedelta` | `pd.Timedelta` | `null` (NaT) | `Float64Array` (ms) |
| `period` | `pd.Period` | `null` | `Float64Array` of ordinals |
| `bigint` | exact integers of any size | `null` | array |
| `object` | anything | `null` | array |

Dtypes are inferred from the data, can be forced with `{ dtype }`, and converted with `astype`:

```ts run
import * as pd from 'pandasx';

console.log(new pd.Series([1, 2, 3]).dtype);
console.log(new pd.Series([1, null]).dtype);
console.log(new pd.Series([1, null], { dtype: 'Int64' }).toArray());
console.log(new pd.Series([9007199254740993n]).dtype);
console.log(new pd.Series(['2024-01-05']).astype('datetime').dtype);
console.log(new pd.Series(['low', 'high', 'low']).astype('category', { categories: ['low', 'high'], ordered: true }).cat.codes.toArray());
```

```text
int64
float64
[ 1, null ]
bigint
datetime
[ 0, 1, 0 ]
```

`convertDtypes()` picks the best nullable dtype for every column, like pandas' `convert_dtypes`:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ n: [1, null], x: [1.5, null], ok: [true, null], s: ['a', null] });
console.log(df.dtypes.toArray());
console.log(df.convertDtypes().dtypes.toArray());
```

```text
[ 'float64', 'float64', 'object', 'string' ]
[ 'Int64', 'Float64', 'boolean', 'string' ]
```

## Nullable dtypes and Kleene logic

Comparisons on nullable columns return `boolean` with missing values, and `and` / `or` follow three-valued logic:

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([1, null, 3], { dtype: 'Int64' });
console.log(s.gt(1).toArray());

const a = new pd.Series([true, false, null], { dtype: 'boolean' });
console.log(a.or(true).toArray(), a.and(false).toArray());
```

```text
[ false, null, true ]
[ true, true, true ] [ false, false, false ]
```
