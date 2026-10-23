import { readText, readTextSync, writeOutput, type Compression, type Source } from './source.ts';
import { Column } from '../core/column.ts';
import { Index } from '../core/indexes.ts';
import type { Label } from '../core/types.ts';
import { DataFrame } from '../frame.ts';

/**
 * - `records`  `[{col: v}, ...]`
 * - `columns`  `{col: {index: v}}` (pandas' default)
 * - `index`    `{index: {col: v}}`
 * - `split`    `{columns, index, data}`
 * - `values`   `[[v, ...], ...]`
 */
export type JsonOrient = 'records' | 'columns' | 'index' | 'split' | 'values' | 'table';

export interface ReadJsonOptions {
  orient?: JsonOrient;
  /** One JSON object per line (JSON Lines). */
  lines?: boolean;
  /** With `lines`, yield frames of this many rows. */
  chunksize?: number;
  compression?: Compression;
  encoding?: BufferEncoding;
  /** Columns to parse as datetimes. */
  convertDates?: readonly string[];
}

/** Reads JSON from a path, buffer or JSON text. The orient is detected when omitted. */
export function readJson(source: Source, options: ReadJsonOptions & { chunksize: number }): Generator<DataFrame>;
export function readJson(source: Source, options?: ReadJsonOptions): DataFrame;
export function readJson(source: Source, options: ReadJsonOptions = {}): DataFrame | Generator<DataFrame> {
  const text = readTextSync(source, { compression: options.compression, encoding: options.encoding, literal: (s) => /^\s*[[{]/.test(s) });
  return parseJsonText(text, options);
}

/** Reads JSON from a path, URL or buffer, asynchronously. */
export async function readJsonAsync(source: Source, options: ReadJsonOptions & { storageOptions?: RequestInit } = {}): Promise<DataFrame> {
  const text = await readText(source, { compression: options.compression, encoding: options.encoding, storageOptions: options.storageOptions, literal: (s) => /^\s*[[{]/.test(s) });
  return parseJsonText(text, { ...options, chunksize: undefined }) as DataFrame;
}

function parseJsonText(text: string, options: ReadJsonOptions): DataFrame | Generator<DataFrame> {
  const dates = (df: DataFrame) => {
    for (const c of options.convertDates ?? []) if (df.has(c)) df.set(c, df.get(c).astype('datetime'));
    return df;
  };
  if (options.lines) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (options.chunksize) {
      const size = options.chunksize;
      return (function* () {
        for (let i = 0; i < lines.length; i += size) {
          const df = new DataFrame(lines.slice(i, i + size).map((l) => JSON.parse(l) as Record<string, unknown>));
          yield dates(DataFrame._fromColumns(df._cols, Index.range(df.length, i)));
        }
      })();
    }
    return dates(new DataFrame(lines.map((l) => JSON.parse(l) as Record<string, unknown>)));
  }
  return dates(fromJsonValue(JSON.parse(text), options.orient));
}

export function fromJsonValue(data: unknown, orient?: JsonOrient): DataFrame {
  const o = orient ?? detectOrient(data);
  switch (o) {
    case 'records':
      return new DataFrame(data as Record<string, unknown>[]);
    case 'values':
      return new DataFrame(data as unknown[][]);
    case 'split': {
      const { columns, index, data: rows } = data as { columns: string[]; index?: Label[]; data: unknown[][] };
      return new DataFrame(rows, { columns, index });
    }
    case 'table': {
      const { schema, data: rows } = data as { schema: { fields: { name: string; type: string }[]; primaryKey?: string[] }; data: Record<string, unknown>[] };
      let df = new DataFrame(rows, { columns: schema.fields.map((f) => f.name) });
      for (const f of schema.fields) if (f.type === 'datetime') df.set(f.name, df.get(f.name).astype('datetime'));
      if (schema.primaryKey?.length) df = df.setIndex(schema.primaryKey.length === 1 ? schema.primaryKey[0] : schema.primaryKey);
      if (df.index.name === 'index') df.index = df.index.rename(null);
      return df;
    }
    case 'index': {
      const obj = data as Record<string, Record<string, unknown>>;
      return new DataFrame(Object.values(obj), { index: Object.keys(obj).map(maybeNumber) });
    }
    default: {
      const obj = data as Record<string, Record<string, unknown>>;
      const labels: string[] = [];
      const seen = new Set<string>();
      for (const col of Object.values(obj)) for (const k of Object.keys(col)) if (!seen.has(k)) { seen.add(k); labels.push(k); }
      const cols = new Map<string, Column>();
      for (const [name, col] of Object.entries(obj)) cols.set(name, Column.from(labels.map((l) => col[l] ?? null)));
      return DataFrame._fromColumns(cols, new Index(labels.map(maybeNumber)));
    }
  }
}

function detectOrient(data: unknown): JsonOrient {
  if (Array.isArray(data)) return data.length > 0 && Array.isArray(data[0]) ? 'values' : 'records';
  if (data && typeof data === 'object' && 'schema' in data && 'data' in data) return 'table';
  if (data && typeof data === 'object' && 'columns' in data && 'data' in data) return 'split';
  return 'columns';
}

function maybeNumber(k: string): Label {
  return /^-?\d+$/.test(k) ? Number(k) : k;
}

function jsonValue(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
}

/** Serialises a frame to JSON; writes to `path` when given and always returns the text. */
export function toJson(df: DataFrame, path?: string, options: { orient?: JsonOrient; indent?: number; lines?: boolean; compression?: Compression; dateFormat?: 'iso' | 'epoch' } = {}): string {
  const orient = options.lines ? 'records' : (options.orient ?? 'columns');
  if (options.lines && options.orient && options.orient !== 'records') throw new Error("lines requires orient 'records'");
  const names = df.columns;
  const labels = df.index.labels.map((l) => (Array.isArray(l) ? l.join(',') : String(l)));
  const cell = (n: string, i: number) => {
    const v = df._column(n).get(i);
    if (options.dateFormat === 'epoch' && v instanceof Date) return v.getTime();
    return jsonValue(v);
  };
  let value: unknown;
  switch (orient) {
    case 'records':
      value = Array.from({ length: df.length }, (_, i) => Object.fromEntries(names.map((n) => [n, cell(n, i)])));
      break;
    case 'values':
      value = Array.from({ length: df.length }, (_, i) => names.map((n) => cell(n, i)));
      break;
    case 'split':
      value = { columns: names, index: df.index.labels.map(jsonValue), data: Array.from({ length: df.length }, (_, i) => names.map((n) => cell(n, i))) };
      break;
    case 'index':
      value = Object.fromEntries(labels.map((l, i) => [l, Object.fromEntries(names.map((n) => [n, cell(n, i)]))]));
      break;
    case 'table':
      value = {
        schema: { fields: [{ name: df.index.name ?? 'index', type: 'integer' }, ...names.map((n) => ({ name: n, type: tableType(df._column(n).dtype) }))], primaryKey: [df.index.name ?? 'index'], pandas_version: '1.4.0' },
        data: Array.from({ length: df.length }, (_, i) => ({ [df.index.name ?? 'index']: jsonValue(df.index.labels[i]), ...Object.fromEntries(names.map((n) => [n, cell(n, i)])) })),
      };
      break;
    default:
      value = Object.fromEntries(names.map((n) => [n, Object.fromEntries(labels.map((l, i) => [l, cell(n, i)]))]));
  }
  const text = options.lines
    ? (value as unknown[]).map((r) => JSON.stringify(r)).join('\n') + '\n'
    : JSON.stringify(value, null, options.indent);
  if (path) writeOutput(path, text, options.compression);
  return text;
}

function tableType(dtype: string): string {
  if (dtype === 'int64' || dtype === 'Int64') return 'integer';
  if (dtype === 'float64' || dtype === 'Float64') return 'number';
  if (dtype === 'bool' || dtype === 'boolean') return 'boolean';
  if (dtype === 'datetime') return 'datetime';
  if (dtype === 'timedelta') return 'duration';
  return 'string';
}
