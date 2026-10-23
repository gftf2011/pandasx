/** Window computations: rolling, expanding and exponentially weighted (ewm). */
import { Column } from './core/column.ts';
import { toOffset } from './core/offsets.ts';
import { parseTimedelta, Timedelta } from './core/time.ts';
import { isNumericDType } from './core/types.ts';
import { DataFrame } from './frame.ts';
import { numericView, Series } from './series.ts';

export type WinType =
  | 'boxcar' | 'triang' | 'hamming' | 'hann' | 'bartlett' | 'blackman' | 'blackmanharris' | 'nuttall'
  | 'flattop' | 'bohman' | 'parzen' | 'cosine' | 'gaussian' | 'exponential';

export interface RollingOptions {
  /** Minimum valid observations for a result (default: window size; 1 for time windows). */
  minPeriods?: number;
  /** Label at the window centre instead of its right edge. */
  center?: boolean;
  /** Which window edges are included (default 'right'; 'both' for fixed windows when set). */
  closed?: 'right' | 'left' | 'both' | 'neither';
  /** Weighted window type (fixed-size windows only). */
  winType?: WinType;
  /** Parameters for gaussian (`std`) and exponential (`tau`) windows. */
  std?: number;
  tau?: number;
  /** DataFrame column holding the times of a time-based window (default: the index). */
  on?: string;
  /** Evaluate every `step` rows. */
  step?: number;
}

type Target = Series | DataFrame;
type Bounds = { start: Int32Array; end: Int32Array };

/** A kernel reduces values[start[i]..end[i]) for every row. */
type Kernel = (x: Float64Array, b: Bounds, minp: number) => Float64Array;

abstract class Window<T extends Target = Target> {
  protected readonly target: T;
  protected readonly on: string | undefined;

  constructor(target: T, on?: string) {
    this.target = target;
    this.on = on;
  }

  protected abstract bounds(n: number, times: Float64Array | null): Bounds;
  protected abstract minPeriods(): number;
  protected abstract needsTimes(): boolean;
  protected step(): number { return 1; }

