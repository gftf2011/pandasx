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
}

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
      const locs = index.getLoc(l);
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
