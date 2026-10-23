/**
 * SQL I/O. A connection can be:
 * - a path / ':memory:' → opened with Node's built-in `node:sqlite`;
 * - a `node:sqlite` DatabaseSync or a better-sqlite3 Database (anything with `prepare`);
 * - a client with `query(sql, params)` (pg, mysql2/promise, ...) — `{ rows }`, `[rows]` or rows;
 * - `{ query(sql, params) => rows | Promise<rows> }` for anything else.
 */
import { Column } from '../core/column.ts';
import { Index } from '../core/indexes.ts';
import type { DType } from '../core/types.ts';
import { DataFrame } from '../frame.ts';
import { toDatetime } from '../datetimes.ts';
import { requireOptional } from './source.ts';

type Row = Record<string, unknown>;
/** A synchronous SQLite-style connection (node:sqlite DatabaseSync, better-sqlite3). */
export interface SyncDb { prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } ; exec?(sql: string): unknown; close?(): void }
/** A client with `query(sql, params)` (pg, mysql2/promise, or your own adapter). */
export interface AsyncDb { query(sql: string, params?: unknown[]): unknown }
export type SqlConnection = string | SyncDb | AsyncDb;

export type SqlDialect = 'sqlite' | 'postgres' | 'mysql' | 'generic';

interface Adapter {
  dialect: SqlDialect;
  all(sql: string, params: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params: readonly unknown[]): Promise<void>;
  close(): void;
}

async function adapter(conn: SqlConnection, dialectHint?: SqlDialect): Promise<Adapter> {
  if (typeof conn === 'string') {
    const { DatabaseSync } = await requireOptional<typeof import('node:sqlite')>('node:sqlite', 'SQLite paths');
    const db = new DatabaseSync(conn);
    const a = await adapter(db as unknown as SyncDb, 'sqlite');
    return { ...a, close: () => db.close() };
  }
  if ('prepare' in conn && typeof conn.prepare === 'function') {
    const db = conn as SyncDb;
    return {
      dialect: dialectHint ?? 'sqlite',
      all: async (sql, params) => db.prepare(sql).all(...params.map(sqliteValue)) as Row[],
      run: async (sql, params) => { db.prepare(sql).run(...params.map(sqliteValue)); },
      close: () => {},
    };
  }
  const db = conn as AsyncDb;
  const name = (db as { constructor?: { name?: string } }).constructor?.name ?? '';
  const dialect: SqlDialect = dialectHint ?? (/^(Client|Pool|PoolClient)$/.test(name) ? 'postgres' : /Connection|Pool/.test(name) ? 'mysql' : 'generic');
  const rowsOf = (res: unknown): Row[] => {
    if (Array.isArray(res)) return (Array.isArray(res[0]) ? res[0] : res) as Row[];
    if (res && typeof res === 'object' && 'rows' in res) return (res as { rows: Row[] }).rows;
    return [];
  };
  return {
    dialect,
    all: async (sql, params) => rowsOf(await db.query(sql, [...params])),
    run: async (sql, params) => { await db.query(sql, [...params]); },
    close: () => {},
  };
}

function sqliteValue(v: unknown): unknown {
  if (v === undefined || (typeof v === 'number' && Number.isNaN(v))) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return String(v);
  return v;
}

const quoteIdent = (name: string, dialect: SqlDialect) => (dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`);
const placeholder = (k: number, dialect: SqlDialect) => (dialect === 'postgres' ? `$${k + 1}` : '?');

export interface ReadSqlOptions {
  /** Query parameters (positional). */
  params?: readonly unknown[];
  indexCol?: string | readonly string[];
  /** Columns to convert to datetimes (or `{column: strptime format}`). */
  parseDates?: readonly string[] | Record<string, string>;
  /** Only these columns (readSqlTable). */
  columns?: readonly string[];
  dtype?: DType | Record<string, DType>;
  /** Yield frames of this many rows (fetches once, slices lazily). */
  chunksize?: number;
  /** Force the SQL dialect (placeholders / quoting). */
  dialect?: SqlDialect;
}

function rowsToFrame(rows: Row[], o: ReadSqlOptions, offset = 0): DataFrame {
  const names = rows.length ? Object.keys(rows[0]) : [];
  const cols = new Map<string, Column>();
  for (const n of names) {
    let vals = rows.map((r) => {
      const v = r[n];
      return typeof v === 'bigint' && Number.isSafeInteger(Number(v)) ? Number(v) : v;
    });
    const forced = typeof o.dtype === 'string' ? o.dtype : o.dtype?.[n];
    const pd = Array.isArray(o.parseDates) ? (o.parseDates.includes(n) ? '' : undefined) : (o.parseDates as Record<string, string> | undefined)?.[n];
    if (pd !== undefined) { cols.set(n, toDatetime(vals, pd ? { format: pd, errors: 'coerce' } : { errors: 'coerce' })._col); continue; }
    if (vals.some((v) => v instanceof Uint8Array)) vals = vals.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v));
    cols.set(n, Column.from(vals, forced));
  }
  let df = DataFrame._fromColumns(cols, Index.range(rows.length, offset));
  if (o.indexCol) df = df.setIndex(o.indexCol as string | string[]);
  return df;
}

/** Runs a query and returns its rows as a DataFrame, like `pd.read_sql_query`. */
export async function readSqlQuery(sql: string, conn: SqlConnection, o: ReadSqlOptions = {}): Promise<DataFrame> {
  const db = await adapter(conn, o.dialect);
  try {
    return rowsToFrame(await db.all(sql, o.params ?? []), o);
  } finally { db.close(); }
}

/** Reads a whole table (or some `columns`), like `pd.read_sql_table`. */
export async function readSqlTable(table: string, conn: SqlConnection, o: ReadSqlOptions = {}): Promise<DataFrame> {
  const db = await adapter(conn, o.dialect);
  try {
    const cols = o.columns ? o.columns.map((c) => quoteIdent(c, db.dialect)).join(', ') : '*';
    return rowsToFrame(await db.all(`SELECT ${cols} FROM ${quoteIdent(table, db.dialect)}`, []), o);
  } finally { db.close(); }
}

/** `readSqlQuery` for SQL text, `readSqlTable` for a bare table name, like `pd.read_sql`. */
export async function readSql(sqlOrTable: string, conn: SqlConnection, o: ReadSqlOptions = {}): Promise<DataFrame> {
  return /^\s*[\w."`[\]]+\s*$/.test(sqlOrTable) && !/^\s*select\b/i.test(sqlOrTable) ? readSqlTable(sqlOrTable.trim(), conn, o) : readSqlQuery(sqlOrTable, conn, o);
}

