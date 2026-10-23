/** Aggregating reshapes and encodings: pivotTable, crosstab, getDummies, cut/qcut, factorize, wideToLong. */
import { aggregate, NUMERIC_AGGS, quantile } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { Interval, type IntervalClosed } from './core/interval.ts';
import { isNumericDType, type AggName, type DType, type Label } from './core/types.ts';
import { compareValues, hashKey, isNA } from './core/values.ts';
import { DataFrame } from './frame.ts';
import { computeGroups } from './groupby.ts';
import { numericView, Series, type AggFunc } from './series.ts';

/** Aggregation for pivotTable / crosstab: any AggFunc, or 'len'. */
export type PivotAggFunc = AggFunc | 'len';

const list = <T>(v: T | readonly T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...v] : [v as T]);
const fname = (f: PivotAggFunc, i: number) => (typeof f === 'function' ? f.name || `func${i}` : f);

export interface PivotTableOptions {
  index: string | readonly string[];
  columns?: string | readonly string[];
  values?: string | readonly string[];
  /** Aggregation: name, function, list of them, or `{value: func | func[]}` (default 'mean'). */
  aggfunc?: PivotAggFunc | readonly PivotAggFunc[] | Record<string, PivotAggFunc | readonly PivotAggFunc[]>;
  /** Value for missing cells. */
  fillValue?: unknown;
  /** Add row and column totals named `marginsName` ('All'). */
  margins?: boolean;
  marginsName?: string;
  /** Drop columns whose entries are all NA, and rows with NA keys (default true). */
  dropna?: boolean;
}

interface Measure { value: string; func: PivotAggFunc; label: string[] }

