/** MultiIndex reshaping: stack / unstack / xs / pivot and level manipulation. */
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import type { Label } from './core/types.ts';
import { compareValues, hashKey } from './core/values.ts';
import { colKey, colTuple, DataFrame } from './frame.ts';
import { KeyError, Series } from './series.ts';

/** An index level, by position or name. */
export type Level = number | string;

const tupleOf = (index: Index, i: number): Label[] => (index.isMulti ? [...(index.labels[i] as readonly Label[])] : [index.labels[i]]);
const namesOf = (index: Index): (string | null)[] => (index.isMulti ? [...index.names!] : [index.name]);

function makeIndex(tuples: Label[][], names: (string | null)[], tz: string | null = null): Index {
  if (names.length === 1) return new Index(tuples.map((t) => t[0]), { name: names[0], tz });
  return new Index(tuples, { names });
}

function uniqueInOrder<T>(items: readonly T[], key: (t: T) => unknown = hashKey): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const it of items) { const k = key(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

const tupleKey = (t: readonly Label[]) => hashKey(t as Label[]);
const sortTuples = (ts: Label[][]) => ts.sort((a, b) => compareValues(a, b));

/** Column tuples of a frame (flat columns are 1-tuples). */
function columnTuples(df: DataFrame): string[][] {
  return df.columns.map((k) => (df.nColumnLevels > 1 ? colTuple(k) : [k]));
}

function columnLevelNames(df: DataFrame): (string | null)[] {
  const n = df.nColumnLevels;
  return df._colNames && df._colNames.length === n ? [...df._colNames] : new Array(n).fill(null);
}

/** Builds a frame from column tuples (MultiIndex when tuples have > 1 part). */
function frameFromTuples(cols: [Label[], Column][], index: Index, names: (string | null)[]): DataFrame {
  if ((cols[0]?.[0].length ?? names.length) <= 1) {
    return DataFrame._fromColumns(new Map(cols.map(([t, c]) => [String(t[0]), c])), index, names[0] !== null && names[0] !== undefined ? [names[0]] : null);
  }
  return DataFrame._fromTupleColumns(cols, index, names);
}

// ------------------------------------------------------------------- stack

/**
 * Moves column level(s) into the innermost row index level. Flat columns give a
 * Series; MultiIndex columns give a frame with the remaining column levels.
 * Like pandas 3, missing combinations are kept as NA unless `dropna`.
 */
export function stack(df: DataFrame, options: { level?: Level; dropna?: boolean } = {}): Series | DataFrame {
  const tuples = columnTuples(df);
  const nl = df.nColumnLevels;
  const colNames = columnLevelNames(df);
  const l = nl > 1 ? df.columnIndex.levelNumber(options.level ?? -1) : 0;
  const levelVals = uniqueInOrder(tuples.map((t) => t[l]));
  const rest = uniqueInOrder(tuples.map((t) => t.filter((_, k) => k !== l)), tupleKey);
  const n = df.length;
  const rowTuples: Label[][] = [];
  for (let i = 0; i < n; i++) for (const v of levelVals) rowTuples.push([...tupleOf(df.index, i), v]);
  const index = makeIndex(rowTuples, [...namesOf(df.index), colNames[l]]);
  const order = Int32Array.from({ length: n * levelVals.length }, (_, k) => (k % levelVals.length) * n + Math.floor(k / levelVals.length));
  const gather = (r: string[]): Column => {
    const parts = levelVals.map((v) => {
      const t = [...r.slice(0, l), v, ...r.slice(l)];
      const key = nl > 1 ? colKey(t) : t[0];
      return df.has(key) ? df._column(key) : Column.full(n, null, 'float64');
    });
    return Column.concat(parts).take(order);
  };
  let out: Series | DataFrame;
  if (rest[0].length === 0) out = Series._from(gather([]), index, null);
  else out = frameFromTuples(rest.map((r) => [r, gather(r)]), index, colNames.filter((_, k) => k !== l));
  if (options.dropna) {
    const keep: number[] = [];
    for (let i = 0; i < out.length; i++) {
      const allNA = out instanceof Series ? out._col.isNA(i) : [...out._cols.values()].every((c) => c.isNA(i));
      if (!allNA) keep.push(i);
    }
    out = out.take(keep);
  }
  return out;
}

// ----------------------------------------------------------------- unstack

/**
 * Moves row index level(s) into the innermost column level(s); new rows and
 * columns are sorted like pandas. Missing cells become NA (or `fillValue`).
 */
export function unstack(target: Series | DataFrame, options: { level?: Level | readonly Level[]; fillValue?: unknown } = {}): DataFrame | Series {
  const index = target.index;
  if (!index.isMulti) {
    if (target instanceof Series) throw new Error('index must be a MultiIndex to unstack');
    // pandas: a frame with a flat index unstacks to a Series indexed by (column, row).
    return stack(target.transpose()) as Series;
  }
  const levels = (Array.isArray(options.level) ? options.level : [options.level ?? -1]).map((l) => index.levelNumber(l as Level));
  const keepLevels = Array.from({ length: index.nlevels }, (_, l) => l).filter((l) => !levels.includes(l));
  if (keepLevels.length === 0) throw new Error('Cannot unstack all index levels');
  const names = namesOf(index);
  const n = target.length;
  const rowParts = Array.from({ length: n }, (_, i) => keepLevels.map((l) => tupleOf(index, i)[l]));
  const colParts = Array.from({ length: n }, (_, i) => levels.map((l) => tupleOf(index, i)[l]));
  const newRows = sortTuples(uniqueInOrder(rowParts, tupleKey));
  const newCols = sortTuples(uniqueInOrder(colParts, tupleKey));
  const rowPos = new Map(newRows.map((r, k) => [tupleKey(r), k]));
  const colPos = new Map(newCols.map((c, k) => [tupleKey(c), k]));
  const where = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${rowPos.get(tupleKey(rowParts[i]))}:${colPos.get(tupleKey(colParts[i]))}`;
    if (where.has(key)) throw new Error('Index contains duplicate entries, cannot reshape');
    where.set(key, i);
  }
  const outIndex = makeIndex(newRows, keepLevels.map((l) => names[l]), index.tz);
  const build = (col: Column, ck: number) => {
    const positions = Int32Array.from({ length: newRows.length }, (_, r) => where.get(`${r}:${ck}`) ?? -1);
    if (options.fillValue === undefined || options.fillValue === null) return col.take(positions);
    // Fill before building so an int column stays int when the fill value fits.
    return Column.fromLike(Array.from(positions, (p) => (p < 0 ? options.fillValue : col.get(p))), col);
  };
  const levelNames = levels.map((l) => names[l]);
  const cols: [Label[], Column][] = [];
  if (target instanceof Series) {
    newCols.forEach((c, k) => cols.push([c.map((p) => (p === null ? '' : String(p))), build(target._col, k)]));
    return frameFromTuples(cols, outIndex, levelNames);
  }
  const tuples = columnTuples(target);
  const colNames = columnLevelNames(target);
  target.columns.forEach((key, j) => {
    newCols.forEach((c, k) => cols.push([[...tuples[j], ...c.map((p) => (p === null ? '' : String(p)))], build(target._column(key), k)]));
  });
  return frameFromTuples(cols, outIndex, [...colNames, ...levelNames]);
}

// ---------------------------------------------------------------------- xs

/** Cross-section by label at a level (rows by default, columns with axis 1). */
export function xs(target: Series | DataFrame, key: Label, options: { level?: Level | readonly Level[]; axis?: 0 | 1 | 'index' | 'columns'; dropLevel?: boolean } = {}): unknown {
  const axis1 = options.axis === 1 || options.axis === 'columns';
  const dropLevel = options.dropLevel ?? true;
  if (axis1) {
    if (!(target instanceof DataFrame)) throw new Error('Series has no columns axis');
    const t = target.transpose();
    const r = xs(t, key, { level: options.level, dropLevel });
    return r instanceof DataFrame ? r.transpose() : r;
  }
  const index = target.index;
  const keys = Array.isArray(key) && index.isMulti ? (key as readonly Label[]) : [key];
  const levels = options.level === undefined ? keys.map((_, l) => l) : (Array.isArray(options.level) ? options.level : [options.level]).map((l) => index.levelNumber(l as Level));
  if (levels.length !== keys.length) throw new Error('key and level must have the same length');
  const pos: number[] = [];
  for (let i = 0; i < target.length; i++) {
    const t = tupleOf(index, i);
    if (levels.every((l, k) => hashKey(t[l]) === hashKey(keys[k]))) pos.push(i);
  }
  if (pos.length === 0) throw new KeyError(key);
  if (!index.isMulti) {
    if (target instanceof DataFrame && pos.length === 1) return target.loc(index.labels[pos[0]] as Label);
    return target.take(pos);
  }
  let out = target.take(pos);
  if (dropLevel && levels.length < index.nlevels) out = withIndex(out, out.index.droplevel(levels));
  else if (dropLevel && target instanceof DataFrame && pos.length === 1) return target.iloc(pos[0]);
  return out;
}

function withIndex<T extends Series | DataFrame>(t: T, index: Index): T {
  return (t as unknown as { _withIndex(i: Index): T })._withIndex(index);
}

// ------------------------------------------------------------ level helpers

/** Applies an Index transform to the rows (axis 0) or to the column labels (axis 1). */
export function onAxis<T extends Series | DataFrame>(target: T, axis: 0 | 1 | 'index' | 'columns' | undefined, fn: (i: Index) => Index): T {
  if (axis === 1 || axis === 'columns') {
    if (!(target instanceof DataFrame)) throw new Error('Series has no columns axis');
    const copy = target.copy({ deep: false });
    copy.setColumns(fn(target.columnIndex));
    return copy as T;
  }
  return withIndex(target, fn(target.index));
}

// ------------------------------------------------------------------- pivot

/** Reshapes by unique index/column values without aggregation (duplicates throw). */
export function pivot(df: DataFrame, options: { index?: string | readonly string[]; columns: string | readonly string[]; values?: string | readonly string[] }): DataFrame {
  const cols = typeof options.columns === 'string' ? [options.columns] : [...options.columns];
  const idx = options.index === undefined ? [] : typeof options.index === 'string' ? [options.index] : [...options.index];
  let base: DataFrame;
  if (idx.length) base = df.setIndex([...idx, ...cols]);
  else {
    // Append the column keys to the existing index.
    const tuples = Array.from({ length: df.length }, (_, i) => [...tupleOf(df.index, i), ...cols.map((c) => df._column(c).get(i) as Label)]);
    base = df.drop(cols);
    base = withIndex(base, new Index(tuples, { names: [...namesOf(df.index), ...cols] }));
  }
  const nIdx = base.index.nlevels - cols.length;
  const levels = cols.map((_, k) => nIdx + k);
  if (typeof options.values === 'string') {
    return unstack(base.get(options.values), { level: levels }) as DataFrame;
  }
  const valueCols = options.values ? [...options.values] : base.columns;
  return unstack(base.get(valueCols), { level: levels }) as DataFrame;
}
