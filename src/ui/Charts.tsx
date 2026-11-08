// Diagrams people use at work, drawn the way they expect them:
//   flow    → flowchart (start/end pills, step boxes, decision diamonds, yes/no)
//   deps    → dependency / call graph (groups as clusters, cycles in red)
//   classes → UML class diagram (fields · methods, extends ▷, implements ▷ dashed, has ◆)
//   er      → ER diagram (tables with PK/FK columns, 1 / N at the line ends)
//   arch    → architecture topology (zones, services, DB cylinders, queues, async dashed)
// One layout for all of them (dagre, layered): node sizes are measured first and
// edge labels get their own space in the layout, so nothing is drawn over a box.
// Reading rules (same in every diagram):
//   · lines carry their verb on the line, on a knocked-out label
//   · a state is color AND a word on the box (새로 · 바뀜 · 없앰 · 위험 · 안 씀)
//   · "em" marks the main path: it stays strong, the other lines step back
//   · too wide for the column → the other direction, never a shrunken picture
import { Icon } from "./Icon";
import { copyVisual, saveVisual, viewVisual } from "./exportVisual";
import { logoPath } from "./Logos";
import { graphlib, layout } from "@dagrejs/dagre";
import { createMemo, For, type JSX, Show } from "solid-js";
import { previewFile } from "../state/ui";
import { t as tr } from "../i18n";

/** new/changed/gone: what this work did · risk: watch out · off: there, but not used */
export type State = "new" | "changed" | "gone" | "risk" | "off" | undefined;
type Box = { x: number; y: number; w: number; h: number };
type LNode = { id: string; w: number; h: number; parent?: string };
type LEdge = { id: string; from: string; to: string; label?: string; cls?: string; start?: string; end?: string; ends?: [string?, string?] };
type Pt = { x: number; y: number };
type Laid = {
  nodes: Map<string, Box>;
  clusters: Map<string, Box>;
  edges: (LEdge & { points: Pt[]; lx?: number; ly?: number })[];
  w: number;
  h: number;
};

// ───────────── type sizes (the CSS uses the same numbers)
const FT = 14; // box title
const FN = 12.5; // box note
const FL = 12.5; // line label
const LH = 22; // line label height
const LP = 16; // line label side padding (both sides)
/** the chat column a picture has to fit (wider → try the other direction) */
const MAXW = 660;
const TAG: Record<string, string> = { new: "새로", changed: "바뀜", gone: "없앰", risk: "위험", off: "안 씀" };

// ───────────── text measuring (same fonts as the CSS)
let ctx: CanvasRenderingContext2D | null = null;
const family = () => (typeof document !== "undefined" ? getComputedStyle(document.body).fontFamily : "sans-serif");
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export function textW(s: string, size = 13, weight = 500, mono = false): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return s.length * size * 0.6;
  ctx.font = `${weight} ${size}px ${mono ? MONO : family()}`;
  return Math.ceil(ctx.measureText(s).width);
}
const cut = (s: string, n = 42) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const labelW = (s: string) => textW(s, FL, 500) + LP;
/** the state word, in the app's language */
const tag = (s: State) => (s && TAG[s] ? tr(TAG[s]) : "");
const chipW = (s: State) => (tag(s) ? textW(tag(s), 11, 600) + 14 : 0);

// ───────────── layout
function lay(nodes: LNode[], edges: LEdge[], clusters: { id: string; label: string }[], opt: { dir?: "TB" | "LR"; nodesep?: number; ranksep?: number; onLines?: boolean } = {}): Laid {
  const g = new graphlib.Graph({ compound: clusters.length > 0, multigraph: true });
  g.setGraph({ rankdir: opt.dir ?? "TB", nodesep: opt.nodesep ?? 32, ranksep: opt.ranksep ?? 52, edgesep: 20, marginx: 16, marginy: clusters.length ? 34 : 18 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of clusters) g.setNode(c.id, { label: c.label });
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    g.setNode(n.id, { width: n.w, height: n.h });
    if (n.parent && clusters.some((c) => c.id === n.parent)) g.setParent(n.id, n.parent);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    // onLines: lines go box to box without detours through label slots; the labels are placed on them afterwards
    g.setEdge(e.from, e.to, e.label && !opt.onLines ? { label: e.label, width: labelW(e.label) + 6, height: LH + 4, labelpos: "c" } : {}, e.id);
  }
  layout(g);
  const out: Laid = { nodes: new Map(), clusters: new Map(), edges: [], w: 0, h: 0 };
  for (const n of nodes) {
    const v = g.node(n.id);
    if (v) out.nodes.set(n.id, { x: v.x - n.w / 2, y: v.y - n.h / 2, w: n.w, h: n.h });
  }
  for (const c of clusters) {
    const v = g.node(c.id);
    if (v?.width) out.clusters.set(c.id, { x: v.x - v.width / 2 - 12, y: v.y - v.height / 2 - 30, w: v.width + 24, h: v.height + 42 });
  }
  for (const e of edges) {
    const v = g.edge({ v: e.from, w: e.to, name: e.id });
    if (v?.points) out.edges.push({ ...e, points: v.points, lx: opt.onLines ? undefined : v.x, ly: opt.onLines ? undefined : v.y });
  }
  if (!opt.onLines) return frame(out);
  const blocked = [...out.nodes.values()].map((b) => ({ x: b.x - 4, y: b.y - 14, w: b.w + 8, h: b.h + 18 }));
  return frame(out, placeLabels(out, blocked, true));
}

/** shift everything to a margin and measure the canvas */
function frame(out: Laid, extra: Box[] = [], m = 14): Laid {
  const all = [...out.nodes.values(), ...out.clusters.values()];
  const pts = out.edges.flatMap((e) => e.points);
  const labs = [...extra, ...out.edges.filter((e) => e.label && e.lx !== undefined).map((e) => ({ x: e.lx! - labelW(e.label!) / 2, y: e.ly! - LH / 2, w: labelW(e.label!), h: LH }))];
  // the state chip sits on a box's top edge, 10px above it
  const boxes = [...all, ...labs, ...[...out.nodes.values()].map((b) => ({ ...b, y: b.y - 12, w: b.w + 16, h: 12 }))];
  if (!boxes.length && !pts.length) return out;
  const minX = Math.min(...boxes.map((b) => b.x), ...pts.map((p) => p.x));
  const minY = Math.min(...boxes.map((b) => b.y), ...pts.map((p) => p.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w), ...pts.map((p) => p.x));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h), ...pts.map((p) => p.y));
  const dx = m - minX, dy = m - minY;
  for (const b of all) (b.x += dx), (b.y += dy);
  for (const e of out.edges) {
    e.points = e.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (e.lx !== undefined) (e.lx += dx), (e.ly! += dy);
  }
  out.w = Math.ceil(maxX - minX + m * 2);
  out.h = Math.ceil(maxY - minY + m * 2);
  return out;
}

