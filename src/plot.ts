/**
 * Plotting to SVG (no dependencies), like `df.plot(...)` / `df.plot.bar(...)`.
 *
 * Charts follow a fixed visual system: a validated colour-blind-safe categorical
 * palette assigned in order (never cycled), light and dark themes via CSS
 * custom properties, hairline recessive grid, 2px lines, <= 24px bars with
 * rounded data ends and 2px surface gaps, >= 8px dots with a surface ring,
 * a legend for two or more series plus selective direct labels, and native
 * per-mark tooltips (<title>). There is deliberately no secondary y axis.
 */
import { writeFileSync } from 'node:fs';
import { quantile } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { isNumericDType } from './core/types.ts';
import { escapeXml } from './io/markup.ts';
import { renderHtml } from './io/html.ts';
import { DataFrame } from './frame.ts';
import { numericView, Series } from './series.ts';

export type PlotKind = 'line' | 'bar' | 'barh' | 'hist' | 'box' | 'kde' | 'density' | 'area' | 'pie' | 'scatter' | 'hexbin';

export interface PlotOptions {
  kind?: PlotKind;
  /** Column for the x axis (default: the index). */
  x?: string;
  /** Column(s) to plot (default: all numeric columns). */
  y?: string | readonly string[];
  title?: string;
  xlabel?: string;
  ylabel?: string;
  width?: number;
  height?: number;
  /** Show the legend (default: when there are two or more series). */
  legend?: boolean;
  /** Horizontal gridlines (default true). */
  grid?: boolean;
  /** Stack bars / areas. */
  stacked?: boolean;
  /** Histogram bins (default 10). */
  bins?: number;
  logy?: boolean;
  xlim?: [number, number];
  ylim?: [number, number];
  /** One small chart per series instead of one chart with many. */
  subplots?: boolean;
  /** Columns of the subplot grid. */
  layoutColumns?: number;
  /** 'auto' follows the viewer's colour scheme (default); force 'light' or 'dark'. */
  theme?: 'auto' | 'light' | 'dark';
  /** Scatter: column whose values colour the dots (sequential blue). */
  c?: string;
  /** Scatter: dot radius (default 4). */
  s?: number;
  /** Hexbin grid size (default 20). */
  gridsize?: number;
  /** Write the result to this path (.svg, or .html with a data table). */
  path?: string;
}

// ------------------------------------------------------------------ palette

const LIGHT = {
  surface: '#fcfcfb', primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
};
const DARK = {
  surface: '#1a1a19', primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const MAX_SERIES = LIGHT.series.length;

function vars(t: typeof LIGHT): string {
  return [`--surface:${t.surface}`, `--ink:${t.primary}`, `--ink-2:${t.secondary}`, `--muted:${t.muted}`, `--grid:${t.grid}`, `--axis:${t.axis}`,
    ...t.series.map((c, i) => `--s${i + 1}:${c}`)].join(';');
}

function styleBlock(cls: string, theme: PlotOptions['theme']): string {
  const base = `.${cls}{${vars(theme === 'dark' ? DARK : LIGHT)}}`;
  const dark = theme === 'auto' || theme === undefined
    ? `@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .${cls}{${vars(DARK)}}}:root[data-theme="dark"] .${cls}{${vars(DARK)}}`
    : '';
  return `<style>${base}${dark}.${cls} text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink-2);font-size:12px}`
    + `.${cls} .title{fill:var(--ink);font-size:15px;font-weight:600}.${cls} .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}`
    + `.${cls} .grid{stroke:var(--grid);stroke-width:1}.${cls} .axis{stroke:var(--axis);stroke-width:1}.${cls} .label{fill:var(--ink-2)}`
    + `.${cls} .hit{fill:transparent}.${cls} .hit:hover+*,.${cls} .mark:hover{opacity:.85}</style>`;
}

const color = (i: number) => `var(--s${i + 1})`;

// ------------------------------------------------------------------- scales

function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
}

/** Ticks covering [min, max] that start and end on round values (the domain expands to them). */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.floor(min / step + 1e-9) * step; v <= Math.ceil(max / step - 1e-9) * step + step * 1e-9; v += step) out.push(Number((Math.round(v / step) * step).toPrecision(12)));
  return out;
}

/** 1,284 → 1.3K; keeps small numbers readable. */
export function compact(v: number): string {
  const a = Math.abs(v);
  const trim = (x: number) => String(Number(x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)));
  if (a >= 1e12) return trim(v / 1e12) + 'T';
  if (a >= 1e9) return trim(v / 1e9) + 'B';
  if (a >= 1e6) return trim(v / 1e6) + 'M';
  if (a >= 1e3) return trim(v / 1e3) + 'K';
  if (a < 1e-3) return '0';
  return String(Number(v.toPrecision(4)));
}

interface Scale { map(v: number): number; ticks: number[]; fmt(v: number): string }

function linear(domain: [number, number], range: [number, number], opts: { nice?: boolean; log?: boolean; zero?: boolean; count?: number } = {}): Scale {
  let [d0, d1] = domain;
  if (opts.zero) { d0 = Math.min(0, d0); d1 = Math.max(0, d1); }
  if (opts.log) {
    const l0 = Math.floor(Math.log10(Math.max(d0, 1e-12))), l1 = Math.ceil(Math.log10(Math.max(d1, 1e-12)));
    const ticks = Array.from({ length: l1 - l0 + 1 }, (_, k) => 10 ** (l0 + k));
    const map = (v: number) => range[0] + ((Math.log10(Math.max(v, 1e-12)) - l0) / Math.max(1e-9, l1 - l0)) * (range[1] - range[0]);
    return { map, ticks, fmt: compact };
  }
  const ticks = opts.nice === false ? [d0, d1] : niceTicks(d0, d1, opts.count ?? 5);
  if (opts.nice !== false) { d0 = Math.min(d0, ticks[0]); d1 = Math.max(d1, ticks[ticks.length - 1]); }
  const span = d1 - d0 || 1;
  return { map: (v) => range[0] + ((v - d0) / span) * (range[1] - range[0]), ticks: ticks.filter((t) => t >= d0 - 1e-9 && t <= d1 + 1e-9), fmt: compact };
}

