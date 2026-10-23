/** Numeric kernels: ranking, correlation and interpolation. */

export type RankMethod = 'average' | 'min' | 'max' | 'first' | 'dense';
export type NaOption = 'keep' | 'top' | 'bottom';

export interface RankOptions {
  method?: RankMethod;
  ascending?: boolean;
  /** Where NA values go: 'keep' leaves them NaN (default), 'top'/'bottom' ranks them. */
  naOption?: NaOption;
  /** Express ranks as fractions of the number of ranked values. */
  pct?: boolean;
}

/**
 * Ranks values (1-based). `cmp` orders two valid positions; `missing` flags NA.
 */
export function rankPositions(n: number, missing: (i: number) => boolean, cmp: (a: number, b: number) => number, options: RankOptions = {}): Float64Array {
  const method = options.method ?? 'average';
  const asc = options.ascending ?? true;
  const naOption = options.naOption ?? 'keep';
  const valid: number[] = [];
  const nas: number[] = [];
  for (let i = 0; i < n; i++) (missing(i) ? nas : valid).push(i);
  valid.sort((a, b) => (asc ? cmp(a, b) : cmp(b, a)) || a - b);

  // Tie groups in rank order; NA positions form one group at the top or bottom.
  const groups: number[][] = [];
  if (naOption === 'top' && nas.length) groups.push(nas);
  for (let i = 0; i < valid.length; ) {
    let j = i;
    while (j + 1 < valid.length && cmp(valid[j + 1], valid[i]) === 0) j++;
    groups.push(valid.slice(i, j + 1));
    i = j + 1;
  }
  if (naOption === 'bottom' && nas.length) groups.push(nas);

  const out = new Float64Array(n).fill(NaN);
  let start = 0;
  let dense = 0;
  for (const g of groups) {
    dense++;
    g.forEach((p, k) => {
      switch (method) {
        case 'min': out[p] = start + 1; break;
        case 'max': out[p] = start + g.length; break;
        case 'first': out[p] = start + k + 1; break;
        case 'dense': out[p] = dense; break;
        default: out[p] = start + (g.length + 1) / 2;
      }
    });
    start += g.length;
  }
  if (options.pct) {
    const denom = method === 'dense' ? dense : start;
    for (let i = 0; i < n; i++) out[i] /= denom;
  }
  return out;
}

/** Average ranks of the finite values of `x` (NaN stays NaN). */
export function averageRanks(x: ArrayLike<number>): Float64Array {
  return rankPositions(x.length, (i) => x[i] !== x[i], (a, b) => x[a] - x[b]);
}

export type CorrMethod = 'pearson' | 'spearman' | 'kendall';

/** Correlation over pairwise-complete observations. */
export function correlation(x: ArrayLike<number>, y: ArrayLike<number>, method: CorrMethod = 'pearson', minPeriods = 1): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] === x[i] && y[i] === y[i]) { xs.push(x[i]); ys.push(y[i]); }
  }
  if (xs.length < Math.max(minPeriods, 2)) return NaN;
  if (method === 'kendall') return kendallTau(xs, ys);
  if (method === 'spearman') return pearson(averageRanks(xs), averageRanks(ys));
  return pearson(xs, ys);
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Sample covariance over pairwise-complete observations. */
export function covariance(x: ArrayLike<number>, y: ArrayLike<number>, minPeriods = 1, ddof = 1): number {
  let n = 0, mx = 0, my = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === x[i] && y[i] === y[i]) { n++; mx += x[i]; my += y[i]; }
  if (n < Math.max(minPeriods, 1) || n - ddof <= 0) return NaN;
  mx /= n; my /= n;
  let s = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === x[i] && y[i] === y[i]) s += (x[i] - mx) * (y[i] - my);
  return s / (n - ddof);
}

/** Kendall's tau-b (handles ties), O(n²). */
function kendallTau(x: number[], y: number[]): number {
  let concordant = 0, discordant = 0, tiesX = 0, tiesY = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const dx = Math.sign(x[i] - x[j]);
      const dy = Math.sign(y[i] - y[j]);
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) tiesX++;
      else if (dy === 0) tiesY++;
      else if (dx === dy) concordant++;
      else discordant++;
    }
  }
  return (concordant - discordant) / Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
}

// ------------------------------------------------------------- interpolation

