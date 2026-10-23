/**
 * Date offsets and frequency strings ('3D', 'h', '15min', 'B', 'W-MON', 'ME',
 * 'MS', 'QE', 'QS-JAN', 'YE', 'BME', ...), like `pandas.tseries.offsets`.
 * Offsets operate on wall-clock milliseconds (UTC-based arithmetic).
 */
import { MS } from './time.ts';

const DAY = MS.D;
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Day number since epoch → [year, month0, day]. */
function ymd(day: number): [number, number, number] {
  const d = new Date(day * DAY);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

const dayOf = (t: number) => Math.floor(t / DAY);
/** Monday = 0 … Sunday = 6. */
const weekday = (day: number) => (((day + 3) % 7) + 7) % 7;
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export interface BusinessOptions {
  /** Holidays (dates or ISO strings) skipped by business-day offsets. */
  holidays?: readonly (Date | string)[];
  /** Working days, e.g. 'Mon Tue Wed Thu Fri' (default) or a 7-char mask '1111100'. */
  weekmask?: string;
}

/** Fixed-length ('tick'), calendar-anchored, or relative (DateOffset) offset. */
export type OffsetKind = 'tick' | 'anchored' | 'relative';
type Kind = OffsetKind;

/** A calendar offset. `n` repeats it (negative goes backwards). */
export class DateOffset {
  readonly n: number;
  readonly name: string;
  readonly kind: Kind;
  /** Fixed length for tick offsets (ms). */
  readonly tickMs: number;
  /** Whether results are anchored to period starts (MS, QS, YS, BMS) – used for resample defaults. */
  readonly startAnchored: boolean;
  private readonly onDay: ((day: number) => boolean) | null;
  private readonly relative: { years: number; months: number; ms: number } | null;

  constructor(spec: {
    n?: number; name: string; kind: Kind; tickMs?: number; startAnchored?: boolean;
    onDay?: (day: number) => boolean; relative?: { years: number; months: number; ms: number };
  }) {
    this.n = spec.n ?? 1;
    this.name = spec.name;
    this.kind = spec.kind;
    this.tickMs = spec.tickMs ?? 0;
    this.startAnchored = spec.startAnchored ?? false;
    this.onDay = spec.onDay ?? null;
    this.relative = spec.relative ?? null;
  }

  /** Same offset repeated `n` times. */
  times(n: number): DateOffset {
    return new DateOffset({ n, name: this.name, kind: this.kind, tickMs: this.tickMs, startAnchored: this.startAnchored, onDay: this.onDay ?? undefined, relative: this.relative ?? undefined });
  }

  get freqstr(): string {
    return this.n === 1 ? this.name : `${this.n}${this.name}`;
  }

  toString(): string {
    return `<${this.n === 1 ? '' : this.n + ' * '}${this.name}>`;
  }

  /** Whether `t` lies on the offset (always true for ticks). */
  isOnOffset(t: number): boolean {
    if (this.kind !== 'anchored') return true;
    return this.onDay!(dayOf(t));
  }

  /** `t` moved forward (n > 0) or backward (n < 0) by `|n|` offsets, keeping the time of day. */
  apply(t: number, n = this.n): number {
    if (t !== t) return NaN;
    if (this.kind === 'tick') return t + n * this.tickMs;
    if (this.kind === 'relative') return addRelative(t, this.relative!, n);
    const day = dayOf(t);
    const tod = t - day * DAY;
    let d = day;
    if (n === 0) return this.onDay!(d) ? t : this.step(d, 1) * DAY + tod;
    for (let k = 0; k < Math.abs(n); k++) d = this.step(d, n > 0 ? 1 : -1);
    return d * DAY + tod;
  }

  private step(day: number, dir: 1 | -1): number {
    let d = day;
    for (let k = 0; k < 800; k++) {
      d += dir;
      if (this.onDay!(d)) return d;
    }
    throw new Error(`Offset ${this.name} never matches`);
  }

  /** Closest on-offset time at or after `t`. */
  rollforward(t: number): number {
    return this.isOnOffset(t) ? t : this.apply(t, 1);
  }

  /** Closest on-offset time at or before `t`. */
  rollback(t: number): number {
    return this.isOnOffset(t) ? t : this.apply(t, -1);
  }
}

function addRelative(t: number, rel: { years: number; months: number; ms: number }, n: number): number {
  let out = t;
  if (rel.years || rel.months) {
    const d = new Date(t);
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n * (rel.years * 12 + rel.months);
    const y = Math.floor(total / 12), m = total - y * 12;
    const day = Math.min(d.getUTCDate(), lastDayOfMonth(y, m));
    out = Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }
  return out + n * rel.ms;
}

function businessPredicate(options: BusinessOptions = {}): (day: number) => boolean {
  let mask = [true, true, true, true, true, false, false];
  if (options.weekmask) {
    const wm = options.weekmask.trim();
    mask = /^[01]{7}$/.test(wm) ? [...wm].map((c) => c === '1') : WEEKDAYS.map((w) => wm.toUpperCase().split(/\s+/).some((x) => x.startsWith(w.slice(0, 3))));
  }
  const holidays = new Set((options.holidays ?? []).map((h) => dayOf(typeof h === 'string' ? Date.parse(h.length === 10 ? h + 'T00:00:00Z' : h) : h.getTime())));
  return (day) => mask[weekday(day)] && !holidays.has(day);
}

const tick = (name: string, ms: number) => (n = 1) => new DateOffset({ n, name, kind: 'tick', tickMs: ms });

/** Offset constructors, like `pd.offsets`. */
export const offsets = {
  Milli: tick('ms', 1),
  Second: tick('s', MS.s),
  Minute: tick('min', MS.min),
  Hour: tick('h', MS.h),
  Day: tick('D', DAY),
  /** Every week, or anchored on a weekday (0 = Monday … 6 = Sunday). */
  Week(n = 1, options: { weekday?: number } = {}): DateOffset {
    if (options.weekday === undefined) return new DateOffset({ n, name: 'W', kind: 'tick', tickMs: 7 * DAY });
    const wd = options.weekday;
    return new DateOffset({ n, name: `W-${WEEKDAYS[wd]}`, kind: 'anchored', onDay: (d) => weekday(d) === wd });
  },
  MonthEnd: (n = 1) => new DateOffset({ n, name: 'ME', kind: 'anchored', onDay: (d) => ymd(d + 1)[2] === 1 }),
  MonthBegin: (n = 1) => new DateOffset({ n, name: 'MS', kind: 'anchored', startAnchored: true, onDay: (d) => ymd(d)[2] === 1 }),
  SemiMonthEnd: (n = 1) => new DateOffset({ n, name: 'SME', kind: 'anchored', onDay: (d) => ymd(d)[2] === 15 || ymd(d + 1)[2] === 1 }),
  SemiMonthBegin: (n = 1) => new DateOffset({ n, name: 'SMS', kind: 'anchored', startAnchored: true, onDay: (d) => ymd(d)[2] === 1 || ymd(d)[2] === 15 }),
  /** Quarter ends; `startingMonth` (1–12) is a month that ends a quarter (default 12 → Mar/Jun/Sep/Dec). */
  QuarterEnd(n = 1, options: { startingMonth?: number } = {}): DateOffset {
    const sm = (options.startingMonth ?? 12) - 1;
    return new DateOffset({ n, name: `QE-${MONTHS[sm]}`, kind: 'anchored', onDay: (d) => { const [, m] = ymd(d); return ymd(d + 1)[2] === 1 && (((m - sm) % 3) + 3) % 3 === 0; } });
  },
  /** Quarter starts; `startingMonth` (default 1 → Jan/Apr/Jul/Oct). */
  QuarterBegin(n = 1, options: { startingMonth?: number } = {}): DateOffset {
    const sm = (options.startingMonth ?? 1) - 1;
    return new DateOffset({ n, name: `QS-${MONTHS[sm]}`, kind: 'anchored', startAnchored: true, onDay: (d) => { const [, m, day] = ymd(d); return day === 1 && (((m - sm) % 3) + 3) % 3 === 0; } });
  },
  YearEnd(n = 1, options: { month?: number } = {}): DateOffset {
    const mo = (options.month ?? 12) - 1;
    return new DateOffset({ n, name: `YE-${MONTHS[mo]}`, kind: 'anchored', onDay: (d) => ymd(d)[1] === mo && ymd(d + 1)[2] === 1 });
  },
  YearBegin(n = 1, options: { month?: number } = {}): DateOffset {
    const mo = (options.month ?? 1) - 1;
    return new DateOffset({ n, name: `YS-${MONTHS[mo]}`, kind: 'anchored', startAnchored: true, onDay: (d) => { const [, m, day] = ymd(d); return m === mo && day === 1; } });
  },
  BusinessDay: (n = 1, options: BusinessOptions = {}) =>
    new DateOffset({ n, name: options.holidays || options.weekmask ? 'C' : 'B', kind: 'anchored', startAnchored: true, onDay: businessPredicate(options) }),
  CustomBusinessDay: (n = 1, options: BusinessOptions = {}) => new DateOffset({ n, name: 'C', kind: 'anchored', startAnchored: true, onDay: businessPredicate(options) }),
  BusinessMonthEnd(n = 1, options: BusinessOptions = {}): DateOffset {
    const isB = businessPredicate(options);
    return new DateOffset({ n, name: 'BME', kind: 'anchored', onDay: (d) => { if (!isB(d)) return false; let k = d + 1; while (!isB(k)) k++; return ymd(k)[1] !== ymd(d)[1]; } });
  },
  BusinessMonthBegin(n = 1, options: BusinessOptions = {}): DateOffset {
    const isB = businessPredicate(options);
    return new DateOffset({ n, name: 'BMS', kind: 'anchored', startAnchored: true, onDay: (d) => { if (!isB(d)) return false; let k = d - 1; while (!isB(k)) k--; return ymd(k)[1] !== ymd(d)[1]; } });
  },
  /** Relative calendar offset, e.g. `DateOffset({ months: 1, days: 2 })`. */
  DateOffset(parts: { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number } = {}): DateOffset {
    const ms = (parts.weeks ?? 0) * 7 * DAY + (parts.days ?? 0) * DAY + (parts.hours ?? 0) * MS.h + (parts.minutes ?? 0) * MS.min + (parts.seconds ?? 0) * MS.s + (parts.milliseconds ?? 0);
    return new DateOffset({ n: 1, name: 'DateOffset', kind: 'relative', relative: { years: parts.years ?? 0, months: parts.months ?? 0, ms } });
  },
};

/** Parses a frequency string such as '3D', '15min', 'W-MON', 'QS-JAN', 'BME'. */
export function toOffset(freq: string | DateOffset): DateOffset {
  if (freq instanceof DateOffset) return freq;
  const m = /^\s*(-?\d+)?\s*([A-Za-z]+)(?:-([A-Za-z]{3}))?\s*$/.exec(freq);
  if (!m) throw new Error(`Invalid frequency: ${freq}`);
  const n = m[1] === undefined ? 1 : Number(m[1]);
  const base = m[2];
  const anchor = m[3]?.toUpperCase();
  const month = anchor ? MONTHS.indexOf(anchor) + 1 : undefined;
  switch (base) {
    case 'ms': case 'L': return offsets.Milli(n);
    case 's': case 'S': return offsets.Second(n);
    case 'min': case 'T': return offsets.Minute(n);
    case 'h': case 'H': return offsets.Hour(n);
    case 'D': return offsets.Day(n);
    case 'B': return offsets.BusinessDay(n);
    case 'C': return offsets.CustomBusinessDay(n);
    case 'W': return offsets.Week(n, { weekday: anchor ? WEEKDAYS.indexOf(anchor) : 6 });
    case 'M': case 'ME': return offsets.MonthEnd(n);
    case 'MS': return offsets.MonthBegin(n);
    case 'SME': case 'SM': return offsets.SemiMonthEnd(n);
    case 'SMS': return offsets.SemiMonthBegin(n);
    case 'BM': case 'BME': return offsets.BusinessMonthEnd(n);
    case 'BMS': return offsets.BusinessMonthBegin(n);
    case 'Q': case 'QE': return offsets.QuarterEnd(n, { startingMonth: month ?? 12 });
    case 'QS': return offsets.QuarterBegin(n, { startingMonth: month ?? 1 });
    case 'Y': case 'A': case 'YE': return offsets.YearEnd(n, { month: month ?? 12 });
    case 'YS': case 'AS': return offsets.YearBegin(n, { month: month ?? 1 });
    default: throw new Error(`Unsupported frequency: ${freq}`);
  }
}

/** Evenly spaced wall-clock times following `offset`. */
export function rangeTimes(start: number | null, end: number | null, periods: number | null, offset: DateOffset): number[] {
  const out: number[] = [];
  const step = (t: number, k: number) => offset.apply(t, k);
  if (start !== null) {
    let t = offset.kind === 'anchored' ? offset.rollforward(start) : start;
    const limit = periods ?? Infinity;
    while (out.length < limit && (end === null || t <= end)) {
      out.push(t);
      t = step(t, offset.n);
      if (out.length > 10_000_000) throw new Error('date range too large');
    }
    return out;
  }
  if (end === null || periods === null) throw new Error('Of start, end and periods, exactly two must be given');
  let t = offset.kind === 'anchored' ? offset.rollback(end) : end;
  for (let k = 0; k < periods; k++) { out.push(t); t = step(t, -offset.n); }
  return out.reverse();
}
