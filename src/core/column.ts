import { normalizeFreq, parseDate, parsePeriodString, parseTimedelta, Period, periodOrdinal, Timedelta, type PeriodFreq } from './time.ts';
import { isFloatStorage, NULLABLE_DTYPES, type DType, type Storage } from './types.ts';
import { compareValues, hashKey, isNA } from './values.ts';

/** Extra information some dtypes carry. */
export interface ColumnMeta {
  /** `category`: the categories, in order. */
  categories?: readonly unknown[];
  /** `category`: whether the category order is meaningful. */
  ordered?: boolean;
  /** `period`: the frequency. */
  freq?: PeriodFreq;
}

/**
 * An immutable, typed, one-dimensional block of values. Series and DataFrame
 * are thin wrappers that pair columns with an Index.
 */
export class Column {
  readonly dtype: DType;
  readonly data: Storage;
  readonly meta: ColumnMeta;

  constructor(dtype: DType, data: Storage, meta: ColumnMeta = {}) {
    this.dtype = dtype;
    this.data = data;
    this.meta = meta;
  }

  static from(values: Iterable<unknown> | ArrayLike<unknown>, dtype?: DType, meta: ColumnMeta = {}): Column {
    if (values instanceof Column) return dtype ? values.astype(dtype, meta) : values;
    if (!dtype && values instanceof Float64Array) return new Column('float64', values.slice());
    const arr = Array.isArray(values) ? values : Array.from(values as ArrayLike<unknown>);
    return castArray(arr, dtype ?? inferDType(arr), meta);
  }

