/** Time primitives missing from JavaScript: durations (Timedelta) and spans (Period). */

export const MS = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, D: 86_400_000, W: 7 * 86_400_000 } as const;

const UNIT_ALIASES: Record<string, number> = {
  w: MS.W, week: MS.W, weeks: MS.W, W: MS.W,
  d: MS.D, day: MS.D, days: MS.D, D: MS.D,
  h: MS.h, hr: MS.h, hour: MS.h, hours: MS.h, H: MS.h,
  m: MS.min, min: MS.min, mins: MS.min, minute: MS.min, minutes: MS.min, T: MS.min,
  s: MS.s, sec: MS.s, secs: MS.s, second: MS.s, seconds: MS.s, S: MS.s,
  ms: 1, milli: 1, millis: 1, millisecond: 1, milliseconds: 1, L: 1,
  us: 1e-3, microsecond: 1e-3, microseconds: 1e-3,
  ns: 1e-6, nanosecond: 1e-6, nanoseconds: 1e-6,
};

export interface TimedeltaParts {
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

/** A duration with millisecond resolution, like `pandas.Timedelta`. */
export class Timedelta {
  readonly ms: number;

  constructor(value: number | string | TimedeltaParts | Timedelta, unit = 'ms') {
    if (value instanceof Timedelta) this.ms = value.ms;
    else if (typeof value === 'number') this.ms = value * (UNIT_ALIASES[unit] ?? NaN);
    else if (typeof value === 'string') this.ms = parseTimedelta(value);
    else {
      this.ms = (value.weeks ?? 0) * MS.W + (value.days ?? 0) * MS.D + (value.hours ?? 0) * MS.h +
        (value.minutes ?? 0) * MS.min + (value.seconds ?? 0) * MS.s + (value.milliseconds ?? 0);
    }
  }

  /** Whole days (floored, like pandas: -1 days +23:00:00 for -1h). */
  get days(): number { return Math.floor(this.ms / MS.D); }
  /** Seconds within the day (0–86399). */
  get seconds(): number { return Math.floor((this.ms - this.days * MS.D) / 1000); }
  get milliseconds(): number { return Math.round(this.ms - this.days * MS.D - this.seconds * 1000); }

  totalSeconds(): number { return this.ms / 1000; }
  totalDays(): number { return this.ms / MS.D; }

  valueOf(): number { return this.ms; }

  toString(): string {
    if (Number.isNaN(this.ms)) return 'NaT';
    const days = this.days;
    let rest = this.ms - days * MS.D;
    const h = Math.floor(rest / MS.h); rest -= h * MS.h;
    const m = Math.floor(rest / MS.min); rest -= m * MS.min;
    const s = Math.floor(rest / 1000); rest -= s * 1000;
    const p = (n: number) => String(n).padStart(2, '0');
    const frac = rest > 0 ? '.' + String(Math.round(rest * 1000)).padStart(6, '0') : '';
    return `${days} days ${p(h)}:${p(m)}:${p(s)}${frac}`;
  }

  /** ISO 8601 duration, e.g. `P1DT2H3M4S`. */
  isoformat(): string {
    const sign = this.ms < 0 ? '-' : '';
    let rest = Math.abs(this.ms);
    const d = Math.floor(rest / MS.D); rest -= d * MS.D;
    const h = Math.floor(rest / MS.h); rest -= h * MS.h;
    const m = Math.floor(rest / MS.min); rest -= m * MS.min;
    const s = rest / 1000;
    return `${sign}P${d}DT${h}H${m}M${s}S`;
  }

  toJSON(): string { return this.isoformat(); }

