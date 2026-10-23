import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categorical, DataFrame, parseCsv, Period, Series, slice, Timedelta } from '../src/index.ts';

describe('assignment', () => {
  it('Series.setLoc / setIloc / setAt with upcasting and enlargement', () => {
    const s = new Series([1, 2, 3], { index: ['a', 'b', 'c'] });
    s.setLoc('b', 20);
    assert.equal(s.dtype, 'int64');
    s.setLoc(s.gt(15), 0.5);
    assert.equal(s.dtype, 'float64');
    assert.deepEqual(s.toArray(), [1, 0.5, 3]);
    s.setIloc(slice(0, 2), [7, 8]);
    assert.deepEqual(s.toArray(), [7, 8, 3]);
    s.setAt('z', 9);
    assert.deepEqual(s.index.toArray(), ['a', 'b', 'c', 'z']);
    s.setIat(0, 'x');
    assert.equal(s.dtype, 'object');
  });

  it('Series assignment does not leak into the frame it came from', () => {
    const df = new DataFrame({ a: [1, 2] });
    const s = df.get('a');
    s.setIat(0, 100);
    assert.deepEqual(df.get('a').toArray(), [1, 2]);
  });

  it('DataFrame.setLoc with mask, scalar, arrays, Series and new columns', () => {
    const df = new DataFrame({ a: [1, 2, 3], b: ['x', 'y', 'z'] }, { index: ['r1', 'r2', 'r3'] });
    df.setLoc(df.get('a').gt(1), 'b', 'big');
    assert.deepEqual(df.get('b').toArray(), ['x', 'big', 'big']);
    df.setLoc(null, 'c', [10, 20, 30]);
    assert.deepEqual(df.get('c').toArray(), [10, 20, 30]);
    df.setLoc('r1', ['a', 'c'], [-1, -10]);
    assert.deepEqual(df.loc('r1').toArray(), [-1, 'x', -10]);
    df.setLoc(['r2', 'r3'], 'a', new Series([300, 200], { index: ['r3', 'r2'] }));
    assert.deepEqual(df.get('a').toArray(), [-1, 200, 300]);
    df.setLoc(slice('r2', 'r3'), 'new', 'n');
    assert.deepEqual(df.get('new').toArray(), [null, 'n', 'n']);
  });

  it('DataFrame.setLoc enlarges with a new row label', () => {
    const df = new DataFrame({ a: [1], b: [true] }, { index: ['x'] });
    df.setLoc('y', 'a', 5);
    assert.deepEqual(df.index.toArray(), ['x', 'y']);
    assert.deepEqual(df.get('a').toArray(), [1, 5]);
    assert.deepEqual(df.get('b').toArray(), [true, null]);
  });

  it('keeps int64 / bool when an enlarged row is fully assigned', () => {
    const df = new DataFrame({ n: [1, 2], ok: [true, false] }, { index: ['a', 'b'] });
    df.setLoc('c', ['n', 'ok'], [3, true]);
    assert.deepEqual(df.dtypes.toArray(), ['int64', 'bool']);
    df.setLoc('d', 'n', 4);
    assert.deepEqual(df.dtypes.toArray(), ['int64', 'object']);
  });

  it('setIloc with 2-D values, setAt, setIat, columns setter', () => {
    const df = new DataFrame({ a: [1, 2], b: [3, 4] });
    df.setIloc(null, null, [[9, 8], [7, 6]]);
    assert.deepEqual(df.values, [[9, 8], [7, 6]]);
    df.setAt(0, 'a', 0);
    df.setIat(1, 1, 1);
    assert.deepEqual(df.values, [[0, 8], [7, 1]]);
    df.columns = ['x', 'y'];
    assert.deepEqual(df.columns, ['x', 'y']);
    df.setAxis(['p', 'q']);
    assert.equal(df.at('q', 'x'), 7);
  });
});

describe('nullable dtypes', () => {
  it('Int64 keeps integers with NA', () => {
    const s = new Series([1, null, 3], { dtype: 'Int64' });
    assert.deepEqual(s.toArray(), [1, null, 3]);
    assert.equal(s.sum(), 4);
    assert.equal(s.add(1).dtype, 'Int64');
    assert.deepEqual(s.add(1).toArray(), [2, null, 4]);
    assert.equal(s.div(2).dtype, 'Float64');
    assert.equal(s.fillna(0).dtype, 'Int64');
    assert.throws(() => new Series([1.5], { dtype: 'Int64' }));
    assert.equal(s.toString(), '0     1\n1  <NA>\n2     3\ndtype: Int64');
  });

  it('comparisons on nullable dtypes return boolean with NA', () => {
    const s = new Series([1, null, 3], { dtype: 'Int64' });
    const m = s.gt(1);
    assert.equal(m.dtype, 'boolean');
    assert.deepEqual(m.toArray(), [false, null, true]);
  });

  it('boolean follows Kleene logic', () => {
    const a = new Series([true, false, null, null], { dtype: 'boolean' });
    const b = new Series([null, null, true, false], { dtype: 'boolean' });
    assert.deepEqual(a.and(b).toArray(), [null, false, null, false]);
    assert.deepEqual(a.or(b).toArray(), [true, null, true, null]);
    assert.deepEqual(a.not().toArray(), [false, true, null, null]);
  });

  it('convertDtypes picks nullable types', () => {
    const df = new DataFrame({ i: [1, null], f: [1.5, null], b: [true, null], s: ['x', null] }).convertDtypes();
    assert.deepEqual(df.dtypes.toArray(), ['Int64', 'Float64', 'boolean', 'string']);
  });

  it('groupby keeps nullable dtypes', () => {
    const df = new DataFrame({ k: ['a', 'a', 'b'], v: [1, null, 2] }).astype({ v: 'Int64' });
    const r = df.groupby('k').sum();
    assert.equal(r.get('v').dtype, 'Int64');
    assert.deepEqual(r.get('v').toArray(), [1, 2]);
  });
});

