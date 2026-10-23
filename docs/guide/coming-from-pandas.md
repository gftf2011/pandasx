# Coming from pandas

pandasx follows pandas closely: same concepts, same semantics for missing data and alignment, same function names in camelCase. The differences come from JavaScript itself — it has no operator overloading and no `obj[key] = value` hooks — so those forms become methods.

## Naming

Every `snake_case` name becomes `camelCase`, and keyword arguments become an options object:

| pandas | pandasx |
|---|---|
| `pd.read_csv('a.csv', index_col='id')` | `pd.readCsv('a.csv', { indexCol: 'id' })` |
| `df.sort_values('a', ascending=False)` | `df.sortValues('a', { ascending: false })` |
| `df.drop_duplicates(subset=['a'])` | `df.dropDuplicates({ subset: ['a'] })` |
| `df.groupby('k', as_index=False)` | `df.groupby('k', { asIndex: false })` |
| `s.value_counts(normalize=True)` | `s.valueCounts({ normalize: true })` |

## Indexing with `[]`

| pandas | pandasx |
|---|---|
| `df['a']` | `df.get('a')` |
| `df[['a', 'b']]` | `df.get(['a', 'b'])` |
| `df[df.a > 1]` | `df.get(df.get('a').gt(1))` or `df.loc(df.get('a').gt(1))` |
| `df['c'] = values` | `df.set('c', values)` |
| `df.loc['x', 'a']` | `df.loc('x', 'a')` |
| `df.loc['x':'z']` | `df.loc(pd.slice('x', 'z'))` (inclusive, like pandas) |
| `df.iloc[1:3, 0]` | `df.iloc(pd.slice(1, 3), 0)` |
| `df.loc[:, 'a':'c']` | `df.loc(null, pd.slice('a', 'c'))` |
| `df.loc[mask, 'a'] = 0` | `df.setLoc(mask, 'a', 0)` |
| `df.at['x', 'a'] = 1` | `df.setAt('x', 'a', 1)` |
| `df[('price', 'min')]` | `df.column(['price', 'min'])` |

## Operators

| pandas | pandasx |
|---|---|
| `s + 1`, `s - t`, `s * 2`, `s / t` | `s.add(1)`, `s.sub(t)`, `s.mul(2)`, `s.div(t)` |
| `s // 2`, `s % 2`, `s ** 2` | `s.floordiv(2)`, `s.mod(2)`, `s.pow(2)` |
| `s == 1`, `s != 1`, `s < 1`, `s >= 1` | `s.eq(1)`, `s.ne(1)`, `s.lt(1)`, `s.ge(1)` |
| `a & b`, `a \| b`, `~a`, `a ^ b` | `a.and(b)`, `a.or(b)`, `a.not()`, `a.xor(b)` |
| `-s` | `s.neg()` |

Like pandas, binary operations **align on the index**:

```ts run
import * as pd from 'pandasx';

const a = new pd.Series([1, 2, 3], { index: ['x', 'y', 'z'] });
const b = new pd.Series([10, 20], { index: ['y', 'z'] });
console.log(a.add(b));
```

```text
x   NaN
y  12.0
z  23.0
dtype: float64
```

## String expressions still work

`query` and `eval` accept the same strings as pandas:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, 5, 10], b: ['x', 'y', 'x'] });
const limit = 3;
console.log(df.query('a > @limit and b == "x"', { locals: { limit } }));
console.log(df.eval('c = a * 2'));
```

```text
    a  b
2  10  x
    a  b   c
0   1  x   2
1   5  y  10
2  10  x  20
```

## Row-wise functions

`df.apply(fn, { axis: 1 })` passes each row as a **plain object**, which is more natural in JavaScript than a Series:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ w: [2, 3], h: [5, 4] });
console.log(df.apply((row) => (row.w as number) * (row.h as number), { axis: 1 }));
```

```text
0  10
1  12
dtype: int64
```

## Values and missing data

- Missing numbers are `NaN`; missing strings, dates and objects read back as `null`.
- The nullable dtypes `Int64`, `Float64` and `boolean` read missing values as `null` (pandas' `pd.NA`); `pd.NA` is exported as `null`.
- Datetimes are JavaScript `Date` objects; durations are `pd.Timedelta`, periods are `pd.Period`.
- Integers beyond 2⁵³ use the `bigint` dtype.

## Asynchronous I/O

CSV, JSON, HTML and XML readers are synchronous like pandas. Readers that depend on asynchronous libraries — Excel, Parquet, Feather, HDF5 and SQL — return a `Promise`:

```ts
const df = await pd.readParquet('data.parquet');
await df.toExcel('report.xlsx');
```

See also [Differences from pandas](./differences) for the few behaviours that deliberately differ.
