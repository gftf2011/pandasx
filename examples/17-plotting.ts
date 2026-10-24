// Plotting: SVG charts with no dependencies (open the files in ./output in a browser).
// Run: node 17-plotting.ts
import { mkdirSync } from 'node:fs';
import * as pd from 'pandasx';

const out = (name: string) => new URL(`output/${name}`, import.meta.url).pathname;
mkdirSync(out(''), { recursive: true });
const written: string[] = [];
const save = (name: string) => { written.push(name); return out(name); };

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')));
const temps = pd.readCsv(new URL('data/temperatures.csv', import.meta.url), { parseDates: ['time'] });

// Line: one series per sensor, daily mean
const daily = pd.pivotTable(temps, { index: 'time', columns: 'sensor', values: 'celsius', aggfunc: 'mean' }).resample('D').mean();
daily.plot.line({ title: 'Daily mean temperature', ylabel: '°C', path: save('line.svg') });

// Area, stacked: weekly revenue per category
const weekly = pd.pivotTable(sales, { index: 'date', columns: 'category', values: 'revenue', aggfunc: 'sum', fillValue: 0 }).resample('W').sum();
weekly.plot.area({ stacked: true, title: 'Weekly revenue by category', path: save('area.svg') });

// Bars: grouped, stacked and horizontal
const byStore = pd.pivotTable(sales, { index: 'store', columns: 'category', values: 'revenue', aggfunc: 'sum' });
byStore.plot.bar({ title: 'Revenue by store and category', ylabel: 'R$', path: save('bar.svg') });
byStore.plot.bar({ stacked: true, title: 'Revenue by store (stacked)', path: save('bar-stacked.svg') });
sales.groupby('product').get('units').sum().sortValues().plot.barh({ title: 'Units sold by product', path: save('barh.svg') });

// Distributions
const ticket = sales.get('revenue').rename('ticket');
ticket.plot.hist({ bins: 15, title: 'Ticket size', xlabel: 'R$', path: save('hist.svg') });
ticket.plot.kde({ title: 'Ticket size density', path: save('kde.svg') });
pd.pivotTable(sales.assign({ row: (d) => new pd.Series(Array.from({ length: d.length }, (_, i) => i)) }),
  { index: 'row', columns: 'store', values: 'revenue', aggfunc: 'sum' })
  .plot.box({ title: 'Ticket size by store', path: save('box.svg') });

// Relationships
sales.plot.scatter({ x: 'units', y: 'revenue', c: 'unit_price', title: 'Revenue vs units (colour: price)', path: save('scatter.svg') });
const pivot = pd.pivotTable(temps, { index: 'time', columns: 'sensor', values: 'celsius', aggfunc: 'mean' });
pivot.plot.hexbin({ x: 'roastery', y: 'storage', gridsize: 12, title: 'Roastery vs storage', path: save('hexbin.svg') });

// Parts of a whole
sales.get('payment').valueCounts().plot.pie({ title: 'Payment methods', path: save('pie.svg') });

// Small multiples instead of a second y axis
pd.pivotTable(sales, { index: 'date', values: ['units', 'revenue'], aggfunc: 'sum' }).resample('W').sum()
  .plot({ subplots: true, layoutColumns: 2, title: 'Weekly units and revenue', path: save('subplots.svg') });

// HTML page with the chart and its data table; forced dark theme
byStore.round(0).plot.bar({ title: 'Revenue by store', theme: 'dark', path: save('bar-with-table.html') });

// The return value is the SVG markup, ready for a web response
const svg = byStore.plot.bar({ width: 480, height: 280 });
console.log(svg.slice(0, 80) + '…');
console.log('written to ./output:', written.join(', '));
