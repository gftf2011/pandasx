import type { Column } from './column.ts';
import { isFloatStorage } from './types.ts';
import { compareValues } from './values.ts';

export type NaPosition = 'first' | 'last';

export interface SortKey {
  /** Raw comparable values. */
  values: ArrayLike<unknown>;
  missing: (i: number) => boolean;
  ascending: boolean;
}

export function sortKeyFromColumn(col: Column, ascending: boolean): SortKey {
  if (isFloatStorage(col.dtype) || col.dtype === 'bool') {
    const data = col.data as ArrayLike<number>;
    return { values: data, missing: (i) => Number.isNaN(data[i]), ascending };
  }
  if (col.dtype === 'category') {
    // Categoricals sort by category order, not by value.
    const codes = col.data as Int32Array;
    return { values: codes, missing: (i) => codes[i] < 0, ascending };
  }
  const data = col.toArray();
  return { values: data, missing: (i) => col.isNA(i), ascending };
}

/** Stable multi-key argsort. Missing values go to `naPosition` regardless of direction. */
export function argsort(keys: readonly SortKey[], n: number, naPosition: NaPosition = 'last'): number[] {
  const numeric = (v: ArrayLike<unknown>) => v instanceof Float64Array || v instanceof Uint8Array || v instanceof Int32Array;
  if (keys.length === 1 && n >= RADIX_MIN && LITTLE_ENDIAN && numeric(keys[0].values)) return radixArgsort(keys[0], n, naPosition);
  const order = Array.from({ length: n }, (_, i) => i);
  const naSign = naPosition === 'last' ? 1 : -1;
  const numericOnly = keys.every((k) => numeric(k.values));
  // Missing flags computed once, not on every comparison.
  const missing = keys.map((k) => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = k.missing(i) ? 1 : 0;
    return m;
  });
  order.sort((a, b) => {
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      const ma = missing[j][a];
      const mb = missing[j][b];
      if (ma || mb) {
        if (ma && mb) continue;
        return ma ? naSign : -naSign;
      }
      const va = k.values[a];
      const vb = k.values[b];
      const c = numericOnly ? (va as number) - (vb as number) : compareValues(va, vb);
      if (c !== 0) return k.ascending ? c : -c;
    }
    return a - b;
  });
  return order;
}

/** Below this size the comparison sort is as fast and allocates less. */
const RADIX_MIN = 512;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Stable argsort of one numeric key: an LSD radix sort (four 16-bit passes) on
 * the float64 bit pattern, mapped so unsigned order equals numeric order.
 * Descending order sorts the complemented keys, which keeps ties in their
 * original order like the comparison sort does.
 */
function radixArgsort(key: SortKey, n: number, naPosition: NaPosition): number[] {
  const vals = key.values as ArrayLike<number>;
  const present: number[] = [];
  const absent: number[] = [];
  for (let i = 0; i < n; i++) (key.missing(i) ? absent : present).push(i);
  const m = present.length;
  const f = new Float64Array(m);
  for (let k = 0; k < m; k++) f[k] = vals[present[k]] + 0; // + 0 turns -0 into 0, which compares equal to it
  const words = new Uint32Array(f.buffer); // little-endian: [lo, hi] per value
  const flip = key.ascending ? 0 : 0xffffffff;
  for (let k = 0; k < m; k++) {
    const hi = words[2 * k + 1];
    if (hi & 0x80000000) {
      words[2 * k + 1] = ~hi ^ flip;
      words[2 * k] = ~words[2 * k] ^ flip;
    } else {
      words[2 * k + 1] = (hi | 0x80000000) ^ flip;
      words[2 * k] ^= flip;
    }
  }
  let order = new Uint32Array(m);
  for (let k = 0; k < m; k++) order[k] = k;
  let next = new Uint32Array(m);
  const counts = new Uint32Array(65536);
  for (let pass = 0; pass < 4; pass++) {
    const word = pass >> 1;
    const shift = (pass & 1) * 16;
    counts.fill(0);
    for (let k = 0; k < m; k++) counts[(words[2 * k + word] >>> shift) & 0xffff]++;
    if (counts[(words[word] >>> shift) & 0xffff] === m) continue; // every value has the same digit
    let sum = 0;
    for (let d = 0; d < 65536; d++) { const c = counts[d]; counts[d] = sum; sum += c; }
    for (let j = 0; j < m; j++) {
      const k = order[j];
      next[counts[(words[2 * k + word] >>> shift) & 0xffff]++] = k;
    }
    const t = order; order = next; next = t;
  }
  const out = new Array<number>(n);
  let o = 0;
  if (naPosition === 'first') for (const i of absent) out[o++] = i;
  for (let j = 0; j < m; j++) out[o++] = present[order[j]];
  if (naPosition === 'last') for (const i of absent) out[o++] = i;
  return out;
}
