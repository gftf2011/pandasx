import { appendFileSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { inferCompression, readText, readTextSync, writeOutput, type Compression, type Source } from './source.ts';
import { toDatetime } from '../datetimes.ts';
import { pyFloat } from '../core/interval.ts';
import { formatSpec, pyFormat } from '../core/pyformat.ts';
import { strftime } from '../core/strftime.ts';
import { toWall, tzOffset } from '../core/tz.ts';
import { isNumericDType } from '../core/types.ts';
import { colTuple } from '../frame.ts';
import { Column } from '../core/column.ts';
import { formatColumn, formatScalar } from '../core/format.ts';
import { Index } from '../core/indexes.ts';
import type { DType, Label } from '../core/types.ts';
import { DataFrame } from '../frame.ts';

export const DEFAULT_NA_VALUES: readonly string[] = [
  '', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN',
  '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null',
];

export interface ReadCsvOptions {
  /** Field delimiter (default ','); '\\s+' splits on runs of whitespace. */
  sep?: string;
  /** Row number of the header, or null when the file has none (default 0). */
  header?: number | null;
  /** Column names to use (implies no header unless `header` is given). */
  names?: readonly string[];
  /** Column(s) (name or position) to use as the index. */
  indexCol?: string | number | readonly (string | number)[];
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
  /** strptime format for `parseDates`. */
  dateFormat?: string;
  /** Read at most this many data rows. */
  nrows?: number;
  /** Skip this many lines at the start (or the listed line numbers). */
  skiprows?: number | readonly number[];
  /** Drop this many lines at the end. */
  skipfooter?: number;
  trueValues?: readonly string[];
  falseValues?: readonly string[];
  /** Thousands separator to strip from numbers, e.g. ','. */
  thousands?: string;
  /** Decimal mark, e.g. ',' for European files. */
  decimal?: string;
  quotechar?: string;
  /** Character escaping the quote / separator inside fields. */
  escapechar?: string;
  /** Lines starting with this character are ignored. */
  comment?: string;
  /** 'error' (default), 'skip' or 'warn' for rows with too many fields. */
  onBadLines?: 'error' | 'skip' | 'warn';
  encoding?: BufferEncoding;
  /** 'infer' (default, from the extension or magic bytes), 'gzip', 'zstd', 'zip', ... */
  compression?: Compression;
  /** Return an iterator of DataFrames with this many rows each. */
  chunksize?: number;
}

/** Reads CSV from a path, buffer or text (sync). With `chunksize`, yields frames lazily. */
export function readCsv(source: Source, options: ReadCsvOptions & { chunksize: number }): Generator<DataFrame>;
export function readCsv(source: Source, options?: ReadCsvOptions): DataFrame;
export function readCsv(source: Source, options: ReadCsvOptions = {}): DataFrame | Generator<DataFrame> {
  const text = readTextSync(source, { compression: options.compression, encoding: options.encoding, literal: (s) => s.includes('\n') });
  if (options.chunksize) return chunked(text, options);
  return parseCsv(text, options);
}

/** `readCsv` with tab separator, like `pd.read_table`. */
export function readTable(source: Source, options: ReadCsvOptions = {}): DataFrame {
  return readCsv(source, { sep: '\t', ...options, chunksize: undefined });
}

/** Reads CSV from a path, URL or buffer, asynchronously. */
export async function readCsvAsync(source: Source, options: ReadCsvOptions & { storageOptions?: RequestInit } = {}): Promise<DataFrame> {
  const text = await readText(source, { compression: options.compression, encoding: options.encoding, storageOptions: options.storageOptions, literal: (s) => s.includes('\n') });
  return parseCsv(text, options);
}

function* chunked(text: string, options: ReadCsvOptions): Generator<DataFrame> {
  const { names, body } = splitHeader(tokenizeRows(text, options), options);
  const size = options.chunksize!;
  const limit = Math.min(body.length, options.nrows ?? Infinity);
  for (let start = 0; start < limit; start += size) {
    yield rowsToFrame(body.slice(start, Math.min(start + size, limit)), names, options, start);
  }
}

/**
 * Streams a CSV file (or URL) and yields DataFrames of `chunksize` rows without
 * loading the whole file, decompressing on the fly.
 */
export async function* readCsvChunks(source: string | URL, options: ReadCsvOptions & { chunksize: number; storageOptions?: RequestInit }): AsyncGenerator<DataFrame> {
  const s = String(source);
  const remote = /^https?:/i.test(s);
  const compression = inferCompression(remote ? new URL(s).pathname : s, options.compression);
  let stream: AsyncIterable<Uint8Array>;
  if (remote) {
    const res = await fetch(s, options.storageOptions);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${s}`);
    stream = res.body as unknown as AsyncIterable<Uint8Array>;
  } else stream = createReadStream(s.startsWith('file:') ? new URL(s) : s);
  if (compression === 'zip') throw new Error('Streaming zip archives is not supported; use readCsv');
  if (compression) {
    const z = compression === 'gzip' ? zlib.createGunzip() : compression === 'deflate' ? zlib.createInflate() : compression === 'brotli' ? zlib.createBrotliDecompress() : zlib.createZstdDecompress();
    stream = Readable.from(stream).pipe(z);
  }
  const decoder = new TextDecoder(options.encoding ?? 'utf-8');
  const tok = new CsvTokenizer(options);
  const header = options.header === undefined ? (options.names ? null : 0) : options.header;
  const skip = typeof options.skiprows === 'number' ? options.skiprows : 0;
  const limit = options.nrows ?? Infinity;
  let names: string[] | null = header === null ? (options.names ? [...options.names] : null) : null;
  let pending: string[][] = [];
  let emitted = 0;
  let seen = 0;
  const take = (rows: string[][]) => {
    for (const r of rows) {
      const k = seen++;
      if (k < skip) continue;
      if (header !== null && k - skip < header) continue;
      if (header !== null && k - skip === header) {
        names = options.names ? [...options.names] : dedupe(r.map((h, j) => (h === '' ? `Unnamed: ${j}` : h)));
        continue;
      }
      names ??= r.map((_, j) => String(j));
      pending.push(r);
    }
  };
  const flush = function* (all: boolean): Generator<DataFrame> {
    while ((all ? pending.length > 0 : pending.length >= options.chunksize) && emitted < limit) {
      const n = Math.min(options.chunksize, pending.length, limit - emitted);
      yield rowsToFrame(pending.slice(0, n), names ?? [], options, emitted);
      pending = pending.slice(n);
      emitted += n;
    }
  };
  for await (const chunk of stream) {
    take(tok.push(decoder.decode(chunk, { stream: true })));
    yield* flush(false);
    if (emitted >= limit) return;
  }
  take(tok.push(decoder.decode()));
  take(tok.end());
  yield* flush(true);
}

/** Incremental RFC 4180 tokenizer: quotes spanning chunks, CRLF, comments, escapes. */
export class CsvTokenizer {
  private readonly sep: string;
  private readonly quote: string;
  private readonly escape: string | undefined;
  private readonly comment: string | undefined;
  private readonly whitespace: boolean;
  private row: string[] = [];
  private field = '';
  private inQuotes = false;
  private quotedField = false;
  /** A closing quote seen at the very end of a chunk ("" may be split across chunks). */
  private quoteAtChunkEnd = false;
  private pendingCR = false;
  private atRowStart = true;
  private inComment = false;
  private first = true;

  constructor(options: Pick<ReadCsvOptions, 'sep' | 'quotechar' | 'escapechar' | 'comment'> = {}) {
    this.whitespace = options.sep === '\\s+' || options.sep === ' +';
    this.sep = options.sep ?? ',';
    this.quote = options.quotechar ?? '"';
    this.escape = options.escapechar;
    this.comment = options.comment;
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = '';
    this.quotedField = false;
  }

  private endRow(out: string[][]): void {
    this.endField();
    let r = this.row;
    this.row = [];
    this.atRowStart = true;
    if (this.whitespace) r = r.filter((f, i) => !(f === '' && (i === 0 || i === r.length - 1)));
    if (r.length && !(r.length === 1 && r[0] === '')) out.push(r);
  }

  push(text: string): string[][] {
    const out: string[][] = [];
    let i = 0;
    if (this.first && text.length) { if (text.charCodeAt(0) === 0xfeff) i = 1; this.first = false; }
    const n = text.length;
    const sepLen = this.sep.length;
    for (; i < n; i++) {
      const ch = text[i];
      if (this.pendingCR) { this.pendingCR = false; if (ch === '\n') continue; }
      if (this.quoteAtChunkEnd) {
        this.quoteAtChunkEnd = false;
        if (ch === this.quote) { this.field += this.quote; this.inQuotes = true; continue; }
      }
      if (this.inComment) {
        if (ch === '\n' || ch === '\r') { this.inComment = false; this.pendingCR = ch === '\r'; this.atRowStart = true; }
        continue;
      }
      if (this.inQuotes) {
        if (this.escape && ch === this.escape && i + 1 < n) { this.field += text[++i]; continue; }
        if (ch === this.quote) {
          this.inQuotes = false;
          if (i + 1 >= n) { this.quoteAtChunkEnd = true; continue; }
          if (text[i + 1] === this.quote) { this.field += this.quote; this.inQuotes = true; i++; }
          continue;
        }
        this.field += ch;
        continue;
      }
      if (this.atRowStart && this.comment && ch === this.comment) { this.inComment = true; continue; }
      this.atRowStart = false;
      if (this.escape && ch === this.escape && i + 1 < n) { this.field += text[++i]; continue; }
      if (ch === this.quote && this.field === '' && !this.quotedField) { this.inQuotes = true; this.quotedField = true; continue; }
      const isSep = this.whitespace ? ch === ' ' || ch === '\t' : sepLen === 1 ? ch === this.sep : text.startsWith(this.sep, i);
      if (isSep) {
        if (this.whitespace) { while (i + 1 < n && (text[i + 1] === ' ' || text[i + 1] === '\t')) i++; }
        else i += sepLen - 1;
        this.endField();
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        this.endRow(out);
        this.pendingCR = ch === '\r';
        continue;
      }
      this.field += ch;
    }
    return out;
  }

  end(): string[][] {
    const out: string[][] = [];
    this.quoteAtChunkEnd = false;
    if (this.field !== '' || this.row.length > 0 || this.quotedField) this.endRow(out);
    return out;
  }
}

/** Splits CSV text into rows of fields (RFC 4180 quoting, CRLF or LF). */
export function tokenize(text: string, sep = ',', quote = '"'): string[][] {
  const t = new CsvTokenizer({ sep, quotechar: quote });
  return [...t.push(text), ...t.end()];
}

function tokenizeRows(text: string, options: ReadCsvOptions): string[][] {
  const t = new CsvTokenizer(options);
  let rows = [...t.push(text), ...t.end()];
  if (typeof options.skiprows === 'number') rows = rows.slice(options.skiprows);
  else if (options.skiprows) { const skip = new Set(options.skiprows); rows = rows.filter((_, i) => !skip.has(i)); }
  if (options.skipfooter) rows = rows.slice(0, Math.max(0, rows.length - options.skipfooter));
  return rows;
}

function splitHeader(rows: string[][], options: ReadCsvOptions): { names: string[]; body: string[][] } {
  const headerRow = options.header === undefined ? (options.names ? null : 0) : options.header;
  let names: string[];
  let body = rows;
  if (headerRow !== null) {
    names = (rows[headerRow] ?? []).map((h, j) => (h === '' ? `Unnamed: ${j}` : h));
    body = rows.slice(headerRow + 1);
  } else {
    names = Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, j) => String(j));
  }
  if (options.names) names = [...options.names];
  return { names: dedupe(names), body };
}

/** Parses CSV text into a DataFrame, inferring int64 / float64 / bool / string dtypes. */
export function parseCsv(text: string, options: ReadCsvOptions = {}): DataFrame {
  const { names, body } = splitHeader(tokenizeRows(text, options), options);
  return rowsToFrame(options.nrows !== undefined ? body.slice(0, options.nrows) : body, names, options, 0);
}

/** Builds a frame from tokenised rows (also used by the HTML and fixed-width readers). */
export function rowsToFrame(rowsIn: string[][], names: string[], options: ReadCsvOptions, offset: number): DataFrame {
  let rows = rowsIn;
  const width = names.length;
  const bad = rows.findIndex((r) => r.length > width && r.slice(width).some((f) => f !== ''));
  if (bad >= 0 && width > 0) {
    const mode = options.onBadLines ?? 'error';
    if (mode === 'error') throw new Error(`Error tokenizing data: expected ${width} fields in data row ${offset + bad + 1}, saw ${rows[bad].length}`);
    if (mode === 'warn') process.emitWarning(`Skipping bad lines with more than ${width} fields`);
    rows = rows.filter((r) => !(r.length > width && r.slice(width).some((f) => f !== '')));
  }
  const na = new Set([...(options.keepDefaultNa === false ? [] : DEFAULT_NA_VALUES), ...(options.naValues ?? [])]);
  const trueSet = new Set(['True', 'TRUE', 'true', ...(options.trueValues ?? [])]);
  const falseSet = new Set(['False', 'FALSE', 'false', ...(options.falseValues ?? [])]);
  const parseDates = new Set(options.parseDates ?? []);
  const indexCols = options.indexCol === undefined ? [] : (Array.isArray(options.indexCol) ? options.indexCol : [options.indexCol]).map((c) => (typeof c === 'number' ? names[c] : c));

  const cols = new Map<string, Column>();
  names.forEach((name, j) => {
    if (options.usecols && !options.usecols.includes(name) && !indexCols.includes(name)) return;
    const raw = rows.map((r) => r[j] ?? '');
    const forced = typeof options.dtype === 'string' ? options.dtype : options.dtype?.[name];
    if (parseDates.has(name)) {
      const vals = raw.map((v) => (na.has(v) ? null : v));
      cols.set(name, options.dateFormat ? toDatetime(vals, { format: options.dateFormat, errors: 'coerce' })._col : Column.from(vals, 'datetime'));
    } else cols.set(name, inferColumn(raw, na, trueSet, falseSet, forced, options.thousands, options.decimal));
  });

  let index: Index = offset ? Index.range(rows.length, offset) : Index.range(rows.length);
  if (indexCols.length) {
    for (const k of indexCols) if (!cols.has(k)) throw new Error(`Index column not found: ${String(k)}`);
    const parts = indexCols.map((k) => cols.get(k)!.toArray() as Label[]);
    index = indexCols.length === 1 ? new Index(parts[0], { name: indexCols[0] }) : new Index(parts[0].map((_, i) => parts.map((p) => p[i])), { names: indexCols });
    for (const k of indexCols) cols.delete(k);
  }
  return DataFrame._fromColumns(cols, index);
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const SPECIAL_NUM: Record<string, number> = { inf: Infinity, '+inf': Infinity, '-inf': -Infinity, Infinity: Infinity, '-Infinity': -Infinity };

export function inferColumn(raw: readonly string[], na: ReadonlySet<string>, trueSet: ReadonlySet<string>, falseSet: ReadonlySet<string>, forced: DType | undefined, thousands?: string, decimal?: string): Column {
  const values = raw.map((v) => (na.has(v) ? null : v));
  if (forced === 'string' || forced === 'object') return Column.from(values, forced);
  const clean = (v: string) => {
    let t = thousands ? v.split(thousands).join('') : v;
    if (decimal && decimal !== '.') t = t.split(decimal).join('.');
    return t.trim();
  };

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
  if (numeric && ints && values.some((v) => v !== null && !Number.isSafeInteger(Number(clean(v))))) {
    // Integers beyond 2^53 keep full precision as bigint.
    return Column.from(values.map((v) => (v === null ? null : BigInt(clean(v)))), 'bigint');
  }
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
  /** Write the index as the first column(s) (default true). */
  index?: boolean;
  /** Header for the index column(s). */
  indexLabel?: string | readonly string[];
  /** Write the header row (default true), or replacement names. */
  header?: boolean | readonly string[];
  /** String for missing values (default ''). */
  naRep?: string;
  columns?: readonly string[];
  /** Fixed number of decimals for float columns. */
  floatDecimals?: number;
  /** Float format like pandas' `float_format`: '%.2f', '{:,.2f}' or a function. */
  floatFormat?: string | ((v: number) => string);
  /** Decimal mark for floats (default '.'). */
  decimal?: string;
  /** strftime format for datetime columns. */
  dateFormat?: string;
  /** 'minimal' (default), 'all', 'nonnumeric' or 'none'. */
  quoting?: 'minimal' | 'all' | 'nonnumeric' | 'none';
  quotechar?: string;
  lineTerminator?: string;
  /** 'w' (default) overwrites, 'a' appends. */
  mode?: 'w' | 'a';
  /** 'infer' (from the extension), 'gzip', 'zstd', 'zip', ... */
  compression?: Compression;
  encoding?: BufferEncoding;
}

/** Serialises a frame to CSV; writes to `path` when given and always returns the text. */
export function toCsv(df: DataFrame, path?: string, options: ToCsvOptions = {}): string {
  const sep = options.sep ?? ',';
  const naRep = options.naRep ?? '';
  const eol = options.lineTerminator ?? '\n';
  const q = options.quotechar ?? '"';
  const quoting = options.quoting ?? 'minimal';
  const writeIndex = options.index ?? true;
  const names = options.columns ? [...options.columns] : df.columns;
  const needs = (s: string) => s.includes(sep) || s.includes(q) || s.includes('\n') || s.includes('\r');
  const quote = (s: string, numeric = false) => {
    if (quoting === 'none') return s;
    if (quoting === 'all' || (quoting === 'nonnumeric' && !numeric) || needs(s)) return `${q}${s.split(q).join(q + q)}${q}`;
    return s;
  };

  const cellFormatters = names.map((n) => {
    const col = df._column(n);
    if (col.dtype === 'datetime') {
      const data = col.data as Float64Array;
      const tz = col.meta.tz ?? null;
      const dateOnly = !tz && data.every((t) => Number.isNaN(t) || t % 86_400_000 === 0);
      return (i: number) => {
        if (Number.isNaN(data[i])) return naRep;
        if (options.dateFormat) return quote(strftime(toWall(data[i], tz), options.dateFormat, tz ? tzOffset(data[i], tz) : null, tz));
        if (dateOnly) return new Date(data[i]).toISOString().slice(0, 10);
        return quote(formatColumn(col, [i])[0]);
      };
    }
    if (col.dtype === 'float64' || col.dtype === 'Float64') {
      const data = col.data as Float64Array;
      const floatFmt = floatFormatter(options.floatFormat);
      return (i: number) => {
        if (data[i] !== data[i]) return naRep;
        let t = floatFmt ? floatFmt(data[i]) : options.floatDecimals !== undefined ? data[i].toFixed(options.floatDecimals) : pyFloat(data[i]);
        if (options.decimal && options.decimal !== '.') t = t.replace('.', options.decimal);
        return quote(t, true);
      };
    }
    const numeric = isNumericDType(col.dtype);
    return (i: number) => (col.isNA(i) ? naRep : quote(cell(col.get(i)), numeric));
  });

  const lines: string[] = [];
  if (options.header !== false) {
    const idxNames = df.index.nlevels > 1 ? df.index.names!.map((n) => n ?? '') : [df.index.name ?? ''];
    const label = options.indexLabel === undefined ? idxNames : typeof options.indexLabel === 'string' ? [options.indexLabel] : [...options.indexLabel];
    const header = Array.isArray(options.header) ? options.header : names.map((n) => colTuple(n).join(df.nColumnLevels > 1 ? '.' : ''));
    if (df.nColumnLevels > 1 && !Array.isArray(options.header)) {
      // One header line per column level, like pandas.
      for (let l = 0; l < df.nColumnLevels; l++) {
        const lvl = names.map((n) => colTuple(n)[l]);
        lines.push([...(writeIndex ? label.map((x, k) => (k === 0 ? (df._colNames?.[l] ?? '') : x)) : []), ...lvl].map((x) => quote(x)).join(sep));
      }
      if (writeIndex) lines.push([...label, ...names.map(() => '')].map((x) => quote(x)).join(sep));
    } else lines.push([...(writeIndex ? label : []), ...header].map((x) => quote(x)).join(sep));
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
  if (path) {
    if (options.mode === 'a') appendFileSync(path, text, options.encoding ?? 'utf8');
    else writeOutput(path, text, options.compression, options.encoding);
  }
  return text;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloat(v);
  return formatScalar(v);
}

/** Fixed-width text, like `pd.read_fwf`. Column spans are inferred from blank gaps unless given. */
export function readFwf(source: Source, options: ReadCsvOptions & { colspecs?: 'infer' | readonly (readonly [number, number])[]; widths?: readonly number[]; inferNrows?: number } = {}): DataFrame {
  const text = readTextSync(source, { compression: options.compression, encoding: options.encoding, literal: (s) => s.includes('\n') });
  let lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !(options.comment && l.startsWith(options.comment)));
  if (typeof options.skiprows === 'number') lines = lines.slice(options.skiprows);
  let specs: [number, number][];
  if (options.widths) {
    let at = 0;
    specs = options.widths.map((w) => { const s = [at, at + w] as [number, number]; at += w; return s; });
  } else if (options.colspecs && options.colspecs !== 'infer') specs = options.colspecs.map(([a, b]) => [a, b]);
  else {
    const sample = lines.slice(0, options.inferNrows ?? 100);
    const width = Math.max(...sample.map((l) => l.length));
    const filled = Array.from({ length: width }, (_, c) => sample.some((l) => c < l.length && !/\s/.test(l[c])));
    specs = [];
    for (let c = 0; c < width; c++) {
      if (filled[c] && (c === 0 || !filled[c - 1])) specs.push([c, c + 1]);
      else if (filled[c]) specs[specs.length - 1][1] = c + 1;
    }
  }
  const rows = lines.map((l) => specs.map(([a, b]) => l.slice(a, b).trim()));
  const { names, body } = splitHeader(rows, options);
  return rowsToFrame(options.nrows !== undefined ? body.slice(0, options.nrows) : body, names, options, 0);
}

/** Formatter for `floatFormat`: printf style ('%.2f', '%e'), Python style ('{:,.2f}') or a function. */
function floatFormatter(fmt: string | ((v: number) => string) | undefined): ((v: number) => string) | null {
  if (fmt === undefined) return null;
  if (typeof fmt === 'function') return fmt;
  const printf = /^%([-+ 0#]*\d*(?:\.\d+)?[eEfFgG%])$/.exec(fmt);
  if (printf) return (v) => formatSpec(v, printf[1]);
  return (v) => pyFormat(fmt, v);
}
