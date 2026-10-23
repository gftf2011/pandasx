import { aggregate, quantile, type AggOptions } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { DISPLAY, displayPositions, formatColumn, formatIndex, renderTable } from './core/format.ts';
import { Index, Slice } from './core/indexes.ts';
import { argsort, sortKeyFromColumn, type NaPosition } from './core/sort.ts';
import { isFloatStorage, isNumericDType, type AggName, type DType, type Label } from './core/types.ts';
import { compareValues, hashKey, isNA, valuesEqual } from './core/values.ts';
import { DatetimeMethods, StringMethods } from './accessors.ts';
import { DataFrame } from './frame.ts';
import { SeriesGroupBy, type GroupByOptions } from './groupby.ts';

export class KeyError extends Error {
  constructor(key: unknown) {
    super(`KeyError: ${Array.isArray(key) ? JSON.stringify(key) : String(key)}`);
    this.name = 'KeyError';
  }
}

export type SeriesInput = Iterable<unknown> | ArrayLike<unknown> | Record<string, unknown> | Column;

export interface SeriesOptions {
  index?: Index | readonly Label[];
  name?: string | null;
  dtype?: DType;
}

/** Something usable as a boolean mask: a bool Series or an array of booleans. */
export type Mask = Series | readonly boolean[] | Uint8Array;

/** Operand of arithmetic and comparison methods. */
export type Operand = Series | readonly unknown[] | Float64Array | number | string | boolean | Date | null;

export type RowSelector = Label | readonly Label[] | Mask | Slice;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function toIndex(index: Index | readonly Label[] | undefined, n: number): Index {
  if (index === undefined) return Index.range(n);
  const idx = index instanceof Index ? index : new Index([...index]);
  if (idx.length !== n) throw new RangeError(`Length of index (${idx.length}) does not match length of values (${n})`);
  return idx;
}

export function isMask(key: unknown): key is Mask {
  if (key instanceof Series) return key.dtype === 'bool';
  if (key instanceof Uint8Array) return true;
  return Array.isArray(key) && key.length > 0 && typeof key[0] === 'boolean';
}

/** Converts a mask to positions, aligning a Series mask on `index` when needed. */
export function maskPositions(mask: Mask, index: Index): number[] {
  let flags: ArrayLike<unknown>;
  if (mask instanceof Series) {
    flags = mask.index.equals(index) ? (mask._col.data as Uint8Array) : mask.reindex(index.labels, false)._col.toArray().map(Boolean);
  } else flags = mask;
  if (flags.length !== index.length) throw new RangeError(`Boolean mask of length ${flags.length} does not match length ${index.length}`);
  const out: number[] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) out.push(i);
  return out;
}

/** Row positions selected by a label-based key. */
export function labelPositions(key: RowSelector, index: Index): number[] {
  if (key instanceof Slice) return key.labelPositions(index);
  if (isMask(key)) return maskPositions(key, index);
  if (Array.isArray(key) && !(index.nlevels > 1 && !Array.isArray(key[0]))) {
    const out: number[] = [];
    for (const l of key as readonly Label[]) {
      const locs = index.getLoc(l);
      if (locs.length === 0) throw new KeyError(l);
      out.push(...locs);
    }
    return out;
  }
  const locs = index.getLoc(key as Label);
  if (locs.length === 0) throw new KeyError(key);
  return [...locs];
}

/** Row positions selected by a position-based key. */
export function positionalPositions(key: number | readonly number[] | Mask | Slice, n: number): number[] {
  if (key instanceof Slice) return key.positions(n);
  if (isMask(key)) {
    const flags = key instanceof Series ? (key._col.data as Uint8Array) : key;
    if (flags.length !== n) throw new RangeError(`Boolean mask of length ${flags.length} does not match length ${n}`);
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (flags[i]) out.push(i);
    return out;
  }
  const keys = typeof key === 'number' ? [key] : (key as readonly number[]);
  return keys.map((p) => {
    const q = p < 0 ? n + p : p;
    if (!Number.isInteger(q) || q < 0 || q >= n) throw new RangeError(`Position ${p} is out of bounds for length ${n}`);
    return q;
  });
}

type NumOp = (a: number, b: number) => number;

const ARITH: Record<string, NumOp> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  mod: (a, b) => ((a % b) + b) % b,
  pow: (a, b) => a ** b,
  floordiv: (a, b) => Math.floor(a / b),
};

const CMP: Record<string, (c: number) => boolean> = {
  eq: (c) => c === 0,
  ne: (c) => c !== 0,
  lt: (c) => c < 0,
  le: (c) => c <= 0,
  gt: (c) => c > 0,
  ge: (c) => c >= 0,
};

