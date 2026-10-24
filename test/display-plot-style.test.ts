// Expected strings for to_latex / to_markdown / Styler / wide frames come from pandas 3.1.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pd from '../src/index.ts';
import { DataFrame, Series } from '../src/index.ts';

const small = () => new DataFrame({ a: [1, 2], b: [1.5, NaN], c: ['x', 'y'] });

describe('display options', () => {
  it('formats a datetime index uniformly: midnight shows its time when others have one', () => {
    const s = new Series([0, 1], { index: pd.dateRange('2024-02-28 23:00', { periods: 2, freq: 'h' }).toArray() as Date[] });
    assert.equal(s.toString(), '2024-02-28 23:00:00  0\n2024-02-29 00:00:00  1\ndtype: int64');
    const days = new Series([1, 2], { index: pd.dateRange('2024-03-01', { periods: 2 }).toArray() as Date[] });
    assert.equal(days.toString(), '2024-03-01  1\n2024-03-02  2\ndtype: int64');
  });
  it('hides middle columns to fit display.width, like pandas', () => {
    const w = new DataFrame(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`col_${i}`, [i * 1000.5, (i + 15) * 1000.5]])));
    assert.equal(w.toString(), [
      '     col_0    col_1    col_2    col_3  ...   col_11   col_12   col_13   col_14',
      '0      0.0   1000.5   2001.0   3001.5  ...  11005.5  12006.0  13006.5  14007.0',
      '1  15007.5  16008.0  17008.5  18009.0  ...  26013.0  27013.5  28014.0  29014.5',
      '',
      '[2 rows x 15 columns]',
    ].join('\n'));
  });
  it('setOption / optionContext / resetOption', () => {
    const s = new Series([1.23456, 2]);
    assert.equal(pd.optionContext({ 'display.precision': 2 }, () => s.toString()), '0  1.23\n1  2.00\ndtype: float64');
    assert.equal(pd.getOption('display.precision'), 6);
    pd.setOption('display.max_colwidth', 6);
    assert.ok(new Series(['abcdefghij']).toString().startsWith('0  abc...'));
    pd.resetOption('display.max_colwidth');
    pd.setOption('display.max_rows', 4);
    assert.ok(new Series(Array.from({ length: 10 }, (_, i) => i)).toString().includes('...'));
    pd.resetOption('all');
    assert.equal(pd.getOption('display.max_rows'), 60);
    assert.throws(() => pd.setOption('display.nope', 1), /No such option/);
  });
  it('toString options', () => {
    assert.equal(small().toString({ index: false, naRep: '-' }), ' a   b c\n 1 1.5 x\n 2   - y'); // pandas index=False layout
    // toString(options) is to_string(): never truncated unless asked; toString() is repr.
    const wide = new DataFrame(Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((c) => [c, [1.5, 2.25]])));
    assert.ok(wide.toString().includes('...'));
    assert.ok(!wide.toString({ header: false }).includes('...'));
    assert.ok(wide.toString({ lineWidth: 40 }).includes('...'));
    assert.equal(pd.optionContext({ 'display.chop_threshold': 0.01 }, () => new Series([1e-4, 0.5, -1e-5]).toString()), '0  0.0\n1  0.5\n2  0.0\ndtype: float64');
  });
});

