/** Excel (.xlsx) I/O through the optional `exceljs` dependency. */
import { Column } from '../core/column.ts';
import { Index } from '../core/indexes.ts';
import type { DType, Label } from '../core/types.ts';
import { isNA } from '../core/values.ts';
import { colTuple, DataFrame } from '../frame.ts';
import { toDatetime } from '../datetimes.ts';
import { DEFAULT_NA_VALUES } from './csv.ts';
import { readBytes, requireOptional, type Source } from './source.ts';
import type ExcelJSType from 'exceljs';

type ExcelJS = typeof ExcelJSType;

async function excel(): Promise<ExcelJS> {
  const mod = await requireOptional<{ default?: ExcelJS } & ExcelJS>('exceljs', 'Excel I/O');
  return (mod.default ?? mod) as ExcelJS;
}

export interface ReadExcelOptions {
  /** Sheet name or 0-based position (default 0); an array or null reads several into an object. */
  sheetName?: string | number | readonly (string | number)[] | null;
  /** Header row (default 0), several rows for MultiIndex columns, or null. */
  header?: number | readonly number[] | null;
  names?: readonly string[];
  indexCol?: number | string | readonly (number | string)[];
  /** Column names, or Excel letters like 'A:C,E'. */
  usecols?: readonly string[] | string;
  skiprows?: number | readonly number[];
  nrows?: number;
  dtype?: DType | Record<string, DType>;
  naValues?: readonly string[];
  keepDefaultNa?: boolean;
  parseDates?: readonly string[];
  trueValues?: readonly string[];
  falseValues?: readonly string[];
}

/** Plain JS value of an exceljs cell value. */
function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || v instanceof Date) return v;
  const o = v as Record<string, unknown>;
  if ('result' in o) return cellValue(o.result);
  if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('');
  if ('text' in o) return o.text;
  if ('error' in o) return null;
  return String(v);
}

function lettersToIndex(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function parseUsecols(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [a, b] = part.trim().split(':');
    const start = lettersToIndex(a), end = b ? lettersToIndex(b) : start;
    for (let k = start; k <= end; k++) out.add(k);
  }
  return out;
}

function sheetToFrame(rowsIn: unknown[][], o: ReadExcelOptions): DataFrame {
  let rows = rowsIn;
  if (typeof o.skiprows === 'number') rows = rows.slice(o.skiprows);
  else if (o.skiprows) { const s = new Set(o.skiprows); rows = rows.filter((_, i) => !s.has(i)); }
  const width = Math.max(0, ...rows.map((r) => r.length));
  const headerRows = o.header === null ? [] : Array.isArray(o.header) ? [...o.header] : [o.header ?? 0];
  let names: string[];
  if (o.names) names = [...o.names];
  else if (headerRows.length === 0) names = Array.from({ length: width }, (_, j) => String(j));
  else if (headerRows.length === 1) names = Array.from({ length: width }, (_, j) => { const v = rows[headerRows[0]]?.[j]; return isNA(v) || v === '' ? `Unnamed: ${j}` : String(v); });
  else {
    // Forward-fill merged (blank) cells of the upper header levels, like pandas.
    const levels = headerRows.map((r) => {
      let last = '';
      return Array.from({ length: width }, (_, j) => { const v = rows[r]?.[j]; if (!isNA(v) && v !== '') last = String(v); return isNA(v) || v === '' ? last : String(v); });
    });
    names = Array.from({ length: width }, (_, j) => levels.map((l) => l[j]).join('\u001f'));
  }
  const seen = new Map<string, number>();
  names = names.map((n) => { const k = seen.get(n); seen.set(n, (k ?? 0) + 1); return k === undefined ? n : `${n}.${k}`; });
  let body = rows.slice(headerRows.length ? Math.max(...headerRows) + 1 : 0);
  if (o.nrows !== undefined) body = body.slice(0, o.nrows);
  const na = new Set([...(o.keepDefaultNa === false ? [] : DEFAULT_NA_VALUES), ...(o.naValues ?? [])]);
  na.delete('');
  const trueSet = new Set(o.trueValues ?? []), falseSet = new Set(o.falseValues ?? []);
  const letters = typeof o.usecols === 'string' ? parseUsecols(o.usecols) : null;
  const indexCols = o.indexCol === undefined ? [] : (Array.isArray(o.indexCol) ? o.indexCol : [o.indexCol]).map((c) => (typeof c === 'number' ? names[c] : c));
  const cols = new Map<string, Column>();
  names.forEach((name, j) => {
    if (letters && !letters.has(j) && !indexCols.includes(name)) return;
    if (Array.isArray(o.usecols) && !o.usecols.includes(name) && !indexCols.includes(name)) return;
    const vals = body.map((r) => {
      const v = r[j];
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'string') {
        if (na.has(v)) return null;
        if (trueSet.has(v)) return true;
        if (falseSet.has(v)) return false;
      }
      return v;
    });
    const forced = typeof o.dtype === 'string' ? o.dtype : o.dtype?.[name];
    cols.set(name, o.parseDates?.includes(name) ? toDatetime(vals, { errors: 'coerce' })._col : Column.from(vals, forced));
  });
  let df = DataFrame._fromColumns(cols, Index.range(body.length), headerRows.length > 1 ? new Array(headerRows.length).fill(null) : null);
  if (indexCols.length) df = df.setIndex(indexCols.length === 1 ? indexCols[0] : indexCols);
  return df;
}

