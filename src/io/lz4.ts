/** Minimal LZ4 frame codec (decoder + stored-block encoder), for Arrow IPC / Feather buffers. */

const MAGIC = 0x184d2204;

/** Decompresses one LZ4 block into `out` starting at `pos`; returns the new position. */
function decodeBlock(src: Uint8Array, out: Uint8Array, pos: number): number {
  let i = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
    out.set(src.subarray(i, i + lit), pos);
    i += lit;
    pos += lit;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[i++]; len += b; } while (b === 255); }
    len += 4;
    // Overlapping copies must go byte by byte.
    for (let k = 0; k < len; k++) out[pos + k] = out[pos - offset + k];
    pos += len;
  }
  return pos;
}

const MAX_BLOCK = [0, 0, 0, 0, 65_536, 262_144, 1_048_576, 4_194_304];

/** Decodes a concatenation of LZ4 frames. */
export function lz4Decode(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks: Uint8Array[] = [];
  let p = 0;
  while (p + 4 <= data.length) {
    const magic = view.getUint32(p, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) { p += 8 + view.getUint32(p + 4, true); continue; } // skippable frame
    if (magic !== MAGIC) throw new Error('Invalid LZ4 frame');
    const flg = data[p + 4];
    const bd = data[p + 5];
    p += 6;
    const contentSize = (flg & 0x08) !== 0;
    const blockChecksum = (flg & 0x10) !== 0;
    const contentChecksum = (flg & 0x04) !== 0;
    if (contentSize) p += 8;
    if (flg & 0x01) p += 4; // dictionary id
    p += 1; // header checksum
    const maxBlock = MAX_BLOCK[(bd >>> 4) & 7] || 4_194_304;
    for (;;) {
      const size = view.getUint32(p, true);
      p += 4;
      if (size === 0) break;
      const stored = (size & 0x80000000) !== 0;
      const len = size & 0x7fffffff;
      const block = data.subarray(p, p + len);
      p += len + (blockChecksum ? 4 : 0);
      if (stored) chunks.push(block.slice());
      else {
        const out = new Uint8Array(maxBlock);
        const n = decodeBlock(block, out, 0);
        chunks.push(out.subarray(0, n));
      }
    }
    if (contentChecksum) p += 4;
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Encodes as an LZ4 frame of stored (uncompressed) blocks: valid for any LZ4 reader. */
export function lz4EncodeStored(data: Uint8Array): Uint8Array {
  const BLOCK = 4_194_304;
  const blocks = Math.ceil(data.length / BLOCK);
  const out = new Uint8Array(7 + blocks * 4 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  out[4] = 0x60; // version 01, block independence
  out[5] = 0x70; // 4 MB max block
  out[6] = headerChecksum(out.subarray(4, 6));
  let p = 7;
  for (let k = 0; k < blocks; k++) {
    const chunk = data.subarray(k * BLOCK, Math.min((k + 1) * BLOCK, data.length));
    view.setUint32(p, (chunk.length | 0x80000000) >>> 0, true);
    out.set(chunk, p + 4);
    p += 4 + chunk.length;
  }
  view.setUint32(p, 0, true);
  return out;
}

/** Second byte of xxHash32(descriptor, 0), as required by the frame header. */
function headerChecksum(desc: Uint8Array): number {
  return (xxh32(desc, 0) >>> 8) & 0xff;
}

function xxh32(input: Uint8Array, seed: number): number {
  const P1 = 2654435761, P2 = 2246822519, P3 = 3266489917, P4 = 668265263, P5 = 374761393;
  const rotl = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0;
  const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;
  let i = 0;
  const len = input.length;
  let h: number;
  const u32 = (k: number) => (input[k] | (input[k + 1] << 8) | (input[k + 2] << 16) | (input[k + 3] << 24)) >>> 0;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) >>> 0, v2 = (seed + P2) >>> 0, v3 = seed >>> 0, v4 = (seed - P1) >>> 0;
    while (i <= len - 16) {
      v1 = mul(rotl((v1 + mul(u32(i), P2)) >>> 0, 13), P1); i += 4;
      v2 = mul(rotl((v2 + mul(u32(i), P2)) >>> 0, 13), P1); i += 4;
      v3 = mul(rotl((v3 + mul(u32(i), P2)) >>> 0, 13), P1); i += 4;
      v4 = mul(rotl((v4 + mul(u32(i), P2)) >>> 0, 13), P1); i += 4;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else h = (seed + P5) >>> 0;
  h = (h + len) >>> 0;
  while (i <= len - 4) { h = mul(rotl((h + mul(u32(i), P3)) >>> 0, 17), P4); i += 4; }
  while (i < len) { h = mul(rotl((h + mul(input[i], P5)) >>> 0, 11), P1); i++; }
  h ^= h >>> 15; h = mul(h, P2); h ^= h >>> 13; h = mul(h, P3); h ^= h >>> 16;
  return h >>> 0;
}
