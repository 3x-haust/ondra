// Sets: circle-overlap geometry for area-proportional Venn/Euler diagrams, region
// label points, and the UpSet aggregation.
import { arr, isObj, rng, toNum, toStr } from "./text";

export interface SetItem { sets: string[]; value: number; em?: boolean }
export interface Circle { x: number; y: number; r: number }

/** items `{sets: ["A","B"], value}`; single-set items are set sizes. Unknown/empty skipped. */
export function cleanSets(raw: unknown): { names: string[]; items: SetItem[] } {
  const names: string[] = [];
  const m = new Map<string, SetItem>();
  for (const it of arr(raw)) {
    if (!isObj(it)) continue;
    const sets = [...new Set(arr(it.sets ?? (it.label != null ? [it.label] : [])).map(toStr).filter(Boolean) as string[])];
    const value = toNum(it.value ?? it.size);
    if (!sets.length || value === undefined || value < 0) continue;
    for (const s of sets) if (!names.includes(s)) names.push(s);
    const key = [...sets].sort().join("\u0000");
    if (!m.has(key)) m.set(key, { sets, value, em: !!(it.em || it.highlight) });
  }
  return { names, items: [...m.values()] };
}

/** area of the lens where two circles of radius r1, r2 at distance d overlap */
export function lens(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}

/** the distance at which two circles overlap by `area` (bisection; lens area falls as d grows) */
export function distFor(r1: number, r2: number, area: number): number {
  if (area <= 0) return r1 + r2;
  if (area >= Math.PI * Math.min(r1, r2) ** 2) return Math.abs(r1 - r2);
  let lo = Math.abs(r1 - r2);
  let hi = r1 + r2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lens(r1, r2, mid) > area) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** set sizes and pairwise intersections (inclusive) from the items */
export function sizes(names: string[], items: SetItem[]) {
  const key = (ss: string[]) => [...ss].sort().join("\u0000");
  const val = new Map(items.map((i) => [key(i.sets), i.value]));
  const size = names.map((n) => val.get(key([n])));
  const pair = (a: string, b: string) => val.get(key([a, b]));
  return { size, pair, val, key };
}

/**
 * Circles for 2–5 sets whose areas match the set sizes and whose pairwise overlaps
 * match as closely as the plane allows. Missing sizes → equal circles; a missing
 * pair → a moderate overlap (unless `disjointUnknown`). Returns unit-free coordinates.
 */
