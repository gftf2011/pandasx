import { aggregate, NUMERIC_AGGS, quantile, type AggOptions, type QuantileInterpolation } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { DISPLAY, displayPositions, formatColumn, formatIndex, formatScalar, renderTable } from './core/format.ts';
import { Index, Slice } from './core/indexes.ts';
import { argsort, sortKeyFromColumn, type NaPosition } from './core/sort.ts';
import { correlation, covariance, type CorrMethod, type InterpolateOptions, type RankOptions } from './core/stats.ts';
import { isNumericDType, type AggName, type DType, type Label } from './core/types.ts';
import { DataFrameGroupBy, resolveGroupKeys, type GroupByOptions, type GroupKey } from './groupby.ts';
import { merge, type MergeOptions } from './reshape.ts';
import { evaluateStatements } from './expr.ts';
import { EWM, Expanding, Rolling, type EwmOptions, type RollingOptions } from './window.ts';
import type { Timedelta } from './core/time.ts';
import type { DateOffset } from './core/offsets.ts';
import { asfreq, Resampler, type ResampleOptions } from './resample.ts';
import { plotAccessor, type PlotAccessor } from './plot.ts';
import { onAxis, pivot, stack, unstack, xs } from './levels.ts';
import { pivotTable, type PivotTableOptions } from './pivot.ts';
import { combineFirst, compare, explodeFrame, update } from './combine.ts';

import { atTimePositions, betweenTimePositions, shiftIndex, toPeriodIndex, toTimestampIndex, truncatePositions, tzConvertIndex, tzLocalizeIndex } from './timeindex.ts';
import type { Ambiguous, Nonexistent } from './core/tz.ts';

import { toCsv, type ToCsvOptions } from './io/csv.ts';
import { toJson } from './io/json.ts';
import { toHtml, type ToHtmlOptions } from './io/html.ts';
import { toXml, type ToXmlOptions } from './io/xml.ts';
import { toSql, type SqlConnection, type ToSqlOptions } from './io/sql.ts';
import { toExcel, type ToExcelOptions } from './io/excel.ts';
import { toFeather, toParquet, type ToParquetOptions } from './io/columnar.ts';
import { exportCell, latexTable, Styler } from './style.ts';
import { formatSpec, pyFormat } from './core/pyformat.ts';
import { isNA } from './core/values.ts';
import { toHdf, type ToHdfOptions } from './io/hdf.ts';
import {
  dropMatchedLevels, duplicatedFlags, isMask, isPlainObject, isScalarKey, KeyError, numericView, resolveRows, labelPositions, positionalPositions, samplePositions,
  Series, toIndex, type AggFunc, type ArithOptions, type Mask, type Operand, type RowSelector,
} from './series.ts';

export interface FrameOptions {
  index?: Index | readonly Label[];
  columns?: readonly string[];
  dtype?: DType | Record<string, DType>;
}

/** Column-oriented `{name: values}`, row records, or rows as arrays. */
export type FrameInput =
  | Record<string, unknown>
  | readonly Record<string, unknown>[]
  | readonly (readonly unknown[])[];

export type ColSelector = string | readonly string[] | readonly boolean[] | Slice;

/** A Series (aligned on the index), an array, or a scalar broadcast to every row. */
export type ColumnValue = Series | readonly unknown[] | ArrayLike<unknown> | Column | string | number | boolean | Date | null | undefined;

export interface AxisAggOptions extends AggOptions {
  /** 0 / 'index' reduces each column (default); 1 / 'columns' reduces each row. */
  axis?: 0 | 1 | 'index' | 'columns';
  /** Only consider numeric columns. Defaults to true for numeric reductions (sum, mean, std, ...). */
  numericOnly?: boolean;
}


const isAxis1 = (axis: unknown) => axis === 1 || axis === 'columns';

/** Separator joining the parts of a MultiIndex column label into its key. */
export const COL_SEP = '\u001f';
export const colKey = (tuple: readonly Label[]): string => tuple.map((p) => String(p ?? '')).join(COL_SEP);
export const colTuple = (key: string): string[] => key.split(COL_SEP);

/** Two-dimensional labeled table with typed columns, the equivalent of `pandas.DataFrame`. */
export class DataFrame {
  /** @internal */
  readonly _cols: Map<string, Column>;
  /** Row labels; may be reassigned (same length), like `df.index = [...]`. */
  index: Index;

  constructor(data: FrameInput = {}, options: FrameOptions = {}) {
    const cols = new Map<string, Column>();
    let index: Index;
    const dtypeFor = (name: string) => (typeof options.dtype === 'string' ? options.dtype : options.dtype?.[name]);

    if (Array.isArray(data)) {
      const rows = data as readonly unknown[];
      if (rows.length > 0 && Array.isArray(rows[0])) {
        const width = Math.max(...(rows as unknown[][]).map((r) => r.length));
        const names = options.columns ?? Array.from({ length: width }, (_, j) => String(j));
        names.forEach((name, j) => cols.set(name, Column.from((rows as unknown[][]).map((r) => r[j]), dtypeFor(name))));
      } else {
        const names = options.columns ? [...options.columns] : unionKeys(rows as Record<string, unknown>[]);
        for (const name of names) cols.set(name, Column.from((rows as Record<string, unknown>[]).map((r) => r?.[name]), dtypeFor(name)));
      }
      index = toIndex(options.index, rows.length);
    } else {
      const entries = Object.entries(data as Record<string, unknown>).filter(([k]) => !options.columns || options.columns.includes(k));
      const series = entries.filter(([, v]) => v instanceof Series).map(([, v]) => v as Series);
      // Index: explicit, else union of Series indexes, else 0..n-1.
      if (options.index !== undefined) index = options.index instanceof Index ? options.index : new Index([...options.index]);
      else if (series.length > 0) index = series.slice(1).reduce((idx, s) => (idx.equals(s.index) ? idx : idx.union(s.index)), series[0].index);
      else {
        const first = entries.find(([, v]) => isArrayish(v));
        index = Index.range(first ? (first[1] as ArrayLike<unknown>).length : entries.length ? 1 : 0);
      }
      for (const [name, v] of entries) cols.set(name, toColumn(v, index, dtypeFor(name)));
      for (const name of options.columns ?? []) if (!cols.has(name)) cols.set(name, Column.full(index.length, null));
    }
    for (const [name, col] of cols) {
      if (col.length !== index.length) throw new RangeError(`Column "${name}" has length ${col.length}, expected ${index.length}`);
    }
    this._cols = cols;
    this.index = index;
  }

  /** @internal Builds a frame from already-validated columns. */
  static _fromColumns(cols: Map<string, Column>, index: Index, colNames: readonly (string | null)[] | null = null): DataFrame {
    const df = Object.create(DataFrame.prototype) as { _cols: Map<string, Column>; index: Index; _colNames: readonly (string | null)[] | null };
    df._cols = cols;
    df.index = index;
    df._colNames = colNames;
    return df as unknown as DataFrame;
  }

  /** Frame whose columns are labelled by tuples (a column MultiIndex). */
  static _fromTupleColumns(cols: readonly [readonly Label[], Column][], index: Index, names?: readonly (string | null)[]): DataFrame {
    const levels = cols[0]?.[0].length ?? names?.length ?? 1;
    const map = new Map(cols.map(([t, c]) => [colKey(t), c]));
    return DataFrame._fromColumns(map, index, levels > 1 ? (names ?? new Array(levels).fill(null)) : (names ? [names[0]] : null));
  }

  static fromRecords(records: readonly Record<string, unknown>[], options: FrameOptions = {}): DataFrame {
    return new DataFrame(records, options);
  }

  private with(cols: Map<string, Column>, index: Index = this.index): DataFrame {
    // Keep column level names while the keys still have the same number of levels.
    const n = this.nColumnLevels;
    const keep = n > 1 ? [...cols.keys()].every((k) => k.split(COL_SEP).length === n) : n === 1 && cols.size > 0 && [...cols.keys()].every((k) => !k.includes(COL_SEP));
    return DataFrame._fromColumns(cols, index, keep ? this._colNames : null);
  }

  // ---------------------------------------------------------- column levels

  /** @internal Names of the column levels (null when flat and unnamed). */
  _colNames: readonly (string | null)[] | null = null;

  /** Number of column levels (1 for flat columns). */
  get nColumnLevels(): number {
    const first = this._cols.keys().next();
    if (!first.done && first.value.includes(COL_SEP)) return first.value.split(COL_SEP).length;
    return this._colNames && this._colNames.length > 1 ? this._colNames.length : 1;
  }

  /** Column labels as an Index; tuples (with level names) for MultiIndex columns. */
  get columnIndex(): Index {
    const keys = this.columns;
    if (this.nColumnLevels > 1) return Index.fromTuples(keys.map(colTuple), { names: this._colNames ?? undefined });
    return new Index(keys, { name: this._colNames?.[0] ?? null });
  }

  /** Replaces the column labels with an Index (tuples → MultiIndex columns) or names. */
  setColumns(labels: Index | readonly (string | readonly string[])[]): this {
    const list = labels instanceof Index ? labels.labels : labels;
    if (list.length !== this._cols.size) throw new RangeError(`Expected ${this._cols.size} column labels, got ${list.length}`);
    const keys = list.map((l) => (Array.isArray(l) ? colKey(l as readonly Label[]) : String(l)));
    assertUniqueColumns(keys);
    const cols = [...this._cols.values()];
    this._cols.clear();
    keys.forEach((k, j) => this._cols.set(k, cols[j]));
    this._colNames = labels instanceof Index ? (labels.isMulti ? labels.names : labels.name !== null ? [labels.name] : null) : Array.isArray(list[0]) ? new Array((list[0] as readonly string[]).length).fill(null) : null;
    return this;
  }

