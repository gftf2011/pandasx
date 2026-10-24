/** Combining objects: explode, combineFirst, update, compare, mergeAsof, mergeOrdered. */
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { parseTimedelta, Timedelta } from './core/time.ts';
import type { Label } from './core/types.ts';
import { hashKey, isNA, valuesEqual } from './core/values.ts';
import { DataFrame } from './frame.ts';
import { merge } from './reshape.ts';
import { Series } from './series.ts';

// ------------------------------------------------------------------ explode

const isListLike = (v: unknown): v is ArrayLike<unknown> | Iterable<unknown> =>
  Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof Set;

/** Row positions + element values after expanding list-likes (empty → one NA row). */
function explodePositions(values: readonly unknown[]): { pos: number[]; vals: unknown[] } {
  const pos: number[] = [], vals: unknown[] = [];
  values.forEach((v, i) => {
    if (isListLike(v)) {
      const items = [...(v as Iterable<unknown>)];
      if (items.length === 0) { pos.push(i); vals.push(null); }
      for (const it of items) { pos.push(i); vals.push(it); }
    } else { pos.push(i); vals.push(v); }
  });
  return { pos, vals };
}

export function explodeSeries(s: Series, ignoreIndex = false): Series {
  const { pos, vals } = explodePositions(s.toArray());
  return Series._from(Column.from(vals), ignoreIndex ? Index.range(pos.length) : s.index.take(pos), s.name);
}

/** Expands list-like cells of `columns` into rows (several columns must have matching lengths). */
export function explodeFrame(df: DataFrame, columns: string | readonly string[], ignoreIndex = false): DataFrame {
  const names = typeof columns === 'string' ? [columns] : [...columns];
  const first = explodePositions(df._column(names[0]).toArray());
  const exploded = new Map<string, unknown[]>([[names[0], first.vals]]);
  for (const c of names.slice(1)) {
    const e = explodePositions(df._column(c).toArray());
    if (e.pos.length !== first.pos.length || e.pos.some((p, k) => p !== first.pos[k])) throw new Error('columns must have matching element counts');
    exploded.set(c, e.vals);
  }
  const cols = new Map<string, Column>();
  for (const k of df.columns) cols.set(k, exploded.has(k) ? Column.from(exploded.get(k)!) : df._column(k).take(first.pos));
  return DataFrame._fromColumns(cols, ignoreIndex ? Index.range(first.pos.length) : df.index.take(first.pos), df._colNames);
}

// ------------------------------------------------------------ combineFirst

function unionIndex(a: Index, b: Index): Index {
  return a.equals(b) ? a : a.union(b);
}

/** Values of `a`, with its missing values (and missing labels) filled from `b`. */
export function combineFirst<T extends Series | DataFrame>(a: T, b: T): T {
  const index = unionIndex(a.index, b.index);
  if (a instanceof Series && b instanceof Series) {
    const x = a.reindex(index), y = b.reindex(index);
    return Series._from(x._col.mapLike((v, i) => (isNA(v) ? y._col.get(i) : v)), index, a.name) as T;
  }
  const A = a as DataFrame, B = b as DataFrame;
  const names = [...new Set([...A.columns, ...B.columns])];
  const cols = new Map<string, Column>();
  for (const n of names) {
    const x = A.has(n) ? A.get(n).reindex(index) : null;
    const y = B.has(n) ? B.get(n).reindex(index) : null;
    if (!x) { cols.set(n, y!._col); continue; }
    if (!y) { cols.set(n, x._col); continue; }
    cols.set(n, x._col.mapLike((v, i) => (isNA(v) ? y._col.get(i) : v)));
  }
  return DataFrame._fromColumns(cols, index) as T;
}

/**
 * In-place update of `target` with the non-NA values of `other`, aligned on
 * labels (no new rows/columns). With `overwrite: false` only NA cells change.
 */