/** the agent's direction if it gave one; otherwise the preferred one, or the other when that fits the column better */
function fit(make: (dir: "TB" | "LR") => Laid, dir: "TB" | "LR" | undefined, pref: "TB" | "LR"): Laid {
  if (dir) return make(dir);
  const a = make(pref);
  // a little smaller is fine (≥ 86%: 14px type stays ≥ 12px)
  if (a.w * 0.86 <= MAXW) return a;
  const b = make(pref === "LR" ? "TB" : "LR");
  const sa = Math.min(1, MAXW / a.w), sb = Math.min(1, MAXW / b.w);
  return sb > sa + 0.04 && b.h * sb < 1400 ? b : a;
}

const hits = (r: Box, o: Box) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y;

/**
 * Line labels on drawn lines: on the segment that has room for them, away from
 * boxes and from each other (knocked out, so the line under them never cuts a word).
 */
/** how many of these segments run through the box (sampled; lines here are short and few) */
function crossings(r: Box, segs: [Pt, Pt][]) {
  let n = 0;
  for (const [a, b] of segs) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(2, Math.ceil(len / 4));
    for (let i = 0; i <= k; i++) {
      const x = a.x + ((b.x - a.x) * i) / k, y = a.y + ((b.y - a.y) * i) / k;
      if (x > r.x - 2 && x < r.x + r.w + 2 && y > r.y - 2 && y < r.y + r.h + 2) {
        n++;
        break;
      }
    }
  }
  return n;
}

function placeLabels(out: Laid, blocked: Box[], onLine = false) {
  const placed: Box[] = [];
  const segsOf = (e: Laid["edges"][number]) => e.points.slice(1).map((b, i) => [e.points[i], b] as [Pt, Pt]);
  for (const e of out.edges) {
    const others = out.edges.filter((o) => o !== e).flatMap(segsOf);
    if (!e.label) continue;
    const w = labelW(e.label), h = LH;
    let best: { r: Box; s: number } | undefined;
    const p = e.points;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const horiz = Math.abs(b.y - a.y) < 1;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 4) continue;
      const room = horiz ? len >= w + 8 : len >= h + 8;
      for (const t of [0.5, 0.3, 0.7, 0.15, 0.85, 0.4, 0.6, 0.25, 0.75, 0.2, 0.8, 0.35, 0.65]) {
        for (const off of onLine ? [0] : [0, 1, -1, 2, -2]) {
          const cx = a.x + (b.x - a.x) * t + (horiz ? 0 : off * (w / 2 + 6));
          const cy = a.y + (b.y - a.y) * t + (horiz ? off * (h + 4) : 0);
          const r = { x: cx - w / 2, y: cy - h / 2, w, h };
          const s = blocked.filter((o) => hits(r, o)).length * 100 + placed.filter((o) => hits(r, o)).length * 60 + crossings(r, others) * 40 + (room ? 0 : 6) + Math.abs(off) * 9 + Math.abs(t - 0.5) * 4 + (horiz ? 0 : 1);
          if (!best || s < best.s) best = { r, s };
        }
      }
    }
    if (!best) continue;
    placed.push(best.r);
    e.lx = best.r.x + w / 2;
    e.ly = best.r.y + h / 2;
  }
  return placed;
}

/**
 * Architecture tiers. Each zone is one tier in the order given, users first and
 * outside systems last. LR: tiers are columns; TB: tiers are rows (laid out as
 * rows, then turned for LR). Boxes in a tier follow their neighbours (fewer
 * crossings), every line leaves its box at its own port, runs in its own
 * channel between tiers, and lines that skip tiers go around the outside.
 */