/** Spreadsheet-style pivot table, like `pd.pivot_table`. */
export function pivotTable(df: DataFrame, o: PivotTableOptions): DataFrame {
  const idx = list(o.index);
  const cols = list(o.columns);
  if (idx.length === 0) throw new Error('pivotTable needs at least one `index` key');
  const aggfunc = o.aggfunc ?? 'mean';
  const dropna = o.dropna ?? true;
  const marginsName = o.marginsName ?? 'All';
  const isNumericAgg = (f: PivotAggFunc) => typeof f === 'string' && NUMERIC_AGGS.has(f as AggName);
  const candidates = df.columns.filter((c) => !idx.includes(c) && !cols.includes(c));
  const allFuncs = Array.isArray(aggfunc) ? aggfunc : typeof aggfunc === 'object' ? Object.values(aggfunc).flat() : [aggfunc];
  // pandas orders the value columns by name.
  const values = (o.values !== undefined ? list(o.values) : typeof aggfunc === 'object' && !Array.isArray(aggfunc) ? Object.keys(aggfunc)
    : candidates.filter((c) => !allFuncs.some(isNumericAgg) || isNumericDType(df._column(c).dtype))).sort();

  const measures: Measure[] = [];
  if (Array.isArray(aggfunc)) (aggfunc as readonly PivotAggFunc[]).forEach((f, i) => values.forEach((v) => measures.push({ value: v, func: f, label: [fname(f, i), v] })));
  else if (typeof aggfunc === 'object') {
    for (const v of values) {
      const f = (aggfunc as Record<string, PivotAggFunc | readonly PivotAggFunc[]>)[v];
      if (f === undefined) continue;
      if (Array.isArray(f)) (f as readonly PivotAggFunc[]).forEach((g, i) => measures.push({ value: v, func: g, label: [v, fname(g, i)] }));
      else measures.push({ value: v, func: f as PivotAggFunc, label: [v] });
    }
  } else values.forEach((v) => measures.push({ value: v, func: aggfunc as PivotAggFunc, label: [v] }));
  const dropValueLevel = typeof o.values === 'string' && !Array.isArray(aggfunc) && typeof aggfunc !== 'object';

  // Group rows by the full key; margins reuse unions of these groups.
  const keyCols = [...idx, ...cols].map((k) => df._column(k));
  const groups = computeGroups(keyCols, df.length, true, dropna);
  const rowKeyOf = (k: Label[]) => k.slice(0, idx.length);
  const colKeyOf = (k: Label[]) => k.slice(idx.length);
  const uniq = (ks: Label[][]) => {
    const m = new Map<unknown, Label[]>();
    for (const k of ks) m.set(hashKey(k), k);
    return [...m.values()].sort(compareValues);
  };
  const rowKeys = uniq(groups.keys.map(rowKeyOf));
  const colKeys = cols.length ? uniq(groups.keys.map(colKeyOf)) : [[]];
  const cell = new Map<string, number[]>();
  const byRow = new Map<unknown, number[]>(), byCol = new Map<unknown, number[]>();
  const all: number[] = [];
  groups.keys.forEach((k, g) => {
    const rows = groups.rows[g];
    cell.set(`${String(hashKey(rowKeyOf(k)))}|${String(hashKey(colKeyOf(k)))}`, rows);
    const rk = hashKey(rowKeyOf(k)), ck = hashKey(colKeyOf(k));
    byRow.set(rk, [...(byRow.get(rk) ?? []), ...rows]);
    byCol.set(ck, [...(byCol.get(ck) ?? []), ...rows]);
    all.push(...rows);
  });
  const evaluate = (m: Measure, rows: number[] | undefined): unknown => {
    if (!rows || rows.length === 0) return NaN;
    const col = df._column(m.value);
    if (typeof m.func === 'function') return m.func(Series._from(col.take(rows), df.index.take(rows), m.value));
    if (m.func === 'len') return rows.length;
    return aggregate(col, m.func, rows);
  };

  const marginRow: Label[] = [marginsName, ...new Array(idx.length - 1).fill('')];
  const marginCol: Label[] = cols.length ? [marginsName, ...new Array(cols.length - 1).fill('')] : [];
  const outRows = o.margins ? [...rowKeys, marginRow] : rowKeys;
  const outCols: [string[], Column][] = [];
  for (const m of measures) {
    const colList = o.margins && cols.length ? [...colKeys, marginCol] : colKeys;
    for (const ck of colList) {
      const isMarginCol = o.margins && cols.length > 0 && ck === marginCol;
      const vals = outRows.map((rk) => {
        const isMarginRow = o.margins && rk === marginRow;
        let rows: number[] | undefined;
        if (isMarginRow && (isMarginCol || !cols.length)) rows = all;
        else if (isMarginRow) rows = byCol.get(hashKey(ck));
        else if (isMarginCol) rows = byRow.get(hashKey(rk));
        else rows = cols.length ? cell.get(`${String(hashKey(rk))}|${String(hashKey(ck))}`) : byRow.get(hashKey(rk));
        const v = evaluate(m, rows);
        return isNA(v) && o.fillValue !== undefined ? o.fillValue : v;
      });
      if (dropna && !isMarginCol && vals.every(isNA)) continue;
      const label = [...(dropValueLevel ? [] : m.label), ...ck.map((p) => (p === null ? '' : String(p)))];
      outCols.push([label.length ? label : [m.value], Column.from(vals)]);
    }
  }
  const index = idx.length === 1 ? new Index(outRows.map((r) => r[0]), { name: idx[0] }) : new Index(outRows, { names: idx });
  const levelNames = [...(dropValueLevel ? [] : new Array(measures[0]?.label.length ?? 1).fill(null)), ...cols];
  if ((outCols[0]?.[0].length ?? 1) <= 1) {
    return DataFrame._fromColumns(new Map(outCols.map(([t, c]) => [t[0], c])), index, cols.length === 1 && dropValueLevel ? [cols[0]] : null);
  }
  return DataFrame._fromTupleColumns(outCols, index, levelNames);
}

export interface CrosstabOptions {
  values?: Series | readonly unknown[];
  aggfunc?: PivotAggFunc;
  rownames?: readonly string[];
  colnames?: readonly string[];
  margins?: boolean;
  marginsName?: string;
  /** Divide by the grand total (true / 'all'), row totals ('index') or column totals ('columns'). */
  normalize?: boolean | 'all' | 'index' | 'columns';
  dropna?: boolean;
}

