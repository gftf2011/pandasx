import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categorical, concat, DataFrame, merge, Series, dateRange, toDatetime } from '../src/index.ts';

const sales = () =>
  new DataFrame({
    region: ['N', 'S', 'N', 'S', 'N', null],
    product: ['a', 'a', 'b', 'b', 'a', 'a'],
    units: [10, 5, 7, 3, 2, 100],
    price: [1.5, 2, 3, 1, 1.5, 9],
  });

describe('groupby', () => {
  it('named aggregation may reuse a column name as the output name', () => {
    const df = new DataFrame({ k: ['a', 'b', 'a'], revenue: [1, 2, 3], units: [1, 2, 3] });
    const named = df.groupby('k').agg({ revenue: ['revenue', 'sum'], tickets: ['revenue', 'count'], units: ['units', 'max'] });
    assert.deepEqual(named.toDict('list'), { revenue: [4, 2], tickets: [2, 1], units: [3, 2] });
    assert.deepEqual(df.groupby('k').agg({ revenue: ['min', 'max'] }).columnIndex.toArray(), [['revenue', 'min'], ['revenue', 'max']]);
  });
  it('asIndex: false keeps the keys as columns for a selected column', () => {
    const df = new DataFrame({ k: ['b', 'a', 'b'], j: ['x', 'x', 'y'], v: [1, 2, 3] });
    assert.deepEqual(df.groupby('k', { asIndex: false }).get('v').sum().toDict('list'), { k: ['a', 'b'], v: [2, 4] });
    assert.deepEqual(df.groupby('k', { asIndex: false }).get('v').size().toDict('list'), { k: ['a', 'b'], size: [1, 2] });
    assert.deepEqual(df.groupby(['k', 'j'], { asIndex: false }).get('v').mean().toDict('list'), { k: ['a', 'b', 'b'], j: ['x', 'x', 'y'], v: [2, 1, 3] });
    assert.throws(() => new Series([1]).groupby([1], { asIndex: false }), /only valid when grouping a DataFrame/);
    assert.deepEqual(df.groupby('k').get('v').sum().resetIndex().columns, ['k', 'v']);
  });
  it('orders categorical keys by category, like pandas', () => {
    const level = categorical(['high', 'low', 'high', 'mid', 'mid'], { categories: ['low', 'mid', 'high'], ordered: true });
    assert.deepEqual(new Series([3, 1, 4, 1, 5]).groupby(level).sum().toDict(), { low: 1, mid: 6, high: 7 });
    const unordered = categorical(['b', 'a', 'b'], { categories: ['b', 'a'] });
    assert.deepEqual(new Series([1, 2, 3]).groupby(unordered).sum().index.toArray(), ['b', 'a']);
    const df = new DataFrame({ u: [3, 1, 4, 1, 5], lvl: level, k: ['x', 'x', 'y', 'y', 'x'] });
    assert.deepEqual(df.groupby(['lvl', 'k']).get('u').sum().index.toArray(), [['low', 'x'], ['mid', 'x'], ['mid', 'y'], ['high', 'x'], ['high', 'y']]);
  });
  it('sum per group sorted by key, dropping NA keys', () => {
    const r = sales().groupby('region').sum();
    assert.deepEqual(r.index.toArray(), ['N', 'S']);
    assert.equal(r.index.name, 'region');
    assert.deepEqual(r.columns, ['units', 'price']);
    assert.deepEqual(r.get('units').toArray(), [19, 8]);
    assert.equal(r.get('units').dtype, 'int64');
  });

  it('keeps NA groups with dropna: false', () => {
    assert.equal(sales().groupby('region', { dropna: false }).ngroups, 3);
  });

  it('multiple keys produce a tuple index', () => {
    const r = sales().groupby(['region', 'product']).get('units').sum();
    assert.deepEqual(r.index.toArray(), [['N', 'a'], ['N', 'b'], ['S', 'a'], ['S', 'b']]);
    assert.equal(r.get(['N', 'a']), 12);
    const flat = (r.resetIndex() as DataFrame);
    assert.deepEqual(flat.columns, ['region', 'product', 'units']);
  });

  it('asIndex: false keeps keys as columns', () => {
    const r = sales().groupby('region', { asIndex: false }).mean();
    assert.deepEqual(r.columns, ['region', 'units', 'price']);
  });

  it('size / count / nunique', () => {
    const g = sales().groupby('region');
    assert.deepEqual(g.size().toArray(), [3, 2]);
    assert.deepEqual(g.get('product').nunique().toArray(), [2, 2]);
  });

  it('agg: per-column, list and named', () => {
    const g = sales().groupby('region');
    const r = g.agg({ units: 'sum', price: ['min', 'max'] });
    assert.deepEqual(r.columnIndex.toArray(), [['units', 'sum'], ['price', 'min'], ['price', 'max']]);
    assert.deepEqual(r.column(['price', 'max']).toArray(), [3, 2]);
    assert.deepEqual((r.get('price') as unknown as DataFrame).columns, ['min', 'max']);
    assert.deepEqual(r.flattenColumns().columns, ['units_sum', 'price_min', 'price_max']);
    const named = g.agg({ total: ['units', 'sum'], avg_price: ['price', 'mean'] });
    assert.deepEqual(named.columns, ['total', 'avg_price']);
    const custom = g.get('units').agg((s) => s.max() as number - (s.min() as number));
    assert.deepEqual((custom as Series).toArray(), [8, 2]);
  });

  it('transform / filter / apply', () => {
    const df = sales().dropna();
    const g = df.groupby('region');
    assert.deepEqual(g.get('units').transform('sum').toArray(), [19, 8, 19, 8, 19]);
    assert.deepEqual(g.filter((d) => d.length > 2).get('region').unique(), ['N']);
    const top = g.apply((d) => d.get('units').max());
    assert.deepEqual((top as Series).toArray(), [10, 5]);
  });

  it('iterates over groups', () => {
    const keys = [...sales().groupby('region')].map(([k, d]) => [k, d.length]);
    assert.deepEqual(keys, [['N', 3], ['S', 2]]);
  });

  it('Series.groupby with another series', () => {
    const df = sales();
    const r = df.get('units').groupby(df.get('product')).sum();
    assert.deepEqual(r.index.toArray(), ['a', 'b']);
    assert.deepEqual(r.toArray(), [117, 10]);
    assert.equal(r.name, 'units');
  });

  it('head / cumcount per group', () => {
    const df = sales();
    assert.deepEqual(df.groupby('region').head(1).index.toArray(), [0, 1]);
    assert.deepEqual(df.groupby('region').get('units').cumcount().toArray(), [0, 0, 1, 1, 2, NaN]);
  });
});