export type InterpolateMethod =
  | 'linear' | 'time' | 'index' | 'values' | 'nearest' | 'zero' | 'pad' | 'ffill' | 'bfill' | 'backfill'
  | 'slinear' | 'quadratic' | 'cubic' | 'cubicspline' | 'spline' | 'polynomial' | 'pchip' | 'akima';

export interface InterpolateOptions {
  method?: InterpolateMethod;
  /** Polynomial / spline order (for 'spline' and 'polynomial'). */
  order?: number;
  /** Maximum number of consecutive NAs to fill. */
  limit?: number;
  limitDirection?: 'forward' | 'backward' | 'both';
  /** 'inside' fills only NAs surrounded by valid values; 'outside' only outside them. */
  limitArea?: 'inside' | 'outside';
}

/**
 * Fills NaNs in `y` given abscissae `x` (positions, index values or times).
 * Returns a new array.
 */
export function interpolate(y: ArrayLike<number>, x: ArrayLike<number>, options: InterpolateOptions = {}): Float64Array {
  const method = options.method ?? 'linear';
  const n = y.length;
  const out = Float64Array.from(y);
  const known: number[] = [];
  for (let i = 0; i < n; i++) if (y[i] === y[i]) known.push(i);
  if (known.length === 0) return out;

  const kx = known.map((i) => x[i]);
  const ky = known.map((i) => y[i]);
  let evaluate: (xv: number, i: number) => number;
  switch (method) {
    case 'pad':
    case 'ffill':
    case 'zero':
      evaluate = (_, i) => valueBefore(out, known, i, y);
      break;
    case 'bfill':
    case 'backfill':
      evaluate = (_, i) => valueAfter(known, i, y);
      break;
    case 'nearest':
      evaluate = (xv) => ky[nearestIndex(kx, xv)];
      break;
    case 'cubic':
    case 'cubicspline':
      evaluate = notAKnotSpline(kx, ky);
      break;
    case 'spline':
      evaluate = (options.order ?? 3) === 3 ? notAKnotSpline(kx, ky) : localPolynomial(kx, ky, options.order ?? 3);
      break;
    case 'quadratic':
      evaluate = localPolynomial(kx, ky, 2);
      break;
    case 'polynomial':
      if (options.order === undefined) throw new Error("interpolate(method='polynomial') requires `order`");
      evaluate = localPolynomial(kx, ky, options.order);
      break;
    case 'pchip':
      evaluate = pchip(kx, ky);
      break;
    case 'akima':
      evaluate = akima(kx, ky);
      break;
    default:
      evaluate = (xv) => linearAt(kx, ky, xv);
  }

  // Which NAs may be filled, honouring limit / direction / area.
  const first = known[0];
  const last = known[known.length - 1];
  const direction = options.limitDirection ?? (method === 'bfill' || method === 'backfill' ? 'backward' : 'forward');
  const limit = options.limit ?? Infinity;
  // Like pandas/scipy: linear-type methods hold the edge value, directional fills
  // extend, pchip / cubicspline / spline extrapolate, the other scipy methods stay NaN outside.
  const edge: 'hold' | 'fill' | 'extrapolate' | 'none' =
    method === 'pad' || method === 'ffill' || method === 'bfill' || method === 'backfill' ? 'fill'
      : method === 'pchip' || method === 'cubicspline' || method === 'spline' ? 'extrapolate'
        : method === 'linear' || method === 'time' || method === 'index' || method === 'values' ? 'hold' : 'none';
  for (let i = 0; i < n; i++) {
    if (y[i] === y[i]) continue;
    const inside = i > first && i < last;
    if (options.limitArea === 'inside' && !inside) continue;
    if (options.limitArea === 'outside' && inside) continue;
    const prevValid = previousKnown(known, i);
    const nextValid = nextKnown(known, i);
    const fromPrev = prevValid < 0 ? Infinity : i - prevValid;
    const fromNext = nextValid < 0 ? Infinity : nextValid - i;
    const okForward = direction !== 'backward' && fromPrev <= limit;
    const okBackward = direction !== 'forward' && fromNext <= limit;
    if (!okForward && !okBackward) continue;
    if (!inside) {
      if (edge === 'none') continue;
      if (edge === 'hold') {
        if (i < first && direction === 'forward') continue;
        out[i] = i < first ? y[first] : y[last];
        continue;
      }
      if (edge === 'extrapolate' && i < first && direction === 'forward') continue;
    }
    const v = evaluate(x[i], i);
    if (v === v) out[i] = v;
  }
  return out;
}

