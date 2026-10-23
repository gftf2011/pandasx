import type { Label } from './types.ts';
import { Column } from './column.ts';
import { Series } from '../series.ts';
import { compareValues, hashKey } from './values.ts';

/**
 * Immutable sequence of row (or column) labels with hash lookup.
 *
 * Labels may be tuples, which is how multi-key groupby results are indexed;
 * `names` then holds one name per tuple level.
 */
export class Index {
  readonly labels: readonly Label[];
  readonly name: string | null;
  readonly names: readonly (string | null)[] | null;
  /** True for the default 0..n-1 index. */
  readonly isDefault: boolean;
  /** Time zone in which datetime labels are displayed / binned (null = naive). */
  readonly tz: string | null;
  private lookup: Map<unknown, number[]> | null = null;

  constructor(
    labels: readonly Label[],
    options: { name?: string | null; names?: readonly (string | null)[] | null; isDefault?: boolean; tz?: string | null } = {},
  ) {
    this.labels = labels;
    this.name = options.name ?? null;
    this.names = options.names ?? null;
    this.isDefault = options.isDefault ?? false;
    this.tz = options.tz ?? null;
  }

  static range(n: number, start = 0): Index {
    const labels = new Array<number>(n);
    for (let i = 0; i < n; i++) labels[i] = start + i;
    return new Index(labels, { isDefault: start === 0 });
  }

  get length(): number {
    return this.labels.length;
  }

  /** Number of tuple levels (1 for a flat index). */
  get nlevels(): number {
    return this.names?.length ?? 1;
  }

  private map(): Map<unknown, number[]> {
    if (!this.lookup) {
      const m = new Map<unknown, number[]>();
      this.labels.forEach((l, i) => {
        const k = hashKey(l);
        const list = m.get(k);
        if (list) list.push(i);
        else m.set(k, [i]);
      });
      this.lookup = m;
    }
    return this.lookup;
  }

  /** All positions holding `label` (empty when absent). */
  getLoc(label: Label): readonly number[] {
    return this.map().get(hashKey(label)) ?? [];
  }

  has(label: Label): boolean {
    return this.map().has(hashKey(label));
  }

  get isUnique(): boolean {
    return this.map().size === this.length;
  }

  /** Position of each label in this index, -1 when missing. Requires a unique index. */
  getIndexer(labels: readonly Label[]): Int32Array {
    if (!this.isUnique) throw new Error('Cannot reindex on an index with duplicate labels');
    const m = this.map();
    const out = new Int32Array(labels.length);
    for (let i = 0; i < labels.length; i++) out[i] = m.get(hashKey(labels[i]))?.[0] ?? -1;
    return out;
  }

  equals(other: Index): boolean {
    if (this === other) return true;
    if (this.length !== other.length) return false;
    if (this.isDefault && other.isDefault) return true;
    for (let i = 0; i < this.length; i++) {
      if (hashKey(this.labels[i]) !== hashKey(other.labels[i])) return false;
    }
    return true;
  }

  take(positions: ArrayLike<number>): Index {
    const out = new Array<Label>(positions.length);
    for (let i = 0; i < positions.length; i++) out[i] = positions[i] < 0 ? null : this.labels[positions[i]];
    return new Index(out, { name: this.name, names: this.names, tz: this.tz });
  }

  /** Sorted union of labels (order of appearance if labels cannot be sorted meaningfully). */
  union(other: Index): Index {
    const seen = new Set<unknown>();
    const out: Label[] = [];
    for (const l of [...this.labels, ...other.labels]) {
      const k = hashKey(l);
      if (!seen.has(k)) { seen.add(k); out.push(l); }
    }
    out.sort(compareValues);
    return new Index(out, { name: this.name === other.name ? this.name : null, names: this.names });
  }

  rename(name: string | null): Index {
    return new Index(this.labels, { name, names: this.names, isDefault: this.isDefault, tz: this.tz });
  }

  /** Labels as a Series (indexed by themselves), e.g. to use `.dt` on a datetime index. */
  toSeries(): Series {
    const col = Column.from(this.labels);
    return Series._from(this.tz && col.dtype === 'datetime' ? new Column('datetime', col.data, { tz: this.tz }) : col, this, this.name);
  }

