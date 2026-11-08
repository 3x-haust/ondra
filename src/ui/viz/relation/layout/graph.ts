// Network layouts: a force layout run to rest (no animation), cluster ordering for
// the adjacency matrix, the hierarchy behind edge bundling, and ego rings.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { arr, isObj, toNum, toStr } from "./text";

export interface GNode { id: string; label: string; group?: string; value?: number; em?: boolean; note?: string }
export interface GLink { from: string; to: string; value: number; em?: boolean; label?: string }
export interface Graph { nodes: GNode[]; links: GLink[]; groups: string[]; directed: boolean }

/** nodes + links, forgiving: ids from either side, unknown ends become nodes, duplicates merge (undirected) */
export function cleanGraph(b: { nodes?: unknown; links?: unknown; edges?: unknown; directed?: unknown }): Graph {
  const nodes = new Map<string, GNode>();
  for (const n of arr(b.nodes)) {
    const id = isObj(n) ? toStr(n.id ?? n.label ?? n.name) : toStr(n);
    if (!id || nodes.has(id)) continue;
    nodes.set(id, isObj(n) ? { id, label: toStr(n.label ?? n.name) ?? id, group: toStr(n.group), value: toNum(n.value), em: !!(n.em || n.highlight), note: toStr(n.note) } : { id, label: id });
  }
  const directed = !!b.directed;
  const links = new Map<string, GLink>();
  for (const l of arr(b.links ?? b.edges)) {
    if (!isObj(l)) continue;
    const from = toStr(l.from ?? l.source);
    const to = toStr(l.to ?? l.target);
    if (!from || !to || from === to) continue;
    const value = Math.max(0, toNum(l.value ?? l.weight) ?? 1);
    for (const id of [from, to]) if (!nodes.has(id)) nodes.set(id, { id, label: id });
    const k = directed || from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    const p = links.get(k);
    if (p) (p.value += value), (p.em ||= !!(l.em || l.highlight));
    else links.set(k, { from, to, value, em: !!(l.em || l.highlight), label: toStr(l.label) });
  }
  const groups: string[] = [];
  for (const n of nodes.values()) if (n.group && !groups.includes(n.group)) groups.push(n.group);
  return { nodes: [...nodes.values()], links: [...links.values()], groups, directed };
}

export function degrees(g: Graph): Map<string, number> {
  const d = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const l of g.links) (d.set(l.from, (d.get(l.from) ?? 0) + l.value), d.set(l.to, (d.get(l.to) ?? 0) + l.value));
  return d;
}

export interface Placed extends GNode { x: number; y: number; r: number; deg: number }

/**
 * Force layout computed to rest and fitted into w×h (minus `pad`). Same input → same
 * picture: the start positions are a phyllotaxis and d3-force's jiggle is seeded.
 */
export function forceLayout(g: Graph, w: number, h: number, opt: { pad?: number; rmin?: number; rmax?: number } = {}): Placed[] {
  const pad = opt.pad ?? 24;
  const deg = degrees(g);
  const size = (n: GNode) => n.value ?? deg.get(n.id) ?? 1;
  const smax = Math.max(1e-9, ...g.nodes.map(size));
  const rmin = opt.rmin ?? 4;
  const rmax = opt.rmax ?? 11;
  const groups = g.groups;
  // cluster anchors on a circle so groups sit apart
  const anchor = (n: GNode) => {
    const k = n.group ? groups.indexOf(n.group) : -1;
    if (k < 0 || groups.length < 2) return { x: 0, y: 0 };
    const a = (k / groups.length) * Math.PI * 2;
    return { x: Math.cos(a) * 120, y: Math.sin(a) * 120 };
  };
  const ns: any[] = g.nodes.map((n, i) => {
    const r = 6 * Math.sqrt(i + 0.5);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    const an = anchor(n);
    return { ...n, x: an.x + r * Math.cos(a), y: an.y + r * Math.sin(a), r: rmin + (rmax - rmin) * Math.sqrt(size(n) / smax), deg: deg.get(n.id) ?? 0 };
  });
  const byId = new Map(ns.map((n) => [n.id, n]));
  const vmax = Math.max(1e-9, ...g.links.map((l) => l.value));
  const ls = g.links.filter((l) => byId.has(l.from) && byId.has(l.to)).map((l) => ({ source: l.from, target: l.to, value: l.value }));
  const sim = forceSimulation(ns)
    .randomSource(lcg(7))
    .force("link", forceLink(ls).id((d: any) => d.id).distance((l: any) => (l.source.group && l.source.group === l.target.group ? 30 : 60)).strength((l: any) => 0.25 + 0.6 * (l.value / vmax)))
    .force("charge", forceManyBody().strength(-90).distanceMax(400))
    .force("x", forceX((d: any) => anchor(d).x).strength(groups.length > 1 ? 0.08 : 0.04))
    .force("y", forceY((d: any) => anchor(d).y).strength(groups.length > 1 ? 0.08 : 0.04))
    .force("collide", forceCollide((d: any) => d.r + 3))
    .stop();
  const n = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
  for (let i = 0; i < n; i++) sim.tick();
  return fitPoints(ns, w, h, pad);
}

