import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pd from '../src/index.ts';
import { DataFrame, Series } from '../src/index.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe('rank methods', () => {
  const s = new Series([10, 20, 10, null, 30]);
  it('average / min / max / first / dense', () => {
    assert.deepEqual(s.rank().toArray(), [1.5, 3, 1.5, NaN, 4]);
    assert.deepEqual(s.rank({ method: 'min' }).toArray(), [1, 3, 1, NaN, 4]);
    assert.deepEqual(s.rank({ method: 'max' }).toArray(), [2, 3, 2, NaN, 4]);
    assert.deepEqual(s.rank({ method: 'first' }).toArray(), [1, 3, 2, NaN, 4]);
    assert.deepEqual(s.rank({ method: 'dense' }).toArray(), [1, 2, 1, NaN, 3]);
  });
  it('descending, naOption and pct', () => {
    assert.deepEqual(s.rank({ ascending: false, method: 'min' }).toArray(), [3, 2, 3, NaN, 1]);
    assert.deepEqual(s.rank({ naOption: 'top', method: 'min' }).toArray(), [2, 4, 2, 1, 5]);
    assert.deepEqual(s.rank({ naOption: 'bottom', method: 'min' }).toArray(), [1, 3, 1, 5, 4]);
    assert.deepEqual(s.rank({ pct: true }).toArray(), [0.375, 0.75, 0.375, NaN, 1]);
  });
});

describe('correlation methods', () => {
  const df = new DataFrame({ a: [1, 2, 3, 4, 5], b: [2, 4, 5, 4, 5], c: [5, 6, 7, 8, 100] });
  it('pearson / spearman / kendall', () => {
    close(df.get('a').corr(df.get('b')), 0.7745966692414834);
    close(df.get('a').corr(df.get('c'), { method: 'spearman' }), 1);
    close(df.get('a').corr(df.get('b'), { method: 'kendall' }), 0.6708203932499369);
    close(df.corr({ method: 'spearman' }).loc('a', 'b') as number, 0.7378647873726218);
  });
  it('cov / autocorr / corrwith', () => {
    close(df.get('a').cov(df.get('b')), 1.5);
    close(new Series([1, 2, 3, 4]).autocorr(), 1);
    const other = new DataFrame({ a: [5, 4, 3, 2, 1], b: [2, 4, 5, 4, 5] });
    assert.deepEqual(df.corrwith(other).toArray().map((v) => Math.round((v as number) * 1e9) / 1e9), [-1, 1]);
  });
});

describe('interpolate methods', () => {
  it('linear honours limit, direction and area', () => {
    const s = new Series([null, 1, null, null, 4, null]);
    assert.deepEqual(s.interpolate().toArray(), [NaN, 1, 2, 3, 4, 4]);
    assert.deepEqual(s.interpolate({ limit: 1 }).toArray(), [NaN, 1, 2, NaN, 4, 4]);
    assert.deepEqual(s.interpolate({ limitDirection: 'both' }).toArray(), [1, 1, 2, 3, 4, 4]);
    assert.deepEqual(s.interpolate({ limitArea: 'inside' }).toArray(), [NaN, 1, 2, 3, 4, NaN]);
  });
  it('index / time / nearest / pad / bfill', () => {
    const s = new Series([0, null, 10], { index: [0, 1, 10] });
    assert.deepEqual(s.interpolate({ method: 'index' }).toArray(), [0, 1, 10]);
    const t = new Series([0, null, 30], { index: [new Date('2024-01-01'), new Date('2024-01-02'), new Date('2024-01-04')] });
    assert.deepEqual(t.interpolate({ method: 'time' }).toArray(), [0, 10, 30]);
    const u = new Series([1, null, null, 9]);
    assert.deepEqual(u.interpolate({ method: 'nearest' }).toArray(), [1, 1, 9, 9]);
    assert.deepEqual(u.interpolate({ method: 'pad' }).toArray(), [1, 1, 1, 9]);
    assert.deepEqual(u.interpolate({ method: 'bfill' }).toArray(), [1, 9, 9, 9]);
  });
  it('polynomial / spline / pchip reproduce smooth curves', () => {
    const x = [0, 1, 2, 3, 4, 5, 6];
    const y = x.map((v) => v * v);
    const s = new Series(y.map((v, i) => (i === 3 ? null : v)));
    close(s.interpolate({ method: 'quadratic' }).iat(3) as number, 9);
    close(s.interpolate({ method: 'polynomial', order: 2 }).iat(3) as number, 9);
    const cubic = s.interpolate({ method: 'cubic' }).iat(3) as number;
    assert.ok(Math.abs(cubic - 9) < 0.2);
    const mono = new Series([0, 1, null, 1, 2]).interpolate({ method: 'pchip' }).iat(2) as number;
    assert.ok(mono >= 1 && mono <= 1.0001);
  });
});

