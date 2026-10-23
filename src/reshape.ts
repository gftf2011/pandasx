import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { argsort, sortKeyFromColumn } from './core/sort.ts';
import type { Label } from './core/types.ts';
import { hashKey } from './core/values.ts';
import { DataFrame } from './frame.ts';
import { Series } from './series.ts';

export interface ConcatOptions {
  /** 0 stacks rows (default), 1 places side by side aligned on the index. */
  axis?: 0 | 1 | 'index' | 'columns';
  /** 'outer' keeps all columns/labels (default), 'inner' only shared ones. */
  join?: 'outer' | 'inner';
  /** Discard the original indexes and number rows 0..n-1. */
  ignoreIndex?: boolean;
}

/** Concatenates Series or DataFrames along an axis, like `pandas.concat`. */
export function concat(objs: readonly Series[], options?: ConcatOptions & { axis?: 0 | 'index' }): Series;
export function concat(objs: readonly (DataFrame | Series)[], options?: ConcatOptions): DataFrame;
export function concat(objs: readonly (DataFrame | Series)[], options: ConcatOptions = {}): DataFrame | Series {
  if (objs.length === 0) throw new Error('No objects to concatenate');
  const axis1 = options.axis === 1 || options.axis === 'columns';
  const join = options.join ?? 'outer';

  if (!axis1 && objs.every((o) => o instanceof Series)) {
    const series = objs as readonly Series[];
    const col = Column.concat(series.map((s) => s._col));
    const index = options.ignoreIndex ? Index.range(col.length) : concatIndex(series.map((s) => s.index));
    const name = series.every((s) => s.name === series[0].name) ? series[0].name : null;
    return Series._from(col, index, name);
  }

  if (axis1) {
    const parts = objs.map((o, i) => (o instanceof Series ? o.toFrame(o.name ?? String(i)) : o));
    let index = parts[0].index;
    for (const p of parts.slice(1)) {
      if (index.equals(p.index)) continue;
      index = join === 'inner'
        ? new Index(index.labels.filter((l) => p.index.has(l)), { name: index.name })
        : index.union(p.index);
    }
    const cols = new Map<string, Column>();
    for (const p of parts) {
      const aligned = p.index.equals(index) ? p : p.reindex({ index });
      for (const [k, c] of aligned._cols) {
        if (cols.has(k)) throw new Error(`Duplicate column "${k}" in concat(axis=1); rename it first`);
        cols.set(k, c);
      }
    }
    return DataFrame._fromColumns(cols, options.ignoreIndex ? Index.range(index.length) : index);
  }

  const frames = objs.map((o) => (o instanceof Series ? o.toFrame() : o));
  let names: string[];
  if (join === 'inner') names = frames[0].columns.filter((c) => frames.every((f) => f.has(c)));
  else names = [...new Set(frames.flatMap((f) => f.columns))];
  const cols = new Map<string, Column>();
  for (const name of names) {
    // Placeholders for frames lacking the column take a dtype that can hold NA alongside the others.
    const present = frames.find((f) => f.has(name))!._column(name).dtype;
    const fill = present === 'int64' ? 'float64' : present === 'bool' ? 'object' : present;
    cols.set(name, Column.concat(frames.map((f) => (f.has(name) ? f._column(name) : Column.full(f.length, null, fill)))));
  }
  const total = frames.reduce((s, f) => s + f.length, 0);
  const index = options.ignoreIndex ? Index.range(total) : concatIndex(frames.map((f) => f.index));
  return DataFrame._fromColumns(cols, index);
}

function concatIndex(indexes: readonly Index[]): Index {
  const labels: Label[] = [];
  for (const idx of indexes) labels.push(...idx.labels);
  const first = indexes[0];
  const sameName = indexes.every((i) => i.name === first.name);
  return new Index(labels, { name: sameName ? first.name : null, names: first.names });
}