  /** Joins MultiIndex column labels into flat names, e.g. ('price', 'min') → 'price_min'. */
  flattenColumns(sep = '_'): DataFrame {
    const cols = new Map([...this._cols].map(([k, c]) => [colTuple(k).filter((p) => p !== '').join(sep), c]));
    return DataFrame._fromColumns(cols, this.index);
  }

  /** @internal Column keys from names / tuples; a plain list that only names one MultiIndex column is that tuple. */
  columnKeys(by: string | readonly (string | readonly string[])[]): string[] {
    if (typeof by === 'string') return [by];
    if (this.nColumnLevels > 1 && by.every((b) => typeof b === 'string') && by.length === this.nColumnLevels && !by.some((b) => this._cols.has(b as string)) && this._cols.has(colKey(by as string[]))) {
      return [colKey(by as string[])];
    }
    return by.map((b) => (typeof b === 'string' ? b : colKey(b)));
  }

  /** Keys of the columns whose label starts with `prefix`. */
  private columnsWithPrefix(prefix: readonly string[]): string[] {
    return this.columns.filter((k) => {
      const t = colTuple(k);
      return prefix.every((p, l) => t[l] === p);
    });
  }

  /** Sub-frame of the columns under `prefix`, with the matched levels removed. */
  private columnGroup(prefix: readonly string[]): DataFrame {
    const keys = this.columnsWithPrefix(prefix);
    if (keys.length === 0) throw new KeyError(prefix.length === 1 ? prefix[0] : prefix);
    const rest = this.nColumnLevels - prefix.length;
    const cols = new Map(keys.map((k) => [colKey(colTuple(k).slice(prefix.length)), this._cols.get(k)!]));
    return DataFrame._fromColumns(cols, this.index, rest > 1 && this._colNames ? this._colNames.slice(prefix.length) : null);
  }

  // ---------------------------------------------------------------- attributes

  get columns(): string[] {
    return [...this._cols.keys()];
  }

  /** Renames all columns at once, like `df.columns = [...]`. */
  set columns(names: string[]) {
    if (names.length !== this._cols.size) throw new RangeError(`Expected ${this._cols.size} column names, got ${names.length}`);
    assertUniqueColumns(names);
    const cols = [...this._cols.values()];
    this._cols.clear();
    names.forEach((n, j) => this._cols.set(n, cols[j]));
  }

  /** Replaces the index in place, like `df.index = labels`. */
  setAxis(labels: readonly Label[] | Index): this {
    this.index = toIndex(labels instanceof Index ? labels : [...labels], this.length);
    return this;
  }

  get shape(): [number, number] {
    return [this.index.length, this._cols.size];
  }

  get length(): number {
    return this.index.length;
  }

  get size(): number {
    return this.index.length * this._cols.size;
  }

  get empty(): boolean {
    return this.index.length === 0 || this._cols.size === 0;
  }

  get dtypes(): Series {
    return new Series([...this._cols.values()].map((c) => c.dtype), { index: this.columns, dtype: 'string' });
  }

  /** Rows as arrays (like `df.values` / `to_numpy()`). */
  get values(): unknown[][] {
    const cols = [...this._cols.values()];
    return Array.from({ length: this.length }, (_, i) => cols.map((c) => c.get(i)));
  }

  /** Transpose (columns become rows). */
  get T(): DataFrame {
    return this.transpose();
  }

  transpose(): DataFrame {
    const cols = new Map<string, Column>();
    const src = [...this._cols.values()];
    for (let i = 0; i < this.length; i++) cols.set(String(this.index.labels[i]), Column.from(src.map((c) => c.get(i))));
    return this.with(cols, new Index(this.columns));
  }

  /** @internal */
  _column(name: string): Column {
    const col = this._cols.get(name);
    if (!col) throw new KeyError(name);
    return col;
  }

  has(column: string): boolean {
    return this._cols.has(column);
  }

  *[Symbol.iterator](): IterableIterator<string> {
    yield* this._cols.keys();
  }

  /** `[name, Series]` pairs. */
  *items(): IterableIterator<[string, Series]> {
    for (const name of this._cols.keys()) yield [name, this.get(name)];
  }

  /** `[label, row]` pairs; rows are plain objects. */
  *iterrows(): IterableIterator<[Label, Record<string, unknown>]> {
    const entries = [...this._cols.entries()];
    for (let i = 0; i < this.length; i++) {
      const row: Record<string, unknown> = {};
      for (const [k, c] of entries) row[k] = c.get(i);
      yield [this.index.labels[i], row];
    }
  }

  // ----------------------------------------------------------------- selection

  /** `df.get('a')` ≈ `df['a']`; a list selects columns; a boolean mask selects rows. */
  get(column: string): Series;
  get(columns: readonly string[]): DataFrame;
  get(mask: Mask): DataFrame;
  get(key: string | readonly string[] | Mask): Series | DataFrame {
    const multi = this.nColumnLevels > 1;
    if (typeof key === 'string') {
      if (this._cols.has(key)) return Series._from(this._cols.get(key)!, this.index, multi ? null : key);
      if (multi) return this.columnGroup([key]);
      throw new KeyError(key);
    }
    if (isMask(key)) return this.loc(key);
    const list = key as readonly string[];
    if (multi && list.length <= this.nColumnLevels && list.every((k) => typeof k === 'string' && !this._cols.has(k)) && this.columnsWithPrefix(list).length > 0) {
      // A tuple: full key → Series, prefix → sub-frame.
      if (list.length === this.nColumnLevels) return Series._from(this._cols.get(colKey(list))!, this.index, null);
      return this.columnGroup(list);
    }
    const keys = list.flatMap((k) => (Array.isArray(k) ? [colKey(k as readonly string[])] : this._cols.has(k) || !multi ? [k] : this.columnsWithPrefix([k])));
    return this.with(new Map(keys.map((k) => [k, this._column(k)])));
  }

  /** One column as a Series; a tuple addresses a MultiIndex column, e.g. `column(['price', 'min'])`. */
  column(label: string | readonly string[]): Series {
    const key = typeof label === 'string' ? label : colKey(label);
    return Series._from(this._column(key), this.index, typeof label === 'string' && this.nColumnLevels === 1 ? label : null);
  }

  /** Sets (or replaces) a column in place, like `df['c'] = value`. Returns `this`. */
  set(column: string, value: ColumnValue): this {
    this._cols.set(column, toColumn(value, this.index));
    return this;
  }

  /** Returns a new frame with extra/replaced columns; values may be functions of the frame. */
  assign(columns: Record<string, ColumnValue | ((df: DataFrame) => ColumnValue)>): DataFrame {
    let out: DataFrame = this.copy({ deep: false });
    for (const [name, v] of Object.entries(columns)) {
      out = out.copy({ deep: false });
      out._cols.set(name, toColumn(typeof v === 'function' ? (v as (df: DataFrame) => ColumnValue)(out) : v, out.index));
    }
    return out;
  }

  /** Inserts a column at position `loc` in place. */
  insert(loc: number, column: string, value: ColumnValue): this {
    if (this._cols.has(column)) throw new Error(`Cannot insert ${column}, already exists`);
    const entries = [...this._cols.entries()];
    entries.splice(loc, 0, [column, toColumn(value, this.index)]);
    this._cols.clear();
    for (const [k, v] of entries) this._cols.set(k, v);
    return this;
  }

  /** Removes a column in place and returns it. */
  pop(column: string): Series {
    const s = this.get(column);
    this._cols.delete(column);
    return s;
  }

  /** Label-based selection. Row keys: label, labels, mask, slice (inclusive), callable or `null` for all. */
  loc(rows: readonly Label[] | Mask | Slice | null | ((df: DataFrame) => Mask), cols: string): Series;
  loc(rows: readonly Label[] | Mask | Slice | null | ((df: DataFrame) => Mask), cols?: Exclude<ColSelector, string> | null): DataFrame;
  loc(rows: Label, cols: string): unknown;
  loc(rows: Label, cols?: Exclude<ColSelector, string> | null): Series;
  loc(rows: RowSelector | null | ((df: DataFrame) => Mask), cols: ColSelector | null = null): unknown {
    if (typeof rows === 'function') return this.loc(rows(this), cols as never);
    const r = rows === null ? null : resolveRows(rows, this.index);
    const out = this.select(r ? r.pos : null, r !== null && r.scalar && r.pos.length === 1, cols, false);
    if (r && r.drop && (out instanceof DataFrame || out instanceof Series)) out.index = dropMatchedLevels(out.index, r.drop);
    return out;
  }

  /** Position-based selection. Row keys: integer, integers, mask, slice (exclusive), callable or `null`. */
  iloc(rows: number, cols: number): unknown;
  iloc(rows: number, cols?: readonly number[] | Slice | null): Series;
  iloc(rows: readonly number[] | Mask | Slice | null, cols: number): Series;
  iloc(rows: readonly number[] | Mask | Slice | null, cols?: readonly number[] | Slice | null): DataFrame;
  iloc(rows: number | readonly number[] | Mask | Slice | null, cols: number | readonly number[] | Slice | null = null): unknown {
    const pos = rows === null ? null : positionalPositions(rows, this.length);
    const names = this.columns;
    let colSel: ColSelector | null = null;
    if (typeof cols === 'number') colSel = names[positionalPositions(cols, names.length)[0]];
    else if (cols !== null) colSel = positionalPositions(cols, names.length).map((p) => names[p]);
    return this.select(pos, typeof rows === 'number', colSel, true);
  }

