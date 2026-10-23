import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataFrame, Series, slice, KeyError } from '../src/index.ts';

const people = () =>
  new DataFrame({
    name: ['Ana', 'Bruno', 'Carla', 'Diego'],
    age: [28, 35, 42, null],
    city: ['SP', 'RJ', 'SP', 'BH'],
    score: [8.5, 7.25, 9, 6],
  });

describe('DataFrame construction', () => {
  it('from columns', () => {
    const df = people();
    assert.deepEqual(df.shape, [4, 4]);
    assert.deepEqual(df.columns, ['name', 'age', 'city', 'score']);
    assert.deepEqual(df.dtypes.toArray(), ['string', 'float64', 'string', 'float64']);
  });

  it('from records (missing keys become NA)', () => {
    const df = new DataFrame([{ a: 1, b: 'x' }, { a: 2 }, { b: 'z', c: true }]);
    assert.deepEqual(df.columns, ['a', 'b', 'c']);
    assert.deepEqual(df.get('a').toArray(), [1, 2, NaN]);
    assert.deepEqual(df.get('c').toArray(), [null, null, true]);
  });

  it('from rows with column names', () => {
    const df = new DataFrame([[1, 'a'], [2, 'b']], { columns: ['n', 's'] });
    assert.deepEqual(df.toRecords(), [{ n: 1, s: 'a' }, { n: 2, s: 'b' }]);
  });

  it('aligns Series by index and broadcasts scalars', () => {
    const df = new DataFrame({
      a: new Series([1, 2], { index: ['x', 'y'] }),
      b: new Series([3], { index: ['y'] }),
      c: 'k',
    });
    assert.deepEqual(df.index.toArray(), ['x', 'y']);
    assert.deepEqual(df.get('b').toArray(), [NaN, 3]);
    assert.deepEqual(df.get('c').toArray(), ['k', 'k']);
  });

  it('validates lengths', () => {
    assert.throws(() => new DataFrame({ a: [1, 2], b: [1] }), RangeError);
  });
});

describe('DataFrame selection', () => {
  const df = people().setIndex('name');

  it('get column / columns / mask', () => {
    assert.equal(df.get('age').name, 'age');
    assert.deepEqual(df.get(['city', 'age']).columns, ['city', 'age']);
    assert.deepEqual(df.get(df.get('city').eq('SP')).index.toArray(), ['Ana', 'Carla']);
    assert.throws(() => df.get('nope'), KeyError);
  });

  it('loc combinations', () => {
    assert.equal(df.loc('Bruno', 'city'), 'RJ');
    const row = df.loc('Carla');
    assert.equal(row.get('age'), 42);
    assert.equal(row.name, 'Carla');
    assert.deepEqual(df.loc(['Ana', 'Diego'], 'score').toArray(), [8.5, 6]);
    assert.deepEqual(df.loc(slice('Bruno', 'Carla'), ['age']).shape, [2, 1]);
    assert.deepEqual(df.loc(null, slice('age', 'city')).columns, ['age', 'city']);
    assert.deepEqual(df.loc((d) => d.get('score').gt(8)).index.toArray(), ['Ana', 'Carla']);
  });

  it('iloc combinations', () => {
    assert.equal(df.iloc(0, 0), 28);
    assert.deepEqual(df.iloc(slice(1, 3)).index.toArray(), ['Bruno', 'Carla']);
    assert.deepEqual(df.iloc([0, -1], [2]).get('score').toArray(), [8.5, 6]);
    assert.equal(df.at('Diego', 'city'), 'BH');
    assert.equal(df.iat(1, 2), 7.25);
  });

  it('query / filter / selectDtypes', () => {
    assert.deepEqual(df.query((r) => (r.age as number) > 30).index.toArray(), ['Bruno', 'Carla']);
    assert.deepEqual(df.filter({ like: 'c' }).columns, ['city', 'score']);
    assert.deepEqual(df.selectDtypes({ include: ['number'] }).columns, ['age', 'score']);
  });
});

