// Pure statistics for the stat family: no DOM, no JSX, so tests can import it.
// Everything is forgiving: bad input (NaN, strings, empty arrays) gives an empty
// or neutral result instead of throwing.
import { bin, quantileSorted, ticks as d3ticks } from "d3-array";

export type Pt = [number, number];

/** finite numbers only (strings of numbers are accepted) */
export function finite(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
export const toNum = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** [[x,y], …] or [{x,y}, …] → finite pairs (extra fields are kept by index in `src`) */
export function pairs(v: unknown, kx = "x", ky = "y"): Pt[] {
  if (!Array.isArray(v)) return [];
  const out: Pt[] = [];
  for (const p of v) {
    const x = Array.isArray(p) ? toNum(p[0]) : p && typeof p === "object" ? toNum((p as any)[kx]) : NaN;
    const y = Array.isArray(p) ? toNum(p[1]) : p && typeof p === "object" ? toNum((p as any)[ky]) : NaN;
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

export const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : NaN);
export function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
}
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** [min, max] of the values, padded when they are all equal */
export function extent(a: number[], pad = 0): [number, number] {
  if (!a.length) return [0, 1];
  let lo = Infinity, hi = -Infinity;
  for (const v of a) (v < lo && (lo = v), v > hi && (hi = v));
  if (lo === hi) return [lo - 1, hi + 1];
  const p = (hi - lo) * pad;
  // padding never pushes an all-positive (or all-negative) range across zero
  return [lo >= 0 && lo - p < 0 ? 0 : lo - p, hi <= 0 && hi + p > 0 ? 0 : hi + p];
}

// ───────────── distributions

export interface BoxStats { n: number; min: number; q1: number; median: number; q3: number; max: number; lo: number; hi: number; mean: number; outliers: number[] }
/** quartiles, Tukey whiskers (1.5 IQR, clipped to the data) and outliers */
export function boxStats(values: number[]): BoxStats | null {
  const s = finite(values).sort((a, b) => a - b);
  if (!s.length) return null;
  const q1 = quantileSorted(s, 0.25)!, median = quantileSorted(s, 0.5)!, q3 = quantileSorted(s, 0.75)!;
  const iqr = q3 - q1;
  const fl = q1 - 1.5 * iqr, fh = q3 + 1.5 * iqr;
  const inside = s.filter((v) => v >= fl && v <= fh);
  return {
    n: s.length, min: s[0], max: s[s.length - 1], q1, median, q3,
    lo: inside.length ? inside[0] : q1, hi: inside.length ? inside[inside.length - 1] : q3,
    mean: mean(s), outliers: s.filter((v) => v < fl || v > fh),
  };
}

/** shared histogram thresholds for one or several groups (Freedman–Diaconis, nice steps) */
export function thresholds(values: number[], count?: number): number[] {
  const s = finite(values).sort((a, b) => a - b);
  if (!s.length) return [];
  const [lo, hi] = [s[0], s[s.length - 1]];
  if (lo === hi) return [lo - 0.5, lo + 0.5];
  let k = count && count > 0 ? Math.round(count) : 0;
  if (!k) {
    const iqr = quantileSorted(s, 0.75)! - quantileSorted(s, 0.25)!;
    const h = 2 * iqr * Math.cbrt(1 / s.length);
    k = h > 0 ? Math.ceil((hi - lo) / h) : Math.ceil(Math.log2(s.length) + 1);
  }
  k = clamp(k, 3, 60);
  const t = d3ticks(lo, hi, k);
  const step = t.length > 1 ? t[1] - t[0] : (hi - lo) / k;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  if (out[out.length - 1] <= hi) out.push(+(out[out.length - 1] + step).toPrecision(12));
  return out;
}
export interface Bin { x0: number; x1: number; n: number }
export function histogram(values: number[], th: number[]): Bin[] {
  if (th.length < 2) return [];
  const v = finite(values);
  const b = bin().domain([th[0], th[th.length - 1]]).thresholds(th.slice(1, -1))(v);
  return b.map((x) => ({ x0: x.x0 ?? 0, x1: x.x1 ?? 0, n: x.length }));
}

/** Silverman's rule of thumb */
export function bandwidth(values: number[]): number {
  const v = finite(values);
  if (v.length < 2) return 1;
  const s = [...v].sort((a, b) => a - b);
  const iqr = quantileSorted(s, 0.75)! - quantileSorted(s, 0.25)!;
  const sig = Math.min(sd(v), iqr / 1.34 || sd(v));
  const h = 0.9 * (sig || Math.abs(mean(v)) || 1) * Math.pow(v.length, -0.2);
  return h > 0 ? h : 1;
}
/** Gaussian kernel density on `grid` points across [lo, hi] */
export function kde(values: number[], lo: number, hi: number, bw?: number, grid = 80): Pt[] {
  const v = finite(values);
  if (!v.length || !(hi > lo)) return [];
  const h = bw && bw > 0 ? bw : bandwidth(v);
  const out: Pt[] = [];
  const c = 1 / (v.length * h * Math.sqrt(2 * Math.PI));
  for (let i = 0; i <= grid; i++) {
    const x = lo + ((hi - lo) * i) / grid;
    let d = 0;
    for (const xi of v) d += Math.exp(-0.5 * ((x - xi) / h) ** 2);
    out.push([x, d * c]);
  }
  return out;
}
/** the range a density should be drawn over: data ± 2 bandwidths */
export function kdeRange(values: number[], bw?: number): [number, number] {
  const v = finite(values);
  const h = bw && bw > 0 ? bw : bandwidth(v);
  const [lo, hi] = extent(v);
  return [lo - 2 * h, hi + 2 * h];
}

/** empirical CDF as a step line: [x, F(x)] after each jump, starting at 0 */
export function ecdf(values: number[]): Pt[] {
  const s = finite(values).sort((a, b) => a - b);
  const out: Pt[] = [];
  s.forEach((x, i) => {
    if (i + 1 < s.length && s[i + 1] === x) return;
    out.push([x, (i + 1) / s.length]);
  });
  return out;
}

/** inverse standard normal CDF (Acklam, |error| < 1.2e-9) */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export const normPdf = (x: number, mu = 0, s = 1) => Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
/** standard normal CDF (Abramowitz–Stegun 7.1.26 via erf) */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** log Γ (Lanczos) */
export function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let s = 1.000000000190015;
  for (const c of g) s += c / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
export const tPdf = (x: number, df: number) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
export const chi2Pdf = (x: number, k: number) => (x <= 0 ? 0 : Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - lgamma(k / 2)));
export const fPdf = (x: number, d1: number, d2: number) =>
  x <= 0 ? 0 : Math.exp(0.5 * (d1 * Math.log(d1 * x) + d2 * Math.log(d2) - (d1 + d2) * Math.log(d1 * x + d2)) - Math.log(x) - (lgamma(d1 / 2) + lgamma(d2 / 2) - lgamma((d1 + d2) / 2)));
