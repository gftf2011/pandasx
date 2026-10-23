// Expected values were checked against pandas 3.1 (see parity/reshape.*).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pd from '../src/index.ts';
import { DataFrame, Series } from '../src/index.ts';

const sales = () => new DataFrame({
  region: ['N', 'S', 'N', 'S', 'N', 'E'], prod: ['a', 'a', 'b', 'b', 'a', 'b'],
  units: [10, 5, 7, 3, 2, 4], price: [1.5, 2.0, 3.0, 1.0, 1.5, 2.5],
});

describe('MultiIndex rows', () => {
  const m = sales().setIndex(['region', 'prod']);
  it('partial and full keys', () => {
    const n = m.loc('N');
    assert.deepEqual(n.index.toArray(), ['a', 'b', 'a']);
    assert.equal(n.index.name, 'prod');
    assert.deepEqual((m.loc(['S', 'b']) as unknown as Series).toArray(), [3, 1]);
    assert.deepEqual(m.loc([['N', 'b'], ['E', 'b']]).get('units').toArray(), [7, 4]);
  });
  it('xs, droplevel, swaplevel, levels', () => {
    const a = m.xs('a', { level: 'prod' }) as DataFrame;
    assert.deepEqual(a.index.toArray(), ['N', 'S', 'N']);
    assert.deepEqual(m.droplevel(0).index.toArray(), ['a', 'a', 'b', 'b', 'a', 'b']);
    assert.deepEqual(m.swaplevel().index.names, ['prod', 'region']);
    assert.deepEqual(m.index.levels, [['E', 'N', 'S'], ['a', 'b']]);
    assert.deepEqual(pd.MultiIndex.fromProduct([['a', 'b'], [1, 2]]).toArray(), [['a', 1], ['a', 2], ['b', 1], ['b', 2]]);
  });
});

describe('MultiIndex columns', () => {
  const g = sales().groupby('region').get(['units', 'price']).agg(['sum', 'max']);
  it('tuples, selection and display', () => {
    assert.deepEqual(g.columnIndex.toArray(), [['units', 'sum'], ['units', 'max'], ['price', 'sum'], ['price', 'max']]);
    assert.deepEqual(g.column(['units', 'sum']).toArray(), [4, 19, 8]);
    assert.deepEqual((g.get('price') as unknown as DataFrame).columns, ['sum', 'max']);
    assert.equal(g.toString().split('\n').slice(0, 3).join('\n'), '        units       price\n          sum  max    sum  max\nregion');
    assert.deepEqual(g.flattenColumns().columns, ['units_sum', 'units_max', 'price_sum', 'price_max']);
    assert.throws(() => g.droplevel(0, { axis: 1 }), /Duplicate column label/);
    assert.deepEqual(g.iloc(null, [0, 2]).droplevel(1, { axis: 1 }).columns, ['units', 'price']);
  });
});

describe('stack / unstack / pivot', () => {
  const s = sales().groupby(['region', 'prod']).get('units').sum();
  it('unstack a Series', () => {
    const u = s.unstack({ fillValue: 0 });
    assert.deepEqual(u.columns, ['a', 'b']);
    assert.deepEqual(u.values, [[0, 4], [12, 7], [5, 3]]);
    assert.deepEqual(s.unstack({ level: 0 }).columns, ['E', 'N', 'S']);
  });
  it('stack round trip', () => {
    const st = sales().get(['units', 'price']).head(2).stack() as Series;
    assert.deepEqual(st.index.toArray(), [[0, 'units'], [0, 'price'], [1, 'units'], [1, 'price']]);
    assert.deepEqual(st.toArray(), [10, 1.5, 5, 2]);
    const w = sales().groupby(['region', 'prod']).get(['units', 'price']).sum().unstack() as DataFrame;
    assert.deepEqual(w.columnIndex.toArray(), [['units', 'a'], ['units', 'b'], ['price', 'a'], ['price', 'b']]);
    assert.equal((w.stack() as DataFrame).length, 6);
  });
  it('pivot rejects duplicates', () => {
    const p = sales().iloc([0, 1, 2, 3]).pivot({ index: 'region', columns: 'prod', values: 'units' });
    assert.deepEqual(p.values, [[10, 7], [5, 3]]);
    assert.throws(() => sales().pivot({ index: 'region', columns: 'prod', values: 'units' }), /duplicate/);
  });
});

