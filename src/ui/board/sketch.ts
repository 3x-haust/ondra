// Pen strokes that look drawn by hand: a straight edge gets a slight, smooth bend
// and its ends overshoot a little; a circle doesn't quite close. Deterministic
// (seeded by the mark), so a board looks the same every time it is shown.

export type Pt = [number, number];

/** a small seeded random source (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** a smooth path through points (Catmull-Rom as cubic Béziers) */
export function smooth(pts: Pt[]): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${r1(pts[0][0])} ${r1(pts[0][1])}L${r1(pts[1][0])} ${r1(pts[1][1])}`;
  const p = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b, c, e] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const c1: Pt = [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6];
    const c2: Pt = [c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6];
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(c[0])} ${r1(c[1])}`;
  }
  return d;
}

/** one straight stroke from a to b, gently bowed */
export function edge(a: Pt, b: Pt, rand: () => number): Pt[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
  const bow = (rand() - 0.5) * Math.min(6, len * 0.025);
  const n = Math.max(2, Math.min(8, Math.round(len / 60)));
  const out: Pt[] = [a];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const off = Math.sin(Math.PI * t) * bow + (rand() - 0.5) * 0.7;
    out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
  }
  out.push(b);
  return out;
}

/** a stroke through several points: straight legs bowed by hand, or one smooth curve */
export function polyline(pts: Pt[], rand: () => number, curved = false): string {
  if (curved) return smooth(pts.map(([x, y]) => [x + (rand() - 0.5) * 1.2, y + (rand() - 0.5) * 1.2] as Pt));
  // each leg on its own, so corners stay corners
  return pts.slice(1).map((p, i) => smooth(edge(pts[i], p, rand)).replace(/^M[^CL]+/, i ? "" : "$&")).join("");
}

/** a rounded box as one stroke going round, closing with a small overlap */
export function box(x: number, y: number, w: number, h: number, rand: () => number): string {
  const r = Math.min(10, w / 4, h / 4);
  const j = () => (rand() - 0.5) * 1.6;
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let k = 0; k <= 3; k++) {
      const a = from + (k / 3) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  const side = (a: Pt, b: Pt) => {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 90));
    for (let i = 1; i < n; i++) pts.push([a[0] + (b[0] - a[0]) * (i / n) + j(), a[1] + (b[1] - a[1]) * (i / n) + j()]);
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  side([x + w, y + r], [x + w, y + h - r]);
  corner(x + w - r, y + h - r, 0);
  side([x + w - r, y + h], [x + r, y + h]);
  corner(x + r, y + h - r, Math.PI / 2);
  side([x, y + h - r], [x, y + r]);
  corner(x + r, y + r, Math.PI);
  side([x + r, y], [x + w - r, y]);
  // go a little past where it started, the way a pen does
  pts.push([pts[0][0] + j(), pts[0][1] + j()], [pts[1][0] + j() * 0.5, pts[1][1] + j() * 0.5]);
  return smooth(pts);
}

/** a circle that starts anywhere and runs a bit past its start */
export function ring(cx: number, cy: number, r: number, rand: () => number): string {
  const start = rand() * Math.PI * 2;
  const n = Math.max(14, Math.round(r / 4));
  const squash = 1 + (rand() - 0.5) * 0.06;
  const pts: Pt[] = [];
  for (let i = 0; i <= n + 1; i++) {
    const a = start + (i / n) * Math.PI * 2;
    const rr = r * (1 + (rand() - 0.5) * 0.03) * (i > n ? 1.03 : 1);
    pts.push([cx + Math.cos(a) * rr * squash, cy + (Math.sin(a) * rr) / squash]);
  }
  return smooth(pts);
}

/** an arrowhead at the end of a stroke, as two short pen ticks */
export function head(from: Pt, to: Pt, rand: () => number, size = 13): string {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const tick = (side: number) => {
    const b = a + Math.PI + side * (0.45 + (rand() - 0.5) * 0.12);
    return `M${r1(to[0] + Math.cos(b) * size)} ${r1(to[1] + Math.sin(b) * size)}L${r1(to[0])} ${r1(to[1])}`;
  };
  return tick(1) + tick(-1);
}

/** a highlighter swipe across a box: a wide soft stroke, slightly tilted */
export function swipe(x: number, y: number, w: number, h: number, rand: () => number): string {
  const tilt = (rand() - 0.5) * Math.min(6, h * 0.2);
  return smooth([[x - 2, y + h / 2 + tilt], [x + w / 2, y + h / 2 + (rand() - 0.5) * 2], [x + w + 2, y + h / 2 - tilt]]);
}
