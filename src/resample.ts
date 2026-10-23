/** Time-based resampling (`series.resample('ME').sum()`), like pandas' Resampler. */
import { aggregate, NUMERIC_AGGS, quantile } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { toOffset, type DateOffset } from './core/offsets.ts';
import { interpolate, type InterpolateMethod } from './core/stats.ts';
import { MS, parseDate, parseTimedelta } from './core/time.ts';
import { isNumericDType, type AggName } from './core/types.ts';
import { fromWall, toWall } from './core/tz.ts';
import { colKey, DataFrame } from './frame.ts';
import { numericView, Series } from './series.ts';

export interface ResampleOptions {
  /** Which bin edge is closed. Default 'left', except 'right' for ME/QE/YE/W/BME. */
  closed?: 'left' | 'right';
  /** Which bin edge labels the bin (same defaults as `closed`). */
  label?: 'left' | 'right';
  /** DataFrame column to use instead of the index. */
  on?: string;
  /** Alignment of fixed-frequency bins: 'start_day' (default), 'start', 'epoch', 'end', 'end_day' or a timestamp. */
  origin?: 'start_day' | 'start' | 'epoch' | 'end' | 'end_day' | Date | string;
  /** Shift of the bin edges, e.g. '2h'. */
  offset?: string;
}

type Target = Series | DataFrame;
type AggFn = AggName | ((s: Series) => unknown);

interface Bins {
  /** Bin labels (wall-clock ms). */
  labels: number[];
  /** Row positions per bin. */
  rows: number[][];
}

export class Resampler<T extends Target = Target> {
  private readonly target: T;
  private readonly offset: DateOffset;
  private readonly options: ResampleOptions;
  private readonly tz: string | null;
  private readonly times: Float64Array;
  private binsCache: Bins | null = null;

  constructor(target: T, rule: string | DateOffset, options: ResampleOptions = {}) {
    this.target = target;
    this.offset = toOffset(rule);
    this.options = options;
    let col: Column;
    if (options.on) {
      col = (target as DataFrame)._column(options.on);
      this.tz = col.meta.tz ?? null;
    } else {
      col = Column.from(target.index.labels);
      this.tz = target.index.tz;
    }
    if (col.dtype !== 'datetime') throw new TypeError('resample requires a datetime index (or `on` column)');
    const raw = col.data as Float64Array;
    this.times = raw.map((t) => toWall(t, this.tz));
  }

  private get endAnchored(): boolean {
    return this.offset.kind === 'anchored' && !this.offset.startAnchored;
  }

  private bins(): Bins {
    if (this.binsCache) return this.binsCache;
    const t = this.times;
    const valid = Array.from(t).filter((v) => v === v);
    if (valid.length === 0) return (this.binsCache = { labels: [], rows: [] });
    const first = Math.min(...valid), last = Math.max(...valid);
    const closedRight = (this.options.closed ?? (this.endAnchored ? 'right' : 'left')) === 'right';
    const labelRight = (this.options.label ?? (this.endAnchored ? 'right' : 'left')) === 'right';
    const off = this.offset;
    let binOf: (v: number) => number;
    let labels: number[];

    if (off.kind === 'tick') {
      const step = off.tickMs * off.n;
      const shift = this.options.offset ? parseTimedelta(this.options.offset) : 0;
      const o = this.options.origin ?? 'start_day';
      let origin: number;
      if (o === 'epoch') origin = 0;
      else if (o === 'start') origin = first;
      else if (o === 'end') origin = last;
      else if (o === 'end_day') origin = Math.ceil(last / MS.D) * MS.D;
      else if (o === 'start_day') origin = Math.floor(first / MS.D) * MS.D;
      else origin = toWall(o instanceof Date ? o.getTime() : parseDate(o), this.tz);
      origin += shift;
      const k = (v: number) => (closedRight ? Math.ceil((v - origin) / step) - 1 : Math.floor((v - origin) / step));
      const k0 = k(first), k1 = k(last);
      labels = Array.from({ length: k1 - k0 + 1 }, (_, j) => origin + (k0 + j + (labelRight ? 1 : 0)) * step);
      binOf = (v) => k(v) - k0;
    } else {
      // Calendar offsets: map each time to its base period edge, then chunk by n.
      const base = off.times(1);
      const day = (v: number) => Math.floor(v / MS.D) * MS.D;
      const edge = (v: number) => {
        const d = day(v);
        if (this.endAnchored) return closedRight ? base.rollforward(d) : base.isOnOffset(d) && v >= d ? base.apply(d, 1) : base.rollforward(d);
        return closedRight && base.isOnOffset(d) && v === d ? base.apply(d, -1) : base.rollback(d);
      };
      const e0 = edge(first), e1 = edge(last);
      const seq: number[] = [e0];
      while (seq[seq.length - 1] < e1) seq.push(base.apply(seq[seq.length - 1], 1));
      const pos = new Map(seq.map((e, i) => [e, i]));
      const n = off.n;
      const nChunks = Math.ceil(seq.length / n);
      if (this.endAnchored) {
        // Bins end at e0, e0 + n, e0 + 2n, ... (the first bin ends at the first edge).
        const count = Math.ceil((seq.length - 1) / n) + 1;
        labels = Array.from({ length: count }, (_, c) => {
          const end = base.apply(e0, c * n);
          return labelRight ? end : base.apply(end, -n);
        });
        binOf = (v) => Math.ceil(pos.get(edge(v))! / n);
      } else {
        labels = Array.from({ length: nChunks }, (_, c) => (labelRight ? base.apply(seq[c * n], n) : seq[c * n]));
        binOf = (v) => Math.floor(pos.get(edge(v))! / n);
      }
    }
    const rows: number[][] = labels.map(() => []);
    for (let i = 0; i < t.length; i++) if (t[i] === t[i]) rows[binOf(t[i])].push(i);
    return (this.binsCache = { labels, rows });
  }

