/** XML documents: readXml (rows selected by a small XPath subset) and toXml (pandas layout). */
import { Column } from '../core/column.ts';
import { pyFloat } from '../core/interval.ts';
import { formatColumn, formatScalar } from '../core/format.ts';
import { Index } from '../core/indexes.ts';
import type { DType, Label } from '../core/types.ts';
import { DataFrame } from '../frame.ts';
import { DEFAULT_NA_VALUES, inferColumn } from './csv.ts';
import { elementChildren, escapeXml, localName, parseMarkup, textContent, type MNode } from './markup.ts';
import { readText, readTextSync, writeOutput, type Source } from './source.ts';

export interface ReadXmlOptions {
  /** Rows to select (default './*': children of the root). Supports /, //, *, [@a], [@a='v'], [n], [child='v']. */
  xpath?: string;
  /** Prefix → URI map; with it, prefixed names in `xpath` match by local name. */
  namespaces?: Record<string, string>;
  /** Only child elements become columns. */
  elemsOnly?: boolean;
  /** Only attributes become columns. */
  attrsOnly?: boolean;
  names?: readonly string[];
  dtype?: DType | Record<string, DType>;
  parseDates?: readonly string[];
  encoding?: BufferEncoding;
}

interface Step { axis: 'child' | 'descendant'; name: string; preds: string[] }

function parseXpath(xpath: string): { absolute: boolean; steps: Step[] } {
  let p = xpath.trim();
  let absolute = false;
  if (p.startsWith('./')) p = p.slice(1);
  else if (p.startsWith('/')) absolute = true;
  else p = '/' + p;
  const steps: Step[] = [];
  const re = /(\/\/?)([^/[\]]+)((?:\[[^\]]*\])*)/g;
  for (let m = re.exec(p); m; m = re.exec(p)) {
    steps.push({ axis: m[1] === '//' ? 'descendant' : 'child', name: m[2].trim(), preds: [...m[3].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1].trim()) });
  }
  if (!steps.length) throw new Error(`Unsupported xpath: ${xpath}`);
  return { absolute, steps };
}

function nameMatches(node: MNode, name: string, ns: boolean): boolean {
  if (name === '*') return true;
  if (node.tag === name) return true;
  return ns || !name.includes(':') ? localName(node.tag) === localName(name) : false;
}