  private times(): Float64Array | null {
    if (!this.needsTimes()) return null;
    let col: Column;
    if (this.on) col = (this.target as DataFrame)._column(this.on);
    else col = Column.from(this.target.index.labels);
    if (col.dtype !== 'datetime' && col.dtype !== 'timedelta' && !isNumericDType(col.dtype)) {
      throw new TypeError('A time-based window requires a datetime index (or `on` column)');
    }
    const t = Float64Array.from(numericView(col.dtype === 'datetime' || col.dtype === 'timedelta' ? new Column('float64', col.data) : col));
    for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) throw new Error('index must be monotonic for a time-based window');
    return t;
  }

  /** Runs `kernel` over every numeric column. */
  protected run(kernel: Kernel): T {
    const times = this.times();
    const step = this.step();
    const apply = (x: Float64Array) => {
      const b = this.bounds(x.length, times);
      const out = kernel(x, b, this.minPeriods());
      return step === 1 ? out : out.filter((_, i) => i % step === 0);
    };
    const index = step === 1 ? this.target.index : this.target.index.take(Array.from({ length: Math.ceil(this.target.length / step) }, (_, k) => k * step));
    if (this.target instanceof Series) {
      return Series._from(new Column('float64', apply(Float64Array.from(numericView(this.target._col, 'a window operation')))), index, this.target.name) as T;
    }
    const cols = new Map<string, Column>();
    for (const [name, col] of this.target._cols) {
      if (name === this.on) { cols.set(name, step === 1 ? col : col.take(index.labels.map((_, k) => k * step))); continue; }
      if (!isNumericDType(col.dtype)) continue;
      cols.set(name, new Column('float64', apply(Float64Array.from(numericView(col)))));
    }
    return DataFrame._fromColumns(cols, index) as T;
  }

  count(): T { return this.run((x, b) => slide(x, b, 0, (s) => s.nobs)); }
  sum(): T { return this.run((x, b, m) => slide(x, b, m, (s) => s.sum)); }
  mean(): T { return this.run((x, b, m) => slide(x, b, m, (s) => s.mean)); }
  var(ddof = 1): T { return this.run((x, b, m) => slide(x, b, m, (s) => (s.nobs > ddof ? Math.max(0, s.ssqdm) / (s.nobs - ddof) : NaN))); }
  std(ddof = 1): T { return this.run((x, b, m) => slide(x, b, m, (s) => (s.nobs > ddof ? Math.sqrt(Math.max(0, s.ssqdm) / (s.nobs - ddof)) : NaN))); }
  sem(ddof = 1): T { return this.run((x, b, m) => slide(x, b, m, (s) => (s.nobs > ddof ? Math.sqrt(Math.max(0, s.ssqdm) / (s.nobs - ddof)) / Math.sqrt(s.nobs) : NaN))); }
  skew(): T { return this.run((x, b, m) => slide(x, b, Math.max(m, 3), (s) => s.skew())); }
  kurt(): T { return this.run((x, b, m) => slide(x, b, Math.max(m, 4), (s) => s.kurt())); }
  min(): T { return this.run((x, b, m) => extremes(x, b, m, false)); }
  max(): T { return this.run((x, b, m) => extremes(x, b, m, true)); }
  median(): T { return this.run((x, b, m) => sortedWindow(x, b, m, (v) => quantileSorted(v, 0.5))); }
  quantile(q: number, interpolation: 'linear' | 'lower' | 'higher' | 'midpoint' | 'nearest' = 'linear'): T {
    return this.run((x, b, m) => sortedWindow(x, b, m, (v) => quantileSorted(v, q, interpolation)));
  }
  /** Rank of the last value within its window (average ties), optionally as a fraction. */
  rank(options: { ascending?: boolean; pct?: boolean } = {}): T {
    const asc = options.ascending ?? true;
    return this.run((x, b, m) => perWindow(x, b, m, (vals, last) => {
      if (last !== last) return NaN;
      let less = 0, equal = 0;
      for (const v of vals) { if (v !== v) continue; if (asc ? v < last : v > last) less++; else if (v === last) equal++; }
      const r = less + (equal + 1) / 2;
      return options.pct ? r / vals.filter((v) => v === v).length : r;
    }));
  }

  /**
   * Applies `fn` to each window: a Float64Array when `raw` (default), else a Series.
   */
  apply(fn: (values: any) => number, options: { raw?: boolean } = {}): T {
    const raw = options.raw ?? true;
    return this.run((x, b, m) => perWindow(x, b, m, (vals, _last, s, e) => (raw ? fn(vals) : fn(new Series(vals, { index: this.target.index.labels.slice(s, e) })))));
  }

  /** One aggregation name or a list (DataFrame of results for a Series). */
  agg(func: string | readonly string[]): Target {
    const one = (f: string): Target => {
      const m = (this as unknown as Record<string, () => Target>)[f];
      if (typeof m !== 'function') throw new Error(`Unknown window aggregation: ${f}`);
      return m.call(this);
    };
    if (typeof func === 'string') return one(func);
    const results = func.map(one);
    if (this.target instanceof Series) {
      return DataFrame._fromColumns(new Map(func.map((f, i) => [f, (results[i] as Series)._col])), this.target.index);
    }
    const cols = new Map<string, Column>();
    for (const name of (results[0] as DataFrame).columns) func.forEach((f, i) => cols.set(`${name}_${f}`, (results[i] as DataFrame)._column(name)));
    return DataFrame._fromColumns(cols, this.target.index);
  }

  /** Rolling Pearson correlation with `other` (Series: pairwise per column). */
  corr(other: Series, options: { ddof?: number } = {}): T {
    return this.pairwise(other, (x, y) => {
      const cxy = covOf(x, y, options.ddof ?? 1), cxx = covOf(x, x, options.ddof ?? 1), cyy = covOf(y, y, options.ddof ?? 1);
      return cxy / Math.sqrt(cxx * cyy);
    });
  }

  cov(other: Series, options: { ddof?: number } = {}): T {
    return this.pairwise(other, (x, y) => covOf(x, y, options.ddof ?? 1));
  }

  private pairwise(other: Series, fn: (x: number[], y: number[]) => number): T {
    const y = Float64Array.from(numericView(other.index.equals(this.target.index) ? other._col : other.reindex(this.target.index)._col));
    return this.run((x, b, m) => {
      const out = new Float64Array(x.length).fill(NaN);
      for (let i = 0; i < x.length; i++) {
        const xs: number[] = [], ys: number[] = [];
        for (let j = b.start[i]; j < b.end[i]; j++) if (x[j] === x[j] && y[j] === y[j]) { xs.push(x[j]); ys.push(y[j]); }
        if (xs.length >= Math.max(m, 2)) out[i] = fn(xs, ys);
      }
      return out;
    });
  }
}

