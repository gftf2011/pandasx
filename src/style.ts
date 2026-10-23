/**
 * Conditional formatting rendered to HTML (and LaTeX / Excel), like `df.style`.
 * The markup matches pandas' Styler: ids `T_<uuid>_row<i>_col<j>`, classes
 * `data`, `row_heading`, `col_heading`, and one CSS rule per distinct style.
 */
import { formatScalar } from './core/format.ts';
import { pyFloat } from './core/interval.ts';
import { formatSpec, pyFormat } from './core/pyformat.ts';
import { isNumericDType, type Label } from './core/types.ts';
import { isNA } from './core/values.ts';
import { colTuple, DataFrame } from './frame.ts';
import { escapeXml } from './io/markup.ts';
import { quantile } from './core/aggregate.ts';
import { Column } from './core/column.ts';
import { labelPositions, Series, type RowSelector } from './series.ts';

/** Columns, or `{ rows, columns }` (rows by label, mask or slice). */
export type Subset = string | readonly string[] | { rows?: RowSelector; columns?: string | readonly string[] };
type Axis = 0 | 1 | 'index' | 'columns' | 'rows' | null;
type Formatter = string | ((v: unknown) => string);

const isRowsAxis = (a: Axis | undefined) => a === 1 || a === 'columns';

const RAMPS: Record<string, string[]> = {
  Blues: ['#f7fbff', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  Oranges: ['#fff8f3', '#fcd9c6', '#f8b493', '#f28d62', '#eb6834', '#c9501f', '#9e3d16', '#722b0f'],
  Greens: ['#f5fbf5', '#cdeccd', '#9bd59b', '#63bb63', '#2e9e2e', '#008300', '#006300', '#004400'],
  Reds: ['#fff5f5', '#fbd0cf', '#f5a3a2', '#ec7574', '#e34948', '#bd3333', '#922525', '#681a1a'],
  Purples: ['#f8f7fe', '#dcd8f6', '#bab2ee', '#9085e9', '#6250d6', '#4a3aa7', '#382b80', '#271e5a'],
  Greys: ['#fcfcfb', '#e1e0d9', '#c3c2b7', '#a3a29b', '#898781', '#6b6a65', '#52514e', '#2c2c2a'],
  RdBu: ['#922525', '#e34948', '#f5a3a2', '#f0efec', '#9ec5f4', '#3987e5', '#184f95'],
  coolwarm: ['#184f95', '#3987e5', '#9ec5f4', '#f0efec', '#f5a3a2', '#e34948', '#922525'],
};
RAMPS.viridis = RAMPS.Blues;

function hexToRgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function interpolate(ramp: string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const k = Math.min(ramp.length - 2, Math.floor(x));
  const a = hexToRgb(ramp[k]), b = hexToRgb(ramp[k + 1]);
  const f = x - k;
  return '#' + a.map((c, i) => Math.round(c + (b[i] - c) * f).toString(16).padStart(2, '0')).join('');
}

/** Relative luminance (WCAG) of a hex colour. */
function luminance(hex: string): number {
  return hexToRgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
}

export class Styler {
  readonly data: DataFrame;
  private uuid = Math.random().toString(16).slice(2, 7);
  private readonly styles = new Map<string, string[]>();
  private readonly formatters = new Map<number, (v: unknown) => string>();
  private indexFormatter: ((v: unknown) => string) | null = null;
  private caption: string | null = null;
  private tableStyles: { selector: string; props: string }[] = [];
  private tableAttributes = '';
  private hiddenIndex = false;
  private hiddenHeader = false;
  private readonly hiddenCols = new Set<number>();
  private readonly hiddenRows = new Set<number>();
  private naRep: string | null = null;
  private precision = 6;

  constructor(data: DataFrame) {
    this.data = data;
  }

  // -------------------------------------------------------------- selection

  private cols(subset?: Subset): number[] {
    const all = this.data.columns;
    let names: readonly string[] | undefined;
    if (subset === undefined) names = undefined;
    else if (typeof subset === 'string') names = [subset];
    else if (Array.isArray(subset)) names = subset as readonly string[];
    else { const c = (subset as { columns?: string | readonly string[] }).columns; names = c === undefined ? undefined : typeof c === 'string' ? [c] : c; }
    if (!names) return all.map((_, j) => j);
    return names.map((n) => { const j = all.indexOf(n); if (j < 0) throw new Error(`Column not found: ${n}`); return j; });
  }

  private rows(subset?: Subset): number[] {
    const r = subset && typeof subset === 'object' && !Array.isArray(subset) ? (subset as { rows?: RowSelector }).rows : undefined;
    return r === undefined ? Array.from({ length: this.data.length }, (_, i) => i) : labelPositions(r, this.data.index);
  }

  private add(i: number, j: number, css: string | null | undefined): void {
    if (!css) return;
    const decls = css.split(';').map((d) => d.trim()).filter(Boolean);
    const key = `${i},${j}`;
    this.styles.set(key, [...(this.styles.get(key) ?? []), ...decls]);
  }

  private column(j: number, rows: number[]): Series {
    return this.data.get(this.data.columns[j]).take(rows);
  }

  // ------------------------------------------------------------ core API

  /** Element-wise: `fn(value)` returns CSS ('color: red;') or null. */
  map(fn: (value: unknown) => string | null | undefined, options: { subset?: Subset } = {}): this {
    const rows = this.rows(options.subset);
    for (const j of this.cols(options.subset)) for (const i of rows) this.add(i, j, fn(this.data._column(this.data.columns[j]).get(i)));
    return this;
  }

  applymap(fn: (value: unknown) => string | null | undefined, options: { subset?: Subset } = {}): this {
    return this.map(fn, options);
  }

  /**
   * Column-wise (axis 0, default), row-wise (axis 1) or table-wise (axis null):
   * `fn` gets a Series (or the sub-frame) and returns CSS per element.
   */
  apply(fn: (data: any) => readonly (string | null | undefined)[] | (string | null | undefined)[][] | Series | DataFrame, options: { axis?: Axis; subset?: Subset } = {}): this {
    const rows = this.rows(options.subset);
    const cols = this.cols(options.subset);
    const read = (r: unknown): (string | null | undefined)[] => (r instanceof Series ? (r.toArray() as string[]) : (r as string[]));
    if (options.axis === null) {
      const sub = this.data.get(cols.map((j) => this.data.columns[j])).take(rows);
      const res = fn(sub);
      if (res instanceof DataFrame) cols.forEach((j, k) => rows.forEach((i, r) => this.add(i, j, res._column(res.columns[k]).get(r) as string)));
      else (res as (string | null)[][]).forEach((row, r) => row.forEach((css, k) => this.add(rows[r], cols[k], css)));
      return this;
    }
    if (isRowsAxis(options.axis)) {
      for (const i of rows) {
        const s = new Series(cols.map((j) => this.data._column(this.data.columns[j]).get(i)), { index: cols.map((j) => this.data.columns[j]), name: String(this.data.index.labels[i]) });
        read(fn(s)).forEach((css, k) => this.add(i, cols[k], css));
      }
      return this;
    }
    for (const j of cols) read(fn(this.column(j, rows))).forEach((css, r) => this.add(rows[r], j, css));
    return this;
  }

  /** The same CSS on every cell of `subset`. */
  setProperties(props: Record<string, string> | string, options: { subset?: Subset } = {}): this {
    const css = typeof props === 'string' ? props : Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('; ');
    return this.map(() => css, options);
  }

  // ---------------------------------------------------------- formatting

  /**
   * Display format: a Python template ('{:,.2f}', 'R$ {:.2f}', '{:.1%}'), a
   * function, or `{column: template | function}`.
   */
  format(formatter?: Formatter | Record<string, Formatter> | null, options: { subset?: Subset; naRep?: string; precision?: number; thousands?: string; decimal?: string } = {}): this {
    const make = (f: Formatter | null | undefined): ((v: unknown) => string) => {
      const base = typeof f === 'function' ? f : typeof f === 'string' ? (v: unknown) => pyFormat(f, v) : (v: unknown) => this.defaultFormat(v, options.precision);
      return (v) => {
        if (isNA(v)) return options.naRep ?? this.naRep ?? (typeof v === 'number' ? 'nan' : 'None');
        let s = base(v);
        if (options.thousands !== undefined || options.decimal !== undefined) {
          s = s.replace(/[,.]/g, (c) => (c === ',' ? (options.thousands ?? ',') : (options.decimal ?? '.')));
        }
        return s;
      };
    };
    if (formatter && typeof formatter === 'object') {
      for (const [col, f] of Object.entries(formatter)) for (const j of this.cols([col])) this.formatters.set(j, make(f));
    } else for (const j of this.cols(options.subset)) this.formatters.set(j, make(formatter as Formatter | null));
    return this;
  }

  /** Formats the index labels. */
  formatIndex(formatter: Formatter): this {
    this.indexFormatter = typeof formatter === 'function' ? formatter : (v) => pyFormat(formatter, v);
    return this;
  }

  private defaultFormat(v: unknown, precision?: number): string {
    if (typeof v === 'number' && !Number.isInteger(v)) return formatSpec(v, `.${precision ?? this.precision}f`);
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return formatScalar(v);
  }

  private display(i: number, j: number): string {
    const v = this.data._column(this.data.columns[j]).get(i);
    const f = this.formatters.get(j);
    if (f) return f(v);
    if (isNA(v)) return this.naRep ?? (typeof v === 'number' || v === null && isNumericDType(this.data._column(this.data.columns[j]).dtype) ? 'nan' : 'None');
    return this.defaultFormat(v);
  }

  // ------------------------------------------------------------ builtins

  private extremes(max: boolean, o: { subset?: Subset; color?: string; axis?: Axis; props?: string }): this {
    const css = o.props ?? `background-color: ${o.color ?? 'yellow'};`;
    const pick = (vals: unknown[]) => {
      const nums = vals.map((v) => (typeof v === 'number' && !Number.isNaN(v) ? v : NaN));
      const best = (max ? Math.max : Math.min)(...nums.filter((v) => !Number.isNaN(v)));
      return nums.map((v) => (v === best ? css : null));
    };
    if (o.axis === null) {
      const rows = this.rows(o.subset), cols = this.cols(o.subset);
      const all = cols.flatMap((j) => rows.map((i) => this.data._column(this.data.columns[j]).get(i)));
      const marks = pick(all);
      cols.forEach((j, k) => rows.forEach((i, r) => this.add(i, j, marks[k * rows.length + r])));
      return this;
    }
    return this.apply((s: Series) => pick(s.toArray()), { axis: o.axis, subset: o.subset });
  }

  highlightMax(options: { subset?: Subset; color?: string; axis?: Axis; props?: string } = {}): this { return this.extremes(true, options); }
  highlightMin(options: { subset?: Subset; color?: string; axis?: Axis; props?: string } = {}): this { return this.extremes(false, options); }

  highlightNull(options: { subset?: Subset; color?: string; props?: string } = {}): this {
    const css = options.props ?? `background-color: ${options.color ?? 'red'};`;
    return this.map((v) => (isNA(v) ? css : null), options);
  }

  highlightBetween(options: { subset?: Subset; color?: string; left?: number; right?: number; inclusive?: 'both' | 'neither' | 'left' | 'right'; props?: string } = {}): this {
    const css = options.props ?? `background-color: ${options.color ?? 'yellow'};`;
    const inc = options.inclusive ?? 'both';
    const lo = options.left ?? -Infinity, hi = options.right ?? Infinity;
    return this.map((v) => {
      if (typeof v !== 'number' || Number.isNaN(v)) return null;
      const okL = inc === 'both' || inc === 'left' ? v >= lo : v > lo;
      const okR = inc === 'both' || inc === 'right' ? v <= hi : v < hi;
      return okL && okR ? css : null;
    }, options);
  }

  highlightQuantile(options: { subset?: Subset; color?: string; axis?: Axis; qLeft?: number; qRight?: number; props?: string } = {}): this {
    const css = options.props ?? `background-color: ${options.color ?? 'yellow'};`;
    return this.apply((s: Series) => {
      const col = Column.from(s.toArray().map((v) => (typeof v === 'number' ? v : NaN)), 'float64');
      const lo = quantile(col, options.qLeft ?? 0), hi = quantile(col, options.qRight ?? 1);
      return s.toArray().map((v) => (typeof v === 'number' && v >= lo && v <= hi ? css : null));
    }, { axis: options.axis, subset: options.subset });
  }

  /** Background colour by value (numeric columns), with readable text colour. */
  backgroundGradient(options: { cmap?: string; subset?: Subset; axis?: Axis; low?: number; high?: number; vmin?: number; vmax?: number; textColorThreshold?: number } = {}): this {
    return this.gradient(options, true);
  }

  /** Text colour by value. */
  textGradient(options: { cmap?: string; subset?: Subset; axis?: Axis; low?: number; high?: number; vmin?: number; vmax?: number } = {}): this {
    return this.gradient(options, false);
  }

  private gradient(o: { cmap?: string; subset?: Subset; axis?: Axis; low?: number; high?: number; vmin?: number; vmax?: number; textColorThreshold?: number }, background: boolean): this {
    const ramp = RAMPS[o.cmap ?? 'Blues'] ?? RAMPS.Blues;
    const subset = o.subset ?? this.data.columns.filter((c) => isNumericDType(this.data._column(c).dtype));
    const paint = (vals: unknown[]) => {
      const nums = vals.map((v) => (typeof v === 'number' ? v : NaN));
      const finite = nums.filter((v) => Number.isFinite(v));
      const lo = o.vmin ?? Math.min(...finite), hi = o.vmax ?? Math.max(...finite);
      const span = hi - lo || 1;
      const rLo = lo - span * (o.low ?? 0), rHi = hi + span * (o.high ?? 0);
      return nums.map((v) => {
        if (!Number.isFinite(v)) return null;
        const c = interpolate(ramp, (v - rLo) / (rHi - rLo || 1));
        if (!background) return `color: ${c};`;
        const text = luminance(c) < (o.textColorThreshold ?? 0.408) ? '#f1f1f1' : '#000000';
        return `background-color: ${c}; color: ${text};`;
      });
    };
    if (o.axis === null) {
      const rows = this.rows(subset), cols = this.cols(subset);
      const all = cols.flatMap((j) => rows.map((i) => this.data._column(this.data.columns[j]).get(i)));
      const css = paint(all);
      cols.forEach((j, k) => rows.forEach((i, r) => this.add(i, j, css[k * rows.length + r])));
      return this;
    }
    return this.apply((s: Series) => paint(s.toArray()), { axis: o.axis, subset });
  }

  /** In-cell bar charts via CSS gradients. `align`: 'left' (default), 'zero' or 'mid'. */
  bar(options: { subset?: Subset; axis?: Axis; color?: string | [string, string]; align?: 'left' | 'zero' | 'mid'; vmin?: number; vmax?: number; width?: number } = {}): this {
    const [neg, pos] = Array.isArray(options.color) ? options.color : [options.color ?? '#e34948', options.color ?? '#2a78d6'];
    const width = (options.width ?? 100) / 100;
    const subset = options.subset ?? this.data.columns.filter((c) => isNumericDType(this.data._column(c).dtype));
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    return this.apply((s: Series) => {
      const nums = s.toArray().map((v) => (typeof v === 'number' ? v : NaN));
      const finite = nums.filter((v) => Number.isFinite(v));
      const lo = options.vmin ?? Math.min(...finite), hi = options.vmax ?? Math.max(...finite);
      const align = options.align ?? 'left';
      const zeroAt = align === 'left' ? 0 : align === 'zero' ? 0.5 : lo >= 0 ? 0 : hi <= 0 ? 1 : -lo / (hi - lo);
      const scale = align === 'zero' ? Math.max(Math.abs(lo), Math.abs(hi)) * 2 : align === 'left' ? hi - lo : hi - Math.min(0, lo) - Math.min(0, -hi) || 1;
      return nums.map((v) => {
        if (!Number.isFinite(v)) return null;
        let start: number, end: number;
        if (align === 'left') { start = 0; end = (v - lo) / (scale || 1); }
        else { const p = zeroAt + v / (scale || 1); start = Math.min(zeroAt, p); end = Math.max(zeroAt, p); }
        start *= width; end *= width;
        const c = v < 0 ? neg : pos;
        return `width: 10em; background: linear-gradient(90deg, transparent ${pct(start)}, ${c} ${pct(start)}, ${c} ${pct(end)}, transparent ${pct(end)});`;
      });
    }, { axis: options.axis, subset });
  }

  // -------------------------------------------------------------- layout

  setCaption(caption: string): this { this.caption = caption; return this; }

  /** CSS rules for the table, e.g. `[{ selector: 'th', props: 'font-weight: bold;' }]`. */
  setTableStyles(styles: readonly { selector: string; props: string | readonly [string, string][] }[], options: { overwrite?: boolean } = {}): this {
    const norm = styles.map((s) => ({ selector: s.selector, props: typeof s.props === 'string' ? s.props : s.props.map(([k, v]) => `${k}: ${v};`).join(' ') }));
    this.tableStyles = options.overwrite === false ? [...this.tableStyles, ...norm] : norm;
    return this;
  }

  setTableAttributes(attributes: string): this { this.tableAttributes = attributes; return this; }
  setUuid(uuid: string): this { this.uuid = uuid; return this; }
  setNaRep(naRep: string): this { this.naRep = naRep; return this; }
  setPrecision(precision: number): this { this.precision = precision; return this; }

  /** Hides the index / header (no subset) or some rows / columns. */
  hide(options: { axis?: 'index' | 'columns' | 0 | 1; subset?: readonly Label[] | readonly string[] } = {}): this {
    const cols = options.axis === 'columns' || options.axis === 1;
    if (!options.subset) {
      if (cols) this.hiddenHeader = true; else this.hiddenIndex = true;
      return this;
    }
    if (cols) for (const j of this.cols(options.subset as readonly string[])) this.hiddenCols.add(j);
    else for (const i of labelPositions(options.subset as readonly Label[], this.data.index)) this.hiddenRows.add(i);
    return this;
  }

  // ------------------------------------------------------------- output

  /** The CSS declarations attached to cell (row i, column j). */
  cellStyle(i: number, j: number): string[] {
    return this.styles.get(`${i},${j}`) ?? [];
  }

  /** HTML (style block + table), like `Styler.to_html()`. */
  toHtml(options: { doctype?: boolean; excludeStyles?: boolean; tableUuid?: string } = {}): string {
    const id = `T_${options.tableUuid ?? this.uuid}`;
    const lines: string[] = [];
    const df = this.data;
    const visibleCols = df.columns.map((_, j) => j).filter((j) => !this.hiddenCols.has(j));
    const visibleRows = Array.from({ length: df.length }, (_, i) => i).filter((i) => !this.hiddenRows.has(i));
    if (!options.excludeStyles) {
      // One rule per distinct declaration list, listing every cell that uses it.
      const groups = new Map<string, string[]>();
      for (const i of visibleRows) for (const j of visibleCols) {
        const decls = this.cellStyle(i, j);
        if (!decls.length) continue;
        const body = decls.map((d) => `  ${d};`).join('\n');
        groups.set(body, [...(groups.get(body) ?? []), `#${id}_row${i}_col${j}`]);
      }
      if (groups.size || this.tableStyles.length) {
        lines.push('<style type="text/css">');
        for (const t of this.tableStyles) lines.push(`#${id} ${t.selector} {\n  ${t.props.replace(/;\s*/g, ';\n  ').trim()}\n}`);
        for (const [body, sels] of groups) lines.push(`${sels.join(', ')} {\n${body}\n}`);
        lines.push('</style>');
      }
    }
    lines.push(`<table id="${id}"${this.tableAttributes ? ' ' + this.tableAttributes : ''}>`);
    if (this.caption !== null) lines.push(`  <caption>${escapeXml(this.caption)}</caption>`);
    const levels = df.nColumnLevels;
    const idxLevels = this.hiddenIndex ? 0 : df.index.nlevels;
    if (!this.hiddenHeader) {
      lines.push('  <thead>');
      for (let l = 0; l < levels; l++) {
        lines.push('    <tr>');
        for (let k = 0; k < idxLevels; k++) lines.push(`      <th class="blank${k === idxLevels - 1 ? ` level${l}` : ''}" >&nbsp;</th>`);
        for (const j of visibleCols) {
          const label = levels > 1 ? colTuple(df.columns[j])[l] : df.columns[j];
          lines.push(`      <th id="${id}_level${l}_col${j}" class="col_heading level${l} col${j}" >${escapeXml(label)}</th>`);
        }
        lines.push('    </tr>');
      }
      const names = df.index.isMulti ? df.index.names! : [df.index.name];
      if (idxLevels && names.some((n) => n !== null)) {
        lines.push('    <tr>');
        names.forEach((n, k) => lines.push(`      <th class="index_name level${k}" >${escapeXml(n ?? '')}</th>`));
        for (const j of visibleCols) lines.push(`      <th class="blank col${j}" >&nbsp;</th>`);
        lines.push('    </tr>');
      }
      lines.push('  </thead>');
    }
    lines.push('  <tbody>');
    for (const i of visibleRows) {
      lines.push('    <tr>');
      if (idxLevels) {
        const lab = df.index.isMulti ? (df.index.labels[i] as readonly Label[]) : [df.index.labels[i]];
        lab.forEach((v, k) => {
          const text = this.indexFormatter ? this.indexFormatter(v) : formatScalar(v);
          lines.push(`      <th id="${id}_level${k}_row${i}" class="row_heading level${k} row${i}" >${escapeXml(text)}</th>`);
        });
      }
      for (const j of visibleCols) lines.push(`      <td id="${id}_row${i}_col${j}" class="data row${i} col${j}" >${escapeXml(this.display(i, j))}</td>`);
      lines.push('    </tr>');
    }
    lines.push('  </tbody>');
    lines.push('</table>');
    const html = lines.join('\n') + '\n';
    return options.doctype ? `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n${html}</body>\n</html>\n` : html;
  }

  /** Same as toHtml(). */
  render(): string {
    return this.toHtml();
  }

  /** Formatted text table (formats applied, styles ignored). */
  toString(options: { delimiter?: string } = {}): string {
    const sep = options.delimiter ?? ' ';
    const cols = this.data.columns.map((_, j) => j).filter((j) => !this.hiddenCols.has(j));
    const rows = Array.from({ length: this.data.length }, (_, i) => i).filter((i) => !this.hiddenRows.has(i));
    const lines = [['', ...cols.map((j) => this.data.columns[j])].join(sep)];
    for (const i of rows) lines.push([formatScalar(this.data.index.labels[i]), ...cols.map((j) => this.display(i, j))].join(sep));
    return lines.join('\n') + '\n';
  }

  /** LaTeX tabular with the display formats, like `Styler.to_latex()`. */
  toLatex(options: { hrules?: boolean; caption?: string; label?: string; position?: string; environment?: 'table' | null; columnFormat?: string } = {}): string {
    const df = this.data;
    const cols = df.columns.map((_, j) => j).filter((j) => !this.hiddenCols.has(j));
    return latexTable(
      this.hiddenIndex ? null : df.index.labels.map((l) => (this.indexFormatter ? this.indexFormatter(l) : formatScalar(l))),
      cols.map((j) => df.columns[j]),
      Array.from({ length: df.length }, (_, i) => i).filter((i) => !this.hiddenRows.has(i)).map((i) => cols.map((j) => this.display(i, j))),
      cols.map((j) => isNumericDType(df._column(df.columns[j]).dtype)),
      { ...options, caption: options.caption ?? this.caption ?? undefined, hrules: options.hrules ?? false },
    );
  }

  /** Writes an .xlsx with background / text colours and bold applied (requires `exceljs`). */
  async toExcel(path?: string, options: { sheetName?: string; index?: boolean } = {}): Promise<Buffer> {
    const { toExcel } = await import('./io/excel.ts');
    const parse = (decls: string[]) => {
      const get = (k: string) => decls.map((d) => d.split(':')).find(([p]) => p.trim() === k)?.[1]?.trim();
      return { fill: get('background-color'), color: get('color'), bold: get('font-weight') === 'bold' };
    };
    return toExcel(this.data, path, { ...options, cellStyle: (i, j) => parse(this.cellStyle(i, j)) });
  }
}

const latexEscape = (s: string) => s.replace(/([\\&%$#_{}~^])/g, (c) => (c === '\\' ? '\\textbackslash ' : c === '~' ? '\\textasciitilde ' : c === '^' ? '\\textasciicircum ' : '\\' + c));

/** Renders a LaTeX tabular (booktabs rules like pandas' `to_latex`). */
export function latexTable(index: string[] | null, header: string[], rows: string[][], numeric: boolean[], o: { hrules?: boolean; caption?: string; label?: string; position?: string; environment?: 'table' | null; columnFormat?: string } = {}): string {
  const fmt = o.columnFormat ?? (index ? 'l' : '') + numeric.map((n) => (n ? 'r' : 'l')).join('');
  const out: string[] = [];
  const wrap = o.caption !== undefined || o.label !== undefined || o.environment === 'table';
  if (wrap) {
    out.push(`\\begin{table}${o.position ? `[${o.position}]` : ''}`);
    if (o.caption !== undefined) out.push(`\\caption{${latexEscape(o.caption)}}`);
    if (o.label !== undefined) out.push(`\\label{${o.label}}`);
  }
  out.push(`\\begin{tabular}{${fmt}}`);
  if (o.hrules !== false) out.push('\\toprule');
  out.push([...(index ? [''] : []), ...header.map(latexEscape)].join(' & ') + ' \\\\');
  if (o.hrules !== false) out.push('\\midrule');
  rows.forEach((r, i) => out.push([...(index ? [latexEscape(index[i])] : []), ...r.map(latexEscape)].join(' & ') + ' \\\\'));
  if (o.hrules !== false) out.push('\\bottomrule');
  out.push('\\end{tabular}');
  if (wrap) out.push('\\end{table}');
  return out.join('\n') + '\n';
}

/** Default cell text for LaTeX / Markdown exports. */
export function exportCell(col: Column, i: number, kind: 'latex' | 'markdown'): string {
  const v = col.get(i);
  if (isNA(v)) return kind === 'latex' ? (col.dtype === 'float64' || col.dtype === 'int64' ? 'NaN' : 'None') : 'nan';
  if (typeof v === 'number') return Number.isInteger(v) && col.dtype !== 'float64' ? String(v) : kind === 'latex' ? v.toFixed(6) : pyFloat(v).replace(/\.0$/, '.0');
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return formatScalar(v);
}
