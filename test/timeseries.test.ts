// Expected values below were produced by pandas 3.1 (see parity/).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pd from '../src/index.ts';
import { DataFrame, offsets, Series } from '../src/index.ts';

const near = (actual: unknown[], expected: (number | null)[]) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((a, i) => {
    const e = expected[i];
    if (e === null) assert.ok(a === null || Number.isNaN(a), `pos ${i}: ${a} should be NA`);
    else assert.ok(Math.abs((a as number) - e) < 1e-9 * Math.max(1, Math.abs(e)), `pos ${i}: ${a} != ${e}`);
  });
};
const iso = (s: Series | pd.Index) => (s instanceof Series ? s.toArray() : s.labels).map((d) => (d as Date).toISOString().slice(0, 16));

const s = new Series([1, 2, 3, 4, 5, NaN, 7, 8, 2, 1.5]);
const idx = pd.toDatetime(['2024-01-01', '2024-01-02', '2024-01-02 12:00', '2024-01-05', '2024-01-06', '2024-01-09', '2024-01-31', '2024-02-01', '2024-02-29', '2024-03-15']).toArray() as Date[];
const t = new Series([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { index: idx, dtype: 'float64' });

describe('datetime index lookups', () => {
  const s = new Series([0, 1, 2, 3, 4, 5], { index: pd.dateRange('2024-02-28 22:00', { periods: 6, freq: 'h' }).toArray() as Date[] });
  it('slices with date strings that need not exist, like pandas', () => {
    assert.deepEqual(s.loc(pd.slice('2024-02-29 00:30', '2024-02-29 02:00')).toArray(), [3, 4]);
    assert.deepEqual(s.loc(pd.slice(null, '2024-02-28')).toArray(), [0, 1]);
    assert.deepEqual(s.loc(pd.slice('2024-02-29 01', null)).toArray(), [3, 4, 5]);
    const df = new DataFrame({ v: [0, 1, 2, 3, 4, 5] }, { index: s.index });
    assert.deepEqual(df.loc(pd.slice('2024-02-29 01:00', '2024-02-29 02:00'), 'v').toArray(), [3, 4]);
  });
  it('partial strings select a whole period; exact strings a single label', () => {
    assert.deepEqual((s.loc('2024-02-29') as Series).toArray(), [2, 3, 4, 5]);
    assert.deepEqual((s.loc('2024-02') as Series).toArray(), [0, 1, 2, 3, 4, 5]);
    assert.equal(s.loc('2024-02-29 01:00'), 3);
    assert.deepEqual((s.tzLocalize('America/Sao_Paulo').loc('2024-02-29') as Series).toArray(), [2, 3, 4, 5]);
  });
});

describe('rolling / expanding / ewm', () => {
  it('apply passes a Series by default, raw arrays with raw: true', () => {
    const s = new Series([1, 5, 2, 8, 3]);
    assert.deepEqual(s.rolling(3).apply((w) => (w.max() as number) - (w.min() as number)).toArray(), [NaN, NaN, 4, 6, 6]);
    assert.deepEqual(s.rolling(2).apply((w) => w.index.labels[1] as number).toArray(), [NaN, 1, 2, 3, 4]);
    assert.deepEqual(s.rolling(3).apply((a) => a.reduce((x, y) => x + y, 0), { raw: true }).toArray(), [NaN, NaN, 8, 15, 13]);
  });
  it('fixed windows', () => {
    near(s.rolling(4).std().toArray(), [null, null, null, 1.2909944487358056, 1.2909944487358056, null, null, null, null, 3.3509948771471834]);
    near(s.rolling(3, { minPeriods: 1 }).mean().toArray(), [1, 1.5, 2, 3, 4, 4.5, 6, 7.5, 17 / 3, 23 / 6]);
    near(s.rolling(3).median().toArray(), [null, null, 2, 3, 4, null, null, null, 7, 2]);
    near(s.rolling(5).skew().toArray(), [null, null, null, null, 0, null, null, null, null, null]);
    near(s.expanding().max().toArray(), [1, 2, 3, 4, 5, 5, 7, 8, 8, 8]);
  });
  it('time-based windows', () => {
    near(t.rolling('2D').sum().toArray(), [0, 1, 3, 3, 7, 5, 6, 13, 8, 9]);
  });
  it('weighted windows', () => {
    near(new Series([1, 2, 3, 4, 5]).rolling(3, { winType: 'triang' }).mean().toArray(), [null, null, 2, 3, 4]);
  });
  it('ewm', () => {
    near(s.ewm({ span: 3 }).mean().toArray(), [1, 1.6666666666666667, 2.4285714285714284, 3.2666666666666666, 4.161290322580645, 4.161290322580645, 6.073684210526316, 7.179372197309417, 4.411273486430063, 2.907164480322906]);
    near(s.ewm({ span: 3, adjust: false }).mean().toArray(), [1, 1.5, 2.25, 3.125, 4.0625, 4.0625, 6.265625, 7.1328125, 4.56640625, 3.033203125]);
    near(s.ewm({ com: 2 }).std().toArray(), [null, 0.7071067811865476, 0.98675438206593, 1.2476698930179086, 1.4864192600175838, 1.4864192600175838, 2.216688648626767, 2.3021018797446464, 3.036186548376679, 2.9772992649679755]);
  });
  it('per group', () => {
    const g = new DataFrame({ k: ['a', 'a', 'b', 'a', 'b', 'b'], v: [1, 2, 3, 4, 5, 6] });
    const r = g.groupby('k').get('v').rolling(2).mean() as Series;
    near(r.toArray(), [null, 1.5, 3, null, 4, 5.5]);
    assert.deepEqual(r.index.toArray(), [['a', 0], ['a', 1], ['a', 3], ['b', 2], ['b', 4], ['b', 5]]);
  });
});

describe('resample', () => {
  it('weekly, monthly, multi-month and closed/label', () => {
    const w = t.resample('W').sum() as Series;
    near(w.toArray(), [10, 5, 0, 0, 13, 0, 0, 0, 8, 0, 9]);
    assert.equal(iso(w.index)[0], '2024-01-07T00:00');
    near((t.resample('ME').mean() as Series).toArray(), [3, 7.5, 9]);
    assert.deepEqual(iso((t.resample('2ME').sum() as Series).index), ['2024-01-31T00:00', '2024-03-31T00:00']);
    near((t.resample('2ME').sum() as Series).toArray(), [21, 24]);
    const h = t.resample('12h', { closed: 'right', label: 'right' }).sum() as Series;
    near(h.toArray().slice(0, 5), [0, 0, 1, 2, 0]);
    assert.equal(h.length, 149);
  });
  it('ohlc, size and agg', () => {
    near(t.resample('3D').ohlc().get('open').toArray().slice(0, 2), [0, 3]);
    assert.deepEqual(t.resample('ME').size().toArray(), [7, 2, 1]);
    const df = new DataFrame({ x: t.toArray(), y: t.mul(2).toArray() }, { index: idx });
    assert.deepEqual((df.resample('ME').agg({ x: 'sum', y: ['min', 'max'] }) as DataFrame).columnIndex.toArray(), [['x', 'sum'], ['y', 'min'], ['y', 'max']]);
  });
  it('upsampling', () => {
    const u = new Series([1, 3, 2], { index: pd.toDatetime(['2024-01-01', '2024-01-03', '2024-01-06']).toArray() as Date[], dtype: 'float64' });
    near((u.resample('D').ffill() as Series).toArray(), [1, 1, 3, 3, 3, 2]);
    near((u.resample('D').asfreq() as Series).toArray(), [1, null, 3, null, null, 2]);
    near((u.resample('D').interpolate() as Series).toArray(), [1, 2, 3, 2.6666666666666665, 2.3333333333333335, 2]);
    near((u.resample('D').nearest() as Series).toArray(), [1, 3, 3, 3, 2, 2]);
  });
});

describe('offsets, ranges and conversions', () => {
  it('dateRange with calendar frequencies and time zones', () => {
    assert.deepEqual(iso(pd.dateRange('2024-01-01', { periods: 3, freq: 'BME' })), ['2024-01-31T00:00', '2024-02-29T00:00', '2024-03-29T00:00']);
    assert.deepEqual(iso(pd.dateRange('2024-03-01', { periods: 5, freq: 'B' })).map((d) => d.slice(8, 10)), ['01', '04', '05', '06', '07']);
    assert.deepEqual(iso(pd.dateRange('2024-01-15', { periods: 3, freq: 'MS' })).map((d) => d.slice(0, 10)), ['2024-02-01', '2024-03-01', '2024-04-01']);
    const ny = pd.dateRange('2024-03-09', { periods: 3, freq: 'D', tz: 'America/New_York' });
    assert.deepEqual(ny.toArray().map((d) => (d as Date).toISOString()), ['2024-03-09T05:00:00.000Z', '2024-03-10T05:00:00.000Z', '2024-03-11T04:00:00.000Z']);
    assert.equal(ny.toString().split('\n')[2], '2  2024-03-11 00:00:00-04:00');
  });
  it('offset arithmetic', () => {
    const d = pd.toDatetime(['2024-01-31', '2024-02-29 10:30', '2024-12-31']);
    assert.deepEqual(iso(d.add(offsets.MonthEnd())), ['2024-02-29T00:00', '2024-03-31T10:30', '2025-01-31T00:00']);
    assert.deepEqual(iso(d.sub(offsets.BusinessDay(3))), ['2024-01-26T00:00', '2024-02-26T10:30', '2024-12-26T00:00']);
    assert.deepEqual(iso(d.add(offsets.DateOffset({ months: 1, days: 1 }))).map((x) => x.slice(0, 10)), ['2024-03-01', '2024-03-30', '2025-02-01']);
  });
  it('time zones and DST', () => {
    const loc = pd.toDatetime(['2024-03-10 01:30', '2024-07-01 12:00']).dt.tzLocalize('America/New_York');
    assert.deepEqual(loc.dt.tzConvert('Asia/Tokyo').dt.strftime('%Y-%m-%d %H:%M%z').toArray(), ['2024-03-10 15:30+0900', '2024-07-02 01:00+0900']);
    assert.throws(() => pd.toDatetime(['2024-03-10 02:30']).dt.tzLocalize('America/New_York'), RangeError);
    const fwd = pd.toDatetime(['2024-03-10 02:30']).dt.tzLocalize('America/New_York', { nonexistent: 'shift_forward' });
    assert.equal((fwd.iat(0) as Date).toISOString(), '2024-03-10T07:00:00.000Z');
  });
  it('toDatetime / toTimedelta / periods', () => {
    assert.deepEqual(iso(pd.toDatetime(['15/03/2024 14:05'], { format: '%d/%m/%Y %H:%M' })), ['2024-03-15T14:05']);
    assert.deepEqual(iso(pd.toDatetime(['01/02/2024'], { dayfirst: true })), ['2024-02-01T00:00']);
    assert.deepEqual(pd.toDatetime(['2024-01-01', 'garbage'], { errors: 'coerce' }).isna().toArray(), [false, true]);
    assert.deepEqual(pd.toTimedelta(['1 days 02:00:00', '90min', '-1h']).toArray().map(String), ['1 days 02:00:00', '0 days 01:30:00', '-1 days +23:00:00']);
    assert.deepEqual(pd.periodRange('2024Q3', { periods: 3, freq: 'Q' }).toArray().map(String), ['2024Q3', '2024Q4', '2025Q1']);
    assert.deepEqual(pd.toDatetime(['2024-01-31']).dt.toPeriod('W').toArray().map(String), ['2024-01-29/2024-02-04']);
  });
  it('time-of-day selection, shift with freq, asfreq', () => {
    const s2 = new Series([3, 1, 4, 1, 5, 9, 2, 6], { index: pd.dateRange('2024-01-01 08:00', { periods: 8, freq: '2h' }).toArray() as Date[] });
    assert.deepEqual(s2.betweenTime('09:00', '15:00').toArray(), [1, 4, 1]);
    assert.deepEqual(s2.atTime('10:00').toArray(), [1]);
    assert.equal((s2.shift(1, { freq: 'D' }).index.labels[0] as Date).toISOString(), '2024-01-02T08:00:00.000Z');
    assert.deepEqual(s2.iloc(pd.slice(0, 3)).asfreq('h', { method: 'ffill' }).toArray(), [3, 3, 1, 1, 4]);
    assert.deepEqual(s2.truncate({ before: '2024-01-01 12:00', after: '2024-01-01 16:00' }).toArray(), [4, 1, 5]);
  });
});