describe('merge', () => {
  const left = new DataFrame({ key: ['a', 'b', 'c'], lv: [1, 2, 3] });
  const right = new DataFrame({ key: ['b', 'c', 'c', 'd'], rv: [20, 30, 31, 40] });

  it('inner (default) with duplicates on the right', () => {
    const r = merge(left, right, { on: 'key' });
    assert.deepEqual(r.get('key').toArray(), ['b', 'c', 'c']);
    assert.deepEqual(r.get('rv').toArray(), [20, 30, 31]);
  });

  it('left / right / outer', () => {
    assert.deepEqual(left.merge(right, { how: 'left' }).get('rv').toArray(), [NaN, 20, 30, 31]);
    assert.deepEqual(left.merge(right, { how: 'right' }).get('key').toArray(), ['b', 'c', 'c', 'd']);
    const outer = left.merge(right, { how: 'outer', indicator: true });
    assert.deepEqual(outer.get('key').toArray(), ['a', 'b', 'c', 'c', 'd']);
    assert.deepEqual(outer.get('_merge').toArray(), ['left_only', 'both', 'both', 'both', 'right_only']);
  });

  it('suffixes overlapping columns and supports leftOn/rightOn', () => {
    const a = new DataFrame({ id: [1, 2], v: [1, 2] });
    const b = new DataFrame({ uid: [2, 1], v: [20, 10] });
    const r = merge(a, b, { leftOn: 'id', rightOn: 'uid' });
    assert.deepEqual(r.columns, ['id', 'v_x', 'uid', 'v_y']);
    assert.deepEqual(r.get('v_y').toArray(), [10, 20]);
  });

  it('cross join and validate', () => {
    assert.equal(merge(left, right, { how: 'cross' }).length, 12);
    assert.throws(() => merge(left, right, { on: 'key', validate: '1:1' }));
  });

  it('join on index', () => {
    const a = new DataFrame({ x: [1, 2] }, { index: ['p', 'q'] });
    const b = new DataFrame({ y: [9] }, { index: ['q'] });
    assert.deepEqual(a.join(b).get('y').toArray(), [NaN, 9]);
    assert.deepEqual(a.join(b, { how: 'inner' }).index.toArray(), ['q']);
  });
});

describe('concat', () => {
  it('stacks frames with column union', () => {
    const r = concat([new DataFrame({ a: [1], b: ['x'] }), new DataFrame({ a: [2], c: [true] })], { ignoreIndex: true });
    assert.deepEqual(r.columns, ['a', 'b', 'c']);
    assert.deepEqual(r.get('a').toArray(), [1, 2]);
    assert.deepEqual(r.get('b').toArray(), ['x', null]);
  });

  it('inner join keeps shared columns', () => {
    const r = concat([new DataFrame({ a: [1], b: [2] }), new DataFrame({ a: [3] })], { join: 'inner' });
    assert.deepEqual(r.columns, ['a']);
  });

  it('series along axis 0 and 1', () => {
    const s = concat([new Series([1, 2]), new Series([3])]);
    assert.deepEqual(s.toArray(), [1, 2, 3]);
    assert.deepEqual(s.index.toArray(), [0, 1, 0]);
    const df = concat([new Series([1, 2], { name: 'a' }), new Series([3, 4], { name: 'b' })], { axis: 1 });
    assert.deepEqual(df.columns, ['a', 'b']);
  });
});

describe('datetime helpers', () => {
  it('toDatetime and dateRange', () => {
    const s = toDatetime(['2024-01-01', null]);
    assert.equal(s.dtype, 'datetime');
    assert.deepEqual(s.isna().toArray(), [false, true]);
    const r = dateRange('2024-01-30', { periods: 3 });
    assert.deepEqual(r.dt.day.toArray(), [30, 31, 1]);
    const m = dateRange('2024-01-15', { end: '2024-04-01', freq: 'MS' });
    assert.deepEqual(m.dt.month.toArray(), [2, 3, 4]);
  });
});