  /**
   * Builds a column from `values` keeping the dtype of `like` when the values fit
   * (e.g. filling an Int64 column with integers stays Int64), upcasting otherwise.
   */
  static fromLike(values: readonly unknown[], like: Column): Column {
    if (like.dtype === 'category') {
      const cats = new Set(like.meta.categories!.map(hashKey));
      if (values.every((v) => isNA(v) || cats.has(hashKey(v)))) return castArray(values, 'category', like.meta);
      return Column.from(values);
    }
    const allNA = values.every(isNA);
    let target: DType;
    if (allNA) target = like.dtype === 'int64' ? 'float64' : like.dtype === 'bool' ? 'object' : like.dtype;
    else {
      const d = inferDType(values);
      const hasNA = values.some(isNA);
      const integral = values.every((v) => isNA(v) || (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'boolean');
      if (d === like.dtype) target = d;
      else if (like.dtype === 'Int64' && (d === 'int64' || d === 'float64' || d === 'bool')) target = integral ? 'Int64' : 'Float64';
      else if (like.dtype === 'Float64' && (d === 'int64' || d === 'float64' || d === 'bool')) target = 'Float64';
      else if (like.dtype === 'boolean' && (d === 'bool' || d === 'object') && values.every((v) => isNA(v) || typeof v === 'boolean')) target = 'boolean';
      else if (like.dtype === 'int64' && d === 'float64') target = 'float64';
      else if (like.dtype === 'float64' && d === 'int64') target = 'float64';
      else if (like.dtype === 'bool' && d === 'object' && hasNA && values.every((v) => isNA(v) || typeof v === 'boolean')) target = 'object';
      else if ((like.dtype === 'datetime' || like.dtype === 'timedelta' || like.dtype === 'period') && values.every((v) => isNA(v) || fitsTemporal(v, like.dtype))) target = like.dtype;
      else if (like.dtype === 'bigint' && values.every((v) => isNA(v) || typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v)))) target = 'bigint';
      else target = commonDType([like.dtype, d]);
    }
    return castArray(values, target, target === 'period' ? like.meta : {});
  }

  /** A column of `n` copies of `value`. */
  static full(n: number, value: unknown, dtype?: DType, meta: ColumnMeta = {}): Column {
    const dt = dtype ?? inferDType([value]);
    if (isFloatStorage(dt) && dt !== 'period') {
      const v = toNumber(value, dt);
      return new Column(dt === 'int64' && Number.isNaN(v) ? 'float64' : dt, new Float64Array(n).fill(v));
    }
    if (dt === 'bool') return new Column('bool', new Uint8Array(n).fill(value ? 1 : 0));
    return castArray(new Array(n).fill(isNA(value) ? null : value), dt, meta);
  }

  static empty(dtype: DType = 'object'): Column {
    return castArray([], dtype);
  }

  get length(): number {
    return this.data.length;
  }

  /** The JS value at position `i` (NaN for missing float64/int64, null otherwise). */
  get(i: number): unknown {
    const d = this.data;
    switch (this.dtype) {
      case 'float64':
      case 'int64':
        return (d as Float64Array)[i];
      case 'Int64':
      case 'Float64': {
        const v = (d as Float64Array)[i];
        return v !== v ? null : v;
      }
      case 'boolean': {
        const v = (d as Float64Array)[i];
        return v !== v ? null : v === 1;
      }
      case 'bool':
        return (d as Uint8Array)[i] === 1;
      case 'datetime': {
        const t = (d as Float64Array)[i];
        return t !== t ? null : new Date(t);
      }
      case 'timedelta': {
        const t = (d as Float64Array)[i];
        return t !== t ? null : new Timedelta(t);
      }
      case 'period': {
        const t = (d as Float64Array)[i];
        return t !== t ? null : new Period(t, this.meta.freq);
      }
      case 'category': {
        const c = (d as Int32Array)[i];
        return c < 0 ? null : this.meta.categories![c];
      }
      default: {
        const v = (d as unknown[])[i];
        return v === undefined ? null : v;
      }
    }
  }

  /**
   * A primitive cheap to compare: numbers for numeric/temporal storage, category
   * codes for ordered categoricals.
   */
  raw(i: number): unknown {
    if (isFloatStorage(this.dtype) || this.dtype === 'bool') return (this.data as ArrayLike<number>)[i];
    if (this.dtype === 'category' && this.meta.ordered) return (this.data as Int32Array)[i];
    return this.get(i);
  }

  isNA(i: number): boolean {
    switch (this.dtype) {
      case 'int64':
      case 'bool':
        return false;
      case 'category':
        return (this.data as Int32Array)[i] < 0;
      default:
        if (isFloatStorage(this.dtype)) {
          const v = (this.data as Float64Array)[i];
          return v !== v;
        }
        return isNA((this.data as unknown[])[i]);
    }
  }

  hasNA(): boolean {
    if (this.dtype === 'int64' || this.dtype === 'bool') return false;
    for (let i = 0; i < this.length; i++) if (this.isNA(i)) return true;
    return false;
  }

  toArray(): unknown[] {
    const out = new Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = this.get(i);
    return out;
  }

  /** Gathers positions; a position of -1 yields a missing value (upcasting if required). */
  take(positions: ArrayLike<number>): Column {
    const n = positions.length;
    let hasMissing = false;
    for (let i = 0; i < n; i++) if (positions[i] < 0) { hasMissing = true; break; }

    if (isFloatStorage(this.dtype)) {
      const src = this.data as Float64Array;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = positions[i] < 0 ? NaN : src[positions[i]];
      return new Column(this.dtype === 'int64' && hasMissing ? 'float64' : this.dtype, out, this.meta);
    }
    if (this.dtype === 'bool') {
      const src = this.data as Uint8Array;
      if (hasMissing) {
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = positions[i] < 0 ? null : src[positions[i]] === 1;
        return new Column('object', out);
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = src[positions[i]];
      return new Column('bool', out);
    }
    if (this.dtype === 'category') {
      const src = this.data as Int32Array;
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) out[i] = positions[i] < 0 ? -1 : src[positions[i]];
      return new Column('category', out, this.meta);
    }
    const src = this.data as unknown[];
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = positions[i] < 0 ? null : src[positions[i]];
    return new Column(this.dtype, out, this.meta);
  }

  slice(start: number, end: number): Column {
    return new Column(this.dtype, this.data.slice(start, end), this.meta);
  }

  /** Element-wise transform; the output dtype is inferred unless given. */
  map(fn: (value: unknown, i: number) => unknown, dtype?: DType): Column {
    const out = new Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = fn(this.get(i), i);
    return Column.from(out, dtype);
  }

  /** Like `map`, but keeps this column's dtype when the results fit. */
  mapLike(fn: (value: unknown, i: number) => unknown): Column {
    const out = new Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = fn(this.get(i), i);
    return Column.fromLike(out, this);
  }

  /** Copy with `values(k)` written at `positions[k]` (dtype upcast as needed). */
  setAt(positions: readonly number[], values: (k: number) => unknown): Column {
    const out = this.toArray();
    positions.forEach((p, k) => (out[p] = values(k)));
    return Column.fromLike(out, this);
  }

  astype(dtype: DType, meta: ColumnMeta = {}): Column {
    if (dtype === this.dtype && dtype !== 'category' && dtype !== 'period') return this;
    if (dtype === this.dtype && dtype === 'period' && (!meta.freq || meta.freq === this.meta.freq)) return this;
    if (dtype === 'category' && this.dtype === 'category' && !meta.categories && meta.ordered === undefined) return this;
    if (isFloatStorage(this.dtype) && (dtype === 'float64' || dtype === 'Float64') && this.dtype !== 'period') {
      return new Column(dtype, this.data.slice());
    }
    if ((this.dtype === 'int64' || this.dtype === 'Int64') && (dtype === 'Int64' || dtype === 'int64')) {
      if (dtype === 'int64' && this.hasNA()) throw new TypeError('Cannot convert NA to int64; use the nullable "Int64" dtype');
      return new Column(dtype, this.data.slice());
    }
    if (this.dtype === 'datetime' && dtype === 'period') {
      const freq = meta.freq ?? 'D';
      return new Column('period', (this.data as Float64Array).map((t) => periodOrdinal(t, freq)), { freq });
    }
    if (this.dtype === 'period' && dtype === 'datetime') {
      return Column.from(this.toArray().map((p) => (p === null ? null : (p as Period).startTime)), 'datetime');
    }
    return castArray(this.toArray(), dtype, meta);
  }

  static concat(cols: readonly Column[]): Column {
    if (cols.length === 0) return Column.empty();
    if (cols.every((c) => c.dtype === 'category')) return concatCategories(cols);
    const dtype = cols.every((c) => c.dtype === 'period' && c.meta.freq === cols[0].meta.freq) ? 'period' : commonDType(cols.map((c) => c.dtype));
    const total = cols.reduce((s, c) => s + c.length, 0);
    if (isFloatStorage(dtype) && cols.every((c) => isFloatStorage(c.dtype))) {
      const out = new Float64Array(total);
      let off = 0;
      for (const c of cols) { out.set(c.data as Float64Array, off); off += c.length; }
      return new Column(dtype, out, dtype === 'period' ? cols[0].meta : {});
    }
    if (dtype === 'bool') {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of cols) { out.set(c.data as Uint8Array, off); off += c.length; }
      return new Column('bool', out);
    }
    const out: unknown[] = [];
    for (const c of cols) for (let i = 0; i < c.length; i++) out.push(c.isNA(i) ? null : c.get(i));
    return castArray(out, dtype);
  }
}

