// Dtypes: inference, conversion, nullable types, big integers, durations and periods.
// Run: node 08-dtypes.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

title('Inference');
console.log(new pd.Series([1, 2, 3]).dtype);                // int64
console.log(new pd.Series([1, null]).dtype);                // float64 (NA forces float, like NumPy)
console.log(new pd.Series([true, false]).dtype);            // bool
console.log(new pd.Series(['a', null]).dtype);              // string
console.log(new pd.Series([new Date('2024-03-01')]).dtype); // datetime
console.log(new pd.Series([{ any: 'object' }]).dtype);      // object

title('astype');
const raw = new pd.Series(['1', '2', '3']);
console.log(raw.astype('int64').sum());
console.log(new pd.Series([1.9, -1.9]).astype('int64').toArray());          // truncates toward zero
console.log(new pd.Series([0, 1, 2]).astype('bool').toArray());
console.log(new pd.Series(['2024-03-01', '2024-03-15']).astype('datetime').toArray());
console.log(new pd.DataFrame({ a: ['1', '2'], b: ['x', 'y'] }).astype({ a: 'float64' }).dtypes.toArray());

title('Nullable dtypes: Int64, Float64, boolean');
const df = new pd.DataFrame({ n: [1, null, 3], x: [1.5, null, 2.5], ok: [true, null, false], s: ['a', null, 'c'] });
console.log(df.dtypes.toArray());
const converted = df.convertDtypes();                       // best nullable dtype per column
console.log(converted.dtypes.toArray());
console.log(converted.get('n').toArray(), converted.get('n').add(1).toArray());
console.log(converted.get('ok').and(true).toArray());       // Kleene logic: true & NA = NA

title('bigint: exact integers beyond 2^53');
const ids = new pd.Series([9007199254740993n, 9007199254740995n]);
console.log(ids.dtype, ids.add(1n).toArray(), ids.max());

title('Timedelta');
const t = new pd.Timedelta('1 days 02:30:00');
console.log(String(t), t.totalSeconds(), t.isoformat());
const durations = pd.toTimedelta(['15min', '1h30min', '2 days', null]);
console.log(durations.dtype, durations.toArray().map(String));
console.log(durations.dt.totalSeconds().toArray(), String(durations.sum()));

title('Period');
const quarter = new pd.Period('2024-02-15', 'Q');
console.log(String(quarter), String(quarter.add(1)));
const months = pd.periodRange('2024-01', { periods: 3, freq: 'M' });
console.log(months.dtype, months.toArray().map(String), months.dt.startTime.toArray());

title('Memory usage');
const big = new pd.DataFrame({ id: Array.from({ length: 1000 }, (_, i) => i), store: Array.from({ length: 1000 }, (_, i) => `store-${i % 5}`) });
console.log(big.memoryUsage({ deep: true }));
console.log(big.astype({ store: 'category' }).memoryUsage({ deep: true }));
