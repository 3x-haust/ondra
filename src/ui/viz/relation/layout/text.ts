// Text sizing and input clean-up shared by the relation family (pure, no DOM).

/** a width estimate for UI sans text: Hangul/CJK ≈ 0.92em, Latin ≈ 0.56em, digits 0.6em */
export function estW(s: string, size = 13.5): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x1100 && (c <= 0x11ff || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef))) w += 0.92;
    else if (ch === " ") w += 0.28;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else if (/[ilj.,:;'|!()[\]·]/.test(ch)) w += 0.3;
    else if (/[MWmw@%]/.test(ch)) w += 0.84;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else w += 0.55;
  }
  return w * size;
}

export type Measure = (s: string) => number;

/** cut `s` with an ellipsis so it is at most `max` px wide ("" when not even one char fits) */
export function ellipsize(s: string, max: number, measure: Measure = (t) => estW(t)): string {
  if (measure(s) <= max) return s;
  const chars = [...s];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join("").trimEnd() + "…") <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : chars.slice(0, lo).join("").trimEnd() + "…";
}

export interface Rect { x: number; y: number; w: number; h: number }
export const overlaps = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Keep labels that don't collide, most important first (higher `rank` wins).
 * Returns the indices kept.
 */
export function declutter(boxes: (Rect & { rank?: number })[], pad = 1): Set<number> {
  const order = boxes.map((_, i) => i).sort((a, b) => (boxes[b].rank ?? 0) - (boxes[a].rank ?? 0));
  const kept: number[] = [];
  for (const i of order) if (kept.every((k) => !overlaps(boxes[i], boxes[k], pad))) kept.push(i);
  return new Set(kept);
}

/** a finite number, or undefined (accepts numeric strings like "1,234") */
export function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
export const toStr = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() || undefined : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
export const arr = <T = any>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => x != null) as T[]) : []);
export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** a small deterministic PRNG (mulberry32), so layouts and dot maps don't change between renders */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
