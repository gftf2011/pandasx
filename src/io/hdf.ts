/**
 * HDF5 in pandas' PyTables layouts, via the optional `h5wasm`:
 * reads 'fixed' and 'table' formats written by pandas; writes the 'table' format.
 */
import { Column } from '../core/column.ts';
import { Index } from '../core/indexes.ts';
import type { Label } from '../core/types.ts';
import { isNA } from '../core/values.ts';
import { DataFrame } from '../frame.ts';
import { Series } from '../series.ts';
import { numpyObjectArray, pickle0, plain, tuple, unpickle } from './pickle.ts';
import { requireOptional } from './source.ts';

type H5 = typeof import('h5wasm');
type H5Group = import('h5wasm').Group;
type H5Dataset = import('h5wasm').Dataset;

async function h5(): Promise<H5> {
  const mod = await requireOptional<{ default: H5 }>('h5wasm/node', 'HDF5 I/O');
  const lib = mod.default;
  await lib.ready;
  return lib;
}

const NAT = -9223372036854775808n;

function attr(o: { attrs: Record<string, { value: unknown }> }, name: string): unknown {
  const a = o.attrs[name];
  return a === undefined ? undefined : a.value;
}

function attrText(o: { attrs: Record<string, { value: unknown }> }, name: string): string | undefined {
  const v = attr(o, name);
  if (v === undefined || v === null) return undefined;
  return v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v);
}

function pickled(o: { attrs: Record<string, { value: unknown }> }, name: string): unknown {
  const t = attrText(o, name);
  return t === undefined ? undefined : plain(unpickle(Buffer.from(t, 'latin1')));
}

/** Converts raw stored values (bigints, epoch units, nan_rep strings) to JS values. */
function decodeValues(raw: ArrayLike<unknown>, kind: string | undefined, nanRep: string | undefined): unknown[] {
  const vals = Array.from(raw as ArrayLike<unknown>);
  if (kind?.startsWith('datetime64')) {
    const unit = /\[(\w+)\]/.exec(kind)?.[1] ?? 'ns';
    const div = { ns: 1e6, us: 1e3, ms: 1, s: 1e-3 }[unit] ?? 1e6;
    return vals.map((v) => (v === NAT || v === null ? null : new Date(Number(v) / div)));
  }
  if (kind?.startsWith('timedelta64')) {
    const unit = /\[(\w+)\]/.exec(kind)?.[1] ?? 'ns';
    const div = { ns: 1e6, us: 1e3, ms: 1, s: 1e-3 }[unit] ?? 1e6;
    return vals.map((v) => (v === NAT ? null : Number(v) / div));
  }
  if (kind === 'bool') return vals.map((v) => (v === null ? null : Boolean(Number(v))));
  return vals.map((v) => {
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v;
    if (v instanceof Uint8Array) v = Buffer.from(v).toString('utf8');
    if (typeof v === 'string' && nanRep !== undefined && v === nanRep) return null;
    return v;
  });
}

function datasetValues(ds: H5Dataset): unknown[] {
  if (attrText(ds, 'CLASS') === 'VLARRAY' && attrText(ds, 'PSEUDOATOM') === 'object') {
    const raw = ds.value as unknown;
    const first = Array.isArray(raw) ? raw[0] : raw;
    return numpyObjectArray(unpickle(first instanceof Uint8Array ? first : Uint8Array.from(first as ArrayLike<number>)));
  }
  // PyTables stores booleans as an 8-bit HDF5 bitfield (class 4).
  const isBool = (ds.metadata as { type?: number; size?: number }).type === 4 && (ds.metadata as { size?: number }).size === 1;
  return decodeValues(ds.value as ArrayLike<unknown>, isBool ? 'bool' : (attrText(ds, 'value_type') ?? attrText(ds, 'kind')), undefined);
}

function readAxis(g: H5Group, name: string): Index {
  const variety = attrText(g, `${name}_variety`) ?? 'regular';
  if (variety === 'multi') {
    const nlevels = Number(attr(g, `${name}_nlevels`));
    const levels: unknown[][] = [], codes: unknown[][] = [], names: (string | null)[] = [];
    for (let l = 0; l < nlevels; l++) {
      const lv = g.get(`${name}_level${l}`) as H5Dataset;
      levels.push(datasetValues(lv));
      codes.push(datasetValues(g.get(`${name}_label${l}`) as H5Dataset));
      const nm = attrText(lv, 'name');
      names.push(nm === undefined || nm === 'N.' ? null : nm);
    }
    const n = codes[0].length;
    return new Index(Array.from({ length: n }, (_, i) => levels.map((lv, l) => (Number(codes[l][i]) < 0 ? null : lv[Number(codes[l][i])]) as Label)), { names });
  }
  const ds = g.get(name) as H5Dataset;
  const nm = attrText(ds, 'name');
  const labels = datasetValues(ds) as Label[];
  const isRange = labels.every((v, i) => v === i);
  return new Index(labels, { name: nm === undefined || nm === 'N.' ? null : nm, isDefault: isRange && (nm === undefined || nm === 'N.') });
}

