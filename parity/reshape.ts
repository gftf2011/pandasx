import { readFileSync } from 'node:fs';
import * as pd from '../src/index.ts';
const { Series, DataFrame } = pd;
const ref = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out: Record<string, unknown> = {};
function norm(v: any): unknown {
  if (v instanceof DataFrame) return { columns: v.columnIndex.labels.map((c: any) => (Array.isArray(c) ? c.map(String) : String(c))), index: v.index.labels.map(norm), values: v.values.map((r) => r.map(norm)) };
  if (v instanceof Series) return { index: v.index.labels.map(norm), values: v.toArray().map(norm) };
  if (v instanceof pd.Index) return v.labels.map(norm);
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'number' && Number.isNaN(v)) return null;
  if (v instanceof pd.Interval) return v.toString();
  return v ?? null;
}
const put = (k: string, f: () => unknown) => { try { out[k] = norm(f()); } catch (e) { out[k] = 'ERROR: ' + (e as Error).message; } };
const str = (s: any) => s.astype('string');
const df = new DataFrame({ region: ['N', 'S', 'N', 'S', 'N', 'E'], prod: ['a', 'a', 'b', 'b', 'a', 'b'], units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5] });
const m = df.setIndex(['region', 'prod']);
put('mi_loc_partial', () => m.loc('N')); put('mi_loc_full', () => m.loc(['S', 'b'])); put('mi_xs_level', () => m.xs('a', { level: 'prod' }));
put('mi_droplevel', () => m.droplevel(0)); put('mi_swaplevel', () => m.swaplevel());
const g = df.groupby(['region', 'prod']).get('units').sum();
put('unstack', () => g.unstack()); put('unstack_fill', () => g.unstack({ fillValue: 0 })); put('unstack_level0', () => g.unstack({ level: 0 }));
put('stack_flat', () => df.get(['units', 'price']).head(2).stack());
const w = df.groupby(['region', 'prod']).get(['units', 'price']).sum().unstack() as pd.DataFrame;
put('df_unstack', () => w); put('df_stack_back', () => w.stack());
put('pivot', () => df.iloc([0, 1, 2, 3]).pivot({ index: 'region', columns: 'prod', values: 'units' }));
put('pivot_multi_values', () => df.iloc([0, 1, 2, 3]).pivot({ index: 'region', columns: 'prod' }));
put('pt_sum', () => pd.pivotTable(df, { index: 'region', columns: 'prod', values: 'units', aggfunc: 'sum' }));
put('pt_margins', () => pd.pivotTable(df, { index: 'region', columns: 'prod', values: 'units', aggfunc: 'sum', margins: true, fillValue: 0 }));
put('pt_multi_agg', () => pd.pivotTable(df, { index: 'region', values: ['units', 'price'], aggfunc: ['sum', 'mean'] }));
put('pt_dict', () => pd.pivotTable(df, { index: 'region', columns: 'prod', values: ['units', 'price'], aggfunc: { units: 'sum', price: 'max' } }));
put('pt_two_idx', () => pd.pivotTable(df, { index: ['region', 'prod'], values: 'units', aggfunc: 'count' }));
put('ct', () => pd.crosstab(df.get('region'), df.get('prod'))); put('ct_margins', () => pd.crosstab(df.get('region'), df.get('prod'), { margins: true }));
put('ct_norm_index', () => pd.crosstab(df.get('region'), df.get('prod'), { normalize: 'index' })); put('ct_norm_all_m', () => pd.crosstab(df.get('region'), df.get('prod'), { normalize: 'all', margins: true }));
put('ct_values', () => pd.crosstab(df.get('region'), df.get('prod'), { values: df.get('units'), aggfunc: 'mean' }));
put('dummies_s', () => pd.getDummies(new Series(['a', 'b', null, 'a']), { dummyNa: true }));
put('dummies_df', () => pd.getDummies(df.get(['region', 'units']), { prefix: 'r', dropFirst: true }));
const x = new Series([1, 7, 5, 4, 6, 3, 10, 2]);
put('cut3', () => str(pd.cut(x, 3))); put('cut_edges', () => str(pd.cut(x, [0, 3, 6, 10])));
put('cut_left', () => str(pd.cut(x, [1, 4, 7, 10], { right: false }))); put('cut_lowest', () => str(pd.cut(x, [1, 4, 7, 10], { includeLowest: true })));
put('cut_labels', () => str(pd.cut(x, [0, 5, 10], { labels: ['low', 'high'] }))); put('cut_codes', () => pd.cut(x, [0, 5, 10], { labels: false }));
put('qcut4', () => str(pd.qcut(x, 4))); put('qcut_q', () => str(pd.qcut(x, [0, 0.5, 1])));
put('factorize', () => pd.factorize(new Series(['b', 'a', null, 'b']))[0]);
put('explode', () => new DataFrame({ a: [[1, 2], [], [3]], b: ['x', 'y', 'z'] }).explode('a'));
const wl = new DataFrame({ id: [1, 2], A1970: [1.0, 2.0], A1980: [3.0, 4.0], B1970: [5.0, 6.0], B1980: [7.0, 8.0] });
put('wide_to_long', () => pd.wideToLong(wl, ['A', 'B'], 'id', 'year'));
const t = new DataFrame({ time: [1, 3, 5, 8], k: ['a', 'b', 'a', 'a'], v: [10, 20, 30, 40] });
const q = new DataFrame({ time: [2, 3, 6, 9], k: ['a', 'a', 'b', 'a'], bid: [1.0, 2.0, 3.0, 4.0] });
put('asof_back', () => pd.mergeAsof(t, q, { on: 'time' })); put('asof_fwd', () => pd.mergeAsof(t, q, { on: 'time', direction: 'forward' }));
put('asof_near_by', () => pd.mergeAsof(t, q, { on: 'time', by: 'k', direction: 'nearest' })); put('asof_tol', () => pd.mergeAsof(t, q, { on: 'time', tolerance: 1, allowExactMatches: false }));
put('ordered', () => pd.mergeOrdered(new DataFrame({ k: [1, 3, 5], a: [1.0, 2, 3] }), new DataFrame({ k: [2, 3, 4], b: [7.0, 8, 9] }), { on: 'k', fillMethod: 'ffill' }));
const L = new DataFrame({ v: [1, 2, 3] }, { index: ['x', 'y', 'z'] }); const R = new DataFrame({ key: ['y', 'z', 'w'], w: [20, 30, 40] });
put('merge_li_ro', () => pd.merge(L, R, { leftIndex: true, rightOn: 'key' })); put('merge_li_ri', () => pd.merge(L, R.setIndex('key'), { leftIndex: true, rightIndex: true, how: 'outer' }));
const a = new DataFrame({ p: [1.0, null, 3.0], q: [null, 5.0, null] }); const b = new DataFrame({ p: [10.0, 20.0, 30.0, 40.0], r: [1, 2, 3, 4] });
put('combine_first', () => a.combineFirst(b));
put('update', () => a.copy().update(new DataFrame({ p: [null, 9.0], q: [8.0, null] }, { index: [1, 2] })));
const c1 = new DataFrame({ a: [1, 2, 3], b: ['x', 'y', 'z'] }); const c2 = new DataFrame({ a: [1, 5, 3], b: ['x', 'y', 'q'] });
put('compare', () => c1.compare(c2)); put('compare_shape', () => c1.compare(c2, { keepShape: true }));
put('gb_agg_list', () => df.groupby('region').get(['units', 'price']).agg(['sum', 'max']));
put('mi_from_product', () => pd.MultiIndex.fromProduct([['a', 'b'], [1, 2]]).labels);
const KNOWN: Record<string, string> = {};
let bad = 0;
const close = (u: any, v: any): boolean => {
  if (Array.isArray(u) && Array.isArray(v)) return u.length === v.length && u.every((p, i) => close(p, v[i]));
  if (u && v && typeof u === 'object' && typeof v === 'object') return Object.keys(v).every((k) => close(u[k], v[k]));
  if (typeof u === 'number' && typeof v === 'number') return Math.abs(u - v) <= 1e-6 * Math.max(1, Math.abs(v));
  if (typeof u === 'boolean' && typeof v === 'number') return Number(u) === v;
  return u === v;
};
for (const k of Object.keys(ref)) {
  if (!(k in out)) { console.log('MISSING', k); bad++; continue; }
  if (!close(out[k], ref[k]) && KNOWN[k]) { console.log('KNOWN', k, '-', KNOWN[k]); continue; }
  if (!close(out[k], ref[k])) { bad++; console.log('DIFF', k, '\n  pandas:', JSON.stringify(ref[k]), '\n  node:  ', JSON.stringify(out[k])); }
}
console.log(bad ? `${bad} differences` : 'ALL MATCH', `(${Object.keys(ref).length} cases)`);
