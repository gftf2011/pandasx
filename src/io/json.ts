import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
export type JsonOrient = 'records' | 'columns' | 'index' | 'split' | 'values';

/** Reads JSON from a file path or a JSON string. The orient is detected when omitted. */
export function readJson(source: string, options: { orient?: JsonOrient; lines?: boolean } = {}): DataFrame {
  const text = !source.trimStart().startsWith('[') && !source.trimStart().startsWith('{') && existsSync(source) ? readFileSync(source, 'utf8') : source;
  if (options.lines) {
    return new DataFrame(text.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>));
  }
  return fromJsonValue(JSON.parse(text), options.orient);
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
  if (data && typeof data === 'object' && 'columns' in data && 'data' in data) return 'split';
  return 'columns';
}

function maybeNumber(k: string): Label {
  return /^-?\d+$/.test(k) ? Number(k) : k;
}

function jsonValue(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Serialises a frame to JSON; writes to `path` when given and always returns the text. */
export function toJson(df: DataFrame, path?: string, options: { orient?: JsonOrient; indent?: number } = {}): string {
  const orient = options.orient ?? 'columns';
  const names = df.columns;
  const labels = df.index.labels.map((l) => (Array.isArray(l) ? l.join(',') : String(l)));
  const cell = (n: string, i: number) => jsonValue(df._column(n).get(i));
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
    default:
      value = Object.fromEntries(names.map((n) => [n, Object.fromEntries(labels.map((l, i) => [l, cell(n, i)]))]));
  }
  const text = JSON.stringify(value, null, options.indent);
  if (path) writeFileSync(path, text, 'utf8');
  return text;
}
