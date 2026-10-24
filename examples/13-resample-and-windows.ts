// Resampling and moving windows: resample, asfreq, rolling, expanding and ewm.
// Run: node 13-resample-and-windows.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')));
const revenue = sales.setIndex('date').sortIndex().get('revenue');

title('Downsampling with resample');
console.log(revenue.resample('ME').sum());                      // month end, right-closed like pandas
console.log(revenue.resample('MS').agg(['sum', 'count', 'max']));
console.log(revenue.resample('W-MON').sum().head(3));
console.log(revenue.resample('QE').mean().round(2));
console.log(revenue.resample('2W').sum().head(3));
console.log(revenue.resample('ME').ohlc());
console.log(sales.setIndex('date').sortIndex().get(['units', 'revenue']).resample('ME').sum());

title('Bin edges: closed, label, origin and offset');
const hourly = revenue.head(20);
console.log(hourly.resample('D', { closed: 'right', label: 'right' }).sum().head(3));
console.log(hourly.resample('12h', { offset: '6h' }).sum().head(3));
console.log(hourly.resample('3D', { origin: 'epoch' }).sum().head(3));

title('Resampling one column of a frame with on');
console.log(sales.get(['date', 'units']).resample('ME', { on: 'date' }).sum());

title('Upsampling');
const daily = new pd.Series([100, 130, 90], { index: pd.toDatetime(['2024-03-01', '2024-03-03', '2024-03-06']).toArray() as Date[] });
console.log(new pd.DataFrame({
  asfreq: daily.resample('D').asfreq(),
  ffill: daily.resample('D').ffill(),
  nearest: daily.resample('D').nearest(),
  interpolate: daily.resample('D').interpolate().round(1),
}));
console.log(daily.asfreq('D', { method: 'bfill' }).toArray());

title('Rolling windows');
const temps = pd.readCsv(new URL('data/temperatures.csv', import.meta.url), { parseDates: ['time'] });
const roastery = temps.get(temps.get('sensor').eq('roastery')).setIndex('time').get('celsius');
const firstDay = roastery.head(8);
console.log(new pd.DataFrame({
  celsius: firstDay,
  mean3: firstDay.rolling(3).mean().round(2),
  min1: firstDay.rolling(3, { minPeriods: 1 }).min(),
  centered: firstDay.rolling(3, { center: true }).max(),
  std3: firstDay.rolling(3).std().round(3),
}));
console.log(roastery.rolling('6h').mean().round(2).head(4).toArray());          // time-based window
console.log(firstDay.rolling(3, { winType: 'triang' }).mean().round(2).toArray()); // weighted window
console.log(firstDay.rolling(4).quantile(0.5).round(3).toArray());
console.log(firstDay.rolling(3).apply((w) => (w.max() as number) - (w.min() as number)).round(2).toArray());
console.log(firstDay.rolling(3).agg(['mean', 'max']).round(2).head(4));

title('Expanding windows');
console.log(firstDay.expanding().mean().round(2).toArray());
console.log(firstDay.expanding({ minPeriods: 3 }).max().toArray());

title('Exponentially weighted');
console.log(firstDay.ewm({ span: 3 }).mean().round(3).toArray());
console.log(firstDay.ewm({ alpha: 0.5, adjust: false }).mean().round(3).toArray());
console.log(firstDay.ewm({ halflife: 2 }).std().round(3).toArray());

title('Rolling correlation between two sensors');
const storage = temps.get(temps.get('sensor').eq('storage')).setIndex('time').get('celsius');
console.log(roastery.rolling(24).corr(storage).dropna().round(3).head(3).toArray());
