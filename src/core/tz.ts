/**
 * Time zone support on top of Intl (IANA names like 'America/Sao_Paulo', 'UTC',
 * or fixed offsets like '+03:00'). Datetimes are stored as UTC instants; a zone
 * only changes how they are read (wall clock) and displayed.
 */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function fixedOffset(tz: string): number | null {
  if (tz === 'UTC' || tz === 'utc' || tz === 'Z' || tz === 'GMT') return 0;
  const m = /^(?:UTC|GMT)?([+-])(\d{2}):?(\d{2})?$/.exec(tz);
  if (!m) return null;
  const v = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
  return m[1] === '-' ? -v : v;
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** Validates a zone name, throwing a RangeError for unknown zones. */
export function checkTimeZone(tz: string): string {
  if (fixedOffset(tz) === null) formatter(tz);
  return tz;
}

/** UTC offset (ms) of `tz` at the instant `utc`. */
export function tzOffset(utc: number, tz: string): number {
  const fixed = fixedOffset(tz);
  if (fixed !== null) return fixed;
  if (utc !== utc) return 0;
  const parts = formatter(tz).formatToParts(new Date(utc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(utc / 1000) * 1000;
}

/** Wall-clock time (as a UTC-based ms value) of the instant `utc` in `tz`. */
export function toWall(utc: number, tz: string | null | undefined): number {
  return tz ? utc + tzOffset(utc, tz) : utc;
}

export type Ambiguous = 'raise' | 'NaT' | 'earliest' | 'latest';
export type Nonexistent = 'raise' | 'NaT' | 'shift_forward' | 'shift_backward';

/** Instant whose wall clock in `tz` is `wall`, resolving DST ambiguity/gaps. */
export function fromWall(wall: number, tz: string, ambiguous: Ambiguous = 'raise', nonexistent: Nonexistent = 'raise'): number {
  if (wall !== wall) return NaN;
  const fixed = fixedOffset(tz);
  if (fixed !== null) return wall - fixed;
  const before = tzOffset(wall - 86_400_000, tz);
  const after = tzOffset(wall + 86_400_000, tz);
  const candidates = [...new Set([wall - before, wall - after])].filter((c) => c + tzOffset(c, tz) === wall).sort((a, b) => a - b);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 2) {
    switch (ambiguous) {
      case 'earliest': return candidates[0];
      case 'latest': return candidates[1];
      case 'NaT': return NaN;
      default: throw new RangeError(`Cannot infer DST time from ${new Date(wall).toISOString().slice(0, 19)} in ${tz}, try ambiguous='earliest'`);
    }
  }
  // Wall time falls in a DST gap: find the transition instant by bisection.
  switch (nonexistent) {
    case 'NaT': return NaN;
    case 'shift_forward':
    case 'shift_backward': {
      let lo = wall - before, hi = wall - after;
      if (lo > hi) [lo, hi] = [hi, lo];
      lo -= 86_400_000; hi += 86_400_000;
      const offLo = tzOffset(lo, tz);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (tzOffset(mid, tz) === offLo) lo = mid; else hi = mid;
      }
      return nonexistent === 'shift_forward' ? hi : hi - 1;
    }
    default: throw new RangeError(`${new Date(wall).toISOString().slice(0, 19)} does not exist in ${tz} (DST gap), try nonexistent='shift_forward'`);
  }
}

/** '+HH:MM' suffix for an offset in ms. */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const m = Math.abs(ms) / 60_000;
  return `${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
