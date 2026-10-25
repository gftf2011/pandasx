// Deterministic synthetic dataset shared by every adapter.
import { writeFileSync } from 'node:fs';

export const KEYS = 1000;
export const CATS = 10;

// mulberry32: small, fast, reproducible PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** Columns: id (int), key (1000 distinct strings), cat (10 distinct strings), x, y (floats), n (int). */
export function generate(rows, seed = 42) {
  const rand = rng(seed);
  const id = new Array(rows), key = new Array(rows), cat = new Array(rows);
  const x = new Array(rows), y = new Array(rows), n = new Array(rows);
  for (let i = 0; i < rows; i++) {
    id[i] = i;
    key[i] = `k${Math.floor(rand() * KEYS)}`;
    cat[i] = `c${Math.floor(rand() * CATS)}`;
    x[i] = round6(rand());
    y[i] = round6((rand() + rand() + rand() - 1.5) * 100);
    n[i] = Math.floor(rand() * 100);
  }
  return { id, key, cat, x, y, n };
}

/** Right-hand table for the join: one row per key. */
export function lookup() {
  const key = [], weight = [];
  for (let i = 0; i < KEYS; i++) {
    key.push(`k${i}`);
    weight.push(round6(i / KEYS));
  }
  return { key, weight };
}

export function writeCsv(path, cols) {
  const names = Object.keys(cols);
  const rows = cols[names[0]].length;
  const lines = [names.join(',')];
  for (let i = 0; i < rows; i++) lines.push(names.map((c) => cols[c][i]).join(','));
  writeFileSync(path, lines.join('\n') + '\n');
}