describe('pivotTable / crosstab', () => {
  it('margins and fill', () => {
    const t = pd.pivotTable(sales(), { index: 'region', columns: 'prod', values: 'units', aggfunc: 'sum', margins: true, fillValue: 0 });
    assert.deepEqual(t.index.toArray(), ['E', 'N', 'S', 'All']);
    assert.deepEqual(t.columns, ['a', 'b', 'All']);
    assert.deepEqual(t.values, [[0, 4, 4], [12, 7, 19], [5, 3, 8], [17, 14, 31]]);
  });
  it('several aggregations give (func, value) columns', () => {
    const t = pd.pivotTable(sales(), { index: 'region', values: ['units', 'price'], aggfunc: ['sum', 'mean'] });
    assert.deepEqual(t.columnIndex.toArray(), [['sum', 'price'], ['sum', 'units'], ['mean', 'price'], ['mean', 'units']]);
  });
  it('crosstab with normalisation', () => {
    const df = sales();
    assert.deepEqual(pd.crosstab(df.get('region'), df.get('prod')).values, [[0, 1], [2, 1], [1, 1]]);
    const n = pd.crosstab(df.get('region'), df.get('prod'), { normalize: 'index' });
    assert.deepEqual(n.values, [[0, 1], [2 / 3, 1 / 3], [0.5, 0.5]]);
  });
});

describe('encoding and binning', () => {
  it('getDummies', () => {
    const d = pd.getDummies(sales().get(['region', 'units']), { prefix: 'r', dropFirst: true });
    assert.deepEqual(d.columns, ['units', 'r_N', 'r_S']);
    assert.deepEqual(pd.fromDummies(pd.getDummies(new Series(['x', 'y', 'x']))).get('').toArray(), ['x', 'y', 'x']);
  });
  it('cut / qcut produce interval categories', () => {
    const x = new Series([1, 7, 5, 4, 6, 3, 10, 2]);
    assert.deepEqual(pd.cut(x, 3).astype('string').toArray().slice(0, 2), ['(0.991, 4.0]', '(4.0, 7.0]']);
    assert.deepEqual(pd.cut(x, [0, 5, 10]).astype('string').toArray().slice(0, 2), ['(0, 5]', '(5, 10]']);
    assert.deepEqual(pd.cut(x, [0, 5, 10], { labels: ['low', 'high'] }).toArray().slice(0, 2), ['low', 'high']);
    assert.deepEqual(pd.qcut(x, 4).cat.categories.map(String), ['(0.999, 2.75]', '(2.75, 4.5]', '(4.5, 6.25]', '(6.25, 10.0]']);
    assert.ok(new pd.Interval(0, 1).contains(1) && !new pd.Interval(0, 1).contains(0));
  });
  it('factorize / explode / wideToLong', () => {
    assert.deepEqual(pd.factorize(['b', 'a', null, 'b']), [[0, 1, -1, 0], ['b', 'a']]);
    const e = new DataFrame({ a: [[1, 2], [], [3]], b: ['x', 'y', 'z'] }).explode('a');
    assert.deepEqual(e.index.toArray(), [0, 0, 1, 2]);
    assert.deepEqual(e.get('a').toArray(), [1, 2, NaN, 3]);
    const wl = pd.wideToLong(new DataFrame({ id: [1, 2], A1970: [1, 2], A1980: [3, 4] }), 'A', 'id', 'year');
    assert.deepEqual(wl.index.toArray(), [[1, 1970], [2, 1970], [1, 1980], [2, 1980]]);
  });
});

describe('merging and combining', () => {
  const t = new DataFrame({ time: [1, 3, 5, 8], k: ['a', 'b', 'a', 'a'], v: [10, 20, 30, 40] });
  const q = new DataFrame({ time: [2, 3, 6, 9], k: ['a', 'a', 'b', 'a'], bid: [1, 2, 3, 4] });
  it('mergeAsof directions, by and tolerance', () => {
    assert.deepEqual(pd.mergeAsof(t, q, { on: 'time' }).get('bid').toArray(), [NaN, 2, 2, 3]);
    assert.deepEqual(pd.mergeAsof(t, q, { on: 'time', direction: 'forward' }).get('bid').toArray(), [1, 2, 3, 4]);
    assert.deepEqual(pd.mergeAsof(t, q, { on: 'time', by: 'k', direction: 'nearest' }).get('bid').toArray(), [1, 3, 2, 4]);
  });
  it('merge on index', () => {
    const L = new DataFrame({ v: [1, 2, 3] }, { index: ['x', 'y', 'z'] });
    const R = new DataFrame({ key: ['y', 'z', 'w'], w: [20, 30, 40] });
    const m = pd.merge(L, R, { leftIndex: true, rightOn: 'key' });
    assert.deepEqual(m.index.toArray(), [0, 1]);
    assert.deepEqual(m.get('w').toArray(), [20, 30]);
  });
  it('combineFirst / update / compare', () => {
    const a = new DataFrame({ p: [1, null, 3] });
    const b = new DataFrame({ p: [10, 20, 30, 40] });
    assert.deepEqual(a.combineFirst(b).get('p').toArray(), [1, 20, 3, 40]);
    const u = a.copy().update(new DataFrame({ p: [9] }, { index: [1] }));
    assert.deepEqual(u.get('p').toArray(), [1, 9, 3]);
    const c = new DataFrame({ a: [1, 2, 3] }).compare(new DataFrame({ a: [1, 5, 3] }));
    assert.deepEqual(c.columnIndex.toArray(), [['a', 'self'], ['a', 'other']]);
    assert.deepEqual(c.values, [[2, 5]]);
  });
});
