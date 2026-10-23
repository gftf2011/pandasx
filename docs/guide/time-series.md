# Time series

Datetimes are stored as UTC epoch milliseconds and read back as `Date` objects. A column can carry an IANA time zone; naive datetimes are treated as UTC wall-clock time, like pandas.

## Creating dates

```ts run
import * as pd from 'pandasx';

console.log(pd.toDatetime(['2024-03-15', '2024-03-16 09:30', null]).toArray());
console.log(pd.toDatetime(['15/03/2024 14:05'], { format: '%d/%m/%Y %H:%M' }).toArray());
console.log(pd.toDatetime(['01/02/2024'], { dayfirst: true }).toArray());
console.log(pd.toDatetime([1700000000], { unit: 's' }).toArray());
console.log(pd.toDatetime(['2024-01-01', 'not a date'], { errors: 'coerce' }).isna().toArray());
console.log(pd.toTimedelta(['1 days 02:00:00', '90min', '-1h']).toArray().map(String));
```

```text
[ 2024-03-15T00:00:00.000Z, 2024-03-16T09:30:00.000Z, null ]
[ 2024-03-15T14:05:00.000Z ]
[ 2024-02-01T00:00:00.000Z ]
[ 2023-11-14T22:13:20.000Z ]
[ false, true ]
[ '1 days 02:00:00', '0 days 01:30:00', '-1 days +23:00:00' ]
```

### Ranges and frequencies

```ts run
import * as pd from 'pandasx';

console.log(pd.dateRange('2024-01-30', { periods: 4, freq: 'D' }).toArray());
console.log(pd.dateRange('2024-01-01', { periods: 3, freq: 'ME' }).toArray());
console.log(pd.bdateRange('2024-03-01', { periods: 4 }).dt.strftime('%a %d').toArray());
console.log(pd.dateRange(null, { end: '2024-06-30', periods: 3, freq: 'QE' }).dt.date.toArray());
console.log(pd.periodRange('2024Q3', { periods: 3, freq: 'Q' }).toArray().map(String));
console.log(pd.timedeltaRange('1h', { periods: 3, freq: '30min' }).toArray().map(String));
```

```text
[
  2024-01-30T00:00:00.000Z,
  2024-01-31T00:00:00.000Z,
  2024-02-01T00:00:00.000Z,
  2024-02-02T00:00:00.000Z
]
[
  2024-01-31T00:00:00.000Z,
  2024-02-29T00:00:00.000Z,
  2024-03-31T00:00:00.000Z
]
[ 'Fri 01', 'Mon 04', 'Tue 05', 'Wed 06' ]
[ '2023-12-31', '2024-03-31', '2024-06-30' ]
[ '2024Q3', '2024Q4', '2025Q1' ]
[ '0 days 01:00:00', '0 days 01:30:00', '0 days 02:00:00' ]
```

Frequency strings: `ms`, `s`, `min`, `h`, `D`, `B` (business day), `W` / `W-MON`…, `ME` / `MS` (month end / start), `SME` / `SMS`, `QE` / `QS` (with anchors such as `QE-NOV`), `YE` / `YS`, `BME` / `BMS`, with multiples like `15min` or `2ME`.

## The `.dt` accessor

```ts run
import * as pd from 'pandasx';

const d = pd.toDatetime(['2024-01-31 08:15', '2024-02-29 23:59']);
console.log(d.dt.year.toArray(), d.dt.month.toArray(), d.dt.dayofweek.toArray());
console.log(d.dt.quarter.toArray(), d.dt.isMonthEnd.toArray(), d.dt.isLeapYear.toArray());
console.log(d.dt.dayName().toArray(), d.dt.monthName('pt-BR').toArray());
console.log(d.dt.floor('h').toArray(), d.dt.normalize().toArray());
console.log(d.dt.strftime('%d/%m/%Y %Hh%M').toArray());
console.log(d.dt.toPeriod('M').toArray().map(String));
console.log(d.dt.isocalendar());
```

