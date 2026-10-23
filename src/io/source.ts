/** Reading/writing bytes from paths, URLs and buffers, with transparent compression. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as zlib from 'node:zlib';

export type Compression = 'infer' | 'gzip' | 'deflate' | 'brotli' | 'zstd' | 'zip' | null;

/** Something to read from: a path, a URL, a Buffer / Uint8Array, or (for text formats) the content itself. */
export type Source = string | URL | Uint8Array | ArrayBuffer;

const EXT: [RegExp, Exclude<Compression, 'infer' | null>][] = [
  [/\.gz$/i, 'gzip'], [/\.zz$/i, 'deflate'], [/\.br$/i, 'brotli'], [/\.zst$/i, 'zstd'], [/\.zip$/i, 'zip'],
];

export function inferCompression(path: string | null, compression: Compression | undefined): Exclude<Compression, 'infer'> {
  if (compression === undefined || compression === 'infer') {
    if (!path) return null;
    for (const [re, c] of EXT) if (re.test(path)) return c;
    if (/\.(bz2|xz|tar)$/i.test(path)) throw new Error(`Compression of ${path} is not supported (gzip, deflate, brotli, zstd and zip are)`);
    return null;
  }
  return compression;
}

/** Sniffs compressed content by its magic bytes. */
function sniff(buf: Uint8Array): Exclude<Compression, 'infer' | null> | null {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) return 'zstd';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  return null;
}

export function decompress(buf: Uint8Array, c: Exclude<Compression, 'infer'>): Buffer {
  switch (c) {
    case null: return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    case 'gzip': return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'brotli': return zlib.brotliDecompressSync(buf);
    case 'zstd': return zlib.zstdDecompressSync(buf);
    case 'zip': return unzipSingle(buf);
  }
}

export function compress(buf: Uint8Array, c: Exclude<Compression, 'infer'>, name = 'data'): Buffer {
  switch (c) {
    case null: return Buffer.from(buf);
    case 'gzip': return zlib.gzipSync(buf);
    case 'deflate': return zlib.deflateSync(buf);
    case 'brotli': return zlib.brotliCompressSync(buf);
    case 'zstd': return zlib.zstdCompressSync(buf);
    case 'zip': return zipSingle(buf, name);
  }
}

const isUrl = (s: string) => /^(https?|ftp|s3|gs|file):\/\//i.test(s);

/** Synchronously reads bytes from a path or buffer (URLs need the async variant). */
export function readBytesSync(source: Source, compression?: Compression): Buffer {
  if (typeof source === 'string' || source instanceof URL) {
    const s = String(source);
    if (isUrl(s) && !s.startsWith('file:')) throw new Error(`Reading from a URL is asynchronous: use the *Async reader for ${s}`);
    const raw = readFileSync(s.startsWith('file:') ? new URL(s) : s);
    const c = compression === undefined || compression === 'infer' ? inferCompression(s, 'infer') ?? sniff(raw) : compression;
    return decompress(raw, c);
  }
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  return decompress(bytes, compression === undefined || compression === 'infer' ? sniff(bytes) : compression);
}

/** Reads bytes from a path, URL (via fetch) or buffer. */
export async function readBytes(source: Source, compression?: Compression, options: { storageOptions?: RequestInit } = {}): Promise<Buffer> {
  if ((typeof source === 'string' || source instanceof URL) && isUrl(String(source)) && !String(source).startsWith('file:')) {
    const res = await fetch(String(source), options.storageOptions);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${String(source)}`);
    const raw = new Uint8Array(await res.arrayBuffer());
    const url = new URL(String(source));
    const c = compression === undefined || compression === 'infer' ? inferCompression(url.pathname, 'infer') ?? sniff(raw) : compression;
    return decompress(raw, c);
  }
  return readBytesSync(source, compression);
}

/**
 * Text content of a source. Strings that are not existing paths (and look like
 * data, e.g. contain a newline or start with '<' / '{' / '[') are treated as the content itself.
 */
export function readTextSync(source: Source, options: { compression?: Compression; encoding?: BufferEncoding; literal?: (s: string) => boolean } = {}): string {
  if (typeof source === 'string' && !existsSync(source) && !isUrl(source) && (options.literal ?? ((s) => /[\n<{[]/.test(s)))(source)) return source;
  return readBytesSync(source, options.compression).toString(options.encoding ?? 'utf8');
}

export async function readText(source: Source, options: { compression?: Compression; encoding?: BufferEncoding; literal?: (s: string) => boolean; storageOptions?: RequestInit } = {}): Promise<string> {
  if (typeof source === 'string' && !existsSync(source) && !isUrl(source) && (options.literal ?? ((s) => /[\n<{[]/.test(s)))(source)) return source;
  return (await readBytes(source, options.compression, options)).toString(options.encoding ?? 'utf8');
}

/** Writes text/bytes to `path`, compressing by extension (or `compression`). */
export function writeOutput(path: string, data: string | Uint8Array, compression?: Compression, encoding: BufferEncoding = 'utf8'): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, encoding) : data;
  const c = inferCompression(path, compression);
  writeFileSync(path, compress(bytes, c, path.replace(/^.*[\\/]/, '').replace(/\.zip$/i, '')));
}

// ---------------------------------------------------------------- zip (one file)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Extracts the first file of a zip archive (stored or deflated), like pandas with compression='zip'. */
function unzipSingle(buf: Uint8Array): Buffer {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Use the central directory: local headers may defer sizes to a data descriptor.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Invalid zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let k = 0; k < count; k++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nameLen)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported zip compression method ${method}`);
  }
  throw new Error('Zip archive is empty');
}

function zipSingle(data: Uint8Array, name: string): Buffer {
  const deflated = zlib.deflateRawSync(data);
  const fname = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fname.length, 28);
  const centralOffset = 30 + fname.length + deflated.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + fname.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fname, deflated, central, fname, end]);
}

// ------------------------------------------------------------ optional deps

/** Dynamically imports an optional peer dependency with an actionable error. */
export async function requireOptional<T>(name: string, feature: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(`${feature} requires the optional dependency "${name}". Install it with: npm install ${name}`);
    }
    throw e;
  }
}
