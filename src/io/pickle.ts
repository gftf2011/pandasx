/**
 * A tiny, safe subset of Python's pickle, enough for pandas/PyTables metadata:
 * decodes protocol 0–5 streams into plain JS values (lists, tuples, dicts,
 * strings, numbers, None, bytes) and encodes protocol 0 text pickles.
 * Calls to globals (e.g. numpy reconstruct) are never executed: they become
 * `{ __global__, args, state }` descriptors.
 */

export interface PyCall { __global__: string; args: unknown; state?: unknown }

const MARK = Symbol('mark');

export function unpickle(bytes: Uint8Array): unknown {
  const data = bytes;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stack: unknown[] = [];
  const memo: unknown[] = [];
  let i = 0;
  const readLine = () => {
    const end = data.indexOf(0x0a, i);
    const s = Buffer.from(data.subarray(i, end)).toString('latin1');
    i = end + 1;
    return s;
  };
  const popMark = (): unknown[] => {
    const k = stack.lastIndexOf(MARK);
    const items = stack.splice(k);
    items.shift();
    return items;
  };
  const utf8 = (a: number, b: number) => Buffer.from(data.subarray(a, b)).toString('utf8');
  while (i < data.length) {
    const op = data[i++];
    switch (op) {
      case 0x80: i++; break; // PROTO
      case 0x95: i += 8; break; // FRAME
      case 0x2e: return stack.pop(); // STOP
      case 0x28: stack.push(MARK); break; // MARK
      case 0x4e: stack.push(null); break; // NONE
      case 0x88: stack.push(true); break; // NEWTRUE
      case 0x89: stack.push(false); break; // NEWFALSE
      case 0x4b: stack.push(data[i++]); break; // BININT1
      case 0x4d: stack.push(view.getUint16(i, true)); i += 2; break; // BININT2
      case 0x4a: stack.push(view.getInt32(i, true)); i += 4; break; // BININT
      case 0x8a: { const n = data[i++]; let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(data[i + k]); if (n && data[i + n - 1] & 0x80) v -= 1n << BigInt(8 * n); i += n; stack.push(Number.isSafeInteger(Number(v)) ? Number(v) : v); break; } // LONG1
      case 0x47: stack.push(view.getFloat64(i, false)); i += 8; break; // BINFLOAT
      case 0x49: { const s = readLine(); stack.push(s === '01' ? true : s === '00' ? false : Number(s)); break; } // INT
      case 0x4c: stack.push(Number(readLine().replace(/L$/, ''))); break; // LONG
      case 0x46: stack.push(Number(readLine())); break; // FLOAT
      case 0x53: stack.push(readLine().replace(/^'|'$/g, '')); break; // STRING
      case 0x56: stack.push(readLine().replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))); break; // UNICODE
      case 0x8c: { const n = data[i++]; stack.push(utf8(i, i + n)); i += n; break; } // SHORT_BINUNICODE
      case 0x58: { const n = view.getUint32(i, true); i += 4; stack.push(utf8(i, i + n)); i += n; break; } // BINUNICODE
      case 0x8d: { const n = Number(view.getBigUint64(i, true)); i += 8; stack.push(utf8(i, i + n)); i += n; break; } // BINUNICODE8
      case 0x55: { const n = data[i++]; stack.push(Buffer.from(data.subarray(i, i + n)).toString('latin1')); i += n; break; } // SHORT_BINSTRING
      case 0x54: { const n = view.getUint32(i, true); i += 4; stack.push(Buffer.from(data.subarray(i, i + n)).toString('latin1')); i += n; break; } // BINSTRING
      case 0x43: { const n = data[i++]; stack.push(data.slice(i, i + n)); i += n; break; } // SHORT_BINBYTES
      case 0x42: { const n = view.getUint32(i, true); i += 4; stack.push(data.slice(i, i + n)); i += n; break; } // BINBYTES
      case 0x8e: { const n = Number(view.getBigUint64(i, true)); i += 8; stack.push(data.slice(i, i + n)); i += n; break; } // BINBYTES8
      case 0x96: { const n = Number(view.getBigUint64(i, true)); i += 8; stack.push(data.slice(i, i + n)); i += n; break; } // BYTEARRAY8
      case 0x5d: stack.push([]); break; // EMPTY_LIST
      case 0x29: stack.push({ __tuple__: [] }); break; // EMPTY_TUPLE
      case 0x7d: stack.push(new Map()); break; // EMPTY_DICT
      case 0x8f: stack.push(new Set()); break; // EMPTY_SET
      case 0x6c: stack.push(popMark()); break; // LIST
      case 0x74: stack.push({ __tuple__: popMark() }); break; // TUPLE
      case 0x64: { const items = popMark(); const m = new Map(); for (let k = 0; k < items.length; k += 2) m.set(items[k], items[k + 1]); stack.push(m); break; } // DICT
      case 0x85: stack.push({ __tuple__: [stack.pop()] }); break; // TUPLE1
      case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push({ __tuple__: [a, b] }); break; } // TUPLE2
      case 0x87: { const c = stack.pop(), b = stack.pop(), a = stack.pop(); stack.push({ __tuple__: [a, b, c] }); break; } // TUPLE3
      case 0x61: { const v = stack.pop(); (stack[stack.length - 1] as unknown[]).push(v); break; } // APPEND
      case 0x65: { const items = popMark(); (stack[stack.length - 1] as unknown[]).push(...items); break; } // APPENDS
      case 0x73: { const v = stack.pop(), k = stack.pop(); (stack[stack.length - 1] as Map<unknown, unknown>).set(k, v); break; } // SETITEM
      case 0x75: { const items = popMark(); const m = stack[stack.length - 1] as Map<unknown, unknown>; for (let k = 0; k < items.length; k += 2) m.set(items[k], items[k + 1]); break; } // SETITEMS
      case 0x90: { const items = popMark(); const st = stack[stack.length - 1] as Set<unknown>; items.forEach((x) => st.add(x)); break; } // ADDITEMS
      case 0x91: stack.push(new Set(popMark())); break; // FROZENSET
      case 0x70: memo[Number(readLine())] = stack[stack.length - 1]; break; // PUT
      case 0x71: memo[data[i++]] = stack[stack.length - 1]; break; // BINPUT
      case 0x72: memo[view.getUint32(i, true)] = stack[stack.length - 1]; i += 4; break; // LONG_BINPUT
      case 0x94: memo.push(stack[stack.length - 1]); break; // MEMOIZE
      case 0x67: stack.push(memo[Number(readLine())]); break; // GET
      case 0x68: stack.push(memo[data[i++]]); break; // BINGET
      case 0x6a: stack.push(memo[view.getUint32(i, true)]); i += 4; break; // LONG_BINGET
      case 0x63: { const mod = readLine(); const name = readLine(); stack.push({ __global__: `${mod}.${name}` }); break; } // GLOBAL
      case 0x93: { const name = stack.pop(), mod = stack.pop(); stack.push({ __global__: `${String(mod)}.${String(name)}` }); break; } // STACK_GLOBAL
      case 0x52: { const args = stack.pop(); const f = stack.pop() as PyCall; stack.push({ __global__: f.__global__, args } satisfies PyCall); break; } // REDUCE
      case 0x81: { const args = stack.pop(); const cls = stack.pop() as PyCall; stack.push({ __global__: cls.__global__, args }); break; } // NEWOBJ
      case 0x62: { const st = stack.pop(); (stack[stack.length - 1] as PyCall).state = st; break; } // BUILD
      case 0x30: stack.pop(); break; // POP
      case 0x31: popMark(); break; // POP_MARK
      case 0x32: stack.push(stack[stack.length - 1]); break; // DUP
      default: throw new Error(`Unsupported pickle opcode 0x${op.toString(16)}`);
    }
  }
  throw new Error('Pickle stream ended without STOP');
}