/** t quantile (Hill 1970 approximation; exact enough for confidence bands) */
export function tInv(p: number, df: number): number {
  if (!(df > 0)) return normInv(p);
  if (df > 200) return normInv(p);
  const z = normInv(p);
  const g1 = (z ** 3 + z) / 4, g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96, g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  const g4 = (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
}

/** normal QQ: theoretical quantile vs sorted sample, and the line through the quartiles */
export function qq(values: number[]): { pts: Pt[]; line: { slope: number; icpt: number } } {
  const s = finite(values).sort((a, b) => a - b);
  const n = s.length;
  const pts: Pt[] = s.map((v, i) => [normInv((i + 1 - 0.375) / (n + 0.25)), v]);
  if (n < 2) return { pts, line: { slope: 1, icpt: 0 } };
  const q1 = quantileSorted(s, 0.25)!, q3 = quantileSorted(s, 0.75)!;
  const z1 = normInv(0.25), z3 = normInv(0.75);
  const slope = (q3 - q1) / (z3 - z1) || sd(s) || 1;
  return { pts, line: { slope, icpt: q1 - slope * z1 } };
}

// ───────────── layout helpers for dots

/** deterministic jitter in [-1, 1] (same picture every render) */
export function jitter(i: number, seed = 1): number {
  const x = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Beeswarm: dots at fixed positions along the value axis, pushed off the centre
 * line just enough not to overlap (radius r). Returns the offset for each input,
 * in the input order. `side`: both sides, or one side only (raincloud).
 */
export function swarm(pos: number[], r: number, side: "both" | "up" = "both"): number[] {
  const order = pos.map((p, i) => [p, i] as const).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const placed: { p: number; o: number }[] = [];
  const out = new Array(pos.length).fill(0);
  const d = 2 * r;
  for (const [p, i] of order) {
    const near = placed.filter((q) => Math.abs(q.p - p) < d);
    let best = 0;
    if (near.some((q) => Math.hypot(q.p - p, q.o) < d - 1e-6)) {
      const cands: number[] = [];
      for (const q of near) {
        const dy = Math.sqrt(Math.max(0, d * d - (q.p - p) ** 2));
        cands.push(q.o + dy, q.o - dy);
      }
      cands.sort((a, b) => Math.abs(a) - Math.abs(b));
      best = cands.find((o) => (side === "up" ? o >= 0 : true) && near.every((q) => Math.hypot(q.p - p, q.o - o) >= d - 1e-6)) ?? 0;
    }
    placed.push({ p, o: best });
    out[i] = best;
  }
  return out;
}

// ───────────── fits

export interface LinFit { slope: number; icpt: number; r2: number; r: number; n: number; band: (x: number) => number }
/** least squares with the 95% confidence half-width of the mean at x */
export function linreg(pts: Pt[]): LinFit | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) (sxx += (x - mx) ** 2), (sxy += (x - mx) * (y - my)), (syy += (y - my) ** 2);
  if (sxx === 0) return null;
  const slope = sxy / sxx, icpt = my - slope * mx;
  const sse = sum(pts.map(([x, y]) => (y - (icpt + slope * x)) ** 2));
  const s = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  const t = n > 2 ? tInv(0.975, n - 2) : 0;
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  return { slope, icpt, r2: r * r, r, n, band: (x) => t * s * Math.sqrt(1 / n + (x - mx) ** 2 / sxx) };
}