describe('text exports', () => {
  it('toLatex', () => {
    assert.equal(small().toLatex(), '\\begin{tabular}{lrrl}\n\\toprule\n & a & b & c \\\\\n\\midrule\n0 & 1 & 1.500000 & x \\\\\n1 & 2 & NaN & y \\\\\n\\bottomrule\n\\end{tabular}\n');
  });
  it('toMarkdown', () => {
    assert.equal(small().toMarkdown(), '|    |   a |     b | c   |\n|---:|----:|------:|:----|\n|  0 |   1 |   1.5 | x   |\n|  1 |   2 | nan   | y   |');
    assert.equal(small().toMarkdown({ index: false }), '|   a |     b | c   |\n|----:|------:|:----|\n|   1 |   1.5 | x   |\n|   2 | nan   | y   |');
  });
  it('Python format specs', () => {
    assert.equal(pd.pyFormat('R$ {:,.2f}', -1234.5), 'R$ -1,234.50');
    assert.equal(pd.pyFormat('{:.1%}', 0.1234), '12.3%');
    assert.equal(pd.pyFormat('{:08.3f}', -3.14159), '-003.142');
    // Exact ties round half to even, like Python (JavaScript's toFixed rounds them up).
    const ties: [number, string, string][] = [[8.25, '.1f', '8.2'], [0.125, '.2f', '0.12'], [2.5, '.0f', '2'], [3.5, '.0f', '4'], [0.375, '.2f', '0.38'], [12.345, '.2f', '12.35'], [0.00125, '.1%', '0.1%']];
    for (const [v, spec, want] of ties) assert.equal(pd.formatSpec(v, spec), want, `${v}:${spec}`);
    assert.equal(pd.pyFormat('{:^9}', 'mid'), '   mid   ');
    assert.equal(pd.pyFormat('{:.3g}', 0.000012345), '1.23e-05');
  });
  it('memoryUsage and info', () => {
    assert.deepEqual(small().memoryUsage().toArray(), [132, 16, 16, 16]);
    assert.ok(small().info().endsWith('memory usage: 180.0+ bytes'));
  });
});

describe('Styler', () => {
  it('toString / toLatex honour hidden index, header and rows', () => {
    const d = new pd.DataFrame({ jan: [8.2, 6.1], feb: [7.9, 8.8] }, { index: ['SP01', 'RJ01'] });
    assert.equal(d.style.format('{:.1f}').hide({ axis: 'index' }).toString(), 'jan feb\n8.2 7.9\n6.1 8.8\n');
    assert.equal(d.style.hide({ axis: 'columns' }).toString(), 'SP01 8.200000 7.900000\nRJ01 6.100000 8.800000\n');
    assert.match(d.style.hide({ subset: ['SP01'] }).toLatex(), /\n & jan & feb \\\\\nRJ01 & 6\.100000/);
  });
  it('table-wide rules (axis: null) for highlightQuantile and bar, like pandas axis=None', () => {
    const d = new pd.DataFrame({ jan: [8.2, 6.1, 9.4], feb: [7.9, 8.8, 9.1], mar: [9.0, 5.5, 8.7] });
    const q = d.style.highlightQuantile({ axis: null, qLeft: 0.8, color: 'g' });
    const hits: number[][] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (q.cellStyle(i, j).length) hits.push([i, j]);
    assert.deepEqual(hits, [[2, 0], [2, 1]]);
    const b = new pd.DataFrame({ a: [1, 2, 3], b: [10, 20, 30] }).style.bar({ axis: null });
    assert.match(b.cellStyle(2, 0)[1], /6\.9%\)$/);       // 3 on a shared 1..30 scale
    assert.match(b.cellStyle(2, 1)[1], /100\.0%\)$/);
  });
  it('renders pandas markup', () => {
    const html = small().style.setUuid('44c45').highlightMax({ subset: ['a'] }).format({ b: '{:.2f}' }).setCaption('Cap').toHtml();
    assert.ok(html.startsWith('<style type="text/css">\n#T_44c45_row1_col0 {\n  background-color: yellow;\n}\n</style>\n<table id="T_44c45">\n  <caption>Cap</caption>'));
    assert.ok(html.includes('<td id="T_44c45_row0_col1" class="data row0 col1" >1.50</td>'));
    assert.ok(html.includes('<td id="T_44c45_row1_col1" class="data row1 col1" >nan</td>'));
  });
  it('gradients, bars, nulls, apply and hide', () => {
    const df = new DataFrame({ x: [1, 5, 10], y: [3, null, 1] });
    const st = df.style.backgroundGradient({ subset: ['x'] }).highlightNull().bar({ subset: ['y'] });
    assert.deepEqual(st.cellStyle(0, 0), ['background-color: #f7fbff', 'color: #000000']);
    assert.deepEqual(st.cellStyle(2, 0), ['background-color: #0d366b', 'color: #f1f1f1']);
    assert.deepEqual(st.cellStyle(1, 1), ['background-color: red']);
    assert.match(st.cellStyle(0, 1).join(';'), /linear-gradient\(90deg/);
    const rows = df.style.apply((r: Series) => r.toArray().map((v) => ((v as number) > 4 ? 'font-weight: bold' : null)), { axis: 1 });
    assert.deepEqual(rows.cellStyle(1, 0), ['font-weight: bold']);
    const hidden = df.style.hide().hide({ axis: 'columns', subset: ['y'] }).toHtml();
    assert.ok(!hidden.includes('row_heading') && !hidden.includes('col1'));
  });
});

