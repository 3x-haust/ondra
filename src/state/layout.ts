// The center as a tree of panes (Ghostty's split tree): each split holds two
// children side by side ("row") or stacked ("col") at a ratio. Pure functions
// only; the app keeps one Layout per space (src/state/panes.ts).

export type Axis = "row" | "col";
export type Dir = "left" | "right" | "up" | "down";
export type Leaf = { id: string; pane: string };
export type Split = { id: string; axis: Axis; ratio: number; a: Node; b: Node };
export type Node = Leaf | Split;
export interface Rect { x: number; y: number; w: number; h: number }
export interface Layout<P> {
  root: Node;
  panes: Record<string, P>;
  focus: string;
  /** the pane that fills the area, if any */
  zoom: string | null;
}
/** what the area measures and how small a pane may get */
export interface Room { w: number; h: number; gap: number; minW: number; minH: number }

export const isLeaf = (n: Node): n is Leaf => "pane" in n;
const axisOf = (d: Dir): Axis => (d === "left" || d === "right" ? "row" : "col");

let seq = 0;
const nid = () => `n${Date.now().toString(36)}${(++seq).toString(36)}`;

export function single<P>(id: string, p: P): Layout<P> {
  return { root: { id: nid(), pane: id }, panes: { [id]: p }, focus: id, zoom: null };
}

/** pane ids in reading order (left before right, top before bottom) */
export function leaves(n: Node): string[] {
  return isLeaf(n) ? [n.pane] : [...leaves(n.a), ...leaves(n.b)];
}

/** Each node through `f` (a replaced node isn't walked into; a changed split's children still are). */
function map(n: Node, f: (n: Node) => Node | null): Node | null {
  const m = f(n);
  if (!m || isLeaf(m) || (m !== n && m.id !== n.id)) return m;
  const a = map(m.a, f);
  const b = map(m.b, f);
  if (!a) return b;
  if (!b) return a;
  return a === m.a && b === m.b ? m : { ...m, a, b };
}

/** The path of splits from the root down to a pane (closest last). */
function pathTo(n: Node, pane: string, out: Split[] = []): Split[] | null {
  if (isLeaf(n)) return n.pane === pane ? out : null;
  return pathTo(n.a, pane, [...out, n]) ?? pathTo(n.b, pane, [...out, n]);
}

/** A new pane beside `target`, on the `dir` side; it takes the focus. */
export function split<P>(l: Layout<P>, target: string, dir: Dir, id: string, p: P): Layout<P> {
  if (!l.panes[target] || l.panes[id]) return l;
  const fresh: Leaf = { id: nid(), pane: id };
  const first = dir === "left" || dir === "up";
  const root = map(l.root, (n) =>
    isLeaf(n) && n.pane === target ? { id: nid(), axis: axisOf(dir), ratio: 0.5, a: first ? fresh : n, b: first ? n : fresh } : n,
  )!;
  return { root, panes: { ...l.panes, [id]: p }, focus: id, zoom: null };
}

/** The pane gone; its neighbour takes its room (and the focus, if it had it). The last pane stays. */
export function remove<P>(l: Layout<P>, id: string): Layout<P> {
  if (!l.panes[id] || leaves(l.root).length < 2) return l;
  const path = pathTo(l.root, id)!;
  const parent = path[path.length - 1];
  const wasA = isLeaf(parent.a) && parent.a.pane === id;
  const sibling = wasA ? parent.b : parent.a;
  // the pane next to where it was: the sibling's leaf on the side that touched it
  let next: Node = sibling;
  while (!isLeaf(next)) next = wasA ? next.a : next.b;
  const root = map(l.root, (n) => (n === parent ? sibling : n))!;
  const { [id]: _, ...panes } = l.panes;
  return { root, panes, focus: l.focus === id ? next.pane : l.focus, zoom: l.zoom === id ? null : l.zoom };
}

/** Focus a pane. A zoomed layout stays zoomed, on the pane you moved to. */
export function focus<P>(l: Layout<P>, id: string): Layout<P> {
  if (!l.panes[id] || (l.focus === id && (!l.zoom || l.zoom === id))) return l;
  return { ...l, focus: id, zoom: l.zoom ? id : null };
}

export function toggleZoom<P>(l: Layout<P>): Layout<P> {
  if (l.zoom) return { ...l, zoom: null };
  return leaves(l.root).length > 1 ? { ...l, zoom: l.focus } : l;
}

