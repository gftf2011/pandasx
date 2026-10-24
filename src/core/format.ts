import type { Column } from './column.ts';
import type { Index } from './indexes.ts';
import { Period, Timedelta } from './time.ts';
import { Interval } from './interval.ts';
import { formatOffset, toWall, tzOffset } from './tz.ts';
import { NULLABLE_DTYPES, type Label } from './types.ts';

/** Display options, like `pd.options.display` (mutable; see setOption / optionContext). */
export const DISPLAY = {
  /** Rows shown before truncating (pandas `display.max_rows`). */
  maxRows: 60,
  /** Rows shown when truncated. */
  minRows: 10,
  /** Columns shown before truncating (0 = no limit besides `width`). */
  maxColumns: 20,
  /** Decimal places for floats. */
  precision: 6,
  /** Line width; wider frames hide middle columns. */
  width: 80,
  /** Longest cell text before it is cut with '...'. */
  maxColwidth: 50,
  /** Custom float formatter. */
  floatFormat: null as ((v: number) => string) | null,
  /** Floats smaller than this (in absolute value) show as 0. */
  chopThreshold: null as number | null,
  /** Show '[n rows x m columns]': only when truncated ('truncate'), always (true) or never (false). */
  showDimensions: 'truncate' as boolean | 'truncate',
  /** Alignment of column headers. */
  colheaderJustify: 'right' as 'left' | 'right',
};

const DEFAULTS = { ...DISPLAY };
type DisplayKey = keyof typeof DISPLAY;