/** A crosstab factor: a Series or an array of values. */
export type Factor = Series | readonly unknown[];

/** Frequency table of two (or more) factors, like `pd.crosstab`. */
export function crosstab(index: Factor | readonly Factor[], columns: Factor | readonly Factor[], o: CrosstabOptions = {}): DataFrame {
  const asList = (f: Factor | readonly Factor[]): Factor[] => (f instanceof Series || !Array.isArray(f) || !(f[0] instanceof Series || Array.isArray(f[0])) ? [f as Factor] : [...(f as readonly Factor[])]);
  const rows = asList(index), cols = asList(columns);
  const names = (fs: Factor[], given: readonly string[] | undefined, prefix: string) =>
    fs.map((f, i) => given?.[i] ?? (f instanceof Series && f.name !== null ? f.name : `${prefix}_${i}`));
  const rn = names(rows, o.rownames, 'row');
  const cn = names(cols, o.colnames, 'col');
  const data: Record<string, unknown> = {};
  [...rows, ...cols].forEach((f, i) => (data[[...rn, ...cn][i]] = f instanceof Series ? f.toArray() : [...f]));
  data['\u0000v'] = o.values ? (o.values instanceof Series ? o.values.toArray() : [...o.values]) : new Array(rows[0].length).fill(1);
  const frame = new DataFrame(data);
  const normalize = o.normalize === true ? 'all' : o.normalize || null;
  const table = pivotTable(frame, {
    index: rn, columns: cn, values: '\u0000v', aggfunc: o.values ? (o.aggfunc ?? 'sum') : 'size',
    fillValue: o.values ? undefined : 0, margins: o.margins && !normalize, marginsName: o.marginsName, dropna: o.dropna ?? true,
  });
  if (!normalize) return table;
  const keys = table.columns;
  const data2 = keys.map((k) => Float64Array.from(numericView(table._column(k))));
  const rowSums = Array.from({ length: table.length }, (_, i) => data2.reduce((s, c) => s + c[i], 0));
  const colSums = data2.map((c) => c.reduce((a, b) => a + b, 0));
  const total = colSums.reduce((a, b) => a + b, 0);
  const out = new Map<string, Column>();
  keys.forEach((k, j) => out.set(k, new Column('float64', data2[j].map((v, i) => v / (normalize === 'index' ? rowSums[i] : normalize === 'columns' ? colSums[j] : total)))));
  let result = DataFrame._fromColumns(out, table.index, table._colNames);
  if (o.margins) {
    const name = o.marginsName ?? 'All';
    if (normalize !== 'columns') {
      const row = keys.map((_, j) => colSums[j] / total);
      result = appendRow(result, name, row);
    }
    if (normalize !== 'index') {
      const vals = Array.from({ length: result.length }, (_, i) => (i < table.length ? rowSums[i] / total : 1));
      result.set(name, vals);
    }
  }
  return result;
}

function appendRow(df: DataFrame, label: Label, values: readonly unknown[]): DataFrame {
  const grow = Int32Array.from({ length: df.length + 1 }, (_, i) => (i < df.length ? i : -1));
  const cols = new Map<string, Column>();
  df.columns.forEach((k, j) => {
    const c = df._column(k).take(grow);
    cols.set(k, c.setAt([df.length], () => values[j]));
  });
  const lab = df.index.isMulti ? [label, ...new Array(df.index.nlevels - 1).fill('')] : label;
  return DataFrame._fromColumns(cols, new Index([...df.index.labels, lab as Label], { name: df.index.name, names: df.index.names }), df._colNames);
}

// -------------------------------------------------------------- getDummies

export interface DummiesOptions {
  /** Column name prefix(es); defaults to the source column name for frames. */
  prefix?: string | readonly string[] | Record<string, string>;
  prefixSep?: string;
  /** Add a column for missing values. */
  dummyNa?: boolean;
  /** Columns to encode (default: string, object and category columns). */
  columns?: readonly string[];
  /** Drop the first level of each variable. */
  dropFirst?: boolean;
  /** Output dtype (default 'bool', like pandas 2+). */
  dtype?: DType;
}