function concatCategories(cols: readonly Column[]): Column {
  const cats: unknown[] = [];
  const pos = new Map<unknown, number>();
  for (const c of cols) for (const v of c.meta.categories!) {
    const k = hashKey(v);
    if (!pos.has(k)) { pos.set(k, cats.length); cats.push(v); }
  }
  const total = cols.reduce((s, c) => s + c.length, 0);
  const out = new Int32Array(total);
  let off = 0;
  for (const c of cols) {
    const remap = c.meta.categories!.map((v) => pos.get(hashKey(v))!);
    const codes = c.data as Int32Array;
    for (let i = 0; i < codes.length; i++) out[off + i] = codes[i] < 0 ? -1 : remap[codes[i]];
    off += codes.length;
  }
  const same = cols.every((c) => c.meta.categories!.length === cats.length && c.meta.categories!.every((v, i) => hashKey(v) === hashKey(cats[i])));
  return new Column('category', out, { categories: cats, ordered: same && cols.every((c) => c.meta.ordered) });
}

function fitsTemporal(v: unknown, dtype: DType): boolean {
  if (dtype === 'datetime') return v instanceof Date || typeof v === 'string';
  if (dtype === 'timedelta') return v instanceof Timedelta || typeof v === 'string';
  return v instanceof Period || typeof v === 'string' || v instanceof Date;
}

/** The dtype able to hold values of all given dtypes. */
export function commonDType(dtypes: readonly DType[]): DType {
  const set = new Set(dtypes);
  if (set.size === 1) return dtypes[0];
  const only = (...allowed: DType[]) => [...set].every((d) => allowed.includes(d));
  if (only('int64', 'float64')) return 'float64';
  if (only('int64', 'Int64')) return 'Int64';
  if (only('int64', 'float64', 'Int64', 'Float64')) return 'Float64';
  if (only('bool', 'boolean')) return 'boolean';
  if (only('int64', 'bigint')) return 'bigint';
  return 'object';
}