```text
[ 2024, 2024 ] [ 1, 2 ] [ 2, 3 ]
[ 1, 1 ] [ true, true ] [ true, true ]
[ 'Wednesday', 'Thursday' ] [ 'janeiro', 'fevereiro' ]
[ 2024-01-31T08:00:00.000Z, 2024-02-29T23:00:00.000Z ] [ 2024-01-31T00:00:00.000Z, 2024-02-29T00:00:00.000Z ]
[ '31/01/2024 08h15', '29/02/2024 23h59' ]
[ '2024-01', '2024-02' ]
   year  week  day
0  2024     5    3
1  2024     9    4
```

On timedeltas `.dt` gives `days`, `seconds`, `components` and `totalSeconds()`; on periods `startTime`, `endTime` and `toTimestamp()`.

## Time zones

`tzLocalize` attaches a zone to naive times (handling DST gaps and overlaps); `tzConvert` views the same instants in another zone:

```ts run
import * as pd from 'pandasx';

const local = pd.toDatetime(['2024-03-10 01:30', '2024-07-01 12:00']).dt.tzLocalize('America/New_York');
console.log(local);
console.log(local.dt.tzConvert('America/Sao_Paulo'));
console.log(local.dt.tzConvert('Asia/Tokyo').dt.hour.toArray());

const gap = pd.toDatetime(['2024-03-10 02:30']).dt.tzLocalize('America/New_York', { nonexistent: 'shift_forward' });
console.log(gap);
```

```text
0  2024-03-10 01:30:00-05:00
1  2024-07-01 12:00:00-04:00
dtype: datetime
0  2024-03-10 03:30:00-03:00
1  2024-07-01 13:00:00-03:00
dtype: datetime
[ 15, 1 ]
0  2024-03-10 03:00:00-04:00
dtype: datetime
```

Options for daylight-saving edge cases: `ambiguous: 'raise' | 'earliest' | 'latest' | 'NaT'` and `nonexistent: 'raise' | 'shift_forward' | 'shift_backward' | 'NaT'`. A frame or series with a datetime index has the same `tzLocalize` / `tzConvert` methods for its index.

## Date offsets

```ts run
import * as pd from 'pandasx';

const d = pd.toDatetime(['2024-01-31', '2024-02-29 10:30']);
console.log(d.add(pd.offsets.MonthEnd()).dt.date.toArray());
console.log(d.sub(pd.offsets.BusinessDay(3)).dt.date.toArray());
console.log(d.add(pd.offsets.DateOffset({ months: 1, days: 1 })).dt.date.toArray());
const holidays = pd.offsets.BusinessDay(1, { holidays: ['2024-12-25'] });
console.log(pd.toDatetime(['2024-12-24']).add(holidays).dt.date.toArray());
```

```text
[ '2024-02-29', '2024-03-31' ]
[ '2024-01-26', '2024-02-26' ]
[ '2024-03-01', '2024-03-30' ]
[ '2024-12-26' ]
```

## Indexing by time

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([3, 1, 4, 1, 5, 9], { index: pd.dateRange('2024-01-01 08:00', { periods: 6, freq: '2h' }).toArray() as Date[] });
console.log(s.betweenTime('09:00', '15:00'));
console.log(s.atTime('10:00').toArray());
console.log(s.truncate({ before: '2024-01-01 12:00', after: '2024-01-01 16:00' }).toArray());
console.log(s.shift(1, { freq: 'D' }).index.labels[0]);
```

```text
2024-01-01 10:00:00  1
2024-01-01 12:00:00  4
2024-01-01 14:00:00  1
dtype: int64
[ 1 ]
[ 4, 1, 5 ]
2024-01-02T08:00:00.000Z
```

## Resampling

`resample` groups by time bins. Calendar rules (`ME`, `QE`, `W`…) are right-closed and right-labelled, fixed rules (`D`, `15min`…) left-closed — as in pandas — and both can be changed with `closed`, `label`, `origin` and `offset`:

```ts run
import * as pd from 'pandasx';