/** LOESS-style smoother: tricube-weighted local linear fit on a grid over the x range */
export function loess(pts: Pt[], span = 0.75, grid = 60): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 4) return [];
  const k = clamp(Math.ceil(span * n), 3, n);
  const [lo, hi] = [p[0][0], p[n - 1][0]];
  if (!(hi > lo)) return [];
  const out: Pt[] = [];
  for (let g = 0; g <= grid; g++) {
    const x = lo + ((hi - lo) * g) / grid;
    const ds = p.map((q) => Math.abs(q[0] - x)).sort((a, b) => a - b);
    const h = ds[k - 1] || 1e-9;
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (const [xi, yi] of p) {
      const u = Math.abs(xi - x) / h;
      if (u >= 1) continue;
      const w = (1 - u ** 3) ** 3;
      sw += w; swx += w * xi; swy += w * yi; swxx += w * xi * xi; swxy += w * xi * yi;
    }
    if (sw <= 0) continue;
    const den = sw * swxx - swx * swx;
    const y = Math.abs(den) < 1e-12 ? swy / sw : ((swxx * swy - swx * swxy) + x * (sw * swxy - swx * swy)) / den;
    if (Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** log-log least squares: y = a·x^b (only positive pairs count) */
export function powerFit(pts: Pt[]): { a: number; b: number; r2: number } | null {
  const l = pts.filter(([x, y]) => x > 0 && y > 0).map(([x, y]) => [Math.log10(x), Math.log10(y)] as Pt);
  const f = linreg(l);
  return f ? { a: 10 ** f.icpt, b: f.slope, r2: f.r2 } : null;
}

/** 4-parameter logistic: bottom + (top − bottom) / (1 + (ec50 / x)^hill) */
export const logistic4 = (x: number, p: { bottom: number; top: number; ec50: number; hill: number }) => p.bottom + (p.top - p.bottom) / (1 + Math.pow(p.ec50 / x, p.hill));
/** fits a 4PL to dose–response points (doses > 0) with Nelder–Mead on log10(ec50) */
export function fit4pl(pts: Pt[]): { bottom: number; top: number; ec50: number; hill: number } | null {
  const p = pts.filter(([x, y]) => x > 0 && Number.isFinite(y));
  if (p.length < 4) return null;
  const ys = p.map((q) => q[1]);
  const xs = p.map((q) => Math.log10(q[0]));
  const lo0 = Math.min(...ys), hi0 = Math.max(...ys);
  const sorted = [...p].sort((a, b) => a[0] - b[0]);
  const rising = mean(sorted.slice(-2).map((q) => q[1])) >= mean(sorted.slice(0, 2).map((q) => q[1]));
  const f = (v: number[]) => {
    const prm = { bottom: v[0], top: v[1], ec50: 10 ** v[2], hill: v[3] };
    return sum(p.map(([x, y]) => (y - logistic4(x, prm)) ** 2));
  };
  const start = [rising ? lo0 : hi0, rising ? hi0 : lo0, mean(xs), 1];
  // with bottom/top swapped for falling curves the hill stays positive
  const best = nelderMead(f, start, [Math.abs(hi0 - lo0) * 0.1 || 1, Math.abs(hi0 - lo0) * 0.1 || 1, 0.5, 0.5]);
  const [bottom, top, le, hill] = best;
  if (![bottom, top, le, hill].every(Number.isFinite)) return null;
  return { bottom, top, ec50: 10 ** le, hill };
}
export function nelderMead(f: (v: number[]) => number, x0: number[], step: number[], iters = 600): number[] {
  const n = x0.length;
  let s = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[i] : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iters; it++) {
    s.sort((a, b) => a.f - b.f);
    if (Math.abs(s[n].f - s[0].f) < 1e-12 * (1 + Math.abs(s[0].f))) break;
    const c = x0.map((_, j) => mean(s.slice(0, n).map((q) => q.x[j])));
    const at = (t: number) => c.map((v, j) => v + t * (s[n].x[j] - v));
    const r = at(-1), fr = f(r);
    if (fr < s[0].f) {
      const e = at(-2), fe = f(e);
      s[n] = fe < fr ? { x: e, f: fe } : { x: r, f: fr };
    } else if (fr < s[n - 1].f) s[n] = { x: r, f: fr };
    else {
      const k = at(0.5), fk = f(k);
      if (fk < s[n].f) s[n] = { x: k, f: fk };
      else s = s.map((q, i) => (i === 0 ? q : { x: q.x.map((v, j) => s[0].x[j] + 0.5 * (v - s[0].x[j])), f: 0 })).map((q, i) => (i === 0 ? q : { ...q, f: f(q.x) }));
    }
  }
  s.sort((a, b) => a.f - b.f);
  return s[0].x;
}

// ───────────── evaluation curves

/** ROC from scores and 0/1 truth: [[fpr, tpr]] from (0,0) to (1,1) */
export function rocFrom(scores: number[], truth: unknown[]): Pt[] {
  const d = scores.map((s, i) => [toNum(s), truth[i] ? 1 : 0] as const).filter(([s]) => Number.isFinite(s)).sort((a, b) => b[0] - a[0]);
  const P = d.filter((x) => x[1]).length, N = d.length - P;
  if (!P || !N) return [];
  const out: Pt[] = [[0, 0]];
  let tp = 0, fp = 0;
  for (let i = 0; i < d.length; i++) {
    d[i][1] ? tp++ : fp++;
    if (i + 1 < d.length && d[i + 1][0] === d[i][0]) continue;
    out.push([fp / N, tp / P]);
  }
  return out;
}
/** precision–recall from scores: [[recall, precision]] */
export function prFrom(scores: number[], truth: unknown[]): Pt[] {
  const d = scores.map((s, i) => [toNum(s), truth[i] ? 1 : 0] as const).filter(([s]) => Number.isFinite(s)).sort((a, b) => b[0] - a[0]);
  const P = d.filter((x) => x[1]).length;
  if (!P) return [];
  const out: Pt[] = [];
  let tp = 0, fp = 0;
  for (let i = 0; i < d.length; i++) {
    d[i][1] ? tp++ : fp++;
    if (i + 1 < d.length && d[i + 1][0] === d[i][0]) continue;
    out.push([tp / P, tp / (tp + fp)]);
  }
  return [[0, out[0]?.[1] ?? 1], ...out];
}
/** trapezoid area under a curve sorted by x */
export function auc(pts: Pt[]): number {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let a = 0;
  for (let i = 1; i < p.length; i++) a += (p[i][0] - p[i - 1][0]) * (p[i][1] + p[i - 1][1]) / 2;
  return a;
}
/** average precision: Σ (Rₙ − Rₙ₋₁)·Pₙ */
export function avgPrecision(pr: Pt[]): number {
  const p = [...pr].sort((a, b) => a[0] - b[0]);
  let a = 0;
  for (let i = 1; i < p.length; i++) a += (p[i][0] - p[i - 1][0]) * p[i][1];
  return a;
}
/** reliability bins: [mean predicted, observed rate, count] per non-empty bin, and ECE */
export function calibrationFrom(scores: number[], truth: unknown[], bins = 10): { pts: [number, number, number][]; ece: number } {
  const acc = Array.from({ length: bins }, () => ({ p: 0, o: 0, n: 0 }));
  let total = 0;
  scores.forEach((s, i) => {
    const v = toNum(s);
    if (!Number.isFinite(v)) return;
    const b = acc[clamp(Math.floor(clamp(v, 0, 1) * bins), 0, bins - 1)];
    b.p += v; b.o += truth[i] ? 1 : 0; b.n++; total++;
  });
  const pts = acc.filter((b) => b.n).map((b) => [b.p / b.n, b.o / b.n, b.n] as [number, number, number]);
  const ece = total ? sum(pts.map(([p, o, n]) => (n / total) * Math.abs(p - o))) : 0;
  return { pts, ece };
}

// ───────────── survival

export interface KmStep { t: number; s: number; lo: number; hi: number }
export interface Km { steps: KmStep[]; censored: Pt[]; atRisk: (t: number) => number; median: number | null; end: number }
/** Kaplan–Meier with Greenwood log-log 95% band; events: 1 = event, 0 = censored */
export function kaplanMeier(times: unknown[], events: unknown[]): Km {
  const d = (Array.isArray(times) ? times : []).map((t, i) => [toNum(t), Array.isArray(events) ? (events[i] === 0 || events[i] === false ? 0 : 1) : 1] as const)
    .filter(([t]) => Number.isFinite(t) && t >= 0).sort((a, b) => a[0] - b[0]);
  const all = d.map((x) => x[0]);
  const steps: KmStep[] = [{ t: 0, s: 1, lo: 1, hi: 1 }];
  const censored: Pt[] = [];
  let s = 1, g = 0, n = d.length, i = 0, median: number | null = null;
  while (i < d.length) {
    const t = d[i][0];
    let ev = 0, cen = 0;
    while (i < d.length && d[i][0] === t) (d[i][1] ? ev++ : cen++), i++;
    if (ev) {
      s *= 1 - ev / n;
      if (n > ev) g += ev / (n * (n - ev));
      let lo = s, hi = s;
      if (s > 0 && s < 1 && g > 0) {
        const se = Math.sqrt(g) / Math.abs(Math.log(s));
        const ll = Math.log(-Math.log(s));
        hi = Math.exp(-Math.exp(ll - 1.96 * se));
        lo = Math.exp(-Math.exp(ll + 1.96 * se));
      }
      steps.push({ t, s, lo, hi });
      if (median === null && s <= 0.5) median = t;
    }
    if (cen) censored.push([t, s]);
    n -= ev + cen;
  }
  return { steps, censored, median, end: all.length ? all[all.length - 1] : 0, atRisk: (t) => all.filter((x) => x >= t).length };
}
/** survival at time t from KM steps */
export function survAt(steps: KmStep[], t: number): number {
  let s = 1;
  for (const st of steps) if (st.t <= t) s = st.s;
  return s;
}

// ───────────── clustering (heatmap dendrograms)

export interface Dendro { order: number[]; /** merges: [left node, right node, height]; leaves are 0..n-1, merge k is node n+k */ merges: [number, number, number][] }
/** agglomerative clustering, average linkage on Euclidean distance (skips NaN pairs) */
export function hclust(rows: number[][]): Dendro {
  const n = rows.length;
  if (n === 0) return { order: [], merges: [] };
  const dist = (a: number[], b: number[]) => {
    let s = 0, k = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) (s += (a[i] - b[i]) ** 2), k++;
    return k ? Math.sqrt(s / k) : 0;
  };
  const D: number[][] = rows.map((a) => rows.map((b) => dist(a, b)));
  const active = new Map<number, { members: number[] }>();
  rows.forEach((_, i) => active.set(i, { members: [i] }));
  const merges: [number, number, number][] = [];
  const cd = (a: number[], b: number[]) => mean(a.flatMap((i) => b.map((j) => D[i][j])));
  let next = n;
  while (active.size > 1) {
    const ids = [...active.keys()];
    let best = [ids[0], ids[1]], bd = Infinity;
    for (let x = 0; x < ids.length; x++)
      for (let y = x + 1; y < ids.length; y++) {
        const dd = cd(active.get(ids[x])!.members, active.get(ids[y])!.members);
        if (dd < bd) (bd = dd), (best = [ids[x], ids[y]]);
      }
    const [a, b] = best;
    merges.push([a, b, bd]);
    active.set(next++, { members: [...active.get(a)!.members, ...active.get(b)!.members] });
    active.delete(a);
    active.delete(b);
  }
  const order: number[] = [];
  const walk = (id: number): void => void (id < n ? order.push(id) : (walk(merges[id - n][0]), walk(merges[id - n][1])));
  walk(n + merges.length - 1);
  return { order, merges };
}
/** dendrogram segments in unit space: leaf position = index in order (0..n-1), height 0..1 */
export function dendroLines(d: Dendro): { x1: number; x2: number; y1: number; y2: number }[] {
  const n = d.order.length;
  if (n < 2) return [];
  const pos = new Map<number, number>();
  d.order.forEach((leaf, i) => pos.set(leaf, i));
  const top = Math.max(...d.merges.map((m) => m[2]), 1e-9);
  const h = new Map<number, number>();
  const segs: { x1: number; x2: number; y1: number; y2: number }[] = [];
  d.merges.forEach(([a, b, ht], k) => {
    const id = n + k, y = ht / top;
    const pa = pos.get(a)!, pb = pos.get(b)!, ya = h.get(a) ?? 0, yb = h.get(b) ?? 0;
    segs.push({ x1: pa, x2: pa, y1: ya, y2: y }, { x1: pb, x2: pb, y1: yb, y2: y }, { x1: pa, x2: pb, y1: y, y2: y });
    pos.set(id, (pa + pb) / 2);
    h.set(id, y);
  });
  return segs;
}

