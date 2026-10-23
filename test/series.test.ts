import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Series, slice, KeyError } from '../src/index.ts';

describe('Series construction & dtypes', () => {
  it('infers dtypes', () => {
    assert.equal(new Series([1, 2, 3]).dtype, 'int64');
    assert.equal(new Series([1, 2.5]).dtype, 'float64');
    assert.equal(new Series([1, null]).dtype, 'float64');
    assert.equal(new Series([true, false]).dtype, 'bool');
    assert.equal(new Series([true, null]).dtype, 'object');
    assert.equal(new Series(['a', null]).dtype, 'string');
    assert.equal(new Series([new Date(0)]).dtype, 'datetime');
    assert.equal(new Series([1, 'a']).dtype, 'object');
  });

  it('builds from an object with keys as index', () => {
    const s = new Series({ a: 1, b: 2 });
    assert.deepEqual(s.index.toArray(), ['a', 'b']);
    assert.equal(s.get('b'), 2);
  });

  it('reorders an object by an explicit index', () => {
    const s = new Series({ a: 1, b: 2 }, { index: ['b', 'c', 'a'] });
    assert.deepEqual(s.toArray(), [2, NaN, 1]);
  });

  it('rejects mismatched index length', () => {
    assert.throws(() => new Series([1, 2], { index: ['a'] }), RangeError);
  });

  it('astype converts', () => {
    assert.deepEqual(new Series(['1', '2.5']).astype('float64').toArray(), [1, 2.5]);
    assert.deepEqual(new Series([1.9, -1.9]).astype('int64').toArray(), [1, -1]);
    assert.deepEqual(new Series([1, 0]).astype('bool').toArray(), [true, false]);
  });
});

describe('Series selection', () => {
  const s = new Series([10, 20, 30, 40], { index: ['a', 'b', 'c', 'd'], name: 'x' });

  it('loc by label, labels, slice (inclusive) and mask', () => {
    assert.equal(s.loc('b'), 20);
    assert.deepEqual(s.loc(['d', 'a']).toArray(), [40, 10]);
    assert.deepEqual(s.loc(slice('b', 'c')).toArray(), [20, 30]);
    assert.deepEqual(s.loc(s.gt(15)).toArray(), [20, 30, 40]);
    assert.deepEqual(s.loc((x) => x.lt(25)).toArray(), [10, 20]);
    assert.throws(() => s.loc('z'), KeyError);
  });

  it('iloc by position, negative position and slice (exclusive)', () => {
    assert.equal(s.iloc(0), 10);
    assert.equal(s.iloc(-1), 40);
    assert.deepEqual(s.iloc(slice(1, 3)).toArray(), [20, 30]);
    assert.deepEqual(s.iloc(slice(undefined, undefined, -1)).toArray(), [40, 30, 20, 10]);
    assert.deepEqual(s.iloc([0, 2]).index.toArray(), ['a', 'c']);
  });

  it('head / tail', () => {
    assert.deepEqual(s.head(2).toArray(), [10, 20]);
    assert.deepEqual(s.tail(2).toArray(), [30, 40]);
  });
});

describe('Series arithmetic & alignment', () => {
  it('broadcasts scalars and keeps int64', () => {
    const r = new Series([1, 2, 3]).add(1);
    assert.equal(r.dtype, 'int64');
    assert.deepEqual(r.toArray(), [2, 3, 4]);
    assert.equal(new Series([1, 2]).div(2).dtype, 'float64');
  });

  it('aligns on index labels (union, NaN where missing)', () => {
    const a = new Series([1, 2], { index: ['x', 'y'] });
    const b = new Series([10, 20], { index: ['y', 'z'] });
    const r = a.add(b);
    assert.deepEqual(r.index.toArray(), ['x', 'y', 'z']);
    assert.deepEqual(r.toArray(), [NaN, 12, NaN]);
  });

  it('concatenates strings with add', () => {
    assert.deepEqual(new Series(['a', 'b']).add('!').toArray(), ['a!', 'b!']);
  });

  it('comparisons treat NA as false (ne as true)', () => {
    const s = new Series([1, null, 3]);
    assert.deepEqual(s.gt(1).toArray(), [false, false, true]);
    assert.deepEqual(s.ne(1).toArray(), [false, true, true]);
  });

  it('boolean logic', () => {
    const s = new Series([1, 2, 3, 4]);
    assert.deepEqual(s.gt(1).and(s.lt(4)).toArray(), [false, true, true, false]);
    assert.deepEqual(s.eq(1).or(s.eq(4)).toArray(), [true, false, false, true]);
    assert.deepEqual(s.gt(2).not().toArray(), [true, true, false, false]);
  });

  it('datetime comparison against strings and Dates', () => {
    const s = new Series([new Date('2024-01-01'), new Date('2024-06-01')]);
    assert.deepEqual(s.gt('2024-03-01').toArray(), [false, true]);
    assert.deepEqual(s.eq(new Date('2024-01-01')).toArray(), [true, false]);
  });
});