type TNode = LNode & { first?: boolean };
function layTiers(nodes: TNode[], edges: LEdge[], zones: { id: string; label: string }[], dir: "TB" | "LR"): Laid {
  const lr = dir === "LR";
  const HEAD = 30;
  // zone padding along the tiers (row space y) and across a tier (row space x). The zone's
  // name sits top-left: above the column in LR, beside the row's first box in TB, so
  // lines coming into a box never run through it
  const padM: [number, number] = [14, 14];
  const padCOf = (t: string): [number, number] => (lr ? [HEAD, 14] : [textW(zones.find((z) => z.id === t)?.label ?? "", 12.5, 600) + 30, 16]);
  const dim = (n: TNode) => (lr ? { w: n.h, h: n.w } : { w: n.w, h: n.h });
  const zoned = (n: TNode) => !!n.parent && zones.some((z) => z.id === n.parent);
  const order = ["^", ...zones.map((z) => z.id), "$"].filter((t) => nodes.some((n) => (zoned(n) ? n.parent === t : n.first ? t === "^" : t === "$")));
  const rowOf = (n: TNode) => order.indexOf(zoned(n) ? n.parent! : n.first ? "^" : "$");
  const rows: TNode[][] = order.map(() => []);
  for (const n of nodes) rows[rowOf(n)].push(n);
  const row = new Map(nodes.map((n) => [n.id, rowOf(n)]));
  const es = edges.filter((e) => row.has(e.from) && row.has(e.to));
  const BASE = lr ? 18 : 26;
  const gapAfter = (r: TNode[], i: number) => {
    const ls = es.filter((e) => e.label && ((e.from === r[i].id && e.to === r[i + 1].id) || (e.from === r[i + 1].id && e.to === r[i].id)));
    if (!ls.length) return BASE;
    return Math.max(BASE, lr ? LH * ls.length + 18 : Math.max(...ls.map((e) => labelW(e.label!))) + 44);
  };
  const xOf = new Map<string, number>();
  const rowW = (r: TNode[]) => r.reduce((a, n, i) => a + dim(n).w + (i < r.length - 1 ? gapAfter(r, i) : 0), 0);
  const place = (r: TNode[]) => {
    let x = -rowW(r) / 2;
    r.forEach((n, i) => {
      const d = dim(n);
      xOf.set(n.id, x + d.w / 2);
      x += d.w + (i < r.length - 1 ? gapAfter(r, i) : 0);
    });
  };
  rows.forEach(place);
  // three sweeps of barycenter ordering; chains inside a tier keep the order given
  for (let pass = 0; pass < 3; pass++)
    for (const r of pass % 2 ? [...rows].reverse() : rows) {
      if (es.some((e) => row.get(e.from) === row.get(e.to) && r.some((n) => n.id === e.from))) continue;
      const bc = (n: TNode) => {
        const xs = es.filter((e) => (e.to === n.id || e.from === n.id) && row.get(e.from) !== row.get(e.to)).map((e) => xOf.get(e.to === n.id ? e.from : e.to) ?? 0);
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (xOf.get(n.id) ?? 0);
      };
      const keep = r.map((n, i) => ({ n, i, b: bc(n) }));
      keep.sort((a, b) => a.b - b.b || a.i - b.i);
      r.splice(0, r.length, ...keep.map((k) => k.n));
      place(r);
    }
  // final positions (row space)
  const GAP = lr ? Math.min(200, Math.max(92, ...es.filter((e) => e.label && row.get(e.from) !== row.get(e.to)).map((e) => labelW(e.label!) + 40))) : 66;
  const box = new Map<string, Box>();
  const clusters = new Map<string, Box>();
  const tierTop: number[] = [], tierBot: number[] = [];
  let y = 0;
  rows.forEach((r, i) => {
    const z = order[i] !== "^" && order[i] !== "$";
    const rh = Math.max(0, ...r.map((n) => dim(n).h));
    const w = rowW(r);
    const padC = padCOf(order[i]);
    const top = y + (z ? padM[0] : 0);
    let x = -w / 2 + (z ? (padC[0] - padC[1]) / 2 : 0);
    r.forEach((n, k) => {
      const d = dim(n);
      box.set(n.id, { x, y: top + (rh - d.h) / 2, w: d.w, h: d.h });
      x += d.w + (k < r.length - 1 ? gapAfter(r, k) : 0);
    });
    if (z && r.length) {
      const x0 = -w / 2 + (padC[0] - padC[1]) / 2;
      clusters.set(order[i], { x: x0 - padC[0], y, w: w + padC[0] + padC[1], h: rh + padM[0] + padM[1] });
    }
    tierTop[i] = y;
    tierBot[i] = y + rh + (z ? padM[0] + padM[1] : 0);
    y = tierBot[i] + GAP;
  });
  const allBoxes = [...box.values(), ...clusters.values()];
  const minX = Math.min(...allBoxes.map((b) => b.x)), maxX = Math.max(...allBoxes.map((b) => b.x + b.w));
  // ports: every line gets its own spot on the side it leaves from
  type Side = "top" | "bot" | "left" | "right";
  const ends = new Map<string, { e: string; other: string; side: Side }[]>();
  const add = (n: string, e: string, other: string, side: Side) => ends.set(n, [...(ends.get(n) ?? []), { e, other, side }]);
  const sideOf = new Map<string, [Side, Side]>();
  for (const e of es) {
    const ra = row.get(e.from)!, rb = row.get(e.to)!;
    let s: [Side, Side];
    if (ra < rb) s = ["bot", "top"];
    else if (ra > rb) s = ["top", "bot"];
    else {
      const r = rows[ra];
      const ia = r.findIndex((n) => n.id === e.from), ib = r.findIndex((n) => n.id === e.to);
      s = Math.abs(ia - ib) === 1 ? (ia < ib ? ["right", "left"] : ["left", "right"]) : ["bot", "bot"];
    }
    sideOf.set(e.id, s);
    add(e.from, e.id, e.to, s[0]);
    add(e.to, e.id, e.from, s[1]);
  }
  const portOf = (n: string, e: string, side: Side): Pt => {
    const b = box.get(n)!;
    const same = (ends.get(n) ?? []).filter((x) => x.side === side);
    const across = side === "top" || side === "bot";
    same.sort((p, q) => (across ? box.get(p.other)!.x + box.get(p.other)!.w / 2 - (box.get(q.other)!.x + box.get(q.other)!.w / 2) : box.get(p.other)!.y - box.get(q.other)!.y));
    const k = same.findIndex((x) => x.e === e);
    const len = across ? b.w : b.h;
    const step = same.length > 1 ? Math.min(lr ? 12 : 22, (len - 20) / (same.length - 1)) : 0;
    const o = (k - (same.length - 1) / 2) * step;
    if (side === "top") return { x: b.x + b.w / 2 + o, y: b.y };
    if (side === "bot") return { x: b.x + b.w / 2 + o, y: b.y + b.h };
    if (side === "left") return { x: b.x, y: b.y + b.h / 2 + o };
    return { x: b.x + b.w, y: b.y + b.h / 2 + o };
  };
  // channels: the gap after tier i (i = -1 is above the first) holds each crossing line at its own height
  const slots = new Map<number, string[]>();
  const want = (gap: number, key: string) => slots.set(gap, [...(slots.get(gap) ?? []), key]);
  const plans: { e: LEdge; p1: Pt; p2: Pt; kind: "adj" | "skip" | "side" | "loop"; g1?: number; g2?: number }[] = [];
  for (const e of es) {
    const ra = row.get(e.from)!, rb = row.get(e.to)!;
    const [s1, s2] = sideOf.get(e.id)!;
    const p1 = portOf(e.from, e.id, s1), p2 = portOf(e.to, e.id, s2);
    if (ra === rb && s1 !== "bot") plans.push({ e, p1, p2, kind: "side" });
    else if (ra === rb) {
      want(ra, `${e.id}:1`);
      plans.push({ e, p1, p2, kind: "loop", g1: ra });
    } else if (Math.abs(ra - rb) === 1) {
      const g = Math.min(ra, rb);
      if (Math.abs(p1.x - p2.x) > 1) want(g, `${e.id}:1`);
      plans.push({ e, p1, p2, kind: "adj", g1: g });
    } else {
      const g1 = ra < rb ? ra : ra - 1, g2 = ra < rb ? rb - 1 : rb;
      want(g1, `${e.id}:1`);
      want(g2, `${e.id}:2`);
      plans.push({ e, p1, p2, kind: "skip", g1, g2 });
    }
  }
  const gapRange = (g: number): [number, number] => (g < 0 ? [tierTop[0] - 34, tierTop[0] - 6] : g >= rows.length - 1 ? [tierBot[rows.length - 1] + 6, tierBot[rows.length - 1] + 34] : [tierBot[g], tierTop[g + 1]]);
  const slotY = (g: number, key: string) => {
    const l = slots.get(g) ?? [key];
    const [a, b] = gapRange(g);
    return a + ((b - a) * (l.indexOf(key) + 1)) / (l.length + 1);
  };
  let laneL = 0, laneR = 0;
  const routed: Laid["edges"] = [];
  for (const { e, p1, p2, kind, g1, g2 } of plans) {
    let pts: Pt[];
    if (kind === "side") pts = [p1, p2];
    else if (kind === "loop") {
      const cy = slotY(g1!, `${e.id}:1`);
      pts = [p1, { x: p1.x, y: cy }, { x: p2.x, y: cy }, p2];
    } else if (kind === "adj") {
      if (Math.abs(p1.x - p2.x) <= 1) pts = [p1, { x: p1.x, y: p2.y }];
      else {
        const cy = slotY(g1!, `${e.id}:1`);
        pts = [p1, { x: p1.x, y: cy }, { x: p2.x, y: cy }, p2];
      }
    } else {
      const left = (p1.x + p2.x) / 2 < (minX + maxX) / 2;
      const lane = left ? minX - 24 - 16 * laneL++ : maxX + 24 + 16 * laneR++;
      const c1 = slotY(g1!, `${e.id}:1`), c2 = slotY(g2!, `${e.id}:2`);
      pts = [p1, { x: p1.x, y: c1 }, { x: lane, y: c1 }, { x: lane, y: c2 }, { x: p2.x, y: c2 }, p2];
    }
    routed.push({ ...e, points: pts });
  }
  // LR: the same picture turned (rows → columns)
  const T = (b: Box): Box => (lr ? { x: b.y, y: b.x, w: b.h, h: b.w } : b);
  const out: Laid = { nodes: new Map(), clusters: new Map(), edges: [], w: 0, h: 0 };
  for (const [k, b] of box) out.nodes.set(k, T(b));
  for (const [k, b] of clusters) out.clusters.set(k, T(b));
  out.edges = routed.map((e) => ({ ...e, points: lr ? e.points.map((p) => ({ x: p.y, y: p.x })) : e.points }));
  const heads = [...out.clusters.entries()].map(([k, b]) => ({ x: b.x, y: b.y, w: textW(zones.find((z) => z.id === k)?.label ?? "", 12.5, 600) + 28, h: HEAD - 4 }));
  const blocked = [...[...out.nodes.values()].map((b) => ({ x: b.x - 3, y: b.y - 3, w: b.w + 6, h: b.h + 6 })), ...heads];
  const labs = placeLabels(out, blocked);
  return frame(out, labs, 16);
}

