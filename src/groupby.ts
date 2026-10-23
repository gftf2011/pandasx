import { aggregate, NUMERIC_AGGS } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { isNumericDType, NULLABLE_DTYPES, type AggName, type DType, type Label } from './core/types.ts';
import { compareValues, hashKey, isNA } from './core/values.ts';
import { colKey, DataFrame } from './frame.ts';
import { concat } from './reshape.ts';
import { samplePositions, Series, type AggFunc } from './series.ts';
import type { RankOptions } from './core/stats.ts';
import { EWM, Expanding, Rolling, type EwmOptions, type RollingOptions } from './window.ts';
import { Resampler, type ResampleOptions } from './resample.ts';

/** A grouping key: column name, Series (aligned on the index), array of keys, or function of the index label. */
export type GroupKey = string | Series | readonly unknown[] | ((label: Label) => unknown);

export interface GroupByOptions {
  /** Group by index level(s) (number or name) instead of / in addition to `by`. */
  level?: number | string | readonly (number | string)[];
  /** Sort group keys (default true). */
  sort?: boolean;
  /** Exclude groups whose key contains NA (default true). */
  dropna?: boolean;
  /** Use group keys as the result index (default true); false puts them in columns. */
  asIndex?: boolean;
}


/** `{column: func | func[]}`, or named aggregation `{output: [column, func]}`. */
export type AggSpec = AggFunc | readonly AggFunc[] | Record<string, AggFunc | readonly AggFunc[] | readonly [string, AggFunc]>;

interface Groups {
  keys: Label[][];
  rows: number[][];
}

export function computeGroups(keyCols: readonly Column[], n: number, sort: boolean, dropna: boolean): Groups {
  const ids = new Map<unknown, number>();
  const keys: Label[][] = [];
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const tuple = keyCols.map((c) => c.get(i) as Label);
    if (dropna && tuple.some(isNA)) continue;
    const h = tuple.length === 1 ? hashKey(tuple[0]) : hashKey(tuple);
    let g = ids.get(h);
    if (g === undefined) {
      g = keys.length;
      ids.set(h, g);
      keys.push(tuple.map((v) => (isNA(v) ? null : v)));
      rows.push([]);
    }
    rows[g].push(i);
  }
  if (!sort) return { keys, rows };
  const order = keys.map((_, g) => g).sort((a, b) => {
    const ka = keys[a], kb = keys[b];
    for (let l = 0; l < ka.length; l++) {
      if (ka[l] === null || kb[l] === null) { if (ka[l] !== kb[l]) return ka[l] === null ? 1 : -1; continue; }
      const c = compareValues(ka[l], kb[l]);
      if (c !== 0) return c;
    }
    return 0;
  });
  return { keys: order.map((g) => keys[g]), rows: order.map((g) => rows[g]) };
}

/** Output dtype of an aggregation of a column with `dtype` (undefined = infer). */
function resultDType(agg: AggName, dtype: DType, values: readonly unknown[]): DType | undefined {
  const nullable = NULLABLE_DTYPES.has(dtype);
  switch (agg) {
    case 'count': case 'size': case 'nunique': return 'int64';
    case 'any': case 'all': return 'bool';
    case 'mean': case 'median': case 'std': case 'var': case 'sem':
      return dtype === 'timedelta' || dtype === 'datetime' ? undefined : nullable ? 'Float64' : 'float64';
    case 'sum': case 'prod':
      if (dtype === 'float64' || dtype === 'Float64' || dtype === 'bigint') return dtype;
      if (dtype === 'Int64' || dtype === 'boolean') return 'Int64';
      return isNumericDType(dtype) ? 'int64' : undefined;
    default:
      return nullable || dtype === 'category' || dtype === 'period' || !values.some(isNA) ? dtype : undefined;
  }
}

export abstract class BaseGroupBy {
  /** @internal */
  readonly _frame: DataFrame;
  /** @internal Columns holding the keys. */
  readonly _by: readonly string[];
  /** @internal Display names of the keys. */
  readonly _keyNames: readonly (string | null)[];
  protected readonly options: Required<Omit<GroupByOptions, 'level'>>;
  private cache: Groups | null = null;

  constructor(frame: DataFrame, by: readonly string[], options: GroupByOptions, keyNames?: readonly (string | null)[]) {
    this._frame = frame;
    this._by = by;
    this._keyNames = keyNames ?? by;
    this.options = { sort: options.sort ?? true, dropna: options.dropna ?? true, asIndex: options.asIndex ?? true };
  }

