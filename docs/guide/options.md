# Display & options

`console.log(df)` prints the same text table as pandas. Display options control truncation and number formatting. They accept pandas' names (`display.max_rows`) or camelCase (`maxRows`).

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ x: Array.from({ length: 100 }, (_, i) => i / 7), y: Array.from({ length: 100 }, (_, i) => `row ${i}`) });

pd.setOption('display.max_rows', 6);
pd.setOption('display.precision', 3);
console.log(df);
console.log(pd.getOption('display.max_rows'));

pd.resetOption('all');
pd.optionContext({ 'display.precision': 1 }, () => console.log(df.head(2)));   // temporary
console.log(df.head(2));
```

```text
          x       y
0     0.000   row 0
1     0.143   row 1
2     0.286   row 2
...     ...     ...
97   13.857  row 97
98   14.000  row 98
99   14.143  row 99

[100 rows x 2 columns]
6
     x      y
0  0.0  row 0
1  0.1  row 1
          x      y
0  0.000000  row 0
1  0.142857  row 1
```

| Option | Default | Meaning |
|---|---|---|
| `display.max_rows` | 60 | Rows shown before truncating |
| `display.min_rows` | 10 | Rows shown when truncated |
| `display.max_columns` | 20 | Columns shown before truncating |
| `display.precision` | 6 | Decimal places for floats |
| `display.width` | 80 | Line width; wider frames hide middle columns |
| `display.max_colwidth` | 50 | Longest cell text before it is cut with `...` |
| `display.float_format` | `null` | A function `(v: number) => string` |
| `display.chop_threshold` | `null` | Floats smaller than this (in absolute value) show as 0 |
| `display.show_dimensions` | `'truncate'` | Show `[n rows x m columns]`: `'truncate'`, `true` or `false` |
| `display.colheader_justify` | `'right'` | Header alignment |

`pd.options` is the live options object, so `pd.options.precision = 2` also works.

## Per-call rendering

`toString` takes the same settings for a single rendering:

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1.23456, null], b: ['x', 'y'] });
console.log(df.toString({ index: false, naRep: '-' }));
console.log(df.toString({ columns: ['b'], header: false }));
```

```text
       a b
 1.23456 x
       - y
0  x
1  y
```

## Inspecting a frame

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ id: [1, 2, 3], name: ['Ana', null, 'Carla'], score: [9.5, 7, null] });
console.log(df.info());
console.log(df.memoryUsage({ deep: true }));
console.log(df.shape, df.size);
```

```text
<DataFrame>
RangeIndex: 3 entries, 0 to 2
Data columns (total 3 columns):
 #  Column  Non-Null Count  Dtype
 0  id      3 non-null      int64
 1  name    2 non-null      string
 2  score   2 non-null      float64
dtypes: int64(1), string(1), float64(1)
memory usage: 204.0+ bytes
Index  132
id      24
name   130
score   24
dtype: int64
[ 3, 3 ] 9
```