  private index(labels: readonly number[] = this.bins().labels): Index {
    const name = this.options.on ?? this.target.index.name;
    return new Index(labels.map((w) => new Date(this.tz ? fromWall(w, this.tz, 'earliest', 'shift_forward') : w)), { name, tz: this.tz });
  }

  private valueColumns(): [string | null, Column][] {
    if (this.target instanceof Series) return [[this.target.name, this.target._col]];
    return [...this.target._cols].filter(([k]) => k !== this.options.on);
  }

  private wrap(cols: [string | null, Column][]): T {
    const index = this.index();
    if (this.target instanceof Series) return Series._from(cols[0][1], index, this.target.name) as T;
    return DataFrame._fromColumns(new Map(cols.map(([k, c]) => [k!, c])), index) as T;
  }

  private reduce(agg: AggFn, numericOnly = typeof agg === 'string' && NUMERIC_AGGS.has(agg)): T {
    const { rows } = this.bins();
    const out: [string | null, Column][] = [];
    for (const [name, col] of this.valueColumns()) {
      if (numericOnly && !isNumericDType(col.dtype) && this.target instanceof DataFrame) continue;
      const vals = rows.map((r) => (typeof agg === 'function' ? agg(Series._from(col.take(r), this.target.index.take(r), name)) : aggregate(col, agg, r)));
      const dtype = agg === 'count' || agg === 'size' || agg === 'nunique' ? 'int64' : agg === 'mean' || agg === 'std' || agg === 'var' || agg === 'median' ? 'float64' : undefined;
      out.push([name, Column.from(vals, dtype, dtype === undefined && (agg === 'first' || agg === 'last' || agg === 'min' || agg === 'max') && col.dtype === 'category' ? col.meta : {})]);
    }
    return this.wrap(out);
  }

  sum(): T { return this.reduce('sum'); }
  prod(): T { return this.reduce('prod'); }
  mean(): T { return this.reduce('mean'); }
  median(): T { return this.reduce('median'); }
  std(): T { return this.reduce('std'); }
  var(): T { return this.reduce('var'); }
  sem(): T { return this.reduce('sem'); }
  min(): T { return this.reduce('min'); }
  max(): T { return this.reduce('max'); }
  first(): T { return this.reduce('first'); }
  last(): T { return this.reduce('last'); }
  count(): T { return this.reduce('count'); }
  nunique(): T { return this.reduce('nunique'); }
  quantile(q = 0.5): T {
    const { rows } = this.bins();
    return this.wrap(this.valueColumns().filter(([, c]) => isNumericDType(c.dtype)).map(([n, c]) => [n, Column.from(rows.map((r) => quantile(c, q, r)), 'float64')]));
  }