/** scale points (keeping aspect) into the box */
export function fitPoints<T extends { x: number; y: number }>(ps: T[], w: number, h: number, pad: number): T[] {
  if (!ps.length) return ps;
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((w - 2 * pad) / Math.max(1e-9, x1 - x0), (h - 2 * pad) / Math.max(1e-9, y1 - y0), 3);
  const ox = (w - (x1 - x0) * s) / 2;
  const oy = (h - (y1 - y0) * s) / 2;
  return ps.map((p) => ({ ...p, x: ox + (p.x - x0) * s, y: oy + (p.y - y0) * s }));
}

function lcg(seed: number) {
  let s = seed;
  return () => ((s = (1664525 * s + 1013904223) % 4294967296) / 4294967296);
}

/** matrix order: by group (largest group first), inside a group by degree */
export function matrixOrder(g: Graph): GNode[] {
  const deg = degrees(g);
  const gsize = new Map<string, number>();
  for (const n of g.nodes) gsize.set(n.group ?? "", (gsize.get(n.group ?? "") ?? 0) + (deg.get(n.id) ?? 0));
  return [...g.nodes].sort((a, b) => {
    const ga = a.group ?? "";
    const gb = b.group ?? "";
    if (ga !== gb) return (gsize.get(gb) ?? 0) - (gsize.get(ga) ?? 0) || (ga < gb ? -1 : 1);
    return (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0);
  });
}

/** the two-level hierarchy (root → group → node) that edge bundling routes through */
export function bundleTree(g: Graph): { name: string; children: { name: string; children: { name: string; id: string }[] }[] } {
  const groups = new Map<string, { name: string; id: string }[]>();
  for (const n of g.nodes) {
    const k = n.group ?? "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push({ name: n.label, id: n.id });
  }
  return { name: "", children: [...groups.entries()].map(([name, children]) => ({ name, children })) };
}

export interface EgoNode extends GNode { ring: number; angle: number; parent?: string; deg: number }

/**
 * Ego network: the centre, its neighbours (ring 1) and, if `depth` is 2, their other
 * neighbours (ring 2) placed in the angular sector of the ring-1 node that reaches them.
 */
export function egoLayout(g: Graph, center: string | undefined, depth = 2): { center: GNode | undefined; nodes: EgoNode[]; links: GLink[] } {
  const deg = degrees(g);
  const c = g.nodes.find((n) => n.id === center || n.label === center) ?? [...g.nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0))[0];
  if (!c) return { center: undefined, nodes: [], links: [] };
  const nb = new Map<string, Map<string, number>>();
  for (const l of g.links) {
    for (const [a, b] of [[l.from, l.to], [l.to, l.from]]) {
      if (!nb.has(a)) nb.set(a, new Map());
      nb.get(a)!.set(b, (nb.get(a)!.get(b) ?? 0) + l.value);
    }
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ring1 = [...(nb.get(c.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const ring = new Map<string, number>([[c.id, 0]]);
  for (const id of ring1) ring.set(id, 1);
  const parentOf = new Map<string, string>();
  if (depth >= 2) {
    for (const p of ring1) {
      for (const [id] of [...(nb.get(p)?.entries() ?? [])].sort((a, b) => b[1] - a[1])) {
        if (!ring.has(id)) (ring.set(id, 2), parentOf.set(id, p));
      }
    }
  }
  // ring-1 sectors sized by how many ring-2 nodes they carry
  const kids = new Map(ring1.map((id) => [id, [...parentOf.entries()].filter(([, p]) => p === id).map(([k]) => k)]));
  const weight = (id: string) => 1 + (kids.get(id)?.length ?? 0) * 0.8;
  const total = ring1.reduce((s, id) => s + weight(id), 0) || 1;
  const nodes: EgoNode[] = [{ ...c, ring: 0, angle: 0, deg: deg.get(c.id) ?? 0 }];
  let a = -Math.PI / 2;
  for (const id of ring1) {
    const span = (weight(id) / total) * Math.PI * 2;
    nodes.push({ ...byId.get(id)!, ring: 1, angle: a + span / 2, deg: deg.get(id) ?? 0 });
    const ks = kids.get(id) ?? [];
    ks.forEach((k, i) => nodes.push({ ...byId.get(k)!, ring: 2, angle: a + (span * (i + 0.5)) / ks.length, parent: id, deg: deg.get(k) ?? 0 }));
    a += span;
  }
  const inSet = new Set(nodes.map((n) => n.id));
  return { center: c, nodes, links: g.links.filter((l) => inSet.has(l.from) && inSet.has(l.to)) };
}
