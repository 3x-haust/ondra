// Hierarchies: one forgiving input (nested children, "a/b/c" paths, or id + parent)
// turned into a d3 hierarchy, plus the mind-map balancing and the org-chart layout.
import { hierarchy, type HierarchyNode } from "d3-hierarchy";
import { arr, isObj, toNum, toStr } from "./text";

export interface TNode { name: string; value?: number; note?: string; em?: boolean; role?: string; height?: number; children?: TNode[] }

const nodeOf = (o: Record<string, any>, name: string): TNode => ({
  name,
  value: toNum(o.value),
  note: toStr(o.note),
  em: !!(o.em || o.highlight),
  role: toStr(o.role ?? o.title),
  height: toNum(o.height),
});

function nested(list: unknown[], depth = 0): TNode[] {
  if (depth > 12) return [];
  const out: TNode[] = [];
  for (const it of list) {
    if (typeof it === "string" || typeof it === "number") { out.push({ name: String(it) }); continue; }
    if (!isObj(it)) continue;
    const name = toStr(it.label ?? it.name ?? it.id);
    if (!name) continue;
    const n = nodeOf(it, name);
    const kids = nested(arr(it.children ?? it.items), depth + 1);
    if (kids.length) n.children = kids;
    out.push(n);
  }
  return out;
}

/**
 * The tree behind every hierarchy kind. Accepts:
 *  - `root: {label, children: [...]}` or `items: [{label, value?, children?}]`
 *  - `items: [{path: "A/B/C" | ["A","B","C"], value}]`
 *  - `items: [{id, parent?, label?, value?}]`
 * Several tops get a shared root named `rootLabel` (default "전체").
 */
export function toTree(b: { root?: unknown; items?: unknown }, rootLabel?: string): TNode {
  const top = toStr(rootLabel) ?? "전체";
  if (isObj(b.root)) {
    const r = nested([b.root])[0];
    if (r) return r;
  }
  const items = arr(b.items).filter((x) => isObj(x) || typeof x === "string");
  const hasPath = items.some((i) => isObj(i) && (typeof i.path === "string" || Array.isArray(i.path)));
  const hasParent = items.some((i) => isObj(i) && i.parent != null);
  let tops: TNode[];
  if (hasPath) tops = fromPaths(items.filter(isObj));
  else if (hasParent) tops = fromParents(items.filter(isObj));
  else tops = nested(items);
  if (tops.length === 1 && tops[0].children?.length) return tops[0];
  return { name: top, children: tops };
}

function fromPaths(items: Record<string, any>[]): TNode[] {
  const root: TNode = { name: "", children: [] };
  for (const it of items) {
    const parts = (Array.isArray(it.path) ? it.path.map(toStr) : String(it.path ?? "").split(/\s*[/>›]\s*/)).filter(Boolean) as string[];
    if (!parts.length) continue;
    let cur = root;
    parts.forEach((p, i) => {
      cur.children ??= [];
      let nx = cur.children.find((c) => c.name === p);
      if (!nx) cur.children.push((nx = { name: p }));
      if (i === parts.length - 1) Object.assign(nx, { ...nodeOf(it, p), children: nx.children });
      cur = nx;
    });
  }
  return root.children ?? [];
}

function fromParents(items: Record<string, any>[]): TNode[] {
  const byId = new Map<string, TNode & { _p?: string }>();
  for (const it of items) {
    const id = toStr(it.id ?? it.label ?? it.name);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...nodeOf(it, toStr(it.label ?? it.name) ?? id), _p: toStr(it.parent) });
  }
  const tops: TNode[] = [];
  for (const [id, n] of byId) {
    let p = n._p && byId.get(n._p);
    // a parent loop (a → b → a) is cut where it closes
    for (let q = p, k = 0; q && k < 64; q = q._p ? byId.get(q._p) : undefined, k++) if (q === n) p = undefined;
    if (p && n._p !== id) (p.children ??= []).push(n);
    else tops.push(n);
    delete n._p;
  }
  return tops;
}