function covOf(x: number[], y: number[], ddof: number): number {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return n - ddof > 0 ? s / (n - ddof) : NaN;
}

/** Fixed-size or time-based rolling window (`series.rolling(3)`, `df.rolling('2D')`). */
export class Rolling<T extends Target = Target> extends Window<T> {
  private readonly size: number;
  private readonly timeBased: boolean;
  private readonly options: RollingOptions;

  constructor(target: T, window: number | string | Timedelta, options: RollingOptions = {}) {
    super(target, options.on);
    this.options = options;
    if (typeof window === 'number') {
      if (!Number.isInteger(window) || window < 0) throw new RangeError('window must be a non-negative integer');
      this.size = window;
      this.timeBased = false;
    } else {
      this.timeBased = true;
      if (window instanceof Timedelta) this.size = window.ms;
      else {
        const off = (() => { try { return toOffset(window); } catch { return null; } })();
        this.size = off && off.kind === 'tick' ? off.tickMs * off.n : parseTimedelta(window);
      }
      if (options.center) throw new Error('center is not implemented for time-based windows');
      if (options.winType) throw new Error('winType requires a fixed-size window');
    }
  }

  protected override needsTimes(): boolean { return this.timeBased; }
  protected override minPeriods(): number { return this.options.minPeriods ?? (this.timeBased ? 1 : this.size); }
  protected override step(): number { return this.options.step ?? 1; }

  protected override bounds(n: number, times: Float64Array | null): Bounds {
    const start = new Int32Array(n), end = new Int32Array(n);
    const closed = this.options.closed ?? 'right';
    if (this.timeBased) {
      const t = times!;
      const w = this.size;
      const leftIncl = closed === 'left' || closed === 'both';
      const rightIncl = closed === 'right' || closed === 'both';
      let s = 0, e = 0;
      for (let i = 0; i < n; i++) {
        while (s < n && (leftIncl ? t[s] < t[i] - w : t[s] <= t[i] - w)) s++;
        if (rightIncl) { while (e < n && t[e] <= t[i]) e++; } else { while (e < n && t[e] < t[i]) e++; }
        start[i] = s;
        end[i] = Math.max(s, rightIncl ? Math.min(e, i + 1) : e);
      }
      return { start, end };
    }
    const w = this.size;
    const offset = this.options.center ? Math.floor((w - 1) / 2) : 0;
    for (let i = 0; i < n; i++) {
      let e = i + 1 + offset;
      let s = e - w;
      if (closed === 'left') { s--; e--; } else if (closed === 'both') s--; else if (closed === 'neither') e--;
      start[i] = Math.max(0, Math.min(s, n));
      end[i] = Math.max(0, Math.min(e, n));
    }
    return { start, end };
  }

  private weights(): Float64Array {
    return windowWeights(this.options.winType!, this.size, this.options);
  }

  private weighted(fn: (vals: number[], ws: number[]) => number): T {
    const w = this.weights();
    return this.run((x, b, m) => {
      const out = new Float64Array(x.length).fill(NaN);
      for (let i = 0; i < x.length; i++) {
        const vals: number[] = [], ws: number[] = [];
        // Align the weight vector with the window's right edge.
        const first = b.end[i] - this.size;
        for (let j = b.start[i]; j < b.end[i]; j++) if (x[j] === x[j]) { vals.push(x[j]); ws.push(w[j - first]); }
        if (vals.length >= m) out[i] = fn(vals, ws);
      }
      return out;
    });
  }

  override sum(): T {
    if (!this.options.winType) return super.sum();
    return this.weighted((v, w) => v.reduce((s, x, k) => s + x * w[k], 0));
  }