/** a line through the layout points with softly rounded corners */
function pathOf(p: Pt[]): string {
  if (p.length < 2) return "";
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const r = Math.min(8, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const u = Math.hypot(b.x - a.x, b.y - a.y) || 1, v = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    const orth = (Math.abs(b.x - a.x) < 0.5 || Math.abs(b.y - a.y) < 0.5) && (Math.abs(c.x - b.x) < 0.5 || Math.abs(c.y - b.y) < 0.5);
    if (orth) d += ` L${b.x - ((b.x - a.x) / u) * r},${b.y - ((b.y - a.y) / u) * r} Q${b.x},${b.y} ${b.x + ((c.x - b.x) / v) * r},${b.y + ((c.y - b.y) / v) * r}`;
    else {
      const m = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      d += ` Q${b.x},${b.y} ${m.x},${m.y}`;
    }
  }
  const z = p[p.length - 1];
  return `${d} L${z.x},${z.y}`;
}

/** text a little way along the line from one end (for 1 / N, 1 / *) */
function endPoint(p: Pt[], atEnd: boolean) {
  const a = atEnd ? p[p.length - 1] : p[0];
  const b = atEnd ? p[p.length - 2] : p[1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: a.x + (dx / d) * 16 + (dy / d) * 10, y: a.y + (dy / d) * 16 - (dx / d) * 10 + 4.5 };
}

/** the state word on a box's top-right edge, so the color always comes with a word */
/** band: inside a header band of that height (tables, classes) instead */
function Chip(props: { s: State; b: Box; inset?: number; band?: number }) {
  return (
    <Show when={tag(props.s)}>
      {(t) => {
        const w = chipW(props.s);
        // on the top-right corner, partly outside: clear of the lines that come in at the middle
        const x = props.band ? props.b.x + props.b.w - w - (props.inset ?? 8) : props.b.x + props.b.w - w * 0.62;
        return (
          <g class={`ch-chip st-${props.s}`}>
            <rect x={x} y={props.b.y + (props.band ? props.band / 2 : 0) - 10} width={w} height={19} rx={9.5} />
            <text x={x + w / 2} y={props.b.y + (props.band ? props.band / 2 : 0) + 3.8} text-anchor="middle">{t()}</text>
          </g>
        );
      }}
    </Show>
  );
}

const marker = (end: string | undefined, cls: string | undefined) => {
  if (!end) return undefined;
  if (end !== "arrow" && end !== "open") return end;
  const c = ` ${cls ?? ""} `;
  return c.includes(" cycle ") || c.includes(" no ") ? `${end}-bad` : c.includes(" em ") ? `${end}-em` : end;
};

