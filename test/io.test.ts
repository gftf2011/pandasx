import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataFrame, parseCsv, readCsv, readJson } from '../src/index.ts';

describe('CSV', () => {
  it('parses quotes, NA and infers dtypes', () => {
    const df = parseCsv('id,name,score,ok\n1,"Silva, Ana",9.5,True\n2,"He said ""hi""",,False\r\n3,Bob,7,true\n');
    assert.deepEqual(df.dtypes.toArray(), ['int64', 'string', 'float64', 'bool']);
    assert.deepEqual(df.get('name').toArray(), ['Silva, Ana', 'He said "hi"', 'Bob']);
    assert.deepEqual(df.get('score').toArray(), [9.5, NaN, 7]);
  });

  it('supports sep, names, indexCol, usecols, nrows, dtype, parseDates, thousands', () => {
    const text = 'a;b;c;d\nx;1.000;2024-01-02;5\ny;2.500;2024-02-03;6\nz;3;2024-03-04;7\n';
    const df = parseCsv(text, { sep: ';', indexCol: 'a', usecols: ['b', 'c'], nrows: 2, parseDates: ['c'], thousands: '.' });
    assert.deepEqual(df.columns, ['b', 'c']);
    assert.deepEqual(df.index.toArray(), ['x', 'y']);
    assert.deepEqual(df.get('b').toArray(), [1000, 2500]);
    assert.equal(df.get('c').dtype, 'datetime');
    const raw = parseCsv('1,2\n3,4\n', { names: ['p', 'q'], dtype: { q: 'string' } });
    assert.deepEqual(raw.get('q').toArray(), ['2', '4']);
  });

  it('round-trips through a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-pandas-'));
    const path = join(dir, 'out.csv');
    const df = new DataFrame({ a: [1, 2], b: ['x,y', null], c: [true, false] });
    df.toCsv(path, { index: false });
    assert.equal(readFileSync(path, 'utf8'), 'a,b,c\n1,"x,y",True\n2,,False\n');
    assert.ok(readCsv(path).equals(df));
  });

  it('writes the index by default', () => {
    const csv = new DataFrame({ v: [1] }, { index: ['r1'] }).toCsv();
    assert.equal(csv, ',v\nr1,1\n');
  });
});

describe('JSON', () => {
  const df = new DataFrame({ a: [1, 2], b: ['x', 'y'] });

  it('writes the main orients', () => {
    assert.equal(df.toJson(undefined, { orient: 'records' }), '[{"a":1,"b":"x"},{"a":2,"b":"y"}]');
    assert.equal(df.toJson(), '{"a":{"0":1,"1":2},"b":{"0":"x","1":"y"}}');
    assert.equal(df.toJson(undefined, { orient: 'split' }), '{"columns":["a","b"],"index":[0,1],"data":[[1,"x"],[2,"y"]]}');
  });

  it('reads back any orient', () => {
    for (const orient of ['records', 'columns', 'split', 'index'] as const) {
      const back = readJson(df.toJson(undefined, { orient }), { orient });
      assert.deepEqual(back.toRecords(), df.toRecords(), orient);
    }
    // 'values' carries no column names, as in pandas.
    assert.deepEqual(readJson(df.toJson(undefined, { orient: 'values' })).values, df.values);
  });

  it('reads JSON lines', () => {
    assert.equal(readJson('{"a":1}\n{"a":2}\n', { lines: true }).length, 2);
  });
});