function previousKnown(known: number[], i: number): number {
  let lo = 0, hi = known.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (known[m] < i) { ans = known[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function nextKnown(known: number[], i: number): number {
  let lo = 0, hi = known.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (known[m] > i) { ans = known[m]; hi = m - 1; } else lo = m + 1; }
  return ans;
}

function valueBefore(_out: Float64Array, known: number[], i: number, y: ArrayLike<number>): number {
  const p = previousKnown(known, i);
  return p < 0 ? NaN : y[p];
}

function valueAfter(known: number[], i: number, y: ArrayLike<number>): number {
  const p = nextKnown(known, i);
  return p < 0 ? NaN : y[p];
}

function bracket(kx: number[], xv: number): number {
  let lo = 0, hi = kx.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (kx[m] <= xv) lo = m; else hi = m; }
  return lo;
}

function linearAt(kx: number[], ky: number[], xv: number): number {
  if (kx.length === 1) return ky[0];
  const k = bracket(kx, xv);
  const x0 = kx[k], x1 = kx[k + 1];
  return x1 === x0 ? ky[k] : ky[k] + ((ky[k + 1] - ky[k]) * (xv - x0)) / (x1 - x0);
}

function nearestIndex(kx: number[], xv: number): number {
  if (kx.length === 1) return 0;
  const k = bracket(kx, xv);
  return k + 1 < kx.length && Math.abs(kx[k + 1] - xv) < Math.abs(xv - kx[k]) ? k + 1 : k;
}

/** Cubic spline with not-a-knot end conditions (scipy's default for 'cubic'). */
function notAKnotSpline(kx: number[], ky: number[]): (xv: number) => number {
  const n = kx.length;
  if (n < 4) return localPolynomial(kx, ky, n - 1);
  const h = Array.from({ length: n - 1 }, (_, i) => kx[i + 1] - kx[i]);
  // Band matrix (2 sub/super diagonals) for the second derivatives M.
  const A = Array.from({ length: n }, () => new Float64Array(5)); // A[i][j - i + 2]
  const rhs = new Float64Array(n);
  const set = (i: number, j: number, v: number) => { A[i][j - i + 2] = v; };
  set(0, 0, h[1]); set(0, 1, -(h[0] + h[1])); set(0, 2, h[0]);
  for (let i = 1; i < n - 1; i++) {
    set(i, i - 1, h[i - 1]); set(i, i, 2 * (h[i - 1] + h[i])); set(i, i + 1, h[i]);
    rhs[i] = 6 * ((ky[i + 1] - ky[i]) / h[i] - (ky[i] - ky[i - 1]) / h[i - 1]);
  }
  set(n - 1, n - 3, h[n - 2]); set(n - 1, n - 2, -(h[n - 3] + h[n - 2])); set(n - 1, n - 1, h[n - 3]);
  // Gaussian elimination within the band (no pivoting needed for these systems in practice).
  const get = (i: number, j: number) => (Math.abs(j - i) <= 2 ? A[i][j - i + 2] : 0);
  for (let k = 0; k < n - 1; k++) {
    for (let i = k + 1; i <= Math.min(k + 2, n - 1); i++) {
      const f = get(i, k) / get(k, k);
      if (f === 0) continue;
      for (let j = k; j <= Math.min(k + 4, n - 1); j++) if (Math.abs(j - i) <= 2) A[i][j - i + 2] -= f * get(k, j);
      rhs[i] -= f * rhs[k];
    }
  }
  const m = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let acc = rhs[i];
    for (let j = i + 1; j <= Math.min(i + 2, n - 1); j++) acc -= get(i, j) * m[j];
    m[i] = acc / get(i, i);
  }
  return (xv) => {
    const k = Math.max(0, Math.min(bracket(kx, xv), n - 2));
    const t1 = kx[k + 1] - xv, t0 = xv - kx[k], hk = h[k];
    return (m[k] * t1 ** 3 + m[k + 1] * t0 ** 3) / (6 * hk) + (ky[k] / hk - (m[k] * hk) / 6) * t1 + (ky[k + 1] / hk - (m[k + 1] * hk) / 6) * t0;
  };
}