/** Rectangles of every pane and split in a unit square (or `room`, with its gaps and minimum sizes). */
export function rects(root: Node, room?: Room): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const gap = room?.gap ?? 0;
  const walk = (n: Node, r: Rect) => {
    if (isLeaf(n)) return void out.set(n.pane, r);
    out.set(n.id, r);
    const ext = n.axis === "row" ? r.w : r.h;
    const k = room ? clampRatio(n, n.ratio, ext, room) : n.ratio;
    const first = (ext - gap) * k;
    if (n.axis === "row") {
      walk(n.a, { x: r.x, y: r.y, w: first, h: r.h });
      walk(n.b, { x: r.x + first + gap, y: r.y, w: ext - gap - first, h: r.h });
    } else {
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: first });
      walk(n.b, { x: r.x, y: r.y + first + gap, w: r.w, h: ext - gap - first });
    }
  };
  walk(root, room ? { x: 0, y: 0, w: room.w, h: room.h } : { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

/** The least a subtree needs along an axis. */
export function minSize(n: Node, axis: Axis, room: Room): number {
  const leaf = axis === "row" ? room.minW : room.minH;
  if (isLeaf(n)) return leaf;
  const a = minSize(n.a, axis, room);
  const b = minSize(n.b, axis, room);
  return n.axis === axis ? a + b + room.gap : Math.max(a, b);
}

/** A split's ratio kept where both sides get their minimum (shared fairly when they can't). */
export function clampRatio(n: Split, ratio: number, ext: number, room: Room): number {
  const avail = ext - room.gap;
  const minA = minSize(n.a, n.axis, room);
  const minB = minSize(n.b, n.axis, room);
  if (avail <= 0) return 0.5;
  const lo = minA / avail;
  const hi = 1 - minB / avail;
  if (lo > hi) return minA / (minA + minB);
  return Math.min(hi, Math.max(lo, ratio));
}

/** Every pane gets at least its minimum size in this room. */
export function fits(root: Node, room: Room): boolean {
  return minSize(root, "row", room) <= room.w + 0.5 && minSize(root, "col", room) <= room.h + 0.5;
}

/** Splitting `target` toward `dir` leaves every pane its minimum. */
export function canSplit<P>(l: Layout<P>, target: string, dir: Dir, room: Room): boolean {
  return fits(split(l, target, dir, "\u0000probe", undefined as P).root, room);
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

/** The pane `dir` of `from`, nearest on screen; past the edge it wraps around (Ghostty's goto_split). */
export function neighbour(root: Node, from: string, dir: Dir): string | null {
  const all = rects(root);
  const ids = leaves(root);
  const f = all.get(from);
  if (!f || ids.length < 2) return null;
  const eps = 1e-6;
  const find = (r: Rect): string | null => {
    let best: { id: string; d: number; o: number; c: number } | null = null;
    for (const id of ids) {
      if (id === from) continue;
      const c = all.get(id)!;
      let d: number, o: number, cd: number;
      if (dir === "right" || dir === "left") {
        d = dir === "right" ? c.x - (r.x + r.w) : r.x - (c.x + c.w);
        o = overlap(r.y, r.y + r.h, c.y, c.y + c.h);
        cd = Math.abs(c.y + c.h / 2 - (r.y + r.h / 2));
      } else {
        d = dir === "down" ? c.y - (r.y + r.h) : r.y - (c.y + c.h);
        o = overlap(r.x, r.x + r.w, c.x, c.x + c.w);
        cd = Math.abs(c.x + c.w / 2 - (r.x + r.w / 2));
      }
      if (d < -eps || o <= eps) continue;
      if (!best || d < best.d - eps || (Math.abs(d - best.d) <= eps && cd < best.c)) best = { id, d, o, c: cd };
    }
    return best?.id ?? null;
  };
  const near = find(f);
  if (near) return near;
  // wrap: look again from just past the opposite edge
  const shift = { left: { x: f.x + 1 }, right: { x: f.x - 1 }, up: { y: f.y + 1 }, down: { y: f.y - 1 } }[dir];
  return find({ ...f, ...shift });
}

/** previous / next in reading order, wrapping around */
export function step(root: Node, from: string, by: -1 | 1): string | null {
  const ids = leaves(root);
  const i = ids.indexOf(from);
  if (ids.length < 2 || i < 0) return null;
  return ids[(i + by + ids.length) % ids.length];
}

/** Move the divider nearest to the pane on that axis by `px` (right/down grow the first side), as Ghostty's resize_split. */
export function resize<P>(l: Layout<P>, pane: string, dir: Dir, px: number, room: Room): Layout<P> {
  const axis = axisOf(dir);
  const path = pathTo(l.root, pane);
  const s = path && [...path].reverse().find((n) => n.axis === axis);
  if (!s) return l;
  const r = rects(l.root, room).get(s.id)!;
  const ext = axis === "row" ? r.w : r.h;
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  const now = clampRatio(s, s.ratio, ext, room);
  return setRatio(l, s.id, now + (sign * px) / Math.max(1, ext - room.gap), room);
}

/** A split's ratio (dragging its divider), kept to what fits. */
export function setRatio<P>(l: Layout<P>, splitId: string, ratio: number, room?: Room): Layout<P> {
  const s = findSplit(l.root, splitId);
  if (!s) return l;
  const r = room && rects(l.root, room).get(splitId);
  const ext = r ? (s.axis === "row" ? r.w : r.h) : 0;
  const root = map(l.root, (n) => {
    if (isLeaf(n) || n.id !== splitId) return n;
    const k = room && r ? clampRatio(n, ratio, ext, room) : Math.min(0.95, Math.max(0.05, ratio));
    return Math.abs(k - n.ratio) < 1e-9 ? n : { ...n, ratio: k };
  })!;
  return root === l.root ? l : { ...l, root };
}

export function findSplit(n: Node, id: string): Split | null {
  if (isLeaf(n)) return null;
  if (n.id === id) return n;
  return findSplit(n.a, id) ?? findSplit(n.b, id);
}

/** How many panes a subtree lines up along an axis (Ghostty's equalize weight). */
function weight(n: Node, axis: Axis): number {
  if (isLeaf(n)) return 1;
  return n.axis === axis ? weight(n.a, axis) + weight(n.b, axis) : 1;
}

/** Every split at the share its panes give it, so panes in a line come out the same size. `only`: one split. */
export function equalize<P>(l: Layout<P>, only?: string): Layout<P> {
  const root = map(l.root, (n) => {
    if (isLeaf(n) || (only && n.id !== only)) return n;
    const a = weight(n.a, n.axis);
    const k = a / (a + weight(n.b, n.axis));
    return Math.abs(k - n.ratio) < 1e-9 ? n : { ...n, ratio: k };
  })!;
  return root === l.root ? l : { ...l, root };
}

/** Panes that fail `keep` (a task deleted meanwhile) left out; null when none is left. */
export function prune<P>(l: Layout<P>, keep: (p: P, id: string) => boolean): Layout<P> | null {
  const gone = new Set(Object.keys(l.panes).filter((id) => !keep(l.panes[id], id)));
  if (!gone.size) return l;
  const root = map(l.root, (n) => (isLeaf(n) && gone.has(n.pane) ? null : n));
  if (!root) return null;
  const panes = Object.fromEntries(Object.entries(l.panes).filter(([id]) => !gone.has(id)));
  const ids = leaves(root);
  return { root, panes, focus: gone.has(l.focus) ? ids[0] : l.focus, zoom: l.zoom && !gone.has(l.zoom) ? l.zoom : null };
}

/** A layout read back from storage, or null when it doesn't hold together. */
export function parse<P>(raw: unknown, pane: (x: unknown) => P | null): Layout<P> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Layout<unknown>>;
  const panes: Record<string, P> = {};
  const used = new Set<string>();
  const node = (x: unknown): Node | null => {
    if (!x || typeof x !== "object") return null;
    const n = x as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : nid();
    if (typeof n.pane === "string") {
      if (used.has(n.pane)) return null;
      const p = pane((r.panes as Record<string, unknown> | undefined)?.[n.pane]);
      if (!p) return null;
      used.add(n.pane);
      panes[n.pane] = p;
      return { id, pane: n.pane };
    }
    if (n.axis !== "row" && n.axis !== "col") return null;
    const a = node(n.a);
    const b = node(n.b);
    if (!a || !b) return a ?? b;
    const ratio = typeof n.ratio === "number" && n.ratio > 0 && n.ratio < 1 ? n.ratio : 0.5;
    return { id, axis: n.axis, ratio, a, b };
  };
  const root = node(r.root);
  if (!root) return null;
  const ids = leaves(root);
  const f = typeof r.focus === "string" && ids.includes(r.focus) ? r.focus : ids[0];
  return { root, panes, focus: f, zoom: typeof r.zoom === "string" && ids.includes(r.zoom) ? r.zoom : null };
}
