import { Column } from './core/column.ts';
import type { DType } from './core/types.ts';
import { isNA } from './core/values.ts';
import { Series } from './series.ts';

/** Vectorised string functions (`series.str`). Missing values stay missing. */
export class StringMethods {
  private readonly s: Series;

  constructor(s: Series) {
    if (s.dtype !== 'string' && s.dtype !== 'object') throw new TypeError(`.str accessor requires string values, got ${s.dtype}`);
    this.s = s;
  }

  private map(fn: (v: string) => unknown, dtype?: DType): Series {
    const col = this.s._col;
    const out = new Array(col.length);
    let missing = false;
    for (let i = 0; i < out.length; i++) {
      const v = col.get(i);
      if (isNA(v)) { out[i] = null; missing = true; } else out[i] = fn(String(v));
    }
    // A boolean/int result with missing values must fall back to inference (object/float).
    return Series._from(Column.from(out, missing && (dtype === 'bool' || dtype === 'int64') ? undefined : dtype), this.s.index, this.s.name);
  }

  lower(): Series { return this.map((v) => v.toLowerCase(), 'string'); }
  upper(): Series { return this.map((v) => v.toUpperCase(), 'string'); }
  capitalize(): Series { return this.map((v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(), 'string'); }
  title(): Series { return this.map((v) => v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), 'string'); }
  strip(chars?: string): Series { return this.map((v) => (chars ? trimChars(v, chars, true, true) : v.trim()), 'string'); }
  lstrip(chars?: string): Series { return this.map((v) => (chars ? trimChars(v, chars, true, false) : v.trimStart()), 'string'); }
  rstrip(chars?: string): Series { return this.map((v) => (chars ? trimChars(v, chars, false, true) : v.trimEnd()), 'string'); }
  len(): Series { return this.map((v) => v.length, 'int64'); }