/** One-dimensional labeled array, the equivalent of `pandas.Series`. */
export class Series {
  /** @internal */
  readonly _col: Column;
  readonly index: Index;
  readonly name: string | null;

  constructor(data: SeriesInput = [], options: SeriesOptions = {}) {
    let col: Column;
    let index = options.index;
    if (data instanceof Column) {
      col = options.dtype ? data.astype(options.dtype) : data;
    } else if (isPlainObject(data)) {
      const keys = Object.keys(data);
      col = Column.from(Object.values(data), options.dtype);
      if (index === undefined) index = keys;
      else {
        const idx = index instanceof Index ? index : new Index([...index]);
        col = col.take(new Index(keys).getIndexer(idx.labels));
        index = idx;
      }
    } else {
      col = Column.from(data as Iterable<unknown>, options.dtype);
    }
    this._col = col;
    this.index = toIndex(index, col.length);
    this.name = options.name ?? null;
  }

  /** @internal Builds a Series without validation. */
  static _from(col: Column, index: Index, name: string | null): Series {
    return new Series(col, { index, name });
  }

  private with(col: Column, index: Index = this.index, name: string | null = this.name): Series {
    return new Series(col, { index, name });
  }

  // ---------------------------------------------------------------- attributes

  get dtype(): DType {
    return this._col.dtype;
  }

  get length(): number {
    return this._col.length;
  }

  get size(): number {
    return this._col.length;
  }

  get shape(): [number] {
    return [this.length];
  }

  get empty(): boolean {
    return this.length === 0;
  }

  /** Values as a JS array (a copy). */
  get values(): unknown[] {
    return this._col.toArray();
  }

  get str(): StringMethods {
    return new StringMethods(this);
  }

  get dt(): DatetimeMethods {
    return new DatetimeMethods(this);
  }

  toArray(): unknown[] {
    return this._col.toArray();
  }