// ───────────── quality control

export interface Spc { center: number; ucl: number; lcl: number; sigma: number; out: boolean[]; run: boolean[] }
/**
 * Individuals chart: centre = mean, σ from the average moving range (MR̄ / 1.128),
 * limits ±3σ unless given. `out`: beyond a limit; `run`: part of 8 in a row on one side.
 */
export function spc(values: number[], given: { center?: number; ucl?: number; lcl?: number } = {}): Spc {
  const v = values.map((x) => (Number.isFinite(x) ? x : NaN));
  const ok = v.filter(Number.isFinite);
  const center = isNum(given.center) ? given.center : mean(ok);
  const mr: number[] = [];
  for (let i = 1; i < v.length; i++) if (Number.isFinite(v[i]) && Number.isFinite(v[i - 1])) mr.push(Math.abs(v[i] - v[i - 1]));
  const sigma = mr.length ? mean(mr) / 1.128 : sd(ok);
  const ucl = isNum(given.ucl) ? given.ucl : center + 3 * sigma;
  const lcl = isNum(given.lcl) ? given.lcl : center - 3 * sigma;
  const out = v.map((x) => Number.isFinite(x) && (x > ucl || x < lcl));
  const run = v.map(() => false);
  let start = 0, side = 0;
  for (let i = 0; i <= v.length; i++) {
    const s = i < v.length && Number.isFinite(v[i]) ? Math.sign(v[i] - center) : 0;
    if (s !== side || s === 0) {
      if (side !== 0 && i - start >= 8) for (let j = start; j < i; j++) run[j] = true;
      start = i;
      side = s;
    }
  }
  return { center, ucl, lcl, sigma, out, run };
}