describe('Series statistics', () => {
  const s = new Series([1, 2, 3, 4, null]);

  it('skips NA by default', () => {
    assert.equal(s.sum(), 10);
    assert.equal(s.mean(), 2.5);
    assert.equal(s.count(), 4);
    assert.equal(s.min(), 1);
    assert.equal(s.max(), 4);
    assert.equal(s.median(), 2.5);
    assert.ok(Math.abs(s.std() - 1.2909944) < 1e-6);
    assert.ok(Number.isNaN(s.sum({ skipna: false })));
  });

  it('quantile with linear interpolation', () => {
    assert.equal(s.quantile(0.25), 1.75);
    assert.deepEqual(s.quantile([0, 1]).toArray(), [1, 4]);
  });

  it('describe', () => {
    const d = s.describe();
    assert.deepEqual(d.index.toArray(), ['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max']);
    assert.equal(d.get('count'), 4);
    const ds = new Series(['a', 'b', 'a']).describe();
    assert.equal(ds.get('top'), 'a');
    assert.equal(ds.get('freq'), 2);
  });

  it('valueCounts, unique, nunique, mode', () => {
    const t = new Series(['a', 'b', 'a', 'c', 'a', 'b']);
    const vc = t.valueCounts();
    assert.deepEqual(vc.index.toArray(), ['a', 'b', 'c']);
    assert.deepEqual(vc.toArray(), [3, 2, 1]);
    assert.equal(vc.name, 'count');
    assert.deepEqual(t.valueCounts({ normalize: true }).toArray(), [0.5, 1 / 3, 1 / 6]);
    assert.deepEqual(t.unique(), ['a', 'b', 'c']);
    assert.equal(t.nunique(), 3);
    assert.deepEqual(t.mode().toArray(), ['a']);
  });

  it('idxmax / idxmin', () => {
    const t = new Series([3, 9, 1], { index: ['a', 'b', 'c'] });
    assert.equal(t.idxmax(), 'b');
    assert.equal(t.idxmin(), 'c');
  });

  it('cumulative ops, shift, diff, pctChange', () => {
    const t = new Series([1, 2, 4]);
    assert.deepEqual(t.cumsum().toArray(), [1, 3, 7]);
    assert.deepEqual(t.cumprod().toArray(), [1, 2, 8]);
    assert.deepEqual(t.shift(1).toArray(), [NaN, 1, 2]);
    assert.deepEqual(t.diff().toArray(), [NaN, 1, 2]);
    assert.deepEqual(t.pctChange().toArray(), [NaN, 1, 1]);
  });

  it('rank averages ties', () => {
    assert.deepEqual(new Series([10, 20, 10, 30]).rank().toArray(), [1.5, 3, 1.5, 4]);
  });
});

describe('Series missing data', () => {
  const s = new Series([1, null, null, 4]);

  it('isna / fillna / dropna', () => {
    assert.deepEqual(s.isna().toArray(), [false, true, true, false]);
    assert.deepEqual(s.fillna(0).toArray(), [1, 0, 0, 4]);
    assert.deepEqual(s.dropna().index.toArray(), [0, 3]);
  });

  it('ffill / bfill / interpolate', () => {
    assert.deepEqual(s.ffill().toArray(), [1, 1, 1, 4]);
    assert.deepEqual(s.bfill().toArray(), [1, 4, 4, 4]);
    assert.deepEqual(s.ffill(1).toArray(), [1, 1, NaN, 4]);
    assert.deepEqual(s.interpolate().toArray(), [1, 2, 3, 4]);
  });
});

