// Pure layout math for the chart family: input clean-up, stacking, label
// de-collision, part-to-whole folding and per-kind layouts. No JSX, so tests
// can run it in node.
import { stack, stackOffsetDiverging, stackOffsetExpand, stackOffsetNone, stackOffsetWiggle, stackOrderInsideOut, stackOrderNone } from "d3-shape";

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** a number from a number or a numeric string ("1,234", "12.5%"), else null */
export function toNum(v: unknown): number | null {
  if (isNum(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[,\s%]/g, "");
    if (s && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
  }
  return null;
}
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : isNum(v) ? String(v) : d);
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ───────────── x values: numbers, dates or labels

export type XKind = "num" | "time" | "cat";
const ISO = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?)?)?Z?$/;
/** "2026-03-01", "2026-03", "2026-03-01T14:00" → UTC ms; a bare year is not a date */
export function parseTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = ISO.exec(v.trim());
  if (!m || m[2] === undefined) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  return Number.isFinite(t) ? t : null;
}
export function xKind(xs: unknown[]): XKind {
  if (!xs.length) return "cat";
  if (xs.every(isNum)) return "num";
  if (xs.every((x) => parseTime(x) !== null)) return "time";
  return "cat";
}
const DAY = 864e5;
/** a short Korean label for a time tick, by how much time the axis spans */
export function fmtTime(t: number, span: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
  if (span > 3 * 365 * DAY) return `${y}`;
  if (span > 120 * DAY) return mo === 1 ? `${y}.${mo}` : `${mo}월`;
  if (span > 2 * DAY) return `${mo}/${da}`;
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** the label a tooltip shows for an x value */
export function xLabel(x: unknown, kind: XKind): string {
  if (kind === "time") {
    const t = parseTime(x)!;
    const d = new Date(t);
    const hm = d.getUTCHours() || d.getUTCMinutes() ? ` ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` : "";
    return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}${hm}`;
  }
  return str(x);
}

// ───────────── series

export interface Series { label: string; values: (number | null)[]; em?: boolean; dash?: boolean; as?: string }
export interface SeriesData { x: (string | number)[]; series: Series[] }
/**
 * Every "values over x" input in one shape. Accepts
 *   {x, series:[{label, values}]}, {x, values} (one series), {items:[{label, value}]}
 * Missing x → 1..n; values shorter than x are padded with null, longer ones cut.
 */
export function normSeries(b: any): SeriesData {
  let series: Series[] = arr<any>(b?.series)
    .filter((s) => s && typeof s === "object")
    .map((s, i) => ({ label: str(s.label ?? s.name, `계열 ${i + 1}`), values: arr(s.values ?? s.data).map(toNum), em: !!(s.em ?? s.highlight), dash: !!s.dash, as: str(s.as) || undefined }));
  let x: (string | number)[] = arr<any>(b?.x).map((v) => (isNum(v) ? v : str(v)));
  if (!series.length && Array.isArray(b?.values)) series = [{ label: str(b?.label, "값"), values: arr(b.values).map(toNum) }];
  if (!series.length && Array.isArray(b?.items)) {
    const items = arr<any>(b.items).filter((i) => i && typeof i === "object");
    if (!x.length) x = items.map((i, k) => str(i.label ?? i.x, `${k + 1}`));
    series = [{ label: str(b?.label, "값"), values: items.map((i) => toNum(i.value ?? i.y)) }];
  }
  const n = Math.max(x.length, ...series.map((s) => s.values.length), 0);
  if (!x.length) x = Array.from({ length: n }, (_, i) => i + 1);
  const len = x.length;
  series = series.map((s) => ({ ...s, values: Array.from({ length: len }, (_, i) => (i < s.values.length ? s.values[i] : null)) }));
  return { x, series: series.filter((s) => s.values.some((v) => v !== null)) };
}

export type StackMode = "stack" | "percent" | "stream" | "diverging";
/** [lo, hi] per series per x; nulls count as 0 */
export function stackSeries(values: (number | null)[][], mode: StackMode): [number, number][][] {
  if (!values.length) return [];
  const n = Math.max(...values.map((v) => v.length));
  const rows = Array.from({ length: n }, (_, i) => values.map((v) => v[i] ?? 0));
  const keys = values.map((_, k) => k);
  const st = stack<number[], number>()
    .keys(keys)
    .value((d, k) => d[k])
    .offset(mode === "percent" ? stackOffsetExpand : mode === "stream" ? stackOffsetWiggle : mode === "diverging" ? stackOffsetDiverging : stackOffsetNone)
    .order(mode === "stream" ? stackOrderInsideOut : stackOrderNone);
  const out = st(rows);
  return out.map((layer) => layer.map((p) => [Number.isFinite(p[0]) ? p[0] : 0, Number.isFinite(p[1]) ? p[1] : 0] as [number, number]));
}

/** running total, nulls carry the last total (null before the first value) */
export function cumulate(values: (number | null)[]): (number | null)[] {
  let acc: number | null = null;
  return values.map((v) => (v === null ? acc : (acc = (acc ?? 0) + v)));
}

/** extent of the finite numbers, or null */
export function extent(vals: Iterable<number | null | undefined>): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) if (isNum(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  return lo <= hi ? [lo, hi] : null;
}
/** a value domain that includes 0 when the data sits close enough to it */
export function valueDomain(ext: [number, number] | null, zero: "always" | "auto" = "auto"): [number, number] {
  if (!ext) return [0, 1];
  let [lo, hi] = ext;
  if (zero === "always" || (lo >= 0 && lo <= hi * 0.5) || (hi <= 0 && hi >= lo * 0.5)) (lo = Math.min(lo, 0)), (hi = Math.max(hi, 0));
  if (lo === hi) (lo -= Math.abs(lo) * 0.1 || 1), (hi += Math.abs(hi) * 0.1 || 1);
  return [lo, hi];
}

// ───────────── labels

/**
 * 1-D label de-collision: move the wanted positions apart so neighbours are at
 * least `gap` apart, keep their order and stay inside [lo, hi]. Returns positions
 * in the input order.
 */
export function dodge(want: number[], gap: number, lo = -Infinity, hi = Infinity): number[] {
  const idx = want.map((_, i) => i).sort((a, b) => want[a] - want[b]);
  const pos = idx.map((i) => want[i]);
  // clusters of overlapping labels are centred on their mean, then merged
  type C = { start: number; n: number; mean: number };
  const cs: C[] = [];
  for (let k = 0; k < pos.length; k++) {
    cs.push({ start: k, n: 1, mean: pos[k] });
    for (;;) {
      if (cs.length < 2) break;
      const b = cs[cs.length - 1], a = cs[cs.length - 2];
      const aEnd = a.mean + ((a.n - 1) * gap) / 2, bStart = b.mean - ((b.n - 1) * gap) / 2;
      if (bStart - aEnd >= gap) break;
      const n = a.n + b.n;
      const mean = (a.mean * a.n + b.mean * b.n) / n;
      cs.splice(cs.length - 2, 2, { start: a.start, n, mean });
    }
  }
  const out = new Array<number>(pos.length);
  for (const c of cs) for (let j = 0; j < c.n; j++) out[c.start + j] = c.mean - ((c.n - 1) * gap) / 2 + j * gap;
  // keep inside the range, shifting the whole run
  if (out.length) {
    const total = (out.length - 1) * gap;
    if (hi - lo >= total) {
      for (let k = 0; k < out.length; k++) out[k] = Math.max(out[k], lo + k * gap);
      for (let k = out.length - 1; k >= 0; k--) out[k] = Math.min(out[k], hi - (out.length - 1 - k) * gap);
    }
  }
  const res = new Array<number>(want.length);
  idx.forEach((i, k) => (res[i] = out[k]));
  return res;
}

/**
 * Which tick labels to keep along an axis so none overlap: labels sit centred at
 * `pos` with widths `w`; keeps every k-th from the first, k as small as possible.
 */
export function thin(pos: number[], w: number[], pad = 8): number[] {
  const n = pos.length;
  if (n <= 1) return pos.map((_, i) => i);
  for (let k = 1; k <= n; k++) {
    const keep: number[] = [];
    for (let i = 0; i < n; i += k) keep.push(i);
    let ok = true;
    for (let j = 1; j < keep.length && ok; j++) {
      const a = keep[j - 1], b = keep[j];
      if (pos[a] + w[a] / 2 + pad > pos[b] - w[b] / 2) ok = false;
    }
    if (ok) return keep;
  }
  return [0];
}

/** greedy placement of boxes: keep a box only if it hits none already kept */
export function placeBoxes<T extends { x: number; y: number; w: number; h: number }>(boxes: T[], pad = 2): T[] {
  const kept: T[] = [];
  for (const b of boxes) {
    if (kept.every((k) => b.x + b.w + pad <= k.x || k.x + k.w + pad <= b.x || b.y + b.h + pad <= k.y || k.y + k.h + pad <= b.y)) kept.push(b);
  }
  return kept;
}

/** cut a string to at most `max` px using a width function, adding "…" */
export function ellipsize(s: string, max: number, width: (s: string) => number): string {
  if (width(s) <= max) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(chars.slice(0, mid).join("") + "…") <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join("").trimEnd() + "…" : "";
}

// ───────────── marks

/**
 * A bar as a path, square at its baseline and with a rounded data end.
 * (x, y, w, h) is the rect; `end` names the side that carries the data end.
 */
export function barPath(x: number, y: number, w: number, h: number, end: "t" | "b" | "l" | "r" | "none", r = 4): string {
  w = Math.max(0, w);
  h = Math.max(0, h);
  const k = Math.max(0, Math.min(r, end === "t" || end === "b" ? Math.min(w / 2, h) : Math.min(h / 2, w)));
  const f = (n: number) => +n.toFixed(2);
  if (end === "none" || k < 0.5) return `M${f(x)},${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`;
  const X = f(x), Y = f(y);
  switch (end) {
    case "t": return `M${X},${f(y + h)}V${f(y + k)}Q${X},${Y} ${f(x + k)},${Y}H${f(x + w - k)}Q${f(x + w)},${Y} ${f(x + w)},${f(y + k)}V${f(y + h)}Z`;
    case "b": return `M${X},${Y}V${f(y + h - k)}Q${X},${f(y + h)} ${f(x + k)},${f(y + h)}H${f(x + w - k)}Q${f(x + w)},${f(y + h)} ${f(x + w)},${f(y + h - k)}V${Y}Z`;
    case "r": return `M${X},${Y}H${f(x + w - k)}Q${f(x + w)},${Y} ${f(x + w)},${f(y + k)}V${f(y + h - k)}Q${f(x + w)},${f(y + h)} ${f(x + w - k)},${f(y + h)}H${X}Z`;
    case "l": return `M${f(x + w)},${Y}H${f(x + k)}Q${X},${Y} ${X},${f(y + k)}V${f(y + h - k)}Q${X},${f(y + h)} ${f(x + k)},${f(y + h)}H${f(x + w)}Z`;
  }
  return `M${X},${Y}h${f(w)}v${f(h)}h${f(-w)}Z`;
}

// ───────────── part to whole

export interface Part { label: string; value: number; other?: boolean; note?: string }
/** clean {label, value} items: positive values only */
export function parts(items: unknown): Part[] {
  return arr<any>(items)
    .filter((i) => i && typeof i === "object")
    .map((i, k) => ({ label: str(i.label ?? i.name, `항목 ${k + 1}`), value: toNum(i.value) ?? NaN, note: str(i.note) || undefined }))
    .filter((p) => isNum(p.value) && p.value > 0);
}
/** keep the largest `max - 1` parts and fold the rest into one "기타" (only when more than `max`) */
export function foldParts(ps: Part[], max = 6): Part[] {
  const named = ps.filter((p) => !/^(기타|other)$/i.test(p.label));
  const given = ps.filter((p) => /^(기타|other)$/i.test(p.label)).reduce((n, p) => n + p.value, 0);
  const sorted = [...named].sort((a, b) => b.value - a.value);
  const total = sorted.length + (given > 0 ? 1 : 0);
  if (total <= max) return given > 0 ? [...sorted, { label: "기타", value: given, other: true }] : sorted;
  const keep = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((n, p) => n + p.value, 0) + given;
  return [...keep, { label: "기타", value: rest, other: true }];
}
/** integers that sum to `total`, proportional to the values (largest remainder) */
export function largestRemainder(values: number[], total: number): number[] {
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (!sum || total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
  return out;
}
/** percentages that add up to 100 at the given precision */
export function sharePct(values: number[], digits = 0): number[] {
  const f = 10 ** digits;
  return largestRemainder(values, 100 * f).map((v) => v / f);
}

// ───────────── waterfall, pareto

export interface WfStep { label: string; start: number; end: number; kind: "up" | "down" | "total"; value: number }
/**
 * Waterfall steps. An item with `total: true` is a subtotal bar from 0 to the
 * running sum (or to its own value when given, which resets the sum). The first
 * item is a starting total when it is marked as one.
 */
export function waterfall(items: unknown): WfStep[] {
  let acc = 0;
  const out: WfStep[] = [];
  for (const [k, i] of arr<any>(items).entries()) {
    if (!i || typeof i !== "object") continue;
    const label = str(i.label, `항목 ${k + 1}`);
    const v = toNum(i.value);
    if (i.total) {
      if (v !== null) acc = v;
      out.push({ label, start: 0, end: acc, kind: "total", value: acc });
    } else if (v !== null) {
      out.push({ label, start: acc, end: acc + v, kind: v >= 0 ? "up" : "down", value: v });
      acc += v;
    }
  }
  return out;
}
export function pareto(items: unknown): (Part & { cum: number })[] {
  const ps = parts(items).sort((a, b) => b.value - a.value);
  const total = ps.reduce((n, p) => n + p.value, 0) || 1;
  let acc = 0;
  return ps.map((p) => ({ ...p, cum: ((acc += p.value) / total) * 100 }));
}

// ───────────── bump

/** rank per x (1 = largest) when the inputs are values; ties share order of input */
export function ranksOf(values: (number | null)[][]): (number | null)[][] {
  const n = Math.max(0, ...values.map((v) => v.length));
  const out = values.map((v) => v.map(() => null as number | null));
  for (let i = 0; i < n; i++) {
    const present = values.map((v, k) => [v[i], k] as const).filter(([v]) => v !== null && v !== undefined) as [number, number][];
    present.sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, k], r) => (out[k][i] = r + 1));
  }
  return out;
}

// ───────────── marimekko

export interface MekkoRect { col: number; row: number; x: number; w: number; y0: number; y1: number; value: number; share: number }
/** columns as wide as their totals, each split by its series' shares; all in 0..1 */
export function marimekko(values: (number | null)[][], gap = 0): { cols: { x: number; w: number; total: number }[]; rects: MekkoRect[] } {
  const nCols = Math.max(0, ...values.map((v) => v.length));
  const totals = Array.from({ length: nCols }, (_, c) => values.reduce((n, s) => n + Math.max(0, s[c] ?? 0), 0));
  const grand = totals.reduce((a, b) => a + b, 0) || 1;
  const live = totals.filter((t) => t > 0).length;
  const room = Math.max(0, 1 - gap * Math.max(0, live - 1));
  const cols: { x: number; w: number; total: number }[] = [];
  const rects: MekkoRect[] = [];
  let x = 0;
  totals.forEach((t, c) => {
    const w = (t / grand) * room;
    cols.push({ x, w, total: t });
    let y = 0;
    values.forEach((s, r) => {
      const v = Math.max(0, s[c] ?? 0);
      if (!v || !t) return;
      const share = v / t;
      rects.push({ col: c, row: r, x, w, y0: y, y1: y + share, value: v, share });
      y += share;
    });
    if (t > 0) x += w + gap;
  });
  return { cols, rects };
}

// ───────────── calendar

export interface DayCell { date: string; t: number; value: number | null; week: number; dow: number }
/** days placed in week columns (Monday first) from the first to the last date */
export function calendarCells(days: { date: string; value: number | null }[]): { cells: DayCell[]; weeks: number; months: { week: number; month: number; year: number }[] } {
  const parsed = days.map((d) => ({ t: parseTime(d.date), value: d.value })).filter((d): d is { t: number; value: number | null } => d.t !== null);
  if (!parsed.length) return { cells: [], weeks: 0, months: [] };
  const byDay = new Map<number, number | null>();
  for (const d of parsed) {
    const k = Math.floor(d.t / DAY);
    const prev = byDay.get(k);
    byDay.set(k, d.value === null ? prev ?? null : (prev ?? 0) + d.value);
  }
  const keys = [...byDay.keys()];
  const first = Math.min(...keys), last = Math.max(...keys);
  // 1970-01-01 was a Thursday; Monday = 0
  const dowOf = (k: number) => (((k + 3) % 7) + 7) % 7;
  const start = first - dowOf(first);
  const cells: DayCell[] = [];
  const months: { week: number; month: number; year: number }[] = [];
  for (let k = first; k <= last && k - first < 800; k++) {
    const t = k * DAY;
    const d = new Date(t);
    const week = Math.floor((k - start) / 7);
    if (d.getUTCDate() === 1 || k === first) {
      const m = { week: d.getUTCDate() <= 7 || k === first ? week : week + 1, month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
      if (!months.length || months[months.length - 1].month !== m.month) months.push(m);
    }
    cells.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`, t, value: byDay.has(k) ? byDay.get(k)! : null, week, dow: dowOf(k) });
  }
  return { cells, weeks: (cells.length ? cells[cells.length - 1].week : 0) + 1, months };
}
/** 0..k-1 bins for values by quantile-free equal steps of the max (0 stays its own "none") */
export function binOf(v: number, max: number, steps: number): number {
  if (!(v > 0) || !(max > 0)) return 0;
  return clamp(Math.ceil((v / max) * steps), 1, steps);
}