let seq = 0;
/** the frame every diagram shares: markers, clusters, edges, labels; nodes come from `node` */
function Frame(props: { label?: string; laid: Laid; clusterLabels?: Map<string, string>; node: (id: string, b: Box) => JSX.Element; cls?: string; em?: boolean }) {
  const id = `c${++seq}`;
  let svgEl!: SVGSVGElement;
  const m = (k?: string) => (k ? `url(#${id}-${k})` : undefined);
  const heads = (k: string, cls: string) => (
    <>
      <marker id={`${id}-arrow${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class={`ch-head${cls}`} /></marker>
      <marker id={`${id}-open${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" class={`ch-head-open${cls}`} /></marker>
    </>
  );
  return (
    <div class={`blk chart ${props.cls ?? ""}`} classList={{ "has-em": !!props.em }}>
      <Show when={props.label}><div class="blk-label">{props.label}</div></Show>
      <div class="vis-tools">
        <button class="icon-btn xs" title={tr("크게 보기")} aria-label={tr("크게 보기")} onClick={() => viewVisual(svgEl, props.label)}><Icon name="fit" size={13} /></button>
        <button class="icon-btn xs" title={tr("이미지로 저장")} aria-label={tr("이미지로 저장")} onClick={() => void saveVisual(svgEl, props.label)}><Icon name="download" size={13} /></button>
        <button class="icon-btn xs" title={tr("이미지 복사")} aria-label={tr("이미지 복사")} onClick={() => void copyVisual(svgEl)}><Icon name="copy" size={13} /></button>
      </div>
      <div class="chart-wrap">
        <svg
          ref={svgEl}
          class="chart-svg"
          viewBox={`0 0 ${props.laid.w} ${props.laid.h}`}
          width={props.laid.w}
          style={{ "max-width": "100%", "min-width": `${Math.round(props.laid.w * 0.82)}px`, height: "auto" }}
          role="img"
          aria-label={props.label}
        >
          <defs>
            {heads("", "")}
            {heads("-em", " em")}
            {heads("-bad", " bad")}
            <marker id={`${id}-tri`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1,1 L11,6 L1,11 z" class="ch-head-hollow" /></marker>
            <marker id={`${id}-dia`} viewBox="0 0 14 10" refX="13" refY="5" markerWidth="13" markerHeight="10" orient="auto-start-reverse"><path d="M1,5 L7,1 L13,5 L7,9 z" class="ch-head" /></marker>
            <marker id={`${id}-odia`} viewBox="0 0 14 10" refX="13" refY="5" markerWidth="13" markerHeight="10" orient="auto-start-reverse"><path d="M1,5 L7,1 L13,5 L7,9 z" class="ch-head-hollow" /></marker>
          </defs>
          <For each={[...props.laid.clusters.entries()]}>
            {([cid, b]) => (
              <g class="ch-cluster">
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={12} />
                <text x={b.x + 14} y={b.y + 20}>{props.clusterLabels?.get(cid) ?? cid}</text>
              </g>
            )}
          </For>
          <For each={props.laid.edges}>
            {(e) => (
              <g class={`ch-edge ${e.cls ?? ""}`}>
                <path d={pathOf(e.points)} marker-end={m(marker(e.end, e.cls))} marker-start={m(marker(e.start, e.cls))} />
                <Show when={e.ends?.[0]}>{(t) => <text class="ch-end" {...endPoint(e.points, false)}>{t()}</text>}</Show>
                <Show when={e.ends?.[1]}>{(t) => <text class="ch-end" {...endPoint(e.points, true)}>{t()}</text>}</Show>
              </g>
            )}
          </For>
          <For each={props.laid.nodes.size ? [...props.laid.nodes.entries()] : []}>{([nid, b]) => props.node(nid, b)}</For>
          <For each={props.laid.edges.filter((e) => e.label && e.lx !== undefined)}>
            {(e) => {
              const w = labelW(e.label!);
              return (
                <g class={`ch-elabel ${e.cls ?? ""}`}>
                  {/* knocked out: page color, then the card's own tint on top (the card's color is see-through in dark) */}
                  <rect x={e.lx! - w / 2} y={e.ly! - LH / 2} width={w} height={LH} rx={LH / 2} class="ch-ko" />
                  <rect x={e.lx! - w / 2} y={e.ly! - LH / 2} width={w} height={LH} rx={LH / 2} />
                  <text x={e.lx!} y={e.ly! + 4.4} text-anchor="middle">{e.label}</text>
                </g>
              );
            }}
          </For>
        </svg>
      </div>
    </div>
  );
}

const openRef = (ref?: string) => {
  if (!ref) return;
  const p = ref.replace(/:\d+(:\d+)?$/, "");
  if (p.startsWith("/") || p.startsWith("~")) previewFile(ref);
};
const nodeCls = (s: State, em?: boolean) => `${s ? `st-${s}` : ""}${em ? " em" : ""}`;
const edgeCls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ───────────── state machine (status lifecycle, reducer, connection states)
export type StateNode = { id: string; label?: string; note?: string; final?: boolean; state?: State; em?: boolean };
export type StateEdge = { from: string; to: string; event?: string; guard?: string; state?: State; em?: boolean };
export function States(props: { label?: string; initial?: string; states: StateNode[]; transitions?: StateEdge[]; dir?: "TB" | "LR" }) {
  const START = "__start";
  const laid = createMemo(() => {
    const nodes: LNode[] = props.states.map((n) => {
      const t = textW(cut(n.label ?? n.id, 26), FT, 500) + chipW(n.state), s = n.note ? textW(cut(n.note, 32), FN, 400) : 0;
      return { id: n.id, w: Math.max(96, Math.max(t, s) + 44), h: n.note ? 58 : 42 };
    });
    const edges: LEdge[] = (props.transitions ?? []).map((e, i) => ({
      id: `e${i}`,
      from: e.from,
      to: e.to,
      label: [e.event, e.guard ? `[${e.guard}]` : ""].filter(Boolean).join(" ") || undefined,
      end: "arrow",
      cls: edgeCls(e.state && `st-${e.state}`, e.em && "em"),
    }));
    if (props.initial && props.states.some((n) => n.id === props.initial)) {
      nodes.push({ id: START, w: 16, h: 16 });
      edges.push({ id: "e-start", from: START, to: props.initial, end: "arrow", cls: "start" });
    }
    return fit((dir) => lay(nodes, edges, [], { dir, ranksep: 60, nodesep: 30 }), props.dir, "LR");
  });
  const byId = createMemo(() => new Map(props.states.map((n) => [n.id, n])));
  return (
    <Frame
      label={props.label}
      cls="ch-states"
      laid={laid()}
      em={props.states.some((n) => n.em) || (props.transitions ?? []).some((e) => e.em)}
      node={(id, b) => {
        if (id === START) return <circle cx={b.x + 8} cy={b.y + 8} r={7} class="ch-start" />;
        const n = byId().get(id)!;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        return (
          <g class={`ch-node k-state ${nodeCls(n.state, n.em)}`} classList={{ final: !!n.final }}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} />
            <Show when={n.final}><rect x={b.x + 3.5} y={b.y + 3.5} width={b.w - 7} height={b.h - 7} rx={(b.h - 7) / 2} class="ch-final" /></Show>
            <text x={cx} y={cy + (n.note ? -4 : 5)} text-anchor="middle" class="ch-t">{cut(n.label ?? n.id, 26)}</text>
            <Show when={n.note}><text x={cx} y={cy + 15} text-anchor="middle" class="ch-n">{cut(n.note!, 32)}</text></Show>
            <Chip s={n.state} b={b} />
          </g>
        );
      }}
    />
  );
}

// ───────────── flowchart
export type FlowNode = { id: string; label: string; kind?: "start" | "end" | "step" | "decision" | "io" | "sub"; note?: string; state?: State; ref?: string; em?: boolean };
export function Flow(props: { label?: string; nodes: FlowNode[]; edges?: { from: string; to: string; label?: string; em?: boolean }[]; dir?: "TB" | "LR" }) {
  const laid = createMemo(() => {
    const size = (n: FlowNode) => {
      const t = textW(cut(n.label, 30), FT, 500), s = n.note ? textW(cut(n.note, 36), FN, 400) : 0;
      const w = Math.max(t, s) + (n.kind === "decision" ? 76 : n.kind === "io" ? 56 : 40) + (n.kind === "decision" ? 0 : chipW(n.state) / 2);
      return { w: Math.max(n.kind === "decision" ? 136 : 104, w), h: n.kind === "decision" ? (n.note ? 92 : 76) : n.note ? 60 : 44 };
    };
    const tone = (l = "") => (/^(아니|no|실패|x)/i.test(l) ? "no" : /^(예|yes|네|성공|ok)/i.test(l) ? "yes" : "");
    const nodes = props.nodes.map((n) => ({ id: n.id, ...size(n) }));
    const edges = (props.edges ?? []).map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label, end: "arrow", cls: edgeCls(tone(e.label), e.em && "em") }));
    const labelled = edges.some((e) => e.label);
    if (!labelled) return fit((dir) => lay(nodes, edges, [], { dir, ranksep: 46 }), props.dir, "TB");
    // the gap between two rows holds every label of the lines crossing it, each at its own height
    return fit((dir) => {
      const first = lay(nodes, edges, [], { dir, ranksep: 46, onLines: true });
      const at = (id: string) => { const b = first.nodes.get(id); return b ? Math.round(dir === "LR" ? b.x : b.y) : 0; };
      const gaps = new Map<number, number>();
      for (const e of edges) if (e.label) gaps.set(at(e.from), (gaps.get(at(e.from)) ?? 0) + 1);
      const k = Math.max(1, ...gaps.values());
      return lay(nodes, edges, [], { dir, ranksep: Math.min(150, 34 + k * (dir === "LR" ? 46 : 24)), onLines: true });
    }, props.dir, "TB");
  });
  const byId = createMemo(() => new Map(props.nodes.map((n) => [n.id, n])));
  return (
    <Frame
      label={props.label}
      cls="ch-flow"
      laid={laid()}
      em={props.nodes.some((n) => n.em) || (props.edges ?? []).some((e) => e.em)}
      node={(id, b) => {
        const n = byId().get(id)!;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const k = n.kind ?? "step";
        return (
          <g class={`ch-node k-${k} ${nodeCls(n.state, n.em)}`} classList={{ link: !!n.ref }} onClick={() => openRef(n.ref)}>
            <Show when={k === "decision"} fallback={
              <Show when={k === "io"} fallback={<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={k === "start" || k === "end" ? b.h / 2 : 9} />}>
                <polygon points={`${b.x + 12},${b.y} ${b.x + b.w},${b.y} ${b.x + b.w - 12},${b.y + b.h} ${b.x},${b.y + b.h}`} />
              </Show>
            }>
              <polygon points={`${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}`} />
            </Show>
            <text x={cx} y={cy + (n.note ? -4 : 5)} text-anchor="middle" class="ch-t">{cut(n.label, 30)}</text>
            <Show when={n.note}><text x={cx} y={cy + 15} text-anchor="middle" class="ch-n">{cut(n.note!, 36)}</text></Show>
            <Chip s={n.state} b={b} />
          </g>
        );
      }}
    />
  );
}

