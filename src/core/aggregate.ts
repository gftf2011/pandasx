import { Column } from './column.ts';
import { Timedelta } from './time.ts';
import { isNumericStorage, NULLABLE_DTYPES, type AggName } from './types.ts';
import { compareValues, hashKey } from './values.ts';

export interface AggOptions {
  /** Exclude missing values (default true). */
  skipna?: boolean;
  /** Delta degrees of freedom for std/var/sem (default 1). */
  ddof?: number;
  /** Minimum number of valid values for sum/prod, else NA (default 0). */
  minCount?: number;
}

/** Aggregations that only make sense for numeric data. */
export const NUMERIC_AGGS: ReadonlySet<AggName> = new Set<AggName>(['sum', 'mean', 'median', 'std', 'var', 'sem', 'prod']);

/** The missing value an aggregation of `col` returns. */
export function missingOf(col: Column): unknown {
  return col.dtype === 'float64' || col.dtype === 'int64' || col.dtype === 'bool' ? NaN : null;
}

/**
 * Reduces `col` (optionally restricted to `rows`) to a scalar. This kernel backs
 * Series, DataFrame and GroupBy aggregations.
 */
export function aggregate(col: Column, agg: AggName, rows: ArrayLike<number> | null = null, opts: AggOptions = {}): unknown {
  const skipna = opts.skipna ?? true;
  const n = rows ? rows.length : col.length;
  const at = rows ? (i: number) => rows[i] : (i: number) => i;

  switch (agg) {
    case 'size':
      return n;
    case 'count': {
      let c = 0;
      for (let i = 0; i < n; i++) if (!col.isNA(at(i))) c++;
      return c;
    }
    case 'first':
    case 'last': {
      const forward = agg === 'first';
      for (let k = 0; k < n; k++) {
        const p = at(forward ? k : n - 1 - k);
        if (!col.isNA(p)) return col.get(p);
      }
      return missingOf(col);
    }
    case 'nunique': {
      const seen = new Set<unknown>();
      for (let i = 0; i < n; i++) {
        const p = at(i);
        if (!col.isNA(p)) seen.add(hashKey(col.get(p)));
      }
      return seen.size;
    }
    case 'any':
    case 'all': {
      const wantAny = agg === 'any';
      for (let i = 0; i < n; i++) {
        const p = at(i);
        if (col.isNA(p)) continue;
        if (Boolean(col.get(p)) === wantAny) return wantAny;
      }
      return !wantAny;
    }
    case 'min':
    case 'max':
      return extreme(col, agg === 'max', n, at, skipna);
  }

  if (col.dtype === 'bigint') return bigintAgg(col, agg, n, at, skipna, opts);
  if (col.dtype === 'timedelta' || col.dtype === 'datetime') {
    if (agg === 'sum' && col.dtype === 'datetime') throw new TypeError('Cannot sum datetime values');
    if (agg === 'prod' || agg === 'var') throw new TypeError(`Cannot compute ${agg} of dtype ${col.dtype}`);
    const ms = numericAgg(col.data as Float64Array, agg, n, rows, skipna, opts);
    if (Number.isNaN(ms)) return null;
    if (col.dtype === 'datetime' && agg !== 'std' && agg !== 'sem') return new Date(ms);
    return new Timedelta(ms);
  }
  if (!isNumericStorage(col.dtype) || col.dtype === 'period') {
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
  const v = numericAgg(col.data as ArrayLike<number>, agg, n, rows, skipna, opts);
  return NULLABLE_DTYPES.has(col.dtype) && Number.isNaN(v) ? null : v;
}

/** Numeric reductions straight over typed storage, without intermediate arrays. */
function numericAgg(data: ArrayLike<number>, agg: AggName, n: number, rows: ArrayLike<number> | null, skipna: boolean, opts: AggOptions): number {
  if (agg === 'median') {
    const vals: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = data[rows ? rows[i] : i];
      if (v !== v) { if (!skipna) return NaN; } else vals.push(v);
    }
    return medianOf(vals);
  }
  // Welford's algorithm gives sum, mean and variance in one stable pass.
  let k = 0, sum = 0, prod = 1, mean = 0, m2 = 0;
  const moments = agg === 'var' || agg === 'std' || agg === 'sem';
  for (let i = 0; i < n; i++) {
    const v = data[rows ? rows[i] : i];
    if (v !== v) {
      if (!skipna) return NaN;
      continue;
    }
    k++;
    sum += v;
    if (agg === 'prod') prod *= v;
    else if (moments) {
      const d = v - mean;
      mean += d / k;
      m2 += d * (v - mean);
    }
  }
  const minCount = opts.minCount ?? 0;
  switch (agg) {
    case 'sum': return k < minCount ? NaN : sum;
    case 'prod': return k < minCount ? NaN : prod;
    case 'mean': return k === 0 ? NaN : sum / k;
    case 'var':
    case 'std':
    case 'sem': {
      const ddof = opts.ddof ?? 1;
      if (k - ddof <= 0) return NaN;
      const variance = m2 / (k - ddof);
      if (agg === 'var') return variance;
      return agg === 'std' ? Math.sqrt(variance) : Math.sqrt(variance) / Math.sqrt(k);
    }
    default:
      throw new Error(`Unknown aggregation: ${agg as string}`);
  }
}