// ───────────── parliament

/** seat centres on a half disc: rows of seats from inside out, filled left to right by angle */
export function parliamentSeats(n: number, rOuter: number): { x: number; y: number; r: number }[] {
  n = Math.max(0, Math.min(1000, Math.round(n)));
  if (!n) return [];
  // pick the number of rows so the seats come out roughly square
  let rows = 1;
  for (; rows < 30; rows++) {
    const rIn = rOuter * 0.4;
    const step = (rOuter - rIn) / rows;
    let cap = 0;
    for (let k = 0; k < rows; k++) cap += Math.floor((Math.PI * (rIn + step * (k + 0.5))) / step);
    if (cap >= n) break;
  }
  const rIn = rOuter * 0.4;
  const step = (rOuter - rIn) / rows;
  const radii = Array.from({ length: rows }, (_, k) => rIn + step * (k + 0.5));
  const counts = largestRemainder(radii, n);
  const seats: { x: number; y: number; r: number; a: number }[] = [];
  radii.forEach((r, k) => {
    const c = counts[k];
    for (let j = 0; j < c; j++) {
      const a = c === 1 ? Math.PI / 2 : Math.PI - (j / (c - 1)) * Math.PI;
      seats.push({ x: r * Math.cos(a), y: -r * Math.sin(a), r: step * 0.38, a });
    }
  });
  seats.sort((p, q) => q.a - p.a || Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y));
  return seats.map(({ x, y, r }) => ({ x, y, r }));
}

// ───────────── KPI deltas

/** how a change reads: "up" / "down" / "flat", and whether that is good for the metric */
export function deltaTone(delta: number | null, better: unknown): { dir: "up" | "down" | "flat"; tone: "good" | "bad" | "flat" } {
  if (delta === null || delta === 0) return { dir: "flat", tone: "flat" };
  const dir = delta > 0 ? "up" : "down";
  if (better !== "up" && better !== "down") return { dir, tone: "flat" };
  return { dir, tone: dir === better ? "good" : "bad" };
}
/** a delta written as a string ("+12%", "-3.4") → its signed number */
export function deltaNum(v: unknown): number | null {
  if (isNum(v)) return v;
  if (typeof v === "string") {
    const m = /[-+−▼▲]?\s*\d[\d,]*\.?\d*/.exec(v);
    if (!m) return null;
    const neg = /^[-−▼]/.test(m[0]);
    const n = Number(m[0].replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? (neg ? -n : n) : null;
  }
  return null;
}