  /** `{label: value}`; tuple labels are joined with commas. */
  toDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < this.length; i++) out[String(this.index.labels[i])] = this._col.get(i);
    return out;
  }

  toJSON(): Record<string, unknown> {
    return this.toDict();
  }

  toFrame(name?: string): DataFrame {
    return DataFrame._fromColumns(new Map([[name ?? this.name ?? '0', this._col]]), this.index);
  }

  copy(): Series {
    return this.with(new Column(this.dtype, this._col.data.slice()));
  }

  rename(name: string | null): Series {
    return this.with(this._col, this.index, name);
  }

  setIndex(index: Index | readonly Label[]): Series {
    return this.with(this._col, toIndex(index, this.length));
  }

  *[Symbol.iterator](): IterableIterator<unknown> {
    for (let i = 0; i < this.length; i++) yield this._col.get(i);
  }

  *items(): IterableIterator<[Label, unknown]> {
    for (let i = 0; i < this.length; i++) yield [this.index.labels[i], this._col.get(i)];
  }

  // ----------------------------------------------------------------- selection

  /** Value for `label`, or `defaultValue` when absent (like `Series.get`). */
  get(label: Label, defaultValue: unknown = undefined): unknown {
    const locs = this.index.getLoc(label);
    if (locs.length === 0) return defaultValue;
    return locs.length === 1 ? this._col.get(locs[0]) : this.take(locs);
  }

  at(label: Label): unknown {
    const locs = this.index.getLoc(label);
    if (locs.length === 0) throw new KeyError(label);
    return this._col.get(locs[0]);
  }

  iat(position: number): unknown {
    return this._col.get(positionalPositions(position, this.length)[0]);
  }

  /** Label-based selection: label, labels, boolean mask, slice (inclusive) or callable. */
  loc(key: readonly Label[] | Mask | Slice | ((s: Series) => Mask)): Series;
  loc(key: Label): unknown;
  loc(key: RowSelector | ((s: Series) => Mask)): unknown {
    if (typeof key === 'function') return this.loc(key(this));
    const scalar = !(key instanceof Slice) && !isMask(key) && !(Array.isArray(key) && !(this.index.nlevels > 1 && !Array.isArray(key[0])));
    const pos = labelPositions(key, this.index);
    return scalar && pos.length === 1 ? this._col.get(pos[0]) : this.take(pos);
  }

  /** Position-based selection: integer, integers, boolean mask, slice (exclusive) or callable. */
  iloc(key: number): unknown;
  iloc(key: readonly number[] | Mask | Slice | ((s: Series) => Mask)): Series;
  iloc(key: number | readonly number[] | Mask | Slice | ((s: Series) => Mask)): unknown {
    if (typeof key === 'function') return this.iloc(key(this));
    const pos = positionalPositions(key, this.length);
    return typeof key === 'number' ? this._col.get(pos[0]) : this.take(pos);
  }

  /** @internal Rows at the given positions. */
  take(positions: ArrayLike<number>): Series {
    return this.with(this._col.take(positions), this.index.take(positions));
  }

  head(n = 5): Series {
    return this.iloc(new Slice(0, n < 0 ? this.length + n : n));
  }

  tail(n = 5): Series {
    return this.iloc(new Slice(n === 0 ? this.length : -n));
  }

  /** Conforms to new labels; missing labels get `fillValue` (NA by default). */
  reindex(labels: readonly Label[] | Index, fillValue: unknown = null): Series {
    const idx = labels instanceof Index ? labels : new Index([...labels], { name: this.index.name });
    const indexer = this.index.getIndexer(idx.labels);
    let col = this._col.take(indexer);
    if (!isNA(fillValue) && indexer.some((p) => p < 0)) {
      col = col.map((v, i) => (indexer[i] < 0 ? fillValue : v));
    }
    return this.with(col, idx);
  }

  filter(predicate: (value: unknown, label: Label) => boolean): Series {
    const pos: number[] = [];
    for (let i = 0; i < this.length; i++) if (predicate(this._col.get(i), this.index.labels[i])) pos.push(i);
    return this.take(pos);
  }

  sample(n = 1, options: { seed?: number } = {}): Series {
    return this.take(samplePositions(this.length, n, options.seed));
  }

  // -------------------------------------------------------------- aggregation

  private agg1(name: AggName, opts?: AggOptions): unknown {
    return aggregate(this._col, name, null, opts);
  }

  sum(opts?: AggOptions): number { return this.agg1('sum', opts) as number; }
  prod(opts?: AggOptions): number { return this.agg1('prod', opts) as number; }
  mean(opts?: AggOptions): number { return this.agg1('mean', opts) as number; }
  median(opts?: AggOptions): number { return this.agg1('median', opts) as number; }
  std(opts?: AggOptions): number { return this.agg1('std', opts) as number; }
  var(opts?: AggOptions): number { return this.agg1('var', opts) as number; }
  min(opts?: AggOptions): unknown { return this.agg1('min', opts); }
  max(opts?: AggOptions): unknown { return this.agg1('max', opts); }
  /** Number of non-missing values. */
  count(): number { return this.agg1('count') as number; }
  nunique(): number { return this.agg1('nunique') as number; }

  quantile(q: number): number;
  quantile(q: readonly number[]): Series;
  quantile(q: number | readonly number[]): number | Series {
    if (typeof q === 'number') return quantile(this._col, q);
    return new Series(q.map((x) => quantile(this._col, x)), { index: [...q], name: this.name });
  }

  /** Applies one aggregation, several (returns a Series) or a reducer function. */
  agg(func: AggName | ((s: Series) => unknown)): unknown;
  agg(func: readonly (AggName | ((s: Series) => unknown))[]): Series;
  agg(func: AggName | ((s: Series) => unknown) | readonly (AggName | ((s: Series) => unknown))[]): unknown {
    const one = (f: AggName | ((s: Series) => unknown)) => (typeof f === 'function' ? f(this) : this.agg1(f));
    if (Array.isArray(func)) {
      return new Series(func.map(one), { index: func.map((f, i) => (typeof f === 'function' ? f.name || `func${i}` : f)), name: this.name });
    }
    return one(func as AggName);
  }

  idxmax(): Label {
    return this.argExtreme(true);
  }

  idxmin(): Label {
    return this.argExtreme(false);
  }

  private argExtreme(max: boolean): Label {
    let best = -1;
    for (let i = 0; i < this.length; i++) {
      if (this._col.isNA(i)) continue;
      if (best < 0) { best = i; continue; }
      const c = compareValues(this._col.raw(i), this._col.raw(best));
      if (max ? c > 0 : c < 0) best = i;
    }
    if (best < 0) throw new Error('attempt to get argmax/argmin of an empty sequence');
    return this.index.labels[best];
  }

  /** Summary statistics (numeric: count/mean/std/min/quartiles/max; otherwise count/unique/top/freq). */
  describe(): Series {
    if (isNumericDType(this.dtype)) {
      const c = this._col.dtype === 'bool' ? this._col.astype('float64') : this._col;
      return new Series(
        [aggregate(c, 'count'), aggregate(c, 'mean'), aggregate(c, 'std'), aggregate(c, 'min'),
          quantile(c, 0.25), quantile(c, 0.5), quantile(c, 0.75), aggregate(c, 'max')],
        { index: ['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max'], name: this.name, dtype: 'float64' },
      );
    }
    const vc = this.valueCounts();
    return new Series(
      [this.count(), vc.length, vc.length ? vc.index.labels[0] : null, vc.length ? vc.iat(0) : null],
      { index: ['count', 'unique', 'top', 'freq'], name: this.name, dtype: 'object' },
    );
  }

  /** Counts of unique values, most frequent first. */
  valueCounts(options: { normalize?: boolean; sort?: boolean; ascending?: boolean; dropna?: boolean } = {}): Series {
    const { normalize = false, sort = true, ascending = false, dropna = true } = options;
    const counts = new Map<unknown, { value: unknown; n: number }>();
    let total = 0;
    for (let i = 0; i < this.length; i++) {
      const missing = this._col.isNA(i);
      if (missing && dropna) continue;
      const v = this._col.get(i);
      const k = hashKey(v);
      const e = counts.get(k);
      if (e) e.n++;
      else counts.set(k, { value: missing ? null : v, n: 1 });
      total++;
    }
    let entries = [...counts.values()];
    if (sort) {
      const dir = ascending ? 1 : -1;
      entries = entries.map((e, i) => ({ ...e, i })).sort((a, b) => dir * (a.n - b.n) || a.i - b.i);
    }
    const values = entries.map((e) => (normalize ? e.n / total : e.n));
    return new Series(values, {
      index: new Index(entries.map((e) => e.value as Label), { name: this.name }),
      name: normalize ? 'proportion' : 'count',
      dtype: normalize ? 'float64' : 'int64',
    });
  }

  /** Unique values in order of appearance (includes a single NA if present). */
  unique(): unknown[] {
    const seen = new Set<unknown>();
    const out: unknown[] = [];
    for (const v of this) {
      const k = hashKey(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out;
  }

  mode(): Series {
    const vc = this.valueCounts({ sort: false });
    const top = vc.length ? (vc.max() as number) : 0;
    const vals = vc.index.labels.filter((_, i) => vc.iat(i) === top);
    return new Series([...vals].sort(compareValues), { name: this.name });
  }

  // --------------------------------------------------------------- cumulative

  private cumulative(step: (acc: number, v: number) => number, init: number): Series {
    if (!isNumericDType(this.dtype)) throw new TypeError(`Cannot compute cumulative op on dtype ${this.dtype}`);
    const src = this._col.data as ArrayLike<number>;
    const out = new Float64Array(this.length);
    let acc = init;
    for (let i = 0; i < out.length; i++) {
      if (Number.isNaN(src[i])) { out[i] = NaN; continue; }
      acc = step(acc, src[i]);
      out[i] = acc;
    }
    return this.with(new Column(this.dtype === 'float64' ? 'float64' : 'int64', out));
  }

  cumsum(): Series { return this.cumulative((a, v) => a + v, 0); }
  cumprod(): Series { return this.cumulative((a, v) => a * v, 1); }
  cummax(): Series { return this.cumulative((a, v) => Math.max(a, v), -Infinity); }
  cummin(): Series { return this.cumulative((a, v) => Math.min(a, v), Infinity); }

  /** Shifts values by `periods` positions, filling with NA. */
  shift(periods = 1, fillValue: unknown = null): Series {
    const n = this.length;
    const pos = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i - periods;
      pos[i] = j >= 0 && j < n ? j : -1;
    }
    let col = this._col.take(pos);
    if (!isNA(fillValue)) col = col.map((v, i) => (pos[i] < 0 ? fillValue : v), this.dtype);
    return this.with(col);
  }

  diff(periods = 1): Series {
    return this.sub(this.shift(periods));
  }

  pctChange(periods = 1): Series {
    const prev = this.shift(periods);
    return this.sub(prev).div(prev);
  }

  // ---------------------------------------------------------------- transform

  private numericMap(fn: (v: number) => number, keepInt = false): Series {
    if (!isNumericDType(this.dtype)) throw new TypeError(`Operation requires numeric dtype, got ${this.dtype}`);
    const src = this._col.data as ArrayLike<number>;
    const out = new Float64Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = fn(src[i]);
    return this.with(new Column(keepInt && this.dtype === 'int64' ? 'int64' : 'float64', out));
  }

  abs(): Series { return this.numericMap(Math.abs, true); }

  round(decimals = 0): Series {
    const f = 10 ** decimals;
    return this.numericMap((v) => Math.round(v * f) / f, decimals >= 0);
  }

  clip(lower?: number | null, upper?: number | null): Series {
    const lo = lower ?? -Infinity;
    const hi = upper ?? Infinity;
    return this.numericMap((v) => (Number.isNaN(v) ? v : Math.min(Math.max(v, lo), hi)), Number.isInteger(lo) || lo === -Infinity);
  }

  /** Element-wise transform with a function, or substitution via a lookup object / Map. */
  map(mapper: ((value: unknown, label: Label) => unknown) | Record<string, unknown> | Map<unknown, unknown>, options: { naAction?: 'ignore' } = {}): Series {
    let fn: (v: unknown, i: number) => unknown;
    if (typeof mapper === 'function') fn = (v, i) => mapper(v, this.index.labels[i]);
    else if (mapper instanceof Map) {
      const m = new Map<unknown, unknown>();
      for (const [k, v] of mapper) m.set(hashKey(k), v);
      fn = (v) => m.get(hashKey(v)) ?? null;
    } else fn = (v) => (Object.hasOwn(mapper, String(v)) ? mapper[String(v)] : null);
    const ignore = options.naAction === 'ignore';
    return this.with(this._col.map((v, i) => (ignore && isNA(v) ? v : fn(v, i))));
  }

  /** Same as `map` with a function (pandas' Series.apply is element-wise). */
  apply(fn: (value: unknown, label: Label) => unknown): Series {
    return this.map(fn);
  }

  astype(dtype: DType): Series {
    return this.with(this._col.astype(dtype));
  }

  /** Replaces values equal to `from` (or every key of a mapping) with `to`. */
  replace(from: unknown, to?: unknown): Series {
    const m = new Map<unknown, unknown>();
    if (from instanceof Map) for (const [k, v] of from) m.set(hashKey(k), v);
    else if (isPlainObject(from)) for (const [k, v] of Object.entries(from)) m.set(k, v);
    else m.set(hashKey(from), to);
    return this.with(this._col.map((v) => {
      const k = hashKey(v);
      return m.has(k) ? m.get(k) : v;
    }));
  }

  /** Keeps values where `cond` is true; replaces the rest with `other`. */
  where(cond: Mask | ((s: Series) => Mask), other: unknown = null): Series {
    return this.replaceWhere(cond, other, false);
  }

  /** Opposite of `where`: replaces values where `cond` is true. */
  mask(cond: Mask | ((s: Series) => Mask), other: unknown = null): Series {
    return this.replaceWhere(cond, other, true);
  }

  private replaceWhere(cond: Mask | ((s: Series) => Mask), other: unknown, replaceIfTrue: boolean): Series {
    const c = typeof cond === 'function' ? cond(this) : cond;
    const hit = new Uint8Array(this.length);
    for (const p of maskPositions(c, this.index)) hit[p] = 1;
    const aligned = other instanceof Series ? other.reindex(this.index.labels) : null;
    return this.with(this._col.map((v, i) => (Boolean(hit[i]) === replaceIfTrue ? (aligned ? aligned._col.get(i) : other) : v)));
  }

  // ------------------------------------------------------------ missing data

  isna(): Series {
    const out = new Uint8Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = this._col.isNA(i) ? 1 : 0;
    return this.with(new Column('bool', out));
  }

  notna(): Series {
    return this.isna().not();
  }

  isnull(): Series { return this.isna(); }
  notnull(): Series { return this.notna(); }

  fillna(value: unknown): Series {
    if (!this._col.hasNA()) return this;
    const other = value instanceof Series ? value.reindex(this.index.labels) : null;
    return this.with(this._col.map((v, i) => (isNA(v) ? (other ? other._col.get(i) : value) : v)));
  }

  /** Propagates the last valid value forward. */
  ffill(limit = Infinity): Series {
    return this.fillDirectional(true, limit);
  }

  /** Propagates the next valid value backward. */
  bfill(limit = Infinity): Series {
    return this.fillDirectional(false, limit);
  }

  private fillDirectional(forward: boolean, limit: number): Series {
    const n = this.length;
    const pos = new Int32Array(n);
    let last = -1, run = 0;
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k;
      if (!this._col.isNA(i)) { last = i; run = 0; pos[i] = i; continue; }
      run++;
      pos[i] = last >= 0 && run <= limit ? last : i;
    }
    return this.with(this._col.take(pos));
  }

  dropna(): Series {
    const pos: number[] = [];
    for (let i = 0; i < this.length; i++) if (!this._col.isNA(i)) pos.push(i);
    return this.take(pos);
  }

  /** Linear interpolation of missing numeric values. */
  interpolate(): Series {
    if (!isNumericDType(this.dtype)) throw new TypeError('interpolate requires numeric dtype');
    const src = this._col.data as ArrayLike<number>;
    const out = Float64Array.from(src);
    let prev = -1;
    for (let i = 0; i < out.length; i++) {
      if (Number.isNaN(out[i])) continue;
      if (prev >= 0 && i - prev > 1) {
        for (let j = prev + 1; j < i; j++) out[j] = out[prev] + ((out[i] - out[prev]) * (j - prev)) / (i - prev);
      }
      prev = i;
    }
    return this.with(new Column('float64', out));
  }

  // ------------------------------------------------------------------ sorting

  sortValues(options: { ascending?: boolean; naPosition?: NaPosition } = {}): Series {
    const order = argsort([sortKeyFromColumn(this._col, options.ascending ?? true)], this.length, options.naPosition);
    return this.take(order);
  }

  sortIndex(options: { ascending?: boolean } = {}): Series {
    const order = argsort([sortKeyFromColumn(Column.from(this.index.labels, 'object'), options.ascending ?? true)], this.length);
    return this.take(order);
  }

  argsort(): Series {
    const order = argsort([sortKeyFromColumn(this._col, true)], this.length);
    return this.with(Column.from(order, 'int64'));
  }

  nlargest(n = 5): Series {
    return this.dropna().sortValues({ ascending: false }).head(n);
  }

  nsmallest(n = 5): Series {
    return this.dropna().sortValues({ ascending: true }).head(n);
  }

  /** Ranks (1-based, average for ties), like `rank(method='average')`. */
  rank(options: { ascending?: boolean } = {}): Series {
    const order = argsort([sortKeyFromColumn(this._col, options.ascending ?? true)], this.length);
    const out = new Float64Array(this.length).fill(NaN);
    let i = 0;
    while (i < order.length) {
      if (this._col.isNA(order[i])) { i++; continue; }
      let j = i;
      while (j + 1 < order.length && !this._col.isNA(order[j + 1]) && valuesEqual(this._col.get(order[j + 1]), this._col.get(order[i]))) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[order[k]] = r;
      i = j + 1;
    }
    return this.with(new Column('float64', out));
  }

  // ---------------------------------------------------------------- duplicates

  duplicated(keep: 'first' | 'last' | false = 'first'): Series {
    return this.with(new Column('bool', duplicatedFlags([this._col], this.length, keep)));
  }

  dropDuplicates(keep: 'first' | 'last' | false = 'first'): Series {
    return this.loc(this.duplicated(keep).not());
  }

  /** True where the value is contained in `values`. */
  isin(values: Iterable<unknown>): Series {
    const set = new Set<unknown>();
    for (const v of values) set.add(hashKey(v));
    const out = new Uint8Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = !this._col.isNA(i) && set.has(hashKey(this._col.get(i))) ? 1 : 0;
    return this.with(new Column('bool', out));
  }

  between(left: Operand, right: Operand, inclusive: 'both' | 'neither' | 'left' | 'right' = 'both'): Series {
    const l = inclusive === 'both' || inclusive === 'left' ? this.ge(left) : this.gt(left);
    const r = inclusive === 'both' || inclusive === 'right' ? this.le(right) : this.lt(right);
    return l.and(r);
  }

  // ------------------------------------------------------- operators / alignment

  /** @internal Aligns `other` with this series; returns both columns and the result index. */
  _align(other: Operand): { left: Column; right: Column | null; scalar: unknown; index: Index } {
    if (other instanceof Series) {
      if (this.index.equals(other.index)) return { left: this._col, right: other._col, scalar: null, index: this.index };
      const index = this.index.union(other.index);
      return { left: this.reindex(index)._col, right: other.reindex(index)._col, scalar: null, index };
    }
    if (Array.isArray(other) || other instanceof Float64Array) {
      if (other.length !== this.length) throw new RangeError(`Lengths must match: ${this.length} vs ${other.length}`);
      return { left: this._col, right: Column.from(other), scalar: null, index: this.index };
    }
    return { left: this._col, right: null, scalar: other, index: this.index };
  }

  private arith(op: string, other: Operand, reverse = false): Series {
    const { left, right, scalar, index } = this._align(other);
    const fn = ARITH[op];
    const n = left.length;
    const rightDtype: DType = right ? right.dtype : scalar instanceof Date ? 'datetime' : typeof scalar === 'number' || typeof scalar === 'boolean' ? (Number.isInteger(scalar) || typeof scalar === 'boolean' ? 'int64' : 'float64') : isNA(scalar) ? 'float64' : 'object';
    const numericLike = (d: DType) => isFloatStorage(d) || d === 'bool';

    if (numericLike(left.dtype) && numericLike(rightDtype)) {
      const a = left.data as ArrayLike<number>;
      const b = right ? (right.data as ArrayLike<number>) : null;
      const s = scalar instanceof Date ? scalar.getTime() : isNA(scalar) ? NaN : Number(scalar);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = a[i];
        const y = b ? b[i] : s;
        out[i] = reverse ? fn(y, x) : fn(x, y);
      }
      const ints = (d: DType) => d === 'int64' || d === 'bool';
      let dtype: DType = 'float64';
      const lt = reverse ? rightDtype : left.dtype;
      const rt = reverse ? left.dtype : rightDtype;
      if (lt === 'datetime' && rt === 'datetime') dtype = 'float64';
      else if ((lt === 'datetime' || rt === 'datetime') && (op === 'add' || op === 'sub')) dtype = 'datetime';
      else if (ints(lt) && ints(rt) && op !== 'div' && !(op === 'pow' && out.some((v) => !Number.isInteger(v))) && !out.some(Number.isNaN)) dtype = 'int64';
      return new Series(new Column(dtype, out), { index, name: other instanceof Series && other.name !== this.name ? null : this.name });
    }

    // Generic path (strings, objects): JS operators with NA propagation.
    const jsop: Record<string, (a: any, b: any) => unknown> = {
      add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => (typeof a === 'string' ? a.repeat(b) : typeof b === 'string' ? b.repeat(a) : a * b),
      div: (a, b) => a / b, mod: (a, b) => a % b, pow: (a, b) => a ** b, floordiv: (a, b) => Math.floor(a / b),
    };
    const g = jsop[op];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = left.get(i);
      const y = right ? right.get(i) : scalar;
      out[i] = isNA(x) || isNA(y) ? null : reverse ? g(y, x) : g(x, y);
    }
    return new Series(out, { index, name: this.name });
  }

  add(other: Operand): Series { return this.arith('add', other); }
  sub(other: Operand): Series { return this.arith('sub', other); }
  mul(other: Operand): Series { return this.arith('mul', other); }
  div(other: Operand): Series { return this.arith('div', other); }
  mod(other: Operand): Series { return this.arith('mod', other); }
  pow(other: Operand): Series { return this.arith('pow', other); }
  floordiv(other: Operand): Series { return this.arith('floordiv', other); }
  radd(other: Operand): Series { return this.arith('add', other, true); }
  rsub(other: Operand): Series { return this.arith('sub', other, true); }
  rmul(other: Operand): Series { return this.arith('mul', other, true); }
  rdiv(other: Operand): Series { return this.arith('div', other, true); }
  neg(): Series { return this.mul(-1); }

  private compare(op: string, other: Operand): Series {
    const { left, right, scalar, index } = this._align(other);
    const test = CMP[op];
    const n = left.length;
    const out = new Uint8Array(n);
    const fastNum = isFloatStorage(left.dtype) || left.dtype === 'bool';
    let s: unknown = scalar;
    if (left.dtype === 'datetime') s = scalar instanceof Date ? scalar.getTime() : typeof scalar === 'string' ? Date.parse(scalar) : scalar;
    else if (scalar instanceof Date) s = scalar.getTime();
    const rightRaw = right && left.dtype === 'datetime' && right.dtype !== 'datetime' ? right.astype('datetime') : right;
    for (let i = 0; i < n; i++) {
      const ma = left.isNA(i);
      const mb = rightRaw ? rightRaw.isNA(i) : isNA(s);
      if (ma || mb) { out[i] = op === 'ne' ? 1 : 0; continue; }
      const a = fastNum ? (left.data as ArrayLike<number>)[i] : left.raw(i);
      const b = rightRaw ? rightRaw.raw(i) : s;
      let c: number;
      if (op === 'eq' || op === 'ne') c = valuesEqual(a, b) ? 0 : 1;
      else c = compareValues(a, b);
      out[i] = test(c) ? 1 : 0;
    }
    return new Series(new Column('bool', out), { index, name: this.name });
  }

  eq(other: Operand): Series { return this.compare('eq', other); }
  ne(other: Operand): Series { return this.compare('ne', other); }
  lt(other: Operand): Series { return this.compare('lt', other); }
  le(other: Operand): Series { return this.compare('le', other); }
  gt(other: Operand): Series { return this.compare('gt', other); }
  ge(other: Operand): Series { return this.compare('ge', other); }

  private logical(other: Operand, fn: (a: boolean, b: boolean) => boolean): Series {
    const { left, right, scalar, index } = this._align(other);
    const out = new Uint8Array(left.length);
    for (let i = 0; i < out.length; i++) {
      const a = !left.isNA(i) && Boolean(left.get(i));
      const b = right ? !right.isNA(i) && Boolean(right.get(i)) : Boolean(scalar);
      out[i] = fn(a, b) ? 1 : 0;
    }
    return new Series(new Column('bool', out), { index, name: this.name });
  }

  and(other: Operand): Series { return this.logical(other, (a, b) => a && b); }
  or(other: Operand): Series { return this.logical(other, (a, b) => a || b); }
  xor(other: Operand): Series { return this.logical(other, (a, b) => a !== b); }

  not(): Series {
    const out = new Uint8Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = !this._col.isNA(i) && this._col.get(i) ? 0 : 1;
    return this.with(new Column('bool', out));
  }

  any(): boolean {
    for (let i = 0; i < this.length; i++) if (!this._col.isNA(i) && this._col.get(i)) return true;
    return false;
  }

  all(): boolean {
    for (let i = 0; i < this.length; i++) if (!this._col.isNA(i) && !this._col.get(i)) return false;
    return true;
  }

  /** True when both series have the same index, dtype-compatible values and NAs in the same places. */
  equals(other: Series): boolean {
    if (!(other instanceof Series) || this.length !== other.length || !this.index.equals(other.index)) return false;
    for (let i = 0; i < this.length; i++) {
      const a = this._col.isNA(i), b = other._col.isNA(i);
      if (a !== b || (!a && !valuesEqual(this._col.get(i), other._col.get(i)))) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ reshape

  resetIndex(options: { drop?: boolean; name?: string } = {}): DataFrame | Series {
    if (options.drop) return this.with(this._col, Index.range(this.length));
    return this.toFrame(options.name ?? this.name ?? '0').resetIndex();
  }

  groupby(by: Series | readonly unknown[] | readonly (Series | readonly unknown[])[], options: GroupByOptions = {}): SeriesGroupBy {
    const list = Array.isArray(by) && (by[0] instanceof Series || Array.isArray(by[0])) ? (by as (Series | unknown[])[]) : [by as Series | unknown[]];
    const cols = new Map<string, Column>();
    const keyNames: (string | null)[] = [];
    list.forEach((k, i) => {
      const col = k instanceof Series ? (k.index.equals(this.index) ? k._col : k.reindex(this.index)._col) : Column.from(k);
      if (col.length !== this.length) throw new RangeError('Grouper length must match the series length');
      cols.set(`\u0000key${i}`, col);
      keyNames.push(k instanceof Series ? k.name : null);
    });
    cols.set('\u0000value', this._col);
    const frame = DataFrame._fromColumns(cols, this.index);
    return new SeriesGroupBy(frame, [...cols.keys()].slice(0, -1), '\u0000value', options, keyNames, this.name);
  }

  // ------------------------------------------------------------------ display

  toString(): string {
    const pos = displayPositions(this.length, DISPLAY.maxRows, DISPLAY.minRows);
    const idx = formatIndex(this.index, pos);
    const vals = formatColumn(this._col, pos);
    const body = this.length ? renderTable(null, [...idx, vals], idx.length) : `Series([], dtype: ${this.dtype})`;
    const footer = [this.name !== null ? `Name: ${this.name}` : null, this.length > DISPLAY.maxRows ? `Length: ${this.length}` : null, `dtype: ${this.dtype}`]
      .filter(Boolean).join(', ');
    return this.length ? `${body}\n${footer}` : body;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

/** Flags rows whose key (across `cols`) already appeared. */
export function duplicatedFlags(cols: readonly Column[], n: number, keep: 'first' | 'last' | false): Uint8Array {
  const out = new Uint8Array(n);
  const key = (i: number) => (cols.length === 1 ? hashKey(cols[0].get(i)) : hashKey(cols.map((c) => c.get(i))));
  if (keep === false) {
    const counts = new Map<unknown, number>();
    const keys = new Array(n);
    for (let i = 0; i < n; i++) { keys[i] = key(i); counts.set(keys[i], (counts.get(keys[i]) ?? 0) + 1); }
    for (let i = 0; i < n; i++) out[i] = counts.get(keys[i])! > 1 ? 1 : 0;
    return out;
  }
  const seen = new Set<unknown>();
  for (let k = 0; k < n; k++) {
    const i = keep === 'first' ? k : n - 1 - k;
    const h = key(i);
    if (seen.has(h)) out[i] = 1;
    else seen.add(h);
  }
  return out;
}

/** Deterministic sample positions (Mulberry32 PRNG when a seed is given). */
export function samplePositions(length: number, n: number, seed?: number): number[] {
  let rand = Math.random;
  if (seed !== undefined) {
    let a = seed >>> 0;
    rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pos = Array.from({ length }, (_, i) => i);
  const k = Math.min(n, length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (length - i));
    [pos[i], pos[j]] = [pos[j], pos[i]];
  }
  return pos.slice(0, k);
}
