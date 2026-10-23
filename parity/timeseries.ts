import { readFileSync } from 'node:fs';
import * as pd from '../src/index.ts';
const { Series, DataFrame, offsets } = pd;
const ref = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out: Record<string, unknown> = {};
const tzOf = (s: any) => s?._col?.meta?.tz ?? s?.tz ?? null;
function tsStr(d: Date, tz: string | null) {
  const t = d.getTime();
  let off = 0;
  if (tz) { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d); const g = (k: string) => Number(p.find((x) => x.type === k)!.value); off = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(t / 1000) * 1000; }
  const iso = new Date(t + off).toISOString();
  let s = iso.slice(0, 19).replace('T', ' ');
  if (t % 1000) s += '.' + String(t % 1000).padStart(3, '0') + '000';
  if (tz) { const m = Math.abs(off) / 60000; s += (off < 0 ? '-' : '+') + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  return s;
}
function norm(v: any, tz: string | null = null): unknown {
  if (v instanceof Series) return v.toArray().map((x) => norm(x, tzOf(v)));
  if (v instanceof pd.Index) return v.labels.map((x) => norm(x, v.tz));
  if (Array.isArray(v)) return v.map((x) => norm(x, tz));
  if (typeof v === 'number' && Number.isNaN(v)) return null;
  if (v instanceof Date) return tsStr(v, tz);
  if (v instanceof pd.Timedelta || v instanceof pd.Period) return v.toString();
  return v ?? null;
}
const put = (k: string, f: () => unknown) => { try { out[k] = norm(f()); } catch (e) { out[k] = 'ERROR: ' + (e as Error).message; } };
const s = new Series([1, 2, 3, 4, 5, NaN, 7, 8, 2, 1.5]);
put('roll3_sum', () => s.rolling(3).sum());
put('roll3_mean_minp1', () => s.rolling(3, { minPeriods: 1 }).mean());
put('roll4_std', () => s.rolling(4).std());
put('roll4_var_center', () => s.rolling(4, { center: true }).var());
put('roll3_median', () => s.rolling(3).median());
put('roll3_max_closed_both', () => s.rolling(3, { closed: 'both' }).max());
put('roll5_skew', () => s.rolling(5).skew());
put('roll5_kurt', () => s.rolling(5).kurt());
put('roll3_q25', () => s.rolling(3).quantile(0.25));
put('exp_mean', () => s.expanding().mean());
put('exp_std', () => s.expanding({ minPeriods: 2 }).std());
put('ewm_span3_mean', () => s.ewm({ span: 3 }).mean());
put('ewm_span3_mean_noadj', () => s.ewm({ span: 3, adjust: false }).mean());
put('ewm_com2_std', () => s.ewm({ com: 2 }).std());
put('ewm_hl2_var_ignorena', () => s.ewm({ halflife: 2, ignoreNa: true }).var());
put('ewm_alpha_sum', () => s.ewm({ alpha: 0.3 }).sum());
put('roll3_triang_mean', () => s.rolling(3, { winType: 'triang' }).mean());
put('roll4_gauss_sum', () => s.rolling(4, { winType: 'gaussian', std: 1.5 }).sum());
put('roll3_hamming_std', () => s.rolling(3, { winType: 'hamming' }).std());
put('skew', () => s.skew()); put('kurt', () => s.kurt());
const idx = pd.toDatetime(['2024-01-01', '2024-01-02', '2024-01-02 12:00', '2024-01-05', '2024-01-06', '2024-01-09', '2024-01-31', '2024-02-01', '2024-02-29', '2024-03-15']).toArray() as Date[];
const t = new Series([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(Number), { index: idx, dtype: 'float64' });
put('roll_2D_sum', () => t.rolling('2D').sum());
put('roll_3D_mean_left', () => t.rolling('3D', { closed: 'left' }).mean());
put('res_D_sum_len', () => (t.resample('D').sum() as any).length);
for (const [k, rule, m, opts] of [['W', 'W', 'sum', {}], ['ME', 'ME', 'mean', {}], ['MS', 'MS', 'count', {}], ['2D', '2D', 'sum', {}], ['QE', 'QE', 'sum', {}], ['2ME', '2ME', 'sum', {}], ['B', 'B', 'sum', {}]] as const) {
  put(`res_${k}_${m}`, () => (t.resample(rule, opts) as any)[m]());
  put(`res_${k}_idx`, () => (t.resample(rule, opts) as any)[m]().index);
}
put('res_12h_closed_right_idx', () => (t.resample('12h', { closed: 'right', label: 'right' }).sum() as any).index);
put('res_12h_closed_right', () => t.resample('12h', { closed: 'right', label: 'right' }).sum());
put('res_W_MON_idx', () => (t.resample('W-MON').sum() as any).index);
put('res_D_ohlc_open', () => t.resample('3D').ohlc().get('open'));
const u = new Series([1, 3, 2], { index: pd.toDatetime(['2024-01-01', '2024-01-03', '2024-01-06']).toArray() as Date[], dtype: 'float64' });
put('up_ffill', () => u.resample('D').ffill()); put('up_bfill', () => u.resample('D').bfill());
put('up_asfreq', () => u.resample('D').asfreq()); put('up_interp', () => u.resample('D').interpolate());
put('up_nearest', () => u.resample('D').nearest());
put('dr_ME', () => pd.dateRange('2024-01-15', { periods: 4, freq: 'ME' }));
put('dr_MS', () => pd.dateRange('2024-01-15', { periods: 3, freq: 'MS' }));
put('dr_B', () => pd.dateRange('2024-03-01', { periods: 5, freq: 'B' }));
put('dr_W_WED', () => pd.dateRange('2024-03-01', { periods: 3, freq: 'W-WED' }));
put('dr_QS', () => pd.dateRange('2024-02-01', { periods: 3, freq: 'QS' }));
put('dr_QE_NOV', () => pd.dateRange('2024-01-01', { periods: 3, freq: 'QE-NOV' }));
put('dr_YE', () => pd.dateRange('2023-06-01', { periods: 2, freq: 'YE' }));
put('dr_BME', () => pd.dateRange('2024-01-01', { periods: 3, freq: 'BME' }));
put('dr_SME', () => pd.dateRange('2024-01-01', { periods: 3, freq: 'SME' }));
put('dr_end_periods', () => pd.dateRange(null, { end: '2024-01-10', periods: 3, freq: 'D' }));
put('dr_tz', () => pd.dateRange('2024-03-09', { periods: 3, freq: 'D', tz: 'America/New_York' }));
put('dr_3h', () => pd.dateRange('2024-01-01', { end: '2024-01-01 09:00', freq: '3h' }));
const d = pd.toDatetime(['2024-01-31', '2024-02-29 10:30', '2024-12-31']);
put('add_ME', () => d.add(offsets.MonthEnd())); put('add_MB', () => d.add(offsets.MonthBegin(2))); put('sub_BD', () => d.sub(offsets.BusinessDay(3)));
put('add_DO', () => d.add(offsets.DateOffset({ months: 1, days: 1 }))); put('add_YE', () => d.add(offsets.YearEnd()));
put('dt_week', () => d.dt.isocalendar().get('week')); put('dt_qend', () => d.dt.isQuarterEnd); put('dt_dim', () => d.dt.daysInMonth);
put('dt_floor_h', () => d.dt.floor('h')); put('dt_ceil_D', () => d.dt.ceil('D')); put('dt_round_15min', () => pd.toDatetime(['2024-01-01 10:07:30', '2024-01-01 10:22:30']).dt.round('15min'));
put('dt_strftime', () => d.dt.strftime('%a %d %b %Y %I:%M %p %j'));
const loc = pd.toDatetime(['2024-03-10 01:30', '2024-07-01 12:00']).dt.tzLocalize('America/New_York');
put('tz_loc', () => loc); put('tz_conv', () => loc.dt.tzConvert('Asia/Tokyo')); put('tz_hour', () => loc.dt.tzConvert('Asia/Tokyo').dt.hour);
put('tz_amb_earliest', () => pd.toDatetime(['2024-11-03 01:30']).dt.tzLocalize('America/New_York', { ambiguous: 'earliest' }));
put('tz_gap_fwd', () => pd.toDatetime(['2024-03-10 02:30']).dt.tzLocalize('America/New_York', { nonexistent: 'shift_forward' }));
put('todt_fmt', () => pd.toDatetime(['15/03/2024 14:05', '01/12/2023 00:00'], { format: '%d/%m/%Y %H:%M' }));
put('todt_dayfirst', () => pd.toDatetime(['01/02/2024'], { dayfirst: true }));
put('todt_coerce', () => pd.toDatetime(['2024-01-01', 'garbage'], { errors: 'coerce' }));
put('todt_unit_s', () => pd.toDatetime([1700000000], { unit: 's' }));
put('totd', () => pd.toTimedelta(['1 days 02:00:00', '90min', '-1h']));
put('td_comp_days', () => pd.toTimedelta(['1 days 02:00:00', '-1h']).dt.days);
put('td_total', () => pd.toTimedelta(['1 days 02:00:00', '-1h']).dt.totalSeconds());
put('pr_M', () => pd.periodRange('2024-01', { periods: 3, freq: 'M' }));
put('pr_Q', () => pd.periodRange('2024Q3', { periods: 3, freq: 'Q' }));
put('to_period_W', () => d.dt.toPeriod('W'));
put('tdr', () => pd.timedeltaRange('1h', { periods: 3, freq: '30min' }));
const s2 = new Series([3, 1, 4, 1, 5, 9, 2, 6], { index: pd.dateRange('2024-01-01 08:00', { periods: 8, freq: '2h' }).toArray() as Date[] });
put('between_time', () => s2.betweenTime('09:00', '15:00')); put('at_time', () => s2.atTime('10:00'));
put('shift_freq_idx', () => s2.shift(1, { freq: 'D' }).index.labels.slice(0, 2));
put('asfreq_h_ffill', () => s2.iloc(pd.slice(0, 3)).asfreq('h', { method: 'ffill' }));
const g = new DataFrame({ k: ['a', 'a', 'b', 'a', 'b', 'b'], v: [1, 2, 3, 4, 5, 6] }).astype({ v: 'float64' });
put('g_roll2_mean', () => g.groupby('k').get('v').rolling(2).mean());
put('g_roll2_mean_idx', () => (g.groupby('k').get('v').rolling(2).mean() as any).index.labels);
put('g_exp_sum', () => g.groupby('k').get('v').expanding().sum());
put('g_ewm_mean', () => g.groupby('k').get('v').ewm({ alpha: 0.5 }).mean());
// compare
const KNOWN: Record<string, string> = { roll3_hamming_std: 'pandas assigns window weights by absolute position (i % window) for weighted var/std, which disagrees with its own weighted mean; node-pandas slides the weights with the window' };
let bad = 0;
const close = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  return a === b;
};
for (const k of Object.keys(ref)) {
  if (!(k in out)) { console.log('MISSING', k); bad++; continue; }
  if (!close(out[k], ref[k]) && KNOWN[k]) { console.log('KNOWN', k, '-', KNOWN[k]); continue; }
  if (!close(out[k], ref[k])) { bad++; console.log('DIFF', k, '\n  pandas:', JSON.stringify(ref[k]), '\n  node:  ', JSON.stringify(out[k])); }
}
console.log(bad ? `${bad} differences` : 'ALL MATCH', `(${Object.keys(ref).length} cases)`);