  override mean(): T {
    if (!this.options.winType) return super.mean();
    return this.weighted((v, w) => v.reduce((s, x, k) => s + x * w[k], 0) / w.reduce((a, b) => a + b, 0));
  }

  override var(ddof = 1): T {
    if (!this.options.winType) return super.var(ddof);
    return this.weighted((v, w) => weightedVar(v, w, ddof));
  }

  override std(ddof = 1): T {
    if (!this.options.winType) return super.std(ddof);
    return this.weighted((v, w) => Math.sqrt(weightedVar(v, w, ddof)));
  }
}

function weightedVar(v: number[], w: number[], ddof: number): number {
  const n = v.length;
  if (n <= ddof) return NaN;
  const sw = w.reduce((a, b) => a + b, 0);
  const mean = v.reduce((s, x, k) => s + x * w[k], 0) / sw;
  const t = v.reduce((s, x, k) => s + w[k] * (x - mean) ** 2, 0);
  return (t / sw) * (n / (n - ddof));
}

/** Expanding window: everything up to the current row (`series.expanding()`). */
export class Expanding<T extends Target = Target> extends Window<T> {
  private readonly minp: number;

  constructor(target: T, options: { minPeriods?: number } = {}) {
    super(target);
    this.minp = options.minPeriods ?? 1;
  }

  protected override needsTimes(): boolean { return false; }
  protected override minPeriods(): number { return this.minp; }
  protected override bounds(n: number): Bounds {
    return { start: new Int32Array(n), end: Int32Array.from({ length: n }, (_, i) => i + 1) };
  }
}

// ------------------------------------------------------------------ kernels

class Moments {
  nobs = 0;
  sum = 0;
  private comp = 0;
  mean = 0;
  ssqdm = 0;
  private s1 = 0; private s2 = 0; private s3 = 0; private s4 = 0;
  private readonly shift: number;
  private readonly higher: boolean;

  constructor(shift: number, higher: boolean) {
    this.shift = shift;
    this.higher = higher;
  }

  add(x: number): void {
    this.nobs++;
    // Kahan summation keeps long sliding sums accurate.
    const y = x - this.comp;
    const t = this.sum + y;
    this.comp = t - this.sum - y;
    this.sum = t;
    const d = x - this.mean;
    this.mean += d / this.nobs;
    this.ssqdm += d * (x - this.mean);
    if (this.higher) { const z = x - this.shift; this.s1 += z; this.s2 += z * z; this.s3 += z ** 3; this.s4 += z ** 4; }
  }

  remove(x: number): void {
    this.nobs--;
    const y = -x - this.comp;
    const t = this.sum + y;
    this.comp = t - this.sum - y;
    this.sum = t;
    if (this.nobs === 0) { this.mean = 0; this.ssqdm = 0; this.sum = 0; this.comp = 0; }
    else {
      const d = x - this.mean;
      this.mean -= d / this.nobs;
      this.ssqdm -= d * (x - this.mean);
    }
    if (this.higher) { const z = x - this.shift; this.s1 -= z; this.s2 -= z * z; this.s3 -= z ** 3; this.s4 -= z ** 4; }
  }

  private central(): [number, number, number] {
    const n = this.nobs;
    const mu = this.s1 / n;
    const m2 = this.s2 - n * mu * mu;
    const m3 = this.s3 - 3 * mu * this.s2 + 2 * n * mu ** 3;
    const m4 = this.s4 - 4 * mu * this.s3 + 6 * mu * mu * this.s2 - 3 * n * mu ** 4;
    return [m2, m3, m4];
  }

  skew(): number {
    const n = this.nobs;
    if (n < 3) return NaN;
    const [m2, m3] = this.central();
    if (m2 <= 1e-14 * Math.abs(this.s2)) return 0;
    return (Math.sqrt(n * (n - 1)) / (n - 2)) * ((m3 / n) / (m2 / n) ** 1.5);
  }

  kurt(): number {
    const n = this.nobs;
    if (n < 4) return NaN;
    const [m2, , m4] = this.central();
    if (m2 <= 1e-14 * Math.abs(this.s2)) return -3;
    return ((n + 1) * n * (n - 1)) / ((n - 2) * (n - 3)) * (m4 / (m2 * m2)) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  }
}

