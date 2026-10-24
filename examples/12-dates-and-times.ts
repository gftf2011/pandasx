// Dates and times: parsing, ranges, the .dt accessor, time zones and offsets.
// Run: node 12-dates-and-times.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

title('Parsing with toDatetime');
console.log(pd.toDatetime(['2024-03-15', '2024-03-16 09:30', null]).toArray());
console.log(pd.toDatetime(['15/03/2024 14:05'], { format: '%d/%m/%Y %H:%M' }).toArray());
console.log(pd.toDatetime(['01/02/2024'], { dayfirst: true }).toArray());
console.log(pd.toDatetime([1709251200], { unit: 's' }).toArray());
console.log(pd.toDatetime(['2024-03-01', 'not a date'], { errors: 'coerce' }).toArray());
console.log(pd.toDatetime(['2024-03-01 10:00-03:00'], { utc: true }).toArray());

title('Ranges');
console.log(pd.dateRange('2024-03-01', { periods: 4, freq: 'D' }).dt.date.toArray());
console.log(pd.dateRange('2024-01-01', { end: '2024-06-30', freq: 'ME' }).dt.date.toArray());
console.log(pd.dateRange('2024-03-01', { periods: 3, freq: 'W-MON' }).dt.date.toArray());
console.log(pd.bdateRange('2024-03-01', { periods: 5 }).dt.strftime('%a %d/%m').toArray());
console.log(pd.dateRange('2024-03-01 08:00', { periods: 3, freq: '90min' }).dt.strftime('%H:%M').toArray());
console.log(pd.timedeltaRange('0h', { periods: 3, freq: '8h' }).toArray().map(String));

title('The .dt accessor');
const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
const when = sales.get('date').head(3);
console.log(new pd.DataFrame({
  when,
  year: when.dt.year,
  month: when.dt.month,
  day: when.dt.day,
  hour: when.dt.hour,
  weekday: when.dt.dayName(),
  quarter: when.dt.quarter,
  week: when.dt.isocalendar().get('week'),
}));
console.log(when.dt.monthName('pt-BR').toArray());
console.log(when.dt.strftime('%d/%m/%Y %Hh%M').toArray());
console.log(when.dt.floor('h').toArray(), when.dt.round('15min').toArray());
console.log(when.dt.normalize().toArray());
console.log(when.dt.isMonthStart.toArray(), when.dt.isLeapYear.toArray());
console.log(when.dt.toPeriod('M').toArray().map(String));

title('Date arithmetic');
const opened = pd.toDatetime(['2019-03-01', '2023-09-20']);
const age = pd.toDatetime(['2024-03-01', '2024-03-01']).sub(opened);
console.log(age.toArray().map(String), age.dt.days.toArray());
console.log(opened.add(new pd.Timedelta('30 days')).dt.date.toArray());

title('Calendar offsets');
const d = pd.toDatetime(['2024-01-31', '2024-02-29 10:30']);
console.log(d.add(pd.offsets.MonthEnd()).dt.date.toArray());
console.log(d.add(pd.offsets.MonthBegin()).dt.date.toArray());
console.log(d.sub(pd.offsets.BusinessDay(3)).dt.date.toArray());
console.log(d.add(pd.offsets.DateOffset({ months: 1, days: 1 })).dt.date.toArray());
console.log(d.add(pd.offsets.QuarterEnd()).dt.date.toArray(), d.add(pd.offsets.YearBegin()).dt.date.toArray());
const holidays = pd.offsets.BusinessDay(1, { holidays: ['2024-12-25'] });
console.log(pd.toDatetime(['2024-12-24']).add(holidays).dt.date.toArray());

title('Time zones');
const local = pd.toDatetime(['2024-03-10 01:30', '2024-07-01 12:00']).dt.tzLocalize('America/New_York');
console.log(local);
console.log(local.dt.tzConvert('America/Sao_Paulo'));
console.log(local.dt.tzConvert('Asia/Tokyo').dt.hour.toArray());
console.log(pd.toDatetime(['2024-03-10 02:30']).dt.tzLocalize('America/New_York', { nonexistent: 'shift_forward' }));
console.log(pd.toDatetime(['2024-11-03 01:30']).dt.tzLocalize('America/New_York', { ambiguous: 'latest' }));
console.log(local.dt.tzLocalize(null).toArray());              // back to naive wall time

title('Selecting by time on a datetime index');
const temps = pd.readCsv(new URL('data/temperatures.csv', import.meta.url), { parseDates: ['time'] });
const roastery = temps.get(temps.get('sensor').eq('roastery')).setIndex('time').get('celsius');
console.log(roastery.loc(pd.slice('2024-03-01 06:00', '2024-03-01 09:00')));
console.log(roastery.betweenTime('12:00', '13:00').head(4));
console.log(roastery.atTime('00:00').head(3).toArray());
console.log(roastery.truncate({ before: '2024-03-14' }).length);
console.log(roastery.shift(1, { freq: 'D' }).index.labels[0]);