function dummyColumns(s: Series, prefix: string | null, sep: string, o: DummiesOptions): [string, Column][] {
  const vals = s.toArray();
  let levels: unknown[] = s.dtype === 'category' ? [...s._col.meta.categories!] : [...new Map(vals.filter((v) => !isNA(v)).map((v) => [hashKey(v), v])).values()].sort(compareValues);
  if (o.dropFirst) levels = levels.slice(1);
  const dtype = o.dtype ?? 'bool';
  const out: [string, Column][] = levels.map((lv) => {
    const k = hashKey(lv);
    return [prefix === null ? String(lv) : `${prefix}${sep}${String(lv)}`, Column.from(vals.map((v) => hashKey(v) === k), dtype)];
  });
  if (o.dummyNa) out.push([prefix === null ? 'nan' : `${prefix}${sep}nan`, Column.from(vals.map(isNA), dtype)]);
  return out;
}

/** One-hot encoding, like `pd.get_dummies`. */
export function getDummies(data: Series | DataFrame, o: DummiesOptions = {}): DataFrame {
  const sep = o.prefixSep ?? '_';
  if (data instanceof Series) {
    const prefix = typeof o.prefix === 'string' ? o.prefix : null;
    return DataFrame._fromColumns(new Map(dummyColumns(data, prefix, sep, o)), data.index);
  }
  const encode = o.columns ?? data.columns.filter((c) => ['string', 'object', 'category'].includes(data._column(c).dtype));
  const cols = new Map<string, Column>();
  // Like pandas: untouched columns first, then the dummies.
  for (const c of data.columns) if (!encode.includes(c)) cols.set(c, data._column(c));
  for (const c of data.columns) {
    if (!encode.includes(c)) continue;
    const i = encode.indexOf(c);
    const p = o.prefix === undefined ? c : typeof o.prefix === 'string' ? o.prefix : Array.isArray(o.prefix) ? o.prefix[i] : (o.prefix as Record<string, string>)[c] ?? c;
    for (const [k, col] of dummyColumns(data.get(c), p, sep, o)) cols.set(k, col);
  }
  return DataFrame._fromColumns(cols, data.index);
}

/** Inverse of getDummies: one categorical column per prefix. */
export function fromDummies(df: DataFrame, o: { sep?: string; defaultCategory?: unknown } = {}): DataFrame {
  const groups = new Map<string | null, [string, string][]>();
  for (const c of df.columns) {
    const i = o.sep ? c.indexOf(o.sep) : -1;
    const [prefix, level] = i < 0 ? [null, c] : [c.slice(0, i), c.slice(i + o.sep!.length)];
    groups.set(prefix, [...(groups.get(prefix) ?? []), [c, level]]);
  }
  const cols = new Map<string, Column>();
  for (const [prefix, members] of groups) {
    const vals = Array.from({ length: df.length }, (_, r) => {
      const hits = members.filter(([c]) => Boolean(df._column(c).get(r)));
      if (hits.length > 1) throw new Error(`Dummy DataFrame contains multi-assignment in row ${r}`);
      if (hits.length === 0) {
        if (o.defaultCategory === undefined) throw new Error(`Dummy DataFrame contains unassigned value in row ${r}`);
        return o.defaultCategory;
      }
      return hits[0][1];
    });
    cols.set(prefix ?? '', Column.from(vals));
  }
  return DataFrame._fromColumns(cols, df.index);
}

// ------------------------------------------------------------------- cut

export interface CutOptions {
  /** Intervals closed on the right (default true). */
  right?: boolean;
  /** Labels for the bins, or false for integer codes. */
  labels?: readonly unknown[] | false;
  /** Include the lowest edge in the first bin. */
  includeLowest?: boolean;
  /** Decimal precision of generated bin labels (default 3). */
  precision?: number;
  /** 'raise' (default) or 'drop' duplicate edges. */
  duplicates?: 'raise' | 'drop';
  ordered?: boolean;
}