/** a d3 hierarchy summed by value (leaves without a value count as 1 when nothing has values) */
export function sized(t: TNode): HierarchyNode<TNode> {
  const h = hierarchy(t, (d) => d.children);
  const any = h.leaves().some((l) => (l.data.value ?? 0) > 0);
  return h.sum((d) => (d.children?.length ? 0 : any ? Math.max(0, d.value ?? 0) : 1)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

/** the top-level branch index of a node (for colour), -1 for the root */
export function branchOf(n: HierarchyNode<any>): number {
  let c = n;
  while (c.parent && c.parent.parent) c = c.parent;
  return c.parent ? c.parent.children!.indexOf(c) : -1;
}

/**
 * Split a mind map's branches into right and left, keeping their order around the
 * centre (clockwise from the top right), so both sides carry about the same number
 * of leaves.
 */
export function balance(sizes: number[]): { right: number[]; left: number[] } {
  const total = sizes.reduce((a, b) => a + b, 0);
  let best = 0;
  let bestD = Infinity;
  let acc = 0;
  for (let k = 0; k <= sizes.length; k++) {
    const d = Math.abs(total - 2 * acc);
    if (d < bestD && (k > 0 || sizes.length === 0)) (bestD = d), (best = k);
    acc += sizes[k] ?? 0;
  }
  if (sizes.length >= 2 && best === sizes.length) best = sizes.length - 1;
  const idx = sizes.map((_, i) => i);
  return { right: idx.slice(0, best), left: idx.slice(best).reverse() };
}

export interface OrgBox { id: string; node: TNode; x: number; y: number; depth: number; hidden: number; kids: string[]; stacked: boolean }

/**
 * Org chart: top-down, a parent centred over its children; a parent whose children
 * are all leaves stacks them in one column under it (compact form), so wide teams
 * don't blow the width. `open` says which ids are expanded; `depth` is the
 * default number of levels shown. Units: one box is 1 wide and 1 tall.
 */
export function orgLayout(root: TNode, open: (id: string, depth: number) => boolean, stack = true): { boxes: OrgBox[]; links: [string, string][]; cols: number; rows: number } {
  const boxes: OrgBox[] = [];
  const links: [string, string][] = [];
  const GAP = 0.25; // horizontal gap between columns, in box widths
  const VG = 0.55; // vertical gap between levels, in box heights
  const SG = 0.22; // gap between stacked boxes
  const ROW = 1 + VG;
  let maxY = 0;
  // returns the width used by this subtree, placing boxes from x
  const place = (n: TNode, id: string, depth: number, x: number, y: number): number => {
    const kids = n.children ?? [];
    const isOpen = kids.length > 0 && open(id, depth);
    const box: OrgBox = { id, node: n, x, y, depth, hidden: isOpen ? 0 : countAll(n), kids: [], stacked: false };
    boxes.push(box);
    maxY = Math.max(maxY, y + 1);
    if (!isOpen) return 1;
    const ids = kids.map((_, i) => `${id}.${i}`);
    box.kids = ids;
    const allLeaves = kids.every((k, i) => !k.children?.length || !open(ids[i], depth + 1));
    if (stack && allLeaves && kids.length > 1) {
      // stacked under the parent, indented a little
      box.stacked = true;
      kids.forEach((k, i) => {
        const yy = y + ROW + i * (1 + SG);
        boxes.push({ id: ids[i], node: k, x: x + 0.12, y: yy, depth: depth + 1, hidden: countAll(k), kids: [], stacked: false });
        links.push([id, ids[i]]);
        maxY = Math.max(maxY, yy + 1);
      });
      return 1.12;
    }
    let cx = x;
    const starts: number[] = [];
    kids.forEach((k, i) => {
      starts.push(cx);
      cx += place(k, ids[i], depth + 1, cx, y + ROW) + GAP;
      links.push([id, ids[i]]);
    });
    const width = cx - GAP - x;
    // centre the parent over its first and last child boxes
    const first = boxes.find((b) => b.id === ids[0])!;
    const last = boxes.find((b) => b.id === ids[ids.length - 1])!;
    box.x = (first.x + last.x) / 2;
    return Math.max(1, width);
  };
  const cols = place(root, "0", 0, 0, 0);
  return { boxes, links, cols, rows: maxY };
}

export function countAll(n: TNode): number {
  return (n.children ?? []).reduce((s, c) => s + 1 + countAll(c), 0);
}

/** narrow org chart: one box per row, children indented under their parent (x = depth) */
export function orgIndented(root: TNode, open: (id: string, depth: number) => boolean): { boxes: OrgBox[]; links: [string, string][]; rows: number } {
  const boxes: OrgBox[] = [];
  const links: [string, string][] = [];
  const walk = (n: TNode, id: string, depth: number) => {
    const kids = n.children ?? [];
    const isOpen = kids.length > 0 && open(id, depth);
    boxes.push({ id, node: n, x: depth, y: boxes.length, depth, hidden: isOpen ? 0 : countAll(n), kids: [], stacked: false });
    if (!isOpen) return;
    kids.forEach((k, i) => {
      links.push([id, `${id}.${i}`]);
      walk(k, `${id}.${i}`, depth + 1);
    });
  };
  walk(root, "0", 0);
  return { boxes, links, rows: boxes.length };
}
