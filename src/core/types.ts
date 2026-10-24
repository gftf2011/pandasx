import type { Period, Timedelta } from './time.ts';
import type { Interval } from './interval.ts';

/**
 * Logical data types, mirroring pandas dtypes.
 *
 * Storage per dtype:
 * - `float64`   Float64Array, missing = NaN
 * - `int64`     Float64Array holding integers, never missing (upcasts to float64 when NA appears)
 * - `bool`      Uint8Array, never missing (upcasts to object when NA appears)
 * - `Int64`     nullable integer: Float64Array, missing = NaN, read back as null (pandas `Int64`)
 * - `Float64`   nullable float: Float64Array, missing = NaN, read back as null (pandas `Float64`)
 * - `boolean`   nullable boolean: Float64Array of 0/1, missing = NaN (pandas `boolean`)
 * - `datetime`  Float64Array of epoch milliseconds (UTC), missing = NaN (NaT)
 * - `timedelta` Float64Array of milliseconds, missing = NaN (NaT)
 * - `period`    Float64Array of period ordinals, missing = NaN; frequency in column metadata
 * - `category`  Int32Array of codes into `categories`, missing = -1
 * - `bigint`    `Array<bigint | null>`, exact integers of any size
 * - `string`    `Array<string | null>`, missing = null
 * - `object`    `Array<unknown>`, missing = null / undefined / NaN
 */
export type DType =
  | 'float64'
  | 'int64'
  | 'bool'
  | 'Int64'
  | 'Float64'
  | 'boolean'
  | 'datetime'
  | 'timedelta'
  | 'period'
  | 'category'
  | 'bigint'
  | 'string'
  | 'object';

/** A row or column label. Tuples are the labels of a MultiIndex. */
export type Label = string | number | boolean | Date | bigint | null | Period | Timedelta | Interval | readonly Label[];

/** Backing storage of a column. */
export type Storage = Float64Array | Uint8Array | Int32Array | unknown[];

export type AggName =
  | 'sum'
  | 'mean'
  | 'median'
  | 'min'
  | 'max'
  | 'count'
  | 'std'
  | 'var'
  | 'sem'
  | 'prod'
  | 'first'
  | 'last'
  | 'nunique'
  | 'size'
  | 'any'
  | 'all';

/** Every aggregation name, for telling `['col', 'sum']` (named aggregation) from `['sum', 'mean']`. */
export const AGG_NAMES: ReadonlySet<string> = new Set<AggName>(['sum', 'mean', 'median', 'min', 'max', 'count', 'std', 'var', 'sem', 'prod', 'first', 'last', 'nunique', 'size', 'any', 'all']);

export const NUMERIC_DTYPES: ReadonlySet<DType> = new Set<DType>(['float64', 'int64', 'bool', 'Int64', 'Float64', 'boolean', 'bigint']);

/** Dtypes whose missing values read back as `null` (pandas `pd.NA`) rather than NaN. */
export const NULLABLE_DTYPES: ReadonlySet<DType> = new Set<DType>(['Int64', 'Float64', 'boolean']);

export function isNumericDType(dtype: DType): boolean {
  return NUMERIC_DTYPES.has(dtype);
}

/** Dtypes stored in a Float64Array. */
export function isFloatStorage(dtype: DType): boolean {
  switch (dtype) {
    case 'float64':
    case 'int64':
    case 'Int64':
    case 'Float64':
    case 'boolean':
    case 'datetime':
    case 'timedelta':
    case 'period':
      return true;
    default:
      return false;
  }
}

/** Dtypes whose numeric storage can feed arithmetic kernels directly. */
export function isNumericStorage(dtype: DType): boolean {
  return isFloatStorage(dtype) || dtype === 'bool';
}

/** Integer-valued dtypes. */
export function isIntegerDType(dtype: DType): boolean {
  return dtype === 'int64' || dtype === 'Int64' || dtype === 'bigint';
}