export function update(target: Series | DataFrame, other: Series | DataFrame, o: { overwrite?: boolean; filterFunc?: (v: unknown) => boolean } = {}): void {
  const overwrite = o.overwrite ?? true;
  const apply = (dst: Series, src: Series) => {
    const aligned = src.index.equals(dst.index) ? src : src.reindex(dst.index);
    const pos: number[] = [];
    for (let i = 0; i < dst.length; i++) {
      const v = aligned._col.get(i);
      if (isNA(v)) continue;
      if (!overwrite && !dst._col.isNA(i)) continue;
      if (o.filterFunc && !o.filterFunc(dst._col.get(i))) continue;
      pos.push(i);
    }
    if (pos.length) dst.setIloc(pos, pos.map((p) => aligned._col.get(p)));
    return dst;
  };
  if (target instanceof Series) {
    const src = other instanceof Series ? other : other.get(other.columns[0]);
    apply(target, src);
    return;
  }
  const srcFrame = other instanceof Series ? other.toFrame() : other;
  for (const c of target.columns) {
    if (!srcFrame.has(c)) continue;
    target.set(c, apply(target.get(c), srcFrame.get(c)));
  }
}

/**
 * Differences between two same-labelled objects. Frames give MultiIndex columns
 * (column, 'self' / 'other'); unchanged cells are NA unless `keepEqual`.
 */
export function compare(a: Series | DataFrame, b: Series | DataFrame, o: { keepShape?: boolean; keepEqual?: boolean; resultNames?: [string, string] } = {}): DataFrame {
  if (!a.index.equals(b.index)) throw new Error('Can only compare identically-labeled objects');
  const [selfName, otherName] = o.resultNames ?? ['self', 'other'];
  const pairs: [string, Series, Series][] = a instanceof Series
    ? [['', a, b as Series]]
    : (a as DataFrame).columns.map((c) => {
      if (!(b as DataFrame).has(c)) throw new Error('Can only compare identically-labeled objects');
      return [c, (a as DataFrame).get(c), (b as DataFrame).get(c)];
    });
  const n = a.length;
  const diff = pairs.map(([, x, y]) => Array.from({ length: n }, (_, i) => {
    const u = x._col.get(i), v = y._col.get(i);
    return !(isNA(u) && isNA(v)) && !valuesEqual(u, v);
  }));
  const rows = o.keepShape ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: n }, (_, i) => i).filter((i) => diff.some((d) => d[i]));
  const keepCols = pairs.map((_, j) => o.keepShape || rows.some((i) => diff[j][i]));
  const cols: [Label[], Column][] = [];
  pairs.forEach(([name, x, y], j) => {
    if (!keepCols[j]) return;
    const pick = (s: Series) => Column.fromLike(rows.map((i) => (diff[j][i] || o.keepEqual ? s._col.get(i) : null)), s._col);
    if (a instanceof Series) { cols.push([[selfName], pick(x)], [[otherName], pick(y)]); return; }
    cols.push([[name, selfName], pick(x)], [[name, otherName], pick(y)]);
  });
  const index = a.index.take(rows);
  if (a instanceof Series) return DataFrame._fromColumns(new Map(cols.map(([t, c]) => [String(t[0]), c])), index);
  return DataFrame._fromTupleColumns(cols, index);
}

// ---------------------------------------------------------------- mergeAsof

export interface MergeAsofOptions {
  on?: string;
  leftOn?: string;
  rightOn?: string;
  /** Exact-match columns, matched before the nearest key. */
  by?: string | readonly string[];
  leftBy?: string | readonly string[];
  rightBy?: string | readonly string[];
  /** 'backward' (default): last right key <= left key; 'forward'; 'nearest'. */
  direction?: 'backward' | 'forward' | 'nearest';
  /** Maximum distance (number, or Timedelta / '2s' for datetime keys). */
  tolerance?: number | string | Timedelta;
  allowExactMatches?: boolean;
  suffixes?: readonly [string, string];
}

const keyNumbers = (c: Column): Float64Array => {
  if (c.dtype === 'datetime' || c.dtype === 'timedelta' || c.dtype === 'float64' || c.dtype === 'int64' || c.dtype === 'Int64' || c.dtype === 'Float64') return c.data as Float64Array;
  return Float64Array.from(c.toArray(), (v) => (isNA(v) ? NaN : Number(v)));
};

