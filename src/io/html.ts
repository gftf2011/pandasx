/** HTML tables: readHtml (all <table>s in a document) and toHtml (pandas-compatible markup). */
import { Column } from '../core/column.ts';
import { formatColumn, formatScalar } from '../core/format.ts';
import type { Label } from '../core/types.ts';
import { colTuple, DataFrame } from '../frame.ts';
import { elementChildren, escapeXml, findAll, parseMarkup, textContent, type MNode } from './markup.ts';
import { rowsToFrame, type ReadCsvOptions } from './csv.ts';
import { readText, readTextSync, writeOutput, type Source } from './source.ts';

export interface ReadHtmlOptions {
  /** Keep only tables whose text matches (string or RegExp, default all). */
  match?: string | RegExp;
  /** Row(s) to use as the header (default: <thead> rows, else leading rows of <th>). */
  header?: number | readonly number[] | null;
  indexCol?: number | string | readonly (number | string)[];
  skiprows?: number | readonly number[];
  /** Keep only tables with these attributes, e.g. `{ id: 'prices' }`. */
  attrs?: Record<string, string>;
  /** Thousands separator stripped from numbers (default ','). */
  thousands?: string | null;
  decimal?: string;
  naValues?: readonly string[];
  keepDefaultNa?: boolean;
  parseDates?: readonly string[];
  /** Skip elements hidden with style="display:none" (default true). */
  displayedOnly?: boolean;
  /** Return [text, href] pairs for cells of 'header', 'body', 'footer' or 'all'. */
  extractLinks?: 'all' | 'header' | 'body' | 'footer' | null;
  encoding?: BufferEncoding;
}

const WS = /[\r\n]+|\s{2,}/g;
const clean = (s: string) => s.trim().replace(WS, ' ');

function hidden(n: MNode): boolean {
  return /display\s*:\s*none/i.test(n.attrs.style ?? '');
}

/** Rows (cells) of a table, ignoring nested tables. */
function tableRows(table: MNode, displayedOnly: boolean): { section: 'head' | 'body' | 'foot'; cells: MNode[] }[] {
  const out: { section: 'head' | 'body' | 'foot'; cells: MNode[] }[] = [];
  const visit = (n: MNode, section: 'head' | 'body' | 'foot') => {
    for (const c of elementChildren(n)) {
      if (displayedOnly && hidden(c)) continue;
      if (c.tag === 'table') continue;
      if (c.tag === 'thead') visit(c, 'head');
      else if (c.tag === 'tbody') visit(c, 'body');
      else if (c.tag === 'tfoot') visit(c, 'foot');
      else if (c.tag === 'tr') out.push({ section, cells: elementChildren(c).filter((x) => (x.tag === 'td' || x.tag === 'th') && !(displayedOnly && hidden(x))) });
      else visit(c, section);
    }
  };
  visit(table, 'body');
  return out;
}

function cellText(cell: MNode, displayedOnly: boolean): string {
  const strip = (n: MNode | string): string => {
    if (typeof n === 'string') return n;
    if (displayedOnly && hidden(n)) return '';
    if (n.tag === 'br') return '\n';
    return n.children.map(strip).join('');
  };
  return clean(strip(cell));
}

/** Expands colspan / rowspan into a rectangular grid of strings. */
function grid(rows: MNode[][], text: (c: MNode) => string): string[][] {
  const out: string[][] = [];
  const carry: { col: number; left: number; value: string }[] = [];
  rows.forEach((cells) => {
    const row: string[] = [];
    let col = 0;
    const fillCarry = () => {
      for (;;) {
        const c = carry.find((x) => x.col === col && x.left > 0);
        if (!c) return;
        row[col++] = c.value;
        c.left--;
      }
    };
    for (const cell of cells) {
      fillCarry();
      const value = text(cell);
      const cs = Math.max(1, Number(cell.attrs.colspan ?? 1) || 1);
      const rs = Math.max(1, Number(cell.attrs.rowspan ?? 1) || 1);
      for (let k = 0; k < cs; k++) {
        row[col] = value;
        if (rs > 1) carry.push({ col, left: rs - 1, value });
        col++;
      }
    }
    fillCarry();
    out.push(Array.from(row, (v) => v ?? ''));
  });
  return out;
}