describe('plots', () => {
  const ts = new DataFrame({ receita: [10, 12, 9, 14], custo: [7, 8, 8, 9] }, { index: pd.dateRange('2024-01-01', { periods: 4 }).toArray() as Date[] });
  const parse = (svg: string) => ({
    paths: (svg.match(/<path class="mark"/g) ?? []).length,
    circles: (svg.match(/<circle/g) ?? []).length,
    titles: (svg.match(/<title[ >]/g) ?? []).length,
  });
  it('line chart: accessible SVG, palette slots, legend, end labels, tooltips', () => {
    const svg = ts.plot({ title: 'Receita' });
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.includes('role="img"'));
    assert.match(svg, /--s1:#2a78d6/);
    assert.match(svg, /prefers-color-scheme: dark/);
    assert.equal(parse(svg).paths, 2);
    assert.ok(svg.includes('>receita</text>') && svg.includes('stroke-width="2"'));
    assert.ok(parse(svg).titles >= 4 + 1);
  });
  it('every kind renders', () => {
    const x = Array.from({ length: 50 }, (_, i) => i / 5);
    const sc = new DataFrame({ x, y: x.map((v) => v * 2 + Math.sin(v)), z: x.map((v) => v * v) });
    const cat = new DataFrame({ k: ['a', 'b', 'c'], v: [3, 5, 2], w: [1, 2, 3] }).setIndex('k');
    for (const svg of [cat.plot.bar(), cat.plot.barh(), cat.plot.bar({ stacked: true }), sc.plot.hist({ y: ['x', 'y'] }), sc.plot.box(), sc.plot.kde({ y: 'x' }),
      ts.plot.area(), cat.plot.pie({ y: 'v' }), sc.plot.scatter({ x: 'x', y: 'y', c: 'z' }), sc.plot.hexbin({ x: 'x', y: 'y' }), ts.plot({ subplots: true }), cat.get('v').plot.bar()]) {
      assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>') && !svg.includes('NaN'), svg.slice(0, 80));
    }
  });
  it('never cycles colours: > 8 series must be reduced or split', () => {
    const many = new DataFrame(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, [1, 2, 3]])));
    assert.throws(() => many.plot(), /subplots/);
    assert.ok(many.plot({ subplots: true }).startsWith('<svg'));
    const pie = new DataFrame({ v: Array.from({ length: 12 }, (_, i) => i + 1) }).plot.pie({ y: 'v' });
    assert.ok(pie.includes('Other'));
  });
  it('writes SVG or an HTML page with the data table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'np-plot-'));
    ts.plot({ path: join(dir, 'a.svg') });
    ts.plot.bar({ path: join(dir, 'a.html'), title: 'T' });
    assert.ok(readFileSync(join(dir, 'a.svg'), 'utf8').startsWith('<svg'));
    const html = readFileSync(join(dir, 'a.html'), 'utf8');
    assert.ok(html.includes('<details><summary>Data table</summary>') && html.includes('<table'));
  });
});