export function layoutCircles(names: string[], items: SetItem[], opt: { disjointUnknown?: boolean } = {}): Circle[] {
  const { size, pair } = sizes(names, items);
  const n = names.length;
  if (!n) return [];
  const known = size.every((s) => s !== undefined && s > 0);
  const r = names.map((_, i) => (known ? Math.sqrt(size[i]! / Math.PI) : 1));
  if (!known && !opt.disjointUnknown) {
    // symmetric classic Venn
    if (n === 1) return [{ x: 0, y: 0, r: 1 }];
    return names.map((_, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n === 2 ? Math.PI / 2 : 0);
      const d = n === 2 ? 0.55 : 0.62;
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: 1 };
    });
  }
  // target distances with their kind: exact, at least (disjoint), at most (subset)
  type T = { d: number; kind: "eq" | "min" | "max" };
  const tgt: T[][] = names.map(() => names.map(() => ({ d: 0, kind: "eq" as const })));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const p = pair(names[i], names[j]);
      const ri = r[i];
      const rj = r[j];
      let t: T;
      if (p === undefined) t = opt.disjointUnknown ? { d: ri + rj, kind: "min" } : { d: distFor(ri, rj, Math.PI * Math.min(ri, rj) ** 2 * 0.25), kind: "eq" };
      else if (p <= 0) t = { d: (ri + rj) * 1.04, kind: "min" };
      else if (!known) t = { d: distFor(ri, rj, Math.PI * Math.min(ri, rj) ** 2 * 0.3), kind: "eq" };
      else if (p >= Math.min(size[i]!, size[j]!) * 0.999) t = { d: Math.max(0, Math.abs(ri - rj) * 0.85), kind: "max" };
      else t = { d: distFor(ri, rj, Math.min(p, Math.PI * Math.min(ri, rj) ** 2)), kind: "eq" };
      tgt[i][j] = tgt[j][i] = t;
    }
  const loss = (c: Circle[]) => {
    let s = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y);
        const t = tgt[i][j];
        const e = t.kind === "eq" ? d - t.d : t.kind === "min" ? Math.min(0, d - t.d) : Math.max(0, d - t.d);
        s += e * e;
      }
    return s;
  };
  const rand = rng(n * 31 + Math.round(r.reduce((a, b) => a + b, 0) * 1000));
  const scale = Math.max(...r);
  let best: Circle[] = [];
  let bestL = Infinity;
  for (let start = 0; start < 6; start++) {
    let c: Circle[] = r.map((ri, i) => {
      const a = (i / n) * Math.PI * 2 + start;
      return { x: Math.cos(a) * scale * (0.5 + rand()), y: Math.sin(a) * scale * (0.5 + rand()), r: ri };
    });
    // gradient descent on the pairwise distance errors
    let step = 0.1 * scale;
    let l = loss(c);
    for (let it = 0; it < 600 && step > 1e-5 * scale; it++) {
      const g = c.map(() => ({ x: 0, y: 0 }));
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const dx = c[i].x - c[j].x;
          const dy = c[i].y - c[j].y;
          const d = Math.hypot(dx, dy) || 1e-9;
          const t = tgt[i][j];
          const e = t.kind === "eq" ? d - t.d : t.kind === "min" ? Math.min(0, d - t.d) : Math.max(0, d - t.d);
          g[i].x += (e * dx) / d;
          g[i].y += (e * dy) / d;
        }
      const gn = Math.hypot(...g.flatMap((v) => [v.x, v.y])) || 1;
      const nc = c.map((ci, i) => ({ ...ci, x: ci.x - (step * g[i].x) / gn, y: ci.y - (step * g[i].y) / gn }));
      const nl = loss(nc);
      if (nl < l) (c = nc), (l = nl), (step *= 1.15);
      else step *= 0.5;
    }
    if (l < bestL) (bestL = l), (best = c);
  }
  // put the largest circle left, so the same data always reads the same way
  return orient(best);
}

function orient(c: Circle[]): Circle[] {
  if (c.length < 2) return c.map((x) => ({ ...x, x: 0, y: 0 }));
  const cx = c.reduce((s, p) => s + p.x * p.r * p.r, 0) / c.reduce((s, p) => s + p.r * p.r, 0);
  const cy = c.reduce((s, p) => s + p.y * p.r * p.r, 0) / c.reduce((s, p) => s + p.r * p.r, 0);
  const big = c.reduce((a, b) => (b.r > a.r ? b : a));
  let a = Math.atan2(big.y - cy, big.x - cx);
  if (Math.hypot(big.y - cy, big.x - cx) < 1e-6) a = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) + Math.PI;
  const rot = Math.PI - a;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return c.map((p) => ({ r: p.r, x: (p.x - cx) * cos - (p.y - cy) * sin, y: (p.x - cx) * sin + (p.y - cy) * cos }));
}

/** the bounding box of the circles */
export function bounds(c: Circle[]) {
  const x0 = Math.min(...c.map((p) => p.x - p.r));
  const x1 = Math.max(...c.map((p) => p.x + p.r));
  const y0 = Math.min(...c.map((p) => p.y - p.r));
  const y1 = Math.max(...c.map((p) => p.y + p.r));
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * A label point for each region that exists (a bitmask of the circles a point is in):
 * the sampled point deepest inside that region, with its clearance and sampled area.
 */
export function regions(c: Circle[], res = 90): Map<number, { x: number; y: number; clear: number; area: number }> {
  const out = new Map<number, { x: number; y: number; clear: number; area: number }>();
  if (!c.length) return out;
  const b = bounds(c);
  const step = Math.max(b.w, b.h) / res;
  for (let y = b.y0 + step / 2; y < b.y1; y += step)
    for (let x = b.x0 + step / 2; x < b.x1; x += step) {
      let mask = 0;
      let clear = Infinity;
      c.forEach((p, i) => {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < p.r) mask |= 1 << i;
        clear = Math.min(clear, Math.abs(p.r - d));
      });
      if (!mask) continue;
      const cur = out.get(mask);
      if (!cur) out.set(mask, { x, y, clear, area: step * step });
      else {
        cur.area += step * step;
        if (clear > cur.clear) Object.assign(cur, { x, y, clear });
      }
    }
  return out;
}

