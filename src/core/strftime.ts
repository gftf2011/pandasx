/** strftime / strptime with Python directives, on wall-clock milliseconds. */
import { formatOffset } from './tz.ts';

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const p2 = (n: number) => String(n).padStart(2, '0');

/** Formats wall time `wall` (ms); `offset` (ms) is used by %z. */
export function strftime(wall: number, format: string, offset: number | null = null, tzName: string | null = null): string {
  const d = new Date(wall);
  const dow = (d.getUTCDay() + 6) % 7;
  const doy = Math.floor((wall - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  return format.replace(/%([a-zA-Z%])/g, (_, c: string) => {
    switch (c) {
      case 'Y': return String(d.getUTCFullYear());
      case 'y': return p2(d.getUTCFullYear() % 100);
      case 'm': return p2(d.getUTCMonth() + 1);
      case 'd': return p2(d.getUTCDate());
      case 'e': return String(d.getUTCDate()).padStart(2, ' ');
      case 'H': return p2(d.getUTCHours());
      case 'I': return p2(((d.getUTCHours() + 11) % 12) + 1);
      case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'M': return p2(d.getUTCMinutes());
      case 'S': return p2(d.getUTCSeconds());
      case 'f': return String(d.getUTCMilliseconds() * 1000).padStart(6, '0');
      case 'j': return String(doy).padStart(3, '0');
      case 'a': return DAY_NAMES[dow].slice(0, 3);
      case 'A': return DAY_NAMES[dow];
      case 'b': case 'h': return MONTH_NAMES[d.getUTCMonth()].slice(0, 3);
      case 'B': return MONTH_NAMES[d.getUTCMonth()];
      case 'u': return String(dow + 1);
      case 'w': return String(d.getUTCDay());
      case 'U': return p2(Math.floor((doy + 6 - d.getUTCDay()) / 7));
      case 'W': return p2(Math.floor((doy + 6 - dow) / 7));
      case 'V': return p2(isoWeek(wall)[1]);
      case 'G': return String(isoWeek(wall)[0]);
      case 'z': return offset === null ? '' : formatOffset(offset).replace(':', '');
      case 'Z': return tzName ?? '';
      case 'F': return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
      case 'T': return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
      case '%': return '%';
      default: return '%' + c;
    }
  });
}

/** ISO year, week and weekday (1 = Monday). */
export function isoWeek(wall: number): [number, number, number] {
  const d = new Date(wall);
  const dow = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return [year, week, dow + 1];
}

/**
 * Parses `text` with a Python strptime format. Returns `{ wall, offset }`
 * (offset in ms when %z is present, else null), or null when it does not match.
 */
export function strptime(text: string, format: string): { wall: number; offset: number | null } | null {
  let year = 1900, month = 0, day = 1, hour = 0, minute = 0, second = 0, ms = 0, pm: boolean | null = null, offset: number | null = null, doy: number | null = null;
  let i = 0;
  const num = (min: number, max: number): number | null => {
    const m = new RegExp(`^[+-]?\\d{${min},${max}}`).exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  for (let k = 0; k < format.length; k++) {
    const c = format[k];
    if (c !== '%') {
      if (/\s/.test(c)) { while (/\s/.test(text[i] ?? '')) i++; continue; }
      if (text[i] !== c) return null;
      i++;
      continue;
    }
    const dir = format[++k];
    let v: number | null;
    switch (dir) {
      case 'Y': v = num(4, 4); if (v === null) return null; year = v; break;
      case 'y': v = num(2, 2); if (v === null) return null; year = v < 69 ? 2000 + v : 1900 + v; break;
      case 'm': v = num(1, 2); if (v === null) return null; month = v - 1; break;
      case 'd': v = num(1, 2); if (v === null) return null; day = v; break;
      case 'H': v = num(1, 2); if (v === null) return null; hour = v; break;
      case 'I': v = num(1, 2); if (v === null) return null; hour = v % 12; break;
      case 'M': v = num(1, 2); if (v === null) return null; minute = v; break;
      case 'S': v = num(1, 2); if (v === null) return null; second = v; break;
      case 'f': {
        const m = /^\d{1,9}/.exec(text.slice(i));
        if (!m) return null;
        i += m[0].length;
        ms = Number((m[0] + '000000000').slice(0, 9)) / 1e6;
        break;
      }
      case 'j': v = num(1, 3); if (v === null) return null; doy = v; break;
      case 'p': {
        const m = /^(AM|PM|am|pm)/.exec(text.slice(i));
        if (!m) return null;
        i += 2;
        pm = m[0].toUpperCase() === 'PM';
        break;
      }
      case 'b': case 'B': case 'h': {
        const idx = MONTH_NAMES.findIndex((n) => text.slice(i).toLowerCase().startsWith((dir === 'B' ? n : n.slice(0, 3)).toLowerCase()));
        if (idx < 0) return null;
        i += dir === 'B' ? MONTH_NAMES[idx].length : 3;
        month = idx;
        break;
      }
      case 'a': case 'A': {
        const idx = DAY_NAMES.findIndex((n) => text.slice(i).toLowerCase().startsWith((dir === 'A' ? n : n.slice(0, 3)).toLowerCase()));
        if (idx < 0) return null;
        i += dir === 'A' ? DAY_NAMES[idx].length : 3;
        break;
      }
      case 'z': {
        const m = /^(Z|[+-]\d{2}:?\d{2})/.exec(text.slice(i));
        if (!m) return null;
        i += m[0].length;
        if (m[0] === 'Z') offset = 0;
        else {
          const sign = m[0][0] === '-' ? -1 : 1;
          const digits = m[0].replace(/[+:-]/g, '');
          offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
        }
        break;
      }
      case '%': if (text[i] !== '%') return null; i++; break;
      default: throw new Error(`Unsupported strptime directive %${dir}`);
    }
  }
  if (i !== text.length) return null;
  if (pm !== null) hour = (hour % 12) + (pm ? 12 : 0);
  let wall = Date.UTC(year, month, day, hour, minute, second) + ms;
  if (doy !== null) wall = Date.UTC(year, 0, doy, hour, minute, second) + ms;
  const check = new Date(wall);
  if (doy === null && (check.getUTCMonth() !== month || check.getUTCDate() !== day)) return null;
  return { wall, offset };
}