  /** @internal */
  get _groups(): Groups {
    this.cache ??= computeGroups(this._by.map((k) => this._frame._column(k)), this._frame.length, this.options.sort, this.options.dropna);
    return this.cache;
  }

  get ngroups(): number {
    return this._groups.keys.length;
  }

  private publicCache: DataFrame | null = null;

  /** @internal The frame without hidden key columns (added for non-column keys). */
  get _public(): DataFrame {
    if (!this.publicCache) {
      const hidden = this._frame.columns.filter((c) => c.startsWith('\u0000'));
      this.publicCache = hidden.length ? this._frame.drop(hidden) : this._frame;
    }
    return this.publicCache;
  }

  /** Group label → index labels of its rows (pandas `.groups`). */
  get groups(): Map<Label, Label[]> {
    const g = this._groups;
    return new Map(g.keys.map((k, i) => [this.label(k), g.rows[i].map((p) => this._frame.index.labels[p])]));
  }

  /** Group number of each row (NaN for rows whose key was dropped). */
  ngroup(options: { ascending?: boolean } = {}): Series {
    const out = new Float64Array(this._frame.length).fill(NaN);
    const n = this.ngroups;
    this._groups.rows.forEach((rows, g) => { for (const p of rows) out[p] = options.ascending === false ? n - 1 - g : g; });
    return Series._from(Column.from(Array.from(out)), this._frame.index, null);
  }

  /** 0-based position of each row within its group. */
  cumcount(options: { ascending?: boolean } = {}): Series {
    const out = new Float64Array(this._frame.length).fill(NaN);
    for (const rows of this._groups.rows) rows.forEach((p, k) => (out[p] = options.ascending === false ? rows.length - 1 - k : k));
    return Series._from(Column.from(Array.from(out)), this._frame.index, null);
  }

  /** @internal The per-group object windows operate on. */
  protected abstract _groupTarget(rows: number[]): Series | DataFrame;

  /** Rolling window within each group; results are indexed by (group key, original label). */
  rolling(window: number | string, options: RollingOptions = {}): GroupedOperation {
    return new GroupedOperation(this, (t) => new Rolling(t, window, options));
  }

  expanding(options: { minPeriods?: number } = {}): GroupedOperation {
    return new GroupedOperation(this, (t) => new Expanding(t, options));
  }

  ewm(options: EwmOptions): GroupedOperation {
    return new GroupedOperation(this, (t) => new EWM(t, options));
  }

  /** Time resampling within each group. */
  resample(rule: string, options: ResampleOptions = {}): GroupedOperation {
    return new GroupedOperation(this, (t) => new Resampler(t, rule, options));
  }

  /** Calls `fn(this)`, for method chaining. */
  pipe<T>(fn: (g: this) => T): T {
    return fn(this);
  }

  /** @internal Positions of the n-th row(s) of each group (negative counts from the end). */
  _nthPositions(n: number | readonly number[]): number[] {
    const ns = typeof n === 'number' ? [n] : n;
    return this.positionsWhere((rows) => {
      const out: number[] = [];
      for (const k of ns) { const q = k < 0 ? rows.length + k : k; if (q >= 0 && q < rows.length) out.push(rows[q]); }
      return out;
    });
  }

  /** @internal Random rows per group. */
  _samplePositions(n: number, seed?: number): number[] {
    return this.positionsWhere((rows, g) => samplePositions(rows.length, n, seed === undefined ? undefined : seed + g).map((k) => rows[k]));
  }

  /** Group label → row positions. */
  get indices(): Map<Label, number[]> {
    const g = this._groups;
    return new Map(g.keys.map((k, i) => [this.label(k), g.rows[i]]));
  }

  protected label(key: readonly Label[]): Label {
    return key.length === 1 ? key[0] : key;
  }

  /** @internal Index of group keys. */
  _keyIndex(): Index {
    const keys = this._groups.keys;
    if (keys.length > 0 && keys[0].length > 1 || this._by.length > 1) return new Index(keys.map((k) => k), { names: this._keyNames });
    return new Index(keys.map((k) => k[0]), { name: this._keyNames[0] });
  }