/** Converts unpickled tuples to arrays and maps to objects. */
export function plain(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object' && '__tuple__' in v) return (v as { __tuple__: unknown[] }).__tuple__.map(plain);
  return v;
}

/** Elements of a pickled numpy object array (`numpy.core.multiarray._reconstruct`). */
export function numpyObjectArray(v: unknown): unknown[] {
  const call = v as PyCall;
  const state = plain(call.state) as unknown[];
  const items = state?.[4];
  if (!Array.isArray(items)) throw new Error('Unsupported pickled array');
  return items.map((x) => (x instanceof Uint8Array ? Buffer.from(x).toString('utf8') : x));
}

/** Protocol 0 pickle (what PyTables stores in pandas attributes) of plain values. */
export function pickle0(v: unknown): string {
  let memo = 0;
  const out: string[] = [];
  const put = () => out.push(`p${memo++}\n`);
  const enc = (x: unknown): void => {
    if (x === null || x === undefined) { out.push('N'); return; }
    if (typeof x === 'boolean') { out.push(x ? 'I01\n' : 'I00\n'); return; }
    if (typeof x === 'number') { out.push(Number.isInteger(x) ? `I${x}\n` : `F${x}\n`); return; }
    if (typeof x === 'string') {
      out.push(`V${x.replace(/\\/g, '\\u005c').replace(/\n/g, '\\u000a').replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`);
      put();
      return;
    }
    if (Array.isArray(x) && (x as { tuple?: boolean }).tuple) {
      out.push('(');
      x.forEach(enc);
      out.push('t');
      put();
      return;
    }
    if (Array.isArray(x)) {
      out.push('(l');
      put();
      x.forEach((e) => { enc(e); out.push('a'); });
      return;
    }
    if (typeof x === 'object') {
      out.push('(d');
      put();
      for (const [k, e] of Object.entries(x as Record<string, unknown>)) { enc(k); enc(e); out.push('s'); }
      return;
    }
    throw new Error(`Cannot pickle ${typeof x}`);
  };
  enc(v);
  out.push('.');
  return out.join('');
}

/** Marks an array to be pickled as a tuple. */
export function tuple<T>(items: T[]): T[] {
  return Object.assign(items, { tuple: true });
}
