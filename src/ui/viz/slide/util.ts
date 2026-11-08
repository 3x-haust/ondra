// Pure helpers for the slide family: forgiving input readers and the layout
// math (label placement, trees, decision values, dates, lanes). No JSX, so
// tests can import it.

/* ───────────── forgiving readers ───────────── */

/** a list, or nothing: never throws on a string or an object */
export const arr = <T = unknown>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
/** text from a string or a number; anything else is "" */
export const str = (x: unknown): string => (typeof x === "string" ? x.trim() : typeof x === "number" && Number.isFinite(x) ? String(x) : "");
/** a finite number from a number or a numeric string ("12", "12.5%", "1,200") */
export function toNum(x: unknown): number | undefined {
  if (typeof x === "number") return Number.isFinite(x) ? x : undefined;
  if (typeof x === "string") {
    const n = Number(x.replace(/[,%\s]/g, ""));
    return x.trim() && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type State = "done" | "now" | "todo" | "new" | "changed" | "gone" | "off" | "risk" | "late";
export interface Item { label: string; note?: string; em?: boolean; state?: State; value?: number; unit?: string }
const STATES = new Set<string>(["done", "now", "todo", "new", "changed", "gone", "off", "risk", "late"]);

/** "label" or {label, note, em|highlight, state, value}; undefined when there's no label */
export function item(x: unknown): Item | undefined {
  if (typeof x === "string" || typeof x === "number") return str(x) ? { label: str(x) } : undefined;
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const label = str(o.label ?? o.name ?? o.title ?? o.text);
  if (!label) return undefined;
  const out: Item = { label };
  const note = str(o.note ?? o.desc);
  if (note) out.note = note;
  if (o.em === true || o.highlight === true) out.em = true;
  if (typeof o.state === "string" && STATES.has(o.state)) out.state = o.state as State;
  const v = toNum(o.value);
  if (v !== undefined) out.value = v;
  if (str(o.unit)) out.unit = str(o.unit);
  return out;
}
export const items = (x: unknown): Item[] => arr(x).map(item).filter((i): i is Item => !!i);
/** string lists ("points") from strings or {label} objects */
export const texts = (x: unknown): string[] => (typeof x === "string" && x.trim() ? [x.trim()] : arr(x).map((v) => item(v)?.label ?? "").filter(Boolean));

/** a check's result: what can be drawn, and what was left out and why */
export interface Checked<B> { block: B; dropped: string[] }

/* ───────────── text fitting ───────────── */

export type Measure = (s: string, size: number, weight?: number) => number;
/** rough width for tests and before fonts load: Hangul/CJK ≈ 1em, latin ≈ 0.56em */
export const roughW: Measure = (s, size) => [...s].reduce((w, c) => w + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(c) ? 1 : /[\s.,:;'|!il]/.test(c) ? 0.3 : 0.56), 0) * size;

/** shorten to fit `max` px, ending with "…" */
export function clip(s: string, max: number, size: number, m: Measure = roughW, weight = 500): string {
  if (m(s, size, weight) <= max) return s;
  const cs = [...s];
  let lo = 0, hi = cs.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m(cs.slice(0, mid).join("").trimEnd() + "…", size, weight) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? cs.slice(0, lo).join("").trimEnd() + "…" : "";
}

/** wrap to lines of at most `max` px (by words, then by characters for long words); at most `lines`, the last clipped */
export function wrapPx(s: string, max: number, size: number, lines = 2, m: Measure = roughW, weight = 500): string[] {
  const out: string[] = [];
  let cur = "";
  const words = s.split(/\s+/).filter(Boolean);
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    const next = cur ? `${cur} ${w}` : w;
    if (m(next, size, weight) <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = w;
    if (out.length >= lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  // anything left over goes onto the last line, clipped
  const used = out.join(" ").length;
  if (used < s.replace(/\s+/g, " ").trim().length && out.length) out[out.length - 1] = clip(`${out[out.length - 1]} ${s.replace(/\s+/g, " ").trim().slice(used + 1)}`, max, size, m, weight);
  return out.map((l) => (m(l, size, weight) > max ? clip(l, max, size, m, weight) : l)).filter(Boolean);
}

/* ───────────── point labels (quadrant, positioning) ───────────── */

export interface Rect { x: number; y: number; w: number; h: number }
export const overlaps = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Put each point's label beside it (right, left, above, below) where it doesn't
 * hit another label, a dot or the edges; a label that fits nowhere is left out
 * (the dot keeps its hover tip). Emphasised points are placed first.
 */
export function placeLabels(pts: { x: number; y: number; r: number; w: number; h: number; em?: boolean }[], bounds: Rect, obstacles: Rect[] = []): (Rect & { anchor: "start" | "end" | "middle" } | null)[] {
  const out: (Rect & { anchor: "start" | "end" | "middle" } | null)[] = pts.map(() => null);
  const taken: Rect[] = [...obstacles, ...pts.map((p) => ({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 }))];
  const order = pts.map((_, i) => i).sort((a, b) => Number(!!pts[b].em) - Number(!!pts[a].em));
  const inside = (r: Rect) => r.x >= bounds.x && r.y >= bounds.y && r.x + r.w <= bounds.x + bounds.w && r.y + r.h <= bounds.y + bounds.h;
  for (const i of order) {
    const p = pts[i];
    const g = 4;
    const cands: (Rect & { anchor: "start" | "end" | "middle" })[] = [
      { x: p.x + p.r + g, y: p.y - p.h / 2, w: p.w, h: p.h, anchor: "start" },
      { x: p.x - p.r - g - p.w, y: p.y - p.h / 2, w: p.w, h: p.h, anchor: "end" },
      { x: p.x - p.w / 2, y: p.y - p.r - g - p.h, w: p.w, h: p.h, anchor: "middle" },
      { x: p.x - p.w / 2, y: p.y + p.r + g, w: p.w, h: p.h, anchor: "middle" },
    ];
    const hit = cands.find((c) => inside(c) && !taken.some((t) => overlaps(c, t, 1)));
    if (hit) (out[i] = hit), taken.push(hit);
  }
  return out;
}

/** a domain that holds the values: 0..1, 0..5, 0..10, 0..100 or the nice max */
export function autoMax(vals: number[]): number {
  const m = Math.max(0, ...vals);
  for (const cap of [1, 5, 10, 100]) if (m <= cap) return cap;
  const p = 10 ** Math.floor(Math.log10(m));
  return Math.ceil(m / p) * p;
}

/* ───────────── trees (issue tree, decision tree, org) ───────────── */

export interface TNode<T = unknown> { data: T; kids: TNode<T>[]; depth: number; x: number; y: number; leaves: number }
/** children under `kids` (or `items` / `children` / `branches`) */
export const kidsOf = (o: unknown): unknown[] => {
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  return arr(r.kids ?? r.items ?? r.children ?? r.branches);
};
/** a tree read forgivingly: nodes without a label are dropped with their subtree */
export function readTree<T>(o: unknown, read: (o: unknown) => T | undefined, depth = 0, maxDepth = 6): TNode<T> | undefined {
  const d = read(o);
  if (d === undefined) return undefined;
  const kids = depth < maxDepth ? kidsOf(o).map((k) => readTree(k, read, depth + 1, maxDepth)).filter((k): k is TNode<T> => !!k) : [];
  return { data: d, kids, depth, x: 0, y: 0, leaves: 0 };
}
/** tidy left → right layout: leaves on consecutive rows, parents centred on their kids. y in rows, x = depth */
export function layTree<T>(root: TNode<T>): { rows: number; depth: number; all: TNode<T>[] } {
  let row = 0;
  let depth = 0;
  const all: TNode<T>[] = [];
  const walk = (n: TNode<T>) => {
    all.push(n);
    n.x = n.depth;
    depth = Math.max(depth, n.depth);
    if (!n.kids.length) { n.y = row++; n.leaves = 1; return; }
    n.kids.forEach(walk);
    n.y = (n.kids[0].y + n.kids[n.kids.length - 1].y) / 2;
    n.leaves = n.kids.reduce((s, k) => s + k.leaves, 0);
  };
  walk(root);
  return { rows: row, depth, all };
}

export interface DNode { label: string; p?: number; value?: number; cost?: number; kind: "decide" | "chance" | "end"; ev?: number; best?: boolean }
export function readDecision(o: unknown): DNode | undefined {
  if (!o || typeof o !== "object") return typeof o === "string" ? { label: o, kind: "end" } : undefined;
  const r = o as Record<string, unknown>;
  const label = str(r.label ?? r.name);
  if (!label) return undefined;
  const p = toNum(r.p ?? r.prob);
  const d: DNode = { label, kind: "end" };
  if (p !== undefined) d.p = p > 1 ? p / 100 : p;
  const v = toNum(r.value);
  if (v !== undefined) d.value = v;
  const c = toNum(r.cost);
  if (c !== undefined) d.cost = c;
  if (r.kind === "chance" || r.kind === "decide") d.kind = r.kind;
  return d;
}
/**
 * Roll back a decision tree: a chance node is worth Σ p·value of its branches,
 * a decision is worth its best branch (marked `best`), a branch's cost is
 * subtracted on the way up. Probabilities that don't sum to 1 are scaled.
 */
export function rollback(n: TNode<DNode>): number | undefined {
  const d = n.data;
  if (!n.kids.length) {
    d.kind = "end";
    d.ev = d.value !== undefined ? d.value - (d.cost ?? 0) : undefined;
    return d.ev;
  }
  if (d.kind === "end") d.kind = n.kids.some((k) => k.data.p !== undefined) ? "chance" : "decide";
  const vals = n.kids.map(rollback);
  if (d.kind === "chance") {
    const ps = n.kids.map((k) => k.data.p ?? 0);
    const sum = ps.reduce((a, b) => a + b, 0);
    d.ev = sum > 0 && vals.every((v) => v !== undefined) ? vals.reduce((s: number, v, i) => s + (v as number) * (ps[i] / sum), 0) : undefined;
  } else {
    let bi = -1;
    vals.forEach((v, i) => v !== undefined && (bi < 0 || v > (vals[bi] as number)) && (bi = i));
    if (bi >= 0) n.kids[bi].data.best = true;
    d.ev = bi >= 0 ? vals[bi] : undefined;
  }
  if (d.ev !== undefined && d.cost) d.ev -= d.cost;
  return d.ev;
}

/* ───────────── circles (cycle, hub) ───────────── */

/** n points on a circle, the first at 12 o'clock, clockwise */
export const around = (n: number, cx: number, cy: number, r: number, start = -Math.PI / 2) =>
  Array.from({ length: n }, (_, i) => {
    const a = start + (i / Math.max(1, n)) * Math.PI * 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), a };
  });

/* ───────────── funnel ───────────── */

/** each stage's share of the first and of the stage before it (null when it can't be computed) */
export function conversions(vals: number[]): { ofFirst: number | null; ofPrev: number | null }[] {
  return vals.map((v, i) => ({
    ofFirst: vals[0] > 0 ? v / vals[0] : null,
    ofPrev: i && vals[i - 1] > 0 ? v / vals[i - 1] : null,
  }));
}
export const pct = (r: number | null, digits = 1) => (r === null ? "–" : `${+(r * 100).toFixed(r * 100 >= 10 ? 0 : digits)}%`);

/* ───────────── dates (gantt, milestones, roadmap) ───────────── */

const DAY = 86_400_000;
/** "2026-11-02", "2026-11" (the 1st), "2026.11.02", "2026/11/02" → days since epoch (UTC); undefined if not a date */
export function day(x: unknown): number | undefined {
  const s = str(x);
  const m = /^(\d{4})[-./](\d{1,2})(?:[-./](\d{1,2}))?/.exec(s);
  if (!m) return undefined;
  const mo = +m[2], d = m[3] ? +m[3] : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return Math.round(Date.UTC(+m[1], mo - 1, d) / DAY);
}
export const dateOf = (d: number) => new Date(d * DAY);
/** "11. 2." (same year) or "2026. 11. 2." */
export const fmtDay = (d: number, withYear = false) => {
  const t = dateOf(d);
  return withYear ? `${t.getUTCFullYear()}. ${t.getUTCMonth() + 1}. ${t.getUTCDate()}.` : `${t.getUTCMonth() + 1}. ${t.getUTCDate()}.`;
};

/** ticks for a day range: weeks (Mondays) when short, month starts, or quarter starts when long */
export function dayTicks(lo: number, hi: number, maxTicks: number): { at: number; label: string }[] {
  const span = Math.max(1, hi - lo);
  const out: { at: number; label: string }[] = [];
  // Mondays (1970-01-01 was a Thursday → day 4 is the first Monday), every 1–4 weeks
  const k = [1, 2, 3, 4].find((n) => span / (7 * n) <= maxTicks);
  if (k) {
    for (let d = lo + ((4 - lo) % 7 + 7) % 7; d <= hi; d += 7 * k) out.push({ at: d, label: fmtDay(d) });
    return out;
  }
  const s = dateOf(lo), months: number[] = [];
  for (let y = s.getUTCFullYear(), mo = s.getUTCMonth() + 1; ; mo++) {
    if (mo > 11) (mo = 0), y++;
    const d = Math.round(Date.UTC(y, mo, 1) / DAY);
    if (d > hi) break;
    months.push(d);
  }
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, maxTicks)));
  const step = every <= 1 ? 1 : every <= 3 ? 3 : every <= 6 ? 6 : 12;
  for (const d of months) {
    const t = dateOf(d);
    if (t.getUTCMonth() % step) continue;
    out.push({ at: d, label: t.getUTCMonth() === 0 ? `${t.getUTCFullYear()}년` : `${t.getUTCMonth() + 1}월` });
  }
  return out;
}

/**
 * Stack intervals into the fewest rows so none overlap (greedy, in start order);
 * returns each interval's row. Used for milestone labels and roadmap bars.
 */
export function packRows(iv: { a: number; b: number }[], gap = 0): number[] {
  const ends: number[] = [];
  const order = iv.map((_, i) => i).sort((x, y) => iv[x].a - iv[y].a);
  const row = iv.map(() => 0);
  for (const i of order) {
    let r = ends.findIndex((e) => e + gap <= iv[i].a);
    if (r < 0) (r = ends.length), ends.push(0);
    ends[r] = iv[i].b;
    row[i] = r;
  }
  return row;
}

/** a period (index or name) → index into `periods`; fractional indexes allowed ("from": 1.5) */
export function periodIx(x: unknown, periods: string[]): number | undefined {
  const n = typeof x === "number" ? x : undefined;
  if (n !== undefined) return Number.isFinite(n) ? clamp(n, 0, Math.max(0, periods.length - 1)) : undefined;
  const s = str(x);
  if (!s) return undefined;
  const i = periods.indexOf(s);
  return i >= 0 ? i : undefined;
}

/* ───────────── status (scorecard, okr) ───────────── */

export type Status = "good" | "warn" | "bad";
/** on target → good, within `tol` (10%) → warn, otherwise bad; `better: "down"` flips it */
export function statusOf(actual: number, target: number, better: "up" | "down" = "up", tol = 0.1): Status {
  if (!Number.isFinite(actual) || !Number.isFinite(target)) return "warn";
  const ratio = target === 0 ? (actual === 0 ? 1 : better === "up" ? (actual > 0 ? 2 : 0) : actual < 0 ? 2 : 0) : better === "up" ? actual / target : target / actual;
  if (better === "down" && actual <= target) return "good";
  if (better === "up" && actual >= target) return "good";
  return ratio >= 1 - tol ? "warn" : "bad";
}
const STATUS_WORDS: Record<string, Status> = { good: "good", ok: "good", green: "good", "달성": "good", "정상": "good", warn: "warn", amber: "warn", yellow: "warn", "주의": "warn", risk: "warn", bad: "bad", red: "bad", "미달": "bad", "위험": "bad" };
export const statusWord = (x: unknown): Status | undefined => STATUS_WORDS[str(x).toLowerCase()];

/** a feature cell: true/"yes"/"o" → yes, false/"no"/"x" → no, "partial"/"△"/0.5 → part, other text → text */
export function cell(x: unknown): { k: "yes" | "no" | "part" | "text" | "none"; t?: string } {
  if (x === true || x === 1) return { k: "yes" };
  if (x === false || x === 0) return { k: "no" };
  if (x === null || x === undefined || x === "") return { k: "none" };
  if (typeof x === "number") return x > 0 && x < 1 ? { k: "part" } : { k: "text", t: String(x) };
  const s = str(x);
  const l = s.toLowerCase();
  if (["yes", "y", "o", "true", "✓", "✔", "지원", "있음"].includes(l)) return { k: "yes" };
  if (["no", "n", "x", "false", "✗", "✕", "미지원", "없음", "-"].includes(l)) return { k: "no" };
  if (["partial", "part", "△", "일부", "부분"].includes(l)) return { k: "part" };
  return s ? { k: "text", t: s } : { k: "none" };
}

/** a Harvey ball: 0–4 quarters (also 0–1 or 0–100 read as a share) */
export function quarters(x: unknown): number | undefined {
  const n = toNum(x);
  if (n === undefined) return undefined;
  if (n > 4) return clamp(Math.round((n / 100) * 4), 0, 4);
  if (n > 0 && n < 1) return clamp(Math.round(n * 4), 0, 4);
  return clamp(Math.round(n), 0, 4);
}

/** RACI letters from "R", "A/R", "RA", "C" … → the set of valid letters in R, A, C, I order */
export function raci(x: unknown): string {
  const s = str(x).toUpperCase();
  return ["R", "A", "C", "I"].filter((l) => s.includes(l)).join("");
}

/** a journey feeling on −2..2 (also 1..5 read as −2..2) */
export function feel(x: unknown, scale5 = false): number | undefined {
  const n = toNum(x);
  if (n === undefined) return undefined;
  return clamp(scale5 ? n - 3 : n, -2, 2);
}
