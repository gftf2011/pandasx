/**
 * Python format strings: '{:,.2f}', 'R$ {:,.2f}', '{:.1%}', '{:>8}', '{:e}', '{:d}'.
 * Supports [[fill]align][sign][#][0][width][,|_][.precision][type] with types
 * f F e E g G % d n s b o x X c.
 */

const SPEC = /^(?:(.)?([<>^=]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/;

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Formats one value with a format spec (the part after ':' in Python). */
export function formatSpec(value: unknown, spec: string): string {
  const m = SPEC.exec(spec);
  if (!m) throw new Error(`Invalid format spec: ${spec}`);
  const [, fillCh, align, sign = '-', alt, zero, widthS, sep, precS, type] = m;
  const precision = precS === undefined ? undefined : Number(precS);
  let body: string;
  let negative = false;
  if (typeof value === 'number' || typeof value === 'bigint') {
    const num = Number(value);
    if (Number.isNaN(num)) body = 'nan';
    else if (!Number.isFinite(num)) { body = 'inf'; negative = num < 0; }
    else {
      negative = num < 0 || Object.is(num, -0);
      const a = Math.abs(num);
      switch (type) {
        case 'f': case 'F': body = a.toFixed(precision ?? 6); break;
        case 'e': case 'E': {
          body = a.toExponential(precision ?? 6).replace(/e([+-])(\d)$/, 'e$10$2');
          if (type === 'E') body = body.toUpperCase();
          break;
        }
        case '%': body = (a * 100).toFixed(precision ?? 6) + '%'; break;
        case 'd': case 'n': body = String(typeof value === 'bigint' ? (value < 0n ? -value : value) : Math.round(a)); break;
        case 'b': body = (alt ? '0b' : '') + Math.trunc(a).toString(2); break;
        case 'o': body = (alt ? '0o' : '') + Math.trunc(a).toString(8); break;
        case 'x': body = (alt ? '0x' : '') + Math.trunc(a).toString(16); break;
        case 'X': body = (alt ? '0X' : '') + Math.trunc(a).toString(16).toUpperCase(); break;
        case 'c': body = String.fromCodePoint(num); negative = false; break;
        case 'g': case 'G': case undefined: {
          if (type === undefined && precision === undefined) { body = String(a); break; }
          const p = Math.max(1, precision ?? 6);
          const exp = a === 0 ? 0 : Math.floor(Math.log10(a));
          body = exp < -4 || exp >= p ? a.toExponential(p - 1).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2') : String(Number(a.toPrecision(p)));
          if (type === 'G') body = body.toUpperCase();
          break;
        }
        default: body = String(a);
      }
      if (sep && /^[\d]/.test(body)) {
        const [i, rest] = body.split(/(?=[.e%])/, 2) as [string, string?];
        body = group(i, sep) + (body.slice(i.length) || rest || '');
      }
    }
  } else {
    body = value === null || value === undefined ? 'None' : value instanceof Date ? value.toISOString().replace('T', ' ').slice(0, 19) : String(value);
    if (precision !== undefined && (type === 's' || type === undefined)) body = body.slice(0, precision);
  }
  const signStr = negative ? '-' : typeof value === 'number' && sign === '+' ? '+' : typeof value === 'number' && sign === ' ' ? ' ' : '';
  const width = widthS ? Number(widthS) : 0;
  const fill = fillCh ?? (zero && !align ? '0' : ' ');
  const al = align ?? (zero ? '=' : typeof value === 'number' ? '>' : '<');
  const total = signStr.length + body.length;
  if (total >= width) return signStr + body;
  const pad = width - total;
  switch (al) {
    case '<': return signStr + body + fill.repeat(pad);
    case '^': return fill.repeat(Math.floor(pad / 2)) + signStr + body + fill.repeat(Math.ceil(pad / 2));
    case '=': return signStr + fill.repeat(pad) + body;
    default: return fill.repeat(pad) + signStr + body;
  }
}

/** Applies a template such as 'R$ {:,.2f}' or '{}'; '{{' and '}}' are literal braces. */
export function pyFormat(template: string, value: unknown): string {
  return template.replace(/\{\{|\}\}|\{(?:[^{}:]*)(?::([^{}]*))?\}/g, (m, spec: string | undefined) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    return formatSpec(value, spec ?? '');
  });
}