/** pandas' `_round_frac`: round to `precision` significant digits after the leading zeros. */
function roundFrac(x: number, precision: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const whole = Math.trunc(x);
  const frac = x - whole;
  const digits = whole === 0 ? -Math.floor(Math.log10(Math.abs(frac))) - 1 + precision : precision;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Bins values into intervals, like `pd.cut`. Returns a categorical Series of Intervals (or labels / codes). */
export function cut(x: Series | readonly unknown[], bins: number | readonly number[], o: CutOptions = {}): Series {
  const s = x instanceof Series ? x : new Series([...x]);
  const v = Float64Array.from(numericView(s._col, 'cut'));
  const right = o.right ?? true;
  let edges: number[];
  let userInts = false;
  if (typeof bins === 'number') {
    const valid = Array.from(v).filter((a) => a === a);
    let mn = Math.min(...valid), mx = Math.max(...valid);
    if (mn === mx) { mn -= 0.001 * Math.abs(mn || 1); mx += 0.001 * Math.abs(mx || 1); edges = Array.from({ length: bins + 1 }, (_, i) => mn + ((mx - mn) * i) / bins); }
    else {
      edges = Array.from({ length: bins + 1 }, (_, i) => mn + ((mx - mn) * i) / bins);
      const adj = (mx - mn) * 0.001;
      if (right) edges[0] -= adj; else edges[bins] += adj;
    }
  } else {
    edges = [...bins];
    userInts = edges.every(Number.isInteger);
    for (let i = 1; i < edges.length; i++) if (edges[i] < edges[i - 1]) throw new Error('bins must increase monotonically');
  }
  return binValues(s, v, edges, { ...o, right }, userInts);
}

function binValues(s: Series, v: Float64Array, edgesIn: number[], o: CutOptions & { right: boolean }, userInts: boolean): Series {
  let edges = edgesIn;
  if (new Set(edges).size !== edges.length) {
    if (o.duplicates !== 'drop') throw new Error('Bin edges must be unique; pass duplicates: "drop"');
    edges = [...new Set(edges)];
  }
  const n = edges.length - 1;
  const closed: IntervalClosed = o.right ? 'right' : 'left';
  const codes = new Int32Array(v.length).fill(-1);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x !== x) continue;
    for (let b = 0; b < n; b++) {
      const lo = edges[b], hi = edges[b + 1];
      const inBin = o.right ? (x > lo || (o.includeLowest && b === 0 && x === lo)) && x <= hi : x >= lo && (x < hi || (o.includeLowest && b === n - 1 && x === hi));
      if (inBin) { codes[i] = b; break; }
    }
  }
  if (o.labels === false) {
    return Series._from(new Column(codes.some((c) => c < 0) ? 'float64' : 'int64', Float64Array.from(codes, (c) => (c < 0 ? NaN : c))), s.index, s.name);
  }
  let categories: unknown[];
  if (o.labels) {
    if (o.labels.length !== n) throw new Error('Bin labels must be one fewer than the number of bin edges');
    categories = [...o.labels];
  } else {
    const p = o.precision ?? 3;
    const shown = userInts ? [...edges] : edges.map((e) => roundFrac(e, p));
    // pandas widens the first label when it is right-closed but includes its left edge.
    const widen = Boolean(o.includeLowest && o.right);
    if (widen) shown[0] = roundFrac(shown[0] - 10 ** -p, p + 3);
    // pandas prints integer bounds only for right-closed bins without include_lowest.
    categories = Array.from({ length: n }, (_, b) => new Interval(shown[b], shown[b + 1], closed, { integerBounds: userInts && o.right && !widen }));
  }
  return Series._from(new Column('category', codes, { categories, ordered: o.ordered ?? true }), s.index, s.name);
}

