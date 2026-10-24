import { aggregate, quantile, type AggOptions, type QuantileInterpolation } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { DISPLAY, displayPositions, formatColumn, formatIndex, renderTable } from './core/format.ts';
import { Index, Slice } from './core/indexes.ts';
import { argsort, sortKeyFromColumn, type NaPosition } from './core/sort.ts';
import { correlation, covariance, interpolate, kurtosis, rankPositions, skewness, type CorrMethod, type InterpolateOptions, type RankOptions } from './core/stats.ts';
import { EWM, Expanding, Rolling, type EwmOptions, type RollingOptions } from './window.ts';
import { asfreq, Resampler, type ResampleOptions } from './resample.ts';
import { plotAccessor, type PlotAccessor } from './plot.ts';
import { onAxis, unstack, xs } from './levels.ts';
import { combineFirst, compare, explodeSeries, update } from './combine.ts';
import { toHdf } from './io/hdf.ts';

import { atTimePositions, betweenTimePositions, shiftIndex, toPeriodIndex, toTimestampIndex, truncatePositions, tzConvertIndex, tzLocalizeIndex } from './timeindex.ts';
import type { Ambiguous, Nonexistent } from './core/tz.ts';

import { isNumericDType, isNumericStorage, NULLABLE_DTYPES, type AggName, type DType, type Label } from './core/types.ts';
import { normalizeFreq, parseDate, parsePeriodString, parseTimedelta, Period, periodOrdinal, Timedelta } from './core/time.ts';
import { compareValues, hashKey, isNA, valuesEqual } from './core/values.ts';
import { DateOffset } from './core/offsets.ts';
import { fromWall, toWall } from './core/tz.ts';
import { CategoricalMethods, DatetimeMethods, StringMethods } from './accessors.ts';
import { DataFrame } from './frame.ts';
import { resolveGroupKeys, SeriesGroupBy, type GroupByOptions, type GroupKey } from './groupby.ts';

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

/** Options of the arithmetic methods (`add`, `sub`, ...), like pandas' `fill_value`. */
export interface ArithOptions {
  /** Replaces a missing value on one side (after alignment) before computing; missing on both sides stays NA. */
  fillValue?: unknown;
}

/** Operand of arithmetic and comparison methods. */
export type Operand = Series | readonly unknown[] | Float64Array | number | bigint | string | boolean | Date | Timedelta | Period | DateOffset | null;

export type RowSelector = Label | readonly Label[] | Mask | Slice;

/** An aggregation: a name such as 'sum' / 'mean', or a function reducing a Series. */
export type AggFunc = AggName | ((s: Series) => unknown);

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

/**
 * Resolves a label-based row key. On a MultiIndex a scalar or a shorter tuple
 * selects by prefix (`drop` = levels matched, which pandas removes from the
 * result); a full tuple is a scalar key; an array of tuples selects several.
 */
export function resolveRows(key: RowSelector, index: Index): { pos: number[]; scalar: boolean; drop: number } {
  if (key instanceof Slice) return { pos: key.labelPositions(index), scalar: false, drop: 0 };
  if (isMask(key)) return { pos: maskPositions(key, index), scalar: false, drop: 0 };
  const multi = index.isMulti;
  const find = (l: Label): number[] => {
    if (multi) {
      const prefix = Array.isArray(l) ? (l as readonly Label[]) : [l];
      const locs = index.getLocPrefix(prefix);
      if (locs.length === 0) throw new KeyError(l);
      return locs;
    }
    const locs = index.getLoc(l);
    if (locs.length === 0) throw new KeyError(l);
    return [...locs];
  };
  if (Array.isArray(key)) {
    if (multi && !Array.isArray(key[0])) {
      const pos = find(key as readonly Label[]);
      const full = key.length === index.nlevels;
      return { pos, scalar: full, drop: full ? 0 : key.length };
    }
    return { pos: (key as readonly Label[]).flatMap(find), scalar: false, drop: 0 };
  }
  if (multi) return { pos: find(key as Label), scalar: false, drop: 1 };
  return { pos: find(key as Label), scalar: true, drop: 0 };
}

/** Row positions selected by a label-based key. */
export function labelPositions(key: RowSelector, index: Index): number[] {
  return resolveRows(key, index).pos;
}

