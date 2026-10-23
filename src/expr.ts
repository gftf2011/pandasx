/**
 * String expressions for `DataFrame.query` / `DataFrame.eval` / `pd.eval`, with
 * pandas (Python) syntax: `a > 1 and b == "x"`, `c = a + b`, `x in [1, 2]`,
 * `@threshold`, `` `col name` ``, `name.str.startswith("A")`, chained `1 < a < 5`.
 */
import { Column } from './core/column.ts';
import { DataFrame } from './frame.ts';
import { Series } from './series.ts';

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'local'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' };

const OPERATORS = ['**', '//', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '(', ')', '[', ']', ',', '.', '&', '|', '~', '=', '!'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else v += src[j++];
      }
      if (j >= src.length) throw new SyntaxError(`Unterminated string in expression: ${src}`);
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new SyntaxError('Unterminated backtick-quoted name');
      out.push({ t: 'id', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '@') {
      const m = /^@([A-Za-z_]\w*)/.exec(src.slice(i));
      if (!m) throw new SyntaxError('Expected a variable name after @');
      out.push({ t: 'local', v: m[1] });
      i += m[0].length;
      continue;
    }
    const id = /^[A-Za-z_À-￿][\wÀ-￿]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new SyntaxError(`Unexpected character '${c}' in expression`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'eof' });
  return out;
}

/** Parsed expression tree returned by parseExpression. */
export type ExprNode =
  | { k: 'lit'; v: unknown }
  | { k: 'name'; v: string }
  | { k: 'local'; v: string }
  | { k: 'list'; items: ExprNode[] }
  | { k: 'unary'; op: string; arg: ExprNode }
  | { k: 'bin'; op: string; l: ExprNode; r: ExprNode }
  | { k: 'cmp'; ops: string[]; args: ExprNode[] }
  | { k: 'attr'; obj: ExprNode; name: string }
  | { k: 'call'; fn: ExprNode; args: ExprNode[]; kwargs: Record<string, ExprNode> }
  | { k: 'index'; obj: ExprNode; key: ExprNode };

const CONSTANTS: Record<string, unknown> = { True: true, False: false, true: true, false: false, None: null, null: null, NaN: NaN, nan: NaN, inf: Infinity };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.t === 'op' && t.v === v; }
  private isWord(v: string): boolean { const t = this.peek(); return t.t === 'id' && t.v === v; }
  private expect(v: string): void {
    if (!this.isOp(v)) throw new SyntaxError(`Expected '${v}' in expression`);
    this.pos++;
  }

  parse(): ExprNode {
    const n = this.or();
    if (this.peek().t !== 'eof') throw new SyntaxError(`Unexpected token in expression: ${JSON.stringify(this.peek())}`);
    return n;
  }

  private or(): ExprNode {
    let l = this.and();
    while (this.isOp('|') || this.isWord('or')) { this.pos++; l = { k: 'bin', op: 'or', l, r: this.and() }; }
    return l;
  }

  private and(): ExprNode {
    let l = this.not();
    while (this.isOp('&') || this.isWord('and')) { this.pos++; l = { k: 'bin', op: 'and', l, r: this.not() }; }
    return l;
  }

  private not(): ExprNode {
    if (this.isOp('~') || this.isWord('not')) { this.pos++; return { k: 'unary', op: 'not', arg: this.not() }; }
    return this.comparison();
  }

  private comparison(): ExprNode {
    const first = this.additive();
    const ops: string[] = [];
    const args: ExprNode[] = [first];
    for (;;) {
      const t = this.peek();
      let op: string | null = null;
      if (t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) { op = t.v; this.pos++; }
      else if (this.isWord('in')) { op = 'in'; this.pos++; }
      else if (this.isWord('not') && this.tokens[this.pos + 1]?.t === 'id' && (this.tokens[this.pos + 1] as { v: string }).v === 'in') { op = 'not in'; this.pos += 2; }
      if (!op) break;
      ops.push(op);
      args.push(this.additive());
    }
    return ops.length ? { k: 'cmp', ops, args } : first;
  }

  private additive(): ExprNode {
    let l = this.term();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next() as { v: string }; l = { k: 'bin', op: op.v, l, r: this.term() }; }
    return l;
  }

  private term(): ExprNode {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('//') || this.isOp('%')) {
      const op = this.next() as { v: string };
      l = { k: 'bin', op: op.v, l, r: this.unary() };
    }
    return l;
  }

  private unary(): ExprNode {
    if (this.isOp('-')) { this.pos++; return { k: 'unary', op: 'neg', arg: this.unary() }; }
    if (this.isOp('+')) { this.pos++; return this.unary(); }
    return this.power();
  }

  private power(): ExprNode {
    const base = this.postfix();
    if (this.isOp('**')) { this.pos++; return { k: 'bin', op: '**', l: base, r: this.unary() }; }
    return base;
  }

  private postfix(): ExprNode {
    let n = this.atom();
    for (;;) {
      if (this.isOp('.')) {
        this.pos++;
        const t = this.next();
        if (t.t !== 'id') throw new SyntaxError('Expected attribute name after "."');
        n = { k: 'attr', obj: n, name: t.v };
      } else if (this.isOp('(')) {
        this.pos++;
        const args: ExprNode[] = [];
        const kwargs: Record<string, ExprNode> = {};
        while (!this.isOp(')')) {
          const t = this.peek();
          if (t.t === 'id' && this.tokens[this.pos + 1]?.t === 'op' && (this.tokens[this.pos + 1] as { v: string }).v === '=') {
            this.pos += 2;
            kwargs[t.v] = this.or();
          } else args.push(this.or());
          if (!this.isOp(')')) this.expect(',');
        }
        this.pos++;
        n = { k: 'call', fn: n, args, kwargs };
      } else if (this.isOp('[')) {
        this.pos++;
        const key = this.or();
        this.expect(']');
        n = { k: 'index', obj: n, key };
      } else return n;
    }
  }

  private atom(): ExprNode {
    const t = this.next();
    switch (t.t) {
      case 'num': return { k: 'lit', v: t.v };
      case 'str': return { k: 'lit', v: t.v };
      case 'local': return { k: 'local', v: t.v };
      case 'id': return t.v in CONSTANTS ? { k: 'lit', v: CONSTANTS[t.v] } : { k: 'name', v: t.v };
      case 'op':
        if (t.v === '(') {
          const first = this.or();
          if (this.isOp(',')) {
            const items = [first];
            while (this.isOp(',')) { this.pos++; if (this.isOp(')')) break; items.push(this.or()); }
            this.expect(')');
            return { k: 'list', items };
          }
          this.expect(')');
          return first;
        }
        if (t.v === '[') {
          const items: ExprNode[] = [];
          while (!this.isOp(']')) { items.push(this.or()); if (!this.isOp(']')) this.expect(','); }
          this.pos++;
          return { k: 'list', items };
        }
    }
    throw new SyntaxError(`Unexpected token in expression: ${JSON.stringify(t)}`);
  }
}

