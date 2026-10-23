/**
 * Logical data types, mirroring the pandas dtypes that matter in practice.
 *
 * Storage per dtype:
 * - `float64`  Float64Array, missing = NaN
 * - `int64`    Float64Array holding integers, never missing (upcasts to float64 when NA appears)
 * - `bool`     Uint8Array, never missing (upcasts to object when NA appears)
 * - `datetime` Float64Array of epoch milliseconds, missing = NaN (NaT)
 * - `string`   Array<string | null>, missing = null
 * - `object`   Array<unknown>, missing = null / undefined / NaN
 */
export type DType = 'float64' | 'int64' | 'bool' | 'datetime' | 'string' | 'object';

/** A row or column label. Tuples appear in indexes produced by multi-key groupby. */
export type Label = string | number | boolean | Date | null | readonly Label[];

/** Backing storage of a column. */
export type Storage = Float64Array | Uint8Array | unknown[];

export type AggName =
  | 'sum'
  | 'mean'
  | 'median'
  | 'min'
  | 'max'
  | 'count'
  | 'std'
  | 'var'
  | 'prod'
  | 'first'
  | 'last'
  | 'nunique'
  | 'size';

export const NUMERIC_DTYPES: ReadonlySet<DType> = new Set<DType>(['float64', 'int64', 'bool']);

export function isNumericDType(dtype: DType): boolean {
  return NUMERIC_DTYPES.has(dtype);
}

/** Dtypes stored in a Float64Array. */
export function isFloatStorage(dtype: DType): boolean {
  return dtype === 'float64' || dtype === 'int64' || dtype === 'datetime';
}