// ───────────── time series

/** autocorrelation for lags 1..maxLag, and the ±1.96/√n band */
export function acf(values: number[], maxLag = 20): { lags: number[]; r: number[]; band: number } {
  const v = finite(values);
  const n = v.length;
  if (n < 3) return { lags: [], r: [], band: 0 };
  const m = mean(v);
  const c0 = sum(v.map((x) => (x - m) ** 2)) || 1;
  const L = Math.min(maxLag, n - 1);
  const lags: number[] = [], r: number[] = [];
  for (let k = 1; k <= L; k++) {
    let c = 0;
    for (let i = k; i < n; i++) c += (v[i] - m) * (v[i - k] - m);
    lags.push(k);
    r.push(c / c0);
  }
  return { lags, r, band: 1.96 / Math.sqrt(n) };
}

// ───────────── meta-analysis

/** fixed-effect (inverse variance) pooled estimate and its 95% CI */
export function pooled(items: { value: number; se: number }[]): { value: number; lo: number; hi: number; se: number } | null {
  const ok = items.filter((i) => Number.isFinite(i.value) && i.se > 0);
  if (!ok.length) return null;
  const w = ok.map((i) => 1 / i.se ** 2);
  const sw = sum(w);
  const value = sum(ok.map((i, k) => i.value * w[k])) / sw;
  const se = Math.sqrt(1 / sw);
  return { value, se, lo: value - 1.96 * se, hi: value + 1.96 * se };
}