const TIME_STEPS: [number, (d: Date) => string][] = [
  [1000, (d) => d.toISOString().slice(11, 19)], [60_000, (d) => d.toISOString().slice(11, 16)], [3_600_000, (d) => d.toISOString().slice(11, 16)],
  [86_400_000, (d) => d.toISOString().slice(5, 10)], [7 * 86_400_000, (d) => d.toISOString().slice(5, 10)],
  [30 * 86_400_000, (d) => d.toISOString().slice(0, 7)], [365 * 86_400_000, (d) => d.toISOString().slice(0, 4)],
];

function timeScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const span = d1 - d0 || 1;
  const target = span / 5;
  const [step, fmt] = TIME_STEPS.find(([s]) => s * 4 >= target) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const mult = Math.max(1, Math.round(target / step));
  const ticks: number[] = [];
  if (step >= 30 * 86_400_000) {
    const months = step >= 365 * 86_400_000 ? 12 * mult : mult;
    const s = new Date(d0);
    let t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + (s.getUTCDate() > 1 ? 1 : 0), 1);
    while (t <= d1) { if (t >= d0) ticks.push(t); const x = new Date(t); t = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + months, 1); }
  } else {
    for (let t = Math.ceil(d0 / (step * mult)) * step * mult; t <= d1; t += step * mult) ticks.push(t);
  }
  return { map: (v) => range[0] + ((v - d0) / span) * (range[1] - range[0]), ticks, fmt: (v) => fmt(new Date(v)) };
}

// --------------------------------------------------------------------- data

interface SeriesData { name: string; values: Float64Array }
interface PlotData { x: { values: unknown[]; kind: 'number' | 'time' | 'category'; name: string | null }; series: SeriesData[] }

function plotData(target: DataFrame | Series, o: PlotOptions): PlotData {
  const df = target instanceof Series ? target.toFrame(target.name ?? 'value') : target;
  let names: string[];
  if (o.y !== undefined) names = typeof o.y === 'string' ? [o.y] : [...o.y];
  else names = df.columns.filter((c) => c !== o.x && isNumericDType(df._column(c).dtype));
  if (names.length === 0) throw new TypeError('no numeric data to plot');
  const series = names.map((n) => ({ name: n, values: Float64Array.from(numericView(df._column(n), 'plotting')) }));
  let xs: unknown[];
  let xname: string | null;
  if (o.x !== undefined) { xs = df._column(o.x).toArray(); xname = o.x; }
  else { xs = df.index.labels.map((l) => (Array.isArray(l) ? l.join(', ') : l)); xname = df.index.name; }
  const kind = xs.every((v) => v instanceof Date || v === null) ? 'time' : xs.every((v) => typeof v === 'number') ? 'number' : 'category';
  return { x: { values: xs, kind, name: xname }, series };
}

const finite = (a: ArrayLike<number>) => Array.from(a).filter((v) => Number.isFinite(v));
const xNum = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
const labelOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v));
const f2 = (n: number) => Number(n.toFixed(2));

// --------------------------------------------------------------- rendering

interface Frame { W: number; H: number; left: number; right: number; top: number; bottom: number }

let uid = 0;

class Svg {
  readonly parts: string[] = [];
  readonly cls = `npviz${(uid++).toString(36)}`;
  readonly f: Frame;
  private readonly o: PlotOptions;
  private readonly title: string;
  private readonly desc: string;

  constructor(o: PlotOptions, f: Frame, title: string, desc: string) {
    this.o = o;
    this.f = f;
    this.title = title;
    this.desc = desc;
  }

  add(s: string): void { this.parts.push(s); }

  text(x: number, y: number, s: string, attrs = ''): void {
    this.add(`<text x="${f2(x)}" y="${f2(y)}"${attrs}>${escapeXml(s)}</text>`);
  }

  toString(): string {
    const { W, H } = this.f;
    const id = this.cls;
    return `<svg xmlns="http://www.w3.org/2000/svg" class="${id}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="${id}-t ${id}-d">`
      + `<title id="${id}-t">${escapeXml(this.title)}</title><desc id="${id}-d">${escapeXml(this.desc)}</desc>`
      + styleBlock(id, this.o.theme)
      + `<rect width="${W}" height="${H}" fill="var(--surface)"/>`
      + this.parts.join('') + '</svg>';
  }
}

/** Title + legend row; returns the y where the plot area starts. */
function header(svg: Svg, o: PlotOptions, names: readonly string[], key: 'line' | 'swatch' | 'dot'): number {
  let y = 14;
  if (o.title) { svg.text(svg.f.left, 24, o.title, ' class="title"'); y = 40; }
  const show = o.legend ?? names.length >= 2;
  if (show) {
    let x = svg.f.left;
    names.forEach((n, i) => {
      const w = 22 + n.length * 7;
      if (x + w > svg.f.W - svg.f.right && x > svg.f.left) { x = svg.f.left; y += 18; }
      const cy = y + 8;
      if (key === 'line') svg.add(`<line x1="${x}" y1="${cy}" x2="${x + 14}" y2="${cy}" stroke="${color(i)}" stroke-width="2" stroke-linecap="round"/>`);
      else if (key === 'dot') svg.add(`<circle cx="${x + 5}" cy="${cy}" r="4" fill="${color(i)}"/>`);
      else svg.add(`<rect x="${x}" y="${cy - 5}" width="10" height="10" rx="2" fill="${color(i)}"/>`);
      svg.text(x + (key === 'line' ? 19 : 15), cy + 4, n, ' class="label"');
      x += w + 12;
    });
    y += 26;
  }
  return y + 4;
}