/** Reads sheet(s) of an .xlsx workbook (path, URL or Buffer), like `pd.read_excel`. Requires `exceljs`. */
export async function readExcel(source: Source, options?: ReadExcelOptions & { sheetName?: string | number }): Promise<DataFrame>;
export async function readExcel(source: Source, options: ReadExcelOptions & { sheetName: readonly (string | number)[] | null }): Promise<Record<string, DataFrame>>;
export async function readExcel(source: Source, o: ReadExcelOptions = {}): Promise<DataFrame | Record<string, DataFrame>> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readBytes(source, null)) as unknown as ArrayBuffer);
  const sheets = wb.worksheets;
  const pick = (k: string | number) => {
    const ws = typeof k === 'number' ? sheets[k] : wb.getWorksheet(k);
    if (!ws) throw new Error(`Worksheet ${String(k)} not found`);
    return ws;
  };
  const read = (ws: ExcelJSType.Worksheet) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = (row.values as unknown[]).slice(1).map(cellValue);
      rows[n - 1] = vals;
    });
    return sheetToFrame(Array.from(rows, (r) => r ?? []), o);
  };
  const want = o.sheetName === undefined ? 0 : o.sheetName;
  if (want === null || Array.isArray(want)) {
    const list = want === null ? sheets.map((s) => s.name) : want;
    return Object.fromEntries(list.map((k) => [typeof k === 'number' ? sheets[k].name : k, read(pick(k))]));
  }
  return read(pick(want as string | number));
}

export interface ToExcelOptions {
  sheetName?: string;
  index?: boolean;
  header?: boolean;
  /** Header for the index column(s). */
  indexLabel?: string | readonly string[];
  startrow?: number;
  startcol?: number;
  /** Text for missing values (default: empty cell). */
  naRep?: string;
  /** Excel number format for floats, e.g. '0.00'. */
  floatFormat?: string;
  /** Excel format for datetimes (default 'yyyy-mm-dd hh:mm:ss'). */
  datetimeFormat?: string;
  /** Freeze the first [rows, cols]. */
  freezePanes?: readonly [number, number];
  /** Merge repeated MultiIndex labels (default true). */
  mergeCells?: boolean;
}

