// Flow layouts: sankey / alluvial input clean-up (no cycles, merged duplicates),
// the sankey and alluvial geometry, chord matrices and arc-diagram ordering.
import { sankey, sankeyLinkHorizontal, type SankeyGraph } from "d3-sankey";
import { arr, isObj, toNum, toStr } from "./text";

export interface FNode { id: string; label: string; em?: boolean; group?: string; stage?: number; cat?: number }
export interface FLink { from: string; to: string; value: number; em?: boolean; note?: string }

/** links from {from,to,value} or {source,target,value}; duplicates merged, self-links dropped */
export function cleanLinks(raw: unknown): FLink[] {
  const m = new Map<string, FLink>();
  for (const l of arr(raw)) {
    if (!isObj(l)) continue;
    const from = toStr(l.from ?? l.source);
    const to = toStr(l.to ?? l.target);
    const value = toNum(l.value ?? l.weight ?? 1);
    if (!from || !to || from === to || value === undefined || value <= 0) continue;
    const k = `${from}\u0000${to}`;
    const prev = m.get(k);
    if (prev) (prev.value += value), (prev.em ||= !!l.em || !!l.highlight);
    else m.set(k, { from, to, value, em: !!(l.em || l.highlight), note: toStr(l.note) });
  }
  return [...m.values()];
}

/** drop the links that would close a cycle (smallest first loses), so a DAG remains */
export function acyclic(links: FLink[]): FLink[] {
  const out: FLink[] = [];
  const adj = new Map<string, Set<string>>();
  const reach = (a: string, b: string) => {
    const seen = new Set<string>();
    const st = [a];
    while (st.length) {
      const x = st.pop()!;
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of adj.get(x) ?? []) st.push(y);
    }
    return false;
  };
  const keep = new Set<FLink>();
  for (const l of [...links].sort((a, b) => b.value - a.value)) {
    if (reach(l.to, l.from)) continue;
    keep.add(l);
    if (!adj.has(l.from)) adj.set(l.from, new Set());
    adj.get(l.from)!.add(l.to);
  }
  for (const l of links) if (keep.has(l)) out.push(l);
  return out;
}

/** node list: given nodes first (for labels/order), then any id only seen in links */
export function cleanNodes(raw: unknown, links: { from: string; to: string }[]): FNode[] {
  const out = new Map<string, FNode>();
  for (const n of arr(raw)) {
    const id = isObj(n) ? toStr(n.id ?? n.label ?? n.name) : toStr(n);
    if (!id || out.has(id)) continue;
    out.set(id, { id, label: (isObj(n) && toStr(n.label ?? n.name)) || id, em: isObj(n) && !!(n.em || n.highlight), group: isObj(n) ? toStr(n.group) : undefined });
  }
  for (const l of links) for (const id of [l.from, l.to]) if (!out.has(id)) out.set(id, { id, label: id });
  return [...out.values()];
}

export interface SNode extends FNode { x0: number; x1: number; y0: number; y1: number; value: number; depth: number; color: number }
export interface SLink { from: SNode; to: SNode; value: number; width: number; path: string; em: boolean; color: number; note?: string; y0: number; y1: number; cat?: number }

/**
 * Sankey geometry inside w×h. `path` (a list of node ids) marks the highlighted route.
 * Colours: each first-column node gets a slot; every other node takes the slot of its
 * largest inflow, links take their source's slot.
 */
export function sankeyLayout(nodes: FNode[], links: (FLink & { cat?: number })[], w: number, h: number, opt: { path?: string[]; nodeWidth?: number; pad?: number; align?: (n: any) => number; sort?: (a: any, b: any) => number } = {}): { nodes: SNode[]; links: SLink[]; em: boolean } {
  const used = new Set(links.flatMap((l) => [l.from, l.to]));
  const ns = nodes.filter((n) => used.has(n.id)).map((n) => ({ ...n }));
  if (!ns.length) return { nodes: [], links: [], em: false };
  const idx = new Map(ns.map((n, i) => [n.id, i]));
  const ls = links.filter((l) => idx.has(l.from) && idx.has(l.to)).map((l) => ({ ...l, source: idx.get(l.from)!, target: idx.get(l.to)! }));
  const pathPairs = new Set<string>();
  const p = opt.path ?? [];
  for (let i = 0; i + 1 < p.length; i++) pathPairs.add(`${p[i]}\u0000${p[i + 1]}`);
  const gen = sankey<any, any>()
    .nodeWidth(opt.nodeWidth ?? 10)
    .nodePadding(opt.pad ?? 10)
    .extent([[0, 0], [Math.max(10, w), Math.max(10, h)]]);
  if (opt.align) gen.nodeAlign(opt.align);
  if (opt.sort) gen.nodeSort(opt.sort);
  // keep the padding from squeezing nodes to nothing when there are many per column
  const g: SankeyGraph<any, any> = gen({ nodes: ns, links: ls });
  const pathGen = sankeyLinkHorizontal();
  const out = g.nodes as any[];
  const emAny = ls.some((l) => l.em) || pathPairs.size > 0 || ns.some((n) => n.em);
  // colours: first column by order, the rest from the largest inflow
  let slot = 0;
  for (const n of [...out].sort((a, b) => a.depth - b.depth || a.y0 - b.y0)) {
    if (!n.targetLinks?.length) n.color = slot++;
    else n.color = [...n.targetLinks].sort((a: any, b: any) => b.value - a.value)[0].source.color;
  }
  const sl: SLink[] = (g.links as any[]).map((l) => ({
    from: l.source,
    to: l.target,
    value: l.value,
    width: Math.max(1, l.width),
    path: pathGen(l) ?? "",
    em: !!l.em || pathPairs.has(`${l.source.id}\u0000${l.target.id}`),
    color: l.source.color,
    note: l.note,
    cat: l.cat,
    y0: l.y0,
    y1: l.y1,
  }));
  const onPath = new Set(p);
  for (const n of out) n.em = !!n.em || onPath.has(n.id) || sl.some((l) => l.em && (l.from === n || l.to === n));
  return { nodes: out as SNode[], links: sl, em: emAny };
}