export interface MergeOptions {
  /** Join type (default 'inner'). */
  how?: 'inner' | 'left' | 'right' | 'outer' | 'cross';
  /** Key column(s) present in both frames (defaults to the shared columns). */
  on?: string | readonly string[];
  leftOn?: string | readonly string[];
  rightOn?: string | readonly string[];
  /** Suffixes for overlapping non-key columns (default `['_x', '_y']`). */
  suffixes?: readonly [string, string];
  /** Adds a `_merge` column: 'left_only' | 'right_only' | 'both'. */
  indicator?: boolean;
  /** Sort the result by the join keys. */
  sort?: boolean;
  /** Check the key relationship, e.g. '1:1', '1:m', 'm:1'. */
  validate?: '1:1' | '1:m' | 'm:1' | 'm:m';
  /** Use the left / right index (all levels) as join key(s). */
  leftIndex?: boolean;
  rightIndex?: boolean;
}

const asList = (v: string | readonly string[] | undefined): string[] | undefined => (v === undefined ? undefined : typeof v === 'string' ? [v] : [...v]);

/** Database-style hash join of two frames, like `pandas.merge`. */
export function merge(left: DataFrame, right: DataFrame, options: MergeOptions = {}): DataFrame {
  if (options.leftIndex || options.rightIndex) return mergeOnIndex(left, right, options);
  const how = options.how ?? 'inner';
  const [sx, sy] = options.suffixes ?? ['_x', '_y'];
  let leftOn = asList(options.leftOn) ?? asList(options.on);
  let rightOn = asList(options.rightOn) ?? asList(options.on);

  const lPos: number[] = [];
  const rPos: number[] = [];

  if (how === 'cross') {
    leftOn = [];
    rightOn = [];
    for (let i = 0; i < left.length; i++) for (let j = 0; j < right.length; j++) { lPos.push(i); rPos.push(j); }
  } else {
    if (!leftOn || !rightOn) {
      const shared = left.columns.filter((c) => right.has(c));
      if (shared.length === 0) throw new Error('No common columns to perform merge on; pass `on`, or `leftOn` and `rightOn`');
      leftOn = rightOn = shared;
    }
    if (leftOn.length !== rightOn.length) throw new Error('leftOn and rightOn must have the same length');
    const lKeys = leftOn.map((c) => left._column(c));
    const rKeys = rightOn.map((c) => right._column(c));
    const keyOf = (cols: Column[], i: number) => (cols.length === 1 ? hashKey(cols[0].get(i)) : hashKey(cols.map((c) => c.get(i))));

    const build = (cols: Column[], n: number) => {
      const m = new Map<unknown, number[]>();
      for (let i = 0; i < n; i++) {
        const k = keyOf(cols, i);
        const list = m.get(k);
        if (list) list.push(i);
        else m.set(k, [i]);
      }
      return m;
    };

    if (options.validate) validate(options.validate, build(lKeys, left.length), build(rKeys, right.length), left.length, right.length);

    if (how === 'right') {
      const lMap = build(lKeys, left.length);
      for (let j = 0; j < right.length; j++) {
        const matches = lMap.get(keyOf(rKeys, j));
        if (matches) for (const i of matches) { lPos.push(i); rPos.push(j); }
        else { lPos.push(-1); rPos.push(j); }
      }
    } else {
      const rMap = build(rKeys, right.length);
      const matched = how === 'outer' ? new Uint8Array(right.length) : null;
      for (let i = 0; i < left.length; i++) {
        const matches = rMap.get(keyOf(lKeys, i));
        if (matches) {
          for (const j of matches) { lPos.push(i); rPos.push(j); if (matched) matched[j] = 1; }
        } else if (how === 'left' || how === 'outer') { lPos.push(i); rPos.push(-1); }
      }
      if (matched) for (let j = 0; j < right.length; j++) if (!matched[j]) { lPos.push(-1); rPos.push(j); }
    }
  }

  // Assemble columns: left columns (keys coalesced when shared by name), then right non-key columns.
  const cols = new Map<string, Column>();
  const sharedKeys = new Set(leftOn.filter((c, i) => rightOn![i] === c));
  const rightKeySet = new Set(rightOn.filter((c) => sharedKeys.has(c)));
  const rightValueCols = right.columns.filter((c) => !rightKeySet.has(c));
  const overlap = new Set(left.columns.filter((c) => !sharedKeys.has(c) && rightValueCols.includes(c)));

  for (const name of left.columns) {
    let col = left._column(name).take(lPos);
    if (sharedKeys.has(name)) {
      const rc = right._column(name).take(rPos);
      if (lPos.some((p) => p < 0)) {
        const lc = col;
        col = Column.from(lPos.map((p, k) => (p < 0 ? rc.get(k) : lc.get(k))));
      }
    }
    cols.set(overlap.has(name) ? name + sx : name, col);
  }
  for (const name of rightValueCols) cols.set(overlap.has(name) ? name + sy : name, right._column(name).take(rPos));
  if (options.indicator) {
    cols.set('_merge', Column.from(lPos.map((p, k) => (p < 0 ? 'right_only' : rPos[k] < 0 ? 'left_only' : 'both')), 'string'));
  }

  let out = DataFrame._fromColumns(cols, Index.range(lPos.length));
  if ((options.sort || how === 'outer') && leftOn.length > 0) {
    const keyNames = leftOn.map((c) => (cols.has(c) ? c : c + sx));
    const order = argsort(keyNames.map((n) => sortKeyFromColumn(out._column(n), true)), out.length);
    out = out.take(order).resetIndex({ drop: true });
  }
  return out;
}

