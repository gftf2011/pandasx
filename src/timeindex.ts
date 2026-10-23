/** Operations on datetime indexes shared by Series and DataFrame. */
import { Index } from './core/indexes.ts';
import { toOffset, type DateOffset } from './core/offsets.ts';
import { parseDate, Period } from './core/time.ts';
import type { Label } from './core/types.ts';
import { checkTimeZone, fromWall, toWall, type Ambiguous, type Nonexistent } from './core/tz.ts';
import { compareValues } from './core/values.ts';
import type { DataFrame } from './frame.ts';
import type { Series } from './series.ts';

type Target = Series | DataFrame;

function times(index: Index): number[] {
  return index.labels.map((l) => {
    if (l instanceof Date) return l.getTime();
    if (l === null) return NaN;
    throw new TypeError('This operation requires a DatetimeIndex (Date labels)');
  });
}

function withIndex<T extends Target>(target: T, index: Index): T {
  const copy = (target as unknown as { _withIndex(i: Index): T })._withIndex(index);
  return copy;
}

/** Shifts the index by `periods` × `freq` (data unchanged). */
export function shiftIndex<T extends Target>(target: T, periods: number, freq: string | DateOffset): T {
  const off = toOffset(freq);
  const tz = target.index.tz;
  const labels = times(target.index).map((t) => {
    if (t !== t) return null;
    const w = off.apply(toWall(t, tz), periods * off.n);
    return new Date(tz ? fromWall(w, tz, 'earliest', 'shift_forward') : w);
  });
  return withIndex(target, new Index(labels, { name: target.index.name, tz }));
}

export function tzLocalizeIndex<T extends Target>(target: T, tz: string | null, options: { ambiguous?: Ambiguous; nonexistent?: Nonexistent } = {}): T {
  const cur = target.index.tz;
  if (tz === null) {
    const labels = times(target.index).map((t) => (t !== t ? null : new Date(toWall(t, cur))));
    return withIndex(target, new Index(labels, { name: target.index.name }));
  }
  if (cur) throw new TypeError('Already tz-aware, use tzConvert to convert');
  checkTimeZone(tz);
  const labels = times(target.index).map((t) => (t !== t ? null : new Date(fromWall(t, tz, options.ambiguous, options.nonexistent))));
  return withIndex(target, new Index(labels, { name: target.index.name, tz }));
}

export function tzConvertIndex<T extends Target>(target: T, tz: string | null): T {
  if (!target.index.tz) throw new TypeError('Cannot convert tz-naive timestamps, use tzLocalize to localize');
  if (tz) checkTimeZone(tz);
  return withIndex(target, new Index(target.index.labels, { name: target.index.name, tz: tz ?? 'UTC' }));
}

function timeOfDay(text: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(text.trim());
  if (!m) throw new Error(`Invalid time: ${text}`);
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0)) * 1000 + Number(((m[4] ?? '') + '000').slice(0, 3));
}

const msOfDay = (t: number, tz: string | null) => { const w = toWall(t, tz); return ((w % 86_400_000) + 86_400_000) % 86_400_000; };

/** Rows whose time of day equals `time` ('HH:MM[:SS]'). */
export function atTimePositions(index: Index, time: string): number[] {
  const target = timeOfDay(time);
  return times(index).flatMap((t, i) => (t === t && msOfDay(t, index.tz) === target ? [i] : []));
}

/** Rows whose time of day is within [start, end] (wrapping past midnight when start > end). */
export function betweenTimePositions(index: Index, start: string, end: string, inclusive: 'both' | 'neither' | 'left' | 'right' = 'both'): number[] {
  const s = timeOfDay(start), e = timeOfDay(end);
  const geS = (x: number) => (inclusive === 'both' || inclusive === 'left' ? x >= s : x > s);
  const leE = (x: number) => (inclusive === 'both' || inclusive === 'right' ? x <= e : x < e);
  return times(index).flatMap((t, i) => {
    if (t !== t) return [];
    const x = msOfDay(t, index.tz);
    return (s <= e ? geS(x) && leE(x) : geS(x) || leE(x)) ? [i] : [];
  });
}

/** Rows with labels in [before, after] on a sorted index. */
export function truncatePositions(index: Index, before?: Label | string, after?: Label | string): number[] {
  const conv = (v: Label | string | undefined) => (v !== undefined && typeof v === 'string' && index.labels[0] instanceof Date ? new Date(parseDate(v)) : v);
  const b = conv(before), a = conv(after);
  if (b !== undefined && a !== undefined && compareValues(b, a) > 0) throw new RangeError('Truncate: after must be after before');
  return index.labels.flatMap((l, i) => ((b === undefined || compareValues(l, b) >= 0) && (a === undefined || compareValues(l, a) <= 0) ? [i] : []));
}

export function toPeriodIndex<T extends Target>(target: T, freq = 'D'): T {
  const tz = target.index.tz;
  const labels = times(target.index).map((t) => (t !== t ? null : new Period(new Date(toWall(t, tz)), freq)));
  return withIndex(target, new Index(labels as unknown as Label[], { name: target.index.name }));
}

export function toTimestampIndex<T extends Target>(target: T, how: 'start' | 'end' = 'start'): T {
  const labels = target.index.labels.map((l) => {
    if (l === null) return null;
    if (!(l instanceof Period)) throw new TypeError('toTimestamp requires a PeriodIndex');
    return how === 'start' ? l.startTime : l.endTime;
  });
  return withIndex(target, new Index(labels, { name: target.index.name }));
}
