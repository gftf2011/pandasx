export { Series, KeyError, type SeriesInput, type SeriesOptions, type Mask, type Operand } from './series.ts';
export { DataFrame, type FrameInput, type FrameOptions, type AxisAggOptions } from './frame.ts';
export { DataFrameGroupBy, SeriesGroupBy, type GroupByOptions, type AggSpec } from './groupby.ts';
export { concat, merge, toDatetime, dateRange, type ConcatOptions, type MergeOptions } from './reshape.ts';
export { readCsv, parseCsv, toCsv, type ReadCsvOptions, type ToCsvOptions } from './io/csv.ts';
export { readJson, toJson, type JsonOrient } from './io/json.ts';
export { Index, Slice, slice } from './core/indexes.ts';
export { DISPLAY as options } from './core/format.ts';
export { StringMethods, DatetimeMethods } from './accessors.ts';
export type { DType, Label, AggName } from './core/types.ts';
export { Timedelta, Period, type TimedeltaParts, type PeriodFreq } from './core/time.ts';
export { CategoricalMethods } from './accessors.ts';
export { evaluate as eval, evaluate, parseExpression } from './expr.ts';
export type { GroupKey } from './groupby.ts';
export type { RankOptions, RankMethod, CorrMethod, InterpolateOptions, InterpolateMethod } from './core/stats.ts';
import { Series as SeriesClass } from './series.ts';

/** pandas' `pd.NA`: missing values of nullable dtypes read back as `null`. */
export const NA = null;

/** Builds a categorical Series, like `pd.Categorical(values, categories, ordered)`. */
export function categorical(values: Iterable<unknown>, options: { categories?: readonly unknown[]; ordered?: boolean; name?: string } = {}): SeriesClass {
  return new SeriesClass([...values], { name: options.name }).astype('category', options);
}

import { isNA as isMissing } from './core/values.ts';

/** True for null, undefined, NaN and invalid Dates (like `pd.isna` on a scalar). */
export function isna(value: unknown): boolean {
  return isMissing(value);
}

export function notna(value: unknown): boolean {
  return !isMissing(value);
}