function validate(kind: string, lMap: Map<unknown, number[]>, rMap: Map<unknown, number[]>, ln: number, rn: number): void {
  const leftUnique = lMap.size === ln || [...lMap].every(([k, v]) => k === null || v.length === 1);
  const rightUnique = rMap.size === rn || [...rMap].every(([k, v]) => k === null || v.length === 1);
  if ((kind === '1:1' || kind === '1:m') && !leftUnique) throw new Error(`Merge keys are not unique in left dataset; not a ${kind} merge`);
  if ((kind === '1:1' || kind === 'm:1') && !rightUnique) throw new Error(`Merge keys are not unique in right dataset; not a ${kind} merge`);
}

/** merge() with `leftIndex` / `rightIndex`: index levels become hidden key columns. */
function mergeOnIndex(left: DataFrame, right: DataFrame, options: MergeOptions): DataFrame {
  const levelCols = (df: DataFrame, tag: string) => {
    const idx = df.index;
    const cols = new Map(df._cols);
    const names: string[] = [];
    for (let l = 0; l < idx.nlevels; l++) {
      const name = `\u0000${tag}${l}`;
      cols.set(name, Column.from(idx.isMulti ? idx.labels.map((t) => (t as readonly Label[])[l]) : idx.labels));
      names.push(name);
    }
    cols.set(`\u0000${tag}pos`, Column.from(Array.from({ length: df.length }, (_, i) => i), 'int64'));
    return { frame: DataFrame._fromColumns(cols, Index.range(df.length)), names };
  };
  const L = options.leftIndex ? levelCols(left, 'l') : { frame: DataFrame._fromColumns(new Map([...left._cols, ['\u0000lpos', Column.from(Array.from({ length: left.length }, (_, i) => i), 'int64')]]), left.index), names: asList(options.leftOn) ?? asList(options.on) ?? [] };
  const R = options.rightIndex ? levelCols(right, 'r') : { frame: DataFrame._fromColumns(new Map([...right._cols, ['\u0000rpos', Column.from(Array.from({ length: right.length }, (_, i) => i), 'int64')]]), right.index), names: asList(options.rightOn) ?? asList(options.on) ?? [] };
  if (L.names.length !== R.names.length) throw new Error('len(left keys) must equal len(right keys)');
  const res = merge(L.frame, R.frame, { ...options, leftIndex: false, rightIndex: false, on: undefined, leftOn: L.names, rightOn: R.names });
  const lpos = res._column('\u0000lpos').toArray().map((v) => (v === null || Number.isNaN(v) ? -1 : (v as number)));
  const rpos = res._column('\u0000rpos').toArray().map((v) => (v === null || Number.isNaN(v) ? -1 : (v as number)));
  let index: Index;
  if (options.leftIndex && options.rightIndex) {
    const labels = lpos.map((p, k) => (p >= 0 ? left.index.labels[p] : right.index.labels[rpos[k]]));
    index = new Index(labels, { name: left.index.name, names: left.index.names });
  } else if (options.leftIndex) index = right.index.take(rpos);
  else index = left.index.take(lpos);
  const cols = new Map([...res._cols].filter(([k]) => !k.startsWith('\u0000')));
  let out = DataFrame._fromColumns(cols, index);
  if (options.leftIndex && options.rightIndex && (options.how === 'outer' || options.sort)) {
    out = out.take(argsort([sortKeyFromColumn(Column.from(index.labels, 'object'), true)], out.length));
  }
  return out;
}