describe('DataFrame mutation & reshaping', () => {
  it('set mutates, assign does not', () => {
    const df = people();
    const df2 = df.assign({ double: (d) => d.get('score').mul(2) });
    assert.ok(!df.has('double'));
    assert.deepEqual(df2.get('double').toArray(), [17, 14.5, 18, 12]);
    df.set('flag', true);
    assert.deepEqual(df.get('flag').toArray(), [true, true, true, true]);
  });

  it('insert / pop / drop / rename', () => {
    const df = people();
    df.insert(0, 'id', [1, 2, 3, 4]);
    assert.equal(df.columns[0], 'id');
    assert.deepEqual(df.pop('id').toArray(), [1, 2, 3, 4]);
    assert.deepEqual(df.drop(['age', 'city']).columns, ['name', 'score']);
    assert.deepEqual(df.drop({ index: [0, 2] }).index.toArray(), [1, 3]);
    assert.deepEqual(df.rename({ columns: { name: 'nome' } }).columns[0], 'nome');
  });

  it('setIndex / resetIndex round trip', () => {
    const df = people().setIndex('name');
    assert.equal(df.index.name, 'name');
    const back = df.resetIndex();
    assert.deepEqual(back.columns, ['name', 'age', 'city', 'score']);
    assert.ok(back.index.isDefault);
  });

  it('sortValues by multiple keys with mixed directions', () => {
    const df = people().sortValues(['city', 'score'], { ascending: [true, false] });
    assert.deepEqual(df.get('name').toArray(), ['Diego', 'Bruno', 'Carla', 'Ana']);
  });

  it('dropna / fillna', () => {
    const df = people();
    assert.equal(df.dropna().length, 3);
    assert.equal(df.dropna({ subset: ['city'] }).length, 4);
    assert.deepEqual(df.fillna({ age: 0 }).get('age').toArray(), [28, 35, 42, 0]);
    assert.deepEqual(df.dropna({ axis: 1 }).columns, ['name', 'city', 'score']);
  });

  it('dropDuplicates', () => {
    const df = new DataFrame({ a: [1, 1, 2], b: ['x', 'x', 'y'] });
    assert.equal(df.dropDuplicates().length, 2);
    assert.deepEqual(df.dropDuplicates({ subset: 'a', keep: 'last' }).index.toArray(), [1, 2]);
  });

  it('melt and pivotTable', () => {
    const wide = new DataFrame({ id: [1, 2], x: [10, 20], y: [30, 40] });
    const long = wide.melt({ idVars: ['id'] });
    assert.deepEqual(long.columns, ['id', 'variable', 'value']);
    assert.deepEqual(long.get('value').toArray(), [10, 20, 30, 40]);
    const pt = long.pivotTable({ index: 'id', columns: 'variable', values: 'value', aggfunc: 'sum' });
    assert.deepEqual(pt.columns, ['x', 'y']);
    assert.deepEqual(pt.get('y').toArray(), [30, 40]);
  });

  it('transpose', () => {
    const t = new DataFrame({ a: [1, 2], b: [3, 4] }).T;
    assert.deepEqual(t.columns, ['0', '1']);
    assert.deepEqual(t.index.toArray(), ['a', 'b']);
    assert.deepEqual(t.get('1').toArray(), [2, 4]);
  });
});

describe('DataFrame computation', () => {
  it('column aggregations skip non-numeric columns', () => {
    const df = people();
    assert.deepEqual(df.sum().index.toArray(), ['age', 'score']);
    assert.deepEqual(df.mean().toArray(), [35, 7.6875]);
    assert.deepEqual(df.count().toArray(), [4, 3, 4, 4]);
    assert.deepEqual(df.max().toArray(), ['Diego', 42, 'SP', 9]);
  });

  it('row-wise aggregations', () => {
    const df = new DataFrame({ a: [1, 2], b: [3, 4] });
    assert.deepEqual(df.sum({ axis: 1 }).toArray(), [4, 6]);
  });

  it('agg with list and mapping', () => {
    const df = new DataFrame({ a: [1, 2, 3], b: [4, 5, 6] });
    const r = df.agg(['min', 'max']);
    assert.deepEqual(r.index.toArray(), ['min', 'max']);
    assert.deepEqual(r.get('b').toArray(), [4, 6]);
    const m = df.agg({ a: 'sum', b: ['mean'] });
    assert.deepEqual(m.get('a').toArray(), [6, NaN]);
    assert.deepEqual(m.get('b').toArray(), [NaN, 5]);
  });

  it('apply along both axes', () => {
    const df = new DataFrame({ a: [1, 2], b: [3, 4] });
    assert.deepEqual((df.apply((s) => s.sum()) as Series).toArray(), [3, 7]);
    assert.deepEqual((df.apply((r) => (r.a as number) * (r.b as number), { axis: 1 }) as Series).toArray(), [3, 8]);
    const expanded = df.apply((r) => ({ s: (r.a as number) + (r.b as number) }), { axis: 1 }) as DataFrame;
    assert.deepEqual(expanded.get('s').toArray(), [4, 6]);
  });

  it('element-wise arithmetic aligns frames', () => {
    const a = new DataFrame({ x: [1, 2], y: [3, 4] });
    const b = new DataFrame({ x: [10, 20] });
    const r = a.add(b);
    assert.deepEqual(r.get('x').toArray(), [11, 22]);
    assert.deepEqual(r.get('y').toArray(), [NaN, NaN]);
    assert.deepEqual(a.mul(2).get('y').toArray(), [6, 8]);
    assert.deepEqual(a.gt(1).get('x').toArray(), [false, true]);
  });

  it('corr / cov', () => {
    const df = new DataFrame({ a: [1, 2, 3], b: [2, 4, 6], c: [3, 2, 1] });
    const c = df.corr();
    assert.ok(Math.abs((c.loc('a', 'b') as number) - 1) < 1e-12);
    assert.ok(Math.abs((c.loc('a', 'c') as number) + 1) < 1e-12);
    assert.equal(df.cov().loc('a', 'a'), 1);
  });

  it('describe', () => {
    const d = people().describe();
    assert.deepEqual(d.columns, ['age', 'score']);
    assert.equal(d.loc('count', 'age'), 3);
  });

  it('valueCounts over rows', () => {
    const vc = people().valueCounts({ subset: ['city'] });
    assert.equal(vc.iat(0), 2);
    assert.equal(vc.index.labels[0], 'SP');
  });
});

describe('DataFrame display', () => {
  it('renders an aligned table', () => {
    const df = new DataFrame({ a: [1, 22], b: ['x', null] });
    assert.equal(df.toString(), '    a     b\n0   1     x\n1  22  null');
  });

  it('truncates long frames', () => {
    const df = new DataFrame({ a: Array.from({ length: 100 }, (_, i) => i) });
    const text = df.toString();
    assert.ok(text.includes('...'));
    assert.ok(text.endsWith('[100 rows x 1 columns]'));
  });
});