  /** @internal Wraps per-group result columns as a frame indexed (or prefixed) by group keys. */
  _wrap(cols: Map<string, Column>, colNames: readonly (string | null)[] | null = null): DataFrame {
    if (this.options.asIndex) return DataFrame._fromColumns(cols, this._keyIndex(), colNames);
    const out = new Map<string, Column>();
    const levels = colNames?.length ?? 1;
    this._keyNames.forEach((name, l) => {
      const label = name ?? `level_${l}`;
      out.set(levels > 1 ? colKey([label, ...new Array(levels - 1).fill('')]) : label, Column.from(this._groups.keys.map((k) => k[l])));
    });
    for (const [k, v] of cols) out.set(k, v);
    return DataFrame._fromColumns(out, Index.range(this.ngroups), colNames);
  }

  protected positionsWhere(fn: (rows: number[], g: number) => number[]): number[] {
    const out: number[] = [];
    this._groups.rows.forEach((rows, g) => out.push(...fn(rows, g)));
    return out.sort((a, b) => a - b);
  }

  /** @internal Aggregates one column per group. */
  _aggColumn(col: Column, agg: AggFunc, name: string): Column {
    const rows = this._groups.rows;
    if (typeof agg === 'function') {
      return Column.from(rows.map((r) => agg(Series._from(col.take(r), this._frame.index.take(r), name))));
    }
    const vals = rows.map((r) => aggregate(col, agg, r));
    const dtype = resultDType(agg, col.dtype, vals);
    return Column.from(vals, dtype, dtype === col.dtype ? col.meta : {});
  }
}

/** Result of `DataFrame.groupby(...)`. */
export class DataFrameGroupBy extends BaseGroupBy {
  private readonly selection: readonly string[] | null;

  constructor(frame: DataFrame, by: readonly string[], options: GroupByOptions = {}, selection: readonly string[] | null = null, keyNames?: readonly (string | null)[]) {
    super(frame, by, options, keyNames);
    this.selection = selection;
  }

  private valueColumns(): string[] {
    return this.selection ? [...this.selection] : this._frame.columns.filter((c) => !this._by.includes(c) && !c.startsWith('\u0000'));
  }

  protected override _groupTarget(rows: number[]): DataFrame {
    return this._frame.get(this.valueColumns()).take(rows);
  }

  /** `groupby(...).get('col')` ≈ `groupby(...)['col']`. */
  get(column: string): SeriesGroupBy;
  get(columns: readonly string[]): DataFrameGroupBy;
  get(key: string | readonly string[]): SeriesGroupBy | DataFrameGroupBy {
    if (typeof key === 'string') {
      this._frame._column(key);
      return new SeriesGroupBy(this._frame, this._by, key, this.options, this._keyNames, key);
    }
    return new DataFrameGroupBy(this._frame, this._by, this.options, key, this._keyNames);
  }

  /** Rows per group. */
  size(): Series {
    const sizes = this._groups.rows.map((r) => r.length);
    return Series._from(Column.from(sizes, 'int64'), this._keyIndex(), 'size');
  }

  private reduce(agg: AggName): DataFrame {
    const numericOnly = NUMERIC_AGGS.has(agg);
    const cols = new Map<string, Column>();
    for (const name of this.valueColumns()) {
      const col = this._frame._column(name);
      if (numericOnly && !isNumericDType(col.dtype)) continue;
      cols.set(name, this._aggColumn(col, agg, name));
    }
    return this._wrap(cols);
  }

  sum(): DataFrame { return this.reduce('sum'); }
  prod(): DataFrame { return this.reduce('prod'); }
  mean(): DataFrame { return this.reduce('mean'); }
  median(): DataFrame { return this.reduce('median'); }
  std(): DataFrame { return this.reduce('std'); }
  var(): DataFrame { return this.reduce('var'); }
  min(): DataFrame { return this.reduce('min'); }
  max(): DataFrame { return this.reduce('max'); }
  count(): DataFrame { return this.reduce('count'); }
  first(): DataFrame { return this.reduce('first'); }
  last(): DataFrame { return this.reduce('last'); }
  nunique(): DataFrame { return this.reduce('nunique'); }