// ───────────── geometry

/** ternary (a, b, c) → unit triangle x/y; a at the top, b bottom-left, c bottom-right */
export function ternary(a: number, b: number, c: number): Pt | null {
  const s = a + b + c;
  if (![a, b, c].every((v) => Number.isFinite(v) && v >= 0) || !(s > 0)) return null;
  const [A, , C] = [a / s, b / s, c / s];
  return [C + A / 2, (A * Math.sqrt(3)) / 2];
}

/** convex hull (monotone chain), counter-clockwise */
export function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

/** hexagonal bins of radius r over pixel points: centres and counts */
export function hexbin(pts: Pt[], r: number): { x: number; y: number; n: number }[] {
  const dx = r * Math.sqrt(3), dy = r * 1.5;
  const m = new Map<string, { x: number; y: number; n: number }>();
  for (const [px, py] of pts) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    let pj = Math.round(py / dy), pi = Math.round(px / dx - (pj & 1) / 2);
    const py1 = py / dy - pj;
    if (Math.abs(py1) * 3 > 1) {
      const px1 = px / dx - pi - (pj & 1) / 2;
      const pj2 = pj + (py1 < 0 ? -1 : 1);
      const pi2 = Math.floor(px / dx - (pj2 & 1) / 2 + 0.5);
      const px2 = px / dx - pi2 - (pj2 & 1) / 2;
      const py2 = py / dy - pj2;
      if (px1 * px1 + py1 * py1 > px2 * px2 + py2 * py2) (pi = pi2), (pj = pj2);
    }
    const k = `${pi},${pj}`;
    const c = m.get(k) ?? { x: (pi + (pj & 1) / 2) * dx, y: pj * dy, n: 0 };
    c.n++;
    m.set(k, c);
  }
  return [...m.values()];
}

/** the points not dominated by any other (pareto frontier), sorted by x */
export function frontier(pts: Pt[], xBetter: "up" | "down" = "down", yBetter: "up" | "down" = "up"): number[] {
  const sx = xBetter === "up" ? 1 : -1, sy = yBetter === "up" ? 1 : -1;
  const idx = pts.map((_, i) => i).filter((i) => Number.isFinite(pts[i][0]) && Number.isFinite(pts[i][1]));
  const keep = idx.filter((i) => !idx.some((j) => j !== i && sx * pts[j][0] >= sx * pts[i][0] && sy * pts[j][1] >= sy * pts[i][1] && (pts[j][0] !== pts[i][0] || pts[j][1] !== pts[i][1])));
  return keep.sort((a, b) => pts[a][0] - pts[b][0]);
}

// ───────────── stacked shares

/**
 * Likert bars centred on the neutral level: per item, segments [start, end] in
 * percent where negative is the disagree side. Odd level count: the middle level
 * straddles 0; even: split between halves.
 */
