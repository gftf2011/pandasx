/** Helpers that operate on single JS values: missing detection, hashing and ordering. */

export function isNA(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ||
    (v instanceof Date && Number.isNaN(v.getTime()));
}

/**
 * Maps a value to a primitive usable as a Map key, so that equal Dates and equal
 * tuples collide. All missing values share one key.
 */
export function hashKey(v: unknown): unknown {
  if (isNA(v)) return null;
  if (v instanceof Date) return '\u0000d' + v.getTime();
  if (Array.isArray(v)) return '\u0000t' + v.map(encodePart).join('\u0001');
  return v;
}

function encodePart(v: unknown): string {
  if (isNA(v)) return 'n';
  if (v instanceof Date) return 'd' + v.getTime();
  if (Array.isArray(v)) return '[' + v.map(encodePart).join('\u0002') + ']';
  return typeof v === 'string' ? 's' + v : typeof v === 'number' ? 'f' + v : 'o' + String(v);
}

const TYPE_RANK: Record<string, number> = { boolean: 0, number: 1, bigint: 1, object: 2, string: 3 };

/** Total order used by sorting: numbers < dates < strings, tuples compared element-wise. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const ra = TYPE_RANK[typeof a] ?? 4;
  const rb = TYPE_RANK[typeof b] ?? 4;
  if (ra !== rb) return ra - rb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNA(a) || isNA(b)) return false;
  return hashKey(a) === hashKey(b);
}
