export { Series, KeyError, type SeriesInput, type SeriesOptions, type Mask, type Operand } from './series.ts';
export { DataFrame, type FrameInput, type FrameOptions, type AxisAggOptions, type ColSelector, type ColumnValue } from './frame.ts';
export type { AggFunc, RowSelector } from './series.ts';
export type { AggOptions, QuantileInterpolation } from './core/aggregate.ts';
export { Column } from './core/column.ts';
export type { ColumnMeta } from './core/column.ts';
export { Rolling, Expanding, EWM, type RollingOptions, type EwmOptions, type WinType, type WindowTarget } from './window.ts';
export { Resampler, type ResampleOptions } from './resample.ts';
export type { NaPosition } from './core/sort.ts';
export type { Ambiguous, Nonexistent } from './core/tz.ts';
export type { DateUnit } from './datetimes.ts';
export type { Level } from './levels.ts';
export type { Factor, PivotAggFunc } from './pivot.ts';
export type { Formatter, StyleAxis } from './style.ts';
export type { OffsetKind } from './core/offsets.ts';
export type { ExprNode } from './expr.ts';
export type { SyncDb, AsyncDb } from './io/sql.ts';
export type { NaOption } from './core/stats.ts';
export { DataFrameGroupBy, SeriesGroupBy, GroupedOperation, type GroupByOptions, type AggSpec } from './groupby.ts';
export { concat, merge, type ConcatOptions, type MergeOptions } from './reshape.ts';
export { toDatetime, toTimedelta, dateRange, bdateRange, periodRange, timedeltaRange, type ToDatetimeOptions, type DateRangeOptions } from './datetimes.ts';
export { offsets, toOffset, DateOffset, type BusinessOptions } from './core/offsets.ts';
export { readCsv, readCsvAsync, readCsvChunks, readTable, readFwf, parseCsv, toCsv, CsvTokenizer, type ReadCsvOptions, type ToCsvOptions } from './io/csv.ts';
export type { Compression, Source } from './io/source.ts';
export { readHtml, readHtmlAsync, toHtml, type ReadHtmlOptions, type ToHtmlOptions } from './io/html.ts';
export { readXml, readXmlAsync, toXml, type ReadXmlOptions, type ToXmlOptions } from './io/xml.ts';
export { readExcel, toExcel, ExcelWriter, type ReadExcelOptions, type ToExcelOptions } from './io/excel.ts';
export { readParquet, toParquet, readFeather, toFeather, fromArrow, toArrow, type ReadParquetOptions, type ToParquetOptions } from './io/columnar.ts';
export { readHdf, toHdf, hdfKeys, type ToHdfOptions } from './io/hdf.ts';
export { Styler, type Subset } from './style.ts';
export { formatSpec, pyFormat } from './core/pyformat.ts';
export { plotHtml, compact, type PlotOptions, type PlotKind, type PlotAccessor } from './plot.ts';
export { readSql, readSqlQuery, readSqlTable, readSqlChunks, toSql, type SqlConnection, type SqlDialect, type ReadSqlOptions, type ToSqlOptions } from './io/sql.ts';
export { readJson, readJsonAsync, toJson, type JsonOrient, type ReadJsonOptions } from './io/json.ts';
export { Index, MultiIndex, Slice, slice } from './core/indexes.ts';
export { Interval, type IntervalClosed } from './core/interval.ts';
export { pivotTable, crosstab, getDummies, fromDummies, cut, qcut, intervalRange, factorize, unique, wideToLong, type PivotTableOptions, type CrosstabOptions, type DummiesOptions, type CutOptions } from './pivot.ts';
export { mergeAsof, mergeOrdered, combineFirst, type MergeAsofOptions } from './combine.ts';
export { pivot, stack, unstack } from './levels.ts';
import { DataFrame as DF } from './frame.ts';

/** Wide → long, like `pd.melt`. */
export function melt(df: DF, options: Parameters<DF['melt']>[0] = {}): DF {
  return df.melt(options);
}
export { DISPLAY as options, setOption, getOption, resetOption, optionContext } from './core/format.ts';
export { StringMethods, DatetimeMethods } from './accessors.ts';
export type { DType, Label, AggName, Storage } from './core/types.ts';
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
