/** Helpers that operate on single JS values: missing detection, hashing and ordering. */
import { Period, Timedelta } from './time.ts';
import { Interval } from './interval.ts';

export function isNA(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return v !== v;
  if (v instanceof Date) return Number.isNaN(v.getTime());
  if (v instanceof Timedelta) return Number.isNaN(v.ms);
  return false;
}

/**
 * Maps a value to a primitive usable as a Map key, so that equal Dates, durations,
 * periods and tuples collide. All missing values share one key.
 */
export function hashKey(v: unknown): unknown {
  if (isNA(v)) return null;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return '\u0000d' + v.getTime();
  if (v instanceof Timedelta) return '\u0000td' + v.ms;
  if (v instanceof Period) return '\u0000p' + v.freq + v.ordinal;
  if (v instanceof Interval) return '\u0000i' + v.closed + v.left + ',' + v.right;
  if (Array.isArray(v)) return '\u0000t' + v.map(encodePart).join('\u0001');
  return v;
}

function encodePart(v: unknown): string {
  if (isNA(v)) return 'n';
  if (Array.isArray(v)) return '[' + v.map(encodePart).join('\u0002') + ']';
  const k = hashKey(v);
  return typeof k === 'string' ? 's' + k : typeof k === 'number' ? 'f' + k : typeof k === 'bigint' ? 'b' + k : 'o' + String(k);
}

const TYPE_RANK: Record<string, number> = { boolean: 0, number: 1, bigint: 1, object: 2, string: 3 };

/** Total order used by sorting: numbers < dates < strings, tuples compared element-wise. */
export function compareValues(a: unknown, b: unknown): number {
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ta === 'string' && tb === 'string') return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  if ((ta === 'bigint' || ta === 'number') && (tb === 'bigint' || tb === 'number')) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof Timedelta && b instanceof Timedelta) return a.ms - b.ms;
  if (a instanceof Period && b instanceof Period) return a.ordinal - b.ordinal;
  if (a instanceof Interval && b instanceof Interval) return a.left - b.left || a.right - b.right;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (ta === 'boolean' && tb === 'boolean') return Number(a) - Number(b);
  const ra = TYPE_RANK[ta] ?? 4;
  const rb = TYPE_RANK[tb] ?? 4;
  if (ra !== rb) return ra - rb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNA(a) || isNA(b)) return false;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    // 1n == 1, but only when both are integral.
    return (typeof a === 'number' && Number.isInteger(a) && BigInt(a) === b) || (typeof b === 'number' && Number.isInteger(b) && BigInt(b) === a);
  }
  return hashKey(a) === hashKey(b);
}
