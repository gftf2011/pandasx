/** Constructors for datetime-like data: toDatetime, toTimedelta and the *Range helpers. */
import { Column } from './core/column.ts';
import { Index } from './core/indexes.ts';
import { rangeTimes, toOffset, type DateOffset } from './core/offsets.ts';
import { strptime } from './core/strftime.ts';
import { MS, normalizeFreq, parseDate, parseTimedelta, Period, Timedelta } from './core/time.ts';
import { checkTimeZone, fromWall, toWall } from './core/tz.ts';
import { isNA } from './core/values.ts';
import { Series } from './series.ts';

export type DateUnit = 'D' | 'h' | 'm' | 's' | 'ms' | 'us' | 'ns';
const UNIT_MS: Record<DateUnit, number> = { D: MS.D, h: MS.h, m: MS.min, s: 1000, ms: 1, us: 1e-3, ns: 1e-6 };

export interface ToDatetimeOptions {
  /** strptime format, e.g. '%d/%m/%Y %H:%M'. */
  format?: string;
  /** 'raise' (default) throws on bad input, 'coerce' turns it into NaT. */
  errors?: 'raise' | 'coerce';
  /** Return tz-aware UTC datetimes (strings with offsets are converted). */
  utc?: boolean;
  /** Parse ambiguous 01/02/2024 as 1 February. */
  dayfirst?: boolean;
  /** Unit of numeric input (default 'ms'). */
  unit?: DateUnit;
}

/** Parses one value to a UTC instant; returns [ms, hadOffset]. */
function parseOne(v: unknown, o: ToDatetimeOptions): [number, boolean] {
  if (isNA(v)) return [NaN, false];
  if (v instanceof Date) return [v.getTime(), false];
  if (typeof v === 'number' || typeof v === 'bigint') return [Number(v) * UNIT_MS[o.unit ?? 'ms'], false];
  if (v instanceof Period) return [v.startTime.getTime(), false];
  const s = String(v).trim();
  if (o.format) {
    const r = strptime(s, o.format);
    if (!r) return [NaN, false];
    return [r.offset === null ? r.wall : r.wall - r.offset, r.offset !== null];
  }
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (slash) {
    const [a, b] = [Number(slash[1]), Number(slash[2])];
    const [day, month] = o.dayfirst ? [a, b] : [b, a];
    return [Date.UTC(Number(slash[3]), month - 1, day, Number(slash[4] ?? 0), Number(slash[5] ?? 0), Number(slash[6] ?? 0)), false];
  }
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(s) && /\d[T ]\d/.test(s);
  return [parseDate(s), hasOffset];
}

/**
 * Converts values (strings, Dates, epoch numbers) to datetimes, like `pd.to_datetime`.
 * Scalars return a Date (or null), arrays/Series return a Series.
 */
export function toDatetime(values: Series | readonly unknown[], options?: ToDatetimeOptions): Series;
export function toDatetime(value: string | number | Date, options?: ToDatetimeOptions): Date | null;
export function toDatetime(values: unknown, options: ToDatetimeOptions = {}): Series | Date | null {
  const scalar = !(values instanceof Series) && !Array.isArray(values);
  const arr = values instanceof Series ? values.toArray() : scalar ? [values] : (values as unknown[]);
  const out = new Float64Array(arr.length);
  let anyOffset = false;
  arr.forEach((v, i) => {
    const [t, off] = parseOne(v, options);
    if (t !== t && !isNA(v) && options.errors !== 'coerce') throw new Error(`Could not parse datetime: ${String(v)}`);
    out[i] = t;
    anyOffset ||= off;
  });
  if (scalar) return out[0] !== out[0] ? null : new Date(out[0]);
  const tz = options.utc || anyOffset ? 'UTC' : null;
  const col = new Column('datetime', out, { tz });
  return values instanceof Series ? Series._from(col, values.index, values.name) : Series._from(col, Index.range(out.length), null);
}

/** Converts values to timedeltas ('1 days 02:00:00', '90min', numbers in `unit`). */
export function toTimedelta(values: Series | readonly unknown[], options?: { unit?: DateUnit; errors?: 'raise' | 'coerce' }): Series;
export function toTimedelta(value: string | number, options?: { unit?: DateUnit; errors?: 'raise' | 'coerce' }): Timedelta | null;
export function toTimedelta(values: unknown, options: { unit?: DateUnit; errors?: 'raise' | 'coerce' } = {}): Series | Timedelta | null {
  const scalar = !(values instanceof Series) && !Array.isArray(values);
  const arr = values instanceof Series ? values.toArray() : scalar ? [values] : (values as unknown[]);
  const out = Float64Array.from(arr, (v) => {
    if (isNA(v)) return NaN;
    if (v instanceof Timedelta) return v.ms;
    if (typeof v === 'number') return v * UNIT_MS[options.unit ?? 'ns'];
    try { return parseTimedelta(String(v)); } catch (e) { if (options.errors === 'coerce') return NaN; throw e; }
  });
  if (scalar) return out[0] !== out[0] ? null : new Timedelta(out[0]);
  const col = new Column('timedelta', out);
  return values instanceof Series ? Series._from(col, values.index, values.name) : Series._from(col, Index.range(out.length), null);
}