export function likert(counts: number[], levels: number): { lo: number; hi: number; pct: number }[] {
  const c = Array.from({ length: levels }, (_, i) => Math.max(0, toNum(counts[i]) || 0));
  const total = sum(c) || 1;
  const pct = c.map((v) => (v / total) * 100);
  const mid = (levels - 1) / 2;
  const neg = sum(pct.filter((_, i) => i < mid)) + (levels % 2 ? pct[Math.floor(mid)] / 2 : 0);
  let at = -neg;
  return pct.map((p) => {
    const seg = { lo: at, hi: at + p, pct: p };
    at += p;
    return seg;
  });
}

/** mosaic: column widths by column total, heights by share within the column */
export function mosaic(m: number[][]): { x0: number; x1: number; y0: number; y1: number; v: number; colShare: number; rowShare: number }[][] {
  const cols = m.length;
  const tot = m.map((c) => sum(c.map((v) => Math.max(0, toNum(v) || 0))));
  const T = sum(tot) || 1;
  let x = 0;
  return m.map((c, i) => {
    const w = tot[i] / T;
    let y = 0;
    const cells = c.map((v0) => {
      const v = Math.max(0, toNum(v0) || 0);
      const h = tot[i] ? v / tot[i] : 0;
      const cell = { x0: x, x1: x + w, y0: y, y1: y + h, v, colShare: w, rowShare: h };
      y += h;
      return cell;
    });
    x += w;
    return cols ? cells : [];
  });
}

// ───────────── labels and ticks

export interface Rect { x: number; y: number; w: number; h: number }
export const overlaps = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
/**
 * Greedy label placement: each label tries a few spots around its anchor and
 * takes the first that hits no placed label, no blocked area and stays inside
 * `bounds`. Labels that don't fit anywhere are dropped (null).
 */
export function placeLabels(items: { x: number; y: number; w: number; h: number }[], bounds: Rect, blocked: Rect[] = [], gap = 6): (Rect | null)[] {
  const placed: Rect[] = [];
  return items.map((it) => {
    const cands: Rect[] = [
      { x: it.x + gap, y: it.y - it.h / 2, w: it.w, h: it.h },
      { x: it.x - gap - it.w, y: it.y - it.h / 2, w: it.w, h: it.h },
      { x: it.x - it.w / 2, y: it.y - gap - it.h, w: it.w, h: it.h },
      { x: it.x - it.w / 2, y: it.y + gap, w: it.w, h: it.h },
      { x: it.x + gap, y: it.y - gap - it.h, w: it.w, h: it.h },
      { x: it.x - gap - it.w, y: it.y - gap - it.h, w: it.w, h: it.h },
      { x: it.x + gap, y: it.y + gap, w: it.w, h: it.h },
      { x: it.x - gap - it.w, y: it.y + gap, w: it.w, h: it.h },
    ];
    const r = cands.find((c) => c.x >= bounds.x && c.y >= bounds.y && c.x + c.w <= bounds.x + bounds.w && c.y + c.h <= bounds.y + bounds.h && !placed.some((p) => overlaps(c, p, 1)) && !blocked.some((p) => overlaps(c, p)));
    if (r) placed.push(r);
    return r ?? null;
  });
}
/** keep every k-th tick so labels of the given widths, centred at `pos`, never touch */
export function thin(pos: number[], widths: number[], gap = 8): number[] {
  for (let k = 1; k <= pos.length; k++) {
    const keep = pos.map((_, i) => i).filter((i) => i % k === 0);
    let ok = true;
    for (let j = 1; j < keep.length && ok; j++) {
      const a = keep[j - 1], b = keep[j];
      if (Math.abs(pos[b] - pos[a]) < (widths[a] + widths[b]) / 2 + gap) ok = false;
    }
    if (ok) return keep;
  }
  return pos.length ? [0] : [];
}
/** powers of ten covering [lo, hi] (both > 0), with 2 and 5 steps when the range is short */
export function logTicks(lo: number, hi: number): { major: number[]; minor: number[] } {
  if (!(lo > 0) || !(hi > lo)) return { major: [], minor: [] };
  const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi));
  const major: number[] = [], minor: number[] = [];
  for (let e = a; e <= b; e++) {
    for (let m = 1; m < 10; m++) {
      const v = m * 10 ** e;
      if (v < lo * (1 - 1e-9) || v > hi * (1 + 1e-9)) continue;
      if (m === 1) major.push(+v.toPrecision(12));
      else minor.push(+v.toPrecision(12));
    }
  }
  if (major.length < 2) {
    // less than a decade: 2 and 5 steps, or every step when that still leaves too few
    const extra = minor.filter((v) => [2, 5].includes(Math.round(v / 10 ** Math.floor(Math.log10(v) + 1e-9))));
    if (major.length + extra.length >= 3) return { major: [...major, ...extra].sort((x, y) => x - y), minor: minor.filter((v) => !extra.includes(v)) };
    return { major: [...major, ...minor].sort((x, y) => x - y), minor: [] };
  }
  return { major, minor };
}
/** a log domain snapped out to powers of ten */
export function logDomain(vals: number[]): [number, number] {
  const p = vals.filter((v) => v > 0 && Number.isFinite(v));
  if (!p.length) return [1, 10];
  const lo = Math.min(...p), hi = Math.max(...p);
  // under a decade apart: pad a little instead of stretching to whole decades
  if (hi / lo < 8) return [lo / 1.15, hi * 1.15];
  const a = 10 ** Math.floor(Math.log10(lo) + 1e-9), b = 10 ** Math.ceil(Math.log10(hi) - 1e-9);
  return a === b ? [a, a * 10] : [a, b];
}