function yAxis(svg: Svg, scale: Scale, x0: number, x1: number, grid: boolean, label?: string): void {
  for (const t of scale.ticks) {
    const y = scale.map(t);
    if (grid) svg.add(`<line class="grid" x1="${x0}" x2="${x1}" y1="${f2(y)}" y2="${f2(y)}"/>`);
    svg.text(x0 - 8, y + 4, scale.fmt(t), ' class="tick" text-anchor="end"');
  }
  if (label) svg.add(`<text class="label" transform="translate(14 ${f2((scale.map(scale.ticks[0]) + scale.map(scale.ticks[scale.ticks.length - 1])) / 2)}) rotate(-90)" text-anchor="middle">${escapeXml(label)}</text>`);
}

function xAxisTicks(svg: Svg, scale: Scale, y: number, label?: string): void {
  svg.add(`<line class="axis" x1="${svg.f.left}" x2="${svg.f.W - svg.f.right}" y1="${f2(y)}" y2="${f2(y)}"/>`);
  let lastEnd = -Infinity;
  for (const t of scale.ticks) {
    const x = scale.map(t);
    const s = scale.fmt(t);
    if (x - s.length * 3.3 < lastEnd + 6) continue;
    svg.text(x, y + 16, s, ' class="tick" text-anchor="middle"');
    lastEnd = x + s.length * 3.3;
  }
  if (label) svg.text((svg.f.left + svg.f.W - svg.f.right) / 2, svg.f.H - 6, label, ' class="label" text-anchor="middle"');
}

function categoryAxis(svg: Svg, cats: readonly string[], center: (i: number) => number, y: number, label?: string): void {
  svg.add(`<line class="axis" x1="${svg.f.left}" x2="${svg.f.W - svg.f.right}" y1="${f2(y)}" y2="${f2(y)}"/>`);
  const room = (svg.f.W - svg.f.left - svg.f.right) / Math.max(1, cats.length);
  const every = Math.max(1, Math.ceil((Math.max(...cats.map((c) => c.length)) * 6.6 + 8) / room));
  cats.forEach((c, i) => { if (i % every === 0) svg.text(center(i), y + 16, c.length > 16 ? c.slice(0, 15) + '…' : c, ' class="tick" text-anchor="middle"'); });
  if (label) svg.text((svg.f.left + svg.f.W - svg.f.right) / 2, svg.f.H - 6, label, ' class="label" text-anchor="middle"');
}

/** Bar path with a 4px rounded data end and a square baseline. */
function barPath(x: number, y: number, w: number, h: number, orient: 'up' | 'down' | 'right' | 'left'): string {
  const r = Math.min(4, Math.abs(orient === 'up' || orient === 'down' ? h : w) / 2, Math.abs(orient === 'up' || orient === 'down' ? w : h) / 2);
  const [X, Y, Wd, Ht] = [x, y, w, h].map(f2);
  switch (orient) {
    case 'up': return `M${X},${f2(Y + Ht)}V${f2(Y + r)}Q${X},${Y} ${f2(X + r)},${Y}H${f2(X + Wd - r)}Q${f2(X + Wd)},${Y} ${f2(X + Wd)},${f2(Y + r)}V${f2(Y + Ht)}Z`;
    case 'down': return `M${X},${Y}V${f2(Y + Ht - r)}Q${X},${f2(Y + Ht)} ${f2(X + r)},${f2(Y + Ht)}H${f2(X + Wd - r)}Q${f2(X + Wd)},${f2(Y + Ht)} ${f2(X + Wd)},${f2(Y + Ht - r)}V${Y}Z`;
    case 'right': return `M${X},${Y}H${f2(X + Wd - r)}Q${f2(X + Wd)},${Y} ${f2(X + Wd)},${f2(Y + r)}V${f2(Y + Ht - r)}Q${f2(X + Wd)},${f2(Y + Ht)} ${f2(X + Wd - r)},${f2(Y + Ht)}H${X}Z`;
    default: return `M${f2(X + Wd)},${Y}H${f2(X + r)}Q${X},${Y} ${X},${f2(Y + r)}V${f2(Y + Ht - r)}Q${X},${f2(Y + Ht)} ${f2(X + r)},${f2(Y + Ht)}H${f2(X + Wd)}Z`;
  }
}

function checkSeriesCount(n: number, kind: string): void {
  if (n > MAX_SERIES) {
    throw new RangeError(`${n} series is more than the ${MAX_SERIES} distinguishable colours for a ${kind} chart; select fewer columns (y), aggregate the rest, or use { subplots: true }`);
  }
}

// ------------------------------------------------------------------- charts