// ───────────── dependency / call graph
export type DepNode = { id: string; label: string; group?: string; note?: string; state?: State; ref?: string; em?: boolean };
export function Deps(props: { label?: string; nodes: DepNode[]; edges?: { from: string; to: string; label?: string; kind?: "call" | "import" | "data"; em?: boolean }[]; dir?: "TB" | "LR" }) {
  const edges = () => props.edges ?? [];
  // cycles: edges inside a strongly connected part (Tarjan)
  const cyclic = createMemo(() => {
    const adj = new Map<string, string[]>();
    for (const e of edges()) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    let i = 0;
    const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), st: string[] = [];
    const comp = new Map<string, number>();
    let c = 0;
    const sizes: number[] = [];
    const visit = (v: string) => {
      idx.set(v, i), low.set(v, i), i++, st.push(v), on.add(v);
      for (const w of adj.get(v) ?? []) {
        if (!idx.has(w)) visit(w), low.set(v, Math.min(low.get(v)!, low.get(w)!));
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
      if (low.get(v) === idx.get(v)) {
        let n = 0, w: string;
        do (w = st.pop()!), on.delete(w), comp.set(w, c), n++;
        while (w !== v);
        sizes[c++] = n;
      }
    };
    for (const n of props.nodes) if (!idx.has(n.id)) visit(n.id);
    return new Set(edges().filter((e) => comp.get(e.from) === comp.get(e.to) && (sizes[comp.get(e.from)!] > 1 || e.from === e.to)).map((e) => `${e.from}>${e.to}`));
  });
  const groups = createMemo(() => [...new Set(props.nodes.map((n) => n.group).filter((g): g is string => !!g))]);
  const laid = createMemo(() => {
    const nodes = props.nodes.map((n) => ({
      id: n.id,
      parent: n.group ? `g:${n.group}` : undefined,
      w: Math.max(textW(cut(n.label, 34), 13, 500, true) + chipW(n.state), n.note ? textW(cut(n.note, 36), FN, 400) : 0) + 30,
      h: n.note ? 56 : 40,
    }));
    // a cycle is red AND says so on the line; an unlabeled import says what it is
    const es = edges().map((e, i) => {
      const cyc = cyclic().has(`${e.from}>${e.to}`);
      const label = cyc ? (e.label ? `${e.label} · ${tr("순환")}` : tr("순환")) : e.label ?? (e.kind === "import" ? "import" : undefined);
      return { id: `e${i}`, from: e.from, to: e.to, label, end: e.kind === "import" ? "open" : "arrow", cls: edgeCls(e.kind, cyc && "cycle", e.em && "em") };
    });
    const cl = groups().map((g) => ({ id: `g:${g}`, label: g }));
    return fit((dir) => lay(nodes, es, cl, { dir, ranksep: 60 }), props.dir, "LR");
  });
  const byId = createMemo(() => new Map(props.nodes.map((n) => [n.id, n])));
  return (
    <Frame
      label={props.label}
      cls="ch-deps"
      laid={laid()}
      em={props.nodes.some((n) => n.em) || edges().some((e) => e.em)}
      clusterLabels={new Map(groups().map((g) => [`g:${g}`, g]))}
      node={(id, b) => {
        const n = byId().get(id)!;
        return (
          <g class={`ch-node k-mod ${nodeCls(n.state, n.em)}`} classList={{ link: !!n.ref }} onClick={() => openRef(n.ref)}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={7} />
            <text x={b.x + 14} y={b.y + (n.note ? 23 : 25)} class="ch-t mono">{cut(n.label, 34)}</text>
            <Show when={n.note}><text x={b.x + 14} y={b.y + 42} class="ch-n">{cut(n.note!, 36)}</text></Show>
            <Chip s={n.state} b={b} />
          </g>
        );
      }}
    />
  );
}