  /** Substring or regex test. `regex` defaults to true like pandas when `pat` is a RegExp. */
  contains(pat: string | RegExp, options: { case?: boolean; regex?: boolean } = {}): Series {
    const caseSensitive = options.case ?? true;
    if (pat instanceof RegExp || options.regex) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat, caseSensitive ? '' : 'i');
      return this.map((v) => { re.lastIndex = 0; return re.test(v); }, 'bool');
    }
    const needle = caseSensitive ? pat : pat.toLowerCase();
    return this.map((v) => (caseSensitive ? v : v.toLowerCase()).includes(needle), 'bool');
  }

  startswith(prefix: string): Series { return this.map((v) => v.startsWith(prefix), 'bool'); }
  endswith(suffix: string): Series { return this.map((v) => v.endsWith(suffix), 'bool'); }

  /** Replaces all occurrences (string pattern) or follows the RegExp's flags. */
  replace(pat: string | RegExp, repl: string): Series {
    return this.map((v) => (typeof pat === 'string' ? v.split(pat).join(repl) : v.replace(pat, repl)), 'string');
  }

  slice(start?: number, stop?: number): Series { return this.map((v) => v.slice(start, stop), 'string'); }

  /** Splits each string into an array (whitespace by default). */
  split(sep?: string | RegExp, limit?: number): Series {
    return this.map((v) => (sep === undefined ? v.trim().split(/\s+/) : v.split(sep, limit)), 'object');
  }

  /** Element `i` of each array/string (e.g. after `split`). */
  get(i: number): Series {
    const col = this.s._col;
    return Series._from(col.map((v) => (isNA(v) ? null : ((v as ArrayLike<unknown>)[i < 0 ? (v as ArrayLike<unknown>).length + i : i] ?? null))), this.s.index, this.s.name);
  }

  pad(width: number, side: 'left' | 'right' | 'both' = 'left', fillchar = ' '): Series {
    return this.map((v) => {
      if (side === 'left') return v.padStart(width, fillchar);
      if (side === 'right') return v.padEnd(width, fillchar);
      const total = Math.max(0, width - v.length);
      const left = Math.floor(total / 2);
      return fillchar.repeat(left) + v + fillchar.repeat(total - left);
    }, 'string');
  }

  zfill(width: number): Series { return this.pad(width, 'left', '0'); }
  repeat(n: number): Series { return this.map((v) => v.repeat(n), 'string'); }
  count(pat: string | RegExp): Series {
    return this.map((v) => (typeof pat === 'string' ? v.split(pat).length - 1 : (v.match(new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')) ?? []).length), 'int64');
  }

  /** First capture group of `pat` (or the whole match when there is none). */
  extract(pat: RegExp): Series {
    return this.map((v) => { const m = v.match(pat); return m ? (m[1] ?? m[0]) : null; }, 'string');
  }

  isnumeric(): Series { return this.map((v) => v.length > 0 && /^\d+$/.test(v), 'bool'); }
  isalpha(): Series { return this.map((v) => v.length > 0 && /^\p{L}+$/u.test(v), 'bool'); }
  isdigit(): Series { return this.isnumeric(); }
  cat(sep = ''): string {
    return this.s.dropna().toArray().map(String).join(sep);
  }
}

function trimChars(v: string, chars: string, left: boolean, right: boolean): string {
  let a = 0, b = v.length;
  if (left) while (a < b && chars.includes(v[a])) a++;
  if (right) while (b > a && chars.includes(v[b - 1])) b--;
  return v.slice(a, b);
}

/** Datetime properties (`series.dt`), computed in UTC. */
export class DatetimeMethods {
  private readonly s: Series;

  constructor(s: Series) {
    if (s.dtype !== 'datetime') throw new TypeError(`.dt accessor requires datetime values, got ${s.dtype}`);
    this.s = s;
  }

  private field(fn: (d: Date) => number): Series {
    const data = this.s._col.data as Float64Array;
    const out = new Float64Array(data.length);
    let missing = false;
    for (let i = 0; i < data.length; i++) {
      if (Number.isNaN(data[i])) { out[i] = NaN; missing = true; } else out[i] = fn(new Date(data[i]));
    }
    return Series._from(new Column(missing ? 'float64' : 'int64', out), this.s.index, this.s.name);
  }

  get year(): Series { return this.field((d) => d.getUTCFullYear()); }
  get month(): Series { return this.field((d) => d.getUTCMonth() + 1); }
  get day(): Series { return this.field((d) => d.getUTCDate()); }
  get hour(): Series { return this.field((d) => d.getUTCHours()); }
  get minute(): Series { return this.field((d) => d.getUTCMinutes()); }
  get second(): Series { return this.field((d) => d.getUTCSeconds()); }
  /** Monday = 0 … Sunday = 6, as in pandas. */
  get dayofweek(): Series { return this.field((d) => (d.getUTCDay() + 6) % 7); }
  get dayofyear(): Series {
    return this.field((d) => Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1);
  }
  get quarter(): Series { return this.field((d) => Math.floor(d.getUTCMonth() / 3) + 1); }

  /** Truncates to midnight UTC. */
  normalize(): Series {
    const data = this.s._col.data as Float64Array;
    const out = data.map((t) => (Number.isNaN(t) ? NaN : Math.floor(t / 86_400_000) * 86_400_000));
    return Series._from(new Column('datetime', out), this.s.index, this.s.name);
  }

  /** Formats with strftime-style codes: %Y %m %d %H %M %S %j. */
  strftime(format: string): Series {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return Series._from(this.s._col.map((v) => {
      if (v === null) return null;
      const d = v as Date;
      return format.replace(/%([YmdHMSj%])/g, (_, c: string) => {
        switch (c) {
          case 'Y': return String(d.getUTCFullYear());
          case 'm': return p(d.getUTCMonth() + 1);
          case 'd': return p(d.getUTCDate());
          case 'H': return p(d.getUTCHours());
          case 'M': return p(d.getUTCMinutes());
          case 'S': return p(d.getUTCSeconds());
          case 'j': return p(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1, 3);
          default: return '%';
        }
      });
    }, 'string'), this.s.index, this.s.name);
  }
}