describe('Series transforms', () => {
  it('map with function, object and Map', () => {
    const s = new Series(['a', 'b', 'c']);
    assert.deepEqual(s.map((v) => (v as string).toUpperCase()).toArray(), ['A', 'B', 'C']);
    assert.deepEqual(s.map({ a: 1, b: 2 }).toArray(), [1, 2, NaN]);
    assert.deepEqual(s.map(new Map([['c', 'z']])).toArray(), [null, null, 'z']);
  });

  it('where / mask / replace / isin / between / clip / round', () => {
    const s = new Series([1, 5, 10]);
    assert.deepEqual(s.where(s.gt(2), 0).toArray(), [0, 5, 10]);
    assert.deepEqual(s.mask(s.gt(2), 0).toArray(), [1, 0, 0]);
    assert.deepEqual(s.replace(5, 50).toArray(), [1, 50, 10]);
    assert.deepEqual(s.isin([1, 10]).toArray(), [true, false, true]);
    assert.deepEqual(s.between(2, 10).toArray(), [false, true, true]);
    assert.deepEqual(s.clip(2, 8).toArray(), [2, 5, 8]);
    assert.deepEqual(new Series([1.234, 5.678]).round(1).toArray(), [1.2, 5.7]);
  });

  it('sortValues keeps NA last and is stable', () => {
    const s = new Series([3, null, 1, 2], { index: ['a', 'b', 'c', 'd'] });
    assert.deepEqual(s.sortValues().index.toArray(), ['c', 'd', 'a', 'b']);
    assert.deepEqual(s.sortValues({ ascending: false }).index.toArray(), ['a', 'd', 'c', 'b']);
    assert.deepEqual(s.sortValues({ naPosition: 'first' }).index.toArray(), ['b', 'c', 'd', 'a']);
    assert.deepEqual(s.sortIndex({ ascending: false }).index.toArray(), ['d', 'c', 'b', 'a']);
  });

  it('nlargest / duplicated / dropDuplicates', () => {
    const s = new Series([5, 1, 5, 3]);
    assert.deepEqual(s.nlargest(2).toArray(), [5, 5]);
    assert.deepEqual(s.duplicated().toArray(), [false, false, true, false]);
    assert.deepEqual(s.duplicated(false).toArray(), [true, false, true, false]);
    assert.deepEqual(s.dropDuplicates().toArray(), [5, 1, 3]);
  });
});

describe('accessors', () => {
  it('str methods keep NA', () => {
    const s = new Series([' Foo ', 'bar', null]);
    assert.deepEqual(s.str.strip().str.lower().toArray(), ['foo', 'bar', null]);
    assert.deepEqual(s.str.contains('a').toArray(), [false, true, false]);
    assert.deepEqual(s.str.len().toArray(), [5, 3, NaN]);
    assert.deepEqual(new Series(['a-b', 'c-d']).str.split('-').str.get(1).toArray(), ['b', 'd']);
    assert.deepEqual(new Series(['ab12', 'x9']).str.extract(/(\d+)/, { expand: false }).toArray(), ['12', '9']);
  });

  it('dt fields', () => {
    const s = new Series([new Date('2024-03-15T10:30:00Z'), null]);
    assert.deepEqual(s.dt.year.toArray(), [2024, NaN]);
    assert.deepEqual(s.dt.month.toArray(), [3, NaN]);
    assert.equal(s.dt.dayofweek.iat(0), 4); // Friday
    assert.deepEqual(s.dt.strftime('%Y/%m/%d %H:%M').toArray(), ['2024/03/15 10:30', null]);
  });
});

describe('display', () => {
  it('formats like pandas', () => {
    const s = new Series([1.5, 2, null], { name: 'v' });
    assert.equal(s.toString(), '0  1.5\n1  2.0\n2  NaN\nName: v, dtype: float64');
  });
});
