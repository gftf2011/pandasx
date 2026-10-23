/** A bounded interval such as (0.5, 1.0], like `pandas.Interval`. */
export type IntervalClosed = 'right' | 'left' | 'both' | 'neither';

/** Python's repr of a float: integers keep a trailing '.0'. */
export function pyFloat(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

export class Interval {
  readonly left: number;
  readonly right: number;
  readonly closed: IntervalClosed;
  /** Print bounds as integers (bins given as integers). */
  private readonly ints: boolean;

  constructor(left: number, right: number, closed: IntervalClosed = 'right', options: { integerBounds?: boolean } = {}) {
    if (left > right) throw new RangeError('left side of interval must be <= right side');
    this.left = left;
    this.right = right;
    this.closed = closed;
    this.ints = options.integerBounds ?? false;
  }

  get mid(): number { return (this.left + this.right) / 2; }
  get length(): number { return this.right - this.left; }
  get closedLeft(): boolean { return this.closed === 'left' || this.closed === 'both'; }
  get closedRight(): boolean { return this.closed === 'right' || this.closed === 'both'; }

  contains(v: number): boolean {
    return (this.closedLeft ? v >= this.left : v > this.left) && (this.closedRight ? v <= this.right : v < this.right);
  }

  overlaps(other: Interval): boolean {
    const leftOk = other.closedLeft && this.closedRight ? other.left <= this.right : other.left < this.right;
    const rightOk = this.closedLeft && other.closedRight ? this.left <= other.right : this.left < other.right;
    return leftOk && rightOk;
  }

  toString(): string {
    const f = (v: number) => (this.ints ? String(v) : pyFloat(v));
    return `${this.closedLeft ? '[' : '('}${f(this.left)}, ${f(this.right)}${this.closedRight ? ']' : ')'}`;
  }

  toJSON(): string { return this.toString(); }

  [Symbol.for('nodejs.util.inspect.custom')](): string { return `Interval(${this.left}, ${this.right}, closed='${this.closed}')`; }
}
