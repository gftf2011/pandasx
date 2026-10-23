/**
 * Columnar formats: Parquet (optional `hyparquet` / `hyparquet-writer`) and
 * Feather / Arrow IPC (optional `apache-arrow`). The `pandas` metadata written
 * by pyarrow is honoured (index columns, nullable / categorical dtypes) and
 * written back, so files round-trip with pandas.
 */
import { Column } from '../core/column.ts';
import { Index } from '../core/indexes.ts';
import type { Label } from '../core/types.ts';
import { isNA } from '../core/values.ts';
import { DataFrame } from '../frame.ts';
import { readBytes, requireOptional, type Source } from './source.ts';

interface PandasColumnMeta { name: string | null; field_name: string; pandas_type: string; numpy_type: string; metadata: Record<string, unknown> | null }
interface PandasMeta {
  index_columns: (string | { kind: 'range'; name: string | null; start: number; stop: number; step: number })[];
  columns: PandasColumnMeta[];
  column_indexes?: unknown[];
}

// ---------------------------------------------------------------- building

/** Converts raw decoded values (bigints, Dates, ...) to a column honouring pandas metadata. */
function toColumn(values: unknown[], meta: PandasColumnMeta | undefined): Column {
  let vals = values.map((v) => (v === undefined ? null : v));
  const allSafe = vals.every((v) => typeof v !== 'bigint' || Number.isSafeInteger(Number(v)));
  if (allSafe) vals = vals.map((v) => (typeof v === 'bigint' ? Number(v) : v));
  const numpy = meta?.numpy_type ?? '';
  const pandas = meta?.pandas_type ?? '';
  if (pandas === 'categorical') {
    const cats = (meta?.metadata as { categories?: unknown[] } | null)?.categories;
    return Column.from(vals, 'category', { ordered: Boolean((meta?.metadata as { ordered?: boolean } | null)?.ordered), categories: cats });
  }
  if (numpy === 'Int64' || numpy === 'Int32' || numpy === 'Int16' || numpy === 'Int8' || numpy === 'UInt64') return Column.from(vals, 'Int64');
  if (numpy === 'Float64' || numpy === 'Float32') return Column.from(vals, 'Float64');
  if (numpy === 'boolean') return Column.from(vals, 'boolean');
  if (pandas === 'datetimetz' || numpy.startsWith('datetime64')) {
    const tz = (meta?.metadata as { timezone?: string } | null)?.timezone ?? null;
    const c = Column.from(vals, 'datetime');
    return tz ? new Column('datetime', c.data, { tz }) : c;
  }
  if (numpy.startsWith('timedelta64')) return Column.from(vals.map((v) => (typeof v === 'number' ? v / (numpy.includes('[ns]') ? 1e6 : numpy.includes('[us]') ? 1e3 : 1) : v)), 'timedelta');
  if (vals.some((v) => v instanceof Date) && vals.every((v) => v === null || v instanceof Date)) return Column.from(vals, 'datetime');
  return Column.from(vals);
}

function assemble(columns: [string, unknown[]][], meta: PandasMeta | null, rowCount: number): DataFrame {
  const byField = new Map((meta?.columns ?? []).map((c) => [c.field_name, c]));
  const cols = new Map<string, Column>();
  for (const [name, values] of columns) cols.set(name, toColumn(values, byField.get(name)));
  let df = DataFrame._fromColumns(cols, Index.range(rowCount));
  const idx = meta?.index_columns ?? [];
  if (idx.length === 1 && typeof idx[0] === 'object') {
    const r = idx[0];
    const labels = Array.from({ length: rowCount }, (_, i) => r.start + i * r.step);
    df.index = new Index(labels, { name: r.name, isDefault: r.start === 0 && r.step === 1 && r.name === null });
  } else if (idx.length && idx.every((c) => typeof c === 'string' && cols.has(c))) {
    const names = idx as string[];
    const display = names.map((n) => byField.get(n)?.name ?? null);
    df = df.setIndex(names.length === 1 ? names[0] : names);
    df.index = names.length === 1 ? df.index.rename(display[0]) : new Index(df.index.labels, { names: display });
  }
  return df;
}

