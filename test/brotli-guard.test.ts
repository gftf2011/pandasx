// Brotli data must not reach a Node.js decoder vulnerable to CVE-2026-111497 ("Node2Shell").
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import * as pd from '../src/index.ts';
import { DataFrame } from '../src/index.ts';
import { _setNodeVersion, assertBrotliSafe, brotliVulnerable } from '../src/io/source.ts';

const VULNERABLE = '24.21.0';
const FIXED = '24.22.1';
const refused = { message: /CVE-2026-111497/ };

describe('brotliVulnerable', () => {
  it('knows the fixed releases of each line', () => {
    for (const v of ['22.23.3', '22.0.0', '24.22.0', '24.21.9', '26.12.0', '26.0.0', '20.19.5', '18.20.0', '23.11.0', '25.9.0']) assert.equal(brotliVulnerable(v), true, v);
    for (const v of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0']) assert.equal(brotliVulnerable(v), false, v);
  });
  it('the escape hatch allows trusted data', () => {
    assert.throws(() => assertBrotliSafe('x', VULNERABLE), refused);
    process.env.PANDASX_ALLOW_VULNERABLE_BROTLI = '1';
    try {
      assert.doesNotThrow(() => assertBrotliSafe('x', VULNERABLE));
    } finally {
      delete process.env.PANDASX_ALLOW_VULNERABLE_BROTLI;
    }
    assert.doesNotThrow(() => assertBrotliSafe('x', FIXED));
  });
});

describe('readers on a vulnerable Node.js', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pandasx-brotli-'));
  const csv = 'a,b\n1,x\n2,y\n';
  const df = new DataFrame({ a: [1, 2], b: ['x', 'y'] });
  let server: Server;
  let base = '';

  before(async () => {
    writeFileSync(join(dir, 'data.csv.br'), brotliCompressSync(csv));
    writeFileSync(join(dir, 'data.csv.gz'), gzipSync(csv));
    // Serves the CSV with Content-Encoding: br (or gzip), like a hostile server could.
    server = createServer((req, res) => {
      const br = req.url === '/br.csv';
      res.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': br ? 'br' : 'gzip' });
      res.end(br ? brotliCompressSync(csv) : gzipSync(csv));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => _setNodeVersion());

  it('refuse .br files, streams, Parquet pages and br responses', async () => {
    _setNodeVersion(VULNERABLE);
    const parquet = await df.toParquet(undefined, { compression: 'brotli' });
    assert.throws(() => pd.readCsv(join(dir, 'data.csv.br')), refused);
    assert.throws(() => pd.readCsv(Buffer.from(brotliCompressSync(csv)), { compression: 'brotli' }), refused);
    await assert.rejects(async () => { for await (const _ of pd.readCsvChunks(join(dir, 'data.csv.br'), { chunksize: 1 })); }, refused);
    await assert.rejects(pd.readParquet(parquet), refused);
    await assert.rejects(pd.readCsvAsync(`${base}/br.csv`), refused);
    await assert.rejects(async () => { for await (const _ of pd.readCsvChunks(`${base}/br.csv`, { chunksize: 1 })); }, refused);
  });
  it('still read other codecs and gzip responses', async () => {
    _setNodeVersion(VULNERABLE);
    assert.ok(pd.readCsv(join(dir, 'data.csv.gz')).equals(df));
    assert.ok((await pd.readCsvAsync(`${base}/gzip.csv`)).equals(df));
    assert.ok((await pd.readParquet(await df.toParquet(undefined, { compression: 'gzip' }))).equals(df));
  });
  it('read Brotli normally on a fixed Node.js', async () => {
    _setNodeVersion(FIXED);
    assert.ok(pd.readCsv(join(dir, 'data.csv.br')).equals(df));
    assert.ok((await pd.readParquet(await df.toParquet(undefined, { compression: 'brotli' }))).equals(df));
    assert.ok((await pd.readCsvAsync(`${base}/br.csv`)).equals(df));
  });
});
