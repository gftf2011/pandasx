// End to end: clean raw sales, enrich them, analyse and export a report (CSV, Excel, HTML chart).
// Run: node 20-sales-report.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import * as pd from 'pandasx';

const step = (t: string) => console.log(`\n▶ ${t}`);
const out = (name: string) => new URL(`output/${name}`, import.meta.url).pathname;
mkdirSync(out(''), { recursive: true });

step('1. Load');
const raw = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'], dtype: { category: 'category' } });
const stores = pd.readJson(new URL('data/stores.json', import.meta.url), { convertDates: ['opened'] });
console.log(raw.shape, 'sales rows;', stores.length, 'stores');

step('2. Clean');
const sales = raw
  .fillna({ discount: 0, payment: 'unknown' })
  .assign({
    revenue: (d) => d.get('units').mul(d.get('unit_price')).mul(d.get('discount').rsub(1)).round(2),
    month: (d) => d.get('date').dt.toPeriod('M'),
    weekday: (d) => d.get('date').dt.dayName(),
    hour: (d) => d.get('date').dt.hour,
  });
console.log('missing values left:', sales.isna().sum().sum());

step('3. Enrich with store data');
const enriched = sales.merge(stores.get(['store', 'city', 'state', 'area_m2']), { on: 'store', how: 'left', validate: 'm:1' });
console.log(enriched.get(['date', 'city', 'product', 'revenue']).head(3));

step('4. KPIs per store');
const kpis = enriched.groupby(['store', 'city']).agg({
  revenue: ['revenue', 'sum'],
  tickets: ['revenue', 'count'],
  avg_ticket: ['revenue', 'mean'],
  units: ['units', 'sum'],
  area_m2: ['area_m2', 'first'],
});
kpis.set('revenue_per_m2', kpis.get('revenue').div(kpis.get('area_m2')));
kpis.set('rank', kpis.get('revenue').rank({ ascending: false, method: 'min' }).astype('int64'));
console.log(kpis.sortValues('rank').round(2));

step('5. Monthly trend and growth');
const monthly = pd.pivotTable(enriched, { index: 'month', columns: 'store', values: 'revenue', aggfunc: 'sum' });
console.log(monthly.round(0));
console.log('month-over-month growth (%):');
console.log(monthly.pctChange().mul(100).round(1).dropna({ how: 'all' }));

step('6. Best sellers and peak hours');
console.log(enriched.groupby('product').get('revenue').sum().nlargest(3).round(2));
const byHour = enriched.groupby(pd.cut(enriched.get('hour'), [6, 10, 14, 18, 22], { labels: ['morning', 'midday', 'afternoon', 'evening'] })).get('revenue').sum();
console.log(byHour.round(2));
console.log(pd.crosstab(enriched.get('weekday'), enriched.get('category'), { normalize: 'index' }).round(2));

step('7. Export');
kpis.round(2).toCsv(out('kpis.csv'));
await new pd.ExcelWriter(out('sales-report.xlsx'))
  .write(kpis.round(2), { sheetName: 'KPIs' })
  .write(monthly.round(2), { sheetName: 'Monthly' })
  .write(enriched.drop(['month']), { sheetName: 'Data', index: false })
  .close();
monthly.plot.line({ title: 'Monthly revenue by store', ylabel: 'R$', path: out('monthly-revenue.html') });
writeFileSync(out('kpis.html'), kpis.round(2).style.format({ revenue: 'R$ {:,.2f}', avg_ticket: 'R$ {:,.2f}', revenue_per_m2: '{:.1f}' }).highlightMax({ subset: ['revenue'], color: '#d6f5e6' }).toHtml({ doctype: true }));
console.log('wrote output/kpis.csv, output/sales-report.xlsx, output/monthly-revenue.html, output/kpis.html');