/** Ordered nearest-key join, like `pd.merge_asof` (both frames sorted by the key). */
export function mergeAsof(left: DataFrame, right: DataFrame, o: MergeAsofOptions): DataFrame {
  const lk = o.leftOn ?? o.on, rk = o.rightOn ?? o.on;
  if (!lk || !rk) throw new Error('mergeAsof needs `on` (or `leftOn` and `rightOn`)');
  const lb = typeof (o.leftBy ?? o.by) === 'string' ? [(o.leftBy ?? o.by) as string] : [...((o.leftBy ?? o.by ?? []) as readonly string[])];
  const rb = typeof (o.rightBy ?? o.by) === 'string' ? [(o.rightBy ?? o.by) as string] : [...((o.rightBy ?? o.by ?? []) as readonly string[])];
  const lx = keyNumbers(left._column(lk)), rx = keyNumbers(right._column(rk));
  for (const [x, side] of [[lx, 'left'], [rx, 'right']] as const) {
    for (let i = 1; i < x.length; i++) if (x[i] < x[i - 1]) throw new Error(`${side} keys must be sorted`);
  }
  const tol = o.tolerance === undefined ? Infinity : typeof o.tolerance === 'number' ? o.tolerance : o.tolerance instanceof Timedelta ? o.tolerance.ms : parseTimedelta(o.tolerance);
  const exact = o.allowExactMatches ?? true;
  const direction = o.direction ?? 'backward';
  const groupKey = (df: DataFrame, cols: string[], i: number) => hashKey(cols.map((c) => df._column(c).get(i)));
  const rightGroups = new Map<unknown, number[]>();
  for (let j = 0; j < right.length; j++) {
    const k = rb.length ? groupKey(right, rb, j) : null;
    rightGroups.set(k, [...(rightGroups.get(k) ?? []), j]);
  }
  const match = new Int32Array(left.length).fill(-1);
  for (let i = 0; i < left.length; i++) {
    const x = lx[i];
    if (x !== x) continue;
    const cand = rightGroups.get(lb.length ? groupKey(left, lb, i) : null) ?? [];
    let back = -1, fwd = -1;
    let lo = 0, hi = cand.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (exact ? rx[cand[m]] <= x : rx[cand[m]] < x) lo = m + 1; else hi = m; }
    if (lo > 0) back = cand[lo - 1];
    lo = 0; hi = cand.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (exact ? rx[cand[m]] < x : rx[cand[m]] <= x) lo = m + 1; else hi = m; }
    if (lo < cand.length) fwd = cand[lo];
    let pick = -1;
    if (direction === 'backward') pick = back;
    else if (direction === 'forward') pick = fwd;
    else if (back < 0) pick = fwd;
    else if (fwd < 0) pick = back;
    else pick = x - rx[back] <= rx[fwd] - x ? back : fwd;
    if (pick >= 0 && Math.abs(rx[pick] - x) <= tol) match[i] = pick;
  }
  const [sx, sy] = o.suffixes ?? ['_x', '_y'];
  const skip = new Set([...(lk === rk ? [rk] : []), ...rb.filter((c, k) => c === lb[k])]);
  const rightCols = right.columns.filter((c) => !skip.has(c));
  const overlap = new Set(left.columns.filter((c) => rightCols.includes(c)));
  const cols = new Map<string, Column>();
  for (const c of left.columns) cols.set(overlap.has(c) ? c + sx : c, left._column(c));
  for (const c of rightCols) cols.set(overlap.has(c) ? c + sy : c, right._column(c).take(match));
  return DataFrame._fromColumns(cols, Index.range(left.length));
}

/** Ordered outer merge with optional forward fill, like `pd.merge_ordered`. */
export function mergeOrdered(left: DataFrame, right: DataFrame, o: { on?: string | readonly string[]; leftOn?: string | readonly string[]; rightOn?: string | readonly string[]; fillMethod?: 'ffill'; how?: 'outer' | 'inner' | 'left' | 'right'; suffixes?: readonly [string, string] } = {}): DataFrame {
  let out = merge(left, right, { on: o.on, leftOn: o.leftOn, rightOn: o.rightOn, how: o.how ?? 'outer', suffixes: o.suffixes, sort: true });
  if (o.fillMethod === 'ffill') out = out.ffill();
  return out;
}