  /** Rows per bin. */
  size(): Series {
    return Series._from(Column.from(this.bins().rows.map((r) => r.length), 'int64'), this.index(), null);
  }

  /** open / high / low / close per bin (columns prefixed per input column for frames). */
  ohlc(): DataFrame {
    const { rows } = this.bins();
    const cols = new Map<string, Column>();
    for (const [name, col] of this.valueColumns()) {
      if (!isNumericDType(col.dtype)) continue;
      for (const [k, agg] of [['open', 'first'], ['high', 'max'], ['low', 'min'], ['close', 'last']] as const) {
        cols.set(this.target instanceof Series ? k : colKey([name!, k]), Column.from(rows.map((r) => aggregate(col, agg, r)), 'float64'));
      }
    }
    return DataFrame._fromColumns(cols, this.index(), this.target instanceof Series ? null : [null, null]);
  }

  /** One func for every column, a list, or `{column: func | func[]}`. */
  agg(spec: AggFn | readonly AggFn[] | Record<string, AggFn | readonly AggFn[]>): Target {
    if (typeof spec === 'string' || typeof spec === 'function') return this.reduce(spec);
    const label = (f: AggFn, i: number) => (typeof f === 'function' ? f.name || `func${i}` : f);
    const { rows } = this.bins();
    const cols = new Map<string, Column>();
    const one = (col: Column, name: string | null, f: AggFn) =>
      Column.from(rows.map((r) => (typeof f === 'function' ? f(Series._from(col.take(r), this.target.index.take(r), name)) : aggregate(col, f, r))));
    if (Array.isArray(spec)) {
      for (const [name, col] of this.valueColumns()) {
        (spec as readonly AggFn[]).forEach((f, i) => {
          if (typeof f === 'string' && NUMERIC_AGGS.has(f) && !isNumericDType(col.dtype)) return;
          cols.set(this.target instanceof Series ? label(f, i) : colKey([name!, label(f, i)]), one(col, name, f));
        });
      }
      return DataFrame._fromColumns(cols, this.index(), this.target instanceof Series ? null : [null, null]);
    }
    const entries = Object.entries(spec as Record<string, AggFn | readonly AggFn[]>);
    const multi = entries.some(([, f]) => Array.isArray(f));
    for (const [name, f] of entries) {
      const col = (this.target as DataFrame)._column(name);
      if (Array.isArray(f)) (f as readonly AggFn[]).forEach((g, i) => cols.set(colKey([name, label(g, i)]), one(col, name, g)));
      else cols.set(multi ? colKey([name, label(f as AggFn, 0)]) : name, one(col, name, f as AggFn));
    }
    return DataFrame._fromColumns(cols, this.index(), multi ? [null, null] : null);
  }

  aggregate(spec: AggFn | readonly AggFn[] | Record<string, AggFn | readonly AggFn[]>): Target {
    return this.agg(spec);
  }

  /** Calls `fn(binSeriesOrFrame)` per bin. */
  apply(fn: (group: any) => unknown): Series {
    const { rows } = this.bins();
    const vals = rows.map((r) => fn(this.target instanceof Series ? this.target.take(r) : this.target.take(r)));
    return new Series(vals, { index: this.index() });
  }

  pipe<T>(fn: (r: this) => T): T {
    return fn(this);
  }

  /** Iterates `[binLabel, rows]`. */
  *[Symbol.iterator](): IterableIterator<[Date, Target]> {
    const { labels, rows } = this.bins();
    const idx = this.index(labels);
    for (let i = 0; i < labels.length; i++) yield [idx.labels[i] as Date, this.target.take(rows[i])];
  }

  // ------------------------------------------------------------- upsampling

  /** Value at each bin label exactly (NA when absent). */
  asfreq(fillValue: unknown = null): T {
    return this.upsample((pos) => pos.exact, fillValue);
  }

  /** Last observation at or before each label. */
  ffill(limit = Infinity): T {
    return this.upsample((pos) => (pos.prevDist <= limit ? pos.prev : -1));
  }

  /** Next observation at or after each label. */
  bfill(limit = Infinity): T {
    return this.upsample((pos) => (pos.nextDist <= limit ? pos.next : -1));
  }