function parseTables(html: string, o: ReadHtmlOptions): DataFrame[] {
  const root = parseMarkup(html, 'html');
  const displayedOnly = o.displayedOnly ?? true;
  let tables = findAll(root, (n) => n.tag === 'table');
  if (o.attrs) tables = tables.filter((t) => Object.entries(o.attrs!).every(([k, v]) => t.attrs[k] === v));
  if (o.match !== undefined) {
    const re = typeof o.match === 'string' ? new RegExp(o.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : o.match;
    tables = tables.filter((t) => re.test(textContent(t)));
  }
  if (tables.length === 0) throw new Error(o.match !== undefined ? `No tables found matching ${String(o.match)}` : 'No tables found');
  return tables.map((t) => tableToFrame(t, o, displayedOnly));
}

function tableToFrame(table: MNode, o: ReadHtmlOptions, displayedOnly: boolean): DataFrame {
  const rows = tableRows(table, displayedOnly);
  const link = (c: MNode, section: string) => {
    const t = cellText(c, displayedOnly);
    const want = o.extractLinks === 'all' || o.extractLinks === section;
    if (!want) return t;
    const a = findAll(c, (n) => n.tag === 'a')[0];
    return JSON.stringify([t, a?.attrs.href ?? null]);
  };
  const sectionOf = rows.map((r) => r.section);
  // Cell text depends on the section when extracting links.
  const texts = new Map<MNode, string>();
  rows.forEach((r) => r.cells.forEach((c) => texts.set(c, link(c, r.section === 'head' ? 'header' : r.section === 'foot' ? 'footer' : 'body'))));
  const full = grid(rows.map((r) => r.cells), (c) => texts.get(c)!);

  let headerRows: number[];
  if (o.header !== undefined && o.header !== null) headerRows = Array.isArray(o.header) ? [...o.header] : [o.header as number];
  else if (o.header === null) headerRows = [];
  else {
    headerRows = sectionOf.flatMap((s, i) => (s === 'head' ? [i] : []));
    if (headerRows.length === 0) {
      // Leading rows made only of <th> cells.
      for (let i = 0; i < rows.length && rows[i].cells.length && rows[i].cells.every((c) => c.tag === 'th'); i++) headerRows.push(i);
    }
  }
  // Body rows, with <tfoot> rows last.
  const bodyIdx = full.map((_, i) => i).filter((i) => !headerRows.includes(i));
  let bodyRows = [...bodyIdx.filter((i) => sectionOf[i] !== 'foot'), ...bodyIdx.filter((i) => sectionOf[i] === 'foot')].map((i) => full[i]);
  if (typeof o.skiprows === 'number') bodyRows = bodyRows.slice(o.skiprows);
  else if (o.skiprows) { const s = new Set(o.skiprows); bodyRows = bodyRows.filter((_, i) => !s.has(i)); }
  const width = Math.max(0, ...full.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...new Array(Math.max(0, width - r.length)).fill('')];
  const headers = headerRows.map((i) => pad(full[i]));
  const multi = headers.length > 1;
  const names = Array.from({ length: width }, (_, j) => {
    if (headers.length === 0) return String(j);
    if (!multi) return headers[0][j] || `Unnamed: ${j}`;
    return headers.map((h) => h[j]).join('\u001f');
  });
  const csvOptions: ReadCsvOptions = {
    thousands: o.thousands === null ? undefined : (o.thousands ?? ','), decimal: o.decimal, naValues: o.naValues, keepDefaultNa: o.keepDefaultNa,
    parseDates: o.parseDates, indexCol: o.indexCol as ReadCsvOptions['indexCol'],
  };
  const df = rowsToFrame(bodyRows.map(pad), dedupeNames(names), csvOptions, 0);
  if (multi) df._colNames = new Array(headers.length).fill(null);
  return df;
}

function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = seen.get(n);
    seen.set(n, (k ?? 0) + 1);
    return k === undefined ? n : `${n}.${k}`;
  });
}