describe('string methods', () => {
  const s = new Series(['Ana Maria', 'bruno', null, 'CARLA-souza']);
  it('expand split / rsplit / partition', () => {
    const parts = s.str.split(' ', { expand: true });
    assert.deepEqual(parts.columns, ['0', '1']);
    assert.deepEqual(parts.get('1').toArray(), ['Maria', null, null, null]);
    assert.deepEqual(new Series(['a-b-c']).str.split('-', { n: 1 }).iat(0), ['a', 'b-c']);
    assert.deepEqual(new Series(['a-b-c']).str.rsplit('-', { n: 1 }).iat(0), ['a-b', 'c']);
    const p = new Series(['k=v']).str.partition('=') as DataFrame;
    assert.deepEqual(p.values, [['k', '=', 'v']]);
  });
  it('extract with named groups and extractall', () => {
    const df = new Series(['a1', 'b22', 'c']).str.extract(/(?<letter>[a-z])(?<digits>\d+)/);
    assert.deepEqual(df.columns, ['letter', 'digits']);
    assert.deepEqual(df.get('digits').toArray(), ['1', '22', null]);
    const all = new Series(['a1b2', 'c3']).str.extractall(/(\d)/);
    assert.deepEqual(all.index.toArray(), [[0, 0], [0, 1], [1, 0]]);
    assert.deepEqual(all.get('0').toArray(), ['1', '2', '3']);
  });
  it('predicates and transforms', () => {
    assert.deepEqual(s.str.match(/[A-Z]/).toArray(), [true, false, false, true]);
    assert.deepEqual(s.str.fullmatch('[a-z]+').toArray(), [false, true, false, false]);
    assert.deepEqual(s.str.contains('a', { case: false, na: false }).toArray(), [true, false, false, true]);
    // A string pattern is a regex by default, like pandas (regex=True).
    const cities = new Series(['Porto Alegre', 'Rio', 'a.b', 'ab']);
    assert.deepEqual(cities.str.contains('Porto|Rio').toArray(), [true, true, false, false]);
    assert.deepEqual(cities.str.contains('a.b').toArray(), [false, false, true, false]);
    assert.deepEqual(cities.str.contains('a.b', { regex: false }).toArray(), [false, false, true, false]);
    assert.deepEqual(cities.str.contains('PORTO', { case: false }).toArray(), [true, false, false, false]);
    assert.deepEqual(s.str.title().toArray(), ['Ana Maria', 'Bruno', null, 'Carla-Souza']);
    assert.deepEqual(s.str.swapcase().iat(1), 'BRUNO');
    assert.deepEqual(s.str.findall(/a/i).iat(0), ['A', 'a', 'a', 'a']);
    assert.deepEqual(s.str.find('a').toArray(), [2, -1, NaN, 10]);
    assert.deepEqual(new Series(['  x ']).str.center(7, '*').iat(0), '**  x *');
    assert.deepEqual(new Series(['a1b22']).str.title().iat(0), 'A1B22');
    assert.deepEqual(new Series(['x', null], { dtype: 'object' }).str.contains('x').toArray(), [true, null]);
    assert.deepEqual(new Series(['-5']).str.zfill(4).iat(0), '-005');
    assert.deepEqual(new Series(['prefix_x']).str.removeprefix('prefix_').iat(0), 'x');
    assert.deepEqual(new Series(['aaa']).str.replace('a', 'b', { n: 2 }).iat(0), 'bba');
    assert.deepEqual(new Series(['a1b2']).str.replace(/(\d)/, '<$1>').iat(0), 'a<1>b<2>');
    assert.deepEqual(new Series(['abcdef']).str.slice(0, undefined, 2).iat(0), 'ace');
    assert.deepEqual(new Series(['abc']).str.translate({ a: 'x', b: null }).iat(0), 'xc');
    assert.deepEqual(new Series(['the quick brown fox']).str.wrap(10).iat(0), 'the quick\nbrown fox');
    assert.deepEqual(new Series([['a', 'b']]).str.join('-').iat(0), 'a-b');
    assert.deepEqual(new Series(['a', 'b']).str.cat(['x', 'y'], { sep: ':' }).toArray(), ['a:x', 'b:y']);
    assert.deepEqual(new Series(['a|b', 'b']).str.getDummies().values, [[1, 1], [0, 1]]);
    assert.equal(new Series(['ç']).str.encode().str.decode().iat(0), 'ç');
  });
});