  /**
   * Aggregates groups.
   * - `'sum'` / function: applied to every value column.
   * - `['sum', 'mean']`: one output column per (column, func), named `col_func`.
   * - `{a: 'sum', b: ['min', 'max']}`: per-column functions (`b_min`, `b_max`).
   * - `{total: ['a', 'sum']}`: named aggregation, like `agg(total=('a', 'sum'))`.
   */
  agg(spec: AggSpec): DataFrame {
    if (typeof spec === 'string') return this.reduce(spec);
    const label = (f: AggFunc, i: number) => (typeof f === 'function' ? f.name || `func${i}` : f);
    const cols = new Map<string, Column>();
    const add = (out: string, col: string, f: AggFunc) => cols.set(out, this._aggColumn(this._frame._column(col), f, col));

    // Lists of functions give MultiIndex columns (column, func), like pandas.
    let multi = false;
    if (typeof spec === 'function') {
      for (const c of this.valueColumns()) add(c, c, spec);
    } else if (Array.isArray(spec)) {
      multi = true;
      for (const c of this.valueColumns()) {
        const dtype = this._frame._column(c).dtype;
        (spec as readonly AggFunc[]).forEach((f, i) => {
          if (typeof f === 'string' && NUMERIC_AGGS.has(f) && !isNumericDType(dtype)) return;
          add(colKey([c, label(f, i)]), c, f);
        });
      }
    } else {
      const entries = Object.entries(spec as Record<string, AggFunc | readonly AggFunc[] | readonly [string, AggFunc]>);
      const isNamed = (key: string, v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && this._frame.has(v[0]) && !this._frame.has(key);
      multi = entries.some(([k, v]) => Array.isArray(v) && !isNamed(k, v));
      for (const [key, v] of entries) {
        if (isNamed(key, v)) add(key, (v as readonly [string, AggFunc])[0], (v as readonly [string, AggFunc])[1]);
        else if (Array.isArray(v)) (v as readonly AggFunc[]).forEach((f, i) => add(colKey([key, label(f, i)]), key, f));
        else add(multi ? colKey([key, label(v as AggFunc, 0)]) : key, key, v as AggFunc);
      }
    }
    return this._wrap(cols, multi ? [null, null] : null);
  }

  aggregate(spec: AggSpec): DataFrame {
    return this.agg(spec);
  }

  /**
   * Calls `fn(groupFrame, key)` per group. Scalar results → Series; Series results →
   * DataFrame (one row per group); DataFrame results → concatenated frame.
   */
  apply(fn: (group: DataFrame, key: Label) => unknown): Series | DataFrame {
    const g = this._groups;
    const results = g.rows.map((r, i) => fn(this._public.take(r), this.label(g.keys[i])));
    const index = this._keyIndex();
    if (results.every((r) => r instanceof DataFrame)) {
      const frames = (results as DataFrame[]).map((df, i) => {
        const key = g.keys[i];
        const labels = df.index.labels.map((l) => [...key, ...(Array.isArray(l) ? l : [l])] as Label);
        return DataFrame._fromColumns(df._cols, new Index(labels, { names: [...this._keyNames, df.index.name] }));
      });
      return concat(frames) as DataFrame;
    }
    if (results.every((r) => r instanceof Series)) {
      const rows = (results as Series[]).map((s) => s.toDict());
      return new DataFrame(rows, { index });
    }
    return new Series(results, { index });
  }

  /** Same-shaped result: each value replaced by its group's aggregate (or `fn(series)`). */
  transform(func: AggName | ((s: Series) => Series | unknown)): DataFrame {
    const cols = new Map<string, Column>();
    for (const name of this.valueColumns()) {
      const sg = this.get(name);
      cols.set(name, sg.transform(func)._col);
    }
    return DataFrame._fromColumns(cols, this._frame.index);
  }

  /** Rows of the groups for which `fn(group)` is true. */
  filter(fn: (group: DataFrame, key: Label) => boolean): DataFrame {
    const g = this._groups;
    return this._public.take(this.positionsWhere((rows, i) => (fn(this._public.take(rows), this.label(g.keys[i])) ? rows : [])));
  }

  /** First `n` rows of each group, in original order. */
  head(n = 5): DataFrame {
    return this._public.take(this.positionsWhere((rows) => rows.slice(0, n)));
  }

  tail(n = 5): DataFrame {
    return this._public.take(this.positionsWhere((rows) => rows.slice(Math.max(0, rows.length - n))));
  }

  /** Applies a per-group Series transform to every value column. */
  private eachColumn(fn: (g: SeriesGroupBy) => Series, numericOnly = false): DataFrame {
    const cols = new Map<string, Column>();
    for (const name of this.valueColumns()) {
      const col = this._frame._column(name);
      if (numericOnly && !isNumericDType(col.dtype)) continue;
      cols.set(name, fn(this.get(name))._col);
    }
    return DataFrame._fromColumns(cols, this._frame.index);
  }

  /** Per-column per-group aggregation with a Series → scalar function. */
  private aggEach(fn: (s: Series) => unknown, numericOnly = true): DataFrame {
    const cols = new Map<string, Column>();
    for (const name of this.valueColumns()) {
      const col = this._frame._column(name);
      if (numericOnly && !isNumericDType(col.dtype)) continue;
      cols.set(name, this._aggColumn(col, fn, name));
    }
    return this._wrap(cols);
  }

  sem(): DataFrame { return this.reduce('sem'); }
  any(): DataFrame { return this.reduce('any'); }
  all(): DataFrame { return this.reduce('all'); }
  shift(periods = 1): DataFrame { return this.eachColumn((g) => g.shift(periods)); }
  diff(periods = 1): DataFrame { return this.eachColumn((g) => g.diff(periods), true); }
  pctChange(periods = 1): DataFrame { return this.eachColumn((g) => g.pctChange(periods), true); }
  rank(options: RankOptions = {}): DataFrame { return this.eachColumn((g) => g.rank(options)); }
  cumsum(): DataFrame { return this.eachColumn((g) => g.cumsum(), true); }
  cumprod(): DataFrame { return this.eachColumn((g) => g.cumprod(), true); }
  cummax(): DataFrame { return this.eachColumn((g) => g.cummax(), true); }
  cummin(): DataFrame { return this.eachColumn((g) => g.cummin(), true); }
  ffill(limit?: number): DataFrame { return this.eachColumn((g) => g.ffill(limit)); }
  bfill(limit?: number): DataFrame { return this.eachColumn((g) => g.bfill(limit)); }
  fillna(value: unknown): DataFrame { return this.eachColumn((g) => g.transform((s) => s.fillna(value))); }

  quantile(q = 0.5): DataFrame { return this.aggEach((s) => s.quantile(q)); }
  idxmax(): DataFrame { return this.aggEach((s) => s.idxmax()); }
  idxmin(): DataFrame { return this.aggEach((s) => s.idxmin()); }

  /** n-th row(s) of each group (negative counts from the end), keeping the original index. */
  nth(n: number | readonly number[]): DataFrame {
    return this._public.take(this._nthPositions(n));
  }

  /** `n` random rows per group. */
  sample(n = 1, options: { seed?: number } = {}): DataFrame {
    return this._public.take(this._samplePositions(n, options.seed));
  }

  /** Summary statistics per group, one `column_stat` column per statistic. */
  describe(): DataFrame {
    const cols = new Map<string, Column>();
    for (const name of this.valueColumns()) {
      if (!isNumericDType(this._frame._column(name).dtype)) continue;
      const d = this.get(name).describe();
      for (const stat of d.columns) cols.set(colKey([name, stat]), d._column(stat));
    }
    return DataFrame._fromColumns(cols, this.options.asIndex ? this._keyIndex() : Index.range(this.ngroups), [null, null]);
  }

  getGroup(key: Label): DataFrame {
    const h = hashKey(Array.isArray(key) && this._by.length === 1 ? key[0] : key);
    const g = this._groups;
    const i = g.keys.findIndex((k) => hashKey(this.label(k)) === h);
    if (i < 0) throw new Error(`Group not found: ${String(key)}`);
    return this._public.take(g.rows[i]);
  }

  *[Symbol.iterator](): IterableIterator<[Label, DataFrame]> {
    const g = this._groups;
    for (let i = 0; i < g.keys.length; i++) yield [this.label(g.keys[i]), this._public.take(g.rows[i])];
  }
}

/** Result of `groupby(...).get('col')` or `Series.groupby(...)`. */
export class SeriesGroupBy extends BaseGroupBy {
  private readonly column: string;
  private readonly resultName: string | null;