function lineChart(d: PlotData, o: PlotOptions, area = false): string {
  checkSeriesCount(d.series.length, area ? 'area' : 'line');
  const f: Frame = { W: o.width ?? 640, H: o.height ?? 400, left: 56, right: 24, top: 0, bottom: 40 };
  const directLabels = d.series.length >= 2 && d.series.length <= 4 && (o.legend ?? true);
  if (directLabels) f.right = 24 + Math.min(110, Math.max(...d.series.map((s) => s.name.length)) * 7 + 12);
  const svg = new Svg(o, f, o.title ?? `${area ? 'Area' : 'Line'} chart of ${d.series.map((s) => s.name).join(', ')}`, `${d.series.length} series over ${d.x.values.length} points`);
  f.top = header(svg, o, d.series.map((s) => s.name), area ? 'swatch' : 'line');
  const n = d.x.values.length;
  const xs = d.x.kind === 'category' ? Array.from({ length: n }, (_, i) => i) : d.x.values.map(xNum);
  const stacked = area && (o.stacked ?? true) && d.series.length > 1;
  const tops = d.series.map(() => new Float64Array(n));
  const bottoms = d.series.map(() => new Float64Array(n));
  const acc = new Float64Array(n);
  d.series.forEach((s, k) => {
    for (let i = 0; i < n; i++) {
      const v = Number.isFinite(s.values[i]) ? s.values[i] : stacked ? 0 : NaN;
      bottoms[k][i] = stacked ? acc[i] : 0;
      tops[k][i] = stacked ? acc[i] + v : v;
      if (stacked) acc[i] += v;
    }
  });
  const allY = [...tops.flatMap((t) => finite(t)), ...(area ? [0] : [])];
  const yScale = linear(o.ylim ?? [Math.min(...allY), Math.max(...allY)], [f.H - f.bottom, f.top + 8], { log: o.logy, zero: area });
  const xd: [number, number] = o.xlim ?? [Math.min(...finite(Float64Array.from(xs))), Math.max(...finite(Float64Array.from(xs)))];
  const xScale = d.x.kind === 'time' ? timeScale(xd, [f.left, f.W - f.right]) : d.x.kind === 'number' ? linear(xd, [f.left, f.W - f.right], { count: 6 }) : linear([0, Math.max(1, n - 1)], [f.left, f.W - f.right], { nice: false });
  yAxis(svg, yScale, f.left, f.W - f.right, o.grid ?? true, o.ylabel);
  if (d.x.kind === 'category') categoryAxis(svg, d.x.values.map(labelOf), (i) => xScale.map(i), f.H - f.bottom, o.xlabel ?? d.x.name ?? undefined);
  else xAxisTicks(svg, xScale, f.H - f.bottom, o.xlabel ?? d.x.name ?? undefined);
  const pathOf = (vals: Float64Array) => {
    let p = '', pen = false;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(vals[i]) || !Number.isFinite(xs[i] as number)) { pen = false; continue; }
      p += `${pen ? 'L' : 'M'}${f2(xScale.map(xs[i] as number))},${f2(yScale.map(vals[i]))}`;
      pen = true;
    }
    return p;
  };
  d.series.forEach((s, k) => {
    if (area) {
      let poly = '';
      for (let i = 0; i < n; i++) poly += `${i ? 'L' : 'M'}${f2(xScale.map(xs[i] as number))},${f2(yScale.map(Number.isFinite(tops[k][i]) ? tops[k][i] : bottoms[k][i]))}`;
      for (let i = n - 1; i >= 0; i--) poly += `L${f2(xScale.map(xs[i] as number))},${f2(yScale.map(bottoms[k][i]))}`;
      svg.add(`<path d="${poly}Z" fill="${color(k)}" fill-opacity="${stacked ? 0.55 : 0.1}" stroke="none"/>`);
    }
    svg.add(`<path class="mark" d="${pathOf(tops[k])}" fill="none" stroke="${stacked ? 'var(--surface)' : color(k)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (stacked) svg.add(`<path d="${pathOf(tops[k])}" fill="none" stroke="${color(k)}" stroke-width="1.5" stroke-linejoin="round"/>`);
  });
  // Native tooltips on invisible hit targets, one per x position.
  for (let i = 0; i < n; i++) {
    const cx = xScale.map(xs[i] as number);
    if (!Number.isFinite(cx)) continue;
    const w = Math.max(6, (f.W - f.left - f.right) / Math.max(1, n));
    const tip = `${labelOf(d.x.values[i])}\n` + d.series.map((s) => `${s.name}: ${Number.isFinite(s.values[i]) ? compact(s.values[i]) : '—'}`).join('\n');
    svg.add(`<rect class="hit" x="${f2(cx - w / 2)}" y="${f.top}" width="${f2(w)}" height="${f.H - f.bottom - f.top}"><title>${escapeXml(tip)}</title></rect>`);
  }
  // End markers + direct labels (only when they don't collide).
  const ends = d.series.map((s, k) => {
    let i = n - 1;
    while (i >= 0 && !Number.isFinite(tops[k][i])) i--;
    return { k, i, y: i >= 0 ? yScale.map(tops[k][i]) : NaN, x: i >= 0 ? xScale.map(xs[i] as number) : NaN };
  }).filter((e) => e.i >= 0);
  const sorted = [...ends].sort((a, b) => a.y - b.y);
  const separated = sorted.every((e, j) => j === 0 || e.y - sorted[j - 1].y >= 14);
  for (const e of ends) {
    svg.add(`<circle cx="${f2(e.x)}" cy="${f2(e.y)}" r="4" fill="${color(e.k)}" stroke="var(--surface)" stroke-width="2"/>`);
    if (directLabels && separated) svg.text(e.x + 10, e.y + 4, d.series[e.k].name, ' class="label"');
  }
  return svg.toString();
}

function barChart(d: PlotData, o: PlotOptions, horizontal: boolean): string {
  checkSeriesCount(d.series.length, 'bar');
  const cats = d.x.values.map(labelOf);
  const n = cats.length;
  const f: Frame = { W: o.width ?? 640, H: o.height ?? 400, left: horizontal ? Math.min(160, 16 + Math.max(...cats.map((c) => c.length)) * 6.6) : 56, right: 32, top: 0, bottom: 40 };
  const svg = new Svg(o, f, o.title ?? `Bar chart of ${d.series.map((s) => s.name).join(', ')}`, `${d.series.length} series across ${n} categories`);
  f.top = header(svg, o, d.series.map((s) => s.name), 'swatch');
  const stacked = Boolean(o.stacked) && d.series.length > 1;
  const pos = new Float64Array(n), neg = new Float64Array(n);
  const segs: { k: number; i: number; v: number; from: number; to: number }[] = [];
  d.series.forEach((s, k) => {
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      if (stacked) {
        const base = v >= 0 ? pos[i] : neg[i];
        segs.push({ k, i, v, from: base, to: base + v });
        if (v >= 0) pos[i] += v; else neg[i] += v;
      } else segs.push({ k, i, v, from: 0, to: v });
    }
  });
  const vals = segs.flatMap((s) => [s.from, s.to]);
  const vRange: [number, number] = o.ylim ?? [Math.min(0, ...vals), Math.max(0, ...vals)];
  const plotLen = horizontal ? f.H - f.bottom - f.top : f.W - f.left - f.right;
  const band = plotLen / Math.max(1, n);
  const groups = stacked ? 1 : d.series.length;
  const thick = Math.min(24, Math.max(2, (band * 0.7 - 2 * (groups - 1)) / groups));
  const vScale = horizontal ? linear(vRange, [f.left, f.W - f.right], { zero: true, count: 6 }) : linear(vRange, [f.H - f.bottom, f.top + 8], { zero: true });
  const bandStart = (i: number) => (horizontal ? f.top : f.left) + i * band;
  const offset = (k: number) => (band - (groups * thick + 2 * (groups - 1))) / 2 + (stacked ? 0 : k * (thick + 2));
  if (horizontal) {
    for (const t of vScale.ticks) {
      const x = vScale.map(t);
      if (o.grid ?? true) svg.add(`<line class="grid" x1="${f2(x)}" x2="${f2(x)}" y1="${f.top}" y2="${f.H - f.bottom}"/>`);
      svg.text(x, f.H - f.bottom + 16, vScale.fmt(t), ' class="tick" text-anchor="middle"');
    }
    cats.forEach((c, i) => svg.text(f.left - 8, bandStart(i) + band / 2 + 4, c.length > 22 ? c.slice(0, 21) + '…' : c, ' class="tick" text-anchor="end"'));
    svg.add(`<line class="axis" x1="${f2(vScale.map(0))}" x2="${f2(vScale.map(0))}" y1="${f.top}" y2="${f.H - f.bottom}"/>`);
    if (o.xlabel ?? o.ylabel) svg.text((f.left + f.W - f.right) / 2, f.H - 6, (o.ylabel ?? o.xlabel)!, ' class="label" text-anchor="middle"');
  } else {
    yAxis(svg, vScale, f.left, f.W - f.right, o.grid ?? true, o.ylabel);
    categoryAxis(svg, cats, (i) => bandStart(i) + band / 2, vScale.map(0), o.xlabel ?? d.x.name ?? undefined);
  }
  for (const s of segs) {
    const a = vScale.map(s.from), b = vScale.map(s.to);
    // A 2px surface gap separates stacked segments.
    const gap = stacked && s.from !== 0 ? 2 : 0;
    const across = bandStart(s.i) + offset(s.k);
    const tip = `${cats[s.i]} · ${d.series[s.k].name}: ${compact(s.v)}`;
    const isEnd = !stacked || Math.abs(s.to - (s.v >= 0 ? pos[s.i] : neg[s.i])) < 1e-12;
    let path: string;
    if (horizontal) {
      const x0 = Math.min(a, b) + (s.v >= 0 ? gap : 0), w = Math.max(0, Math.abs(b - a) - gap);
      path = isEnd ? barPath(x0, across, w, thick, s.v >= 0 ? 'right' : 'left') : `M${f2(x0)},${f2(across)}h${f2(w)}v${f2(thick)}h${f2(-w)}Z`;
    } else {
      const y0 = Math.min(a, b), h = Math.max(0, Math.abs(b - a) - gap);
      path = isEnd ? barPath(across, s.v >= 0 ? y0 : y0 + gap, thick, h, s.v >= 0 ? 'up' : 'down') : `M${f2(across)},${f2(s.v >= 0 ? y0 : y0 + gap)}h${f2(thick)}v${f2(h)}h${f2(-thick)}Z`;
    }
    svg.add(`<path class="mark" d="${path}" fill="${color(s.k)}"><title>${escapeXml(tip)}</title></path>`);
  }
  // Single series: value at the bar tip (sparingly — only when bars are few).
  if (d.series.length === 1 && n <= 12) {
    for (const s of segs) {
      const tipPos = vScale.map(s.to);
      const across = bandStart(s.i) + offset(0) + thick / 2;
      if (horizontal) svg.text(tipPos + (s.v >= 0 ? 6 : -6), across + 4, compact(s.v), ` class="tick" text-anchor="${s.v >= 0 ? 'start' : 'end'}"`);
      else svg.text(across, tipPos + (s.v >= 0 ? -6 : 14), compact(s.v), ' class="tick" text-anchor="middle"');
    }
  }
  return svg.toString();
}

function histChart(d: PlotData, o: PlotOptions): string {
  checkSeriesCount(d.series.length, 'histogram');
  const all = d.series.flatMap((s) => finite(s.values));
  const lo = o.xlim?.[0] ?? Math.min(...all), hi = o.xlim?.[1] ?? Math.max(...all);
  const nb = o.bins ?? 10;
  const width = (hi - lo) / nb || 1;
  const counts = d.series.map((s) => {
    const c = new Float64Array(nb);
    for (const v of finite(s.values)) c[Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / width)))]++;
    return c;
  });
  const f: Frame = { W: o.width ?? 640, H: o.height ?? 400, left: 56, right: 24, top: 0, bottom: 40 };
  const svg = new Svg(o, f, o.title ?? `Histogram of ${d.series.map((s) => s.name).join(', ')}`, `${nb} bins from ${compact(lo)} to ${compact(hi)}`);
  f.top = header(svg, o, d.series.map((s) => s.name), 'swatch');
  const stacked = Boolean(o.stacked) && d.series.length > 1;
  const tot = new Float64Array(nb);
  const maxC = stacked ? Math.max(...counts.reduce((acc, c) => acc.map((v, i) => v + c[i]), new Float64Array(nb))) : Math.max(...counts.flatMap((c) => [...c]));
  const yScale = linear([0, o.ylim?.[1] ?? maxC], [f.H - f.bottom, f.top + 8], { zero: true });
  const xScale = linear([lo, hi], [f.left, f.W - f.right], { nice: false });
  yAxis(svg, yScale, f.left, f.W - f.right, o.grid ?? true, o.ylabel ?? 'Frequency');
  xAxisTicks(svg, { ...linear([lo, hi], [f.left, f.W - f.right], { count: 6 }), map: xScale.map }, f.H - f.bottom, o.xlabel);
  counts.forEach((c, k) => {
    for (let b = 0; b < nb; b++) {
      if (!c[b]) continue;
      const x0 = xScale.map(lo + b * width) + 1, x1 = xScale.map(lo + (b + 1) * width) - 1;
      const base = stacked ? tot[b] : 0;
      const y0 = yScale.map(base + c[b]), y1 = yScale.map(base) - (stacked && base ? 2 : 0);
      const tip = `${d.series[k].name}: [${compact(lo + b * width)}, ${compact(lo + (b + 1) * width)}) → ${c[b]}`;
      svg.add(`<path class="mark" d="${barPath(x0, y0, Math.max(1, x1 - x0), Math.max(0, y1 - y0), 'up')}" fill="${color(k)}"${!stacked && d.series.length > 1 ? ' fill-opacity="0.55"' : ''}><title>${escapeXml(tip)}</title></path>`);
      if (stacked) tot[b] += c[b];
    }
  });
  return svg.toString();
}

function gaussianKde(values: number[], points: number[]): number[] {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const h = sd * n ** (-1 / 5) || 1; // Scott's rule, like scipy's default
  return points.map((x) => values.reduce((acc, v) => acc + Math.exp(-0.5 * ((x - v) / h) ** 2), 0) / (n * h * Math.sqrt(2 * Math.PI)));
}

function kdeChart(d: PlotData, o: PlotOptions): string {
  const all = d.series.flatMap((s) => finite(s.values));
  const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.5 || 1;
  const xs = Array.from({ length: 200 }, (_, i) => lo - pad + ((hi - lo + 2 * pad) * i) / 199);
  const dens: PlotData = {
    x: { values: xs, kind: 'number', name: o.xlabel ?? null },
    series: d.series.map((s) => ({ name: s.name, values: Float64Array.from(gaussianKde(finite(s.values), xs)) })),
  };
  return lineChart(dens, { ...o, ylabel: o.ylabel ?? 'Density', title: o.title ?? `Density of ${d.series.map((s) => s.name).join(', ')}` });
}

function boxChart(d: PlotData, o: PlotOptions): string {
  checkSeriesCount(d.series.length, 'box');
  const stats = d.series.map((s) => {
    const col = Column.from(finite(s.values), 'float64');
    const q1 = quantile(col, 0.25), q2 = quantile(col, 0.5), q3 = quantile(col, 0.75);
    const iqr = q3 - q1;
    const vals = finite(s.values);
    const inside = vals.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    return { name: s.name, q1, q2, q3, lo: Math.min(...inside), hi: Math.max(...inside), out: vals.filter((v) => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr) };
  });
  const f: Frame = { W: o.width ?? 640, H: o.height ?? 400, left: 56, right: 24, top: 0, bottom: 40 };
  const svg = new Svg(o, f, o.title ?? `Box plot of ${stats.map((s) => s.name).join(', ')}`, 'quartiles, 1.5×IQR whiskers and outliers');
  f.top = header(svg, { ...o, legend: false }, [], 'swatch');
  const all = stats.flatMap((s) => [s.lo, s.hi, ...s.out]);
  const yScale = linear(o.ylim ?? [Math.min(...all), Math.max(...all)], [f.H - f.bottom, f.top + 8]);
  const band = (f.W - f.left - f.right) / stats.length;
  yAxis(svg, yScale, f.left, f.W - f.right, o.grid ?? true, o.ylabel);
  categoryAxis(svg, stats.map((s) => s.name), (i) => f.left + band * (i + 0.5), f.H - f.bottom, o.xlabel);
  stats.forEach((s, i) => {
    const cx = f.left + band * (i + 0.5), w = Math.min(40, band * 0.5);
    const tip = `${s.name}\nmax ${compact(s.hi)} · Q3 ${compact(s.q3)} · median ${compact(s.q2)} · Q1 ${compact(s.q1)} · min ${compact(s.lo)}`;
    svg.add(`<line x1="${f2(cx)}" x2="${f2(cx)}" y1="${f2(yScale.map(s.hi))}" y2="${f2(yScale.map(s.q3))}" stroke="${color(i)}" stroke-width="2"/>`);
    svg.add(`<line x1="${f2(cx)}" x2="${f2(cx)}" y1="${f2(yScale.map(s.q1))}" y2="${f2(yScale.map(s.lo))}" stroke="${color(i)}" stroke-width="2"/>`);
    svg.add(`<rect class="mark" x="${f2(cx - w / 2)}" y="${f2(yScale.map(s.q3))}" width="${f2(w)}" height="${f2(Math.max(1, yScale.map(s.q1) - yScale.map(s.q3)))}" rx="4" fill="${color(i)}" fill-opacity="0.15" stroke="${color(i)}" stroke-width="2"><title>${escapeXml(tip)}</title></rect>`);
    svg.add(`<line x1="${f2(cx - w / 2)}" x2="${f2(cx + w / 2)}" y1="${f2(yScale.map(s.q2))}" y2="${f2(yScale.map(s.q2))}" stroke="${color(i)}" stroke-width="2"/>`);
    for (const v of s.out) svg.add(`<circle cx="${f2(cx)}" cy="${f2(yScale.map(v))}" r="4" fill="${color(i)}" stroke="var(--surface)" stroke-width="2"><title>${escapeXml(`${s.name}: ${compact(v)}`)}</title></circle>`);
  });
  return svg.toString();
}

function pieChart(d: PlotData, o: PlotOptions): string {
  const s = d.series[0];
  let slices = d.x.values.map((x, i) => ({ name: labelOf(x), v: s.values[i] })).filter((e) => Number.isFinite(e.v) && e.v > 0);
  if (slices.length > MAX_SERIES) {
    // Never cycle colours: fold the tail into "Other".
    const sorted = [...slices].sort((a, b) => b.v - a.v);
    slices = [...sorted.slice(0, MAX_SERIES - 1), { name: 'Other', v: sorted.slice(MAX_SERIES - 1).reduce((a, e) => a + e.v, 0) }];
  }
  const total = slices.reduce((a, e) => a + e.v, 0);
  const f: Frame = { W: o.width ?? 480, H: o.height ?? 400, left: 16, right: 16, top: 0, bottom: 16 };
  const svg = new Svg(o, f, o.title ?? `Share of ${s.name}`, `${slices.length} slices`);
  f.top = header(svg, { ...o, legend: o.legend ?? true }, slices.map((e) => e.name), 'swatch');
  const cx = f.W / 2, cy = (f.top + f.H - f.bottom) / 2;
  const r = Math.min(f.W - 120, f.H - f.top - f.bottom - 40) / 2;
  let a = -Math.PI / 2;
  slices.forEach((e, i) => {
    const sweep = (e.v / total) * Math.PI * 2;
    const a2 = a + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${f2(cx + rad * Math.cos(ang))},${f2(cy + rad * Math.sin(ang))}`;
    const d2 = slices.length === 1 ? `M${f2(cx - r)},${f2(cy)}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0` : `M${f2(cx)},${f2(cy)}L${p(a, r)}A${r},${r} 0 ${large},1 ${p(a2, r)}Z`;
    const pct = (e.v / total) * 100;
    svg.add(`<path class="mark" d="${d2}" fill="${color(i)}" stroke="var(--surface)" stroke-width="2" stroke-linejoin="round"><title>${escapeXml(`${e.name}: ${compact(e.v)} (${pct.toFixed(1)}%)`)}</title></path>`);
    if (pct >= 4) {
      const mid = (a + a2) / 2;
      svg.text(cx + (r + 14) * Math.cos(mid), cy + (r + 14) * Math.sin(mid) + 4, `${pct.toFixed(0)}%`, ` class="tick" text-anchor="${Math.cos(mid) >= 0 ? 'start' : 'end'}"`);
    }
    a = a2;
  });
  return svg.toString();
}