  /** Nearest observation. */
  nearest(): T {
    return this.upsample((pos, label) => {
      if (pos.prev < 0) return pos.next;
      if (pos.next < 0) return pos.prev;
      return label - this.times[pos.prev] < this.times[pos.next] - label ? pos.prev : pos.next;
    });
  }

  /** Upsamples and interpolates numeric columns ('linear' uses time spacing). */
  interpolate(method: InterpolateMethod = 'linear'): T {
    const labels = this.fullLabels();
    const merged = [...new Set([...Array.from(this.times).filter((v) => v === v), ...labels])].sort((a, b) => a - b);
    const out: [string | null, Column][] = [];
    for (const [name, col] of this.valueColumns()) {
      if (!isNumericDType(col.dtype)) continue;
      const y = numericView(col);
      const byTime = new Map<number, number>();
      this.times.forEach((t, i) => byTime.set(t, y[i]));
      const ys = Float64Array.from(merged, (t) => byTime.get(t) ?? NaN);
      const filled = interpolate(ys, Float64Array.from(merged), { method: method === 'linear' ? 'linear' : method, limitArea: 'inside' });
      const at = new Map(merged.map((t, i) => [t, filled[i]]));
      out.push([name, new Column('float64', Float64Array.from(labels, (t) => at.get(t)!))]);
    }
    const index = this.index(labels);
    if (this.target instanceof Series) return Series._from(out[0][1], index, this.target.name) as T;
    return DataFrame._fromColumns(new Map(out.map(([k, c]) => [k!, c])), index) as T;
  }

  /** Every label from the first to the last observation at the rule's frequency. */
  private fullLabels(): number[] {
    const valid = Array.from(this.times).filter((v) => v === v);
    if (!valid.length) return [];
    const first = Math.min(...valid), last = Math.max(...valid);
    const off = this.offset;
    let t = off.kind === 'tick' ? first : off.rollforward(Math.floor(first / MS.D) * MS.D);
    const out: number[] = [];
    while (t <= last) { out.push(t); t = off.apply(t, off.n); }
    return out;
  }

  private upsample(pick: (pos: { exact: number; prev: number; next: number; prevDist: number; nextDist: number }, label: number) => number, fillValue: unknown = null): T {
    const labels = this.fullLabels();
    const order = Array.from({ length: this.times.length }, (_, i) => i).filter((i) => this.times[i] === this.times[i]).sort((a, b) => this.times[a] - this.times[b]);
    const ts = order.map((i) => this.times[i]);
    const positions = labels.map((label, k) => {
      let lo = 0, hi = ts.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= label) lo = m + 1; else hi = m; }
      const prevK = lo - 1;
      let nextK = prevK >= 0 && ts[prevK] === label ? prevK : lo;
      if (nextK >= ts.length) nextK = -1;
      const prevLabelK = prevK >= 0 ? labels.findIndex((l) => l >= ts[prevK]) : -1;
      const nextLabelK = nextK >= 0 ? labels.findIndex((l) => l >= ts[nextK]) : -1;
      return pick({
        exact: prevK >= 0 && ts[prevK] === label ? order[prevK] : -1,
        prev: prevK >= 0 ? order[prevK] : -1,
        next: nextK >= 0 ? order[nextK] : -1,
        prevDist: prevK >= 0 ? k - prevLabelK : Infinity,
        nextDist: nextK >= 0 ? nextLabelK - k : Infinity,
      }, label);
    });
    const index = this.index(labels);
    const take = (col: Column) => {
      const c = col.take(positions);
      return fillValue === null ? c : c.mapLike((v, i) => (positions[i] < 0 ? fillValue : v));
    };
    if (this.target instanceof Series) return Series._from(take(this.target._col), index, this.target.name) as T;
    return DataFrame._fromColumns(new Map(this.valueColumns().map(([k, c]) => [k!, take(c)])), index) as T;
  }
}

/** Conforms a datetime-indexed object to a fixed frequency (pandas `asfreq`). */
export function asfreq(target: Target, freq: string | DateOffset, options: { method?: 'pad' | 'ffill' | 'bfill' | 'backfill'; fillValue?: unknown } = {}): Target {
  const r = new Resampler(target, freq, { origin: 'start' });
  if (options.method === 'pad' || options.method === 'ffill') return r.ffill();
  if (options.method === 'bfill' || options.method === 'backfill') return r.bfill();
  return r.asfreq(options.fillValue ?? null);
}

