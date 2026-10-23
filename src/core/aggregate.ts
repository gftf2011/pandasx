import type { Column } from './column.ts';
import { isNumericDType, type AggName } from './types.ts';
import { compareValues, hashKey } from './values.ts';

export interface AggOptions {
  /** Exclude missing values (default true). */
  skipna?: boolean;
  /** Delta degrees of freedom for std/var (default 1). */
  ddof?: number;
}

/** Aggregations that only make sense for numeric data. */
export const NUMERIC_AGGS: ReadonlySet<AggName> = new Set<AggName>(['sum', 'mean', 'median', 'std', 'var', 'prod']);

/**
 * Reduces `col` (optionally restricted to `rows`) to a scalar. This kernel backs
 * Series, DataFrame and GroupBy aggregations.
 */
export function aggregate(col: Column, agg: AggName, rows: ArrayLike<number> | null = null, opts: AggOptions = {}): unknown {
  const skipna = opts.skipna ?? true;
  const n = rows ? rows.length : col.length;
  const at = rows ? (i: number) => rows[i] : (i: number) => i;

  if (agg === 'size') return n;
  if (agg === 'count') {
    let c = 0;
    for (let i = 0; i < n; i++) if (!col.isNA(at(i))) c++;
    return c;
  }
  if (agg === 'first' || agg === 'last') {
    const forward = agg === 'first';
    for (let k = 0; k < n; k++) {
      const p = at(forward ? k : n - 1 - k);
      if (!col.isNA(p)) return col.get(p);
    }
    return col.dtype === 'float64' || col.dtype === 'int64' ? NaN : null;
  }
  if (agg === 'nunique') {
    const seen = new Set<unknown>();
    for (let i = 0; i < n; i++) {
      const p = at(i);
      if (!col.isNA(p)) seen.add(hashKey(col.get(p)));
    }
    return seen.size;
  }
  if (agg === 'min' || agg === 'max') return extreme(col, agg === 'max', n, at, skipna);

  if (!isNumericDType(col.dtype)) {
    if (agg === 'sum' && (col.dtype === 'string' || col.dtype === 'object')) {
      let s = '';
      for (let i = 0; i < n; i++) {
        const p = at(i);
        if (!col.isNA(p)) s += String(col.get(p));
      }
      return s;
    }
    throw new TypeError(`Cannot compute ${agg} of dtype ${col.dtype}`);
  }

  // Numeric fast path over the raw Float64Array / Uint8Array storage, without intermediate arrays.
  const data = col.data as ArrayLike<number>;
  if (agg === 'median') {
    const vals: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = data[rows ? rows[i] : i];
      if (v !== v) { if (!skipna) return NaN; } else vals.push(v);
    }
    if (vals.length === 0) return NaN;
    vals.sort((a, b) => a - b);
    const mid = vals.length >> 1;
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }
  // Welford's algorithm gives sum, mean and variance in one stable pass.
  let k = 0, sum = 0, prod = 1, mean = 0, m2 = 0;
  for (let i = 0; i < n; i++) {
    const v = data[rows ? rows[i] : i];
    if (v !== v) {
      if (!skipna) return NaN;
      continue;
    }
    k++;
    sum += v;
    if (agg === 'prod') prod *= v;
    else if (agg === 'var' || agg === 'std') {
      const d = v - mean;
      mean += d / k;
      m2 += d * (v - mean);
    }
  }
  switch (agg) {
    case 'sum': return sum;
    case 'prod': return prod;
    case 'mean': return k === 0 ? NaN : sum / k;
    case 'var':
    case 'std': {
      const ddof = opts.ddof ?? 1;
      if (k - ddof <= 0) return NaN;
      const variance = m2 / (k - ddof);
      return agg === 'std' ? Math.sqrt(variance) : variance;
    }
    default:
      throw new Error(`Unknown aggregation: ${agg as string}`);
  }
}

function extreme(col: Column, max: boolean, n: number, at: (i: number) => number, skipna: boolean): unknown {
  let best = -1;
  for (let i = 0; i < n; i++) {
    const p = at(i);
    if (col.isNA(p)) {
      if (!skipna) return col.dtype === 'float64' ? NaN : null;
      continue;
    }
    if (best < 0) { best = p; continue; }
    const c = compareValues(col.raw(p), col.raw(best));
    if (max ? c > 0 : c < 0) best = p;
  }
  if (best < 0) return col.dtype === 'float64' || col.dtype === 'int64' ? NaN : null;
  return col.get(best);
}

/** Linear-interpolated quantile, as pandas' default. */
export function quantile(col: Column, q: number, rows: ArrayLike<number> | null = null): number {
  if (!isNumericDType(col.dtype)) throw new TypeError(`Cannot compute quantile of dtype ${col.dtype}`);
  const data = col.data as ArrayLike<number>;
  const vals: number[] = [];
  const n = rows ? rows.length : col.length;
  for (let i = 0; i < n; i++) {
    const v = data[rows ? rows[i] : i];
    if (!Number.isNaN(v)) vals.push(v);
  }
  if (vals.length === 0) return NaN;
  vals.sort((a, b) => a - b);
  const pos = (vals.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo);
}
