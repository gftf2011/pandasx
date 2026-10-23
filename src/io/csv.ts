import { readFileSync, writeFileSync } from 'node:fs';
import { Column } from '../core/column.ts';
import { formatScalar } from '../core/format.ts';
import { Index } from '../core/indexes.ts';
import type { DType, Label } from '../core/types.ts';
import { DataFrame } from '../frame.ts';

export const DEFAULT_NA_VALUES: readonly string[] = [
  '', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN',
  '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null',
];

export interface ReadCsvOptions {
  /** Field delimiter (default ','). */
  sep?: string;
  /** Row number of the header, or null when the file has none (default 0). */
  header?: number | null;
  /** Column names to use (implies no header unless `header` is given). */
  names?: readonly string[];
  /** Column (name or position) to use as the index. */
  indexCol?: string | number;
  /** Only load these columns. */
  usecols?: readonly string[];
  /** Force dtypes, globally or per column. */
  dtype?: DType | Record<string, DType>;
  /** Extra strings recognised as NA. */
  naValues?: readonly string[];
  /** Include the default NA strings (default true). */
  keepDefaultNa?: boolean;
  /** Columns to parse as datetimes. */
  parseDates?: readonly string[];
  /** Read at most this many data rows. */
  nrows?: number;
  /** Skip this many lines at the start of the file. */
  skiprows?: number;
  trueValues?: readonly string[];
  falseValues?: readonly string[];
  /** Thousands separator to strip from numbers, e.g. ','. */
  thousands?: string;
  quotechar?: string;
  encoding?: BufferEncoding;
}

/** Reads a CSV file into a DataFrame (synchronous, like `pandas.read_csv`). */
export function readCsv(path: string, options: ReadCsvOptions = {}): DataFrame {
  return parseCsv(readFileSync(path, { encoding: options.encoding ?? 'utf8' }), options);
}

/** Splits CSV text into rows of fields (RFC 4180 quoting, CRLF or LF). */
export function tokenize(text: string, sep = ',', quote = '"'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) { field += quote; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === quote && field === '') { inQuotes = true; i++; continue; }
    if (text.startsWith(sep, i)) { row.push(field); field = ''; i += sep.length; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const SPECIAL_NUM: Record<string, number> = { inf: Infinity, '+inf': Infinity, '-inf': -Infinity, Infinity: Infinity, '-Infinity': -Infinity };

/** Parses CSV text into a DataFrame, inferring int64 / float64 / bool / string dtypes. */
export function parseCsv(text: string, options: ReadCsvOptions = {}): DataFrame {
  let rows = tokenize(text, options.sep ?? ',', options.quotechar ?? '"');
  if (options.skiprows) rows = rows.slice(options.skiprows);

  const headerRow = options.header === undefined ? (options.names ? null : 0) : options.header;
  let names: string[];
  if (headerRow !== null) {
    names = (rows[headerRow] ?? []).map((h, j) => (h === '' ? `Unnamed: ${j}` : h));
    rows = rows.slice(headerRow + 1);
  } else {
    names = Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, j) => String(j));
  }
  if (options.names) names = [...options.names];
  names = dedupe(names);
  if (options.nrows !== undefined) rows = rows.slice(0, options.nrows);

  const na = new Set([...(options.keepDefaultNa === false ? [] : DEFAULT_NA_VALUES), ...(options.naValues ?? [])]);
  const trueSet = new Set(['True', 'TRUE', 'true', ...(options.trueValues ?? [])]);
  const falseSet = new Set(['False', 'FALSE', 'false', ...(options.falseValues ?? [])]);
  const parseDates = new Set(options.parseDates ?? []);

  const cols = new Map<string, Column>();
  names.forEach((name, j) => {
    if (options.usecols && !options.usecols.includes(name) && name !== options.indexCol && j !== options.indexCol) return;
    const raw = rows.map((r) => r[j] ?? '');
    const forced = typeof options.dtype === 'string' ? options.dtype : options.dtype?.[name];
    cols.set(name, parseDates.has(name) ? Column.from(raw.map((v) => (na.has(v) ? null : v)), 'datetime') : inferColumn(raw, na, trueSet, falseSet, forced, options.thousands));
  });

  let index: Index = Index.range(rows.length);
  if (options.indexCol !== undefined) {
    const key = typeof options.indexCol === 'number' ? names[options.indexCol] : options.indexCol;
    const col = cols.get(key);
    if (!col) throw new Error(`Index column not found: ${String(options.indexCol)}`);
    index = new Index(col.toArray() as Label[], { name: key });
    cols.delete(key);
  }
  return DataFrame._fromColumns(cols, index);
}