function bigintAgg(col: Column, agg: AggName, n: number, at: (i: number) => number, skipna: boolean, opts: AggOptions): unknown {
  const vals: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const p = at(i);
    if (col.isNA(p)) { if (!skipna) return null; continue; }
    vals.push(col.get(p) as bigint);
  }
  if (agg === 'sum') return vals.length < (opts.minCount ?? 0) ? null : vals.reduce((a, b) => a + b, 0n);
  if (agg === 'prod') return vals.reduce((a, b) => a * b, 1n);
  const asNum = new Float64Array(vals.map(Number));
  return numericAgg(asNum, agg, asNum.length, null, true, opts);
}

function medianOf(vals: number[]): number {
  if (vals.length === 0) return NaN;
  vals.sort((a, b) => a - b);
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function extreme(col: Column, max: boolean, n: number, at: (i: number) => number, skipna: boolean): unknown {
  if (col.dtype === 'category' && !col.meta.ordered) {
    throw new TypeError('Categorical is not ordered for min/max; use astype("category", { ordered: true })');
  }
  let best = -1;
  for (let i = 0; i < n; i++) {
    const p = at(i);
    if (col.isNA(p)) {
      if (!skipna) return missingOf(col);
      continue;
    }
    if (best < 0) { best = p; continue; }
    const c = compareValues(col.raw(p), col.raw(best));
    if (max ? c > 0 : c < 0) best = p;
  }
  if (best < 0) return missingOf(col);
  return col.get(best);
}

export type QuantileInterpolation = 'linear' | 'lower' | 'higher' | 'midpoint' | 'nearest';

/** Quantile of the numeric values of `col`, linear interpolation by default (as pandas). */
export function quantile(col: Column, q: number, rows: ArrayLike<number> | null = null, interpolation: QuantileInterpolation = 'linear'): number {
  const c = col.dtype === 'bigint' ? Column.from(col.toArray().map((v) => (v === null ? NaN : Number(v))), 'float64') : col;
  if (!isNumericStorage(c.dtype) || c.dtype === 'period') throw new TypeError(`Cannot compute quantile of dtype ${col.dtype}`);
  const data = c.data as ArrayLike<number>;
  const vals: number[] = [];
  const n = rows ? rows.length : c.length;
  for (let i = 0; i < n; i++) {
    const v = data[rows ? rows[i] : i];
    if (v === v) vals.push(v);
  }
  if (vals.length === 0) return NaN;
  vals.sort((a, b) => a - b);
  const pos = (vals.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  switch (interpolation) {
    case 'lower': return vals[lo];
    case 'higher': return vals[hi];
    case 'midpoint': return (vals[lo] + vals[hi]) / 2;
    case 'nearest': return vals[pos - lo <= 0.5 && !(pos - lo === 0.5 && lo % 2 === 1) ? lo : hi];
    default: return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo);
  }
}