export function parseExpression(src: string): ExprNode {
  return new Parser(tokenize(src)).parse();
}

// ------------------------------------------------------------------ evaluation

export interface EvalContext {
  frame?: DataFrame;
  locals?: Record<string, unknown>;
}

const MATH_FUNCS: Record<string, (x: number) => number> = {
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, expm1: Math.expm1, log: Math.log, log10: Math.log10, log1p: Math.log1p,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, arcsinh: Math.asinh, arccosh: Math.acosh, arctanh: Math.atanh,
  floor: Math.floor, ceil: Math.ceil,
};

const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function evaluateNode(n: ExprNode, ctx: EvalContext): unknown {
  switch (n.k) {
    case 'lit': return n.v;
    case 'list': return n.items.map((i) => evaluateNode(i, ctx));
    case 'local': {
      if (!ctx.locals || !(n.v in ctx.locals)) throw new ReferenceError(`local variable '${n.v}' is not defined`);
      return ctx.locals[n.v];
    }
    case 'name': return resolveName(n.v, ctx);
    case 'unary': {
      const v = evaluateNode(n.arg, ctx);
      if (n.op === 'not') return v instanceof Series ? v.not() : !v;
      return v instanceof Series ? v.neg() : -(v as number);
    }
    case 'bin': return binary(n.op, evaluateNode(n.l, ctx), evaluateNode(n.r, ctx));
    case 'cmp': {
      let result: unknown = true;
      let left = evaluateNode(n.args[0], ctx);
      n.ops.forEach((op, i) => {
        const right = evaluateNode(n.args[i + 1], ctx);
        const r = compare(op, left, right);
        result = i === 0 ? r : binary('and', result, r);
        left = right;
      });
      return result;
    }
    case 'attr': {
      const obj = evaluateNode(n.obj, ctx);
      return getAttr(obj, n.name);
    }
    case 'index': {
      const obj = evaluateNode(n.obj, ctx);
      const key = evaluateNode(n.key, ctx);
      if (obj instanceof Series) return typeof key === 'number' ? obj.iloc(key) : obj.loc(key as never);
      return (obj as Record<string, unknown>)[key as string];
    }
    case 'call': {
      const args = n.args.map((a) => evaluateNode(a, ctx));
      const kwargs = Object.fromEntries(Object.entries(n.kwargs).map(([k, v]) => [snakeToCamel(k), evaluateNode(v, ctx)]));
      const hasKw = Object.keys(kwargs).length > 0;
      if (n.fn.k === 'name' && n.fn.v in MATH_FUNCS && !(ctx.frame?.has(n.fn.v))) {
        const f = MATH_FUNCS[n.fn.v];
        const x = args[0];
        return x instanceof Series ? x.map((v) => (v === null ? null : f(v as number))) : f(x as number);
      }
      if (n.fn.k === 'attr') {
        const obj = evaluateNode(n.fn.obj, ctx);
        const method = methodOf(obj, n.fn.name);
        return method.call(obj, ...args, ...(hasKw ? [kwargs] : []));
      }
      const fn = evaluateNode(n.fn, ctx);
      if (typeof fn !== 'function') throw new TypeError('Expression calls something that is not a function');
      return fn(...args, ...(hasKw ? [kwargs] : []));
    }
  }
}