function readFixedFrame(g: H5Group): DataFrame {
  const columns = readAxis(g, 'axis0');
  const index = readAxis(g, 'axis1');
  const nblocks = Number(attr(g, 'nblocks'));
  const n = index.length;
  const byName = new Map<string, unknown[]>();
  for (let b = 0; b < nblocks; b++) {
    const items = datasetValues(g.get(`block${b}_items`) as H5Dataset).map(String);
    const ds = g.get(`block${b}_values`) as H5Dataset;
    const vals = datasetValues(ds);
    // Blocks are stored transposed: rows × items, row-major.
    items.forEach((name, j) => {
      byName.set(name, Array.from({ length: n }, (_, i) => (vals.length === n * items.length ? vals[i * items.length + j] : vals[j * n + i])));
    });
  }
  const cols = new Map<string, Column>();
  for (const name of columns.labels.map(String)) cols.set(name, Column.from(byName.get(name) ?? new Array(n).fill(null)));
  return DataFrame._fromColumns(cols, index);
}

function readTableFrame(g: H5Group): DataFrame {
  const table = g.get('table') as H5Dataset;
  const rows = table.value as unknown[][];
  const fieldNames = Object.keys(table.attrs).filter((k) => /^FIELD_\d+_NAME$/.test(k)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1])).map((k) => attrText(table, k)!);
  const nonIndex = pickled(g, 'non_index_axes') as [number, string[]][];
  const order = nonIndex?.[0]?.[1] ?? [];
  const indexCols = (pickled(g, 'index_cols') as [number, string][]) ?? [];
  const nanRep = attrText(g, 'nan_rep') ?? 'nan';
  const byName = new Map<string, unknown[]>();
  const fieldPos = new Map(fieldNames.map((f, k) => [f, k]));
  // pandas stores UTF-8 bytes in ASCII-typed string fields; h5wasm decodes those byte by byte.
  const members = (table.metadata as { compound_type?: { members: { cset?: number; array_type?: { cset?: number } }[] } }).compound_type?.members ?? [];
  const fixUtf8 = (v: unknown): unknown => (typeof v === 'string' && /[\x80-\xff]/.test(v) ? Buffer.from(v, 'latin1').toString('utf8') : Array.isArray(v) ? v.map(fixUtf8) : v);
  for (const [f, k] of fieldPos) {
    const kindsRaw = attrText(table, `${f}_kind`);
    const dtype = attrText(table, `${f}_dtype`);
    const ascii = (members[k]?.cset ?? members[k]?.array_type?.cset) === 0;
    const raw = rows.map((r) => (ascii ? fixUtf8(r[k]) : r[k]));
    const blockNan = attrText(table, `${f}_nan_rep`) ?? (nanRep === 'N.' ? 'nan' : nanRep);
    if (kindsRaw?.startsWith('(')) {
      const names = plain(unpickle(Buffer.from(kindsRaw, 'latin1'))) as string[];
      names.forEach((name, j) => byName.set(name, decodeValues(raw.map((cell) => (Array.isArray(cell) || ArrayBuffer.isView(cell) ? (cell as ArrayLike<unknown>)[j] : cell)), dtype, blockNan)));
    } else byName.set(f, decodeValues(raw, attrText(table, `${f}_kind`) ?? dtype, nanRep));
  }
  const info = pickled(g, 'info') as Record<string, { names?: (string | null)[]; index_name?: string | null }> | undefined;
  const idxNames = indexCols.map(([, name]) => name);
  const levelValues = idxNames.map((name) => {
    const kind = attrText(table, `${name}_kind`);
    const values = byName.get(name) ?? [];
    return kind === 'datetime64' ? decodeValues(rows.map((r) => r[fieldPos.get(name)!]), 'datetime64[ns]', undefined) : values;
  });
  const n = rows.length;
  const names = info?.[idxNames[0]]?.names ?? info?.index?.names ?? (info?.index?.index_name !== undefined ? [info.index.index_name] : undefined);
  let index: Index;
  if (levelValues.length <= 1) {
    const labels = (levelValues[0] ?? Array.from({ length: n }, (_, i) => i)) as Label[];
    const nm = names?.[0] ?? null;
    index = new Index(labels, { name: nm, isDefault: nm === null && labels.every((v, i) => v === i) });
  } else index = new Index(Array.from({ length: n }, (_, i) => levelValues.map((v) => v[i] as Label)), { names: idxNames.map((x) => (/^level_\d+$/.test(x) ? null : x)) });
  const cols = new Map<string, Column>();
  for (const name of order.length ? order : [...byName.keys()].filter((k) => !idxNames.includes(k))) {
    const kind = byName.get(name)!;
    cols.set(String(name), Column.from(kind));
  }
  return DataFrame._fromColumns(cols, index);
}

