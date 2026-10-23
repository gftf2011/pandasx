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
  const order = Array.from({ length: n }, (_, i) => i);
  const naSign = naPosition === 'last' ? 1 : -1;
  const numericOnly = keys.every((k) => k.values instanceof Float64Array || k.values instanceof Uint8Array || k.values instanceof Int32Array);
  order.sort((a, b) => {
    for (const k of keys) {
      const ma = k.missing(a);
      const mb = k.missing(b);
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