const idx = pd.toDatetime(['2024-01-01', '2024-01-02', '2024-01-05', '2024-01-31', '2024-02-01', '2024-02-29']).toArray() as Date[];
const s = new pd.Series([1, 2, 3, 4, 5, 6], { index: idx });

console.log(s.resample('ME').sum());
console.log(s.resample('W').agg(['sum', 'count']));
console.log(s.resample('15D').mean());
console.log(s.resample('ME').ohlc());
```

```text
2024-01-31  10
2024-02-29  11
dtype: int64
            sum  count
2024-01-07    6      3
2024-01-14    0      0
2024-01-21    0      0
2024-01-28    0      0
2024-02-04    9      2
2024-02-11    0      0
2024-02-18    0      0
2024-02-25    0      0
2024-03-03    6      1
2024-01-01  2.0
2024-01-16  NaN
2024-01-31  4.5
2024-02-15  6.0
dtype: float64
            open  high  low  close
2024-01-31   1.0   4.0  1.0    4.0
2024-02-29   5.0   6.0  5.0    6.0
```

Upsampling fills new bins with `asfreq()`, `ffill()`, `bfill()`, `nearest()` or `interpolate()`:

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([1, 3, 2], { index: pd.toDatetime(['2024-01-01', '2024-01-03', '2024-01-06']).toArray() as Date[] });
console.log(new pd.DataFrame({ asfreq: s.resample('D').asfreq(), ffill: s.resample('D').ffill(), interpolate: s.resample('D').interpolate() }));
```

```text
            asfreq  ffill  interpolate
2024-01-01     1.0      1     1.000000
2024-01-02     NaN      1     2.000000
2024-01-03     3.0      3     3.000000
2024-01-04     NaN      3     2.666667
2024-01-05     NaN      3     2.333333
2024-01-06     2.0      2     2.000000
```

`df.asfreq(freq, { method })` is the shortcut for conforming an index to a frequency.

## Windows

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([1, 2, 3, 4, 5, null, 7, 8]);
console.log(new pd.DataFrame({
  value: s,
  roll3: s.rolling(3).mean(),
  roll3_min1: s.rolling(3, { minPeriods: 1 }).sum(),
  centered: s.rolling(3, { center: true }).max(),
  expanding: s.expanding().mean(),
  ewm: s.ewm({ span: 3 }).mean().round(3),
}));
```

```text
   value  roll3  roll3_min1  centered  expanding    ewm
0    1.0    NaN         1.0       NaN   1.000000  1.000
1    2.0    NaN         3.0       3.0   1.500000  1.667
2    3.0    2.0         6.0       4.0   2.000000  2.429
3    4.0    3.0         9.0       5.0   2.500000  3.267
4    5.0    4.0        12.0       NaN   3.000000  4.161
5    NaN    NaN         9.0       NaN   3.000000  4.161
6    7.0    NaN        12.0       NaN   3.666667  6.074
7    8.0    NaN        15.0       NaN   4.285714  7.179
```

`rolling` supports `sum`, `mean`, `median`, `min`, `max`, `std`, `var`, `sem`, `skew`, `kurt`, `count`, `quantile`, `rank`, `apply`, `agg`, `corr` and `cov`, with `minPeriods`, `center`, `closed`, `step` and weighted windows (`winType`: `triang`, `hamming`, `hann`, `gaussian`, …). Time-based windows use an offset on a datetime index (or an `on` column):

```ts run
import * as pd from 'pandasx';

const s = new pd.Series([1, 2, 3, 4], { index: pd.toDatetime(['2024-01-01', '2024-01-02', '2024-01-05', '2024-01-06']).toArray() as Date[] });
console.log(s.rolling('2D').sum().toArray());
console.log(new pd.Series([1, 2, 3, 4, 5]).rolling(3, { winType: 'triang' }).mean().toArray());
```

```text
[ 1, 3, 3, 7 ]
[ NaN, NaN, 2, 3, 4 ]
```

`ewm` accepts one of `com`, `span`, `halflife` or `alpha`, plus `adjust`, `ignoreNa` and `minPeriods`, and offers `mean`, `sum`, `std`, `var`, `cov` and `corr`.