/** Keys (groups written by pandas) in an HDF5 file. */
export async function hdfKeys(path: string): Promise<string[]> {
  const lib = await h5();
  const f = new lib.File(path, 'r');
  try {
    const out: string[] = [];
    const walk = (g: H5Group, prefix: string) => {
      for (const k of g.keys()) {
        const o = g.get(k);
        if (o instanceof lib.Group) {
          if (attrText(o, 'pandas_type')) out.push(`${prefix}/${k}`);
          else walk(o, `${prefix}/${k}`);
        }
      }
    };
    walk(f, '');
    return out;
  } finally { f.close(); }
}

/** Reads a frame/series stored by pandas (`to_hdf`, fixed or table format). Requires `h5wasm`. */
export async function readHdf(path: string, key?: string): Promise<DataFrame | Series> {
  const lib = await h5();
  let k = key;
  if (!k) {
    const keys = await hdfKeys(path);
    if (keys.length !== 1) throw new Error(`key must be provided when the file contains ${keys.length} datasets: ${keys.join(', ')}`);
    k = keys[0];
  }
  const f = new lib.File(path, 'r');
  try {
    const g = f.get(k.startsWith('/') ? k : `/${k}`);
    if (!(g instanceof lib.Group)) throw new Error(`No object named ${k} in the file`);
    const type = attrText(g, 'pandas_type');
    if (type === 'frame') return readFixedFrame(g);
    if (type === 'frame_table') return readTableFrame(g);
    if (type === 'series') {
      const index = readAxis(g, 'index');
      const values = datasetValues(g.get('values') as H5Dataset);
      const nm = attrText(g, 'name');
      return new Series(values, { index, name: nm === undefined || nm === 'N.' ? null : nm });
    }
    if (type === 'series_table') {
      const df = readTableFrame(g);
      return df.get(df.columns[0]);
    }
    throw new Error(`Unsupported pandas_type: ${String(type)}`);
  } finally { f.close(); }
}

// ------------------------------------------------------------------- write

export interface ToHdfOptions {
  /** 'a' (default) adds/replaces the key, 'w' truncates the file. */
  mode?: 'a' | 'w';
  /** Only 'table' is written (it is also pandas' appendable format). */
  format?: 'table';
}