export interface DateRangeOptions {
  end?: Date | string;
  periods?: number;
  /** Frequency string ('D', 'h', '15min', 'B', 'W-MON', 'ME', 'MS', 'QE', 'YS', ...) or offset. */
  freq?: string | DateOffset;
  /** Zone for the generated wall times. */
  tz?: string;
  /** Snap start/end to midnight. */
  normalize?: boolean;
  /** Which endpoints to keep (default 'both'). */
  inclusive?: 'both' | 'neither' | 'left' | 'right';
  name?: string;
}

function wallOf(v: Date | string | undefined, tz: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : parseDate(v);
  return tz && v instanceof Date ? toWall(t, tz) : t;
}

/** Fixed-frequency datetimes, like `pd.date_range`. Pass `start` = null to count back from `end`. */
export function dateRange(start: Date | string | null, options: DateRangeOptions = {}): Series {
  const offset = toOffset(options.freq ?? 'D');
  const tz = options.tz;
  let s = start === null ? null : wallOf(start, tz);
  let e = wallOf(options.end, tz);
  if (options.normalize) {
    if (s !== null) s = Math.floor(s / MS.D) * MS.D;
    if (e !== null) e = Math.floor(e / MS.D) * MS.D;
  }
  if (s === null && e === null) throw new Error('dateRange needs `start` or `end`');
  if (s !== null && e === null && options.periods === undefined) throw new Error('dateRange needs `end` or `periods`');
  let walls = rangeTimes(s, e, options.periods ?? null, offset);
  const inc = options.inclusive ?? 'both';
  if ((inc === 'neither' || inc === 'right') && s !== null) walls = walls.filter((t) => t !== s);
  if ((inc === 'neither' || inc === 'left') && e !== null) walls = walls.filter((t) => t !== e);
  if (tz) checkTimeZone(tz);
  const out = Float64Array.from(walls, (w) => (tz ? fromWall(w, tz, 'earliest', 'shift_forward') : w));
  return Series._from(new Column('datetime', out, { tz: tz ?? null }), Index.range(out.length), options.name ?? null);
}

/** Business-day range, like `pd.bdate_range`. */
export function bdateRange(start: Date | string | null, options: DateRangeOptions = {}): Series {
  return dateRange(start, { ...options, freq: options.freq ?? 'B' });
}

/** Periods of `freq`, like `pd.period_range`. */
export function periodRange(start: Date | string | Period | null, options: { end?: Date | string | Period; periods?: number; freq?: string; name?: string } = {}): Series {
  const freq = normalizeFreq(options.freq ?? (start instanceof Period ? start.freq : 'D'));
  const ord = (v: Date | string | Period) => (v instanceof Period ? v.ordinal : new Period(v, freq).ordinal);
  let first: number, count: number;
  if (start !== null) {
    first = ord(start);
    count = options.periods ?? ord(options.end!) - first + 1;
  } else {
    if (options.end === undefined || options.periods === undefined) throw new Error('periodRange needs `end` and `periods` without `start`');
    count = options.periods;
    first = ord(options.end) - count + 1;
  }
  const out = Float64Array.from({ length: Math.max(0, count) }, (_, k) => first + k);
  return Series._from(new Column('period', out, { freq }), Index.range(out.length), options.name ?? null);
}

/** Evenly spaced timedeltas, like `pd.timedelta_range`. */
export function timedeltaRange(start: string | Timedelta | number | null, options: { end?: string | Timedelta | number; periods?: number; freq?: string; name?: string } = {}): Series {
  const ms = (v: string | Timedelta | number) => (v instanceof Timedelta ? v.ms : typeof v === 'number' ? v : parseTimedelta(v));
  const step = (() => { const o = toOffset(options.freq ?? 'D'); if (o.kind !== 'tick') throw new Error('timedeltaRange needs a fixed frequency'); return o.tickMs * o.n; })();
  const s = start === null ? null : ms(start);
  const e = options.end === undefined ? null : ms(options.end);
  const out: number[] = [];
  if (s !== null) for (let t = s; out.length < (options.periods ?? Infinity) && (e === null || t <= e); t += step) out.push(t);
  else if (e !== null && options.periods) for (let k = options.periods - 1; k >= 0; k--) out.push(e - k * step);
  return Series._from(new Column('timedelta', Float64Array.from(out)), Index.range(out.length), options.name ?? null);
}