function scatterChart(df: DataFrame, o: PlotOptions): string {
  if (!o.x || typeof o.y !== 'string') throw new Error("scatter needs `x` and a single `y` column");
  const xs = Float64Array.from(numericView(df._column(o.x))), ys = Float64Array.from(numericView(df._column(o.y)));
  const cs = o.c ? Float64Array.from(numericView(df._column(o.c))) : null;
  const f: Frame = { W: o.width ?? 640, H: o.height ?? 400, left: 56, right: cs ? 80 : 24, top: 0, bottom: 40 };
  const svg = new Svg(o, f, o.title ?? `${o.y} vs ${o.x}`, `${xs.length} points`);
  f.top = header(svg, { ...o, legend: false }, [], 'dot');
  const yScale = linear(o.ylim ?? [Math.min(...finite(ys)), Math.max(...finite(ys))], [f.H - f.bottom, f.top + 8], { log: o.logy });
  const xScale = linear(o.xlim ?? [Math.min(...finite(xs)), Math.max(...finite(xs))], [f.left, f.W - f.right], { count: 6 });
  yAxis(svg, yScale, f.left, f.W - f.right, o.grid ?? true, o.ylabel ?? o.y);
  xAxisTicks(svg, xScale, f.H - f.bottom, o.xlabel ?? o.x);
  const cRange = cs ? [Math.min(...finite(cs)), Math.max(...finite(cs))] : [0, 1];
  const seq = (v: number) => SEQ[Math.round(3 + ((v - cRange[0]) / (cRange[1] - cRange[0] || 1)) * (SEQ.length - 4))];
  const r = o.s ?? 4;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const fill = cs ? (Number.isFinite(cs[i]) ? seq(cs[i]) : 'var(--muted)') : color(0);
    const tip = `${o.x}: ${compact(xs[i])}, ${o.y}: ${compact(ys[i])}${cs ? `, ${o.c}: ${compact(cs[i])}` : ''}`;
    svg.add(`<circle class="mark" cx="${f2(xScale.map(xs[i]))}" cy="${f2(yScale.map(ys[i]))}" r="${Math.max(4, r)}" fill="${fill}" stroke="var(--surface)" stroke-width="2"><title>${escapeXml(tip)}</title></circle>`);
  }
  if (cs) colorbar(svg, cRange as [number, number], o.c!);
  return svg.toString();
}

