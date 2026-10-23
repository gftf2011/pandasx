import { isFloatStorage, type DType, type Storage } from './types.ts';
import { isNA } from './values.ts';

/**
 * An immutable, typed, one-dimensional block of values. Series and DataFrame
 * are thin wrappers that pair columns with an Index.
 */
export class Column {
  readonly dtype: DType;
  readonly data: Storage;

  constructor(dtype: DType, data: Storage) {
    this.dtype = dtype;
    this.data = data;
  }

  static from(values: Iterable<unknown> | ArrayLike<unknown>, dtype?: DType): Column {
    if (values instanceof Column) return dtype ? values.astype(dtype) : values;
    if (!dtype && values instanceof Float64Array) return new Column('float64', values.slice());
    const arr = Array.isArray(values) ? values : Array.from(values as ArrayLike<unknown>);
    return castArray(arr, dtype ?? inferDType(arr));
  }

  /** A column of `n` copies of `value`. */
  static full(n: number, value: unknown, dtype?: DType): Column {
    const dt = dtype ?? inferDType([value]);
    if (isFloatStorage(dt)) {
      const v = toNumber(value, dt);
      return new Column(dt === 'int64' && Number.isNaN(v) ? 'float64' : dt, new Float64Array(n).fill(v));
    }
    if (dt === 'bool') return new Column('bool', new Uint8Array(n).fill(value ? 1 : 0));
    return new Column(dt, new Array(n).fill(isNA(value) ? null : value));
  }

  static empty(dtype: DType = 'object'): Column {
    return castArray([], dtype);
  }

  get length(): number {
    return this.data.length;
  }

  /** The JS value at position `i` (NaN for missing numbers, null otherwise). */
  get(i: number): unknown {
    const d = this.data;
    switch (this.dtype) {
      case 'float64':
      case 'int64':
        return (d as Float64Array)[i];
      case 'bool':
        return (d as Uint8Array)[i] === 1;
      case 'datetime': {
        const t = (d as Float64Array)[i];
        return Number.isNaN(t) ? null : new Date(t);
      }
      default: {
        const v = (d as unknown[])[i];
        return v === undefined ? null : v;
      }
    }
  }

  /** A primitive value at `i` cheap to compare: numbers for numeric/datetime storage. */
  raw(i: number): unknown {
    return this.dtype === 'bool' || this.dtype === 'datetime' ? (this.data as ArrayLike<number>)[i] : this.get(i);
  }

  isNA(i: number): boolean {
    switch (this.dtype) {
      case 'int64':
      case 'bool':
        return false;
      case 'float64':
      case 'datetime':
        return Number.isNaN((this.data as Float64Array)[i]);
      default:
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
      return new Column(this.dtype === 'int64' && hasMissing ? 'float64' : this.dtype, out);
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
    const src = this.data as unknown[];
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = positions[i] < 0 ? null : src[positions[i]];
    return new Column(this.dtype, out);
  }

  slice(start: number, end: number): Column {
    return new Column(this.dtype, this.data.slice(start, end));
  }

  /** Element-wise transform; the output dtype is inferred unless given. */
  map(fn: (value: unknown, i: number) => unknown, dtype?: DType): Column {
    const out = new Array(this.length);
    for (let i = 0; i < out.length; i++) out[i] = fn(this.get(i), i);
    return Column.from(out, dtype);
  }

  astype(dtype: DType): Column {
    if (dtype === this.dtype) return this;
    if (isFloatStorage(this.dtype) && dtype === 'float64') return new Column('float64', this.data.slice());
    return castArray(this.toArray(), dtype);
  }

  static concat(cols: readonly Column[]): Column {
    if (cols.length === 0) return Column.empty();
    const dtype = commonDType(cols.map((c) => c.dtype));
    const total = cols.reduce((s, c) => s + c.length, 0);
    if (isFloatStorage(dtype)) {
      const out = new Float64Array(total);
      let off = 0;
      for (const c of cols) {
        out.set(c.dtype === dtype || isFloatStorage(c.dtype) ? (c.data as Float64Array) : (c.astype(dtype).data as Float64Array), off);
        off += c.length;
      }
      return new Column(dtype, out);
    }
    if (dtype === 'bool') {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of cols) { out.set(c.data as Uint8Array, off); off += c.length; }
      return new Column('bool', out);
    }
    const out: unknown[] = [];
    for (const c of cols) for (let i = 0; i < c.length; i++) out.push(c.isNA(i) ? null : c.get(i));
    return new Column(dtype, out);
  }
}

/** The dtype able to hold values of all given dtypes. */
export function commonDType(dtypes: readonly DType[]): DType {
  const set = new Set(dtypes);
  if (set.size === 1) return dtypes[0];
  if ([...set].every((d) => d === 'int64' || d === 'float64')) return 'float64';
  if ([...set].every((d) => d === 'int64' || d === 'float64' || d === 'bool')) return 'object';
  if ([...set].every((d) => d === 'string')) return 'string';
  return 'object';
}

export function inferDType(values: ArrayLike<unknown>): DType {
  let num = false, nonInt = false, bool = false, str = false, date = false, other = false, na = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) { na = true; continue; }
    switch (typeof v) {
      case 'number':
        if (Number.isNaN(v)) na = true;
        else { num = true; if (!Number.isInteger(v)) nonInt = true; }
        break;
      case 'boolean': bool = true; break;
      case 'string': str = true; break;
      default:
        if (v instanceof Date) date = true;
        else other = true;
    }
  }
  const kinds = Number(num) + Number(bool) + Number(str) + Number(date) + Number(other);
  if (kinds === 0) return 'float64';
  if (kinds > 1 || other) return 'object';
  if (num) return nonInt || na ? 'float64' : 'int64';
  if (bool) return na ? 'object' : 'bool';
  if (str) return 'string';
  return 'datetime';
}

function toNumber(v: unknown, dtype: DType): number {
  if (isNA(v)) return NaN;
  if (dtype === 'datetime') {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return Date.parse(v);
    return Number(v);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return v.trim() === '' ? NaN : Number(v);
  return Number(v);
}

function castArray(arr: readonly unknown[], dtype: DType): Column {
  const n = arr.length;
  switch (dtype) {
    case 'float64':
    case 'datetime': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = toNumber(arr[i], dtype);
      return new Column(dtype, out);
    }
    case 'int64': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = toNumber(arr[i], dtype);
        if (!Number.isFinite(v)) throw new TypeError(`Cannot convert non-finite value ${String(arr[i])} to int64`);
        out[i] = Math.trunc(v);
      }
      return new Column('int64', out);
    }
    case 'bool': {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = isNA(arr[i]) ? 0 : arr[i] ? 1 : 0;
      return new Column('bool', out);
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