function predicate(node: MNode, pred: string, position: number): boolean {
  if (/^\d+$/.test(pred)) return position === Number(pred);
  const attr = /^@([\w:.-]+)(?:\s*=\s*(['"])(.*)\2)?$/.exec(pred);
  if (attr) return attr[3] === undefined ? attr[1] in node.attrs : node.attrs[attr[1]] === attr[3];
  const child = /^([\w:.-]+)\s*=\s*(['"])(.*)\2$/.exec(pred);
  if (child) return elementChildren(node).some((c) => localName(c.tag) === localName(child[1]) && textContent(c).trim() === child[3]);
  throw new Error(`Unsupported xpath predicate: [${pred}]`);
}

function select(doc: MNode, xpath: string, ns: boolean): MNode[] {
  const { absolute, steps } = parseXpath(xpath);
  const rootEl = elementChildren(doc)[0];
  if (!rootEl) return [];
  let current: MNode[] = absolute ? [doc] : [rootEl];
  for (const step of steps) {
    const next: MNode[] = [];
    for (const ctx of current) {
      const candidates = step.axis === 'child' ? elementChildren(ctx) : descendants(ctx);
      const matched = candidates.filter((c) => nameMatches(c, step.name, ns));
      matched.forEach((c, k) => { if (step.preds.every((p) => predicate(c, p, k + 1))) next.push(c); });
    }
    current = [...new Set(next)];
  }
  return current;
}

function descendants(n: MNode, out: MNode[] = []): MNode[] {
  for (const c of elementChildren(n)) { out.push(c); descendants(c, out); }
  return out;
}

function parseXml(text: string, o: ReadXmlOptions): DataFrame {
  const doc = parseMarkup(text, 'xml');
  const nodes = select(doc, o.xpath ?? './*', Boolean(o.namespaces));
  if (nodes.length === 0) throw new Error('xpath does not return any nodes');
  const records: Record<string, string | null>[] = nodes.map((node) => {
    const rec: Record<string, string | null> = {};
    if (!o.elemsOnly) for (const [k, v] of Object.entries(node.attrs)) if (!k.startsWith('xmlns')) rec[localName(k)] = v;
    if (!o.attrsOnly) {
      const kids = elementChildren(node);
      for (const c of kids) {
        const t = textContent(c).trim();
        rec[localName(c.tag)] = t === '' && elementChildren(c).length === 0 ? null : t;
      }
      if (kids.length === 0 && Object.keys(node.attrs).length === 0) rec[localName(node.tag)] = textContent(node).trim() || null;
    }
    return rec;
  });
  const names = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const na = new Set(DEFAULT_NA_VALUES);
  const trueSet = new Set(['True', 'true', 'TRUE']), falseSet = new Set(['False', 'false', 'FALSE']);
  const cols = new Map<string, Column>();
  const out = o.names ? [...o.names] : names;
  names.forEach((n, j) => {
    const raw = records.map((r) => r[n] ?? '');
    const forced = typeof o.dtype === 'string' ? o.dtype : o.dtype?.[n];
    let col = inferColumn(raw, na, trueSet, falseSet, forced);
    if (o.parseDates?.includes(n)) col = Column.from(raw.map((v) => (v === '' ? null : v)), 'datetime');
    cols.set(out[j] ?? n, col);
  });
  return DataFrame._fromColumns(cols, Index.range(records.length));
}

/** Parses an XML string or file into a DataFrame, like `pd.read_xml`. */
export function readXml(source: Source, options: ReadXmlOptions = {}): DataFrame {
  return parseXml(readTextSync(source, { encoding: options.encoding, literal: (s) => s.trimStart().startsWith('<') }), options);
}

export async function readXmlAsync(source: Source, options: ReadXmlOptions & { storageOptions?: RequestInit } = {}): Promise<DataFrame> {
  return parseXml(await readText(source, { encoding: options.encoding, storageOptions: options.storageOptions, literal: (s) => s.trimStart().startsWith('<') }), options);
}

// ------------------------------------------------------------------- toXml

export interface ToXmlOptions {
  index?: boolean;
  rootName?: string;
  rowName?: string;
  /** Text for missing values (default: an empty element). */
  naRep?: string;
  /** Columns written as attributes of the row element. */
  attrCols?: readonly string[];
  /** Columns written as child elements (default: all others). */
  elemCols?: readonly string[];
  /** Namespace declarations, e.g. `{ doc: 'https://example.com' }` ('' = default namespace). */
  namespaces?: Record<string, string>;
  /** Prefix applied to every element name. */
  prefix?: string;
  xmlDeclaration?: boolean;
  prettyPrint?: boolean;
  encoding?: string;
}

/** Serialises a frame as XML, matching pandas' `to_xml` layout. */
export function toXml(df: DataFrame, path?: string, o: ToXmlOptions = {}): string {
  const pretty = o.prettyPrint ?? true;
  const nl = pretty ? '\n' : '';
  const ind = (k: number) => (pretty ? '  '.repeat(k) : '');
  const pfx = (name: string) => (o.prefix ? `${o.prefix}:${name}` : name);
  const ns = Object.entries(o.namespaces ?? {}).map(([k, v]) => ` xmlns${k ? ':' + k : ''}="${escapeXml(v, true)}"`).join('');
  const parts: string[] = [];
  if (o.xmlDeclaration ?? true) parts.push(`<?xml version='1.0' encoding='${o.encoding ?? 'utf-8'}'?>`);
  const root = pfx(o.rootName ?? 'data');
  parts.push(`<${root}${ns}>`);
  const keys = df.columns;
  const attrCols = new Set(o.attrCols ?? []);
  const elemCols = o.elemCols ? [...o.elemCols] : keys.filter((k) => !attrCols.has(k));
  const showIndex = o.index ?? true;
  const idxNames = df.index.isMulti ? df.index.names!.map((n, l) => n ?? `level_${l}`) : [df.index.name ?? 'index'];
  const fmt = new Map(keys.map((k) => [k, valueFormatter(df._column(k))]));
  const labelText = (v: Label) => (v instanceof Date ? formatColumn(Column.from([v]), [0])[0] : formatScalar(v));
  const row = pfx(o.rowName ?? 'row');
  for (let i = 0; i < df.length; i++) {
    const attrs = [...attrCols].map((k) => { const v = fmt.get(k)!(i); return v === null ? '' : ` ${k}="${escapeXml(v, true)}"`; }).join('');
    const kids: string[] = [];
    if (showIndex) {
      const lab = df.index.isMulti ? (df.index.labels[i] as readonly Label[]) : [df.index.labels[i]];
      lab.forEach((v, l) => kids.push(`${ind(2)}<${pfx(idxNames[l])}>${escapeXml(labelText(v))}</${pfx(idxNames[l])}>`));
    }
    for (const k of elemCols) {
      const v = fmt.get(k)!(i);
      const tag = pfx(k);
      if (v === null) kids.push(o.naRep !== undefined ? `${ind(2)}<${tag}>${escapeXml(o.naRep)}</${tag}>` : `${ind(2)}<${tag}/>`);
      else kids.push(`${ind(2)}<${tag}>${escapeXml(v)}</${tag}>`);
    }
    parts.push(kids.length ? `${ind(1)}<${row}${attrs}>${nl}${kids.join(nl)}${nl}${ind(1)}</${row}>` : `${ind(1)}<${row}${attrs}/>`);
  }
  parts.push(`</${root}>`);
  const xml = parts.join(nl);
  if (path) writeOutput(path, xml);
  return xml;
}

function valueFormatter(col: Column): (i: number) => string | null {
  if (col.dtype === 'float64' || col.dtype === 'Float64') return (i) => (col.isNA(i) ? null : pyFloat((col.data as Float64Array)[i]));
  if (col.dtype === 'bool' || col.dtype === 'boolean') return (i) => (col.isNA(i) ? null : col.get(i) ? 'True' : 'False');
  if (col.dtype === 'datetime') {
    const all = Array.from({ length: col.length }, (_, i) => i);
    const f = formatColumn(new Column('datetime', col.data, { ...col.meta }), all);
    return (i) => (col.isNA(i) ? null : f[i].length === 10 ? `${f[i]} 00:00:00` : f[i]);
  }
  return (i) => (col.isNA(i) ? null : formatScalar(col.get(i)));
}