function colorbar(svg: Svg, range: [number, number], name: string): void {
  const x = svg.f.W - svg.f.right + 28, y0 = svg.f.top + 8, y1 = svg.f.H - svg.f.bottom;
  const steps = SEQ.slice(3);
  const h = (y1 - y0) / steps.length;
  steps.forEach((c, k) => svg.add(`<rect x="${x}" y="${f2(y1 - (k + 1) * h)}" width="10" height="${f2(h + 0.5)}" fill="${c}"/>`));
  svg.text(x + 14, y0 + 8, compact(range[1]), ' class="tick"');
  svg.text(x + 14, y1, compact(range[0]), ' class="tick"');
  svg.text(x - 4, y0 - 4, name, ' class="tick"');
}

function hexbinChart(df: DataFrame, o: PlotOptions): string {
  if (!o.x || typeof o.y !== 'string') throw new Error("hexbin needs `x` and a single `y` column");
  const xs = Float64Array.from(numericView(df._column(o.x))), ys = Float64Array.from(numericView(df._column(o.y)));
  const f: Frame = { W: o.width ?? 640, H: o.height ?? 400, left: 56, right: 80, top: 0, bottom: 40 };
  const svg = new Svg(o, f, o.title ?? `Density of ${o.y} vs ${o.x}`, `hexagonal bins of ${xs.length} points`);
  f.top = header(svg, { ...o, legend: false }, [], 'dot');
  const yScale = linear([Math.min(...finite(ys)), Math.max(...finite(ys))], [f.H - f.bottom, f.top + 8]);
  const xScale = linear([Math.min(...finite(xs)), Math.max(...finite(xs))], [f.left, f.W - f.right], { count: 6 });
  yAxis(svg, yScale, f.left, f.W - f.right, false, o.ylabel ?? o.y);
  xAxisTicks(svg, xScale, f.H - f.bottom, o.xlabel ?? o.x);
  const size = (f.W - f.left - f.right) / (o.gridsize ?? 20) / Math.sqrt(3);
  const bins = new Map<string, { cx: number; cy: number; n: number }>();
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const px = xScale.map(xs[i]) - f.left, py = yScale.map(ys[i]) - f.top;
    const q = ((Math.sqrt(3) / 3) * px - py / 3) / size, rr = ((2 / 3) * py) / size;
    let rx = Math.round(q), ry = Math.round(rr), rz = Math.round(-q - rr);
    const dx = Math.abs(rx - q), dy = Math.abs(ry - rr), dz = Math.abs(rz + q + rr);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz;
    const key = `${rx},${ry}`;
    const e = bins.get(key) ?? { cx: f.left + size * Math.sqrt(3) * (rx + ry / 2), cy: f.top + size * 1.5 * ry, n: 0 };
    e.n++;
    bins.set(key, e);
  }
  const max = Math.max(...[...bins.values()].map((b) => b.n));
  // Hexagons at the edges are clipped to the plot area.
  svg.add(`<clipPath id="${svg.cls}-clip"><rect x="${f.left}" y="${f.top}" width="${f.W - f.left - f.right}" height="${f.H - f.bottom - f.top}"/></clipPath><g clip-path="url(#${svg.cls}-clip)">`);
  for (const b of bins.values()) {
    const pts = Array.from({ length: 6 }, (_, k) => { const a = (Math.PI / 3) * k + Math.PI / 6; return `${f2(b.cx + (size - 1) * Math.cos(a))},${f2(b.cy + (size - 1) * Math.sin(a))}`; }).join(' ');
    svg.add(`<polygon class="mark" points="${pts}" fill="${SEQ[Math.round(3 + ((b.n - 1) / Math.max(1, max - 1)) * (SEQ.length - 4))]}"><title>${b.n} points</title></polygon>`);
  }
  svg.add('</g>');
  colorbar(svg, [1, max], 'count');
  return svg.toString();
}

