// Edge cases of the typed fast paths (comparisons, logic, arithmetic, radix sort,
// CSV parsing), which must give the same answers as the generic code they bypass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pd from '../src/index.ts';
import { DataFrame, Series } from '../src/index.ts';

describe('numeric comparison fast path', () => {
  const x = new Series([1, NaN, 3, 2]);
  it('NaN compares false, and true for ne', () => {
    assert.deepEqual(x.gt(1).toArray(), [false, false, true, true]);
    assert.deepEqual(x.ge(2).toArray(), [false, false, true, true]);
    assert.deepEqual(x.lt(3).toArray(), [true, false, false, true]);
    assert.deepEqual(x.le(1).toArray(), [true, false, false, false]);
    assert.deepEqual(x.eq(3).toArray(), [false, false, true, false]);
    assert.deepEqual(x.ne(3).toArray(), [true, true, false, true]);
    assert.deepEqual(x.eq(NaN).toArray(), [false, false, false, false]);
    assert.deepEqual(x.ne(NaN).toArray(), [true, true, true, true]);
    assert.equal(x.gt(1).dtype, 'bool');
  });
  it('column against column, int64 against float64', () => {
    const y = new Series([1, 1, 4, 2.5]);
    assert.deepEqual(x.eq(y).toArray(), [true, false, false, false]);
    assert.deepEqual(x.lt(y).toArray(), [false, false, true, true]);
    assert.deepEqual(new Series([1, 2, 3]).ge(new Series([1.5, 2, 2.5])).toArray(), [false, true, true]);
  });
  it('nullable dtypes keep the generic path', () => {
    const n = new Series([1, null, 3], { dtype: 'Int64' });
    assert.equal(n.gt(1).dtype, 'boolean');
    assert.deepEqual(n.gt(1).toArray(), [false, null, true]);
  });
});

describe('string and category equality fast path', () => {
  it('string column with missing values', () => {
    const s = new Series(['a', null, 'b', 'a']);
    assert.deepEqual(s.eq('a').toArray(), [true, false, false, true]);
    assert.deepEqual(s.ne('a').toArray(), [false, true, true, false]);
  });
  it('category column, including a value that is not a category', () => {
    const c = new Series(['x', 'y', null, 'x'], { dtype: 'category' });
    assert.deepEqual(c.eq('x').toArray(), [true, false, false, true]);
    assert.deepEqual(c.ne('x').toArray(), [false, true, true, false]);
    assert.deepEqual(c.eq('z').toArray(), [false, false, false, false]);
    assert.deepEqual(c.ne('z').toArray(), [true, true, true, true]);
  });
});

describe('boolean logic fast path', () => {
  const a = new Series([true, true, false, false]);
  const b = new Series([true, false, true, false]);
  it('column with column', () => {
    assert.deepEqual(a.and(b).toArray(), [true, false, false, false]);
    assert.deepEqual(a.or(b).toArray(), [true, true, true, false]);
    assert.deepEqual(a.xor(b).toArray(), [false, true, true, false]);
  });
  it('column with a scalar', () => {
    assert.deepEqual(a.and(true).toArray(), [true, true, false, false]);
    assert.deepEqual(a.and(false).toArray(), [false, false, false, false]);
    assert.deepEqual(a.or(true).toArray(), [true, true, true, true]);
    assert.deepEqual(a.or(false).toArray(), [true, true, false, false]);
    assert.deepEqual(a.xor(true).toArray(), [false, false, true, true]);
  });
  it('the nullable boolean dtype keeps Kleene logic', () => {
    const k = new Series([true, null, false], { dtype: 'boolean' });
    assert.deepEqual(k.and(true).toArray(), [true, null, false]);
    assert.deepEqual(k.or(true).toArray(), [true, true, true]);
  });
});

describe('arithmetic fast path', () => {
  const x = new Series([1, 2, NaN, 4]);
  const y = new Series([2, 4, 1, 0]);
  it('column with column and with a scalar', () => {
    assert.deepEqual(x.add(y).toArray(), [3, 6, NaN, 4]);
    assert.deepEqual(x.sub(y).toArray(), [-1, -2, NaN, 4]);
    assert.deepEqual(x.mul(2).toArray(), [2, 4, NaN, 8]);
    assert.deepEqual(x.div(y).toArray(), [0.5, 0.5, NaN, Infinity]);
  });
  it('reversed operators', () => {
    assert.deepEqual(x.rsub(10).toArray(), [9, 8, NaN, 6]);
    assert.deepEqual(x.rdiv(8).toArray(), [8, 4, NaN, 2]);
    assert.deepEqual(x.rsub(y).toArray(), [1, 2, NaN, -4]);
  });
  it('dtypes follow pandas', () => {
    assert.equal(new Series([1, 2]).add(new Series([3, 4])).dtype, 'int64');
    assert.equal(new Series([1, 2]).div(2).dtype, 'float64');
    assert.equal(new Series([1, 2]).mul(new Series([true, false])).dtype, 'int64');
  });
});