  /** Whether labels never decrease. */
  get isMonotonicIncreasing(): boolean {
    for (let i = 1; i < this.length; i++) if (compareValues(this.labels[i - 1], this.labels[i]) > 0) return false;
    return true;
  }

  get isMonotonicDecreasing(): boolean {
    for (let i = 1; i < this.length; i++) if (compareValues(this.labels[i - 1], this.labels[i]) < 0) return false;
    return true;
  }

  toArray(): Label[] {
    return [...this.labels];
  }

  // ---------------------------------------------------------- MultiIndex API

  get isMulti(): boolean {
    return this.names !== null && this.names.length > 1;
  }

  /** Position of a level given by number (negative from the end) or name. */
  levelNumber(level: number | string): number {
    const n = this.nlevels;
    if (typeof level === 'number') {
      const l = level < 0 ? n + level : level;
      if (l < 0 || l >= n) throw new RangeError(`Too many levels: Index has only ${n} levels, not ${level + 1}`);
      return l;
    }
    const names = this.isMulti ? this.names! : [this.name];
    const l = names.indexOf(level);
    if (l < 0) throw new Error(`Level ${level} not found`);
    return l;
  }

  /** Values of one level, in row order. */
  getLevelValues(level: number | string): Index {
    const l = this.levelNumber(level);
    if (!this.isMulti) return this;
    return new Index(this.labels.map((t) => (t as readonly Label[])[l]), { name: this.names![l], tz: this.tz });
  }

  /** Sorted unique values of each level. */
  get levels(): Label[][] {
    return Array.from({ length: this.nlevels }, (_, l) => {
      const seen = new Map<unknown, Label>();
      for (const v of this.getLevelValues(l).labels) if (v !== null) seen.set(hashKey(v), v);
      return [...seen.values()].sort(compareValues);
    });
  }

  /** Index built from per-level arrays of the given positions (1 level → flat index). */
  private fromLevels(levels: number[]): Index {
    if (levels.length === 1) return this.getLevelValues(levels[0]);
    const names = levels.map((l) => this.names![l]);
    return new Index(this.labels.map((t) => levels.map((l) => (t as readonly Label[])[l])), { names, tz: this.tz });
  }

  /** Removes level(s). */
  droplevel(level: number | string | readonly (number | string)[]): Index {
    if (!this.isMulti) throw new Error('Cannot remove levels from an Index with a single level');
    const drop = new Set((Array.isArray(level) ? level : [level as number | string]).map((l) => this.levelNumber(l)));
    const keep = Array.from({ length: this.nlevels }, (_, l) => l).filter((l) => !drop.has(l));
    if (keep.length === 0) throw new Error('Cannot remove all levels');
    return this.fromLevels(keep);
  }

  swaplevel(i: number | string = -2, j: number | string = -1): Index {
    const order = Array.from({ length: this.nlevels }, (_, l) => l);
    const a = this.levelNumber(i), b = this.levelNumber(j);
    [order[a], order[b]] = [order[b], order[a]];
    return this.fromLevels(order);
  }

  reorderLevels(order: readonly (number | string)[]): Index {
    return this.fromLevels(order.map((l) => this.levelNumber(l)));
  }

  setNames(names: string | null | readonly (string | null)[]): Index {
    if (this.isMulti) {
      if (!Array.isArray(names) || names.length !== this.nlevels) throw new RangeError(`Need ${this.nlevels} names`);
      return new Index(this.labels, { names: names as (string | null)[], tz: this.tz });
    }
    return this.rename(Array.isArray(names) ? (names[0] ?? null) : (names as string | null));
  }

  /** Positions whose tuple label starts with `prefix`. */
  getLocPrefix(prefix: readonly Label[]): number[] {
    if (prefix.length === this.nlevels) return [...this.getLoc(prefix)];
    const keys = prefix.map(hashKey);
    const out: number[] = [];
    this.labels.forEach((t, i) => {
      const tuple = t as readonly Label[];
      if (keys.every((k, l) => hashKey(tuple[l]) === k)) out.push(i);
    });
    return out;
  }