function subplotGrid(target: DataFrame | Series, o: PlotOptions, kind: PlotKind): string {
  const d = plotData(target, o);
  const cols = o.layoutColumns ?? Math.min(3, d.series.length);
  const rows = Math.ceil(d.series.length / cols);
  const W = o.width ?? 320 * cols, H = o.height ?? 240 * rows;
  const w = Math.floor(W / cols), h = Math.floor(H / rows);
  const panels = d.series.map((s, i) => {
    const df = target instanceof Series ? target.toFrame(s.name) : (target as DataFrame);
    const svg = render(df, { ...o, subplots: false, y: s.name, title: s.name, width: w, height: h, legend: false }, kind);
    const col = i % cols, row = Math.floor(i / cols);
    return svg.replace('<svg ', `<svg x="${col * w}" y="${row * h}" `);
  });
  const cls = `npviz${(uid++).toString(36)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(o.title ?? `Small multiples of ${d.series.map((s) => s.name).join(', ')}`)}">${styleBlock(cls, o.theme)}<rect width="${W}" height="${H}" fill="var(--surface)"/>${panels.join('')}</svg>`;
}

function render(target: DataFrame | Series, o: PlotOptions, kind: PlotKind): string {
  if (o.subplots && kind !== 'scatter' && kind !== 'hexbin' && kind !== 'pie') return subplotGrid(target, o, kind);
  const df = target instanceof Series ? target.toFrame(target.name ?? 'value') : target;
  switch (kind) {
    case 'scatter': return scatterChart(df, o);
    case 'hexbin': return hexbinChart(df, o);
    case 'bar': return barChart(plotData(target, o), o, false);
    case 'barh': return barChart(plotData(target, o), o, true);
    case 'hist': return histChart(plotData(target, o), o);
    case 'box': return boxChart(plotData(target, o), o);
    case 'kde': case 'density': return kdeChart(plotData(target, o), o);
    case 'area': return lineChart(plotData(target, o), o, true);
    case 'pie': {
      const d = plotData(target, o);
      if (d.series.length !== 1) throw new Error('pie needs a single column (pass y), or use subplots');
      return pieChart(d, o);
    }
    default: return lineChart(plotData(target, o), o);
  }
}