describe('groupby extras', () => {
  const df = new DataFrame({ k: ['a', 'b', 'a', 'b', 'a'], v: [1, 10, 2, 20, 3] });
  it('shift / diff / rank / cumulative per group', () => {
    const g = df.groupby('k').get('v');
    assert.deepEqual(g.shift().toArray(), [NaN, NaN, 1, 10, 2]);
    assert.deepEqual(g.diff().toArray(), [NaN, NaN, 1, 10, 1]);
    assert.deepEqual(g.rank({ ascending: false }).toArray(), [3, 2, 2, 1, 1]);
    assert.deepEqual(g.cummax().toArray(), [1, 10, 2, 20, 3]);
    assert.deepEqual(df.groupby('k').cumsum().get('v').toArray(), [1, 10, 3, 30, 6]);
    assert.deepEqual(df.groupby('k').ngroup().toArray(), [0, 1, 0, 1, 0]);
  });
  it('nth / quantile / idxmax / describe / ohlc', () => {
    assert.deepEqual(df.groupby('k').nth(-1).index.toArray(), [3, 4]);
    assert.deepEqual(df.groupby('k').get('v').quantile(0.5).toArray(), [2, 15]);
    assert.deepEqual(df.groupby('k').idxmax().get('v').toArray(), [4, 3]);
    const d = df.groupby('k').get('v').describe();
    assert.deepEqual(d.columns, ['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max']);
    assert.deepEqual(df.groupby('k').get('v').ohlc().loc('a').toArray(), [1, 3, 1, 3]);
  });
  it('group by function, Series, array and index level', () => {
    const byFn = df.groupby((label) => (label as number) % 2).get('v').sum();
    assert.deepEqual(byFn.toDict(), { 0: 6, 1: 30 });
    const bySeries = df.get('v').groupby(df.get('k')).sum();
    assert.deepEqual(bySeries.toArray(), [6, 30]);
    const byArray = df.groupby([['x', 'x', 'y', 'y', 'y']]).get('v').sum();
    assert.deepEqual(byArray.toArray(), [11, 25]);
    const indexed = df.setIndex('k');
    assert.deepEqual(indexed.groupby(null, { level: 'k' }).sum().get('v').toArray(), [6, 30]);
    assert.deepEqual([...df.groupby((l) => (l as number) < 2)].map(([, g]) => g.columns), [['k', 'v'], ['k', 'v']]);
  });
});

describe('query / eval expressions', () => {
  const df = new DataFrame({ name: ['Ana', 'Bruno', 'Carla'], age: [28, 35, 42], 'first name': ['a', 'b', 'c'] });
  it('query', () => {
    assert.deepEqual(df.query('age > 30 and name != "Carla"').get('name').toArray(), ['Bruno']);
    assert.deepEqual(df.query('age > 30 & ~(name == "Carla")').get('name').toArray(), ['Bruno']);
    assert.deepEqual(df.query('name in ["Ana", "Carla"]').length, 2);
    assert.deepEqual(df.query('name not in ("Ana",)').length, 2);
    assert.deepEqual(df.query('30 < age <= 42').length, 2);
    assert.deepEqual(df.query('age >= @min', { locals: { min: 40 } }).length, 1);
    assert.deepEqual(df.query('`first name` == "b"').get('name').toArray(), ['Bruno']);
    assert.deepEqual(df.query('name.str.startswith("C")').get('age').toArray(), [42]);
    assert.deepEqual(df.query('index > 0').length, 2);
    assert.deepEqual(df.query('age % 2 == 0 or age ** 2 > 1500').length, 2);
    assert.throws(() => df.query('missing > 1'), ReferenceError);
  });
  it('eval with assignments, functions and methods', () => {
    const out = df.eval('older = age + 10\nratio = age / age.max()') as DataFrame;
    assert.deepEqual(out.get('older').toArray(), [38, 45, 52]);
    assert.ok(!df.has('older'));
    assert.equal(df.eval('age.mean()'), 35);
    assert.deepEqual((df.eval('sqrt(age * 0 + 4)') as Series).toArray(), [2, 2, 2]);
    assert.equal(pd.eval('-2 ** 2 + 10 // 3'), -1);
    assert.equal(pd.eval('a + b', { locals: { a: 1, b: 2 } }), 3);
    df.copy().eval('x = 1', { inplace: true });
  });
});