  private select(pos: number[] | null, rowScalar: boolean, cols: ColSelector | null, positional: boolean): unknown {
    const names = this.columnNames(cols, positional);
    const colScalar = typeof cols === 'string';

    if (rowScalar) {
      const p = pos![0];
      if (colScalar) return this._column(names[0]).get(p);
      return new Series(names.map((n) => this._column(n).get(p)), { index: names, name: labelName(this.index.labels[p]) });
    }
    const index = pos ? this.index.take(pos) : this.index;
    const take = (c: Column) => (pos ? c.take(pos) : c);
    if (colScalar) return Series._from(take(this._column(names[0])), index, names[0]);
    return this.with(new Map(names.map((n) => [n, take(this._column(n))])), index);
  }

  /** Single value by row label and column. */
  at(row: Label, column: string): unknown {
    const locs = this.index.getLoc(row);
    if (locs.length === 0) throw new KeyError(row);
    return this._column(column).get(locs[0]);
  }

  iat(row: number, column: number): unknown {
    return this.iloc(row, column);
  }

  // --------------------------------------------------------------- assignment

  /**
   * In-place assignment by labels, like `df.loc[rows, cols] = value`. `null`
   * selects everything on that axis. A new scalar row label appends a row and a
   * new column name adds a column. `value` may be a scalar, an array (one value
   * per selected row, per selected column when a single row is selected, or a
   * 2-D rows × columns array), a Series (aligned by row labels, or by column
   * labels for a single row) or a DataFrame (aligned on both axes).
   */
  setLoc(rows: RowSelector | null | ((df: DataFrame) => Mask), cols: ColSelector | null, value: unknown): this {
    const r = typeof rows === 'function' ? rows(this) : rows;
    const rowScalar = r !== null && isScalarKey(r, this.index);
    // Enlarging adds a missing cell to every column; remember int64 / bool columns so
    // they can return to their dtype once the new cell is filled (as pandas 2+ does).
    const before = new Map<string, DType>();
    if (rowScalar && !this.index.has(r as Label)) {
      const n = this.length;
      const grow = Int32Array.from({ length: n + 1 }, (_, i) => (i < n ? i : -1));
      for (const [k, c] of this._cols) {
        if (c.dtype === 'int64' || c.dtype === 'bool') before.set(k, c.dtype);
        this._cols.set(k, c.take(grow));
      }
      this.index = new Index([...this.index.labels, r as Label], { name: this.index.name, names: this.index.names });
    }
    const pos = r === null ? Array.from({ length: this.length }, (_, i) => i) : labelPositions(r as RowSelector, this.index);
    const names = this.columnNames(cols, false, true);
    this.assignBlock(pos, names, value, rowScalar, typeof cols === 'string');
    for (const [k, dtype] of before) {
      const c = this._cols.get(k)!;
      if (c.hasNA()) continue;
      const vals = c.toArray();
      const fits = dtype === 'int64' ? vals.every((v) => typeof v === 'number' && Number.isInteger(v)) : vals.every((v) => typeof v === 'boolean');
      if (fits) this._cols.set(k, Column.from(vals, dtype));
    }
    return this;
  }

  /** In-place assignment by positions, like `df.iloc[rows, cols] = value`. */
  setIloc(rows: number | readonly number[] | Mask | Slice | null, cols: number | readonly number[] | Slice | null, value: unknown): this {
    const pos = rows === null ? Array.from({ length: this.length }, (_, i) => i) : positionalPositions(rows, this.length);
    const all = this.columns;
    const names = cols === null ? all : positionalPositions(cols, all.length).map((p) => all[p]);
    return this.assignBlock(pos, names, value, typeof rows === 'number', typeof cols === 'number');
  }

  setAt(row: Label, column: string, value: unknown): this {
    return this.setLoc(row as RowSelector, column, value);
  }

  setIat(row: number, column: number, value: unknown): this {
    return this.setIloc(row, column, value);
  }

  /** Column names selected by a column key; unknown names are allowed when `allowNew`. */
  private columnNames(cols: ColSelector | null, positional: boolean, allowNew = false): string[] {
    if (cols === null) return this.columns;
    if (typeof cols === 'string') {
      if (!allowNew) this._column(cols);
      return [cols];
    }
    if (cols instanceof Slice) {
      const idx = new Index(this.columns);
      return (positional ? cols.positions(idx.length) : cols.labelPositions(idx)).map((p) => this.columns[p]);
    }
    if (cols.length > 0 && typeof cols[0] === 'boolean') return this.columns.filter((_, j) => (cols as readonly boolean[])[j]);
    if (!allowNew) for (const c of cols as readonly string[]) this._column(c);
    return [...(cols as readonly string[])];
  }

  private assignBlock(pos: readonly number[], names: readonly string[], value: unknown, rowScalar: boolean, colScalar: boolean): this {
    const labels = this.index.labels;
    let at: (k: number, j: number) => unknown;
    if (value instanceof DataFrame) {
      at = (k, j) => {
        if (!value.has(names[j])) return null;
        const p = value.index.getLoc(labels[pos[k]]);
        return p.length ? value._column(names[j]).get(p[0]) : null;
      };
    } else if (value instanceof Series) {
      at = rowScalar && !colScalar ? (_, j) => value.get(names[j], null) : (k) => value.get(labels[pos[k]], null);
    } else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const arr = value as ArrayLike<unknown>;
      if (arr.length > 0 && Array.isArray(arr[0])) {
        if (arr.length !== pos.length) throw new RangeError(`Expected ${pos.length} rows of values, got ${arr.length}`);
        at = (k, j) => (arr[k] as unknown[])[j];
      } else if (rowScalar && !colScalar) {
        if (arr.length !== names.length) throw new RangeError(`Expected ${names.length} values (one per column), got ${arr.length}`);
        at = (_, j) => arr[j];
      } else {
        if (arr.length !== pos.length) throw new RangeError(`Expected ${pos.length} values (one per row), got ${arr.length}`);
        at = (k) => arr[k];
      }
    } else at = () => value;