  /** MultiIndex from tuples, like `pd.MultiIndex.from_tuples`. */
  static fromTuples(tuples: readonly (readonly Label[])[], options: { names?: readonly (string | null)[] } = {}): Index {
    const n = tuples[0]?.length ?? options.names?.length ?? 2;
    return new Index(tuples.map((t) => [...t]), { names: options.names ?? new Array(n).fill(null) });
  }

  /** MultiIndex from one array per level. */
  static fromArrays(arrays: readonly (readonly Label[])[], options: { names?: readonly (string | null)[] } = {}): Index {
    const n = arrays[0]?.length ?? 0;
    if (arrays.some((a) => a.length !== n)) throw new RangeError('all arrays must be the same length');
    return Index.fromTuples(Array.from({ length: n }, (_, i) => arrays.map((a) => a[i])), { names: options.names ?? arrays.map(() => null) });
  }

  /** Cartesian product of the levels, like `pd.MultiIndex.from_product`. */
  static fromProduct(levels: readonly (readonly Label[])[], options: { names?: readonly (string | null)[] } = {}): Index {
    let tuples: Label[][] = [[]];
    for (const level of levels) tuples = tuples.flatMap((t) => level.map((v) => [...t, v]));
    return Index.fromTuples(tuples, { names: options.names ?? levels.map(() => null) });
  }
}

/** `pd.MultiIndex`-style constructors (a MultiIndex is an Index with tuple labels and level names). */
export const MultiIndex = {
  fromTuples: Index.fromTuples,
  fromArrays: Index.fromArrays,
  fromProduct: Index.fromProduct,
};

/**
 * Slice for loc/iloc. With `iloc` bounds are positions and `stop` is exclusive;
 * with `loc` bounds are labels and `stop` is inclusive, as in pandas.
 */
export class Slice {
  readonly start: Label | undefined;
  readonly stop: Label | undefined;
  readonly step: number;

  constructor(start?: Label, stop?: Label, step = 1) {
    if (step === 0) throw new RangeError('slice step cannot be zero');
    this.start = start ?? undefined;
    this.stop = stop ?? undefined;
    this.step = step;
  }

  /** Positions selected from a sequence of length `n` (positional semantics). */
  positions(n: number): number[] {
    const norm = (v: Label | undefined, dflt: number) => {
      if (v === undefined) return dflt;
      if (typeof v !== 'number') throw new TypeError('iloc slice bounds must be integers');
      return v < 0 ? Math.max(n + v, this.step > 0 ? 0 : -1) : Math.min(v, this.step > 0 ? n : n - 1);
    };
    const out: number[] = [];
    if (this.step > 0) {
      for (let i = norm(this.start, 0); i < norm(this.stop, n); i += this.step) out.push(i);
    } else {
      for (let i = norm(this.start, n - 1); i > norm(this.stop, -1); i += this.step) out.push(i);
    }
    return out;
  }

  /** Positions selected from an index by label bounds (inclusive stop). */
  labelPositions(index: Index): number[] {
    const bound = (l: Label | undefined, first: boolean): number | undefined => {
      if (l === undefined) return undefined;
      const locs = index.isMulti ? index.getLocPrefix(Array.isArray(l) ? (l as readonly Label[]) : [l]) : index.getLoc(l);
      if (locs.length === 0) throw new RangeError(`Label not found in index: ${String(l)}`);
      return first ? locs[0] : locs[locs.length - 1];
    };
    const start = bound(this.start, this.step > 0);
    const stop = bound(this.stop, this.step < 0);
    const stopExclusive = stop === undefined ? undefined : stop + (this.step > 0 ? 1 : -1);
    return new Slice(start, stopExclusive === -1 ? undefined : stopExclusive, this.step).positions(index.length);
  }
}

/** `slice(1, 3)` ≈ Python's `1:3`. */
export function slice(start?: Label, stop?: Label, step = 1): Slice {
  return new Slice(start, stop, step);
}