function inferColumn(raw: readonly string[], na: ReadonlySet<string>, trueSet: ReadonlySet<string>, falseSet: ReadonlySet<string>, forced: DType | undefined, thousands?: string): Column {
  const values = raw.map((v) => (na.has(v) ? null : v));
  if (forced === 'string' || forced === 'object') return Column.from(values, forced);
  const clean = (v: string) => (thousands ? v.split(thousands).join('') : v).trim();

  let numeric = true, ints = true, bools = true, missing = false, any = false;
  for (const v of values) {
    if (v === null) { missing = true; continue; }
    any = true;
    const c = clean(v);
    if (numeric && !(NUMBER_RE.test(c) || c in SPECIAL_NUM)) numeric = false;
    if (numeric && ints && !/^[+-]?\d+$/.test(c)) ints = false;
    if (bools && !trueSet.has(v) && !falseSet.has(v)) bools = false;
    if (!numeric && !bools) break;
  }
  if (forced) {
    return Column.from(values.map((v) => (v === null ? null : forced === 'bool' ? trueSet.has(v) : numeric ? toNum(clean(v)) : v)), forced);
  }
  if (!any) return Column.full(values.length, null, 'float64');
  if (numeric) {
    const out = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = values[i] === null ? NaN : toNum(clean(values[i]!));
    return new Column(ints && !missing ? 'int64' : 'float64', out);
  }
  if (bools) {
    if (missing) return Column.from(values.map((v) => (v === null ? null : trueSet.has(v))), 'object');
    return Column.from(values.map((v) => trueSet.has(v!)), 'bool');
  }
  return Column.from(values, 'string');
}

function toNum(v: string): number {
  return v in SPECIAL_NUM ? SPECIAL_NUM[v] : Number(v);
}

function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = seen.get(n);
    seen.set(n, (k ?? 0) + 1);
    return k === undefined ? n : `${n}.${k}`;
  });
}

export interface ToCsvOptions {
  sep?: string;
  /** Write the index as the first column (default true). */
  index?: boolean;
  /** Write the header row (default true). */
  header?: boolean;
  /** String for missing values (default ''). */
  naRep?: string;
  columns?: readonly string[];
  /** Fixed number of decimals for float columns. */
  floatDecimals?: number;
  lineTerminator?: string;
}

/** Serialises a frame to CSV; writes to `path` when given and always returns the text. */
export function toCsv(df: DataFrame, path?: string, options: ToCsvOptions = {}): string {
  const sep = options.sep ?? ',';
  const naRep = options.naRep ?? '';
  const eol = options.lineTerminator ?? '\n';
  const writeIndex = options.index ?? true;
  const names = options.columns ? [...options.columns] : df.columns;
  const quote = (s: string) => (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r') ? `"${s.replace(/"/g, '""')}"` : s);

  const cellFormatters = names.map((n) => {
    const col = df._column(n);
    if (col.dtype === 'datetime') {
      const data = col.data as Float64Array;
      const dateOnly = data.every((t) => Number.isNaN(t) || t % 86_400_000 === 0);
      return (i: number) => (Number.isNaN(data[i]) ? naRep : dateOnly ? new Date(data[i]).toISOString().slice(0, 10) : new Date(data[i]).toISOString());
    }
    if (col.dtype === 'float64' && options.floatDecimals !== undefined) {
      return (i: number) => (col.isNA(i) ? naRep : (col.data as Float64Array)[i].toFixed(options.floatDecimals));
    }
    return (i: number) => (col.isNA(i) ? naRep : quote(cell(col.get(i))));
  });

  const lines: string[] = [];
  if (options.header ?? true) {
    const idxHeader = writeIndex ? (df.index.nlevels > 1 ? df.index.names!.map((n) => n ?? '') : [df.index.name ?? '']) : [];
    lines.push([...idxHeader, ...names].map(quote).join(sep));
  }
  for (let i = 0; i < df.length; i++) {
    const parts: string[] = [];
    if (writeIndex) {
      const l = df.index.labels[i];
      if (df.index.nlevels > 1) for (const v of l as readonly Label[]) parts.push(quote(cell(v)));
      else parts.push(quote(cell(l)));
    }
    for (const f of cellFormatters) parts.push(f(i));
    lines.push(parts.join(sep));
  }
  const text = lines.join(eol) + eol;
  if (path) writeFileSync(path, text, 'utf8');
  return text;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return formatScalar(v);
}
