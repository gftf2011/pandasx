// Fixtures in test/fixtures were written by real pandas (parity/fixtures.py).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as pd from '../src/index.ts';
import { DataFrame, Series } from '../src/index.ts';

const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const tmp = mkdtempSync(join(tmpdir(), 'node-pandas-io-'));
const out = (f: string) => join(tmp, f);

/** The frame every fixture holds. */
const expected = () => new DataFrame({
  i: [1, 2, 3], f: [1.5, NaN, 3], s: ['x', null, 'zzã'], b: [true, false, true],
  t: pd.toDatetime(['2024-01-01', '2024-01-02 10:00', null]).toArray(),
}, { index: new pd.Index(['r1', 'r2', 'r3'], { name: 'id' }) });

const sameData = (a: DataFrame, b: DataFrame) => {
  assert.deepEqual(a.columns, b.columns);
  assert.deepEqual(a.index.toArray(), b.index.toArray());
  for (const c of a.columns) assert.ok(a.get(c).equals(b.get(c)), `column ${c}: ${a.get(c).toArray()} vs ${b.get(c).toArray()}`);
};

describe('compression and CSV extensions', () => {
  it('reads pandas gzip CSV and round-trips every codec', () => {
    const df = pd.readCsv(fx('pandas.csv.gz'), { indexCol: 'id', parseDates: ['t'] });
    sameData(df, expected());
    for (const ext of ['csv.gz', 'csv.zst', 'csv.br', 'csv.zip', 'csv.zz']) {
      expected().toCsv(out(`x.${ext}`));
      sameData(pd.readCsv(out(`x.${ext}`), { indexCol: 'id', parseDates: ['t'] }), expected());
    }
  });
  it('chunks (sync and streaming)', async () => {
    const big = new DataFrame({ a: Array.from({ length: 25 }, (_, i) => i), b: Array.from({ length: 25 }, (_, i) => `q"${i}\n,`) });
    big.toCsv(out('big.csv.gz'), { index: false });
    const sync = [...pd.readCsv(out('big.csv.gz'), { chunksize: 10 })];
    assert.deepEqual(sync.map((c) => c.length), [10, 10, 5]);
    const chunks: DataFrame[] = [];
    for await (const c of pd.readCsvChunks(out('big.csv.gz'), { chunksize: 7 })) chunks.push(c);
    assert.deepEqual(chunks.map((c) => c.index.labels[0]), [0, 7, 14, 21]);
    assert.ok(pd.concat(chunks).equals(big));
  });
  it('options: decimal, thousands, comment, skipfooter, whitespace, bad lines', () => {
    assert.deepEqual(pd.readCsv('a;b\n1.000,5;x\n', { sep: ';', decimal: ',', thousands: '.' }).get('a').toArray(), [1000.5]);
    assert.deepEqual(pd.readCsv('# hi\na b\n1   2\n', { sep: '\\s+', comment: '#' }).values, [[1, 2]]);
    assert.equal(pd.readCsv('a\n1\n2\ntotal\n', { skipfooter: 1 }).get('a').dtype, 'int64');
    assert.throws(() => pd.readCsv('a,b\n1,2,3\n'), /expected 2 fields/);
    assert.equal(pd.readCsv('a,b\n1,2,3\n4,5\n', { onBadLines: 'skip' }).length, 1);
    assert.equal(expected().toCsv(undefined, { quoting: 'all', index: false }).split('\n')[0], '"i","f","s","b","t"');
  });
  it('fixed-width files', () => {
    const df = pd.readFwf('id  name   score\n 1  Ana     9.5\n22  Bruno  10.0\n');
    assert.deepEqual(df.columns, ['id', 'name', 'score']);
    assert.deepEqual(df.get('score').toArray(), [9.5, 10]);
  });
});

describe('JSON', () => {
  it('reads pandas orient=table and writes JSON lines', () => {
    sameData(pd.readJson(fx('pandas.json')), expected());
    const text = expected().resetIndex().toJson(undefined, { lines: true });
    assert.equal(text.split('\n').length, 4);
    assert.equal(pd.readJson(text, { lines: true }).length, 3);
    assert.deepEqual([...pd.readJson(text, { lines: true, chunksize: 2 })].map((c) => c.length), [2, 1]);
  });
});

describe('HTML and XML', () => {
  it('reads pandas to_html and produces the same markup', () => {
    const html = readFileSync(fx('pandas.html'), 'utf8');
    const [t] = pd.readHtml(html, { indexCol: 0 });
    assert.deepEqual(t.get(t.columns[0]).toArray(), [1, 2, 3]);
    const simple = new DataFrame({ a: [1, 2], b: [1.5, NaN] });
    assert.equal(simple.toHtml(), '<table border="1" class="dataframe">\n  <thead>\n    <tr style="text-align: right;">\n      <th></th>\n      <th>a</th>\n      <th>b</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <th>0</th>\n      <td>1</td>\n      <td>1.5</td>\n    </tr>\n    <tr>\n      <th>1</th>\n      <td>2</td>\n      <td>NaN</td>\n    </tr>\n  </tbody>\n</table>');
  });
  it('handles colspan/rowspan, thead, links and matching', () => {
    const html = `<p>x</p><table id="t"><thead><tr><th colspan="2">AB</th><th>C</th></tr></thead>
      <tr><td rowspan="2">1</td><td>2</td><td><a href="/u">3</a></td></tr><tr><td>5</td><td>6</td></tr></table>
      <table><tr><td>other</td></tr></table>`;
    const [t] = pd.readHtml(html, { attrs: { id: 't' } });
    assert.deepEqual(t.columns, ['AB', 'AB.1', 'C']);
    assert.deepEqual(t.values, [[1, 2, 3], [1, 5, 6]]);
    assert.equal(pd.readHtml(html, { match: 'other' }).length, 1);
    assert.deepEqual(pd.readHtml(html, { attrs: { id: 't' }, extractLinks: 'body' })[0].get('C').iat(0), JSON.stringify(['3', '/u']));
  });
  it('XML round trip matches pandas', () => {
    const xml = readFileSync(fx('pandas.xml'), 'utf8');
    const df = pd.readXml(xml, { parseDates: ['t'] }).setIndex('id');
    sameData(df, expected());
    // (pandas' etree parser writes the declaration with double quotes, lxml with single quotes.)
    assert.equal(expected().toXml().split('\n').slice(1).join('\n'), xml.trimEnd().split('\n').slice(1).join('\n'));
    assert.deepEqual(pd.readXml('<r><row a="1"><b>x</b></row><row a="2"><b>y</b></row><other/></r>', { xpath: '//row[@a="2"]' }).values, [[2, 'y']]);
  });
});