  constructor(frame: DataFrame, by: readonly string[], column: string, options: GroupByOptions = {}, keyNames?: readonly (string | null)[], resultName: string | null = column) {
    super(frame, by, options, keyNames);
    this.column = column;
    this.resultName = resultName;
  }

  private col(): Column {
    return this._frame._column(this.column);
  }

  protected override _groupTarget(rows: number[]): Series {
    return Series._from(this.col().take(rows), this._frame.index.take(rows), this.resultName);
  }

  private series(col: Column): Series {
    if (this.options.asIndex) return Series._from(col, this._keyIndex(), this.resultName);
    return Series._from(col, Index.range(this.ngroups), this.resultName);
  }

  size(): Series {
    return this.series(Column.from(this._groups.rows.map((r) => r.length), 'int64')).rename('size');
  }

  private reduce(agg: AggFunc): Series {
    return this.series(this._aggColumn(this.col(), agg, this.column));
  }

  sum(): Series { return this.reduce('sum'); }
  prod(): Series { return this.reduce('prod'); }
  mean(): Series { return this.reduce('mean'); }
  median(): Series { return this.reduce('median'); }
  std(): Series { return this.reduce('std'); }
  var(): Series { return this.reduce('var'); }
  min(): Series { return this.reduce('min'); }
  max(): Series { return this.reduce('max'); }
  count(): Series { return this.reduce('count'); }
  first(): Series { return this.reduce('first'); }
  last(): Series { return this.reduce('last'); }
  nunique(): Series { return this.reduce('nunique'); }