function optionKey(name: string): DisplayKey {
  const bare = name.replace(/^display\./, '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (!(bare in DISPLAY)) throw new Error(`No such option: ${name}`);
  return bare as DisplayKey;
}

/** Sets an option, e.g. `setOption('display.max_rows', 100)` or `setOption('display.precision', 2)`. */
export function setOption(name: string, value: unknown): void {
  (DISPLAY as Record<string, unknown>)[optionKey(name)] = value;
}

export function getOption(name: string): unknown {
  return DISPLAY[optionKey(name)];
}

/** Restores one option (or 'all') to its default. */
export function resetOption(name: string): void {
  if (name === 'all') Object.assign(DISPLAY, DEFAULTS);
  else { const k = optionKey(name); (DISPLAY as Record<string, unknown>)[k] = DEFAULTS[k]; }
}

/** Runs `fn` with temporary options, like `with pd.option_context(...)`. */
export function optionContext<T>(options: Record<string, unknown>, fn: () => T): T {
  const saved = Object.keys(options).map((k) => [k, getOption(k)] as const);
  for (const [k, v] of Object.entries(options)) setOption(k, v);
  try { return fn(); } finally { for (const [k, v] of saved) setOption(k, v); }
}

/** Cuts long cell text to `maxColwidth`. */
export function clip(s: string): string {
  const m = DISPLAY.maxColwidth;
  return m && s.length > m ? s.slice(0, Math.max(0, m - 3)) + '...' : s;
}

/** Positions to display, with `null` marking the "..." gap. */
export function displayPositions(n: number, max: number, keep: number): (number | null)[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const half = keep >> 1;
  const head = Array.from({ length: half }, (_, i) => i);
  const tail = Array.from({ length: half }, (_, i) => n - half + i);
  return [...head, null, ...tail];
}

function formatDate(t: number, dateOnly: boolean, withMs = false, tz: string | null = null): string {
  const off = tz ? tzOffset(t, tz) : 0;
  const iso = new Date(t + off).toISOString();
  if (dateOnly && !tz) return iso.slice(0, 10);
  return iso.slice(0, withMs ? 23 : 19).replace('T', ' ') + (tz ? formatOffset(off) : '');
}

export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'NaT' : v.toISOString();
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return '(' + v.map(formatScalar).join(', ') + ')';
  if (v instanceof Timedelta || v instanceof Period || v instanceof Interval) return v.toString();
  if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

/** Formats the selected cells of a column so that a column reads uniformly. */
export function formatColumn(col: Column, positions: readonly (number | null)[]): string[] {
  const rows = positions.filter((p): p is number => p !== null);
  let fmt: (p: number) => string;

  const na = NULLABLE_DTYPES.has(col.dtype) ? '<NA>' : 'NaN';
  if (col.dtype === 'float64' || col.dtype === 'Float64') {
    // display.chop_threshold applies before the number of decimals is chosen, like pandas.
    const chop = DISPLAY.chopThreshold;
    const raw = col.data as Float64Array;
    const data = chop === null ? raw : raw.map((v) => (Math.abs(v) < chop ? 0 : v));
    let decimals = 1;
    let exp = false;
    for (const p of rows) {
      const v = data[p];
      if (!Number.isFinite(v) || v === 0) continue;
      const a = Math.abs(v);
      if (a >= 1e16 || a < 1e-5) { exp = true; break; }
      for (let d = 0; d <= DISPLAY.precision; d++) {
        if (Number(v.toFixed(d)) === Number(v.toFixed(DISPLAY.precision))) { decimals = Math.max(decimals, d); break; }
      }
    }
    fmt = (p) => {
      const v = data[p];
      if (Number.isNaN(v)) return na;
      if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
      if (DISPLAY.floatFormat) return DISPLAY.floatFormat(v);
      return exp ? v.toExponential(DISPLAY.precision) : v.toFixed(decimals);
    };
  } else if (col.dtype === 'datetime') {
    const data = col.data as Float64Array;
    const tz = col.meta.tz ?? null;
    const dateOnly = rows.every((p) => Number.isNaN(data[p]) || data[p] % 86_400_000 === 0);
    const withMs = rows.some((p) => data[p] === data[p] && data[p] % 1000 !== 0);
    fmt = (p) => (Number.isNaN(data[p]) ? 'NaT' : formatDate(data[p], dateOnly, withMs, tz));
  } else if (col.dtype === 'Int64' || col.dtype === 'boolean') {
    fmt = (p) => (col.isNA(p) ? na : formatScalar(col.get(p)));
  } else if (col.dtype === 'timedelta' || col.dtype === 'period') {
    fmt = (p) => (col.isNA(p) ? 'NaT' : formatScalar(col.get(p)));
  } else if (col.dtype === 'category') {
    fmt = (p) => (col.isNA(p) ? 'NaN' : formatScalar(col.get(p)));
  } else {
    fmt = (p) => clip(formatScalar(col.get(p)));
  }
  return positions.map((p) => (p === null ? '...' : fmt(p)));
}

/** One string column per index level. */
export function formatIndex(index: Index, positions: readonly (number | null)[]): string[][] {
  const levels = index.nlevels;
  const out: string[][] = Array.from({ length: levels }, () => []);
  const at = (p: number, l: number): Label => (levels > 1 ? (index.labels[p] as readonly Label[])[l] : index.labels[p]);
  // Dates in one level share a format, like pandas: date-only when every label is midnight.
  const shown = positions.filter((p): p is number => p !== null);
  const dateFormat = Array.from({ length: levels }, (_, l) => {
    const times = shown.map((p) => at(p, l)).filter((v): v is Date => v instanceof Date && !Number.isNaN(v.getTime())).map((d) => d.getTime());
    return { dateOnly: times.every((t) => toWall(t, index.tz) % 86_400_000 === 0), withMs: times.some((t) => t % 1000 !== 0) };
  });
  for (const p of positions) {
    for (let l = 0; l < levels; l++) {
      if (p === null) { out[l].push('...'); continue; }
      const v = at(p, l);
      if (v instanceof Date) out[l].push(Number.isNaN(v.getTime()) ? 'NaT' : formatDate(v.getTime(), dateFormat[l].dateOnly, dateFormat[l].withMs, index.tz));
      else out[l].push(formatScalar(v));
    }
  }
  return out;
}

/**
 * Renders a text table. `left` columns (the index) are left-aligned and all
 * others right-aligned, like pandas. Header rows that are entirely blank are skipped.
 * `compact` is pandas' index=False layout (each column prefixed by one space).
 */
export function renderTable(headers: readonly (readonly string[])[] | null, columns: string[][], leftCount: number, compact = false): string {
  const rows = (headers ?? []).filter((h) => h.some((c) => c !== ''));
  const widths = columns.map((c, j) => Math.max(...rows.map((h) => h[j]?.length ?? 0), ...c.map((s) => s.length), 0));
  const pad = (s: string, j: number) => (j < leftCount ? s.padEnd(widths[j]) : s.padStart(widths[j]));
  const line = (cells: readonly string[]) => (compact ? cells.map((c, j) => ' ' + pad(c, j)).join('') : cells.map(pad).join('  ')).trimEnd();
  const lines = rows.map(line);
  const nrows = columns[0]?.length ?? 0;
  for (let i = 0; i < nrows; i++) lines.push(line(columns.map((c) => c[i])));
  return lines.join('\n');
}
