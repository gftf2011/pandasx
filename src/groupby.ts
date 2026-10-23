import { aggregate, NUMERIC_AGGS } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { isNumericDType, type AggName, type DType, type Label } from './core/types.ts';
import { compareValues, hashKey, isNA } from './core/values.ts';
import { DataFrame } from './frame.ts';
import { concat } from './reshape.ts';
import { Series } from './series.ts';

export interface GroupByOptions {
  /** Sort group keys (default true). */
  sort?: boolean;
  /** Exclude groups whose key contains NA (default true). */
  dropna?: boolean;
  /** Use group keys as the result index (default true); false puts them in columns. */
  asIndex?: boolean;
}

type AggFn = AggName | ((s: Series) => unknown);

/** `{column: func | func[]}`, or named aggregation `{output: [column, func]}`. */
export type AggSpec = AggFn | readonly AggFn[] | Record<string, AggFn | readonly AggFn[] | readonly [string, AggFn]>;

interface Groups {
  keys: Label[][];
  rows: number[][];
}

function computeGroups(keyCols: readonly Column[], n: number, sort: boolean, dropna: boolean): Groups {
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

/** Output dtype of an aggregation of a column with `dtype`. */
function resultDType(agg: AggName, dtype: DType, values: readonly unknown[]): DType | undefined {
  if (agg === 'count' || agg === 'size' || agg === 'nunique') return 'int64';
  if (agg === 'mean' || agg === 'median' || agg === 'std' || agg === 'var') return 'float64';
  if (agg === 'sum' || agg === 'prod') return dtype === 'float64' ? 'float64' : isNumericDType(dtype) ? 'int64' : undefined;
  return values.some(isNA) ? undefined : dtype;
}

abstract class BaseGroupBy {
  /** @internal */
  readonly _frame: DataFrame;
  /** @internal Columns holding the keys. */
  readonly _by: readonly string[];
  /** @internal Display names of the keys. */
  readonly _keyNames: readonly (string | null)[];
  protected readonly options: Required<GroupByOptions>;
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
  _wrap(cols: Map<string, Column>): DataFrame {
    if (this.options.asIndex) return DataFrame._fromColumns(cols, this._keyIndex());
    const out = new Map<string, Column>();
    this._keyNames.forEach((name, l) => {
      out.set(name ?? `level_${l}`, Column.from(this._groups.keys.map((k) => k[l])));
    });
    for (const [k, v] of cols) out.set(k, v);
    return DataFrame._fromColumns(out, Index.range(this.ngroups));
  }

  protected positionsWhere(fn: (rows: number[], g: number) => number[]): number[] {
    const out: number[] = [];
    this._groups.rows.forEach((rows, g) => out.push(...fn(rows, g)));
    return out.sort((a, b) => a - b);
  }

  /** @internal Aggregates one column per group. */
  _aggColumn(col: Column, agg: AggFn, name: string): Column {
    const rows = this._groups.rows;
    if (typeof agg === 'function') {
      return Column.from(rows.map((r) => agg(Series._from(col.take(r), this._frame.index.take(r), name))));
    }
    const vals = rows.map((r) => aggregate(col, agg, r));
    return Column.from(vals, resultDType(agg, col.dtype, vals));
  }
}

/** Result of `DataFrame.groupby(...)`. */
export class DataFrameGroupBy extends BaseGroupBy {
  private readonly selection: readonly string[] | null;

  constructor(frame: DataFrame, by: readonly string[], options: GroupByOptions = {}, selection: readonly string[] | null = null) {
    super(frame, by, options);
    this.selection = selection;
  }

  private valueColumns(): string[] {
    return this.selection ? [...this.selection] : this._frame.columns.filter((c) => !this._by.includes(c));
  }

  /** `groupby(...).get('col')` ≈ `groupby(...)['col']`. */
  get(column: string): SeriesGroupBy;
  get(columns: readonly string[]): DataFrameGroupBy;
  get(key: string | readonly string[]): SeriesGroupBy | DataFrameGroupBy {
    if (typeof key === 'string') {
      this._frame._column(key);
      return new SeriesGroupBy(this._frame, this._by, key, this.options, this._keyNames, key);
    }
    return new DataFrameGroupBy(this._frame, this._by, this.options, key);
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
    const label = (f: AggFn, i: number) => (typeof f === 'function' ? f.name || `func${i}` : f);
    const cols = new Map<string, Column>();
    const add = (out: string, col: string, f: AggFn) => cols.set(out, this._aggColumn(this._frame._column(col), f, col));

    if (typeof spec === 'function') {
      for (const c of this.valueColumns()) add(c, c, spec);
    } else if (Array.isArray(spec)) {
      for (const c of this.valueColumns()) {
        const dtype = this._frame._column(c).dtype;
        (spec as readonly AggFn[]).forEach((f, i) => {
          if (typeof f === 'string' && NUMERIC_AGGS.has(f) && !isNumericDType(dtype)) return;
          add(`${c}_${label(f, i)}`, c, f);
        });
      }
    } else {
      for (const [key, v] of Object.entries(spec as Record<string, AggFn | readonly AggFn[] | readonly [string, AggFn]>)) {
        const named = Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && this._frame.has(v[0]) && !this._frame.has(key);
        if (named) add(key, v[0] as string, v[1] as AggFn);
        else if (Array.isArray(v)) (v as readonly AggFn[]).forEach((f, i) => add(`${key}_${label(f, i)}`, key, f));
        else add(key, key, v as AggFn);
      }
    }
    return this._wrap(cols);
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
    const results = g.rows.map((r, i) => fn(this._frame.take(r), this.label(g.keys[i])));
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
    return this._frame.take(this.positionsWhere((rows, i) => (fn(this._frame.take(rows), this.label(g.keys[i])) ? rows : [])));
  }

  /** First `n` rows of each group, in original order. */
  head(n = 5): DataFrame {
    return this._frame.take(this.positionsWhere((rows) => rows.slice(0, n)));
  }

  tail(n = 5): DataFrame {
    return this._frame.take(this.positionsWhere((rows) => rows.slice(Math.max(0, rows.length - n))));
  }

  getGroup(key: Label): DataFrame {
    const h = hashKey(Array.isArray(key) && this._by.length === 1 ? key[0] : key);
    const g = this._groups;
    const i = g.keys.findIndex((k) => hashKey(this.label(k)) === h);
    if (i < 0) throw new Error(`Group not found: ${String(key)}`);
    return this._frame.take(g.rows[i]);
  }

  *[Symbol.iterator](): IterableIterator<[Label, DataFrame]> {
    const g = this._groups;
    for (let i = 0; i < g.keys.length; i++) yield [this.label(g.keys[i]), this._frame.take(g.rows[i])];
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

  private series(col: Column): Series {
    if (this.options.asIndex) return Series._from(col, this._keyIndex(), this.resultName);
    return Series._from(col, Index.range(this.ngroups), this.resultName);
  }

  size(): Series {
    return this.series(Column.from(this._groups.rows.map((r) => r.length), 'int64')).rename('size');
  }

  private reduce(agg: AggFn): Series {
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
  agg(func: AggFn | readonly AggFn[] | Record<string, AggFn>): Series | DataFrame {
    if (typeof func === 'string' || typeof func === 'function') return this.reduce(func);
    const entries: [string, AggFn][] = Array.isArray(func)
      ? (func as readonly AggFn[]).map((f, i) => [typeof f === 'function' ? f.name || `func${i}` : f, f])
      : Object.entries(func as Record<string, AggFn>);
    const cols = new Map<string, Column>();
    for (const [name, f] of entries) cols.set(name, this._aggColumn(this.col(), f, this.column));
    return this._wrap(cols);
  }

  aggregate(func: AggFn | readonly AggFn[] | Record<string, AggFn>): Series | DataFrame {
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

  /** Cumulative sum within each group. */
  cumsum(): Series {
    return this.transform((s) => s.cumsum());
  }

  /** 0-based position of each row within its group. */
  cumcount(): Series {
    const out = new Float64Array(this._frame.length).fill(NaN);
    for (const rows of this._groups.rows) rows.forEach((p, k) => (out[p] = k));
    return Series._from(Column.from(Array.from(out), undefined), this._frame.index, null);
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