  /** One func → Series; a list of funcs → DataFrame with one column per func. */
  agg(func: AggFunc | readonly AggFunc[] | Record<string, AggFunc>): Series | DataFrame {
    if (typeof func === 'string' || typeof func === 'function') return this.reduce(func);
    const entries: [string, AggFunc][] = Array.isArray(func)
      ? (func as readonly AggFunc[]).map((f, i) => [typeof f === 'function' ? f.name || `func${i}` : f, f])
      : Object.entries(func as Record<string, AggFunc>);
    const cols = new Map<string, Column>();
    for (const [name, f] of entries) cols.set(name, this._aggColumn(this.col(), f, this.column));
    return this._wrap(cols);
  }

  aggregate(func: AggFunc | readonly AggFunc[] | Record<string, AggFunc>): Series | DataFrame {
    return this.agg(func);
  }

  /** Calls `fn(groupSeries, key)` per group; scalars → Series indexed by group. */
  apply(fn: (group: Series, key: Label) => unknown): Series {
    const g = this._groups;
    const col = this.col();
    const results = g.rows.map((r, i) => fn(Series._from(col.take(r), this._frame.index.take(r), this.resultName), this.label(g.keys[i])));
    if (results.every((r) => r instanceof Series)) {
      const labels: Label[] = [];
      const parts: Column[] = [];
      (results as Series[]).forEach((s, i) => {
        for (const l of s.index.labels) labels.push([...g.keys[i], ...(Array.isArray(l) ? l : [l])]);
        parts.push(s._col);
      });
      return Series._from(Column.concat(parts), new Index(labels, { names: [...this._keyNames, null] }), this.resultName);
    }
    return this.series(Column.from(results));
  }

  /** Same length as the input: each value replaced by its group's aggregate or `fn(group)`. */
  transform(func: AggName | ((s: Series) => Series | unknown)): Series {
    const g = this._groups;
    const col = this.col();
    const n = this._frame.length;
    const out = new Array(n).fill(null);
    g.rows.forEach((rows) => {
      let res: unknown;
      if (typeof func === 'function') res = func(Series._from(col.take(rows), this._frame.index.take(rows), this.resultName));
      else res = aggregate(col, func, rows);
      if (res instanceof Series) {
        if (res.length !== rows.length) throw new RangeError('transform function must return a Series of the same length as the group');
        rows.forEach((p, k) => (out[p] = res._col.get(k)));
      } else rows.forEach((p) => (out[p] = res));
    });
    return Series._from(Column.from(out), this._frame.index, this.resultName);
  }

  filter(fn: (group: Series, key: Label) => boolean): Series {
    const g = this._groups;
    const col = this.col();
    const pos = this.positionsWhere((rows, i) => (fn(Series._from(col.take(rows), this._frame.index.take(rows), this.resultName), this.label(g.keys[i])) ? rows : []));
    return Series._from(col.take(pos), this._frame.index.take(pos), this.resultName);
  }

  sem(): Series { return this.reduce('sem'); }
  any(): Series { return this.reduce('any'); }
  all(): Series { return this.reduce('all'); }
  cumsum(): Series { return this.transform((s) => s.cumsum()); }
  cumprod(): Series { return this.transform((s) => s.cumprod()); }
  cummax(): Series { return this.transform((s) => s.cummax()); }
  cummin(): Series { return this.transform((s) => s.cummin()); }
  shift(periods = 1): Series { return this.transform((s) => s.shift(periods)); }
  diff(periods = 1): Series { return this.transform((s) => s.diff(periods)); }
  pctChange(periods = 1): Series { return this.transform((s) => s.pctChange(periods)); }
  rank(options: RankOptions = {}): Series { return this.transform((s) => s.rank(options)); }
  ffill(limit?: number): Series { return this.transform((s) => s.ffill(limit)); }
  bfill(limit?: number): Series { return this.transform((s) => s.bfill(limit)); }
  fillna(value: unknown): Series { return this.transform((s) => s.fillna(value)); }