// ───────────── UML class diagram
export type UmlClass = { name: string; kind?: "class" | "interface" | "enum" | "type" | "abstract"; fields?: string[]; methods?: string[]; state?: State; ref?: string; em?: boolean };
export type UmlRel = { from: string; to: string; kind: "extends" | "implements" | "has" | "owns" | "uses"; label?: string; card?: [string?, string?]; em?: boolean };
/** what a UML line means, said on the line when the agent gave no verb */
const REL: Record<UmlRel["kind"], string> = { extends: "상속", implements: "구현", owns: "소유", has: "포함", uses: "사용" };
export function Classes(props: { label?: string; classes: UmlClass[]; relations?: UmlRel[]; dir?: "TB" | "LR" }) {
  const HEAD = 34, LINE = 19, PAD = 8;
  const head = (c: UmlClass) => (c.kind && c.kind !== "class" ? 14 : 0);
  const fieldsH = (c: UmlClass) => (c.fields?.length ? PAD * 2 + c.fields.length * LINE : 10);
  const height = (c: UmlClass) => HEAD + head(c) + fieldsH(c) + (c.methods?.length ? PAD * 2 + c.methods.length * LINE : 0);
  const width = (c: UmlClass) => Math.max(textW(c.name, FT, 650) + 36 + chipW(c.state) * 2, ...[...(c.fields ?? []), ...(c.methods ?? [])].map((f) => textW(cut(f, 40), 12.5, 400, true) + 28), 132);
  const laid = createMemo(() => {
    const nodes = props.classes.map((c) => ({ id: c.name, w: width(c), h: height(c) }));
    const es = (props.relations ?? []).map((r, i) => {
      const label = r.label ?? tr(REL[r.kind]);
      const em = r.em && "em";
      // UML: the arrow head sits on the parent/interface; the diamond on the owner
      if (r.kind === "extends" || r.kind === "implements") return { id: `r${i}`, from: r.from, to: r.to, end: "tri", cls: edgeCls(r.kind, em), label };
      if (r.kind === "has" || r.kind === "owns") return { id: `r${i}`, from: r.from, to: r.to, start: r.kind === "owns" ? "dia" : "odia", cls: edgeCls(r.kind, em), label, ends: r.card };
      return { id: `r${i}`, from: r.from, to: r.to, end: "open", cls: edgeCls("uses", em), label, ends: r.card };
    });
    return fit((dir) => lay(nodes, es, [], { dir, ranksep: 58, nodesep: 36 }), props.dir, "TB");
  });
  const byId = createMemo(() => new Map(props.classes.map((c) => [c.name, c])));
  const stereo: Record<string, string> = { interface: "«interface»", enum: "«enum»", type: "«type»", abstract: "«abstract»" };
  return (
    <Frame
      label={props.label}
      cls="ch-uml"
      laid={laid()}
      em={props.classes.some((c) => c.em) || (props.relations ?? []).some((r) => r.em)}
      node={(id, b) => {
        const c = byId().get(id)!;
        const top = b.y + HEAD + head(c);
        const fy = top + PAD;
        const my = top + fieldsH(c);
        return (
          <g class={`ch-node k-class k-${c.kind ?? "class"} ${nodeCls(c.state, c.em)}`} classList={{ link: !!c.ref }} onClick={() => openRef(c.ref)}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={7} />
            <rect x={b.x} y={b.y} width={b.w} height={HEAD + head(c)} rx={7} class="ch-head-band" />
            <Show when={head(c)}><text x={b.x + b.w / 2} y={b.y + 16} text-anchor="middle" class="ch-n">{stereo[c.kind!]}</text></Show>
            <text x={b.x + b.w / 2} y={b.y + 22 + head(c)} text-anchor="middle" class="ch-t strong" classList={{ italic: c.kind === "abstract" || c.kind === "interface" }}>{c.name}</text>
            <line x1={b.x} y1={top} x2={b.x + b.w} y2={top} class="ch-div" />
            <For each={c.fields ?? []}>{(f, i) => <text x={b.x + 14} y={fy + 13 + i() * LINE} class="ch-f mono">{cut(f, 40)}</text>}</For>
            <Show when={c.methods?.length}>
              <line x1={b.x} y1={my} x2={b.x + b.w} y2={my} class="ch-div" />
              <For each={c.methods ?? []}>{(f, i) => <text x={b.x + 14} y={my + PAD + 13 + i() * LINE} class="ch-f mono">{cut(f, 40)}</text>}</For>
            </Show>
            <Chip s={c.state} b={b} band={HEAD + head(c)} inset={8} />
          </g>
        );
      }}
    />
  );
}

