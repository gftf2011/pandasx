// Styling: df.style for conditional formatting, exported to HTML, LaTeX and Excel.
// Run: node 18-styling.ts   (open output/styled-report.html in a browser)
import { mkdirSync, writeFileSync } from 'node:fs';
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);
const out = (name: string) => new URL(`output/${name}`, import.meta.url).pathname;
mkdirSync(out(''), { recursive: true });

const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
sales.set('revenue', sales.get('units').mul(sales.get('unit_price')));
const report = sales.groupby('store').agg({ revenue: 'sum', units: 'sum', discount: 'mean' });
report.set('share', report.get('revenue').div(report.get('revenue').sum()));
report.set('growth', new pd.Series([0.12, -0.04, 0.27, null, 0.08], { index: report.index }));

const styler = report.style
  .format({ revenue: 'R$ {:,.2f}', units: '{:,}', discount: '{:.1%}', share: '{:.1%}', growth: '{:+.1%}' }, { naRep: '—' })
  .highlightMax({ subset: ['revenue', 'units'], color: '#d6f5e6' })
  .highlightMin({ subset: ['revenue'], color: '#fde2e1' })
  .highlightNull({ color: '#f5f5f4' })
  .backgroundGradient({ subset: ['share'], cmap: 'Blues' })
  .bar({ subset: ['growth'], align: 'zero', color: ['#f4a3a0', '#9ec5f4'] })
  .map((v) => ((v as number) < 0 ? 'color: #b42318' : null), { subset: ['growth'] })
  .setCaption('Store performance, Q1 2024')
  .setTableStyles([
    { selector: '', props: 'border-collapse: collapse; font: 14px system-ui, sans-serif' },
    { selector: 'th', props: 'padding: 6px 12px; border-bottom: 1px solid #e1e0d9; text-align: left' },
    { selector: 'td', props: 'padding: 6px 12px; border-bottom: 1px solid #e1e0d9; text-align: right' },
    { selector: 'caption', props: 'font-weight: 600; padding-bottom: 8px; text-align: left' },
  ])
  .setUuid('report');

writeFileSync(out('styled-report.html'), styler.toHtml({ doctype: true }));
console.log('wrote output/styled-report.html');

title('Plain-text rendering of the formatted values');
console.log(styler.toString());

title('Python format specs, also usable on their own');
console.log(pd.pyFormat('R$ {:,.2f}', 1234567.891), pd.pyFormat('{:>8}', 'right'), pd.pyFormat('{:.2e}', 0.000123), pd.pyFormat('{:08.3f}', -3.14159));

title('Row-wise and table-wide rules');
const scores = new pd.DataFrame({ jan: [8.2, 6.1, 9.4], feb: [7.9, 8.8, 9.1], mar: [9.0, 5.5, 8.7] }, { index: ['SP01', 'RJ01', 'BH01'] });
const s2 = scores.style
  .highlightMax({ axis: 1, props: 'font-weight: bold' })                    // best month per store
  .highlightBetween({ left: 0, right: 6.5, color: '#fde2e1' })             // below target
  .highlightQuantile({ axis: null, qLeft: 0.8, color: '#d6f5e6' })         // top 20% overall
  .textGradient({ cmap: 'Greens', subset: ['mar'] })
  .apply((col: pd.Series) => col.toArray().map((v) => ((v as number) > 9 ? 'text-decoration: underline' : '')), { axis: 0 });
console.log(s2.cellStyle(0, 2), '|', s2.cellStyle(1, 2));

title('Hiding and LaTeX export');
console.log(scores.style.format('{:.1f}').hide({ axis: 'index' }).toString());
console.log(scores.style.format('{:.1f}').highlightMax({ axis: 0, props: 'font-weight: bold' }).toLatex({ hrules: true, caption: 'Customer satisfaction' }));

title('Excel export keeps colors and number formats');
await styler.toExcel(out('styled-report.xlsx'));
console.log('wrote output/styled-report.xlsx');
