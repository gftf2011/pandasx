# Selecting & assigning

All examples on this page use this frame:

```ts
const df = new pd.DataFrame(
  { name: ['Ana', 'Bruno', 'Carla', 'Diego'], age: [28, 35, 42, 19], city: ['SP', 'RJ', 'SP', 'BH'] },
  { index: ['a', 'b', 'c', 'd'] },
);
```

## Columns with `get`

`get` is pandas' `df[...]`: a name returns a Series, a list returns a DataFrame, a boolean mask selects rows.

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla', 'Diego'], age: [28, 35, 42, 19], city: ['SP', 'RJ', 'SP', 'BH'] }, { index: ['a', 'b', 'c', 'd'] });

console.log(df.get('age'));
console.log(df.get(['name', 'city']));
console.log(df.get(df.get('age').gt(30)));
```

```text
a  28
b  35
c  42
d  19
Name: age, dtype: int64
    name  city
a    Ana    SP
b  Bruno    RJ
c  Carla    SP
d  Diego    BH
    name  age  city
b  Bruno   35    RJ
c  Carla   42    SP
```

## By label: `loc`

`loc(rows, columns)` selects by label. Rows can be a label, a list of labels, a boolean mask, a slice (inclusive at both ends, like pandas), a function, or `null` for all rows.

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla', 'Diego'], age: [28, 35, 42, 19], city: ['SP', 'RJ', 'SP', 'BH'] }, { index: ['a', 'b', 'c', 'd'] });

console.log(df.loc('b'));                       // one row → Series
console.log(df.loc('b', 'age'));                // one cell
console.log(df.loc(['a', 'd'], ['name']));      // DataFrame
console.log(df.loc(pd.slice('b', 'c')));        // inclusive slice
console.log(df.loc((d) => d.get('city').eq('SP'), 'name'));
console.log(df.loc(null, pd.slice('age', 'city')).columns);
```

```text
name  Bruno
age      35
city     RJ
Name: b, dtype: object
35
    name
a    Ana
d  Diego
    name  age  city
b  Bruno   35    RJ
c  Carla   42    SP
a    Ana
c  Carla
Name: name, dtype: string
[ 'age', 'city' ]
```

## By position: `iloc`

`iloc` works like `loc` with integer positions; slices exclude the end, and negative positions count from the end.

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla', 'Diego'], age: [28, 35, 42, 19], city: ['SP', 'RJ', 'SP', 'BH'] }, { index: ['a', 'b', 'c', 'd'] });

console.log(df.iloc(0, 1));
console.log(df.iloc(pd.slice(1, 3)));
console.log(df.iloc([0, -1], [0, 2]));
console.log(df.iloc(pd.slice(null, null, -1)).index.toArray());
```

```text
28
    name  age  city
b  Bruno   35    RJ
c  Carla   42    SP
    name  city
a    Ana    SP
d  Diego    BH
[ 'd', 'c', 'b', 'a' ]
```

Scalar shortcuts: `df.at(row, column)` and `df.iat(i, j)`; on a Series `s.at(label)`, `s.iat(i)` and `s.get(label, default)`.

## Filtering

Combine comparisons with `and`, `or`, `not` and `xor`, or use helpers such as `isin` and `between`:

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla', 'Diego'], age: [28, 35, 42, 19], city: ['SP', 'RJ', 'SP', 'BH'] }, { index: ['a', 'b', 'c', 'd'] });

const age = df.get('age');
console.log(df.get(age.ge(20).and(df.get('city').ne('RJ'))).get('name').toArray());
console.log(df.get(df.get('city').isin(['RJ', 'BH'])).get('name').toArray());
console.log(df.get(age.between(20, 40)).get('name').toArray());
console.log(df.filter({ like: 'a' }).columns);          // columns by name
console.log(df.selectDtypes({ include: ['number'] }).columns);
```

```text
[ 'Ana', 'Carla' ]
[ 'Bruno', 'Diego' ]
[ 'Ana', 'Bruno' ]
[ 'name', 'age' ]
[ 'age' ]
```