function firstValid(x: Float64Array): number {
  for (const v of x) if (v === v) return v;
  return 0;
}

/** Sliding add/remove over monotonic bounds. */
function slide(x: Float64Array, b: Bounds, minp: number, read: (s: Moments) => number, higher = true): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  let s = new Moments(firstValid(x), higher);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    const st = b.start[i], en = b.end[i];
    if (st >= hi || st < lo) {
      // Disjoint or moved backwards: restart.
      s = new Moments(firstValid(x), higher);
      lo = hi = st;
    }
    while (hi < en) { if (x[hi] === x[hi]) s.add(x[hi]); hi++; }
    while (lo < st) { if (x[lo] === x[lo]) s.remove(x[lo]); lo++; }
    out[i] = s.nobs >= minp && s.nobs > 0 ? read(s) : minp === 0 ? read(s) : NaN;
  }
  return out;
}

/** Sliding min/max with a monotonic deque. */
function extremes(x: Float64Array, b: Bounds, minp: number, max: boolean): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0, hi = 0, nobs = 0, lo = 0;
  const better = (a: number, c: number) => (max ? a >= c : a <= c);
  for (let i = 0; i < n; i++) {
    while (hi < b.end[i]) {
      const v = x[hi];
      if (v === v) {
        nobs++;
        while (tail > head && better(v, x[dq[tail - 1]])) tail--;
        dq[tail++] = hi;
      }
      hi++;
    }
    while (lo < b.start[i]) { if (x[lo] === x[lo]) nobs--; lo++; }
    while (tail > head && dq[head] < b.start[i]) head++;
    out[i] = nobs >= Math.max(minp, 1) && tail > head ? x[dq[head]] : NaN;
  }
  return out;
}

/** Keeps the window's valid values sorted for order statistics. */
function sortedWindow(x: Float64Array, b: Bounds, minp: number, read: (sorted: number[]) => number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const sorted: number[] = [];
  const pos = (v: number) => { let l = 0, h = sorted.length; while (l < h) { const m = (l + h) >> 1; if (sorted[m] < v) l = m + 1; else h = m; } return l; };
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    if (b.start[i] < lo) { sorted.length = 0; lo = hi = b.start[i]; }
    while (hi < b.end[i]) { const v = x[hi]; if (v === v) sorted.splice(pos(v), 0, v); hi++; }
    while (lo < b.start[i]) { const v = x[lo]; if (v === v) sorted.splice(pos(v), 1); lo++; }
    out[i] = sorted.length >= Math.max(minp, 1) ? read(sorted) : NaN;
  }
  return out;
}

function perWindow(x: Float64Array, b: Bounds, minp: number, fn: (vals: Float64Array, last: number, start: number, end: number) => number): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const vals = x.subarray(b.start[i], b.end[i]);
    let valid = 0;
    for (const v of vals) if (v === v) valid++;
    out[i] = valid >= Math.max(minp, 1) ? fn(vals, x[i], b.start[i], b.end[i]) : NaN;
  }
  return out;
}

function quantileSorted(v: number[], q: number, interpolation = 'linear'): number {
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  switch (interpolation) {
    case 'lower': return v[lo];
    case 'higher': return v[hi];
    case 'midpoint': return (v[lo] + v[hi]) / 2;
    case 'nearest': return v[Math.round(pos)];
    default: return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }
}

