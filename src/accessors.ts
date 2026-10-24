import { Column } from './core/column.ts';
import type { DType, Label } from './core/types.ts';
import { toOffset } from './core/offsets.ts';
import { isoWeek, strftime } from './core/strftime.ts';
import { normalizeFreq, periodOrdinal, periodStart, Timedelta } from './core/time.ts';
import { checkTimeZone, fromWall, toWall, tzOffset, type Ambiguous, type Nonexistent } from './core/tz.ts';
import { Index } from './core/indexes.ts';
import { DataFrame } from './frame.ts';
import { hashKey, isNA } from './core/values.ts';
import { Series } from './series.ts';

/** Vectorised string functions (`series.str`). Missing values stay missing. */
export class StringMethods {
  private readonly s: Series;

  constructor(s: Series) {
    if (s.dtype !== 'string' && s.dtype !== 'object' && s.dtype !== 'category') {
      throw new TypeError(`.str accessor requires string values, got ${s.dtype}`);
    }
    this.s = s;
  }

  private map(fn: (v: string) => unknown, dtype?: DType, na: unknown = undefined): Series {
    const col = this.s._col;
    // pandas 3: boolean predicates on the string dtype give False for missing values.
    if (na === undefined) na = dtype === 'bool' && this.s.dtype === 'string' ? false : null;
    const out = new Array(col.length);
    let missing = false;
    for (let i = 0; i < out.length; i++) {
      const v = col.get(i);
      if (isNA(v)) { out[i] = na; if (isNA(na)) missing = true; } else out[i] = fn(String(v));
    }
    // A boolean/int result with missing values must fall back to inference (object/float).
    return Series._from(Column.from(out, missing && (dtype === 'bool' || dtype === 'int64') ? undefined : dtype), this.s.index, this.s.name);
  }

  /** Builds a DataFrame from per-row arrays (used by `expand`). */
  private frame(rows: (readonly unknown[] | null)[], names?: readonly string[]): DataFrame {
    const width = names?.length ?? Math.max(0, ...rows.map((r) => r?.length ?? 0));
    const cols = new Map<string, Column>();
    for (let j = 0; j < width; j++) cols.set(names?.[j] ?? String(j), Column.from(rows.map((r) => (r ? (r[j] ?? null) : null))));
    return DataFrame._fromColumns(cols, this.s.index);
  }

  private rows(fn: (v: string) => readonly unknown[] | null): (readonly unknown[] | null)[] {
    return this.s._col.toArray().map((v) => (isNA(v) ? null : fn(String(v))));
  }