/** Parses every <table> of an HTML string or file into DataFrames, like `pd.read_html`. */
export function readHtml(source: Source, options: ReadHtmlOptions = {}): DataFrame[] {
  return parseTables(readTextSync(source, { encoding: options.encoding, literal: (s) => s.includes('<') }), options);
}

/** `readHtml` for URLs (or any source), asynchronously. */
export async function readHtmlAsync(source: Source, options: ReadHtmlOptions & { storageOptions?: RequestInit } = {}): Promise<DataFrame[]> {
  return parseTables(await readText(source, { encoding: options.encoding, storageOptions: options.storageOptions, literal: (s) => s.includes('<') }), options);
}

// ------------------------------------------------------------------ toHtml

export interface ToHtmlOptions {
  index?: boolean;
  header?: boolean;
  /** Table border attribute (default 1; 0 omits it). */
  border?: number;
  /** Extra CSS classes besides 'dataframe'. */
  classes?: string | readonly string[];
  tableId?: string;
  /** String for missing values (default 'NaN'). */
  naRep?: string;
  /** Escape <, > and & (default true). */
  escape?: boolean;
  /** text-align of the column headers (default 'right'). */
  justify?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
  /** Print the index names row (default true). */
  indexNames?: boolean;
  /** Merge repeated MultiIndex labels with rowspan/colspan (default true). */
  sparsify?: boolean;
  /** Turn URLs into links. */
  renderLinks?: boolean;
  /** Extra attributes per cell (used by Styler). */
  cellAttrs?: (row: number, col: number) => string;
  /** Fixed decimals for floats. */
  floatDecimals?: number;
}

/** Renders a frame as an HTML table, matching pandas' `to_html` markup. */
export function toHtml(df: DataFrame, path?: string, o: ToHtmlOptions = {}): string {
  const html = renderHtml(df, o);
  if (path) writeOutput(path, html);
  return html;
}