  quantile(q = 0.5): Series { return this.reduce((s) => s.quantile(q)); }
  idxmax(): Series { return this.reduce((s) => s.idxmax()); }
  idxmin(): Series { return this.reduce((s) => s.idxmin()); }

  /** n-th value(s) of each group, keeping the original index. */
  nth(n: number | readonly number[]): Series {
    const pos = this._nthPositions(n);
    return Series._from(this.col().take(pos), this._frame.index.take(pos), this.resultName);
  }

  sample(n = 1, options: { seed?: number } = {}): Series {
    const pos = this._samplePositions(n, options.seed);
    return Series._from(this.col().take(pos), this._frame.index.take(pos), this.resultName);
  }

  /** count/mean/std/min/25%/50%/75%/max per group. */
  describe(): DataFrame {
    const stats: [string, (s: Series) => unknown][] = [
      ['count', (s) => s.count()], ['mean', (s) => s.mean()], ['std', (s) => s.std()], ['min', (s) => s.min()],
      ['25%', (s) => s.quantile(0.25)], ['50%', (s) => s.quantile(0.5)], ['75%', (s) => s.quantile(0.75)], ['max', (s) => s.max()],
    ];
    const cols = new Map<string, Column>();
    for (const [name, f] of stats) cols.set(name, this._aggColumn(this.col(), f, this.column).astype('float64'));
    return DataFrame._fromColumns(cols, this.options.asIndex ? this._keyIndex() : Index.range(this.ngroups));
  }

  /** open/high/low/close per group. */
  ohlc(): DataFrame {
    const cols = new Map<string, Column>();
    for (const [name, agg] of [['open', 'first'], ['high', 'max'], ['low', 'min'], ['close', 'last']] as const) {
      cols.set(name, this._aggColumn(this.col(), agg, this.column));
    }
    return this._wrap(cols);
  }

  valueCounts(): Series {
    const g = this._groups;
    const col = this.col();
    const labels: Label[] = [];
    const counts: number[] = [];
    g.rows.forEach((rows, i) => {
      const vc = Series._from(col.take(rows), Index.range(rows.length), null).valueCounts();
      vc.index.labels.forEach((l, k) => { labels.push([...g.keys[i], l]); counts.push(vc.iat(k) as number); });
    });
    return Series._from(Column.from(counts, 'int64'), new Index(labels, { names: [...this._keyNames, this.resultName] }), 'count');
  }

  *[Symbol.iterator](): IterableIterator<[Label, Series]> {
    const g = this._groups;
    const col = this.col();
    for (let i = 0; i < g.keys.length; i++) {
      const r = g.rows[i];
      yield [this.label(g.keys[i]), Series._from(col.take(r), this._frame.index.take(r), this.resultName)];
    }
  }
}

/**
 * Resolves grouping keys to columns of a frame. Non-column keys become hidden
 * columns (named with a leading NUL) so the GroupBy machinery stays uniform.
 */
export function resolveGroupKeys(
  frame: DataFrame,
  by: GroupKey | readonly GroupKey[] | null | undefined,
  level: GroupByOptions['level'],
): { frame: DataFrame; by: string[]; names: (string | null)[] } {
  let keys: GroupKey[] = [];
  if (by !== null && by !== undefined) {
    if (typeof by === 'string' || by instanceof Series || typeof by === 'function') keys = [by];
    else if ((by as readonly unknown[]).every((k) => (typeof k === 'string' && frame.has(k)) || k instanceof Series || typeof k === 'function' || Array.isArray(k))) {
      keys = [...(by as readonly GroupKey[])];
    } else keys = [by as readonly unknown[]];
  }
  const hidden = new Map<string, Column>();
  const outBy: string[] = [];
  const names: (string | null)[] = [];
  const addHidden = (col: Column, name: string | null) => {
    if (col.length !== frame.length) throw new RangeError(`Grouper length ${col.length} does not match ${frame.length} rows`);
    const key = `\u0000key${hidden.size}`;
    hidden.set(key, col);
    outBy.push(key);
    names.push(name);
  };
  const levels = level === undefined ? [] : Array.isArray(level) ? level : [level as number | string];
  for (const l of levels) {
    const idx = frame.index;
    const pos = typeof l === 'number' ? l : idx.nlevels > 1 ? idx.names!.indexOf(l) : idx.name === l ? 0 : -1;
    if (pos < 0 || pos >= idx.nlevels) throw new Error(`Level ${String(l)} not found`);
    const vals = idx.nlevels > 1 ? idx.labels.map((t) => (t as readonly Label[])[pos]) : idx.labels;
    addHidden(Column.from(vals), idx.nlevels > 1 ? idx.names![pos] : idx.name);
  }
  for (const k of keys) {
    if (typeof k === 'string') { frame._column(k); outBy.push(k); names.push(k); }
    else if (k instanceof Series) addHidden(k.index.equals(frame.index) ? k._col : k.reindex(frame.index)._col, k.name);
    else if (typeof k === 'function') addHidden(Column.from(frame.index.labels.map((l) => k(l))), null);
    else addHidden(Column.from(k), null);
  }
  if (outBy.length === 0) throw new Error('You have to supply one of `by` and `level`');
  const out = hidden.size ? DataFrame._fromColumns(new Map([...frame._cols, ...hidden]), frame.index) : frame;
  return { frame: out, by: outBy, names };
}

type Windowish = Rolling | Expanding | EWM | Resampler;

/**
 * A window or resampler applied per group. Calling an aggregation (mean, sum,
 * std, ...) runs it on every group and stacks the results under a
 * (group key, label) index, like pandas.
 */
export class GroupedOperation {
  private readonly gb: BaseGroupBy;
  private readonly make: (t: Series | DataFrame) => Windowish;