  // case
  lower(): Series { return this.map((v) => v.toLowerCase(), 'string'); }
  upper(): Series { return this.map((v) => v.toUpperCase(), 'string'); }
  casefold(): Series { return this.map((v) => v.toLocaleLowerCase('und').normalize('NFKC'), 'string'); }
  capitalize(): Series { return this.map((v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(), 'string'); }
  /** Python `str.title`: a letter is capitalised after any non-letter. */
  title(): Series { return this.map((v) => v.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()), 'string'); }
  swapcase(): Series { return this.map((v) => [...v].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''), 'string'); }
  /** Unicode normalisation form: 'NFC', 'NFKC', 'NFD' or 'NFKD'. */
  normalize(form: 'NFC' | 'NFKC' | 'NFD' | 'NFKD'): Series { return this.map((v) => v.normalize(form), 'string'); }

  // whitespace / padding
  strip(chars?: string): Series { return this.map((v) => (chars ? trimChars(v, chars, true, true) : v.trim()), 'string'); }
  lstrip(chars?: string): Series { return this.map((v) => (chars ? trimChars(v, chars, true, false) : v.trimStart()), 'string'); }
  rstrip(chars?: string): Series { return this.map((v) => (chars ? trimChars(v, chars, false, true) : v.trimEnd()), 'string'); }
  removeprefix(prefix: string): Series { return this.map((v) => (v.startsWith(prefix) ? v.slice(prefix.length) : v), 'string'); }
  removesuffix(suffix: string): Series { return this.map((v) => (suffix && v.endsWith(suffix) ? v.slice(0, -suffix.length) : v), 'string'); }

  pad(width: number, side: 'left' | 'right' | 'both' = 'left', fillchar = ' '): Series {
    return this.map((v) => {
      if (side === 'left') return v.padStart(width, fillchar);
      if (side === 'right') return v.padEnd(width, fillchar);
      // CPython's str.center rule for where the odd fill character goes.
      const marg = Math.max(0, width - v.length);
      const left = Math.floor(marg / 2) + (marg & width & 1);
      return fillchar.repeat(left) + v + fillchar.repeat(marg - left);
    }, 'string');
  }
  center(width: number, fillchar = ' '): Series { return this.pad(width, 'both', fillchar); }
  ljust(width: number, fillchar = ' '): Series { return this.pad(width, 'right', fillchar); }
  rjust(width: number, fillchar = ' '): Series { return this.pad(width, 'left', fillchar); }
  zfill(width: number): Series {
    return this.map((v) => {
      const sign = v[0] === '-' || v[0] === '+' ? v[0] : '';
      return sign + v.slice(sign.length).padStart(width - sign.length, '0');
    }, 'string');
  }
  /** Wraps long strings at `width` characters, joining lines with '\n'. */
  wrap(width: number): Series {
    return this.map((v) => {
      const lines: string[] = [];
      let line = '';
      for (const word of v.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > width) { lines.push(line); line = ''; }
        let w = word;
        while (w.length > width) { if (line) { lines.push(line); line = ''; } lines.push(w.slice(0, width)); w = w.slice(width); }
        line = line ? `${line} ${w}` : w;
      }
      if (line) lines.push(line);
      return lines.join('\n');
    }, 'string');
  }

  // measurement / predicates
  len(): Series { return this.map((v) => [...v].length, 'int64'); }

  /** Regex test like pandas (`regex: false` for a plain substring); `na` fills missing values. */
  contains(pat: string | RegExp, options: { case?: boolean; regex?: boolean; flags?: string; na?: unknown } = {}): Series {
    const caseSensitive = options.case ?? true;
    const regex = options.regex ?? true;
    if (regex) {
      const re = toRegExp(pat, (caseSensitive ? '' : 'i') + (options.flags ?? ''));
      return this.map((v) => { re.lastIndex = 0; return re.test(v); }, 'bool', options.na);
    }
    const needle = caseSensitive ? String(pat) : String(pat).toLowerCase();
    return this.map((v) => (caseSensitive ? v : v.toLowerCase()).includes(needle), 'bool', options.na);
  }
  /** Regex anchored at the start. */
  match(pat: string | RegExp, options: { case?: boolean; na?: unknown } = {}): Series {
    const re = toRegExp(pat, options.case === false ? 'i' : '');
    return this.map((v) => { const m = re.exec(v); return m !== null && m.index === 0; }, 'bool', options.na);
  }
  /** Regex matching the whole string. */
  fullmatch(pat: string | RegExp, options: { case?: boolean; na?: unknown } = {}): Series {
    const src = pat instanceof RegExp ? pat.source : pat;
    const re = new RegExp(`^(?:${src})$`, (pat instanceof RegExp ? pat.flags.replace('g', '') : '') + (options.case === false ? 'i' : ''));
    return this.map((v) => re.test(v), 'bool', options.na);
  }
  startswith(prefix: string | readonly string[], options: { na?: unknown } = {}): Series {
    const ps = typeof prefix === 'string' ? [prefix] : prefix;
    return this.map((v) => ps.some((p) => v.startsWith(p)), 'bool', options.na);
  }
  endswith(suffix: string | readonly string[], options: { na?: unknown } = {}): Series {
    const ps = typeof suffix === 'string' ? [suffix] : suffix;
    return this.map((v) => ps.some((p) => v.endsWith(p)), 'bool', options.na);
  }
  isalnum(): Series { return this.map((v) => /^[\p{L}\p{N}]+$/u.test(v), 'bool'); }
  isalpha(): Series { return this.map((v) => /^\p{L}+$/u.test(v), 'bool'); }
  isdecimal(): Series { return this.map((v) => /^\p{Nd}+$/u.test(v), 'bool'); }
  isdigit(): Series { return this.map((v) => /^[\p{Nd}²³¹⁰-⁹]+$/u.test(v), 'bool'); }
  isnumeric(): Series { return this.map((v) => /^\p{N}+$/u.test(v), 'bool'); }
  isspace(): Series { return this.map((v) => /^\s+$/.test(v), 'bool'); }
  islower(): Series { return this.map((v) => /\p{L}/u.test(v) && v === v.toLowerCase(), 'bool'); }
  isupper(): Series { return this.map((v) => /\p{L}/u.test(v) && v === v.toUpperCase(), 'bool'); }
  istitle(): Series { return this.map((v) => /\p{L}/u.test(v) && v === new Series([v]).str.title().iat(0), 'bool'); }

  // searching
  count(pat: string | RegExp): Series {
    const re = toRegExp(pat, 'g');
    return this.map((v) => (v.match(re) ?? []).length, 'int64');
  }
  find(sub: string, start = 0, end?: number): Series {
    return this.map((v) => { const i = v.slice(0, end).indexOf(sub, start); return i; }, 'int64');
  }
  rfind(sub: string, start = 0, end?: number): Series {
    return this.map((v) => { const i = v.slice(0, end).lastIndexOf(sub); return i >= start ? i : -1; }, 'int64');
  }
  /** Like `find` but throws when not found. */
  index(sub: string, start = 0, end?: number): Series {
    return this.map((v) => { const i = v.slice(0, end).indexOf(sub, start); if (i < 0) throw new Error('substring not found'); return i; }, 'int64');
  }
  rindex(sub: string, start = 0, end?: number): Series {
    return this.map((v) => { const i = v.slice(0, end).lastIndexOf(sub); if (i < start) throw new Error('substring not found'); return i; }, 'int64');
  }
  /** All matches of `pat` per element (arrays). */
  findall(pat: string | RegExp): Series {
    const re = toRegExp(pat, 'g');
    return this.map((v) => [...v.matchAll(re)].map((m) => (m.length > 2 ? m.slice(1) : m[1] ?? m[0])), 'object');
  }

  /**
   * Capture groups of the first match. With `expand` (default) returns a DataFrame
   * (named groups become column names); with one group and `expand: false` a Series.
   */
  extract(pat: RegExp | string, options?: { expand?: true }): DataFrame;
  extract(pat: RegExp | string, options: { expand: false }): Series;
  extract(pat: RegExp | string, options: { expand?: boolean } = {}): DataFrame | Series {
    const re = toRegExp(pat, '');
    const groupNames = groupNamesOf(re);
    if (options.expand === false) {
      return this.map((v) => { const m = v.match(re); return m ? (m[1] ?? m[0]) : null; }, 'string');
    }
    const rows = this.rows((v) => { const m = v.match(re); return m ? (m.length > 1 ? m.slice(1) : [m[0]]) : []; });
    const df = this.frame(rows.map((r) => (r && r.length ? r : null)), groupNames);
    return df.astype('string');
  }

  /** Every match's groups, one row per match, indexed by (original label, match number). */
  extractall(pat: RegExp | string): DataFrame {
    const re = toRegExp(pat, 'g');
    const labels: Label[] = [];
    const rows: unknown[][] = [];
    this.s._col.toArray().forEach((v, i) => {
      if (isNA(v)) return;
      let k = 0;
      for (const m of String(v).matchAll(re)) {
        labels.push([this.s.index.labels[i], k++]);
        rows.push(m.length > 1 ? m.slice(1) : [m[0]]);
      }
    });
    const names = groupNamesOf(re) ?? Array.from({ length: rows[0]?.length ?? 0 }, (_, j) => String(j));
    const cols = new Map(names.map((n, j) => [n, Column.from(rows.map((r) => r[j] ?? null), 'string')]));
    return DataFrame._fromColumns(cols, new Index(labels, { names: [this.s.index.name, 'match'] }));
  }

  // transforming
  /** Replaces occurrences; `regex` defaults to true for RegExp patterns. `n` limits replacements. */
  replace(pat: string | RegExp, repl: string | ((match: string, ...groups: string[]) => string), options: { regex?: boolean; case?: boolean; n?: number } = {}): Series {
    const regex = options.regex ?? (pat instanceof RegExp);
    const n = options.n ?? -1;
    if (!regex && options.case !== false) {
      const p = String(pat);
      return this.map((v) => {
        if (n < 0) return typeof repl === 'string' ? v.split(p).join(repl) : v.split(p).join(repl(p));
        let out = v;
        let from = 0;
        for (let k = 0; k < n; k++) {
          const i = out.indexOf(p, from);
          if (i < 0) break;
          const r = typeof repl === 'string' ? repl : repl(p);
          out = out.slice(0, i) + r + out.slice(i + p.length);
          from = i + r.length;
        }
        return out;
      }, 'string');
    }
    const re = toRegExp(regex ? pat : escapeRegExp(String(pat)), (options.case === false ? 'i' : '') + (n < 0 ? 'g' : 'g'));
    return this.map((v) => {
      let count = 0;
      return v.replace(re, (...args: unknown[]) => {
        if (n >= 0 && count >= n) return args[0] as string;
        count++;
        if (typeof repl === 'function') return repl(...(args.slice(0, -2) as [string, ...string[]]));
        return (args[0] as string).replace(new RegExp(re.source, re.flags.replace('g', '')), repl);
      });
    }, 'string');
  }
  slice(start?: number, stop?: number, step = 1): Series {
    return this.map((v) => {
      if (step === 1) return v.slice(start, stop);
      const chars = [...v];
      const pos = slicePositions(chars.length, start, stop, step);
      return pos.map((p) => chars[p]).join('');
    }, 'string');
  }
  sliceReplace(start?: number, stop?: number, repl = ''): Series {
    return this.map((v) => v.slice(0, start ?? 0) + repl + v.slice(stop ?? v.length), 'string');
  }
  repeat(n: number): Series { return this.map((v) => v.repeat(n), 'string'); }
  /** Maps characters through a table `{char: replacement | null}`. */
  translate(table: Record<string, string | null>): Series {
    return this.map((v) => [...v].map((c) => (Object.hasOwn(table, c) ? (table[c] ?? '') : c)).join(''), 'string');
  }

  // splitting / joining
  /**
   * Splits each string (whitespace by default). With `expand` returns a DataFrame
   * with one column per part; `n` limits the number of splits.
   */
  split(pat?: string | RegExp, options?: { n?: number; expand?: false; regex?: boolean }): Series;
  split(pat: string | RegExp | undefined, options: { n?: number; expand: true; regex?: boolean }): DataFrame;
  split(pat?: string | RegExp, options: { n?: number; expand?: boolean; regex?: boolean } = {}): Series | DataFrame {
    const n = options.n ?? -1;
    const fn = (v: string) => splitLimited(v, pat, n, options.regex);
    return options.expand ? this.frame(this.rows(fn)) : this.map(fn, 'object');
  }
  /** Splits from the right. */
  rsplit(pat?: string, options?: { n?: number; expand?: false }): Series;
  rsplit(pat: string | undefined, options: { n?: number; expand: true }): DataFrame;
  rsplit(pat?: string, options: { n?: number; expand?: boolean } = {}): Series | DataFrame {
    const n = options.n ?? -1;
    const fn = (v: string) => {
      const parts = pat === undefined ? v.trim().split(/\s+/) : v.split(pat);
      if (n < 0 || parts.length <= n + 1) return parts;
      const sep = pat ?? ' ';
      return [parts.slice(0, parts.length - n).join(sep), ...parts.slice(parts.length - n)];
    };
    return options.expand ? this.frame(this.rows(fn)) : this.map(fn, 'object');
  }
  /** Splits at the first `sep` into [before, sep, after]. */
  partition(sep = ' ', options: { expand?: boolean } = {}): DataFrame | Series {
    const fn = (v: string) => { const i = v.indexOf(sep); return i < 0 ? [v, '', ''] : [v.slice(0, i), sep, v.slice(i + sep.length)]; };
    return options.expand === false ? this.map(fn, 'object') : this.frame(this.rows(fn));
  }
  rpartition(sep = ' ', options: { expand?: boolean } = {}): DataFrame | Series {
    const fn = (v: string) => { const i = v.lastIndexOf(sep); return i < 0 ? ['', '', v] : [v.slice(0, i), sep, v.slice(i + sep.length)]; };
    return options.expand === false ? this.map(fn, 'object') : this.frame(this.rows(fn));
  }
  /** Element `i` of each array/string (e.g. after `split`). */
  get(i: number): Series {
    const col = this.s._col;
    return Series._from(col.map((v) => {
      if (isNA(v)) return null;
      const arr = typeof v === 'string' ? [...v] : (v as ArrayLike<unknown>);
      return arr[i < 0 ? arr.length + i : i] ?? null;
    }), this.s.index, this.s.name);
  }
  /** Joins array elements (e.g. after `split`) with `sep`. */
  join(sep: string): Series {
    return Series._from(this.s._col.map((v) => (isNA(v) ? null : Array.isArray(v) ? v.join(sep) : [...String(v)].join(sep)), 'string'), this.s.index, this.s.name);
  }
  /** Concatenates all values (`others` omitted) or element-wise with other Series/arrays. */
  cat(): string;
  cat(options: { sep?: string; naRep?: string }): string;
  cat(others: Series | readonly unknown[] | readonly (Series | readonly unknown[])[], options?: { sep?: string; naRep?: string }): Series;
  cat(a?: unknown, b: { sep?: string; naRep?: string } = {}): string | Series {
    const isOthers = a instanceof Series || Array.isArray(a);
    const opts = (isOthers ? b : (a as { sep?: string; naRep?: string } | undefined)) ?? {};
    const sep = opts.sep ?? '';
    if (!isOthers) {
      return this.s._col.toArray().filter((v) => !isNA(v) || opts.naRep !== undefined).map((v) => (isNA(v) ? opts.naRep : String(v))).join(sep);
    }
    const list = (a instanceof Series || (Array.isArray(a) && !(a[0] instanceof Series) && !Array.isArray(a[0])) ? [a] : a) as (Series | readonly unknown[])[];
    const cols = list.map((o) => (o instanceof Series ? o.reindex(this.s.index.labels)._col.toArray() : [...o]));
    const own = this.s._col.toArray();
    const out = own.map((v, i) => {
      const parts = [v, ...cols.map((c) => c[i])];
      if (parts.some(isNA) && opts.naRep === undefined) return null;
      return parts.map((p) => (isNA(p) ? opts.naRep : String(p))).join(sep);
    });
    return Series._from(Column.from(out, 'string'), this.s.index, this.s.name);
  }
  /** One indicator column per distinct value of `sep`-separated tokens. */
  getDummies(sep = '|'): DataFrame {
    const rows = this.s._col.toArray().map((v) => (isNA(v) ? [] : String(v).split(sep)));
    const tokens = [...new Set(rows.flat())].sort();
    const cols = new Map(tokens.map((t) => [t, Column.from(rows.map((r) => (r.includes(t) ? 1 : 0)), 'int64')]));
    return DataFrame._fromColumns(cols, this.s.index);
  }

  // bytes
  /** Encodes strings to Buffers. */
  encode(encoding: BufferEncoding = 'utf8'): Series {
    return this.map((v) => Buffer.from(v, encoding), 'object');
  }
  /** Decodes Buffers / Uint8Arrays to strings. */
  decode(encoding: BufferEncoding = 'utf8'): Series {
    return Series._from(this.s._col.map((v) => (isNA(v) ? null : Buffer.from(v as Uint8Array).toString(encoding)), 'string'), this.s.index, this.s.name);
  }
}