### `query` and `eval`

`query` takes the same expression strings as pandas — `and`/`or`/`not` (or `&`/`|`/`~`), comparisons (also chained), `in` / `not in`, arithmetic, backtick-quoted column names, `@variables` and method calls such as `.str.startswith(...)`:

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla', 'Diego'], age: [28, 35, 42, 19], city: ['SP', 'RJ', 'SP', 'BH'] }, { index: ['a', 'b', 'c', 'd'] });

console.log(df.query('20 < age <= 40 and city in ["SP", "RJ"]'));
console.log(df.query('name.str.startswith("C") or age < @young', { locals: { young: 20 } }));
console.log(df.query('index != "a"').index.toArray());
```

```text
    name  age  city
a    Ana   28    SP
b  Bruno   35    RJ
    name  age  city
c  Carla   42    SP
d  Diego   19    BH
[ 'b', 'c', 'd' ]
```

`eval` evaluates an expression, or assigns new columns and returns a new frame:

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ price: [10, 20], qty: [3, 1] });

console.log(df.eval('price * qty'));
console.log(df.eval('total = price * qty\ndiscounted = total * 0.9'));
console.log(pd.eval('2 ** 10 + 1'));
```

```text
0  30
1  20
dtype: int64
   price  qty  total  discounted
0     10    3     30        27.0
1     20    1     20        18.0
1025
```

A predicate function also works: `df.query((row, label) => row.age > 30)`.

## Adding and changing data

`set` adds or replaces a column **in place**; `assign` returns a new frame (values may be functions of the frame):

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ price: [10, 20, 30] });

df.set('qty', [1, 2, 3]);
df.set('currency', 'BRL');                       // scalar broadcast
const out = df.assign({ total: (d) => d.get('price').mul(d.get('qty')) });
console.log(out);
```

```text
   price  qty  currency  total
0     10    1       BRL     10
1     20    2       BRL     40
2     30    3       BRL     90
```

### In-place assignment: `setLoc`, `setIloc`, `setAt`, `setIat`

These replace pandas' `df.loc[...] = value`. Values can be scalars, arrays (one per selected cell row/column), Series (aligned by label) or DataFrames. A new row label appends a row, a new column name adds a column, and dtypes widen when needed.

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ name: ['Ana', 'Bruno', 'Carla'], age: [28, 35, 42] }, { index: ['a', 'b', 'c'] });

df.setLoc(df.get('age').gt(30), 'senior', true);   // new column, masked rows
df.setLoc('b', 'age', 36);                          // one cell
df.setLoc('d', ['name', 'age'], ['Diego', 19]);     // new row
df.setIloc(0, 1, 29);
console.log(df);
```

```text
    name  age  senior
a    Ana   29    null
b  Bruno   36    true
c  Carla   42    true
d  Diego   19    null
```

On a Series: `s.setLoc(key, value)`, `s.setIloc(pos, value)`, `s.setAt(label, value)` and `s.setIat(i, value)`.

## Other row and column operations

```ts run
import * as pd from 'pandasx';
const df = new pd.DataFrame({ a: [1, 2, 3], b: [4, 5, 6], c: [7, 8, 9] });

console.log(df.drop(['b']).columns);
console.log(df.drop({ index: [0] }).index.toArray());
console.log(df.rename({ columns: { a: 'A' } }).columns);
console.log(df.head(2).length, df.tail(1).index.toArray());
console.log(df.sample(2, { seed: 1 }).index.toArray());
console.log(df.reindex({ index: [2, 0, 5] }));
df.insert(0, 'id', ['x', 'y', 'z']);
console.log(df.pop('c').toArray(), df.columns);
```

```text
[ 'a', 'c' ]
[ 1, 2 ]
[ 'A', 'b', 'c' ]
2 [ 2 ]
[ 1, 0 ]
     a    b    c
2  3.0  6.0  9.0
0  1.0  4.0  7.0
5  NaN  NaN  NaN
[ 7, 8, 9 ] [ 'id', 'a', 'b' ]
```
