import { readFileSync } from 'node:fs';
import * as pd from '../src/index.ts';
const { Series, DataFrame } = pd;
const ref = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out: Record<string, unknown> = {};
function norm(v: any): unknown {
  if (v instanceof DataFrame) return { columns: v.columns, index: v.index.labels.map(norm), values: v.values.map((r) => r.map(norm)) };
  if (v instanceof Series) return v.toArray().map(norm);
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'number' && Number.isNaN(v)) return null;
  if (typeof v === 'boolean') return v;
  return v ?? null;
}
const put = (k: string, f: () => unknown) => { try { out[k] = norm(f()); } catch (e) { out[k] = 'ERROR: ' + (e as Error).message; } };
const s = new Series([3, 1, 4, 1, 5, NaN, 9, 2, 6, 5]);
for (const m of ['average', 'min', 'max', 'first', 'dense'] as const) put(`rank_${m}`, () => s.rank({ method: m }));
put('rank_pct_desc_top', () => s.rank({ pct: true, ascending: false, naOption: 'top' }));
const x = new Series([1, 2, 3, 4, 5, 6, 7], { dtype: 'float64' }), y = new Series([2, 1, 4, 3, 7, 5, 6], { dtype: 'float64' });
put('corr_p', () => x.corr(y)); put('corr_s', () => x.corr(y, { method: 'spearman' })); put('corr_k', () => x.corr(y, { method: 'kendall' }));
put('cov', () => x.cov(y)); put('autocorr2', () => y.autocorr(2));
const df = new DataFrame({ a: x, b: y, c: x.pow(2) });
put('df_corr_k', () => df.corr({ method: 'kendall' })); put('df_cov', () => df.cov());
const z = new Series([NaN, 1, NaN, NaN, 4, 9, NaN, 25, NaN]);
for (const m of ['linear', 'nearest', 'zero', 'pad', 'quadratic', 'cubic', 'pchip', 'akima'] as const) put(`interp_${m}`, () => z.interpolate({ method: m }));
put('interp_poly2', () => z.interpolate({ method: 'polynomial', order: 2 }));
put('interp_limit_both', () => z.interpolate({ limit: 1, limitDirection: 'both' }));
put('interp_outside', () => z.interpolate({ limitArea: 'outside', limitDirection: 'both' }));
put('interp_index', () => new Series([0, NaN, 10, NaN, 40], { index: [0, 1, 5, 6, 10] }).interpolate({ method: 'index' }));
put('skewdf', () => df.skew()); put('kurtdf', () => df.kurt());
const st = new Series(['Ana Maria', 'bruno', null, 'CARLA-souza', '  x  ', 'a1b22c333']);
put('str_title', () => st.str.title()); put('str_cap', () => st.str.capitalize()); put('str_swap', () => st.str.swapcase());
put('str_center', () => st.str.center(13, '*')); put('str_zfill', () => new Series(['-5', '42', '+3']).str.zfill(5));
put('str_count', () => st.str.count('a')); put('str_find', () => st.str.find('a')); put('str_rfind', () => st.str.rfind('a'));
put('str_isalnum', () => st.str.isalnum()); put('str_isupper', () => st.str.isupper()); put('str_istitle', () => st.str.istitle());
put('str_split_n', () => st.str.split(' ', { n: 1 }));
put('str_rsplit', () => new Series(['a-b-c']).str.rsplit('-', { n: 1 }));
put('str_extract', () => st.str.extract(/([a-z])(\d+)/));
put('str_slice_step', () => st.str.slice(0, undefined, 2)); put('str_slice_replace', () => st.str.sliceReplace(1, 3, 'XX'));
put('str_wrap', () => new Series(['the quick brown fox jumps']).str.wrap(10));
put('str_replace_n', () => new Series(['aaaa']).str.replace('a', 'b', { n: 2 })); put('str_replace_re', () => new Series(['a1b22']).str.replace(/(\d+)/, '<$1>'));
put('str_dummies', () => new Series(['a|b', 'b', null]).str.getDummies());
put('str_len', () => st.str.len()); put('str_strip_chars', () => new Series(['xxhixx']).str.strip('x'));
put('str_pad_both', () => new Series(['ab']).str.pad(5, 'both', '-'));
const g = new DataFrame({ k: ['a', 'b', 'a', 'b', 'a', 'b', 'a'], v: [1, 10, 2, NaN, 3, 30, 4] });
const G = g.groupby('k').get('v');
put('g_shift', () => G.shift()); put('g_diff', () => G.diff()); put('g_pct', () => G.pctChange()); put('g_rank', () => G.rank());
put('g_cumprod', () => G.cumprod()); put('g_ffill', () => G.ffill()); put('g_nth1', () => G.nth(1)); put('g_quant', () => G.quantile(0.25));
put('g_describe', () => G.describe()); put('g_ngroup', () => g.groupby('k').ngroup()); put('g_cumcount_desc', () => g.groupby('k').cumcount({ ascending: false }));
put('g_sem', () => G.sem()); put('g_idxmin', () => G.idxmin());
const d2 = new DataFrame({ a: [1, 2, 3, 4], b: ['x', 'y', 'x', 'z'], c: [10, 20, 30, 40] }).astype({ c: 'float64' });
put('q1', () => d2.query('a > 1 and b != "z"')); put('q2', () => d2.query('b in ["x", "z"] | c >= 30')); put('q3', () => d2.query('1 < a <= 3 and not b == "y"'));
put('q4', () => d2.query('c / a == 10 and a % 2 == 0')); put('q5', () => d2.query('b.str.contains("x") or index == 3'));
put('ev1', () => d2.eval('a * 2 + c ** 0.5')); put('ev2', () => d2.eval('d = a + c'));
const KNOWN: Record<string, string> = { interp_pad: "method='pad' was removed from interpolate in pandas 3; pandasx keeps it" };
let bad = 0;
const close = (a: any, b: any): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => close(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') return Object.keys(b).every((k) => close(a[k], b[k]));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  return a === b;
};
for (const k of Object.keys(ref)) {
  if (!(k in out)) { console.log('MISSING', k); bad++; continue; }
  if (!close(out[k], ref[k]) && KNOWN[k]) { console.log('KNOWN', k, '-', KNOWN[k]); continue; }
  if (!close(out[k], ref[k])) { bad++; console.log('DIFF', k, '\n  pandas:', JSON.stringify(ref[k]), '\n  node:  ', JSON.stringify(out[k])); }
}
console.log(bad ? `${bad} differences` : 'ALL MATCH', `(${Object.keys(ref).length} cases)`);