function toRegExp(pat: string | RegExp, extraFlags: string): RegExp {
  const src = pat instanceof RegExp ? pat.source : pat;
  const flags = new Set([...(pat instanceof RegExp ? pat.flags : ''), ...extraFlags]);
  if (!flags.has('u') && /\\p\{/.test(src)) flags.add('u');
  return new RegExp(src, [...flags].join(''));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groupNamesOf(re: RegExp): string[] | undefined {
  const names = [...re.source.matchAll(/\(\?<([A-Za-z_][\w]*)>/g)].map((m) => m[1]);
  return names.length ? names : undefined;
}

function splitLimited(v: string, pat: string | RegExp | undefined, n: number, regex?: boolean): string[] {
  if (pat === undefined) {
    const parts = v.trim().split(/\s+/);
    return n < 0 || parts.length <= n + 1 ? parts : [...parts.slice(0, n), parts.slice(n).join(' ')];
  }
  const re = pat instanceof RegExp || regex ? toRegExp(pat, 'g') : null;
  if (!re) {
    const parts = v.split(pat as string);
    return n < 0 || parts.length <= n + 1 ? parts : [...parts.slice(0, n), parts.slice(n).join(pat as string)];
  }
  const out: string[] = [];
  let last = 0;
  for (const m of v.matchAll(re)) {
    if (n >= 0 && out.length >= n) break;
    out.push(v.slice(last, m.index));
    last = m.index! + m[0].length;
  }
  out.push(v.slice(last));
  return out;
}

function slicePositions(len: number, start: number | undefined, stop: number | undefined, step: number): number[] {
  const norm = (v: number | undefined, d: number) => (v === undefined ? d : v < 0 ? Math.max(len + v, -1) : Math.min(v, len));
  const out: number[] = [];
  if (step > 0) for (let i = norm(start, 0); i < norm(stop, len); i += step) out.push(i);
  else for (let i = norm(start, len - 1); i > norm(stop, -1); i += step) out.push(i);
  return out;
}

function trimChars(v: string, chars: string, left: boolean, right: boolean): string {
  let a = 0, b = v.length;
  if (left) while (a < b && chars.includes(v[a])) a++;
  if (right) while (b > a && chars.includes(v[b - 1])) b--;
  return v.slice(a, b);
}

/**
 * Datetime-like properties (`series.dt`) for `datetime` (in the series' time
 * zone, UTC when naive), `timedelta` and `period` values.
 */
export class DatetimeMethods {
  private readonly s: Series;

  constructor(s: Series) {
    if (s.dtype !== 'datetime' && s.dtype !== 'timedelta' && s.dtype !== 'period') {
      throw new TypeError(`.dt accessor requires datetime-like values, got ${s.dtype}`);
    }
    this.s = s;
  }

  private get data(): Float64Array {
    return this.s._col.data as Float64Array;
  }

  private get tzName(): string | null {
    return this.s._col.meta.tz ?? null;
  }

  /** Wall-clock ms of each element (period → start time). */
  private wall(i: number): number {
    const t = this.data[i];
    if (t !== t) return NaN;
    if (this.s.dtype === 'period') return periodStart(t, this.s._col.meta.freq!);
    return toWall(t, this.tzName);
  }

  private require(...dtypes: DType[]): void {
    if (!dtypes.includes(this.s.dtype)) throw new TypeError(`This .dt property is not available for ${this.s.dtype}`);
  }

  private field(fn: (wall: number, i: number) => number): Series {
    const out = new Float64Array(this.data.length);
    let missing = false;
    for (let i = 0; i < out.length; i++) {
      const w = this.s.dtype === 'timedelta' ? this.data[i] : this.wall(i);
      if (w !== w) { out[i] = NaN; missing = true; } else out[i] = fn(w, i);
    }
    return Series._from(new Column(missing ? 'float64' : 'int64', out), this.s.index, this.s.name);
  }

  private flag(fn: (wall: number) => boolean): Series {
    const out = new Uint8Array(this.data.length);
    for (let i = 0; i < out.length; i++) { const w = this.wall(i); out[i] = w === w && fn(w) ? 1 : 0; }
    return Series._from(new Column('bool', out), this.s.index, this.s.name);
  }

  private datetimeFrom(fn: (wall: number) => number): Series {
    const tz = this.tzName;
    const out = new Float64Array(this.data.length);
    for (let i = 0; i < out.length; i++) {
      const w = this.wall(i);
      out[i] = w !== w ? NaN : tz ? fromWall(fn(w), tz, 'earliest', 'shift_forward') : fn(w);
    }
    return Series._from(new Column('datetime', out, { tz }), this.s.index, this.s.name);
  }

  // --------------------------------------------------------------- components

  get year(): Series { this.require('datetime', 'period'); return this.field((w) => new Date(w).getUTCFullYear()); }
  get month(): Series { this.require('datetime', 'period'); return this.field((w) => new Date(w).getUTCMonth() + 1); }
  get day(): Series { this.require('datetime', 'period'); return this.field((w) => new Date(w).getUTCDate()); }
  get hour(): Series { this.require('datetime', 'period'); return this.field((w) => new Date(w).getUTCHours()); }
  get minute(): Series { this.require('datetime', 'period'); return this.field((w) => new Date(w).getUTCMinutes()); }
  get second(): Series { this.require('datetime', 'period'); return this.field((w) => new Date(w).getUTCSeconds()); }
  get millisecond(): Series { this.require('datetime'); return this.field((w) => new Date(w).getUTCMilliseconds()); }
  get microsecond(): Series { this.require('datetime'); return this.field((w) => new Date(w).getUTCMilliseconds() * 1000); }
  get nanosecond(): Series { return this.field(() => 0); }
  /** Monday = 0 … Sunday = 6, as in pandas. */
  get dayofweek(): Series { this.require('datetime', 'period'); return this.field((w) => (new Date(w).getUTCDay() + 6) % 7); }
  get weekday(): Series { return this.dayofweek; }
  get dayofyear(): Series {
    this.require('datetime', 'period');
    return this.field((w) => Math.floor((w - Date.UTC(new Date(w).getUTCFullYear(), 0, 1)) / 86_400_000) + 1);
  }
  get quarter(): Series { this.require('datetime', 'period'); return this.field((w) => Math.floor(new Date(w).getUTCMonth() / 3) + 1); }
  get daysInMonth(): Series {
    this.require('datetime', 'period');
    return this.field((w) => { const d = new Date(w); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); });
  }
  get isMonthStart(): Series { return this.flag((w) => new Date(w).getUTCDate() === 1); }
  get isMonthEnd(): Series { return this.flag((w) => new Date(w + 86_400_000).getUTCDate() === 1); }
  get isQuarterStart(): Series { return this.flag((w) => { const d = new Date(w); return d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0; }); }
  get isQuarterEnd(): Series { return this.flag((w) => { const d = new Date(w + 86_400_000); return d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0; }); }
  get isYearStart(): Series { return this.flag((w) => { const d = new Date(w); return d.getUTCDate() === 1 && d.getUTCMonth() === 0; }); }
  get isYearEnd(): Series { return this.flag((w) => { const d = new Date(w); return d.getUTCDate() === 31 && d.getUTCMonth() === 11; }); }
  get isLeapYear(): Series { return this.flag((w) => { const y = new Date(w).getUTCFullYear(); return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }); }

  /** ISO calendar: DataFrame with year, week, day. */
  isocalendar(): DataFrame {
    const rows = Array.from({ length: this.data.length }, (_, i) => { const w = this.wall(i); return w === w ? isoWeek(w) : null; });
    const col = (k: number) => Column.from(rows.map((r) => (r ? r[k] : null)), rows.some((r) => !r) ? 'Int64' : 'int64');
    return DataFrame._fromColumns(new Map([['year', col(0)], ['week', col(1)], ['day', col(2)]]), this.s.index);
  }

  /** Date part as 'YYYY-MM-DD' strings. */
  get date(): Series { return this.strftime('%Y-%m-%d'); }
  /** Time part as 'HH:MM:SS' strings. */
  get time(): Series { return this.strftime('%H:%M:%S'); }

  dayName(locale = 'en-US'): Series {
    const f = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    return this.names(f);
  }

  monthName(locale = 'en-US'): Series {
    const f = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    return this.names(f);
  }

  private names(f: Intl.DateTimeFormat): Series {
    const out = Array.from({ length: this.data.length }, (_, i) => { const w = this.wall(i); return w === w ? f.format(new Date(w)) : null; });
    return Series._from(Column.from(out, 'string'), this.s.index, this.s.name);
  }

  // ------------------------------------------------------------- conversions

  /** Truncates to midnight (wall clock). */
  normalize(): Series { this.require('datetime'); return this.datetimeFrom((w) => Math.floor(w / 86_400_000) * 86_400_000); }

  /** Rounds down to a multiple of a fixed frequency ('h', '15min', 'D', ...). */
  floor(freq: string): Series { return this.roundTo(freq, Math.floor); }
  ceil(freq: string): Series { return this.roundTo(freq, Math.ceil); }
  round(freq: string): Series { return this.roundTo(freq, roundHalfEven); }

  private roundTo(freq: string, f: (x: number) => number): Series {
    const off = toOffset(freq);
    if (off.kind !== 'tick') throw new Error(`${freq} is a non-fixed frequency`);
    const step = off.tickMs * off.n;
    if (this.s.dtype === 'timedelta') {
      return Series._from(new Column('timedelta', this.data.map((v) => (v !== v ? NaN : f(v / step) * step))), this.s.index, this.s.name);
    }
    this.require('datetime');
    return this.datetimeFrom((w) => f(w / step) * step);
  }

  /** Formats with Python strftime directives (%Y %m %d %H %M %S %f %a %A %b %B %p %j %z %Z ...). */
  strftime(format: string): Series {
    this.require('datetime', 'period');
    const tz = this.tzName;
    const out = Array.from({ length: this.data.length }, (_, i) => {
      const w = this.wall(i);
      if (w !== w) return null;
      return strftime(w, format, tz ? tzOffset(this.data[i], tz) : null, tz);
    });
    return Series._from(Column.from(out, 'string'), this.s.index, this.s.name);
  }

  /** Converts datetimes to periods of `freq` ('D', 'M', 'Q', 'Y', 'W', 'h', ...). */
  toPeriod(freq = 'D'): Series {
    this.require('datetime');
    const f = normalizeFreq(freq);
    const out = Float64Array.from({ length: this.data.length }, (_, i) => periodOrdinal(this.wall(i), f));
    return Series._from(new Column('period', out, { freq: f }), this.s.index, this.s.name);
  }

  /** Periods → datetimes at the start (default) or end of each period. */
  toTimestamp(how: 'start' | 'end' = 'start'): Series {
    this.require('period');
    const f = this.s._col.meta.freq!;
    const out = this.data.map((o) => (o !== o ? NaN : how === 'start' ? periodStart(o, f) : periodStart(o + 1, f) - 1));
    return Series._from(new Column('datetime', out), this.s.index, this.s.name);
  }

  get startTime(): Series { return this.toTimestamp('start'); }
  get endTime(): Series { return this.toTimestamp('end'); }
  get freq(): string | null { return this.s._col.meta.freq ?? null; }

  /** Datetimes as JS Date objects (instants). */
  toDates(): (Date | null)[] {
    return Array.from(this.data, (t) => (t !== t ? null : new Date(t)));
  }

  // --------------------------------------------------------------- time zones

  get tz(): string | null { return this.tzName; }

  /**
   * Interprets naive wall times as local time in `tz` (or drops the zone with
   * `null`, keeping wall times). DST ambiguities follow `ambiguous` / `nonexistent`.
   */
  tzLocalize(tz: string | null, options: { ambiguous?: Ambiguous; nonexistent?: Nonexistent } = {}): Series {
    this.require('datetime');
    if (tz === null) {
      const cur = this.tzName;
      const out = this.data.map((t) => (t !== t ? NaN : toWall(t, cur)));
      return Series._from(new Column('datetime', out), this.s.index, this.s.name);
    }
    if (this.tzName) throw new TypeError('Already tz-aware, use tzConvert to convert');
    checkTimeZone(tz);
    const out = this.data.map((t) => fromWall(t, tz, options.ambiguous, options.nonexistent));
    return Series._from(new Column('datetime', out, { tz }), this.s.index, this.s.name);
  }

  /** Views the same instants in another zone. */
  tzConvert(tz: string | null): Series {
    this.require('datetime');
    if (!this.tzName) throw new TypeError('Cannot convert tz-naive timestamps, use tzLocalize to localize');
    if (tz) checkTimeZone(tz);
    return Series._from(new Column('datetime', this.data, { tz: tz ?? 'UTC' }), this.s.index, this.s.name);
  }

  // ---------------------------------------------------------------- timedelta

  /** Whole days (timedelta), floored like pandas. */
  get days(): Series { this.require('timedelta'); return this.field((ms) => Math.floor(ms / 86_400_000)); }
  /** Seconds within the day (timedelta). */
  get seconds(): Series { this.require('timedelta'); return this.field((ms) => Math.floor((ms - Math.floor(ms / 86_400_000) * 86_400_000) / 1000)); }
  get microseconds(): Series { this.require('timedelta'); return this.field((ms) => Math.round((((ms % 1000) + 1000) % 1000) * 1000)); }
  get nanoseconds(): Series { return this.field(() => 0); }

  totalSeconds(): Series {
    this.require('timedelta');
    return Series._from(new Column('float64', this.data.map((v) => v / 1000)), this.s.index, this.s.name);
  }

  /** days / hours / minutes / seconds / milliseconds / microseconds / nanoseconds. */
  get components(): DataFrame {
    this.require('timedelta');
    const parts = Array.from(this.data, (ms) => {
      if (ms !== ms) return null;
      const td = new Timedelta(ms);
      let rest = ms - td.days * 86_400_000;
      const h = Math.floor(rest / 3_600_000); rest -= h * 3_600_000;
      const m = Math.floor(rest / 60_000); rest -= m * 60_000;
      const sec = Math.floor(rest / 1000); rest -= sec * 1000;
      const milli = Math.floor(rest);
      return [td.days, h, m, sec, milli, Math.round((rest - milli) * 1000), 0];
    });
    const names = ['days', 'hours', 'minutes', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds'];
    const cols = new Map(names.map((n, k) => [n, Column.from(parts.map((p) => (p ? p[k] : null)))]));
    return DataFrame._fromColumns(cols, this.s.index);
  }
}

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Categorical helpers (`series.cat`), like pandas' `.cat` accessor. */
export class CategoricalMethods {
  private readonly s: Series;

  constructor(s: Series) {
    if (s.dtype !== 'category') throw new TypeError(`.cat accessor requires category dtype, got ${s.dtype}`);
    this.s = s;
  }

  get categories(): unknown[] { return [...this.s._col.meta.categories!]; }
  get ordered(): boolean { return this.s._col.meta.ordered ?? false; }

  /** Integer codes (-1 for missing). */
  get codes(): Series {
    return Series._from(new Column('int64', Float64Array.from(this.s._col.data as Int32Array)), this.s.index, this.s.name);
  }

  private with(categories: readonly unknown[], ordered = this.ordered, remapByValue = true): Series {
    const col = this.s._col;
    if (!remapByValue) return Series._from(new Column('category', col.data, { categories, ordered }), this.s.index, this.s.name);
    return Series._from(Column.from(col.toArray(), 'category', { categories, ordered }), this.s.index, this.s.name);
  }

  /** New names for the categories, by position (array), mapping, or function. */
  renameCategories(names: readonly unknown[] | Record<string, unknown> | ((c: unknown) => unknown)): Series {
    const cats = this.categories;
    let next: unknown[];
    if (typeof names === 'function') next = cats.map(names);
    else if (Array.isArray(names)) {
      if (names.length !== cats.length) throw new RangeError('new categories must have the same length as the old ones');
      next = [...names];
    } else next = cats.map((c) => (Object.hasOwn(names, String(c)) ? (names as Record<string, unknown>)[String(c)] : c));
    if (new Set(next.map((c) => hashKey(c))).size !== next.length) throw new Error('Categorical categories must be unique');
    return this.with(next, this.ordered, false);
  }

  reorderCategories(categories: readonly unknown[], options: { ordered?: boolean } = {}): Series {
    const have = new Set(this.categories.map((c) => hashKey(c)));
    if (categories.length !== have.size || !categories.every((c) => have.has(hashKey(c)))) {
      throw new Error('items in new categories are not the same as in old categories');
    }
    return this.with(categories, options.ordered ?? this.ordered);
  }

  addCategories(categories: readonly unknown[]): Series {
    const have = new Set(this.categories.map((c) => hashKey(c)));
    for (const c of categories) if (have.has(hashKey(c))) throw new Error(`new categories must not include old categories: ${String(c)}`);
    return this.with([...this.categories, ...categories], this.ordered, false);
  }

  /** Removes categories; values in them become NA. */
  removeCategories(categories: readonly unknown[]): Series {
    const drop = new Set(categories.map((c) => hashKey(c)));
    return this.with(this.categories.filter((c) => !drop.has(hashKey(c))));
  }

  removeUnusedCategories(): Series {
    const used = new Set(Array.from(this.s._col.data as Int32Array).filter((c) => c >= 0));
    return this.with(this.categories.filter((_, i) => used.has(i)));
  }

  /** Replaces the categories; values not in the new set become NA. */
  setCategories(categories: readonly unknown[], options: { ordered?: boolean } = {}): Series {
    return this.with(categories, options.ordered ?? this.ordered);
  }

  asOrdered(): Series { return this.with(this.categories, true, false); }
  asUnordered(): Series { return this.with(this.categories, false, false); }
}