describe('SQL (node:sqlite)', () => {
  it('writes, appends, queries and reads tables', async () => {
    const db = new DatabaseSync(':memory:');
    assert.equal(await expected().toSql('t', db), 3);
    const back = await pd.readSql('t', db, { indexCol: 'id', parseDates: ['t'] });
    assert.deepEqual(back.get('f').toArray(), [1.5, NaN, 3]);
    assert.deepEqual(back.get('t').isna().toArray(), [false, false, true]);
    await assert.rejects(expected().toSql('t', db), /already exists/);
    await expected().toSql('t', db, { ifExists: 'append' });
    assert.deepEqual((await pd.readSqlQuery('SELECT count(*) AS n FROM t WHERE i >= ?', db, { params: [2] })).values, [[4]]);
    const chunks: number[] = [];
    for await (const c of pd.readSqlChunks('SELECT * FROM t', db, { chunksize: 4 })) chunks.push(c.length);
    assert.deepEqual(chunks, [4, 2]);
    await expected().toSql('t', db, { ifExists: 'replace', index: false });
    assert.deepEqual((await pd.readSqlTable('t', db, { columns: ['i'] })).columns, ['i']);
  });
  it('works with a database path and a generic async client', async () => {
    const path = out('x.db');
    await expected().toSql('t', path);
    assert.equal((await pd.readSql('SELECT * FROM t', path)).length, 3);
    const calls: [string, unknown[]][] = [];
    const client = { query: async (sql: string, params: unknown[]) => { calls.push([sql, params]); return { rows: [{ a: 1 }, { a: 2 }] }; } };
    assert.deepEqual((await pd.readSqlQuery('SELECT a FROM x', client)).get('a').toArray(), [1, 2]);
    assert.equal(calls.length, 1);
  });
});

describe('optional binary formats', () => {
  before(async () => {
    // These need the optional peer dependencies (installed as devDependencies here).
    await import('exceljs'); await import('hyparquet'); await import('apache-arrow'); await import('h5wasm/node');
  });
  it('Parquet: reads pandas files and writes files pandas reads', async () => {
    sameData(await pd.readParquet(fx('pandas.parquet')), expected());
    await expected().toParquet(out('x.parquet'));
    sameData(await pd.readParquet(out('x.parquet')), expected());
    const sub = await pd.readParquet(out('x.parquet'), { columns: ['f'] });
    assert.deepEqual(sub.columns, ['f']);
    assert.deepEqual(sub.index.toArray(), ['r1', 'r2', 'r3']);
  });
  it('Feather: reads pandas (lz4) files and round-trips', async () => {
    const df = await pd.readFeather(fx('pandas.feather'));
    assert.deepEqual(df.dtypes.toArray(), ['string', 'int64', 'float64', 'string', 'bool', 'datetime', 'Int64', 'category']);
    await expected().toFeather(out('x.feather'));
    sameData(await pd.readFeather(out('x.feather')), expected());
  });
  it('HDF5: reads fixed and table formats, writes table format', async () => {
    sameData(await pd.readHdf(fx('pandas_fixed.h5')) as DataFrame, expected());
    sameData(await pd.readHdf(fx('pandas_table.h5')) as DataFrame, expected());
    await expected().toHdf(out('x.h5'), 'frame', { mode: 'w' });
    await new Series([1.5, 2], { name: 'v' }).toHdf(out('x.h5'), 'series');
    assert.deepEqual(await pd.hdfKeys(out('x.h5')), ['/frame', '/series']);
    sameData(await pd.readHdf(out('x.h5'), 'frame') as DataFrame, expected());
    assert.deepEqual((await pd.readHdf(out('x.h5'), 'series') as Series).toArray(), [1.5, 2]);
  });
  it('Excel: reads pandas workbooks, writes several sheets', async () => {
    sameData(await pd.readExcel(fx('pandas.xlsx'), { sheetName: 'data', indexCol: 0 }), expected());
    const w = new pd.ExcelWriter(out('x.xlsx'));
    await w.write(expected(), { sheetName: 'one' }).write(expected().head(1), { sheetName: 'two', index: false }).close();
    const all = await pd.readExcel(out('x.xlsx'), { sheetName: null });
    assert.deepEqual(Object.keys(all), ['one', 'two']);
    sameData(all.one.setIndex('id'), expected());
    const bytes = await expected().toExcel();
    writeFileSync(out('y.xlsx'), bytes);
    assert.equal((await pd.readExcel(bytes)).length, 3);
  });
});