/** Akima (1970) sub-spline, like scipy's Akima1DInterpolator. */
function akima(kx: number[], ky: number[]): (xv: number) => number {
  const n = kx.length;
  if (n < 3) return (xv) => linearAt(kx, ky, xv);
  const mm = new Float64Array(n + 3); // slopes with two extra on each side: mm[i + 2] = slope i
  for (let i = 0; i < n - 1; i++) mm[i + 2] = (ky[i + 1] - ky[i]) / (kx[i + 1] - kx[i]);
  mm[1] = 2 * mm[2] - mm[3]; mm[0] = 2 * mm[1] - mm[2];
  mm[n + 1] = 2 * mm[n] - mm[n - 1]; mm[n + 2] = 2 * mm[n + 1] - mm[n];
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w1 = Math.abs(mm[i + 3] - mm[i + 2]), w2 = Math.abs(mm[i + 1] - mm[i]);
    t[i] = w1 + w2 > 1e-9 * Math.max(Math.abs(mm[i + 1]), Math.abs(mm[i + 2]), 1e-300) ? (w1 * mm[i + 1] + w2 * mm[i + 2]) / (w1 + w2) : (mm[i + 1] + mm[i + 2]) / 2;
  }
  return (xv) => {
    const k = Math.max(0, Math.min(bracket(kx, xv), n - 2));
    const hk = kx[k + 1] - kx[k], s = (xv - kx[k]) / hk;
    const h00 = (1 + 2 * s) * (1 - s) ** 2, h10 = s * (1 - s) ** 2, h01 = s * s * (3 - 2 * s), h11 = s * s * (s - 1);
    return h00 * ky[k] + h10 * hk * t[k] + h01 * ky[k + 1] + h11 * hk * t[k + 1];
  };
}

/** Lagrange polynomial of degree `order` through the known points nearest to x. */
function localPolynomial(kx: number[], ky: number[], order: number): (xv: number) => number {
  const n = kx.length;
  const m = Math.min(order + 1, n);
  return (xv) => {
    let start = Math.max(0, Math.min(bracket(kx, xv) - Math.floor((m - 1) / 2), n - m));
    if (start < 0) start = 0;
    let sum = 0;
    for (let i = start; i < start + m; i++) {
      let term = ky[i];
      for (let j = start; j < start + m; j++) if (j !== i) term *= (xv - kx[j]) / (kx[i] - kx[j]);
      sum += term;
    }
    return sum;
  };
}

/** Monotone piecewise cubic Hermite interpolation (Fritsch–Carlson). */
function pchip(kx: number[], ky: number[]): (xv: number) => number {
  const n = kx.length;
  if (n < 3) return (xv) => linearAt(kx, ky, xv);
  const h: number[] = [], delta: number[] = [];
  for (let i = 0; i < n - 1; i++) { h.push(kx[i + 1] - kx[i]); delta.push((ky[i + 1] - ky[i]) / h[i]); }
  const dk = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) dk[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      dk[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  const edge = (h0: number, h1: number, d0: number, d1: number) => {
    let d = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(d) !== Math.sign(d0)) d = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(d) > Math.abs(3 * d0)) d = 3 * d0;
    return d;
  };
  dk[0] = edge(h[0], h[1], delta[0], delta[1]);
  dk[n - 1] = edge(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);
  return (xv) => {
    const k = Math.min(bracket(kx, xv), n - 2);
    const t = (xv - kx[k]) / h[k];
    const h00 = (1 + 2 * t) * (1 - t) ** 2, h10 = t * (1 - t) ** 2, h01 = t * t * (3 - 2 * t), h11 = t * t * (t - 1);
    return h00 * ky[k] + h10 * h[k] * dk[k] + h01 * ky[k + 1] + h11 * h[k] * dk[k + 1];
  };
}

/** Bias-corrected sample skewness (pandas `skew`), ignoring NaN. */
export function skewness(x: ArrayLike<number>): number {
  const v = Array.from(x).filter((a) => a === a);
  const n = v.length;
  if (n < 3) return NaN;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0;
  for (const a of v) { const d = a - mean; m2 += d * d; m3 += d ** 3; }
  if (m2 === 0) return 0;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * ((m3 / n) / (m2 / n) ** 1.5);
}

/** Bias-corrected excess kurtosis (pandas `kurt`, Fisher's definition), ignoring NaN. */
export function kurtosis(x: ArrayLike<number>): number {
  const v = Array.from(x).filter((a) => a === a);
  const n = v.length;
  if (n < 4) return NaN;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m4 = 0;
  for (const a of v) { const d = a - mean; m2 += d * d; m4 += d ** 4; }
  if (m2 === 0) return 0;
  return ((n + 1) * n * (n - 1)) / ((n - 2) * (n - 3)) * (m4 / (m2 * m2)) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}