/** Quantile-based bins, like `pd.qcut`. `q` is a count or the quantiles. */
export function qcut(x: Series | readonly unknown[], q: number | readonly number[], o: Omit<CutOptions, 'right' | 'includeLowest'> = {}): Series {
  const s = x instanceof Series ? x : new Series([...x]);
  const col = Column.from(numericView(s._col, 'qcut'), 'float64');
  const qs = typeof q === 'number' ? Array.from({ length: q + 1 }, (_, i) => i / q) : [...q];
  const edges = qs.map((p) => quantile(col, p));
  return binValues(s, col.data as Float64Array, edges, { ...o, right: true, includeLowest: true }, false);
}

/** Fixed-width intervals, like `pd.interval_range`. */
export function intervalRange(start: number, options: { end?: number; periods?: number; freq?: number; closed?: IntervalClosed } = {}): Index {
  const freq = options.freq ?? (options.end !== undefined && options.periods ? (options.end - start) / options.periods : 1);
  const periods = options.periods ?? Math.round(((options.end ?? start) - start) / freq);
  const ints = [start, freq].every(Number.isInteger);
  return new Index(Array.from({ length: periods }, (_, i) => new Interval(start + i * freq, start + (i + 1) * freq, options.closed ?? 'right', { integerBounds: ints })));
}

// --------------------------------------------------------------- factorize

/** Integer codes and unique values (NA → -1), like `pd.factorize`. */
export function factorize(values: Series | readonly unknown[], options: { sort?: boolean } = {}): [number[], unknown[]] {
  const arr = values instanceof Series ? values.toArray() : [...values];
  let uniques = [...new Map(arr.filter((v) => !isNA(v)).map((v) => [hashKey(v), v])).values()];
  if (options.sort) uniques = uniques.sort(compareValues);
  const pos = new Map(uniques.map((u, i) => [hashKey(u), i]));
  return [arr.map((v) => (isNA(v) ? -1 : pos.get(hashKey(v))!)), uniques];
}

/** Unique values in order of appearance, like `pd.unique`. */
export function unique(values: Series | readonly unknown[]): unknown[] {
  const arr = values instanceof Series ? values.toArray() : [...values];
  return [...new Map(arr.map((v) => [hashKey(v), v])).values()];
}

// -------------------------------------------------------------- wideToLong

/** Wide → long by column stub names, like `pd.wide_to_long`. */
export function wideToLong(df: DataFrame, stubnames: string | readonly string[], i: string | readonly string[], j: string, o: { sep?: string; suffix?: string } = {}): DataFrame {
  const stubs = list(stubnames);
  const ids = list(i);
  const sep = o.sep ?? '';
  const suffix = new RegExp(`^${o.suffix ?? '\\d+'}$`);
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffixes = new Map<unknown, string>();
  const stubCols = new Map<string, Map<string, string>>(stubs.map((st) => [st, new Map()]));
  for (const c of df.columns) {
    for (const st of stubs) {
      const m = new RegExp(`^${esc(st)}${esc(sep)}(.+)$`).exec(c);
      if (m && suffix.test(m[1])) { stubCols.get(st)!.set(m[1], c); suffixes.set(m[1], m[1]); }
    }
  }
  const sfx = [...suffixes.values()].sort((a, b) => compareValues(/^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a, /^-?\d+(\.\d+)?$/.test(b) ? Number(b) : b));
  const used = new Set([...stubCols.values()].flatMap((m) => [...m.values()]));
  const others = df.columns.filter((c) => !used.has(c) && !ids.includes(c));
  const tuples: Label[][] = [];
  const out = new Map<string, unknown[]>([...others, ...stubs].map((c) => [c, []]));
  for (const x of sfx) {
    for (let r = 0; r < df.length; r++) {
      tuples.push([...ids.map((id) => df._column(id).get(r) as Label), /^-?\d+$/.test(x) ? Number(x) : x]);
      for (const c of others) out.get(c)!.push(df._column(c).get(r));
      for (const st of stubs) { const c = stubCols.get(st)!.get(x); out.get(st)!.push(c ? df._column(c).get(r) : null); }
    }
  }
  const cols = new Map([...out].map(([k, v]) => [k, Column.from(v)]));
  return DataFrame._fromColumns(cols, new Index(tuples, { names: [...ids, j] }));
}