function resolveName(name: string, ctx: EvalContext): unknown {
  const df = ctx.frame;
  if (df?.has(name)) return df.get(name);
  if (df && (name === 'index' || name === df.index.name)) return new Series(Column.from(df.index.labels), { index: df.index, name: df.index.name });
  if (df && df.index.names?.includes(name)) {
    const l = df.index.names.indexOf(name);
    return new Series(df.index.labels.map((t) => (t as readonly unknown[])[l]), { index: df.index, name });
  }
  if (!df && ctx.locals && name in ctx.locals) return ctx.locals[name];
  throw new ReferenceError(`name '${name}' is not defined`);
}

function getAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) throw new TypeError(`Cannot read attribute '${name}' of null`);
  const camel = snakeToCamel(name);
  const o = obj as Record<string, unknown>;
  const v = camel in o ? o[camel] : o[name];
  if (v === undefined) throw new TypeError(`Object has no attribute '${name}'`);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(obj) : v;
}

function methodOf(obj: unknown, name: string): (...a: unknown[]) => unknown {
  const camel = snakeToCamel(name);
  const o = obj as Record<string, unknown>;
  const f = (camel in o ? o[camel] : o[name]) as unknown;
  if (typeof f !== 'function') throw new TypeError(`Object has no method '${name}'`);
  return f as (...a: unknown[]) => unknown;
}

const SERIES_BIN: Record<string, [string, string]> = {
  '+': ['add', 'radd'], '-': ['sub', 'rsub'], '*': ['mul', 'rmul'], '/': ['div', 'rdiv'],
  '//': ['floordiv', 'rfloordiv'], '%': ['mod', 'rmod'], '**': ['pow', 'rpow'], and: ['and', 'and'], or: ['or', 'or'],
};

function binary(op: string, a: unknown, b: unknown): unknown {
  if (a instanceof Series || b instanceof Series) {
    const [m, rm] = SERIES_BIN[op];
    if (a instanceof Series) return (a as unknown as Record<string, (x: unknown) => Series>)[m](b);
    return (b as unknown as Record<string, (x: unknown) => Series>)[rm](a);
  }
  const x = a as number, y = b as number;
  switch (op) {
    case '+': return (a as never as string) + (b as never as string);
    case '-': return x - y;
    case '*': return x * y;
    case '/': return x / y;
    case '//': return Math.floor(x / y);
    case '%': return ((x % y) + y) % y;
    case '**': return x ** y;
    case 'and': return Boolean(a) && Boolean(b);
    case 'or': return Boolean(a) || Boolean(b);
  }
  throw new SyntaxError(`Unknown operator ${op}`);
}

const FLIP: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
const CMP_METHOD: Record<string, string> = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

function compare(op: string, a: unknown, b: unknown): unknown {
  if (op === 'in' || op === 'not in') {
    const list = b instanceof Series ? b.toArray() : Array.isArray(b) ? b : [b];
    const r = a instanceof Series ? a.isin(list) : list.includes(a);
    return op === 'in' ? r : r instanceof Series ? r.not() : !r;
  }
  if (a instanceof Series) return (a as unknown as Record<string, (x: unknown) => Series>)[CMP_METHOD[op]](b);
  if (b instanceof Series) return (b as unknown as Record<string, (x: unknown) => Series>)[CMP_METHOD[FLIP[op]]](a);
  const x = a as number, y = b as number;
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    default: return x >= y;
  }
}

/**
 * Evaluates one or more statements (separated by newlines or ';'). Assignments
 * `name = expr` write columns into `frame` (which must be a copy the caller owns).
 * Returns the value of the last expression, or the frame when the last statement is an assignment.
 */
export function evaluateStatements(src: string, ctx: EvalContext): { value: unknown; assigned: boolean } {
  const statements = src.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
  let value: unknown;
  let assigned = false;
  for (const stmt of statements) {
    const m = /^(`[^`]+`|[A-Za-z_][\w]*)\s*=(?!=)\s*(.+)$/s.exec(stmt);
    if (m) {
      if (!ctx.frame) throw new Error('Assignment needs a DataFrame (use df.eval)');
      const name = m[1].startsWith('`') ? m[1].slice(1, -1) : m[1];
      ctx.frame.set(name, evaluateNode(parseExpression(m[2]), ctx) as never);
      assigned = true;
      value = ctx.frame;
    } else {
      value = evaluateNode(parseExpression(stmt), ctx);
      assigned = false;
    }
  }
  return { value, assigned };
}

/** `pd.eval`: evaluates an expression over `locals` (Series/scalars). */
export function evaluate(expr: string, options: { locals?: Record<string, unknown>; frame?: DataFrame } = {}): unknown {
  return evaluateStatements(expr, { locals: options.locals, frame: options.frame }).value;
}