/**
 * Exclusive region values (only these sets) from inclusive intersections, by
 * inclusion–exclusion. A missing higher-order intersection is inferred when it can
 * be (a subset pair: A ⊆ B makes A∩B∩C = A∩C; a disjoint pair makes it 0); a region
 * that needs one that can't be inferred stays undefined (drawn without a number).
 */
export function exclusive(names: string[], items: SetItem[]): Map<number, number | undefined> {
  const { val, key } = sizes(names, items);
  const n = names.length;
  const memo = new Map<number, number | undefined>();
  const inc = (mask: number): number | undefined => {
    if (memo.has(mask)) return memo.get(mask);
    let v = val.get(key(names.filter((_, i) => mask & (1 << i))));
    if (v === undefined && bits(mask) >= 2) {
      const idx = names.map((_, i) => i).filter((i) => mask & (1 << i));
      outer: for (const i of idx)
        for (const j of idx) {
          if (i === j) continue;
          const pij = val.get(key([names[i], names[j]]));
          if (pij === 0) { v = 0; break outer; }
          const si = val.get(key([names[i]]));
          if (bits(mask) >= 3 && pij !== undefined && si !== undefined && pij >= si) { v = inc(mask & ~(1 << j)); if (v !== undefined) break outer; }
        }
    }
    memo.set(mask, v);
    return v;
  };
  const out = new Map<number, number | undefined>();
  const full = (1 << n) - 1;
  for (let m = 1; m <= full; m++) {
    // exclusive(m) = Σ over supersets s ⊇ m of (-1)^{|s|-|m|} inc(s)
    let s = 0;
    let ok = true;
    for (let sup = m; ; sup = (sup + 1) | m) {
      const v = inc(sup);
      if (v === undefined) ok = false;
      else s += ((bits(sup) - bits(m)) % 2 ? -1 : 1) * v;
      if (sup === full) break;
    }
    out.set(m, ok ? Math.max(0, s) : undefined);
  }
  return out;
}
export const bits = (m: number) => { let c = 0; for (let x = m; x; x &= x - 1) c++; return c; };

export interface UpsetCombo { sets: string[]; mask: number; value: number; em?: boolean }

/**
 * UpSet: each item is an exclusive combination (`value` = only these sets). Set totals
 * are summed from the combinations unless given as `sets: [{label, value}]`.
 */
export function upset(b: { items?: unknown; sets?: unknown }, maxCombos = 16): { names: string[]; totals: number[]; combos: UpsetCombo[]; more: number } {
  const names: string[] = [];
  const given = new Map<string, number>();
  for (const s of arr(b.sets)) {
    const name = isObj(s) ? toStr(s.label ?? s.name) : toStr(s);
    if (!name) continue;
    if (!names.includes(name)) names.push(name);
    const v = isObj(s) ? toNum(s.value ?? s.size) : undefined;
    if (v !== undefined) given.set(name, v);
  }
  const combos = new Map<number, UpsetCombo>();
  const raw: { sets: string[]; value: number; em: boolean }[] = [];
  for (const it of arr(b.items)) {
    if (!isObj(it)) continue;
    const sets = [...new Set(arr(it.sets).map(toStr).filter(Boolean) as string[])];
    const value = toNum(it.value ?? it.size);
    if (!sets.length || value === undefined || value < 0) continue;
    for (const s of sets) if (!names.includes(s)) names.push(s);
    raw.push({ sets, value, em: !!(it.em || it.highlight) });
  }
  for (const r of raw) {
    const mask = r.sets.reduce((m, s) => m | (1 << names.indexOf(s)), 0);
    const p = combos.get(mask);
    if (p) p.value += r.value;
    else combos.set(mask, { sets: names.filter((_, i) => mask & (1 << i)), mask, value: r.value, em: r.em });
  }
  const totals = names.map((n, i) => given.get(n) ?? [...combos.values()].filter((c) => c.mask & (1 << i)).reduce((s, c) => s + c.value, 0));
  const sorted = [...combos.values()].sort((a, b) => b.value - a.value || bits(a.mask) - bits(b.mask));
  return { names, totals, combos: sorted.slice(0, maxCombos), more: Math.max(0, sorted.length - maxCombos) };
}