  /** @internal */
  constructor(gb: BaseGroupBy, make: (t: Series | DataFrame) => Windowish) {
    this.gb = gb;
    this.make = make;
    const methods = ['sum', 'mean', 'median', 'min', 'max', 'std', 'var', 'sem', 'count', 'skew', 'kurt', 'quantile', 'apply', 'agg',
      'first', 'last', 'prod', 'nunique', 'ohlc', 'size', 'rank', 'corr', 'cov', 'ffill', 'bfill', 'asfreq', 'interpolate'];
    for (const m of methods) {
      (this as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => this.call(m, args);
    }
  }

  /** Runs `method(...args)` on each group's window and stacks the results. */
  call(method: string, args: readonly unknown[] = []): Series | DataFrame {
    const g = (this.gb as unknown as { _groups: { keys: Label[][]; rows: number[][] } })._groups;
    const keyNames = (this.gb as unknown as { _keyNames: readonly (string | null)[] })._keyNames;
    const target = (rows: number[]) => (this.gb as unknown as { _groupTarget(r: number[]): Series | DataFrame })._groupTarget(rows);
    const parts: (Series | DataFrame)[] = [];
    let innerName: string | null = null;
    g.rows.forEach((rows, i) => {
      const w = this.make(target(rows)) as unknown as Record<string, (...a: unknown[]) => Series | DataFrame>;
      if (typeof w[method] !== 'function') throw new Error(`${method} is not available here`);
      const res = w[method](...args);
      innerName = res.index.name;
      const labels = res.index.labels.map((l) => [...g.keys[i], ...(Array.isArray(l) ? l : [l])] as Label);
      parts.push(res instanceof Series ? Series._from(res._col, new Index(labels), res.name) : DataFrame._fromColumns(res._cols, new Index(labels)));
    });
    const out: Series | DataFrame = parts.every((p) => p instanceof Series) ? concat(parts as Series[]) : concat(parts);
    const index = new Index(out.index.labels, { names: [...keyNames, innerName] });
    return out instanceof Series ? Series._from(out._col, index, out.name) : DataFrame._fromColumns(out._cols, index);
  }
}

export interface GroupedOperation {
  sum(): Series | DataFrame; mean(): Series | DataFrame; median(): Series | DataFrame; min(): Series | DataFrame; max(): Series | DataFrame;
  std(ddof?: number): Series | DataFrame; var(ddof?: number): Series | DataFrame; sem(): Series | DataFrame; count(): Series | DataFrame;
  skew(): Series | DataFrame; kurt(): Series | DataFrame; quantile(q: number): Series | DataFrame; apply(fn: (v: any) => unknown, options?: object): Series | DataFrame;
  agg(spec: unknown): Series | DataFrame; first(): Series | DataFrame; last(): Series | DataFrame; prod(): Series | DataFrame;
  nunique(): Series | DataFrame; ohlc(): DataFrame; size(): Series; rank(options?: object): Series | DataFrame;
  ffill(): Series | DataFrame; bfill(): Series | DataFrame; asfreq(): Series | DataFrame; interpolate(): Series | DataFrame;
}