/** Symmetric window weights (scipy.signal.windows with sym=True). */
export function windowWeights(type: WinType, m: number, options: { std?: number; tau?: number } = {}): Float64Array {
  const w = new Float64Array(m);
  const N = m - 1;
  const cosine = (a: number[]) => {
    for (let n = 0; n < m; n++) w[n] = m === 1 ? 1 : a.reduce((s, ak, k) => s + (k % 2 ? -1 : 1) * ak * Math.cos((2 * Math.PI * k * n) / N), 0);
  };
  switch (type) {
    case 'boxcar': w.fill(1); break;
    case 'triang':
      for (let n = 0; n < m; n++) {
        const k = n < Math.ceil(m / 2) ? n + 1 : m - n;
        w[n] = m % 2 === 0 ? (2 * k - 1) / m : (2 * k) / (m + 1);
      }
      break;
    case 'bartlett': for (let n = 0; n < m; n++) w[n] = m === 1 ? 1 : n <= N / 2 ? (2 * n) / N : 2 - (2 * n) / N; break;
    case 'hamming': cosine([0.54, 0.46]); break;
    case 'hann': cosine([0.5, 0.5]); break;
    case 'blackman': cosine([0.42, 0.5, 0.08]); break;
    case 'blackmanharris': cosine([0.35875, 0.48829, 0.14128, 0.01168]); break;
    case 'nuttall': cosine([0.3635819, 0.4891775, 0.1365995, 0.0106411]); break;
    case 'flattop': cosine([0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]); break;
    case 'cosine': for (let n = 0; n < m; n++) w[n] = Math.sin((Math.PI * (n + 0.5)) / m); break;
    case 'bohman':
      for (let n = 0; n < m; n++) {
        const x = Math.abs((2 * n) / N - 1);
        w[n] = m === 1 ? 1 : (1 - x) * Math.cos(Math.PI * x) + Math.sin(Math.PI * x) / Math.PI;
      }
      break;
    case 'parzen':
      for (let n = 0; n < m; n++) {
        const x = Math.abs(n - N / 2) / (m / 2);
        w[n] = x <= 0.5 ? 1 - 6 * x * x * (1 - x) : 2 * (1 - x) ** 3;
      }
      break;
    case 'gaussian': {
      if (options.std === undefined) throw new Error("winType 'gaussian' needs `std`");
      for (let n = 0; n < m; n++) w[n] = Math.exp(-0.5 * ((n - N / 2) / options.std) ** 2);
      break;
    }
    case 'exponential': {
      const tau = options.tau ?? 1;
      for (let n = 0; n < m; n++) w[n] = Math.exp(-Math.abs(n - N / 2) / tau);
      break;
    }
    default: throw new Error(`Unsupported window type: ${type as string}`);
  }
  return w;
}

// ---------------------------------------------------------------------- ewm

export interface EwmOptions {
  com?: number;
  span?: number;
  halflife?: number;
  alpha?: number;
  /** Divide by decaying weights (default true) instead of the recursive form. */
  adjust?: boolean;
  /** Skip missing values when computing weights (default false). */
  ignoreNa?: boolean;
  minPeriods?: number;
}

/** Exponentially weighted window (`series.ewm({ span: 10 }).mean()`). */
export class EWM<T extends Target = Target> {
  private readonly target: T;
  private readonly alpha: number;
  private readonly adjust: boolean;
  private readonly ignoreNa: boolean;
  private readonly minp: number;

  constructor(target: T, options: EwmOptions) {
    this.target = target;
    const given = ['com', 'span', 'halflife', 'alpha'].filter((k) => (options as Record<string, unknown>)[k] !== undefined);
    if (given.length !== 1) throw new Error('Pass exactly one of com, span, halflife or alpha');
    if (options.com !== undefined) { if (options.com < 0) throw new RangeError('com must be >= 0'); this.alpha = 1 / (1 + options.com); }
    else if (options.span !== undefined) { if (options.span < 1) throw new RangeError('span must be >= 1'); this.alpha = 2 / (options.span + 1); }
    else if (options.halflife !== undefined) { if (options.halflife <= 0) throw new RangeError('halflife must be > 0'); this.alpha = 1 - Math.exp(Math.log(0.5) / options.halflife); }
    else { if (options.alpha! <= 0 || options.alpha! > 1) throw new RangeError('alpha must be in (0, 1]'); this.alpha = options.alpha!; }
    this.adjust = options.adjust ?? true;
    this.ignoreNa = options.ignoreNa ?? false;
    this.minp = Math.max(options.minPeriods ?? 0, 1);
  }

  private run(fn: (x: Float64Array) => Float64Array): T {
    if (this.target instanceof Series) {
      return Series._from(new Column('float64', fn(Float64Array.from(numericView(this.target._col, 'ewm')))), this.target.index, this.target.name) as T;
    }
    const cols = new Map<string, Column>();
    for (const [name, col] of (this.target as DataFrame)._cols) if (isNumericDType(col.dtype)) cols.set(name, new Column('float64', fn(Float64Array.from(numericView(col)))));
    return DataFrame._fromColumns(cols, this.target.index) as T;
  }

