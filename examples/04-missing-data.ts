// Missing data: detecting, dropping, filling and interpolating.
// Run: node 04-missing-data.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });

title('Where are the holes?');
console.log(sales.isna().sum());                       // missing per column
console.log('rows with any NA:', sales.isna().any({ axis: 1 }).sum());
console.log(sales.get(sales.get('payment').isna()).head(3));

title('NA in reductions (skipped by default)');
const discount = sales.get('discount');
console.log({ mean: discount.mean(), meanStrict: discount.mean({ skipna: false }), count: discount.count() });
console.log(pd.isna(null), pd.isna(NaN), pd.notna(0));

title('Dropping');
console.log('dropna():', sales.dropna().length);
console.log('subset payment:', sales.dropna({ subset: ['payment'] }).length);
console.log('thresh 8:', sales.dropna({ thresh: 8 }).length);
console.log('columns without NA:', sales.dropna({ axis: 1 }).columns);

title('Filling');
const filled = sales.fillna({ discount: 0, payment: 'unknown' });
console.log(filled.isna().sum().sum());
console.log(filled.get('payment').valueCounts());

title('Forward / backward fill');
const readings = new pd.Series([20.1, null, null, 21.4, null, 22.0]);
console.log(readings.ffill().toArray());
console.log(readings.bfill().toArray());
console.log(readings.ffill(1).toArray());              // fill at most 1 in a row

title('Interpolation');
console.log(readings.interpolate().round(2).toArray());
console.log(new pd.Series([0, 1, null, 9, 16]).interpolate({ method: 'quadratic' }).toArray());
console.log(new pd.Series([null, 1, null, 3, null]).interpolate({ limitDirection: 'both' }).toArray());
const byTime = new pd.Series([10, null, 40], { index: pd.toDatetime(['2024-03-01', '2024-03-02', '2024-03-05']).toArray() as Date[] });
console.log(byTime.interpolate({ method: 'time' }).toArray());   // weights by elapsed time

title('Sentinels, where and mask');
const raw = new pd.Series([3, -1, 5, -1, 8]);
console.log(raw.replace(-1, null).toArray());
console.log(raw.where(raw.gt(0), 0).toArray());
console.log(raw.mask(raw.lt(0)).toArray());

title('Nullable dtypes keep integers and booleans with NA');
const units = new pd.Series([3, null, 5], { dtype: 'Int64' });
console.log(units.dtype, units.toArray(), units.sum());
const flag = new pd.Series([true, null, false], { dtype: 'boolean' });
console.log(flag.or(true).toArray(), flag.and(false).toArray()); // Kleene logic