export function renderHtml(df: DataFrame, o: ToHtmlOptions = {}): string {
  const esc = (s: string) => (o.escape === false ? s : escapeXml(s));
  const link = (s: string) => (o.renderLinks && /^(https?|ftp):\/\//.test(s) ? `<a href="${escapeXml(s, true)}" target="_blank">${esc(s)}</a>` : esc(s));
  const showIndex = o.index ?? true;
  const sparsify = o.sparsify ?? true;
  const classes = ['dataframe', ...(typeof o.classes === 'string' ? o.classes.split(/\s+/) : o.classes ?? [])].filter(Boolean).join(' ');
  const border = o.border ?? 1;
  const naRep = o.naRep ?? 'NaN';
  const lines: string[] = [];
  const ind = (k: number) => '  '.repeat(k);
  lines.push(`<table${border ? ` border="${border}"` : ''} class="${classes}"${o.tableId ? ` id="${escapeXml(o.tableId, true)}"` : ''}>`);
  const keys = df.columns;
  const levels = df.nColumnLevels;
  const tuples = keys.map((k) => (levels > 1 ? colTuple(k) : [k]));
  const idx = df.index;
  const idxLevels = showIndex ? idx.nlevels : 0;
  const idxNames = idx.isMulti ? idx.names!.map((n) => n ?? '') : [idx.name ?? ''];
  const hasIdxNames = showIndex && (o.indexNames ?? true) && idxNames.some((n) => n !== '');

  if (o.header ?? true) {
    lines.push(`${ind(1)}<thead>`);
    for (let l = 0; l < levels; l++) {
      const style = levels === 1 ? ` style="text-align: ${o.justify ?? 'right'};"` : '';
      lines.push(`${ind(2)}<tr${style}>`);
      const levelName = levels > 1 ? (df._colNames?.[l] ?? '') : (df._colNames?.[0] ?? '');
      for (let k = 0; k < idxLevels; k++) lines.push(`${ind(3)}<th>${k === idxLevels - 1 ? esc(levelName) : ''}</th>`);
      for (let j = 0; j < tuples.length; j++) {
        if (levels > 1 && l < levels - 1 && sparsify) {
          const same = (a: number, b: number) => tuples[a].slice(0, l + 1).every((p, q) => p === tuples[b][q]);
          if (j > 0 && same(j, j - 1)) continue;
          let span = 1;
          while (j + span < tuples.length && same(j + span, j)) span++;
          lines.push(`${ind(3)}<th${span > 1 ? ` colspan="${span}" halign="left"` : ''}>${esc(tuples[j][l])}</th>`);
        } else lines.push(`${ind(3)}<th>${esc(tuples[j][l])}</th>`);
      }
      lines.push(`${ind(2)}</tr>`);
    }
    if (hasIdxNames) {
      lines.push(`${ind(2)}<tr>`);
      for (const nm of idxNames) lines.push(`${ind(3)}<th>${esc(nm)}</th>`);
      for (let j = 0; j < keys.length; j++) lines.push(`${ind(3)}<th></th>`);
      lines.push(`${ind(2)}</tr>`);
    }
    lines.push(`${ind(1)}</thead>`);
  }

  const n = df.length;
  const positions = Array.from({ length: n }, (_, i) => i);
  const cells = keys.map((k) => {
    const col = df._column(k);
    if (col.dtype === 'bool' || col.dtype === 'boolean') return positions.map((i) => (col.isNA(i) ? '<NA>' : col.get(i) ? 'True' : 'False'));
    if (o.floatDecimals !== undefined && (col.dtype === 'float64' || col.dtype === 'Float64')) {
      return positions.map((i) => (col.isNA(i) ? naRep : (col.data as Float64Array)[i].toFixed(o.floatDecimals)));
    }
    const f = formatColumn(col, positions);
    return f.map((s, i) => (col.isNA(i) ? (col.dtype === 'datetime' ? 'NaT' : naRep) : s));
  });
  const labels = (i: number): Label[] => (idx.isMulti ? [...(idx.labels[i] as readonly Label[])] : [idx.labels[i]]);
  const labelStr = (v: Label) => (v instanceof Date ? formatColumn(Column.from([v]), [0])[0] : formatScalar(v));
  lines.push(`${ind(1)}<tbody>`);
  for (let i = 0; i < n; i++) {
    lines.push(`${ind(2)}<tr>`);
    if (showIndex) {
      const lab = labels(i);
      for (let l = 0; l < lab.length; l++) {
        if (idx.isMulti && sparsify && l < lab.length - 1) {
          const same = (a: number, b: number) => labels(a).slice(0, l + 1).every((p, q) => labelStr(p) === labelStr(labels(b)[q]));
          if (i > 0 && same(i, i - 1)) continue;
          let span = 1;
          while (i + span < n && same(i + span, i)) span++;
          lines.push(`${ind(3)}<th${span > 1 ? ` rowspan="${span}" valign="top"` : ''}>${esc(labelStr(lab[l]))}</th>`);
        } else lines.push(`${ind(3)}<th>${esc(labelStr(lab[l]))}</th>`);
      }
    }
    for (let j = 0; j < keys.length; j++) {
      const attrs = o.cellAttrs ? o.cellAttrs(i, j) : '';
      lines.push(`${ind(3)}<td${attrs}>${link(cells[j][i])}</td>`);
    }
    lines.push(`${ind(2)}</tr>`);
  }
  lines.push(`${ind(1)}</tbody>`);
  lines.push('</table>');
  return lines.join('\n');
}