/** p-value → stars (*** < .001, ** < .01, * < .05, ns) */
export const stars = (p: number) => (!Number.isFinite(p) ? "" : p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "ns");
/** p as people write it: "p < 0.001", "p = 0.032" */
export const pText = (p: number) => (!Number.isFinite(p) ? "" : p < 0.001 ? "p < 0.001" : `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`);

/** best and second best index of a column (ties share the rank) */
export function ranks(vals: (number | null)[], better: "up" | "down" = "up"): { best: Set<number>; second: Set<number> } {
  const ok = vals.map((v, i) => [v, i] as const).filter(([v]) => v !== null && Number.isFinite(v)) as [number, number][];
  const uniq = [...new Set(ok.map(([v]) => v))].sort((a, b) => (better === "up" ? b - a : a - b));
  const best = new Set(ok.filter(([v]) => v === uniq[0]).map(([, i]) => i));
  const second = new Set(uniq.length > 1 ? ok.filter(([v]) => v === uniq[1]).map(([, i]) => i) : []);
  return { best, second };
}

// ───────────── reference distributions (hypothesis tests)

export type Dist = "normal" | "t" | "chi2" | "f";
/** the density of a test statistic's null distribution */
export function distPdf(d: Dist, df = 1, df2 = 1): (x: number) => number {
  if (d === "t") return (x) => tPdf(x, Math.max(df, 0.5));
  if (d === "chi2") return (x) => chi2Pdf(x, Math.max(df, 0.5));
  if (d === "f") return (x) => fPdf(x, Math.max(df, 0.5), Math.max(df2, 0.5));
  return (x) => normPdf(x);
}
/** a range that holds all but a sliver of the distribution (and the observed value) */
export function distRange(d: Dist, df = 1, df2 = 1, stat?: number): [number, number] {
  let lo: number, hi: number;
  if (d === "chi2") (lo = 0), (hi = df + 5 * Math.sqrt(2 * df) + 2);
  else if (d === "f") (lo = 0), (hi = Math.max(5, 1 + 8 / Math.sqrt(Math.min(df, df2) + 1)));
  else { const w = d === "t" && df < 5 ? 6 : 4.2; (lo = -w), (hi = w); }
  if (isNum(stat)) (lo = Math.min(lo, stat * 1.1)), (hi = Math.max(hi, stat * 1.1));
  return [lo, hi];
}
/** where nearly all of the probability lies (for the CDF table, wider than what is drawn) */
export function distSupport(d: Dist, df = 1, df2 = 1): [number, number] {
  if (d === "chi2") return [0, df + 12 * Math.sqrt(2 * df) + 10];
  if (d === "f") return [0, Math.max(60, 20 * (1 + 10 / Math.max(1, df2)))];
  if (d === "t" && df < 3) return [-80, 80];
  return [-12, 12];
}
/** cumulative probability on a grid (trapezoid rule), normalised to end at 1 */
export function cdfTable(pdf: (x: number) => number, lo: number, hi: number, n = 2000): { xs: number[]; F: number[] } {
  const xs: number[] = [], F: number[] = [];
  let acc = 0, prev = 0;
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n, y = pdf(x);
    const v = Number.isFinite(y) ? y : 0;
    if (i) acc += ((v + prev) / 2) * ((hi - lo) / n);
    xs.push(x); F.push(acc); prev = v;
  }
  return { xs, F: F.map((f) => f / (acc || 1)) };
}
export function cdfAt(t: { xs: number[]; F: number[] }, x: number): number {
  if (x <= t.xs[0]) return 0;
  if (x >= t.xs[t.xs.length - 1]) return 1;
  const i = t.xs.findIndex((v) => v >= x);
  const f = (x - t.xs[i - 1]) / (t.xs[i] - t.xs[i - 1]);
  return t.F[i - 1] + f * (t.F[i] - t.F[i - 1]);
}
export function quantileAt(t: { xs: number[]; F: number[] }, p: number): number {
  const i = t.F.findIndex((v) => v >= p);
  if (i <= 0) return t.xs[0];
  const f = (p - t.F[i - 1]) / (t.F[i] - t.F[i - 1] || 1);
  return t.xs[i - 1] + f * (t.xs[i] - t.xs[i - 1]);
}