  mean(): T {
    const f = 1 - this.alpha;
    return this.run((x) => {
      const out = new Float64Array(x.length);
      let num = 0, den = 0, nobs = 0, started = false;
      let y = NaN, oldW = 1;
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        const obs = v === v;
        if (this.adjust) {
          if (started && (obs || !this.ignoreNa)) { num *= f; den *= f; }
          if (obs) { num += v; den += 1; nobs++; started = true; }
          out[i] = nobs >= this.minp ? num / den : NaN;
          continue;
        }
        // Recursive form: y = f^k * y + (1 - f^k) * x, k = steps since the last observation.
        if (started && (obs || !this.ignoreNa)) oldW *= f;
        if (obs) {
          y = started ? oldW * y + (1 - oldW) * v : v;
          oldW = 1; nobs++; started = true;
        }
        out[i] = nobs >= this.minp ? y : NaN;
      }
      return out;
    });
  }

  sum(): T {
    const f = 1 - this.alpha;
    return this.run((x) => {
      const out = new Float64Array(x.length);
      let num = 0, nobs = 0, started = false;
      for (let i = 0; i < x.length; i++) {
        const v = x[i], obs = v === v;
        if (started && (obs || !this.ignoreNa)) num *= f;
        if (obs) { num += v; nobs++; started = true; }
        out[i] = nobs >= this.minp ? num : NaN;
      }
      return out;
    });
  }

  var(options: { bias?: boolean } = {}): T { return this.run((x) => this.covKernel(x, x, options.bias ?? false)); }

  std(options: { bias?: boolean } = {}): T {
    return this.run((x) => this.covKernel(x, x, options.bias ?? false).map(Math.sqrt));
  }

  cov(other: Series, options: { bias?: boolean } = {}): T {
    const y = this.aligned(other);
    return this.run((x) => this.covKernel(x, y, options.bias ?? false));
  }

  corr(other: Series): T {
    const y = this.aligned(other);
    return this.run((x) => {
      const cxy = this.covKernel(x, y, true), cxx = this.covKernel(x, x, true), cyy = this.covKernel(y, y, true);
      return cxy.map((c, i) => c / Math.sqrt(cxx[i] * cyy[i]));
    });
  }

  private aligned(other: Series): Float64Array {
    return Float64Array.from(numericView(other.index.equals(this.target.index) ? other._col : other.reindex(this.target.index)._col));
  }

  /** pandas' ewmcov recursion (weighted covariance with bias correction). */
  private covKernel(x: Float64Array, y: Float64Array, bias: boolean): Float64Array {
    const a = this.alpha, f = 1 - a;
    const out = new Float64Array(x.length);
    let meanX = NaN, meanY = NaN, cov = 0, sumW = 0, sumW2 = 0, oldW = 0, nobs = 0;
    for (let i = 0; i < x.length; i++) {
      const vx = x[i], vy = y[i];
      const obs = vx === vx && vy === vy;
      if (meanX === meanX) {
        if (obs || !this.ignoreNa) { sumW *= f; sumW2 *= f * f; oldW *= f; }
        if (obs) {
          const newW = this.adjust ? 1 : a;
          const oldMx = meanX, oldMy = meanY;
          meanX = (oldW * oldMx + newW * vx) / (oldW + newW);
          meanY = (oldW * oldMy + newW * vy) / (oldW + newW);
          cov = (oldW * (cov + (oldMx - meanX) * (oldMy - meanY)) + newW * (vx - meanX) * (vy - meanY)) / (oldW + newW);
          sumW += newW; sumW2 += newW * newW; oldW += newW;
          if (!this.adjust) { sumW /= oldW; sumW2 /= oldW * oldW; oldW = 1; }
          nobs++;
        }
      } else if (obs) {
        meanX = vx; meanY = vy; cov = 0; sumW = 1; sumW2 = 1; oldW = 1; nobs = 1;
      }
      if (nobs >= this.minp && nobs > 0) {
        if (bias) out[i] = cov;
        else {
          const num = sumW * sumW, den = num - sumW2;
          out[i] = den > 0 ? (num / den) * cov : NaN;
        }
      } else out[i] = NaN;
    }
    return out;
  }
}