export function inferDType(values: ArrayLike<unknown>): DType {
  let num = false, nonInt = false, bool = false, str = false, date = false, td = false, per = false, big = false, other = false, na = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) { na = true; continue; }
    switch (typeof v) {
      case 'number':
        if (v !== v) na = true;
        else { num = true; if (!Number.isInteger(v)) nonInt = true; }
        break;
      case 'boolean': bool = true; break;
      case 'string': str = true; break;
      case 'bigint': big = true; break;
      default:
        if (v instanceof Date) { if (Number.isNaN(v.getTime())) na = true; else date = true; }
        else if (v instanceof Timedelta) td = true;
        else if (v instanceof Period) per = true;
        else other = true;
    }
  }
  const kinds = Number(num) + Number(bool) + Number(str) + Number(date) + Number(td) + Number(per) + Number(big) + Number(other);
  if (kinds === 0) return 'float64';
  if (kinds > 1 || other) return 'object';
  if (num) return nonInt || na ? 'float64' : 'int64';
  if (bool) return na ? 'object' : 'bool';
  if (str) return 'string';
  if (big) return 'bigint';
  if (td) return 'timedelta';
  if (per) return 'period';
  return 'datetime';
}

function toNumber(v: unknown, dtype: DType): number {
  if (isNA(v)) return NaN;
  if (dtype === 'datetime') {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return parseDate(v);
    return Number(v);
  }
  if (dtype === 'timedelta') {
    if (v instanceof Timedelta) return v.ms;
    if (typeof v === 'string') return parseTimedelta(v);
    return Number(v);
  }
  if (dtype === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (v instanceof Timedelta) return v.ms;
  if (typeof v === 'string') return v.trim() === '' ? NaN : Number(v);
  return Number(v);
}

function castArray(arr: readonly unknown[], dtype: DType, meta: ColumnMeta = {}): Column {
  const n = arr.length;
  switch (dtype) {
    case 'float64':
    case 'Float64':
    case 'datetime':
    case 'timedelta':
    case 'boolean': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = toNumber(arr[i], dtype);
      return new Column(dtype, out);
    }
    case 'int64':
    case 'Int64': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = toNumber(arr[i], dtype);
        if (v !== v && dtype === 'Int64') { out[i] = NaN; continue; }
        if (!Number.isFinite(v)) throw new TypeError(`Cannot convert non-finite value ${String(arr[i])} to ${dtype}`);
        if (dtype === 'Int64' && !Number.isInteger(v)) throw new TypeError(`Cannot safely cast non-integer ${v} to Int64`);
        out[i] = Math.trunc(v);
      }
      return new Column(dtype, out);
    }
    case 'bool': {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = isNA(arr[i]) ? 0 : arr[i] ? 1 : 0;
      return new Column('bool', out);
    }
    case 'period': {
      const freq = normalizeFreq(meta.freq ?? inferPeriodFreq(arr) ?? 'D');
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (isNA(v)) out[i] = NaN;
        else if (v instanceof Period) out[i] = v.freq === freq ? v.ordinal : periodOrdinal(v.startTime.getTime(), freq);
        else if (v instanceof Date) out[i] = periodOrdinal(v.getTime(), freq);
        else if (typeof v === 'number') out[i] = v;
        else out[i] = periodOrdinal(parsePeriodString(String(v)), freq);
      }
      return new Column('period', out, { freq });
    }
    case 'category': {
      let categories = meta.categories;
      if (!categories) {
        const seen = new Map<unknown, unknown>();
        for (const v of arr) if (!isNA(v)) seen.set(hashKey(v), v);
        categories = [...seen.values()].sort(compareValues);
      }
      const pos = new Map<unknown, number>(categories.map((c, i) => [hashKey(c), i]));
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) out[i] = isNA(arr[i]) ? -1 : pos.get(hashKey(arr[i])) ?? -1;
      return new Column('category', out, { categories, ordered: meta.ordered ?? false });
    }
    case 'bigint': {
      const out = new Array<bigint | null>(n);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (isNA(v)) out[i] = null;
        else if (typeof v === 'bigint') out[i] = v;
        else if (typeof v === 'number') out[i] = BigInt(Math.trunc(v));
        else out[i] = BigInt(String(v).trim());
      }
      return new Column('bigint', out);
    }
    case 'string': {
      const out = new Array<string | null>(n);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        out[i] = isNA(v) ? null : v instanceof Date ? v.toISOString() : String(v);
      }
      return new Column('string', out);
    }
    default: {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = arr[i] === undefined ? null : arr[i];
      return new Column('object', out);
    }
  }
}

function inferPeriodFreq(arr: readonly unknown[]): PeriodFreq | undefined {
  for (const v of arr) if (v instanceof Period) return v.freq;
  return undefined;
}

export { NULLABLE_DTYPES };