/** Pandas metadata + the columns (index levels first are excluded from data columns). */
function describe(df: DataFrame, index: boolean | undefined): { columns: [string, Column][]; meta: PandasMeta } {
  const columns: [string, Column][] = [];
  const meta: PandasMeta = { index_columns: [], columns: [], column_indexes: [] };
  const idx = df.index;
  const storeIndex = index === true || (index === undefined && !idx.isDefault);
  const colMeta = (name: string | null, field: string, c: Column): PandasColumnMeta => {
    const [pandas_type, numpy_type] = pandasTypes(c);
    const metadata = c.dtype === 'category' ? { num_categories: c.meta.categories!.length, ordered: Boolean(c.meta.ordered) }
      : c.dtype === 'datetime' && c.meta.tz ? { timezone: c.meta.tz } : null;
    return { name, field_name: field, pandas_type, numpy_type, metadata };
  };
  for (const key of df.columns) {
    const c = df._column(key);
    columns.push([key, c]);
    meta.columns.push(colMeta(key, key, c));
  }
  if (storeIndex) {
    for (let l = 0; l < idx.nlevels; l++) {
      const name = idx.isMulti ? idx.names![l] : idx.name;
      const field = name ?? `__index_level_${l}__`;
      const vals = idx.isMulti ? idx.labels.map((t) => (t as readonly Label[])[l]) : idx.labels;
      const c = Column.from(vals);
      columns.push([field, c]);
      meta.columns.push(colMeta(name, field, c));
      meta.index_columns.push(field);
    }
  } else if (index === undefined) {
    meta.index_columns.push({ kind: 'range', name: idx.name, start: 0, stop: df.length, step: 1 });
  }
  return { columns, meta };
}

function pandasTypes(c: Column): [string, string] {
  switch (c.dtype) {
    case 'int64': return ['int64', 'int64'];
    case 'Int64': return ['int64', 'Int64'];
    case 'float64': return ['float64', 'float64'];
    case 'Float64': return ['float64', 'Float64'];
    case 'bool': return ['bool', 'bool'];
    case 'boolean': return ['bool', 'boolean'];
    case 'datetime': return c.meta.tz ? ['datetimetz', 'datetime64[ms]'] : ['datetime', 'datetime64[ms]'];
    case 'timedelta': return ['timedelta', 'timedelta64[ms]'];
    case 'category': return ['categorical', 'int8'];
    case 'bigint': return ['int64', 'int64'];
    case 'string': return ['unicode', 'object'];
    default: return ['mixed', 'object'];
  }
}

// ------------------------------------------------------------------ parquet

export interface ReadParquetOptions {
  /** Only these columns (index columns are added automatically). */
  columns?: readonly string[];
  /** Row range [rowStart, rowEnd). */
  rowStart?: number;
  rowEnd?: number;
  storageOptions?: RequestInit;
}