    names.forEach((name, j) => {
      const col = this._cols.get(name);
      if (col) this._cols.set(name, col.setAt(pos, (k) => at(k, j)));
      else {
        const arr = new Array(this.length).fill(null);
        pos.forEach((p, k) => (arr[p] = at(k, j)));
        this._cols.set(name, Column.from(arr));
      }
    });
    return this;
  }

  /** @internal Rows at positions. */
  take(positions: ArrayLike<number>): DataFrame {
    const cols = new Map<string, Column>();
    for (const [k, c] of this._cols) cols.set(k, c.take(positions));
    return this.with(cols, this.index.take(positions));
  }

  head(n = 5): DataFrame {
    return this.iloc(new Slice(0, n < 0 ? this.length + n : n));
  }

  tail(n = 5): DataFrame {
    return this.iloc(new Slice(n === 0 ? this.length : -n));
  }

  sample(n = 1, options: { seed?: number; frac?: number } = {}): DataFrame {
    const k = options.frac !== undefined ? Math.round(options.frac * this.length) : n;
    return this.take(samplePositions(this.length, k, options.seed));
  }

  /**
   * Filters rows with a pandas-style expression (`'age > 30 and city == "SP"'`,
   * `@var` for `locals`) or a predicate `(row, label) => boolean`.
   */
  query(expr: string | ((row: Record<string, unknown>, label: Label) => boolean), options: { locals?: Record<string, unknown> } = {}): DataFrame {
    if (typeof expr === 'string') {
      const mask = evaluateStatements(expr, { frame: this, locals: options.locals }).value;
      if (!(mask instanceof Series)) throw new TypeError('query expression must evaluate to a boolean Series');
      return this.loc(mask.dtype === 'boolean' ? mask.fillna(false).astype('bool') : mask);
    }
    const pos: number[] = [];
    let i = 0;
    for (const [label, row] of this.iterrows()) {
      if (expr(row, label)) pos.push(i);
      i++;
    }
    return this.take(pos);
  }

  /**
   * Evaluates a pandas-style expression over the columns. Assignments
   * (`'c = a + b'`, several separated by newlines or ';') return a new frame
   * (or modify this one with `inplace`); otherwise the expression's value is returned.
   */
  eval(expr: string, options: { locals?: Record<string, unknown>; inplace?: boolean } = {}): unknown {
    const target = options.inplace ? this : this.copy({ deep: false });
    return evaluateStatements(expr, { frame: target, locals: options.locals }).value;
  }

  /** Selects columns by name: exact `items`, substring `like` or `regex`. */
  filter(options: { items?: readonly string[]; like?: string; regex?: RegExp | string }): DataFrame {
    let names = this.columns;
    if (options.items) names = options.items.filter((c) => this._cols.has(c));
    if (options.like !== undefined) names = names.filter((c) => c.includes(options.like!));
    if (options.regex !== undefined) {
      const re = typeof options.regex === 'string' ? new RegExp(options.regex) : options.regex;
      names = names.filter((c) => re.test(c));
    }
    return this.get(names);
  }

  selectDtypes(options: { include?: readonly (DType | 'number')[]; exclude?: readonly (DType | 'number')[] }): DataFrame {
    const matches = (d: DType, list: readonly (DType | 'number')[]) => list.includes(d) || (list.includes('number') && isNumericDType(d) && d !== 'bool');
    return this.get(this.columns.filter((c) => {
      const d = this._cols.get(c)!.dtype;
      return (!options.include || matches(d, options.include)) && (!options.exclude || !matches(d, options.exclude));
    }));
  }

  drop(columns: string | readonly string[]): DataFrame;
  drop(options: { columns?: string | readonly string[]; index?: Label | readonly Label[] }): DataFrame;
  drop(arg: string | readonly string[] | { columns?: string | readonly string[]; index?: Label | readonly Label[] }): DataFrame {
    const opts = typeof arg === 'string' || Array.isArray(arg) ? { columns: arg as string | string[] } : (arg as { columns?: string | string[]; index?: Label | Label[] });
    let out: DataFrame = this;
    if (opts.columns !== undefined) {
      const drop = new Set(typeof opts.columns === 'string' ? [opts.columns] : opts.columns);
      for (const c of drop) if (!this._cols.has(c)) throw new KeyError(c);
      out = this.with(new Map([...this._cols].filter(([k]) => !drop.has(k))));
    }
    if (opts.index !== undefined) {
      const labels = Array.isArray(opts.index) && this.index.nlevels === 1 ? opts.index : [opts.index as Label];
      const dropPos = new Set(labelPositions(labels as Label[], out.index));
      out = out.take(Array.from({ length: out.length }, (_, i) => i).filter((i) => !dropPos.has(i)));
    }
    return out;
  }

  rename(options: { columns?: Record<string, string> | ((c: string) => string); index?: Record<string, Label> | ((l: Label) => Label) }): DataFrame {
    let cols = this._cols;
    if (options.columns) {
      const m = options.columns;
      const f = typeof m === 'function' ? m : (c: string) => m[c] ?? c;
      assertUniqueColumns([...this._cols.keys()].map(f));
      cols = new Map([...this._cols].map(([k, v]) => [f(k), v]));
    }
    let index = this.index;
    if (options.index) {
      const m = options.index;
      const f = typeof m === 'function' ? m : (l: Label) => (Object.hasOwn(m, String(l)) ? m[String(l)] : l);
      index = new Index(this.index.labels.map(f), { name: this.index.name, names: this.index.names });
    }
    return this.with(cols, index);
  }

  /** Conforms to new row labels and/or columns, filling holes with NA (or `fillValue`). */
  reindex(options: { index?: readonly Label[] | Index; columns?: readonly string[]; fillValue?: unknown }): DataFrame {
    let out: DataFrame = this;
    if (options.index) {
      const idx = options.index instanceof Index ? options.index : new Index([...options.index], { name: this.index.name });
      const cols = new Map<string, Column>();
      for (const name of out._cols.keys()) cols.set(name, out.get(name).reindex(idx, options.fillValue ?? null)._col);
      out = this.with(cols, idx);
    }
    if (options.columns) {
      out = this.with(new Map(options.columns.map((c) => [c, out._cols.get(c) ?? Column.full(out.length, options.fillValue ?? null)])), out.index);
    }
    return out;
  }

  // ------------------------------------------------------------------ indexes

  /** Uses one or more columns as the index. */
  setIndex(keys: string | readonly string[], options: { drop?: boolean } = {}): DataFrame {
    const names = typeof keys === 'string' ? [keys] : [...keys];
    const cols = names.map((n) => this._column(n));
    const index = names.length === 1
      ? new Index(cols[0].toArray() as Label[], { name: names[0] })
      : new Index(Array.from({ length: this.length }, (_, i) => cols.map((c) => c.get(i) as Label)), { names });
    const drop = options.drop ?? true;
    return this.with(drop ? new Map([...this._cols].filter(([k]) => !names.includes(k))) : new Map(this._cols), index);
  }

  /** Moves the index into column(s) and restores a default 0..n-1 index. */
  resetIndex(options: { drop?: boolean } = {}): DataFrame {
    const range = Index.range(this.length);
    if (options.drop) return this.with(new Map(this._cols), range);
    const cols = new Map<string, Column>();
    if (this.index.nlevels > 1) {
      this.index.names!.forEach((name, l) => {
        cols.set(name ?? `level_${l}`, Column.from(this.index.labels.map((t) => (t as readonly Label[])[l])));
      });
    } else {
      const name = this.index.name ?? (this._cols.has('index') ? 'level_0' : 'index');
      cols.set(name, Column.from(this.index.labels));
    }
    for (const [k, v] of this._cols) cols.set(k, v);
    return this.with(cols, range);
  }

  // -------------------------------------------------------------- aggregation

  private reduce(agg: AggName, options: AxisAggOptions = {}): Series {
    const numericOnly = options.numericOnly ?? NUMERIC_AGGS.has(agg);
    const names = this.columns.filter((c) => !numericOnly || isNumericDType(this._cols.get(c)!.dtype));
    if (isAxis1(options.axis)) {
      const sub = this.get(names);
      const rowCol = (i: number) => Column.from(names.map((n) => sub._cols.get(n)!.get(i)));
      const out = Array.from({ length: this.length }, (_, i) => aggregate(rowCol(i), agg, null, options));
      return new Series(out, { index: this.index });
    }
    const vals = names.map((n) => aggregate(this._cols.get(n)!, agg, null, options));
    return new Series(vals, { index: names });
  }

  sum(options?: AxisAggOptions): Series { return this.reduce('sum', options); }
  prod(options?: AxisAggOptions): Series { return this.reduce('prod', options); }
  mean(options?: AxisAggOptions): Series { return this.reduce('mean', options); }
  median(options?: AxisAggOptions): Series { return this.reduce('median', options); }
  std(options?: AxisAggOptions): Series { return this.reduce('std', options); }
  var(options?: AxisAggOptions): Series { return this.reduce('var', options); }
  min(options?: AxisAggOptions): Series { return this.reduce('min', options); }
  max(options?: AxisAggOptions): Series { return this.reduce('max', options); }
  count(options?: AxisAggOptions): Series { return this.reduce('count', options); }
  sem(options?: AxisAggOptions): Series { return this.reduce('sem', options); }
  skew(): Series { return this.perNumeric((s) => s.skew()); }
  kurt(): Series { return this.perNumeric((s) => s.kurt()); }
  kurtosis(): Series { return this.kurt(); }

  private perNumeric(fn: (s: Series) => unknown): Series {
    const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype));
    return new Series(names.map((n) => fn(this.get(n))), { index: names });
  }

  /** Rolling window of `window` rows, or a time span ('3D') over a datetime index / `on` column. */
  rolling(window: number | string | Timedelta, options: RollingOptions = {}): Rolling<DataFrame> {
    return new Rolling(this, window, options);
  }

  expanding(options: { minPeriods?: number } = {}): Expanding<DataFrame> {
    return new Expanding(this, options);
  }

  ewm(options: EwmOptions): EWM<DataFrame> {
    return new EWM(this, options);
  }
  any(options?: AxisAggOptions): Series { return this.reduce('any', options); }
  all(options?: AxisAggOptions): Series { return this.reduce('all', options); }
  nunique(options?: AxisAggOptions): Series { return this.reduce('nunique', options); }

  /** Quantile of each numeric column; `interpolation` as in pandas (default 'linear'). */
  quantile(q = 0.5, options: { interpolation?: QuantileInterpolation } = {}): Series {
    const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype));
    return new Series(names.map((n) => quantile(this._cols.get(n)!, q, null, options.interpolation ?? 'linear')), { index: names, name: String(q) });
  }

  /** Calls `fn(this, ...args)`, for chaining custom steps: `df.pipe(clean).pipe(addTotals, 'revenue')`. */
  pipe<T, A extends unknown[]>(fn: (df: DataFrame, ...args: A) => T, ...args: A): T {
    return fn(this, ...args);
  }

  idxmax(): Series {
    const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype));
    return new Series(names.map((n) => this.get(n).idxmax()), { index: names });
  }

  idxmin(): Series {
    const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype));
    return new Series(names.map((n) => this.get(n).idxmin()), { index: names });
  }

  /**
   * Aggregates columns. `func` may be a name/function (→ Series), a list
   * (→ DataFrame with one row per aggregation) or `{column: func | func[]}`.
   */
  agg(func: AggFunc): Series;
  agg(func: readonly AggFunc[] | Record<string, AggFunc | readonly AggFunc[]>): DataFrame;
  agg(func: AggFunc | readonly AggFunc[] | Record<string, AggFunc | readonly AggFunc[]>): Series | DataFrame {
    const label = (f: AggFunc, i: number) => (typeof f === 'function' ? f.name || `func${i}` : f);
    const apply = (name: string, f: AggFunc) => (typeof f === 'function' ? f(this.get(name)) : aggregate(this._column(name), f));
    if (typeof func === 'string' || typeof func === 'function') {
      if (typeof func === 'string') return this.reduce(func);
      return new Series(this.columns.map((c) => func(this.get(c))), { index: this.columns });
    }
    const spec: [string, readonly AggFunc[]][] = Array.isArray(func)
      ? this.columns.filter((c) => !func.some((f: AggFunc) => typeof f === 'string' && NUMERIC_AGGS.has(f)) || isNumericDType(this._cols.get(c)!.dtype)).map((c) => [c, func as readonly AggFunc[]])
      : Object.entries(func as Record<string, AggFunc | readonly AggFunc[]>).map(([c, f]) => [c, Array.isArray(f) ? f : [f as AggFunc]]);
    const rowLabels: string[] = [];
    for (const [, fs] of spec) fs.forEach((f, i) => { const l = label(f, i); if (!rowLabels.includes(l)) rowLabels.push(l); });
    const cols = new Map<string, Column>();
    for (const [c, fs] of spec) {
      const vals = rowLabels.map((l) => {
        const k = fs.findIndex((f, i) => label(f, i) === l);
        return k < 0 ? null : apply(c, fs[k]);
      });
      cols.set(c, Column.from(vals));
    }
    return this.with(cols, new Index(rowLabels));
  }

  /** Summary statistics of numeric columns (or all columns with `include: 'all'`). */
  describe(options: { include?: 'all' } = {}): DataFrame {
    const numeric = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype));
    const names = options.include === 'all' || numeric.length === 0 ? this.columns : numeric;
    const parts = names.map((n) => this.get(n).describe());
    const labels: Label[] = [];
    for (const p of parts) for (const l of p.index.labels) if (!labels.includes(l)) labels.push(l);
    const cols = new Map<string, Column>();
    names.forEach((n, j) => cols.set(n, parts[j].reindex(labels)._col));
    return this.with(cols, new Index(labels));
  }

  /** Pairwise correlation of numeric columns: pearson (default), spearman or kendall. */
  corr(options: { method?: CorrMethod; minPeriods?: number } = {}): DataFrame {
    return this.pairwise((x, y) => correlation(x, y, options.method, options.minPeriods));
  }

  /** Pairwise sample covariance of numeric columns. */
  cov(options: { minPeriods?: number; ddof?: number } = {}): DataFrame {
    return this.pairwise((x, y) => covariance(x, y, options.minPeriods, options.ddof));
  }

  /** Correlation of each column with the same-named column of `other` (or with a Series). */
  corrwith(other: DataFrame | Series, options: { method?: CorrMethod; axis?: 0 | 1 | 'index' | 'columns' } = {}): Series {
    if (isAxis1(options.axis)) {
      const o = other instanceof DataFrame ? other : null;
      const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype) && (!o || o.has(c)));
      const vals = Array.from({ length: this.length }, (_, i) => {
        const x = Float64Array.from(names, (n) => Number(this._cols.get(n)!.get(i) ?? NaN));
        const y = Float64Array.from(names, (n) => Number((o ? o._column(n).get(i) : (other as Series).get(n, NaN)) ?? NaN));
        return correlation(x, y, options.method);
      });
      return new Series(vals, { index: this.index });
    }
    const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype) && (other instanceof Series || other.has(c)));
    return new Series(names.map((n) => this.get(n).corr(other instanceof Series ? other : other.get(n), { method: options.method })), { index: names });
  }

  private pairwise(fn: (x: ArrayLike<number>, y: ArrayLike<number>) => number): DataFrame {
    const names = this.columns.filter((c) => isNumericDType(this._cols.get(c)!.dtype));
    const data = names.map((n) => numericView(this._cols.get(n)!));
    const cols = new Map<string, Column>();
    names.forEach((n, j) => cols.set(n, new Column('float64', Float64Array.from(names.map((_, i) => fn(data[i], data[j]))))));
    return this.with(cols, new Index(names));
  }

  // ---------------------------------------------------------------- transform

  /** Applies a Series → Series transform to every column (non-numeric ones are kept when `numericOnly`). */
  private mapColumns(fn: (s: Series) => Series, numericOnly = false): DataFrame {
    const cols = new Map<string, Column>();
    for (const [k, c] of this._cols) {
      cols.set(k, numericOnly && !isNumericDType(c.dtype) ? c : fn(Series._from(c, this.index, k))._col);
    }
    return this.with(cols);
  }

  cumsum(): DataFrame { return this.mapColumns((s) => s.cumsum(), true); }
  cumprod(): DataFrame { return this.mapColumns((s) => s.cumprod(), true); }
  cummax(): DataFrame { return this.mapColumns((s) => s.cummax(), true); }
  cummin(): DataFrame { return this.mapColumns((s) => s.cummin(), true); }
  abs(): DataFrame { return this.mapColumns((s) => s.abs(), true); }
  round(decimals = 0): DataFrame { return this.mapColumns((s) => s.round(decimals), true); }
  clip(lower?: number | null, upper?: number | null): DataFrame { return this.mapColumns((s) => s.clip(lower, upper), true); }
  /** Shifts rows by `periods` (or the datetime index with `{ freq }`). */
  shift(periods = 1, options: { freq?: string | DateOffset; fillValue?: unknown } = {}): DataFrame {
    if (options.freq !== undefined) return shiftIndex(this, periods, options.freq);
    return this.mapColumns((s) => s.shift(periods, { fillValue: options.fillValue }));
  }
  diff(periods = 1): DataFrame { return this.mapColumns((s) => s.diff(periods), true); }
  pctChange(periods = 1): DataFrame { return this.mapColumns((s) => s.pctChange(periods), true); }
  rank(options: RankOptions & { numericOnly?: boolean } = {}): DataFrame { return this.mapColumns((s) => s.rank(options), options.numericOnly); }

  /**
   * `axis: 0` (default) calls `fn(series, column)` per column; `axis: 1` calls
   * `fn(row, label)` per row with a plain object. Scalar results become a Series;
   * Series / object results become a DataFrame.
   */
  apply(fn: (s: Series, column: string) => unknown, options?: { axis?: 0 | 'index' }): Series | DataFrame;
  apply(fn: (row: Record<string, unknown>, label: Label) => unknown, options: { axis: 1 | 'columns' }): Series | DataFrame;
  apply(fn: (x: any, key: any) => unknown, options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): Series | DataFrame {
    if (isAxis1(options.axis)) {
      const results: unknown[] = [];
      for (const [label, row] of this.iterrows()) results.push(fn(row, label));
      if (results.length && results.every((r) => isPlainObject(r))) {
        return new DataFrame(results as Record<string, unknown>[], { index: this.index });
      }
      return new Series(results, { index: this.index });
    }
    const names = this.columns;
    const results = names.map((n) => fn(this.get(n), n));
    if (results.length && results.every((r) => r instanceof Series)) {
      const cols = new Map<string, Column>();
      names.forEach((n, j) => cols.set(n, (results[j] as Series)._col));
      return this.with(cols, (results[0] as Series).index);
    }
    return new Series(results, { index: names });
  }

  /** Element-wise function over every cell (pandas `DataFrame.map`, formerly `applymap`). */
  map(fn: (value: unknown) => unknown): DataFrame {
    return this.mapColumns((s) => s.map((v) => fn(v)));
  }

  applymap(fn: (value: unknown) => unknown): DataFrame {
    return this.map(fn);
  }

  /** Casts all columns, or per column with `{column: dtype}`. */
  astype(dtype: DType | Record<string, DType>, options: { categories?: readonly unknown[]; ordered?: boolean; freq?: string } = {}): DataFrame {
    const cols = new Map<string, Column>();
    for (const [k, c] of this._cols) {
      const d = typeof dtype === 'string' ? dtype : dtype[k];
      cols.set(k, d ? Series._from(c, this.index, k).astype(d, options)._col : c);
    }
    return this.with(cols);
  }

  /** Converts every column to the best nullable dtype (pandas `convert_dtypes`). */
  convertDtypes(): DataFrame {
    return this.mapColumns((s) => s.convertDtypes());
  }


  replace(from: unknown, to?: unknown): DataFrame {
    return this.mapColumns((s) => s.replace(from, to));
  }

  isin(values: Iterable<unknown> | Record<string, Iterable<unknown>>): DataFrame {
    if (isPlainObject(values)) {
      const m = values as Record<string, Iterable<unknown>>;
      return this.mapColumns((s) => (m[s.name!] ? s.isin(m[s.name!]) : new Series(Column.full(s.length, false, 'bool'), { index: s.index })));
    }
    const list = [...(values as Iterable<unknown>)];
    return this.mapColumns((s) => s.isin(list));
  }

  /** Keeps cells where `cond` holds; the rest become `other`. */
  where(cond: DataFrame | ((df: DataFrame) => DataFrame), other: unknown = null): DataFrame {
    const c = typeof cond === 'function' ? cond(this) : cond;
    return this.mapColumns((s) => (c.has(s.name!) ? s.where(c.get(s.name!), other) : s.map(() => other)));
  }

  mask(cond: DataFrame | ((df: DataFrame) => DataFrame), other: unknown = null): DataFrame {
    const c = typeof cond === 'function' ? cond(this) : cond;
    return this.mapColumns((s) => (c.has(s.name!) ? s.mask(c.get(s.name!), other) : s));
  }

  // ------------------------------------------------------------ missing data

  isna(): DataFrame { return this.mapColumns((s) => s.isna()); }
  notna(): DataFrame { return this.mapColumns((s) => s.notna()); }
  isnull(): DataFrame { return this.isna(); }
  notnull(): DataFrame { return this.notna(); }

  /** Fills NA with a scalar, or per column with `{column: value}`. */
  fillna(value: unknown): DataFrame {
    if (isPlainObject(value)) {
      const m = value as Record<string, unknown>;
      return this.mapColumns((s) => (Object.hasOwn(m, s.name!) ? s.fillna(m[s.name!]) : s));
    }
    return this.mapColumns((s) => s.fillna(value));
  }

  ffill(limit?: number): DataFrame { return this.mapColumns((s) => s.ffill(limit)); }
  bfill(limit?: number): DataFrame { return this.mapColumns((s) => s.bfill(limit)); }
  interpolate(options: InterpolateOptions = {}): DataFrame { return this.mapColumns((s) => s.interpolate(options), true); }

  /**
   * Drops rows (axis 0) or columns (axis 1) with missing values.
   * `how: 'any'` (default) or `'all'`; `thresh` keeps rows with at least that many non-NA values.
   */
  dropna(options: { axis?: 0 | 1 | 'index' | 'columns'; how?: 'any' | 'all'; thresh?: number; subset?: readonly string[] } = {}): DataFrame {
    const how = options.how ?? 'any';
    if (isAxis1(options.axis)) {
      const keep = this.columns.filter((c) => {
        const col = this._cols.get(c)!;
        let valid = 0;
        for (let i = 0; i < col.length; i++) if (!col.isNA(i)) valid++;
        if (options.thresh !== undefined) return valid >= options.thresh;
        return how === 'any' ? valid === col.length : valid > 0;
      });
      return this.get(keep);
    }
    const cols = (options.subset ?? this.columns).map((c) => this._column(c));
    const pos: number[] = [];
    for (let i = 0; i < this.length; i++) {
      let valid = 0;
      for (const c of cols) if (!c.isNA(i)) valid++;
      const keep = options.thresh !== undefined ? valid >= options.thresh : how === 'any' ? valid === cols.length : valid > 0;
      if (keep) pos.push(i);
    }
    return pos.length === this.length ? this : this.take(pos);
  }

  // ------------------------------------------------------------------ sorting

  /** Sorts by column(s); a MultiIndex column is a tuple, e.g. `sortValues([['preco', 'min']])`. */
  sortValues(by: string | readonly (string | readonly string[])[], options: { ascending?: boolean | readonly boolean[]; naPosition?: NaPosition } = {}): DataFrame {
    const names = this.columnKeys(by);
    const asc = options.ascending ?? true;
    const keys = names.map((n, i) => sortKeyFromColumn(this._column(n), typeof asc === 'boolean' ? asc : asc[i] ?? true));
    return this.take(argsort(keys, this.length, options.naPosition));
  }

  sortIndex(options: { ascending?: boolean } = {}): DataFrame {
    const key = sortKeyFromColumn(Column.from(this.index.labels, 'object'), options.ascending ?? true);
    return this.take(argsort([key], this.length));
  }

  nlargest(n: number, columns: string | readonly string[]): DataFrame {
    return this.dropna({ subset: typeof columns === 'string' ? [columns] : columns }).sortValues(columns, { ascending: false }).head(n);
  }

  nsmallest(n: number, columns: string | readonly string[]): DataFrame {
    return this.dropna({ subset: typeof columns === 'string' ? [columns] : columns }).sortValues(columns, { ascending: true }).head(n);
  }

  // --------------------------------------------------------------- duplicates

  duplicated(options: { subset?: string | readonly string[]; keep?: 'first' | 'last' | false } = {}): Series {
    const names = options.subset === undefined ? this.columns : typeof options.subset === 'string' ? [options.subset] : options.subset;
    const flags = duplicatedFlags(names.map((n) => this._column(n)), this.length, options.keep ?? 'first');
    return Series._from(new Column('bool', flags), this.index, null);
  }

  dropDuplicates(options: { subset?: string | readonly string[]; keep?: 'first' | 'last' | false; ignoreIndex?: boolean } = {}): DataFrame {
    const out = this.loc(this.duplicated(options).not());
    return options.ignoreIndex ? out.resetIndex({ drop: true }) : out;
  }

  /** Counts of unique rows (over `subset` columns), most frequent first. */
  valueCounts(options: { subset?: readonly string[]; normalize?: boolean; ascending?: boolean } = {}): Series {
    const subset = options.subset ?? this.columns;
    let s = this.groupby([...subset]).size().sortValues({ ascending: options.ascending ?? false });
    if (options.normalize) s = s.div(this.length).rename('proportion');
    else s = s.rename('count');
    return s;
  }

  // ---------------------------------------------------------- group / combine

  /**
   * Groups rows by column name(s), Series, arrays of keys, functions of the
   * index label, and/or index levels (`{ level }`).
   */
  groupby(by: GroupKey | readonly GroupKey[] | null, options: GroupByOptions & { asIndex: false }): DataFrameGroupBy<DataFrame>;
  groupby(by: GroupKey | readonly GroupKey[] | null, options?: GroupByOptions): DataFrameGroupBy;
  groupby(by: GroupKey | readonly GroupKey[] | null, options: GroupByOptions = {}): DataFrameGroupBy<Series | DataFrame> {
    const r = resolveGroupKeys(this, by, options.level);
    return new DataFrameGroupBy(r.frame, r.by, options, null, r.names);
  }


  merge(right: DataFrame, options: MergeOptions = {}): DataFrame {
    return merge(this, right, options);
  }

  /** Joins columns of `other` on the index. */
  join(other: DataFrame | Series, options: { how?: 'left' | 'right' | 'inner' | 'outer'; lsuffix?: string; rsuffix?: string } = {}): DataFrame {
    const right = other instanceof Series ? other.toFrame() : other;
    const how = options.how ?? 'left';
    let index: Index;
    if (how === 'left') index = this.index;
    else if (how === 'right') index = right.index;
    else if (how === 'inner') index = new Index(this.index.labels.filter((l) => right.index.has(l)), { name: this.index.name });
    else index = this.index.equals(right.index) ? this.index : this.index.union(right.index);
    const l = index === this.index ? this : this.reindex({ index });
    const r = index === right.index ? right : right.reindex({ index });
    const cols = new Map<string, Column>();
    const overlap = new Set(l.columns.filter((c) => r.has(c)));
    if (overlap.size && !options.lsuffix && !options.rsuffix) {
      throw new Error(`columns overlap but no suffix specified: ${[...overlap].join(', ')}`);
    }
    for (const [k, c] of l._cols) cols.set(overlap.has(k) ? k + (options.lsuffix ?? '') : k, c);
    for (const [k, c] of r._cols) cols.set(overlap.has(k) ? k + (options.rsuffix ?? '') : k, c);
    return this.with(cols, index);
  }

  /** Unpivots wide → long (`id_vars` kept, other columns stacked into variable/value). */
  melt(options: { idVars?: readonly string[]; valueVars?: readonly string[]; varName?: string; valueName?: string } = {}): DataFrame {
    const idVars = options.idVars ?? [];
    const valueVars = options.valueVars ?? this.columns.filter((c) => !idVars.includes(c));
    const n = this.length;
    const positions = Array.from({ length: n * valueVars.length }, (_, i) => i % n);
    const cols = new Map<string, Column>();
    for (const id of idVars) cols.set(id, this._column(id).take(positions));
    cols.set(options.varName ?? 'variable', Column.from(valueVars.flatMap((v) => new Array(n).fill(v)), 'string'));
    cols.set(options.valueName ?? 'value', Column.concat(valueVars.map((v) => this._column(v))));
    return this.with(cols, Index.range(positions.length));
  }

  /** Spreadsheet-style pivot table with aggregation, margins and multiple keys. */
  pivotTable(options: PivotTableOptions): DataFrame {
    return pivotTable(this, options);
  }

  /** Expands list-like cells of `columns` into one row per element. */
  explode(columns: string | readonly string[], options: { ignoreIndex?: boolean } = {}): DataFrame {
    return explodeFrame(this, columns, options.ignoreIndex);
  }

  /** Fills missing values (and missing labels) from `other`. */
  combineFirst(other: DataFrame): DataFrame {
    return combineFirst(this, other);
  }

  /** In-place update with the non-missing values of `other`. */
  update(other: DataFrame | Series, options: { overwrite?: boolean; filterFunc?: (v: unknown) => boolean } = {}): this {
    update(this, other, options);
    return this;
  }

  /** Cell differences with `other`, as (column, 'self'/'other') columns. */
  compare(other: DataFrame, options: { keepShape?: boolean; keepEqual?: boolean; resultNames?: [string, string] } = {}): DataFrame {
    return compare(this, other, options);
  }

  // ------------------------------------------------------- element-wise operators

  private binary(other: Operand | DataFrame, op: (a: Series, b: Operand) => Series): DataFrame {
    if (other instanceof DataFrame) {
      const index = this.index.equals(other.index) ? this.index : this.index.union(other.index);
      const names = [...new Set([...this.columns, ...other.columns])].sort();
      const l = this.reindex({ index, columns: names });
      const r = other.reindex({ index, columns: names });
      const cols = new Map<string, Column>();
      for (const n of names) cols.set(n, op(l.get(n), r.get(n))._col);
      return this.with(cols, index);
    }
    if (other instanceof Series) {
      // Like pandas' default axis='columns': other's labels match column names.
      const cols = new Map<string, Column>();
      for (const n of this.columns) {
        const v = other.get(n, null);
        cols.set(n, op(this.get(n), v as Operand)._col);
      }
      return this.with(cols);
    }
    return this.mapColumns((s) => op(s, other));
  }

  add(other: Operand | DataFrame, options: ArithOptions = {}): DataFrame { return this.binary(other, (a, b) => a.add(b, options)); }
  sub(other: Operand | DataFrame, options: ArithOptions = {}): DataFrame { return this.binary(other, (a, b) => a.sub(b, options)); }
  mul(other: Operand | DataFrame, options: ArithOptions = {}): DataFrame { return this.binary(other, (a, b) => a.mul(b, options)); }
  div(other: Operand | DataFrame, options: ArithOptions = {}): DataFrame { return this.binary(other, (a, b) => a.div(b, options)); }
  mod(other: Operand | DataFrame, options: ArithOptions = {}): DataFrame { return this.binary(other, (a, b) => a.mod(b, options)); }
  pow(other: Operand | DataFrame, options: ArithOptions = {}): DataFrame { return this.binary(other, (a, b) => a.pow(b, options)); }
  eq(other: Operand | DataFrame): DataFrame { return this.binary(other, (a, b) => a.eq(b)); }
  ne(other: Operand | DataFrame): DataFrame { return this.binary(other, (a, b) => a.ne(b)); }
  lt(other: Operand | DataFrame): DataFrame { return this.binary(other, (a, b) => a.lt(b)); }
  le(other: Operand | DataFrame): DataFrame { return this.binary(other, (a, b) => a.le(b)); }
  gt(other: Operand | DataFrame): DataFrame { return this.binary(other, (a, b) => a.gt(b)); }
  ge(other: Operand | DataFrame): DataFrame { return this.binary(other, (a, b) => a.ge(b)); }



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
  droplevel(level: number | string | readonly (number | string)[], options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): DataFrame {
    return onAxis(this, options.axis, (i) => i.droplevel(level));
  }

  swaplevel(i: number | string = -2, j: number | string = -1, options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): DataFrame {
    return onAxis(this, options.axis, (x) => x.swaplevel(i, j));
  }

  reorderLevels(order: readonly (number | string)[], options: { axis?: 0 | 1 | 'index' | 'columns' } = {}): DataFrame {
    return onAxis(this, options.axis, (x) => x.reorderLevels(order));
  }

  /** Moves a column level into the row index (flat columns → Series). */
  stack(options: { level?: number | string; dropna?: boolean } = {}): Series | DataFrame {
    return stack(this, options);
  }

  /** Moves row index level(s) into the columns. */
  unstack(options: { level?: number | string | readonly (number | string)[]; fillValue?: unknown } = {}): DataFrame | Series {
    return unstack(this, options);
  }

  /** Reshapes without aggregation, like `df.pivot(index, columns, values)`. */
  pivot(options: { index?: string | readonly string[]; columns: string | readonly string[]; values?: string | readonly string[] }): DataFrame {
    return pivot(this, options);
  }

  // -------------------------------------------------------------- time series

  /** @internal Same data with another index. */
  _withIndex(index: Index): this {
    return this.with(new Map(this._cols), index) as this;
  }

  /** Groups by time bins, like `resample('ME')` / `resample('15min')`. */
  resample(rule: string | DateOffset, options: ResampleOptions = {}): Resampler<DataFrame> {
    return new Resampler(this, rule, options);
  }

  /** Conforms a datetime index to `freq`, optionally filling ('ffill' / 'bfill'). */
  asfreq(freq: string | DateOffset, options: { method?: 'pad' | 'ffill' | 'bfill' | 'backfill'; fillValue?: unknown } = {}): DataFrame {
    return asfreq(this, freq, options) as DataFrame;
  }

  /** Localizes a naive datetime index to `tz` (or removes the zone with null). */
  tzLocalize(tz: string | null, options: { ambiguous?: Ambiguous; nonexistent?: Nonexistent } = {}): DataFrame {
    return tzLocalizeIndex(this, tz, options);
  }

  /** Converts a tz-aware datetime index to another zone. */
  tzConvert(tz: string | null): DataFrame {
    return tzConvertIndex(this, tz);
  }

  /** Rows at a time of day, e.g. `atTime('09:30')`. */
  atTime(time: string): DataFrame {
    return this.take(atTimePositions(this.index, time)) as DataFrame;
  }

  /** Rows between two times of day, e.g. `betweenTime('09:00', '17:00')`. */
  betweenTime(start: string, end: string, options: { inclusive?: 'both' | 'neither' | 'left' | 'right' } = {}): DataFrame {
    return this.take(betweenTimePositions(this.index, start, end, options.inclusive)) as DataFrame;
  }

  /** Rows with index labels between `before` and `after` (inclusive). */
  truncate(options: { before?: Label | string; after?: Label | string } = {}): DataFrame {
    return this.take(truncatePositions(this.index, options.before, options.after)) as DataFrame;
  }

  /** Converts a datetime index to a period index. */
  toPeriod(freq = 'D'): DataFrame {
    return toPeriodIndex(this, freq);
  }

  /** Converts a period index to datetimes at the start (or end) of each period. */
  toTimestamp(how: 'start' | 'end' = 'start'): DataFrame {
    return toTimestampIndex(this, how);
  }

  firstValidIndex(): Label {
    for (let i = 0; i < this.length; i++) if ([...this._cols.values()].some((c) => !c.isNA(i))) return this.index.labels[i];
    return null;
  }

  lastValidIndex(): Label {
    for (let i = this.length - 1; i >= 0; i--) if ([...this._cols.values()].some((c) => !c.isNA(i))) return this.index.labels[i];
    return null;
  }

  // ------------------------------------------------------------------- output

  copy(options: { deep?: boolean } = {}): DataFrame {
    const deep = options.deep ?? true;
    const cols = new Map<string, Column>();
    for (const [k, c] of this._cols) cols.set(k, deep ? new Column(c.dtype, c.data.slice()) : c);
    return this.with(cols);
  }

  equals(other: DataFrame): boolean {
    if (!(other instanceof DataFrame) || !this.index.equals(other.index)) return false;
    const a = this.columns, b = other.columns;
    if (a.length !== b.length || a.some((c, i) => c !== b[i])) return false;
    return a.every((c) => this.get(c).equals(other.get(c)));
  }

  /** Row records `[{col: value}, ...]` (pandas `to_dict('records')`). */
  toRecords(): Record<string, unknown>[] {
    return [...this.iterrows()].map(([, row]) => row);
  }

  toDict(orient: 'dict' | 'list' | 'records' | 'index' | 'series' = 'dict'): unknown {
    switch (orient) {
      case 'records': return this.toRecords();
      case 'list': return Object.fromEntries(this.columns.map((c) => [c, this._cols.get(c)!.toArray()]));
      case 'series': return Object.fromEntries(this.columns.map((c) => [c, this.get(c)]));
      case 'index': return Object.fromEntries([...this.iterrows()].map(([l, r]) => [String(l), r]));
      default: return Object.fromEntries(this.columns.map((c) => [c, this.get(c).toDict()]));
    }
  }

  toJSON(): Record<string, unknown>[] {
    return this.toRecords();
  }

  toCsv(path?: string, options: ToCsvOptions = {}): string {
    return toCsv(this, path, options);
  }

  toJson(path?: string, options: Parameters<typeof toJson>[2] = {}): string {
    return toJson(this, path, options);
  }


  /** Bytes used per column (and the index), like `memory_usage`; `deep` counts string contents. */
  memoryUsage(options: { index?: boolean; deep?: boolean } = {}): Series {
    const names = this.columns;
    const vals = names.map((n) => columnBytes(this._cols.get(n)!, options.deep ?? false));
    if (options.index ?? true) return new Series([indexBytes(this.index, options.deep ?? false), ...vals], { index: ['Index', ...names], dtype: 'int64' });
    return new Series(vals, { index: names, dtype: 'int64' });
  }

  /** Conditional formatting (Styler), like `df.style`. */
  get style(): Styler {
    return new Styler(this);
  }

  /** LaTeX tabular (booktabs), like `to_latex`. */
  toLatex(options: { index?: boolean; header?: boolean; caption?: string; label?: string; position?: string; columnFormat?: string; naRep?: string; floatFormat?: string | ((v: number) => string) } = {}): string {
    const names = this.columns;
    const rows = Array.from({ length: this.length }, (_, i) => names.map((n) => {
      const c = this._cols.get(n)!;
      const v = c.get(i);
      if (isNA(v) && options.naRep !== undefined) return options.naRep;
      if (typeof v === 'number' && !isNA(v) && options.floatFormat && (c.dtype === 'float64' || c.dtype === 'Float64')) return typeof options.floatFormat === 'function' ? options.floatFormat(v) : pyFormat(options.floatFormat, v);
      return exportCell(c, i, 'latex');
    }));
    const index = options.index === false ? null : this.index.labels.map((l) => (Array.isArray(l) ? l.join(' ') : formatScalar(l)));
    return latexTable(index, options.header === false ? names.map(() => '') : names.map((n) => colTuple(n).join(' ')), rows, names.map((n) => isNumericDType(this._cols.get(n)!.dtype)), { ...options, hrules: true });
  }

  /** Markdown pipe table (tabulate style), like `to_markdown`. */
  toMarkdown(options: { index?: boolean } = {}): string {
    const names = this.columns;
    const showIndex = options.index ?? true;
    const columns: { header: string; cells: string[]; numeric: boolean }[] = [];
    if (showIndex) {
      const labels = this.index.labels;
      columns.push({ header: this.index.name ?? '', cells: labels.map((l) => (typeof l === 'number' ? formatSpec(l, 'g') : formatScalar(l))), numeric: labels.every((l) => typeof l === 'number') });
    }
    for (const n of names) {
      const c = this._cols.get(n)!;
      const numeric = isNumericDType(c.dtype) && c.dtype !== 'bool';
      const cells = Array.from({ length: this.length }, (_, i) => {
        const v = c.get(i);
        if (isNA(v)) return 'nan';
        if (typeof v === 'number') return formatSpec(v, 'g');
        return typeof v === 'boolean' ? (v ? 'True' : 'False') : formatScalar(v);
      });
      columns.push({ header: colTuple(n).join(' '), cells, numeric });
    }
    return pipeTable(columns);
  }

  /** HTML table markup (pandas-compatible); writes to `path` when given. */
  toHtml(path?: string, options: ToHtmlOptions = {}): string {
    return toHtml(this, path, options);
  }

  /** Writes rows to a SQL table (sqlite path, node:sqlite / better-sqlite3 / pg / mysql2 connection). */
  toSql(table: string, conn: SqlConnection, options: ToSqlOptions = {}): Promise<number> {
    return toSql(this, table, conn, options);
  }

  /** Writes an .xlsx workbook (requires the optional `exceljs`); resolves to the file bytes. */
  toExcel(path?: string, options: ToExcelOptions = {}): Promise<Buffer> {
    return toExcel(this, path, options);
  }

  /** Writes Parquet (requires the optional `hyparquet-writer`); resolves to the bytes. */
  toParquet(path?: string, options: ToParquetOptions = {}): Promise<Buffer> {
    return toParquet(this, path, options);
  }

  /** Writes Feather / Arrow IPC (requires the optional `apache-arrow`); resolves to the bytes. */
  toFeather(path?: string, options: { index?: boolean } = {}): Promise<Buffer> {
    return toFeather(this, path, options);
  }

  /** Writes HDF5 in pandas' 'table' format (requires the optional `h5wasm`). */
  toHdf(path: string, key: string, options: ToHdfOptions = {}): Promise<void> {
    return toHdf(this, path, key, options);
  }

  /** XML document (pandas layout); writes to `path` when given. */
  toXml(path?: string, options: ToXmlOptions = {}): string {
    return toXml(this, path, options);
  }

  /** Concise summary: dtypes and non-null counts per column. */
  info(): string {
    const lines = ['<DataFrame>'];
    const idx = this.index;
    lines.push(idx.isDefault ? `RangeIndex: ${idx.length} entries, 0 to ${Math.max(0, idx.length - 1)}` : `Index: ${idx.length} entries`);
    lines.push(`Data columns (total ${this._cols.size} columns):`);
    const names = this.columns;
    const rows = names.map((n, i) => [String(i).padStart(2), n, `${aggregate(this._cols.get(n)!, 'count')} non-null`, this._cols.get(n)!.dtype]);
    lines.push(renderTable([[' #', 'Column', 'Non-Null Count', 'Dtype']], [0, 1, 2, 3].map((j) => rows.map((r) => r[j])), 4));
    const counts = new Map<string, number>();
    for (const c of this._cols.values()) counts.set(c.dtype, (counts.get(c.dtype) ?? 0) + 1);
    lines.push('dtypes: ' + [...counts].map(([d, n]) => `${d}(${n})`).join(', '));
    const bytes = (this.memoryUsage().sum() as number);
    const hasObjects = [...this._cols.values()].some((c) => c.dtype === 'string' || c.dtype === 'object');
    lines.push(`memory usage: ${humanBytes(bytes, hasObjects ? '+' : '')}`);
    return lines.join('\n');
  }

  /**
   * Text rendering (what `console.log(df)` shows). Options override the global
   * display options for this call.
   */
  toString(opts?: { maxRows?: number; maxCols?: number; index?: boolean; header?: boolean; naRep?: string; lineWidth?: number; showDimensions?: boolean | 'truncate'; columns?: readonly string[] }): string {
    // No options: repr, truncated by the display options (console.log, String(df)).
    // With options: like pandas' to_string(), complete unless maxRows / maxCols / lineWidth say otherwise.
    const repr = opts === undefined;
    const options = opts ?? {};
    const frame = options.columns ? this.get(options.columns) : this;
    const [nrows, ncols] = frame.shape;
    if (ncols === 0 || nrows === 0) {
      return `Empty DataFrame\nColumns: [${frame.columns.join(', ')}]\nIndex: [${frame.index.labels.map(String).join(', ')}]`;
    }
    const maxRows = options.maxRows ?? (repr ? DISPLAY.maxRows : 0);
    const maxCols = options.maxCols ?? (repr ? DISPLAY.maxColumns : 0);
    const width = options.lineWidth ?? (repr ? DISPLAY.width : 0);
    const rowPos = displayPositions(nrows, maxRows || Infinity, Math.min(DISPLAY.minRows, maxRows || Infinity));
    const names = frame.columns;
    const levels = frame.nColumnLevels;
    const showIndex = options.index ?? true;
    const idx = showIndex ? formatIndex(frame.index, rowPos) : [];
    const cellCols = names.map((n) => formatColumn(frame._cols.get(n)!, rowPos).map((v) => (options.naRep !== undefined && (v === 'NaN' || v === 'null' || v === '<NA>') ? options.naRep : v)));
    const headerOf = (j: number) => (levels > 1 ? colTuple(names[j]) : [names[j]]);
    const colWidth = (j: number) => Math.max(...headerOf(j).map((h) => h.length), ...cellCols[j].map((c) => c.length));
    // Hide middle columns when there are too many, or when the table is wider than the line width.
    let colPos = displayPositions(ncols, maxCols || Infinity, maxCols || Infinity);
    const idxWidth = idx.reduce((w, c) => w + Math.max(...c.map((x) => x.length)) + 2, 0);
    const tableWidth = (pos: (number | null)[]) => idxWidth + pos.reduce((w: number, j) => w + (j === null ? 3 : colWidth(j)) + 2, 0);
    if (width && tableWidth(colPos) > width && ncols > 1) {
      let keep = Math.min(ncols, colPos.filter((j) => j !== null).length);
      while (keep > 2) {
        keep -= 1;
        const half = Math.ceil(keep / 2);
        const cand = [...Array.from({ length: half }, (_, k) => k), null, ...Array.from({ length: keep - half }, (_, k) => ncols - (keep - half) + k)];
        colPos = cand;
        if (tableWidth(cand) <= width) break;
      }
    }
    const headers: string[][] = Array.from({ length: levels }, (_, l) => idx.map((_, k) => (k === idx.length - 1 ? (levels > 1 ? (this._colNames?.[l] ?? '') : (this._colNames?.[0] ?? '')) : '')));
    const indexNames: string[] = showIndex ? (frame.index.nlevels > 1 ? frame.index.names!.map((n) => n ?? '') : [frame.index.name ?? '']) : [];
    const body: string[][] = [...idx];
    let prev: string[] | null = null;
    for (const j of colPos) {
      if (j === null) { headers.forEach((h) => h.push('...')); indexNames.push(''); body.push(rowPos.map(() => '...')); prev = null; continue; }
      const tuple = headerOf(j);
      tuple.forEach((part, l) => {
        const same = prev !== null && l < levels - 1 && tuple.slice(0, l + 1).every((p, k) => p === prev![k]);
        headers[l].push(same ? '' : part);
      });
      prev = tuple;
      indexNames.push('');
      body.push(cellCols[j]);
    }
    let out = renderTable(options.header === false ? [] : [...headers, indexNames], body, idx.length, !showIndex);
    const truncated = nrows > rowPos.filter((p) => p !== null).length || colPos.includes(null);
    const dims = options.showDimensions ?? (repr ? DISPLAY.showDimensions : false);
    if (dims === true || (dims === 'truncate' && truncated)) out += `\n\n[${nrows} rows x ${ncols} columns]`;
    return out;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

// ----------------------------------------------------------------- helpers

/** Like pandas: '180.0+ bytes', '1.2 KB' (the '+' marks a lower bound when objects are not measured). */
function humanBytes(n: number, plus = ''): string {
  for (const unit of ['bytes', 'KB', 'MB', 'GB']) {
    if (n < 1024 || unit === 'GB') return `${n.toFixed(1)}${plus} ${unit}`;
    n /= 1024;
  }
  return `${n.toFixed(1)}${plus} TB`;
}

/** Bytes of one column (typed storage exactly; object references as 8 bytes, plus contents when deep). */
export function columnBytes(c: Column, deep: boolean): number {
  if (c.data instanceof Float64Array || c.data instanceof Uint8Array || c.data instanceof Int32Array) {
    let n = c.data.byteLength;
    if (c.dtype === 'category') n += c.meta.categories!.length * 8 + (deep ? c.meta.categories!.reduce((s: number, v) => s + (typeof v === 'string' ? 49 + Buffer.byteLength(v) : 0), 0) : 0);
    return n;
  }
  let n = c.length * 8;
  if (deep) for (const v of c.data as unknown[]) if (typeof v === 'string') n += 49 + Buffer.byteLength(v);
  return n;
}

function indexBytes(index: Index, deep: boolean): number {
  if (index.isDefault) return 132;
  return columnBytes(Column.from(index.labels.map((l) => (Array.isArray(l) ? l.join(',') : l))), deep);
}

/** Markdown pipe table in tabulate's layout (decimal-aligned numbers). */
function pipeTable(columns: { header: string; cells: string[]; numeric: boolean }[]): string {
  const aligned = columns.map((col) => {
    if (!col.numeric) return col.cells;
    const dec = Math.max(0, ...col.cells.map((s) => (s.includes('.') ? s.length - s.indexOf('.') - 1 : 0)));
    return col.cells.map((s) => (s.includes('.') ? s + ' '.repeat(dec - (s.length - s.indexOf('.') - 1)) : s + ' '.repeat(dec ? dec + 1 : 0)));
  });
  const widths = columns.map((col, j) => Math.max(col.header.length + 2, ...aligned[j].map((s) => s.length)));
  const pad = (s: string, j: number) => (columns[j].numeric ? s.padStart(widths[j]) : s.padEnd(widths[j]));
  const lines = ['| ' + columns.map((c, j) => pad(c.header, j)).join(' | ') + ' |'];
  lines.push('|' + columns.map((c, j) => (c.numeric ? '-'.repeat(widths[j] + 1) + ':' : ':' + '-'.repeat(widths[j] + 1))).join('|') + '|');
  for (let i = 0; i < (aligned[0]?.length ?? 0); i++) lines.push('| ' + aligned.map((col, j) => pad(col[i], j)).join(' | ') + ' |');
  return lines.join('\n');
}

/** Column labels are keys of a Map, so duplicates would silently drop data. */
function assertUniqueColumns(keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) throw new Error(`Duplicate column label "${k.split(COL_SEP).join(', ')}": pandasx requires unique column labels`);
    seen.add(k);
  }
}

function isArrayish(v: unknown): boolean {
  return Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof Column;
}

function unionKeys(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

function labelName(l: Label): string | null {
  return l === null ? null : String(l);
}

/** Turns a Series (aligned on `index`), array or scalar (broadcast) into a column. */
function toColumn(v: unknown, index: Index, dtype?: DType): Column {
  if (v instanceof Series) {
    const s = v.index.equals(index) ? v : v.reindex(index);
    return dtype ? s._col.astype(dtype) : s._col;
  }
  if (isArrayish(v)) {
    const col = Column.from(v as ArrayLike<unknown>, dtype);
    if (col.length !== index.length) throw new RangeError(`Length of values (${col.length}) does not match length of index (${index.length})`);
    return col;
  }
  return Column.full(index.length, v, dtype);
}


