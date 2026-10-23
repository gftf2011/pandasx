# Differences from pandas

pandasx is tested against pandas 3 with a parity suite that runs the same operations in both and compares the results. The behaviours below differ on purpose, or because JavaScript works differently. For the syntax mapping (operators, `[]`, keyword arguments) see [Coming from pandas](./coming-from-pandas).

## Language-level

- **Methods instead of operators and `[]`.** `s.add(t)`, `df.get('a')`, `df.set('c', v)`, `df.loc(...)`, `df.setLoc(...)`: JavaScript has no operator overloading or item assignment.
- **Asynchronous binary I/O.** Excel, Parquet, Feather, HDF5 and SQL return a `Promise`, because the libraries underneath are asynchronous. CSV, JSON, HTML and XML are synchronous, with `…Async` variants for URLs.
- **Row-wise `apply` receives a plain object**, not a Series.
- **Missing values.** Numbers use `NaN`; strings, dates, objects and the nullable dtypes (`Int64`, `Float64`, `boolean`) read back as `null`, which is what `pd.NA` is. There is no separate `NaT` object: a missing datetime is `null`.
- **Datetime resolution is milliseconds**, the resolution of JavaScript `Date`. Nanosecond timestamps from files are truncated to milliseconds, and pandas reads datetimes written by pandasx as `datetime64[ms]`.
- **Booleans print as `true` / `false`** in `console.log`. Exports (CSV, HTML, XML) write `True` / `False` like pandas.

## Data model

- **Column labels are unique strings.** Duplicate column names throw instead of being allowed. A MultiIndex column is a tuple of strings: `df.columnIndex` holds the tuples, `df.columns` the parts joined by `\u001f`, and `flattenColumns()` turns them into names like `price_min`.
- **Row labels** can be strings, numbers, booleans, dates, `null` or tuples (a MultiIndex).

## Plotting

- **SVG instead of Matplotlib.** Charts are SVG strings with a fixed, colour-blind-safe visual system, not a Matplotlib figure.
- **No secondary y axis.** Two scales on one chart mislead readers; use `subplots: true`.
- **At most eight series per chart.** More would need repeated colours, so the call throws; select fewer columns or use `subplots`. Pie charts fold extra slices into "Other".

## Numerics

- **Weighted rolling `std` / `var`** (`rolling(n, { winType }).std()`) slide the weights with the window, consistent with the weighted `mean`. pandas assigns them by absolute position.
- **`interpolate({ method: 'pad' })`** is still accepted as an alias for `ffill`; pandas 3 removed it.

## Files

- **HDF5:** writing uses the `table` format and does not support MultiIndex rows yet; reading supports both `fixed` and `table`.
- **Parquet:** categorical columns read back in pandas as strings.

Something else behaves differently? It is probably a bug: please [open an issue](https://github.com/gftf2011/pandasx/issues) with the pandas code and the pandasx code side by side.
