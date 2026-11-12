// The pen's strokes: clean, even lines, each drawn as one continuous path so it
// can be revealed from its start to its end the way a pen moves.

export type Pt = [number, number];

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

/** a stroke through several points: straight legs with softly rounded bends, or one smooth curve */
export function polyline(pts: Pt[], curved = false): string {
  if (pts.length < 2) return "";
  if (curved) return smooth(pts);
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i];
    const next = pts[i + 1];
    if (!next) {
      d += `L${r1(px)} ${r1(py)}`;
      break;
    }
    // round the bend a little: stop short of it, then curve through it
    const back = Math.min(12, Math.hypot(px - pts[i - 1][0], py - pts[i - 1][1]) / 3);
    const fwd = Math.min(12, Math.hypot(next[0] - px, next[1] - py) / 3);
    const toward = (a: Pt, b: Pt, k: number): Pt => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [a[0] + ((b[0] - a[0]) / l) * k, a[1] + ((b[1] - a[1]) / l) * k];
    };
    const a = toward(pts[i], pts[i - 1], back), b = toward(pts[i], next, fwd);
    d += `L${r1(a[0])} ${r1(a[1])}Q${r1(px)} ${r1(py)} ${r1(b[0])} ${r1(b[1])}`;
  }
  return d;
}

/** a rounded box as one stroke going round from its top-left corner */
export function box(x: number, y: number, w: number, h: number): string {
  const r = Math.min(8, w / 4, h / 4);
  return `M${r1(x + r)} ${r1(y)}H${r1(x + w - r)}A${r} ${r} 0 0 1 ${r1(x + w)} ${r1(y + r)}V${r1(y + h - r)}A${r} ${r} 0 0 1 ${r1(x + w - r)} ${r1(y + h)}H${r1(x + r)}A${r} ${r} 0 0 1 ${r1(x)} ${r1(y + h - r)}V${r1(y + r)}A${r} ${r} 0 0 1 ${r1(x + r)} ${r1(y)}Z`;
}

/** a circle as one stroke, starting at its top */
export function ring(cx: number, cy: number, r: number): string {
  return `M${r1(cx)} ${r1(cy - r)}A${r} ${r} 0 1 1 ${r1(cx - 0.01)} ${r1(cy - r)}Z`;
}

/** an open arrowhead at the end of a stroke */
export function head(from: Pt, to: Pt, size = 10): string {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const at = (s: number): Pt => [to[0] + Math.cos(a + Math.PI + s * 0.5) * size, to[1] + Math.sin(a + Math.PI + s * 0.5) * size];
  const [l, rr] = [at(1), at(-1)];
  return `M${r1(l[0])} ${r1(l[1])}L${r1(to[0])} ${r1(to[1])}L${r1(rr[0])} ${r1(rr[1])}`;
}

/** a highlighter swipe across a box: one wide soft stroke */
export function swipe(x: number, y: number, w: number, h: number): string {
  return `M${r1(x - 2)} ${r1(y + h / 2)}L${r1(x + w + 2)} ${r1(y + h / 2)}`;
}