describe('radix argsort for one numeric key', () => {
  // Reference: the stable comparison sort, NaN at naPosition, ties in original order.
  const reference = (v: number[], ascending: boolean, naPosition: 'first' | 'last') => {
    const idx = v.map((_, i) => i);
    const na = idx.filter((i) => Number.isNaN(v[i]));
    const ok = idx.filter((i) => !Number.isNaN(v[i])).sort((a, b) => (ascending ? v[a] - v[b] : v[b] - v[a]) || a - b);
    return naPosition === 'first' ? [...na, ...ok] : [...ok, ...na];
  };
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const special = [NaN, 0, -0, Infinity, -Infinity, 1e-310, -1e-310, Number.MAX_VALUE, -Number.MAX_VALUE];
  const values = Array.from({ length: 5000 }, () => {
    const r = rand();
    return r < 0.1 ? special[Math.floor(rand() * special.length)] : r < 0.4 ? Math.floor(rand() * 20) - 10 : (rand() - 0.5) * 1e6;
  });
  const s = new Series(values);
  for (const ascending of [true, false]) {
    for (const naPosition of ['first', 'last'] as const) {
      it(`ascending=${ascending}, naPosition=${naPosition}`, () => {
        const got = s.sortValues({ ascending, naPosition }).index.labels;
        assert.deepEqual(got, reference(values, ascending, naPosition));
      });
    }
  }
  it('int64, bool and category keys', () => {
    const ints = Array.from({ length: 2000 }, (_, i) => (i * 7919) % 101);
    assert.deepEqual(new Series(ints).sortValues().index.labels, reference(ints, true, 'last'));
    const bools = ints.map((v) => v % 3 === 0);
    assert.deepEqual(new Series(bools).sortValues({ ascending: false }).index.labels, reference(bools.map(Number), false, 'last'));
    const cats = new Series(ints.map((v) => (v % 5 === 0 ? null : `c${v % 4}`)), { dtype: 'category' });
    const codes = cats.toArray().map((v) => (v === null ? NaN : Number(String(v).slice(1))));
    assert.deepEqual(cats.sortValues({ naPosition: 'first' }).index.labels, reference(codes, true, 'first'));
  });
  it('DataFrame.sortValues by one column', () => {
    const df = new DataFrame({ x: values, id: values.map((_, i) => i) });
    assert.deepEqual(df.sortValues('x', { ascending: false }).get('id').toArray(), reference(values, false, 'last'));
  });
});

describe('CSV fast paths', () => {
  const cols = (df: DataFrame) => Object.fromEntries(df.columns.map((c) => [c, { dtype: df.get(c).dtype, values: df.get(c).toArray() }]));
  it('plain numbers: int64, float64 and NaN', () => {
    const df = pd.parseCsv('a,b,c,d\n1,1.5,1e3,\n-2,.5,2,3\n 3 ,-0.25,1.,4\n');
    assert.deepEqual(cols(df), {
      a: { dtype: 'int64', values: [1, -2, 3] },
      b: { dtype: 'float64', values: [1.5, 0.5, -0.25] },
      c: { dtype: 'float64', values: [1000, 2, 1] },
      d: { dtype: 'float64', values: [NaN, 3, 4] },
    });
  });
  it('values that need the full inference', () => {
    const df = pd.parseCsv('hex,inf,big,bool,mixed,empty\n0x10,inf,9007199254740993,True,1,\n1,-inf,1,False,a,\n');
    assert.deepEqual(cols(df), {
      hex: { dtype: 'string', values: ['0x10', '1'] },
      inf: { dtype: 'float64', values: [Infinity, -Infinity] },
      big: { dtype: 'bigint', values: [9007199254740993n, 1n] },
      bool: { dtype: 'bool', values: [true, false] },
      mixed: { dtype: 'string', values: ['1', 'a'] },
      empty: { dtype: 'float64', values: [NaN, NaN] },
    });
  });
  it('numeric NA, true and false markers', () => {
    assert.deepEqual(pd.parseCsv('a\n1\n-999\n3\n', { naValues: ['-999'] }).get('a').toArray(), [1, NaN, 3]);
    const flags = pd.parseCsv('a\n1\n0\n', { trueValues: ['1'], falseValues: ['0'] }).get('a');
    assert.deepEqual([flags.dtype, flags.toArray()], ['int64', [1, 0]]);
  });
  it('quotes, CRLF, comments and blank lines next to plain lines', () => {
    const text = 'a,b\r\n1,"x,y"\r\n\r\n#skip,me\r\n2,"say ""hi"""\r\n3,z';
    const df = pd.parseCsv(text, { comment: '#' });
    assert.deepEqual(cols(df), {
      a: { dtype: 'int64', values: [1, 2, 3] },
      b: { dtype: 'string', values: ['x,y', 'say "hi"', 'z'] },
    });
  });
  it('rows split across chunks', () => {
    const tok = new pd.CsvTokenizer();
    const rows = [...tok.push('a,b\n1,'), ...tok.push('2\n3,"q'), ...tok.push('"\n4,5'), ...tok.end()];
    assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', 'q'], ['4', '5']]);
  });
});