/**
 * Alluvial input: `stages` (column names) and `items: {path: [category per stage], value}`.
 * Becomes a sankey whose node ids are "stage␀category", ordered the same way in every column.
 */
export function alluvialGraph(stagesRaw: unknown, itemsRaw: unknown): { stages: string[]; cats: string[]; nodes: FNode[]; links: (FLink & { cat: number })[] } {
  const items = arr(itemsRaw)
    .filter(isObj)
    .map((i) => ({ path: arr(i.path ?? i.items).map(toStr), value: toNum(i.value) ?? 0, em: !!(i.em || i.highlight) }))
    .filter((i) => i.value > 0 && i.path.length >= 2);
  const n = Math.max(0, ...items.map((i) => i.path.length));
  const given = arr(stagesRaw).map(toStr);
  const stages = Array.from({ length: n }, (_, k) => given[k] ?? `${k + 1}`);
  const cats: string[] = [];
  for (let k = 0; k < n; k++) for (const i of items) { const c = i.path[k]; if (c && !cats.includes(c)) cats.push(c); }
  const id = (k: number, c: string) => `${k}\u0000${c}`;
  const nodes: FNode[] = [];
  const seen = new Set<string>();
  const m = new Map<string, FLink & { cat: number }>();
  for (const i of items) {
    const origin = i.path.find(Boolean);
    const cat = origin ? cats.indexOf(origin) : 0;
    for (let k = 0; k + 1 < i.path.length; k++) {
      const a = i.path[k];
      const b = i.path[k + 1];
      if (!a || !b) continue;
      for (const [kk, c] of [[k, a], [k + 1, b]] as const) {
        const nid = id(kk, c);
        if (!seen.has(nid)) (seen.add(nid), nodes.push({ id: nid, label: c, stage: kk, cat: cats.indexOf(c) }));
      }
      const key = `${id(k, a)}\u0000${id(k + 1, b)}\u0000${cat}`;
      const prev = m.get(key);
      if (prev) prev.value += i.value;
      else m.set(key, { from: id(k, a), to: id(k + 1, b), value: i.value, em: i.em, cat });
    }
  }
  return { stages, cats, nodes, links: [...m.values()] };
}

/** a square matrix from links (or a given matrix), with names in a stable order */
export function chordMatrix(b: { names?: unknown; matrix?: unknown; links?: unknown; items?: unknown }): { names: string[]; matrix: number[][] } {
  const names = arr(b.names ?? (Array.isArray(b.matrix) ? b.items : undefined)).map((x) => (isObj(x) ? toStr(x.label ?? x.id) : toStr(x))).filter(Boolean) as string[];
  if (Array.isArray(b.matrix) && b.matrix.length) {
    const n = b.matrix.length;
    const nm = Array.from({ length: n }, (_, i) => names[i] ?? `${i + 1}`);
    const mat = nm.map((_, i) => nm.map((_, j) => Math.max(0, toNum((b.matrix as any[])[i]?.[j]) ?? 0)));
    return { names: nm, matrix: mat };
  }
  const links = cleanLinks(b.links ?? b.items);
  const nm = [...names];
  for (const l of links) for (const id of [l.from, l.to]) if (!nm.includes(id)) nm.push(id);
  const mat = nm.map(() => nm.map(() => 0));
  for (const l of links) mat[nm.indexOf(l.from)][nm.indexOf(l.to)] += l.value;
  return { names: nm, matrix: mat };
}

/** arc-diagram order: grouped (first-seen group order), then by the given order */
export function arcOrder(nodes: FNode[]): FNode[] {
  const groups: (string | undefined)[] = [];
  for (const n of nodes) if (!groups.includes(n.group)) groups.push(n.group);
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => groups.indexOf(a.n.group) - groups.indexOf(b.n.group) || a.i - b.i).map((x) => x.n);
}