/** Wraps an SVG and the plotted data table in a standalone HTML page. */
export function plotHtml(svg: string, target: DataFrame | Series, title = 'Chart'): string {
  const df = target instanceof Series ? target.toFrame(target.name ?? 'value') : target;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeXml(title)}</title>`
    + `<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f9f9f7;color:#0b0b0b}`
    + `@media (prefers-color-scheme: dark){body{background:#0d0d0d;color:#f0efec}}svg{max-width:100%;height:auto}`
    + `table{border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:12px}td,th{padding:4px 8px;border-bottom:1px solid #e1e0d9;text-align:right}`
    + `details{margin-top:16px}</style></head><body>${svg}<details><summary>Data table</summary>${renderHtml(df, { border: 0 })}</details></body></html>`;
}

function output(svg: string, target: DataFrame | Series, o: PlotOptions): string {
  if (o.path) writeFileSync(o.path, o.path.endsWith('.html') ? plotHtml(svg, target, o.title) : svg);
  return svg;
}

export interface PlotAccessor {
  (options?: PlotOptions): string;
  line(options?: PlotOptions): string;
  bar(options?: PlotOptions): string;
  barh(options?: PlotOptions): string;
  hist(options?: PlotOptions): string;
  box(options?: PlotOptions): string;
  kde(options?: PlotOptions): string;
  density(options?: PlotOptions): string;
  area(options?: PlotOptions): string;
  pie(options?: PlotOptions): string;
  scatter(options: PlotOptions & { x: string; y: string }): string;
  hexbin(options: PlotOptions & { x: string; y: string }): string;
}

/** `df.plot` / `series.plot`: callable with `{kind}` and with one method per kind. Each returns SVG. */
export function plotAccessor(target: DataFrame | Series): PlotAccessor {
  const run = (kind: PlotKind, o: PlotOptions = {}) => output(render(target, o, kind), target, o);
  const fn = ((o: PlotOptions = {}) => run(o.kind ?? 'line', o)) as PlotAccessor;
  for (const k of ['line', 'bar', 'barh', 'hist', 'box', 'kde', 'density', 'area', 'pie', 'scatter', 'hexbin'] as PlotKind[]) {
    (fn as unknown as Record<string, (o?: PlotOptions) => string>)[k] = (o?: PlotOptions) => run(k, o);
  }
  return fn;
}