  [Symbol.for('nodejs.util.inspect.custom')](): string { return `Timedelta('${this.toString()}')`; }
}

/** Parses '1 days 02:03:04.5', '1d 2h', '90min', '-1.5h', 'P1DT2H' into milliseconds. */
export function parseTimedelta(text: string): number {
  const s = text.trim();
  if (s === '' || s === 'NaT') return NaN;
  const iso = /^(-)?P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
  if (iso) {
    const [, neg, w, d, h, m, sec] = iso;
    const v = Number(w ?? 0) * MS.W + Number(d ?? 0) * MS.D + Number(h ?? 0) * MS.h + Number(m ?? 0) * MS.min + Number(sec ?? 0) * 1000;
    return neg ? -v : v;
  }
  let total = 0;
  let rest = s;
  const clock = /([+-])?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s*$/.exec(rest);
  if (clock) {
    const v = Number(clock[2]) * MS.h + Number(clock[3]) * MS.min + Number(clock[4]) * 1000;
    total += clock[1] === '-' ? -v : v;
    rest = rest.slice(0, clock.index);
  }
  const re = /([+-]?\d*\.?\d+)\s*([a-zA-Z]+)/g;
  let matched = rest.trim() === '';
  for (const m of rest.matchAll(re)) {
    const unit = UNIT_ALIASES[m[2]] ?? UNIT_ALIASES[m[2].toLowerCase()];
    if (unit === undefined) throw new Error(`Unknown timedelta unit: ${m[2]}`);
    total += Number(m[1]) * unit;
    matched = true;
  }
  if (!matched) {
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
    throw new Error(`Cannot parse timedelta: ${text}`);
  }
  return total;
}

// ------------------------------------------------------------------ periods

export type PeriodFreq = 'Y' | 'Q' | 'M' | 'W' | 'D' | 'h' | 'min' | 's';

const FREQ_ALIASES: Record<string, PeriodFreq> = {
  Y: 'Y', A: 'Y', YE: 'Y', AS: 'Y', YS: 'Y', Q: 'Q', QE: 'Q', QS: 'Q', M: 'M', ME: 'M', MS: 'M',
  W: 'W', D: 'D', h: 'h', H: 'h', min: 'min', T: 'min', s: 's', S: 's',
};

export function normalizeFreq(freq: string): PeriodFreq {
  const f = FREQ_ALIASES[freq];
  if (!f) throw new Error(`Unsupported period frequency: ${freq}`);
  return f;
}

/** Ordinal of the period of `freq` containing `t` (epoch ms, UTC). */
export function periodOrdinal(t: number, freq: PeriodFreq): number {
  if (Number.isNaN(t)) return NaN;
  const d = new Date(t);
  const y = d.getUTCFullYear() - 1970;
  switch (freq) {
    case 'Y': return y;
    case 'Q': return y * 4 + Math.floor(d.getUTCMonth() / 3);
    case 'M': return y * 12 + d.getUTCMonth();
    case 'W': return Math.floor((Math.floor(t / MS.D) + 3) / 7);
    case 'D': return Math.floor(t / MS.D);
    case 'h': return Math.floor(t / MS.h);
    case 'min': return Math.floor(t / MS.min);
    case 's': return Math.floor(t / MS.s);
  }
}

/** Start instant (epoch ms) of a period ordinal. */
export function periodStart(ordinal: number, freq: PeriodFreq): number {
  switch (freq) {
    case 'Y': return Date.UTC(1970 + ordinal, 0, 1);
    case 'Q': return Date.UTC(1970 + Math.floor(ordinal / 4), (((ordinal % 4) + 4) % 4) * 3, 1);
    case 'M': return Date.UTC(1970 + Math.floor(ordinal / 12), ((ordinal % 12) + 12) % 12, 1);
    case 'W': return (ordinal * 7 - 3) * MS.D;
    case 'D': return ordinal * MS.D;
    case 'h': return ordinal * MS.h;
    case 'min': return ordinal * MS.min;
    case 's': return ordinal * MS.s;
  }
}

/** A span of time such as the month 2024-03, like `pandas.Period`. */
export class Period {
  readonly ordinal: number;
  readonly freq: PeriodFreq;

  constructor(value: Date | string | number, freq: string = 'D') {
    this.freq = normalizeFreq(freq);
    if (typeof value === 'number') this.ordinal = value;
    else if (value instanceof Date) this.ordinal = periodOrdinal(value.getTime(), this.freq);
    else this.ordinal = periodOrdinal(parsePeriodString(value), this.freq);
  }

  get startTime(): Date { return new Date(periodStart(this.ordinal, this.freq)); }
  /** Last millisecond of the period. */
  get endTime(): Date { return new Date(periodStart(this.ordinal + 1, this.freq) - 1); }

  add(n: number): Period { return new Period(this.ordinal + n, this.freq); }

  valueOf(): number { return this.ordinal; }

  toString(): string {
    const d = this.startTime;
    const y = d.getUTCFullYear();
    const p = (n: number) => String(n).padStart(2, '0');
    const iso = d.toISOString();
    switch (this.freq) {
      case 'Y': return String(y);
      case 'Q': return `${y}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      case 'M': return `${y}-${p(d.getUTCMonth() + 1)}`;
      case 'W': return `${iso.slice(0, 10)}/${new Date(d.getTime() + 6 * MS.D).toISOString().slice(0, 10)}`;
      case 'D': return iso.slice(0, 10);
      case 'h': return iso.slice(0, 13).replace('T', ' ') + ':00';
      case 'min': return iso.slice(0, 16).replace('T', ' ');
      case 's': return iso.slice(0, 19).replace('T', ' ');
    }
  }

  toJSON(): string { return this.toString(); }

  [Symbol.for('nodejs.util.inspect.custom')](): string { return `Period('${this.toString()}', '${this.freq}')`; }
}

/** Accepts '2024', '2024Q1', '2024-03', '2024-03-15' and anything Date.parse understands. */
export function parsePeriodString(s: string): number {
  const q = /^(\d{4})-?Q([1-4])$/i.exec(s.trim());
  if (q) return Date.UTC(Number(q[1]), (Number(q[2]) - 1) * 3, 1);
  if (/^\d{4}$/.test(s.trim())) return Date.UTC(Number(s), 0, 1);
  if (/^\d{4}-\d{2}$/.test(s.trim())) return Date.parse(s + '-01T00:00:00Z');
  return parseDate(s);
}

/** Date.parse, but date-only and naive date-times are read as UTC (pandas treats naive times as UTC-like). */
export function parseDate(s: string): number {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) return Date.parse(t.replace(' ', 'T') + 'Z');
  return Date.parse(t);
}