function writeSheet(wb: ExcelJSType.Workbook, df: DataFrame, o: ToExcelOptions): void {
  const ws = wb.addWorksheet(o.sheetName ?? 'Sheet1');
  const r0 = (o.startrow ?? 0) + 1, c0 = (o.startcol ?? 0) + 1;
  const showIndex = o.index ?? true;
  const merge = o.mergeCells ?? true;
  const idx = df.index;
  const nIdx = showIndex ? idx.nlevels : 0;
  const levels = df.nColumnLevels;
  const keys = df.columns;
  const headerStyle = { font: { bold: true }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }, alignment: { horizontal: 'center', vertical: 'top' } } as const;
  const setHeader = (r: number, c: number, v: unknown) => {
    const cell = ws.getCell(r, c);
    cell.value = v as ExcelJSType.CellValue;
    Object.assign(cell, { font: headerStyle.font, border: headerStyle.border, alignment: headerStyle.alignment });
  };
  let row = r0;
  if (o.header ?? true) {
    const idxNames = idx.isMulti ? idx.names!.map((n) => n ?? '') : [idx.name ?? ''];
    const label = o.indexLabel === undefined ? idxNames : typeof o.indexLabel === 'string' ? [o.indexLabel] : [...o.indexLabel];
    for (let l = 0; l < levels; l++) {
      if (levels === 1) for (let k = 0; k < nIdx; k++) if (label[k]) setHeader(row, c0 + k, label[k]);
      let j = 0;
      while (j < keys.length) {
        const t = levels > 1 ? colTuple(keys[j]) : [keys[j]];
        let span = 1;
        if (merge && l < levels - 1) {
          while (j + span < keys.length && colTuple(keys[j + span]).slice(0, l + 1).every((p, q) => p === t[q])) span++;
        }
        setHeader(row, c0 + nIdx + j, t[l]);
        if (span > 1) ws.mergeCells(row, c0 + nIdx + j, row, c0 + nIdx + j + span - 1);
        j += span;
      }
      row++;
    }
    if (levels > 1 && showIndex && label.some((x) => x)) {
      label.forEach((x, k) => setHeader(row, c0 + k, x));
      row++;
    }
  }
  const cols = keys.map((k) => df._column(k));
  const labels = (i: number): Label[] => (idx.isMulti ? [...(idx.labels[i] as readonly Label[])] : [idx.labels[i]]);
  for (let i = 0; i < df.length; i++) {
    if (showIndex) labels(i).forEach((v, k) => {
      const prev = i > 0 ? labels(i - 1) : null;
      const same = merge && idx.isMulti && k < nIdx - 1 && prev && labels(i).slice(0, k + 1).every((p, q) => String(p) === String(prev[q]));
      if (!same) setHeader(row + i, c0 + k, v instanceof Date ? v : v);
    });
    cols.forEach((col, j) => {
      const cell = ws.getCell(row + i, c0 + nIdx + j);
      let v = col.get(i);
      if (isNA(v)) { if (o.naRep !== undefined) cell.value = o.naRep; return; }
      if (typeof v === 'bigint') v = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
      else if (typeof v === 'object' && !(v instanceof Date)) v = String(v);
      cell.value = v as ExcelJSType.CellValue;
      if (v instanceof Date) cell.numFmt = o.datetimeFormat ?? (v.getTime() % 86_400_000 === 0 ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss');
      else if (typeof v === 'number' && o.floatFormat && !Number.isInteger(v)) cell.numFmt = o.floatFormat;
    });
  }
  if (merge && showIndex && idx.isMulti) {
    for (let k = 0; k < nIdx - 1; k++) {
      let i = 0;
      while (i < df.length) {
        let span = 1;
        while (i + span < df.length && labels(i + span).slice(0, k + 1).every((p, q) => String(p) === String(labels(i)[q]))) span++;
        if (span > 1) ws.mergeCells(row + i, c0 + k, row + i + span - 1, c0 + k);
        i += span;
      }
    }
  }
  if (o.freezePanes) ws.views = [{ state: 'frozen', ySplit: o.freezePanes[0], xSplit: o.freezePanes[1] }];
}

/** Writes a frame to an .xlsx file (or returns the bytes when `path` is omitted). Requires `exceljs`. */
export async function toExcel(df: DataFrame, path?: string, o: ToExcelOptions = {}): Promise<Buffer> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  writeSheet(wb, df, o);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  if (path) (await import('node:fs')).writeFileSync(path, buf);
  return buf;
}

/** Several sheets in one workbook, like `pd.ExcelWriter`. */
export class ExcelWriter {
  private readonly path: string | undefined;
  private readonly sheets: [DataFrame, ToExcelOptions][] = [];

  constructor(path?: string) {
    this.path = path;
  }

  write(df: DataFrame, options: ToExcelOptions = {}): this {
    this.sheets.push([df, options]);
    return this;
  }

  /** Writes the workbook; returns its bytes. */
  async close(): Promise<Buffer> {
    const ExcelJS = await excel();
    const wb = new ExcelJS.Workbook();
    this.sheets.forEach(([df, o], k) => writeSheet(wb, df, { ...o, sheetName: o.sheetName ?? `Sheet${k + 1}` }));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    if (this.path) (await import('node:fs')).writeFileSync(this.path, buf);
    return buf;
  }
}