/** Reads a Parquet file (path, URL or bytes), like `pd.read_parquet`. Requires `hyparquet`. */
export async function readParquet(source: Source, o: ReadParquetOptions = {}): Promise<DataFrame> {
  const h = await requireOptional<typeof import('hyparquet')>('hyparquet', 'readParquet');
  let file: import('hyparquet').AsyncBuffer;
  const s = typeof source === 'string' || source instanceof URL ? String(source) : null;
  if (s && /^https?:/i.test(s)) file = await h.asyncBufferFromUrl({ url: s, requestInit: o.storageOptions });
  else if (s) file = await (h as unknown as { asyncBufferFromFile(p: string): Promise<import('hyparquet').AsyncBuffer> }).asyncBufferFromFile(s.startsWith('file:') ? new URL(s).pathname : s);
  else {
    const b = await readBytes(source, null);
    file = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  const metadata = await h.parquetMetadataAsync(file);
  const kv = metadata.key_value_metadata?.find((k) => k.key === 'pandas');
  const meta = kv?.value ? (JSON.parse(kv.value) as PandasMeta) : null;
  const fields = metadata.schema.slice(1).filter((e) => !e.num_children).map((e) => e.name);
  const indexFields = (meta?.index_columns ?? []).filter((c): c is string => typeof c === 'string');
  const wanted = o.columns ? [...new Set([...o.columns, ...indexFields])].filter((c) => fields.includes(c)) : fields;
  const rows = await h.parquetReadObjects({ file, metadata, columns: wanted, rowStart: o.rowStart, rowEnd: o.rowEnd });
  const columns: [string, unknown[]][] = wanted.map((f) => [f, rows.map((r) => (r as Record<string, unknown>)[f])]);
  const df = assemble(columns, meta, rows.length);
  if (o.rowStart && meta?.index_columns[0] && typeof meta.index_columns[0] === 'object') {
    df.index = Index.range(rows.length, o.rowStart);
  }
  return df;
}

export interface ToParquetOptions {
  /** Store the index: true, false, or default (stored unless it is the default RangeIndex). */
  index?: boolean;
  compression?: 'snappy' | 'gzip' | 'brotli' | 'zstd' | 'lz4' | 'uncompressed' | null;
  rowGroupSize?: number;
}

/** Writes Parquet (to `path`, or returns the bytes). Requires `hyparquet-writer`. */
export async function toParquet(df: DataFrame, path?: string, o: ToParquetOptions = {}): Promise<Buffer> {
  const w = await requireOptional<typeof import('hyparquet-writer')>('hyparquet-writer', 'toParquet');
  const { columns, meta } = describe(df, o.index);
  const columnData = columns.map(([name, c]) => parquetColumn(name, c));
  const codec = (o.compression === null || o.compression === 'uncompressed' ? 'UNCOMPRESSED' : (o.compression ?? 'snappy').toUpperCase()) as 'SNAPPY';
  // Naive datetimes must not be flagged as UTC-adjusted, or readers make them tz-aware.
  const schema = w.schemaFromColumnData({ columnData });
  // (The legacy converted type TIMESTAMP_MILLIS implies UTC, so naive columns use the logical type only.)
  columns.forEach(([, c], k) => {
    if (c.dtype !== 'datetime') return;
    const el = schema[k + 1] as unknown as Record<string, unknown>;
    el.logical_type = { type: 'TIMESTAMP', isAdjustedToUTC: Boolean(c.meta.tz), unit: 'MILLIS' };
    if (!c.meta.tz) delete el.converted_type;
  });
  const buf = Buffer.from(w.parquetWriteBuffer({
    columnData: columnData.map(({ name, data }) => ({ name, data })), schema, codec, rowGroupSize: o.rowGroupSize,
    kvMetadata: [{ key: 'pandas', value: JSON.stringify({ ...meta, creator: { library: 'node-pandas' }, pandas_version: '2.2.0' }) }],
  }));
  if (path) (await import('node:fs')).writeFileSync(path, buf);
  return buf;
}

function parquetColumn(name: string, c: Column): import('hyparquet-writer').ColumnSource {
  const vals = c.toArray().map((v) => (isNA(v) ? null : v));
  switch (c.dtype) {
    case 'float64': case 'Float64': return { name, data: vals, type: 'DOUBLE', nullable: true };
    case 'int64': case 'Int64': case 'bigint': return { name, data: vals.map((v) => (v === null ? null : BigInt(v as number))), type: 'INT64', nullable: true };
    case 'bool': case 'boolean': return { name, data: vals, type: 'BOOLEAN', nullable: true };
    case 'datetime': return { name, data: vals, type: 'TIMESTAMP', nullable: true };
    case 'timedelta': return { name, data: vals.map((v) => (v === null ? null : BigInt(Math.round((v as { ms: number }).ms)))), type: 'INT64', nullable: true };
    case 'string': case 'category': return { name, data: vals.map((v) => (v === null ? null : String(v))), type: 'STRING', nullable: true };
    default:
      if (vals.every((v) => v === null || typeof v === 'string')) return { name, data: vals, type: 'STRING', nullable: true };
      return { name, data: vals.map((v) => (v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))), type: 'STRING', nullable: true };
  }
}

// --------------------------------------------------------- feather / arrow

type Arrow = typeof import('apache-arrow');

/** Builds a DataFrame from an apache-arrow Table. */
export function fromArrow(table: import('apache-arrow').Table): DataFrame {
  const raw = table.schema.metadata.get('pandas');
  const meta = raw ? (JSON.parse(raw) as PandasMeta) : null;
  const columns: [string, unknown[]][] = table.schema.fields.map((f) => {
    const vec = table.getChild(f.name)!;
    const unit = (f.type as { unit?: number }).unit;
    const type = String(f.type);
    // arrow-js reads timestamps as epoch milliseconds; durations keep their unit.
    const durScale = [1000, 1, 1e-3, 1e-6][unit ?? 1];
    const vals: unknown[] = [];
    for (let i = 0; i < vec.length; i++) {
      let v = vec.get(i) as unknown;
      if (v !== null && (type.startsWith('Timestamp') || type.startsWith('Date')) && !(v instanceof Date)) v = new Date(Number(v));
      else if (v !== null && type.startsWith('Duration')) v = Number(v) * durScale;
      vals.push(v);
    }
    return [f.name, vals];
  });
  return assemble(columns, meta, table.numRows);
}