/** Query results in chunks of `chunksize` rows. */
export async function* readSqlChunks(sql: string, conn: SqlConnection, o: ReadSqlOptions & { chunksize: number }): AsyncGenerator<DataFrame> {
  const db = await adapter(conn, o.dialect);
  let rows: Row[];
  try { rows = await db.all(sql, o.params ?? []); } finally { db.close(); }
  for (let i = 0; i < rows.length; i += o.chunksize) yield rowsToFrame(rows.slice(i, i + o.chunksize), o, i);
}

export interface ToSqlOptions {
  /** 'fail' (default) if the table exists, 'replace' it, or 'append' to it. */
  ifExists?: 'fail' | 'replace' | 'append';
  /** Write the index as column(s) (default true). */
  index?: boolean;
  indexLabel?: string | readonly string[];
  /** SQL column types by column name. */
  dtype?: Record<string, string>;
  /** Rows per INSERT statement (default 500). */
  chunksize?: number;
  dialect?: SqlDialect;
}

function sqlType(dtype: DType, dialect: SqlDialect): string {
  switch (dtype) {
    case 'int64': case 'Int64': case 'bigint': return dialect === 'sqlite' ? 'INTEGER' : 'BIGINT';
    case 'float64': case 'Float64': return dialect === 'postgres' ? 'DOUBLE PRECISION' : dialect === 'mysql' ? 'DOUBLE' : 'REAL';
    case 'bool': case 'boolean': return dialect === 'sqlite' ? 'INTEGER' : 'BOOLEAN';
    case 'datetime': return dialect === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
    default: return 'TEXT';
  }
}

/** Writes a frame to a SQL table; returns the number of rows written. */
export async function toSql(df: DataFrame, table: string, conn: SqlConnection, o: ToSqlOptions = {}): Promise<number> {
  const db = await adapter(conn, o.dialect);
  try {
    const d = db.dialect;
    let frame = df;
    if (o.index ?? true) {
      const labels = typeof o.indexLabel === 'string' ? [o.indexLabel] : o.indexLabel;
      frame = df.resetIndex();
      if (labels) frame = frame.rename({ columns: Object.fromEntries(frame.columns.slice(0, labels.length).map((c, i) => [c, labels[i]])) });
    }
    const names = frame.columns;
    const q = (n: string) => quoteIdent(n, d);
    const exists = await tableExists(db, table);
    if (exists && (o.ifExists ?? 'fail') === 'fail') throw new Error(`Table '${table}' already exists`);
    if (exists && o.ifExists === 'replace') await db.run(`DROP TABLE ${q(table)}`, []);
    if (!exists || o.ifExists === 'replace') {
      const defs = names.map((n) => `${q(n)} ${o.dtype?.[n] ?? sqlType(frame._column(n).dtype, d)}`).join(', ');
      await db.run(`CREATE TABLE ${q(table)} (${defs})`, []);
    }
    const size = o.chunksize ?? 500;
    const cols = names.map((n) => frame._column(n));
    for (let start = 0; start < frame.length; start += size) {
      const end = Math.min(start + size, frame.length);
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (let i = start; i < end; i++) {
        tuples.push(`(${cols.map((c) => { params.push(dbValue(c.get(i), d)); return placeholder(params.length - 1, d); }).join(', ')})`);
      }
      if (d === 'sqlite') await db.run('BEGIN', []).catch(() => {});
      await db.run(`INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES ${tuples.join(', ')}`, params);
      if (d === 'sqlite') await db.run('COMMIT', []).catch(() => {});
    }
    return frame.length;
  } finally { db.close(); }
}

function dbValue(v: unknown, d: SqlDialect): unknown {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return null;
  if (d === 'sqlite') return sqliteValue(v);
  if (typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array)) return String(v);
  return v;
}

async function tableExists(db: Adapter, table: string): Promise<boolean> {
  if (db.dialect === 'sqlite') return (await db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table])).length > 0;
  const ph = placeholder(0, db.dialect);
  const rows = await db.all(`SELECT table_name FROM information_schema.tables WHERE table_name = ${ph}`, [table]).catch(() => []);
  return rows.length > 0;
}