/** Writes a frame in pandas' HDF5 'table' format, readable by `pd.read_hdf`. Requires `h5wasm`. */
export async function toHdf(df: DataFrame | Series, path: string, key: string, o: ToHdfOptions = {}): Promise<void> {
  const lib = await h5();
  const { existsSync } = await import('node:fs');
  const frame = df instanceof Series ? df.toFrame(df.name ?? '0') : df;
  if (o.mode !== 'w' && existsSync(path)) {
    // Replacing a key, like pandas: h5wasm cannot unlink a node, so the file is
    // rewritten with its other keys before the new one is added.
    const keys = await hdfKeys(path);
    const target = '/' + key.replace(/^\//, '');
    if (keys.includes(target)) {
      const others: [string, DataFrame | Series][] = [];
      for (const k of keys) if (k !== target) others.push([k, await readHdf(path, k)]);
      let mode: 'w' | 'a' = 'w';
      for (const [k, v] of others) { await toHdf(v, path, k, { ...o, mode }); mode = 'a'; }
      return toHdf(df, path, key, { ...o, mode });
    }
  }
  const f = new lib.File(path, o.mode === 'w' || !existsSync(path) ? 'w' : 'a');
  try {
    const name = key.replace(/^\//, '');
    // PyTables only unpickles fixed-length string attributes, so write every text attribute that way.
    const setText = (o: { create_attribute: (n: string, d: string, s?: number[] | null, t?: string) => void; attrs: Record<string, unknown>; delete_attribute?: (n: string) => void }, a: string, v: string) => {
      if (o.attrs[a] && o.delete_attribute) o.delete_attribute(a);
      o.create_attribute(a, v, [], `${/^\(.*\.$/s.test(v) ? "A" : "S"}${Math.max(1, Buffer.byteLength(v))}`);
    };
    for (const [a, v] of [['CLASS', 'GROUP'], ['PYTABLES_FORMAT_VERSION', '2.1'], ['TITLE', ''], ['VERSION', '1.0']]) setText(f as never, a, v);
    const g = f.create_group(name);
    const index = frame.index;
    if (index.isMulti) throw new Error('toHdf does not support MultiIndex rows yet; resetIndex() first');
    const n = frame.length;
    const fields = new Map<string, unknown>();
    const dtypes: [string, string, number[]?][] = [];
    const tableAttrs: [string, string][] = [];
    // Index column.
    const idxVals = index.labels;
    const idxKind = idxVals.every((v) => typeof v === 'number' && Number.isInteger(v)) ? 'integer' : idxVals.every((v) => v instanceof Date) ? 'datetime64' : 'string';
    if (idxKind === 'integer') { fields.set('index', BigInt64Array.from(idxVals as number[], (v) => BigInt(v))); dtypes.push(['index', '<q']); }
    else if (idxKind === 'datetime64') { fields.set('index', BigInt64Array.from(idxVals as Date[], (v) => BigInt(v.getTime()) * 1_000_000n)); dtypes.push(['index', '<q']); }
    else {
      const strs = idxVals.map((v) => (isNA(v) ? 'null' : String(v)));
      fields.set('index', strs);
      dtypes.push(['index', `S${Math.max(1, ...strs.map((s) => Buffer.byteLength(s)))}`]);
    }
    tableAttrs.push(['index_kind', idxKind], ['index_nan_rep', 'null']);
    const valuesCols: string[] = [];
    frame.columns.forEach((colName, b) => {
      const c = frame._column(colName);
      const field = `values_block_${b}`;
      valuesCols.push(field);
      let dtype: string, kind: string, meta = 'N.';
      switch (c.dtype) {
        case 'int64': case 'bigint':
          fields.set(field, BigInt64Array.from(c.toArray(), (v) => BigInt(v as number))); dtype = '<q'; kind = 'int64'; break;
        case 'float64': case 'Float64': case 'Int64':
          fields.set(field, Float64Array.from(c.data as Float64Array)); dtype = '<d'; kind = 'float64'; break;
        case 'bool':
          fields.set(field, Int8Array.from(c.data as Uint8Array)); dtype = '<b'; kind = 'bool'; break;
        case 'datetime':
          fields.set(field, BigInt64Array.from(c.data as Float64Array, (t) => (t !== t ? NAT : BigInt(Math.round(t)) * 1_000_000n))); dtype = '<q'; kind = 'datetime64[ns]'; break;
        default: {
          const strs = c.toArray().map((v) => (isNA(v) ? 'nan' : String(v)));
          const width = Math.max(1, ...strs.map((s) => Buffer.byteLength(s)));
          fields.set(field, strs); dtype = `S${width}`; kind = `bytes${width}`; meta = 'str';
          tableAttrs.push([`${field}_nan_rep`, 'nan']);
        }
      }
      dtypes.push([field, dtype]);
      tableAttrs.push([`${field}_dtype`, kind], [`${field}_kind`, pickle0([colName])], [`${field}_meta`, meta]);
    });
    const ds = g.create_dataset({ name: 'table', data: fields as Map<string, never>, dtype: dtypes as never, shape: [n] });
    [...fields.keys()].forEach((fname, k) => {
      setText(ds as never, `FIELD_${k}_NAME`, fname);
      setText(ds as never, `FIELD_${k}_FILL`, fname === 'index' && idxKind === 'string' ? '' : '0');
    });
    for (const [a, v] of [['CLASS', 'TABLE'], ['VERSION', '2.7'], ['TITLE', ''], ...tableAttrs] as [string, string][]) setText(ds as never, a, v);
    ds.create_attribute('NROWS', BigInt64Array.from([BigInt(n)]), [], '<q');
    const groupAttrs: [string, string][] = [
      ['CLASS', 'GROUP'], ['TITLE', ''], ['VERSION', '1.0'],
      ['pandas_type', df instanceof Series ? 'series_table' : 'frame_table'], ['pandas_version', '0.15.2'], ['table_type', df instanceof Series ? 'appendable_series' : 'appendable_frame'],
      ['encoding', 'UTF-8'], ['errors', 'strict'], ['nan_rep', 'nan'], ['levels', '1'],
      ['index_cols', pickle0([tuple([0, 'index'])])], ['values_cols', pickle0(valuesCols)],
      ['non_index_axes', pickle0([tuple([1, frame.columns])])], ['data_columns', pickle0([])],
      ['info', pickle0({ 1: { names: [null], type: 'Index' }, index: index.name !== null ? { index_name: index.name } : {}, ...Object.fromEntries(valuesCols.map((v) => [v, {}])) })],
      ['metadata', pickle0([])],
    ];
    for (const [a, v] of groupAttrs) setText(g as never, a, v);
  } finally { f.close(); }
}