/** Drops the first `drop` levels of a MultiIndex selection, as pandas does for partial keys. */
export function dropMatchedLevels(index: Index, drop: number): Index {
  if (drop <= 0 || !index.isMulti || drop >= index.nlevels) return index;
  return index.droplevel(Array.from({ length: drop }, (_, l) => l));
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
  /** @internal Replaced (never mutated) by the `set*` methods. */
  _col: Column;
  index: Index;
  name: string | null;

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
    const { pos, scalar, drop } = resolveRows(key, this.index);
    if (scalar && pos.length === 1) return this._col.get(pos[0]);
    const out = this.take(pos);
    return drop ? out.with(out._col, dropMatchedLevels(out.index, drop)) : out;
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
  /** Sample skewness (bias corrected). */
  skew(): number { return skewness(numericView(this._col, 'skew')); }
  /** Excess kurtosis (bias corrected). */
  kurt(): number { return kurtosis(numericView(this._col, 'kurt')); }
  kurtosis(): number { return this.kurt(); }

  // ------------------------------------------------------------------ windows

  /** Rolling window of `window` rows, or a time span ('3D', '2h') over a datetime index. */
  rolling(window: number | string | Timedelta, options: RollingOptions = {}): Rolling<Series> {
    return new Rolling(this, window, options);
  }

  /** Expanding window (all rows up to the current one). */
  expanding(options: { minPeriods?: number } = {}): Expanding<Series> {
    return new Expanding(this, options);
  }

  /** Exponentially weighted window; pass one of com, span, halflife or alpha. */
  ewm(options: EwmOptions): EWM<Series> {
    return new EWM(this, options);
  }

  /** Standard error of the mean. */
  sem(opts?: AggOptions): number { return this.agg1('sem', opts) as number; }
  /** Number of non-missing values. */
  count(): number { return this.agg1('count') as number; }
  nunique(): number { return this.agg1('nunique') as number; }

  /** Quantile(s) of the non-missing values; `interpolation` as in pandas (default 'linear'). */
  quantile(q: number, options?: { interpolation?: QuantileInterpolation }): number;
  quantile(q: readonly number[], options?: { interpolation?: QuantileInterpolation }): Series;
  quantile(q: number | readonly number[], options: { interpolation?: QuantileInterpolation } = {}): number | Series {
    const how = options.interpolation ?? 'linear';
    if (typeof q === 'number') return quantile(this._col, q, null, how);
    return new Series(q.map((x) => quantile(this._col, x, null, how)), { index: [...q], name: this.name });
  }

  /** Calls `fn(this, ...args)`, for chaining custom steps: `s.pipe(clean).pipe(scale, 10)`. */
  pipe<T, A extends unknown[]>(fn: (s: Series, ...args: A) => T, ...args: A): T {
    return fn(this, ...args);
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
      const c = this._col.dtype === 'bool' || this._col.dtype === 'boolean' || this._col.dtype === 'bigint' ? Column.from(numericView(this._col), 'float64') : this._col;
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
    if (this.dtype === 'category') {
      for (const c of this._col.meta.categories!) if (!counts.has(hashKey(c))) counts.set(hashKey(c), { value: c, n: 0 });
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
    const src = numericView(this._col, 'cumulative op');
    const out = new Float64Array(this.length);
    let acc = init;
    for (let i = 0; i < out.length; i++) {
      if (Number.isNaN(src[i])) { out[i] = NaN; continue; }
      acc = step(acc, src[i]);
      out[i] = acc;
    }
    return this.with(new Column(numericResultDType(this.dtype, true), out));
  }

  cumsum(): Series { return this.cumulative((a, v) => a + v, 0); }
  cumprod(): Series { return this.cumulative((a, v) => a * v, 1); }
  cummax(): Series { return this.cumulative((a, v) => Math.max(a, v), -Infinity); }
  cummin(): Series { return this.cumulative((a, v) => Math.min(a, v), Infinity); }

  /**
   * Shifts values by `periods` positions (filling with NA or `fillValue`), or
   * with `{ freq }` shifts the datetime index instead of the data.
   */
  shift(periods = 1, options: { freq?: string | DateOffset; fillValue?: unknown } | unknown = {}): Series {
    const opts = isPlainObject(options) ? (options as { freq?: string | DateOffset; fillValue?: unknown }) : { fillValue: options };
    if (opts.freq !== undefined) return shiftIndex(this, periods, opts.freq);
    const fillValue = opts.fillValue ?? null;
    const n = this.length;
    const pos = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i - periods;
      pos[i] = j >= 0 && j < n ? j : -1;
    }
    let col = this._col.take(pos);
    if (!isNA(fillValue)) col = col.mapLike((v, i) => (pos[i] < 0 ? fillValue : v));
    return this.with(col);
  }

  /** Label of the first non-missing value (null when none). */
  firstValidIndex(): Label {
    for (let i = 0; i < this.length; i++) if (!this._col.isNA(i)) return this.index.labels[i];
    return null;
  }

  lastValidIndex(): Label {
    for (let i = this.length - 1; i >= 0; i--) if (!this._col.isNA(i)) return this.index.labels[i];
    return null;
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
    const src = numericView(this._col, 'this operation');
    const out = new Float64Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = fn(src[i]);
    return this.with(new Column(numericResultDType(this.dtype, keepInt), out));
  }

  abs(): Series { return this.numericMap(Math.abs, true); }

  /** Rounds like NumPy / pandas: `rint(v * 10^d) / 10^d`, ties to even (2.5 → 2, 0.125 → 0.12). */
  round(decimals = 0): Series {
    const f = 10 ** Math.abs(decimals);
    const fn = decimals >= 0 ? (v: number) => rintHalfEven(v * f) / f : (v: number) => rintHalfEven(v / f) * f;
    return this.numericMap(fn, decimals >= 0);
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

  /** Casts to `dtype`; `category` accepts `{categories, ordered}`, `period` accepts `{freq}`. */
  astype(dtype: DType, options: { categories?: readonly unknown[]; ordered?: boolean; freq?: string } = {}): Series {
    const meta = { categories: options.categories, ordered: options.ordered, freq: options.freq ? normalizeFreq(options.freq) : undefined };
    return this.with(this._col.astype(dtype, meta));
  }

  /** Converts to the best nullable dtypes: Int64, Float64, boolean, string (pandas `convert_dtypes`). */
  convertDtypes(): Series {
    return this.with(convertColumn(this._col));
  }

  /** Categorical helpers (`series.cat`). */
  get cat(): CategoricalMethods {
    return new CategoricalMethods(this);
  }

  /** Replaces values equal to `from` (or every key of a mapping) with `to`. */
  replace(from: unknown, to?: unknown): Series {
    const m = new Map<unknown, unknown>();
    if (from instanceof Map) for (const [k, v] of from) m.set(hashKey(k), v);
    else if (isPlainObject(from)) for (const [k, v] of Object.entries(from)) m.set(k, v);
    else m.set(hashKey(from), to);
    return this.with(this._col.mapLike((v) => {
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
    return this.with(this._col.mapLike((v, i) => (Boolean(hit[i]) === replaceIfTrue ? (aligned ? aligned._col.get(i) : other) : v)));
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
    return this.with(this._col.mapLike((v, i) => (isNA(v) ? (other ? other._col.get(i) : value) : v)));
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

  /**
   * Fills NaN by interpolation. Methods: linear (default), time, index/values,
   * nearest, zero/pad/ffill, bfill, quadratic, cubic, spline, polynomial, pchip, akima.
   */
  interpolate(options: InterpolateOptions = {}): Series {
    const y = numericView(this._col, 'interpolate');
    const method = options.method ?? 'linear';
    let x: ArrayLike<number>;
    if (method === 'time') {
      x = this.index.labels.map((l) => {
        if (!(l instanceof Date)) throw new TypeError("interpolate(method='time') requires a datetime index");
        return l.getTime();
      });
    } else if (method === 'index' || method === 'values') {
      x = this.index.labels.map((l) => (l instanceof Date ? l.getTime() : Number(l)));
    } else x = Float64Array.from({ length: this.length }, (_, i) => i);
    const out = interpolate(y, x, options);
    return this.with(new Column(this.dtype === 'Float64' || this.dtype === 'Int64' ? 'Float64' : 'float64', out));
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

  /** Ranks (1-based); `method`: average (default), min, max, first, dense. */
  rank(options: RankOptions = {}): Series {
    const col = this._col;
    const raw = (i: number) => col.raw(i);
    const out = rankPositions(this.length, (i) => col.isNA(i), (a, b) => compareValues(raw(a), raw(b)), options);
    return this.with(new Column('float64', out));
  }

  /** Correlation with another Series (aligned on the index). */
  corr(other: Series, options: { method?: CorrMethod; minPeriods?: number } = {}): number {
    const { left, right } = this._align(other);
    return correlation(numericView(left), numericView(right!), options.method, options.minPeriods);
  }

  /** Sample covariance with another Series (aligned on the index). */
  cov(other: Series, options: { minPeriods?: number; ddof?: number } = {}): number {
    const { left, right } = this._align(other);
    return covariance(numericView(left), numericView(right!), options.minPeriods, options.ddof);
  }

  /** Correlation of the series with itself shifted by `lag`. */
  autocorr(lag = 1): number {
    return this.corr(this.shift(lag));
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

  private arith(op: string, other: Operand, reverse = false, options: ArithOptions = {}): Series {
    if (other instanceof DateOffset) return this.applyOffset(other, op, reverse);
    let { left, right, scalar, index } = this._align(other);
    const fill = options.fillValue;
    if (fill !== undefined && !isNA(fill)) {
      const n = left.length;
      const leftNA = Array.from({ length: n }, (_, i) => isNA(left.get(i)));
      const rightNA = Array.from({ length: n }, (_, i) => isNA(right ? right.get(i) : scalar));
      if (leftNA.some((na, i) => na && !rightNA[i])) left = left.mapLike((v, i) => (leftNA[i] && !rightNA[i] ? fill : v));
      if (right && rightNA.some((na, i) => na && !leftNA[i])) right = right.mapLike((v, i) => (rightNA[i] && !leftNA[i] ? fill : v));
    }
    const fn = ARITH[op];
    const n = left.length;
    const rightDtype: DType = right ? right.dtype : scalarDType(scalar);
    const name = other instanceof Series && other.name !== this.name ? null : this.name;

    if (numericLike(left.dtype) && numericLike(rightDtype)) {
      const a = left.data as ArrayLike<number>;
      const b = right ? (right.data as ArrayLike<number>) : null;
      const sv = scalarNumber(scalar, left.dtype);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = a[i];
        const y = b ? b[i] : sv;
        out[i] = reverse ? fn(y, x) : fn(x, y);
      }
      const lt = reverse ? rightDtype : left.dtype;
      const rt = reverse ? left.dtype : rightDtype;
      const dtype = arithDType(op, lt, rt, out);
      const meta = dtype === 'period' ? (left.dtype === 'period' ? left.meta : right!.meta) : {};
      return new Series(new Column(dtype, out, meta), { index, name });
    }

    // Generic path (strings, bigints, objects): JS operators with NA propagation.
    const g = JS_OPS[op];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = left.get(i);
      let y = right ? right.get(i) : scalar;
      if (isNA(x) || isNA(y)) { out[i] = null; continue; }
      if (typeof x === 'bigint' || typeof y === 'bigint') {
        if (op === 'div' || op === 'pow' && Number(y) < 0) { out[i] = reverse ? Number(y) / Number(x) : Number(x) / Number(y); continue; }
        if (typeof x === 'number') x = BigInt(Math.trunc(x));
        if (typeof y === 'number') y = BigInt(Math.trunc(y));
      }
      out[i] = reverse ? g(y, x) : g(x, y);
    }
    return new Series(out, { index, name });
  }

  /** Datetime ± calendar offset, applied on wall-clock time. */
  private applyOffset(offset: DateOffset, op: string, reverse: boolean): Series {
    if (this.dtype !== 'datetime') throw new TypeError(`Cannot apply a DateOffset to dtype ${this.dtype}`);
    if (op !== 'add' && !(op === 'sub' && !reverse)) throw new TypeError(`Unsupported operation with DateOffset: ${op}`);
    const tz = this._col.meta.tz ?? null;
    const n = op === 'sub' ? -offset.n : offset.n;
    const out = (this._col.data as Float64Array).map((t) => {
      if (t !== t) return NaN;
      const w = offset.apply(toWall(t, tz), n);
      return tz ? fromWall(w, tz, 'earliest', 'shift_forward') : w;
    });
    return this.with(new Column('datetime', out, { tz }));
  }

  add(other: Operand, options: ArithOptions = {}): Series { return this.arith('add', other, false, options); }
  sub(other: Operand, options: ArithOptions = {}): Series { return this.arith('sub', other, false, options); }
  mul(other: Operand, options: ArithOptions = {}): Series { return this.arith('mul', other, false, options); }
  div(other: Operand, options: ArithOptions = {}): Series { return this.arith('div', other, false, options); }
  truediv(other: Operand, options: ArithOptions = {}): Series { return this.arith('div', other, false, options); }
  mod(other: Operand, options: ArithOptions = {}): Series { return this.arith('mod', other, false, options); }
  pow(other: Operand, options: ArithOptions = {}): Series { return this.arith('pow', other, false, options); }
  floordiv(other: Operand, options: ArithOptions = {}): Series { return this.arith('floordiv', other, false, options); }
  radd(other: Operand, options: ArithOptions = {}): Series { return this.arith('add', other, true, options); }
  rsub(other: Operand, options: ArithOptions = {}): Series { return this.arith('sub', other, true, options); }
  rmul(other: Operand, options: ArithOptions = {}): Series { return this.arith('mul', other, true, options); }
  rdiv(other: Operand, options: ArithOptions = {}): Series { return this.arith('div', other, true, options); }
  rmod(other: Operand, options: ArithOptions = {}): Series { return this.arith('mod', other, true, options); }
  rpow(other: Operand, options: ArithOptions = {}): Series { return this.arith('pow', other, true, options); }
  rfloordiv(other: Operand, options: ArithOptions = {}): Series { return this.arith('floordiv', other, true, options); }
  neg(): Series { return this.mul(-1); }

  private cmp(op: string, other: Operand): Series {
    const { left, right, scalar, index } = this._align(other);
    const test = CMP[op];
    const n = left.length;
    const ordering = op !== 'eq' && op !== 'ne';
    const nullable = NULLABLE_DTYPES.has(left.dtype) || (right !== null && NULLABLE_DTYPES.has(right.dtype));
    const aAt = comparable(left, ordering);
    let bAt: (i: number) => unknown;
    let bNA: (i: number) => boolean;
    if (right) {
      const r = coerceLike(right, left, ordering);
      bAt = comparable(r, ordering);
      bNA = (i) => r.isNA(i);
    } else {
      const sv = coerceScalar(scalar, left, ordering);
      bAt = () => sv;
      bNA = () => isNA(sv);
    }
    const out = nullable ? new Float64Array(n) : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (left.isNA(i) || bNA(i)) { out[i] = nullable ? NaN : op === 'ne' ? 1 : 0; continue; }
      const x = aAt(i);
      const y = bAt(i);
      const c = ordering ? compareValues(x, y) : valuesEqual(x, y) ? 0 : 1;
      out[i] = test(c) ? 1 : 0;
    }
    return new Series(new Column(nullable ? 'boolean' : 'bool', out), { index, name: this.name });
  }

  eq(other: Operand): Series { return this.cmp('eq', other); }
  ne(other: Operand): Series { return this.cmp('ne', other); }
  lt(other: Operand): Series { return this.cmp('lt', other); }
  le(other: Operand): Series { return this.cmp('le', other); }
  gt(other: Operand): Series { return this.cmp('gt', other); }
  ge(other: Operand): Series { return this.cmp('ge', other); }

  /** Boolean logic; with the nullable `boolean` dtype NA follows Kleene logic like pandas. */
  private logical(other: Operand, kind: 'and' | 'or' | 'xor'): Series {
    const { left, right, scalar, index } = this._align(other);
    const kleene = left.dtype === 'boolean' || right?.dtype === 'boolean';
    const val = (c: Column, i: number) => (c.isNA(i) ? (kleene ? NaN : 0) : c.get(i) ? 1 : 0);
    const sv = isNA(scalar) ? (kleene ? NaN : 0) : scalar ? 1 : 0;
    const out = kleene ? new Float64Array(left.length) : new Uint8Array(left.length);
    for (let i = 0; i < out.length; i++) {
      const a = val(left, i);
      const b = right ? val(right, i) : sv;
      if (kind === 'and') out[i] = a === 0 || b === 0 ? 0 : a !== a || b !== b ? NaN : 1;
      else if (kind === 'or') out[i] = a === 1 || b === 1 ? 1 : a !== a || b !== b ? NaN : 0;
      else out[i] = a !== a || b !== b ? NaN : a !== b ? 1 : 0;
    }
    return new Series(new Column(kleene ? 'boolean' : 'bool', out), { index, name: this.name });
  }

  and(other: Operand): Series { return this.logical(other, 'and'); }
  or(other: Operand): Series { return this.logical(other, 'or'); }
  xor(other: Operand): Series { return this.logical(other, 'xor'); }

  not(): Series {
    if (this.dtype === 'boolean') {
      const src = this._col.data as Float64Array;
      return this.with(new Column('boolean', src.map((v) => (v !== v ? NaN : 1 - v))));
    }
    const out = new Uint8Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = !this._col.isNA(i) && this._col.get(i) ? 0 : 1;
    return this.with(new Column('bool', out));
  }

  // --------------------------------------------------------------- assignment

  /**
   * In-place assignment by label, like `s.loc[key] = value`. A new scalar label
   * appends a row. `value` may be a scalar, an array (one per selected row) or a
   * Series (aligned by label).
   */
  setLoc(key: RowSelector | ((s: Series) => Mask), value: unknown): this {
    const k = typeof key === 'function' ? key(this) : key;
    if (isScalarKey(k, this.index) && !this.index.has(k as Label)) {
      this._col = Column.fromLike([...this._col.toArray(), value], this._col);
      this.index = new Index([...this.index.labels, k as Label], { name: this.index.name, names: this.index.names });
      return this;
    }
    return this.assignAt(labelPositions(k, this.index), value);
  }

  /** In-place assignment by position, like `s.iloc[key] = value`. */
  setIloc(key: number | readonly number[] | Mask | Slice | ((s: Series) => Mask), value: unknown): this {
    const k = typeof key === 'function' ? key(this) : key;
    return this.assignAt(positionalPositions(k, this.length), value);
  }

  setAt(label: Label, value: unknown): this {
    return this.setLoc(label as RowSelector, value);
  }

  setIat(position: number, value: unknown): this {
    return this.setIloc(position, value);
  }

  private assignAt(pos: readonly number[], value: unknown): this {
    let at: (k: number) => unknown;
    if (value instanceof Series) at = (k) => value.get(this.index.labels[pos[k]], null);
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const arr = value as ArrayLike<unknown>;
      if (arr.length !== pos.length) throw new RangeError(`Cannot set ${arr.length} values into ${pos.length} positions`);
      at = (k) => arr[k];
    } else at = () => value;
    this._col = this._col.setAt(pos, at);
    return this;
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

  resetIndex(options?: { drop?: false; name?: string }): DataFrame;
  resetIndex(options: { drop: true }): Series;
  resetIndex(options?: { drop?: boolean; name?: string }): DataFrame | Series;
  resetIndex(options: { drop?: boolean; name?: string } = {}): DataFrame | Series {
    if (options.drop) return this.with(this._col, Index.range(this.length));
    return this.toFrame(options.name ?? this.name ?? '0').resetIndex();
  }

  /** Groups values by Series, arrays of keys, functions of the index label, and/or index levels. */
  groupby(by: GroupKey | readonly GroupKey[] | null, options: GroupByOptions = {}): SeriesGroupBy {
    if (options.asIndex === false) throw new TypeError('asIndex: false is only valid when grouping a DataFrame');
    const base = DataFrame._fromColumns(new Map([['\u0000value', this._col]]), this.index);
    const r = resolveGroupKeys(base, by, options.level);
    return new SeriesGroupBy(r.frame, r.by, '\u0000value', options, r.names, this.name);
  }




  /** One row per element of list-like values. */
  explode(options: { ignoreIndex?: boolean } = {}): Series {
    return explodeSeries(this, options.ignoreIndex);
  }

  combineFirst(other: Series): Series {
    return combineFirst(this, other);
  }

  /** In-place update with the non-missing values of `other`. */
  update(other: Series, options: { overwrite?: boolean } = {}): this {
    update(this, other, options);
    return this;
  }

  /** Differences with `other` as self/other columns. */
  compare(other: Series, options: { keepShape?: boolean; keepEqual?: boolean; resultNames?: [string, string] } = {}): DataFrame {
    return compare(this, other, options);
  }

  /** Bytes used by the values (and index), like `memory_usage`. */
  memoryUsage(options: { index?: boolean; deep?: boolean } = {}): number {
    return (this.toFrame('v').memoryUsage(options).sum() as number);
  }

  /** CSV text of the series (with its index); writes to `path` when given. */
  toCsv(path?: string, options: Parameters<DataFrame['toCsv']>[1] = {}): string {
    return this.toFrame(this.name ?? '0').toCsv(path, options);
  }

  toJson(path?: string, options: Parameters<DataFrame['toJson']>[1] = {}): string {
    return this.toFrame(this.name ?? '0').toJson(path, options);
  }

  /** Writes HDF5 in pandas' 'table' format (requires the optional `h5wasm`). */
  toHdf(path: string, key: string, options: { mode?: 'a' | 'w' } = {}): Promise<void> {
    return toHdf(this, path, key, options);
  }

  /** SVG charts: `plot({ kind })` or `plot.line()`, `plot.bar()`, `plot.hist()`, ... */
  get plot(): PlotAccessor {
    return plotAccessor(this);
  }

  // ------------------------------------------------------------- MultiIndex

  /** Cross-section at `key` of an index level (or of the columns with `axis: 1`). */
  xs(key: Label, options: { level?: number | string | readonly (number | string)[]; axis?: 0 | 1 | 'index' | 'columns'; dropLevel?: boolean } = {}): unknown {
    return xs(this, key, options);
  }

  /** Removes index level(s) (or column levels with `axis: 1`). */
  droplevel(level: number | string | readonly (number | string)[], options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): Series {
    return onAxis(this, options.axis, (i) => i.droplevel(level));
  }

  swaplevel(i: number | string = -2, j: number | string = -1, options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): Series {
    return onAxis(this, options.axis, (x) => x.swaplevel(i, j));
  }

  reorderLevels(order: readonly (number | string)[], options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): Series {
    return onAxis(this, options.axis, (x) => x.reorderLevels(order));
  }

  /** Pivots an index level into columns. */
  unstack(options: { level?: number | string | readonly (number | string)[]; fillValue?: unknown } = {}): DataFrame {
    return unstack(this, options) as DataFrame;
  }

  // -------------------------------------------------------------- time series

  /** @internal Same data with another index. */
  _withIndex(index: Index): this {
    return this.with(this._col, index) as this;
  }

  /** Groups by time bins, like `resample('ME')` / `resample('15min')`. */
  resample(rule: string | DateOffset, options: ResampleOptions = {}): Resampler<Series> {
    return new Resampler(this, rule, options);
  }

  /** Conforms a datetime index to `freq`, optionally filling ('ffill' / 'bfill'). */
  asfreq(freq: string | DateOffset, options: { method?: 'pad' | 'ffill' | 'bfill' | 'backfill'; fillValue?: unknown } = {}): Series {
    return asfreq(this, freq, options) as Series;
  }

  /** Localizes a naive datetime index to `tz` (or removes the zone with null). */
  tzLocalize(tz: string | null, options: { ambiguous?: Ambiguous; nonexistent?: Nonexistent } = {}): Series {
    return tzLocalizeIndex(this, tz, options);
  }

  /** Converts a tz-aware datetime index to another zone. */
  tzConvert(tz: string | null): Series {
    return tzConvertIndex(this, tz);
  }

  /** Rows at a time of day, e.g. `atTime('09:30')`. */
  atTime(time: string): Series {
    return this.take(atTimePositions(this.index, time)) as Series;
  }

  /** Rows between two times of day, e.g. `betweenTime('09:00', '17:00')`. */
  betweenTime(start: string, end: string, options: { inclusive?: 'both' | 'neither' | 'left' | 'right' } = {}): Series {
    return this.take(betweenTimePositions(this.index, start, end, options.inclusive)) as Series;
  }

  /** Rows with index labels between `before` and `after` (inclusive). */
  truncate(options: { before?: Label | string; after?: Label | string } = {}): Series {
    return this.take(truncatePositions(this.index, options.before, options.after)) as Series;
  }

  /** Converts a datetime index to a period index. */
  toPeriod(freq = 'D'): Series {
    return toPeriodIndex(this, freq);
  }

  /** Converts a period index to datetimes at the start (or end) of each period. */
  toTimestamp(how: 'start' | 'end' = 'start'): Series {
    return toTimestampIndex(this, how);
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

// ------------------------------------------------------------ operator helpers

const JS_OPS: Record<string, (a: any, b: any) => unknown> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => (typeof a === 'string' ? a.repeat(b) : typeof b === 'string' ? b.repeat(a) : a * b),
  div: (a, b) => a / b,
  mod: (a, b) => (typeof a === 'bigint' ? ((a % b) + b) % b : ((a % b) + b) % b),
  pow: (a, b) => a ** b,
  floordiv: (a, b) => (typeof a === 'bigint' ? (a / b) - ((a % b !== 0n && (a < 0n) !== (b < 0n)) ? 1n : 0n) : Math.floor(a / b)),
};

function numericLike(d: DType): boolean {
  return isNumericStorage(d);
}

function scalarDType(v: unknown): DType {
  if (isNA(v)) return 'float64';
  if (v instanceof Date) return 'datetime';
  if (v instanceof Timedelta) return 'timedelta';
  if (v instanceof Period) return 'period';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int64' : 'float64';
  if (typeof v === 'bigint') return 'bigint';
  if (typeof v === 'string') return 'string';
  return 'object';
}

function scalarNumber(v: unknown, like: DType): number {
  if (isNA(v)) return NaN;
  if (v instanceof Date) return v.getTime();
  if (v instanceof Timedelta) return v.ms;
  if (v instanceof Period) return v.ordinal;
  if (typeof v === 'string' && like === 'timedelta') return parseTimedelta(v);
  return Number(v);
}

/** Result dtype of a numeric kernel, following pandas' promotion rules. */
function arithDType(op: string, lt: DType, rt: DType, out: Float64Array): DType {
  const temporal = (d: DType) => d === 'datetime' || d === 'timedelta' || d === 'period';
  if (temporal(lt) || temporal(rt)) {
    if (lt === 'datetime' && rt === 'datetime') return 'timedelta';
    if (lt === 'period' && rt === 'period') return 'int64';
    if ((lt === 'datetime' || rt === 'datetime') && (op === 'add' || op === 'sub')) return 'datetime';
    if ((lt === 'period' || rt === 'period') && (op === 'add' || op === 'sub')) return 'period';
    if (lt === 'timedelta' && rt === 'timedelta') return op === 'div' ? 'float64' : op === 'floordiv' ? 'int64' : 'timedelta';
    if (lt === 'timedelta' || rt === 'timedelta') return 'timedelta';
    return 'float64';
  }
  const ints = (d: DType) => d === 'int64' || d === 'bool' || d === 'Int64' || d === 'boolean';
  const nullable = NULLABLE_DTYPES.has(lt) || NULLABLE_DTYPES.has(rt);
  const integral = ints(lt) && ints(rt) && op !== 'div' && !(op === 'pow' && out.some((v) => v === v && !Number.isInteger(v)));
  if (nullable) return integral ? 'Int64' : 'Float64';
  return integral && !out.some(Number.isNaN) ? 'int64' : 'float64';
}

/** Accessor for primitives to compare: numbers for numeric/temporal storage, codes for ordered categories. */
function comparable(col: Column, ordering: boolean): (i: number) => unknown {
  if (isNumericStorage(col.dtype)) {
    const d = col.data as ArrayLike<number>;
    return (i) => d[i];
  }
  if (col.dtype === 'category' && ordering) {
    if (!col.meta.ordered) throw new TypeError('Unordered Categoricals can only compare equality or not');
    const d = col.data as Int32Array;
    return (i) => d[i];
  }
  return (i) => col.get(i);
}

function coerceLike(right: Column, left: Column, ordering: boolean): Column {
  if ((left.dtype === 'datetime' || left.dtype === 'timedelta' || left.dtype === 'period') && right.dtype !== left.dtype) {
    return right.astype(left.dtype, left.meta);
  }
  if (left.dtype === 'category' && ordering) {
    const pos = new Map(left.meta.categories!.map((c, i) => [hashKey(c), i]));
    return Column.from(right.toArray().map((v) => (isNA(v) ? NaN : categoryCode(pos, v))), 'float64');
  }
  return right;
}

function categoryCode(pos: Map<unknown, number>, v: unknown): number {
  const c = pos.get(hashKey(v));
  if (c === undefined) throw new TypeError(`Value ${String(v)} is not among the categories`);
  return c;
}

function coerceScalar(v: unknown, left: Column, ordering: boolean): unknown {
  if (isNA(v)) return null;
  switch (left.dtype) {
    case 'datetime':
      return v instanceof Date ? v.getTime() : typeof v === 'string' ? parseDate(v) : v;
    case 'timedelta':
      return v instanceof Timedelta ? v.ms : typeof v === 'string' ? parseTimedelta(v) : v;
    case 'period': {
      const freq = left.meta.freq!;
      if (v instanceof Period) return v.freq === freq ? v.ordinal : periodOrdinal(v.startTime.getTime(), freq);
      if (v instanceof Date) return periodOrdinal(v.getTime(), freq);
      return typeof v === 'string' ? periodOrdinal(parsePeriodString(v), freq) : v;
    }
    case 'category':
      if (!ordering) return v;
      if (!left.meta.ordered) throw new TypeError('Unordered Categoricals can only compare equality or not');
      return categoryCode(new Map(left.meta.categories!.map((c, i) => [hashKey(c), i])), v);
    default:
      if (isNumericStorage(left.dtype)) {
        if (typeof v === 'boolean') return Number(v);
        if (v instanceof Date) return v.getTime();
      }
      return v;
  }
}

export function isScalarKey(key: unknown, index: Index): boolean {
  if (key instanceof Slice || isMask(key)) return false;
  return !(Array.isArray(key) && !(index.nlevels > 1 && !Array.isArray(key[0])));
}

/** Numeric values of a column as numbers (bigint converted), or a TypeError. */
export function numericView(col: Column, what = 'this operation'): ArrayLike<number> {
  if (col.dtype === 'bigint') return Float64Array.from(col.toArray(), (v) => (v === null ? NaN : Number(v)));
  if (!isNumericDType(col.dtype)) throw new TypeError(`Cannot compute ${what} on dtype ${col.dtype}`);
  return col.data as ArrayLike<number>;
}

function numericResultDType(d: DType, keepInt: boolean): DType {
  if (d === 'Int64' || d === 'boolean') return keepInt ? 'Int64' : 'Float64';
  if (d === 'Float64') return 'Float64';
  if ((d === 'int64' || d === 'bool') && keepInt) return 'int64';
  return 'float64';
}

/** Best nullable dtype for a column (pandas `convert_dtypes`). */
export function convertColumn(col: Column): Column {
  switch (col.dtype) {
    case 'int64': return col.astype('Int64');
    case 'bool': return col.astype('boolean');
    case 'float64': {
      const d = col.data as Float64Array;
      const integral = d.every((v) => v !== v || Number.isInteger(v));
      return col.astype(integral && d.some((v) => v === v) ? 'Int64' : 'Float64');
    }
    case 'object': {
      const vals = col.toArray().filter((v) => !isNA(v));
      if (vals.length === 0) return col;
      if (vals.every((v) => typeof v === 'boolean')) return col.astype('boolean');
      if (vals.every((v) => typeof v === 'string')) return col.astype('string');
      if (vals.every((v) => typeof v === 'number' && Number.isInteger(v))) return col.astype('Int64');
      if (vals.every((v) => typeof v === 'number')) return col.astype('Float64');
      return col;
    }
    default:
      return col;
  }
}

/** Nearest integer, ties to even (C `rint`). */
function rintHalfEven(y: number): number {
  if (!Number.isFinite(y)) return y;
  const f = Math.floor(y);
  const diff = y - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