/** Converts a DataFrame to an apache-arrow Table (requires `apache-arrow`). */
export async function toArrow(df: DataFrame, options: { index?: boolean } = {}): Promise<import('apache-arrow').Table> {
  const A = await requireOptional<Arrow>('apache-arrow', 'Arrow conversion');
  const { columns, meta } = describe(df, options.index);
  const vectors: Record<string, import('apache-arrow').Vector> = {};
  for (const [name, c] of columns) vectors[name] = arrowVector(A, c);
  const table = new A.Table(vectors);
  const schema = new A.Schema(table.schema.fields, new Map([['pandas', JSON.stringify({ ...meta, creator: { library: 'node-pandas' }, pandas_version: '2.2.0' })]]));
  return new A.Table(schema, table.batches);
}

function arrowVector(A: Arrow, c: Column): import('apache-arrow').Vector {
  const vals = c.toArray().map((v) => (isNA(v) ? null : v));
  switch (c.dtype) {
    case 'float64': case 'Float64': return A.vectorFromArray(vals as (number | null)[], new A.Float64());
    case 'int64': case 'Int64': case 'bigint': return A.vectorFromArray(vals.map((v) => (v === null ? null : BigInt(v as number))), new A.Int64());
    case 'bool': case 'boolean': return A.vectorFromArray(vals as (boolean | null)[], new A.Bool());
    case 'datetime': return A.vectorFromArray(vals.map((v) => (v === null ? null : (v as Date).getTime())), new A.TimestampMillisecond(c.meta.tz ?? null));
    case 'timedelta': return A.vectorFromArray(vals.map((v) => (v === null ? null : BigInt(Math.round((v as { ms: number }).ms)))), new A.Duration(A.TimeUnit.MILLISECOND));
    case 'category': return A.vectorFromArray(vals.map((v) => (v === null ? null : String(v))), new A.Dictionary(new A.Utf8(), new A.Int32()));
    default: return A.vectorFromArray(vals.map((v) => (v === null ? null : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))), new A.Utf8());
  }
}

let codecsRegistered = false;

/** Registers LZ4 (pandas' default for Feather) and ZSTD codecs with arrow-js. */
async function registerCodecs(A: Arrow): Promise<void> {
  if (codecsRegistered) return;
  const zlib = await import('node:zlib');
  const { lz4Decode, lz4EncodeStored } = await import('./lz4.ts');
  A.compressionRegistry.set(A.CompressionType.LZ4_FRAME, { decode: lz4Decode, encode: lz4EncodeStored });
  A.compressionRegistry.set(A.CompressionType.ZSTD, { decode: (d) => new Uint8Array(zlib.zstdDecompressSync(d)), encode: (d) => new Uint8Array(zlib.zstdCompressSync(d)) });
  codecsRegistered = true;
}

/** Reads a Feather (Arrow IPC) file or bytes, like `pd.read_feather`. Requires `apache-arrow`. */
export async function readFeather(source: Source, options: { columns?: readonly string[] } = {}): Promise<DataFrame> {
  const A = await requireOptional<Arrow>('apache-arrow', 'readFeather');
  await registerCodecs(A);
  let table = A.tableFromIPC(await readBytes(source, null));
  if (options.columns) table = table.select(options.columns as string[]);
  return fromArrow(table);
}

/** Writes Feather v2 (Arrow IPC file); returns the bytes. Requires `apache-arrow`. */
export async function toFeather(df: DataFrame, path?: string, options: { index?: boolean } = {}): Promise<Buffer> {
  const A = await requireOptional<Arrow>('apache-arrow', 'toFeather');
  await registerCodecs(A);
  const buf = Buffer.from(A.tableToIPC(await toArrow(df, options), 'file'));
  if (path) (await import('node:fs')).writeFileSync(path, buf);
  return buf;
}