// ───────────── ER diagram
export type ErTable = { name: string; columns: { name: string; type?: string; pk?: boolean; fk?: boolean; null?: boolean }[]; state?: State; note?: string; em?: boolean };
export function Er(props: { label?: string; tables: ErTable[]; relations?: { from: string; to: string; card?: "1-1" | "1-n" | "n-1" | "n-n"; label?: string; em?: boolean }[]; dir?: "TB" | "LR" }) {
  const HEAD = 34, ROW = 22;
  const width = (t: ErTable) => Math.max(textW(t.name, FT, 650) + 36 + chipW(t.state), ...t.columns.map((c) => 36 + textW(c.name, 12.5, 500, true) + 20 + (c.type ? textW(c.type, 11.5, 400, true) : 0) + 14), 160);
  const laid = createMemo(() => {
    const nodes = props.tables.map((t) => ({ id: t.name, w: width(t), h: HEAD + t.columns.length * ROW + 10 }));
    const es = (props.relations ?? []).map((r, i) => {
      const [a, b] = (r.card ?? "1-n").split("-");
      return { id: `r${i}`, from: r.from, to: r.to, label: r.label, ends: [a === "n" ? "N" : "1", b === "n" ? "N" : "1"] as [string, string], cls: edgeCls("rel", r.em && "em") };
    });
    return fit((dir) => lay(nodes, es, [], { dir, ranksep: 80, nodesep: 34 }), props.dir, "LR");
  });
  const byId = createMemo(() => new Map(props.tables.map((t) => [t.name, t])));
  return (
    <Frame
      label={props.label}
      cls="ch-er"
      laid={laid()}
      em={props.tables.some((t) => t.em) || (props.relations ?? []).some((r) => r.em)}
      node={(id, b) => {
        const t = byId().get(id)!;
        return (
          <g class={`ch-node k-table ${nodeCls(t.state, t.em)}`}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={7} />
            <rect x={b.x} y={b.y} width={b.w} height={HEAD} rx={7} class="ch-head-band" />
            <text x={b.x + 14} y={b.y + 22} class="ch-t strong">{t.name}</text>
            <line x1={b.x} y1={b.y + HEAD} x2={b.x + b.w} y2={b.y + HEAD} class="ch-div" />
            <For each={t.columns}>
              {(c, i) => {
                const y = b.y + HEAD + 5 + i() * ROW + 15;
                return (
                  <>
                    <Show when={c.pk || c.fk}><text x={b.x + 12} y={y} class={`ch-key ${c.pk ? "pk" : "fk"}`}>{c.pk ? "PK" : "FK"}</text></Show>
                    <text x={b.x + 38} y={y} class="ch-f mono" classList={{ strong: !!c.pk }}>{c.name}{c.null ? "?" : ""}</text>
                    <Show when={c.type}><text x={b.x + b.w - 12} y={y} text-anchor="end" class="ch-ty mono">{c.type}</text></Show>
                  </>
                );
              }}
            </For>
            <Chip s={t.state} b={b} band={HEAD} inset={8} />
          </g>
        );
      }}
    />
  );
}

// ───────────── architecture topology
export type ArchNode = { id: string; label: string; zone?: string; kind?: "user" | "app" | "service" | "function" | "db" | "cache" | "queue" | "storage" | "external" | "gateway"; note?: string; state?: State; ref?: string; logo?: string; em?: boolean };
/** a node's logo: named, or found from its label / note ("Postgres", "Redis", "Node · 3 pods") */
const archLogo = (n: ArchNode) => logoPath(n.logo) ?? logoPath(n.label) ?? logoPath(n.note);
const KIND_TAG: Record<string, string> = { user: "사용자", app: "앱", service: "서비스", function: "함수", db: "DB", cache: "캐시", queue: "큐", storage: "저장소", external: "외부", gateway: "게이트웨이" };
export function Arch(props: { label?: string; zones?: { id: string; label: string }[]; nodes: ArchNode[]; edges?: { from: string; to: string; label?: string; async?: boolean; em?: boolean }[]; dir?: "TB" | "LR" }) {
  const laid = createMemo(() => {
    const nodes = props.nodes.map((n) => {
      const w = Math.max(textW(cut(n.label, 26), FT, 600) + (archLogo(n) ? 23 : 0), n.note ? textW(cut(n.note, 30), FN, 400) : 0, textW(tr(KIND_TAG[n.kind ?? "service"] ?? ""), 11, 500) + chipW(n.state) * 2 + 8) + 32;
      const db = n.kind === "db" || n.kind === "cache";
      return { id: n.id, parent: n.zone, first: n.kind === "user", w: Math.max(120, w), h: (n.note ? 66 : 50) + (db ? 12 : 0) };
    });
    const es = (props.edges ?? []).map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label ?? (e.async ? tr("비동기") : undefined), end: "arrow", cls: edgeCls(e.async && "async", e.em && "em") }));
    const zones = (props.zones ?? []).map((z) => ({ id: z.id, label: z.label }));
    return fit((dir) => layTiers(nodes, es, zones, dir), props.dir, "LR");
  });
  const byId = createMemo(() => new Map(props.nodes.map((n) => [n.id, n])));
  return (
    <Frame
      label={props.label}
      cls="ch-arch"
      laid={laid()}
      em={props.nodes.some((n) => n.em) || (props.edges ?? []).some((e) => e.em)}
      clusterLabels={new Map((props.zones ?? []).map((z) => [z.id, z.label]))}
      node={(id, b) => {
        const n = byId().get(id)!;
        const k = n.kind ?? "service";
        const cx = b.x + b.w / 2;
        const cyl = k === "db" || k === "cache";
        const ty = b.y + (cyl ? 12 : 0);
        return (
          <g class={`ch-node k-${k} ${nodeCls(n.state, n.em)}`} classList={{ link: !!n.ref }} onClick={() => openRef(n.ref)}>
            <Show
              when={cyl}
              fallback={
                <Show when={k === "user"} fallback={<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={k === "function" ? 16 : 9} />}>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.h / 2, 22)} />
                </Show>
              }
            >
              <path d={`M${b.x},${b.y + 8} a${b.w / 2},8 0 0,0 ${b.w},0 a${b.w / 2},8 0 0,0 ${-b.w},0 v${b.h - 16} a${b.w / 2},8 0 0,0 ${b.w},0 v${-(b.h - 16)}`} />
            </Show>
            <Show when={k === "queue"}>
              <line x1={b.x + b.w - 14} y1={b.y + 6} x2={b.x + b.w - 14} y2={b.y + b.h - 6} class="ch-sub" />
              <line x1={b.x + b.w - 20} y1={b.y + 6} x2={b.x + b.w - 20} y2={b.y + b.h - 6} class="ch-sub" />
            </Show>
            <text x={cx} y={ty + 18} text-anchor="middle" class="ch-kind">{tr(KIND_TAG[k] ?? "")}</text>
            <Show when={archLogo(n)} fallback={<text x={cx} y={ty + 37} text-anchor="middle" class="ch-t strong">{cut(n.label, 26)}</text>}>
              {(lg) => {
                const lw = textW(cut(n.label, 26), FT, 600);
                const x0 = cx - (lw + 22) / 2;
                return (
                  <>
                    <svg x={x0} y={ty + 24} width={16} height={16} viewBox="0 0 24 24" class="ch-logo"><path d={lg().d} style={{ fill: lg().color }} /></svg>
                    <text x={x0 + 22} y={ty + 37} class="ch-t strong">{cut(n.label, 26)}</text>
                  </>
                );
              }}
            </Show>
            <Show when={n.note}><text x={cx} y={ty + 55} text-anchor="middle" class="ch-n">{cut(n.note!, 30)}</text></Show>
            <Chip s={n.state} b={b} />
          </g>
        );
      }}
    />
  );
}