describe('category dtype', () => {
  it('stores codes and categories', () => {
    const s = categorical(['b', 'a', 'b', null]);
    assert.equal(s.dtype, 'category');
    assert.deepEqual(s.cat.categories, ['a', 'b']);
    assert.deepEqual(s.cat.codes.toArray(), [1, 0, 1, -1]);
    assert.deepEqual(s.toArray(), ['b', 'a', 'b', null]);
  });

  it('ordered categories sort and compare by category order', () => {
    const s = categorical(['med', 'low', 'high'], { categories: ['low', 'med', 'high'], ordered: true });
    assert.deepEqual(s.sortValues().toArray(), ['low', 'med', 'high']);
    assert.deepEqual(s.gt('low').toArray(), [true, false, true]);
    assert.equal(s.max(), 'high');
    assert.throws(() => categorical(['a']).gt('a'), TypeError);
  });

  it('valueCounts includes unused categories', () => {
    const s = categorical(['a', 'a'], { categories: ['a', 'b'] });
    assert.deepEqual(s.valueCounts().toDict(), { a: 2, b: 0 });
  });

  it('cat methods', () => {
    const s = categorical(['x', 'y', 'x']);
    assert.deepEqual(s.cat.renameCategories(['X', 'Y']).toArray(), ['X', 'Y', 'X']);
    assert.deepEqual(s.cat.addCategories(['z']).cat.categories, ['x', 'y', 'z']);
    assert.deepEqual(s.cat.removeCategories(['y']).toArray(), ['x', null, 'x']);
    assert.deepEqual(s.cat.setCategories(['y', 'x'], { ordered: true }).sortValues().toArray(), ['y', 'x', 'x']);
    assert.deepEqual(s.cat.addCategories(['z']).cat.removeUnusedCategories().cat.categories, ['x', 'y']);
    assert.ok(s.cat.asOrdered().cat.ordered);
  });

  it('setting a value outside the categories upcasts to object', () => {
    const s = categorical(['a', 'b']);
    s.setIat(0, 'b');
    assert.equal(s.dtype, 'category');
    s.setIat(0, 'zzz');
    assert.equal(s.dtype, 'string');
  });

  it('groupby on a categorical key', () => {
    const df = new DataFrame({ k: ['b', 'a', 'b'], v: [1, 2, 3] }).astype({ k: 'category' });
    assert.deepEqual(df.groupby('k').sum().get('v').toArray(), [2, 4]);
  });
});

describe('bigint dtype', () => {
  it('keeps exact integers beyond 2^53', () => {
    const s = new Series([9007199254740993n, 1n]);
    assert.equal(s.dtype, 'bigint');
    assert.equal(s.sum(), 9007199254740994n);
    assert.deepEqual(s.add(1).toArray(), [9007199254740994n, 2n]);
    assert.deepEqual(s.gt(2).toArray(), [true, false]);
    assert.equal(s.max(), 9007199254740993n);
  });

  it('CSV integers beyond 2^53 become bigint', () => {
    const df = parseCsv('id\n12345678901234567890\n1\n');
    assert.equal(df.get('id').dtype, 'bigint');
    assert.equal(df.get('id').iat(0), 12345678901234567890n);
    assert.equal(df.toJson(undefined, { orient: 'records' }), '[{"id":"12345678901234567890"},{"id":1}]');
  });
});

describe('timedelta and period primitives', () => {
  it('Timedelta parsing and formatting', () => {
    assert.equal(new Timedelta('1 days 02:03:04').ms, 93_784_000);
    assert.equal(new Timedelta('1h30min').ms, 5_400_000);
    assert.equal(new Timedelta({ days: 1, hours: 2 }).toString(), '1 days 02:00:00');
    assert.equal(new Timedelta(-1, 'h').toString(), '-1 days +23:00:00');
    assert.equal(new Timedelta('P1DT2H').ms, 93_600_000);
  });

  it('Period arithmetic and formatting', () => {
    const p = new Period('2024-03-15', 'M');
    assert.equal(p.toString(), '2024-03');
    assert.equal(p.add(10).toString(), '2025-01');
    assert.equal(new Period('2024Q2', 'Q').startTime.toISOString(), '2024-04-01T00:00:00.000Z');
    assert.equal(new Period(new Date('2024-03-13'), 'W').toString(), '2024-03-11/2024-03-17');
  });

  it('datetime minus datetime gives timedelta', () => {
    const a = new Series([new Date('2024-01-02')]);
    const b = new Series([new Date('2024-01-01')]);
    const d = a.sub(b);
    assert.equal(d.dtype, 'timedelta');
    assert.equal((d.iat(0) as Timedelta).days, 1);
    assert.equal(a.add(new Timedelta('12h')).iat(0)!.toString(), new Date('2024-01-02T12:00:00Z').toString());
  });
});
