// The memory as folders, the same shape the Obsidian mirror writes to disk:
//   모든 일/ · <공간>/ · <공간>/<프로젝트>/      ← homes (where a piece applies)
//     규칙/ 취향/ 결정/ 사실/ 방법/ 배운 점/      ← one folder per kind
//     주제/<도구·서비스>/                         ← things two or more pieces are about
//     지난 기억/                                  ← replaced or retired
//     AGENTS.md                                   ← instruction files the engine reads
//     지금                                        ← (projects) what was last going on
//   일 기록/<월>/<일>/                            ← one entry per finished job
// and the graph drawn from it: the structure by default (hubs sized by count),
// or the local neighbourhood of what's selected, like Obsidian's local graph.
import { isLive, KINDS, kindLabel, kindOf } from "../engine/memory";
import type { JournalEntry, Memory, MemoryKind, Project, ProjectNow, SpaceId } from "../state/types";

export type HomeKind = "global" | "space" | "project";
export interface Home {
  id: string;
  kind: HomeKind;
  label: string;
  parent?: string;
  space?: SpaceId;
  path?: string;
  live: Memory[];
  past: Memory[];
  files: string[];
}

export type RowType = "home" | "kind" | "topics" | "topic" | "past" | "memory" | "file" | "now" | "journal" | "month" | "day" | "entry" | "index";
export interface TreeNode {
  /** unique per row (open state, keyboard cursor) */
  key: string;
  /** what selecting it selects; the same piece can sit in a kind folder and a topic folder */
  id: string;
  type: RowType;
  label: string;
  home: string;
  kind?: MemoryKind;
  memory?: Memory;
  path?: string;
  entry?: JournalEntry;
  now?: ProjectNow;
  /** open until the user closes it (the newest month and day of 일 기록) */
  open0?: boolean;
  /** folders and files inside */
  children?: TreeNode[];
  /** pieces right inside (kind / topic / past folders) */
  mems?: Memory[];
  count: number;
}

export interface Topic {
  key: string;
  label: string;
  mems: Memory[];
}

export interface Model {
  homes: Map<string, Home>;
  /** homes in tree order (모든 일, then spaces, each followed by its projects) */
  order: string[];
  topics: Map<string, Topic>;
  roots: TreeNode[];
  /** first row for each id (where a selection is revealed) */
  rowOf: Map<string, TreeNode>;
  /** row key → parent row key */
  up: Map<string, string>;
  memById: Map<string, Memory>;
  /** 일 기록, newest first */
  journal: JournalEntry[];
  entryById: Map<string, JournalEntry>;
  /** 지금 by project folder (only the fresh ones are passed in) */
  nows: Map<string, { folder: string; home: string; now: ProjectNow }>;
}

export const LIMIT = 50;
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const topicKey = (a: string) => a.trim().toLowerCase();
export const kindFolderId = (home: string, k: MemoryKind) => `${home}|k:${k}`;
export const pastId = (home: string) => `${home}|past`;
export const topicsId = (home: string) => `${home}|t`;
export const JOURNAL = "j";
export const VERSIONS = "v";
export const entryId = (e: JournalEntry) => `j:${e.id}`;
export const nowId = (folder: string) => `n:${folder}`;
const pad = (n: number) => String(n).padStart(2, "0");
export const monthKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const dayKey = (t: number) => `${monthKey(t)}-${pad(new Date(t).getDate())}`;
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
export function monthLabel(t: number) {
  const d = new Date(t);
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}월` : `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
export function dayLabel(t: number, withMonth = false) {
  const d = new Date(t);
  const today = dayKey(Date.now());
  const k = dayKey(t);
  if (k === today) return "오늘";
  if (k === dayKey(Date.now() - 86_400_000)) return "어제";
  return `${withMonth ? `${d.getMonth() + 1}월 ` : ""}${d.getDate()}일 ${WEEK[d.getDay()]}`;
}
export const clock = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** what matters more first, then newest */
export const byWeight = (a: Memory, b: Memory) =>
  (b.importance ?? 3) - (a.importance ?? 3) || (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);

export interface Input {
  spaces: { id: SpaceId; label: string; folder: string }[];
  projects: Project[];
  memory: Memory[];
  files?: { bySpace: { space: SpaceId; files: string[] }[]; byProject: { project: string; files: string[] }[] };
  journal?: JournalEntry[];
  /** project folder → what was last going on (fresh ones) */
  now?: Record<string, ProjectNow>;
  expand: (p: string) => string;
  /** file names on disk (memoryFileNames) — rows show the real files */
  names?: Map<string, string>;
  journalName?: (title: string, id: string) => string;
}

export const entryMatches = (e: JournalEntry, s: string) => [e.title, e.ask, e.text].some((x) => x.toLowerCase().includes(s));

/** Homes, topics and the folder tree. `match` keeps only what a search finds. */
export function buildModel(inp: Input, match?: (m: Memory) => boolean, q = ""): Model {
  const homes = new Map<string, Home>();
  const mk = (h: Omit<Home, "live" | "past" | "files">) => {
    const x: Home = { ...h, live: [], past: [], files: [] };
    homes.set(h.id, x);
    return x;
  };
  mk({ id: "g", kind: "global", label: "모든 일" });
  for (const s of inp.spaces) mk({ id: `s:${s.id}`, kind: "space", label: s.label, parent: "g", space: s.id, path: s.folder });
  const spaceHome = (id?: SpaceId) => {
    const k = `s:${id ?? "?"}`;
    return homes.get(k) ?? mk({ id: k, kind: "space", label: id ?? "공간", parent: "g", space: id });
  };
  const projHome = (folder: string, name?: string, space?: SpaceId) => {
    const k = `p:${inp.expand(folder)}`;
    const had = homes.get(k);
    if (had) return had;
    const sp = space ?? inp.spaces.find((s) => inp.expand(folder).startsWith(inp.expand(s.folder)))?.id ?? inp.spaces[0]?.id;
    return mk({ id: k, kind: "project", label: name ?? base(folder), parent: spaceHome(sp).id, space: sp, path: inp.expand(folder) });
  };
  for (const p of inp.projects) projHome(p.folder, p.name, p.space);
  const nows = new Map<string, { folder: string; home: string; now: ProjectNow }>();
  for (const [folder, now] of Object.entries(inp.now ?? {})) nows.set(folder, { folder, home: projHome(folder).id, now });
  const homeOf = (m: Memory) => (m.scope === "global" ? homes.get("g")! : m.scope === "space" ? spaceHome(m.space) : projHome(m.project ?? "기타"));
  const memById = new Map<string, Memory>();
  for (const m of inp.memory) {
    memById.set(m.id, m);
    const h = homeOf(m);
    (isLive(m) ? h.live : h.past).push(m);
  }
  // instruction files: in the deepest home whose folder holds them, each file once
  const seenFile = new Set<string>();
  const projects = [...homes.values()].filter((h) => h.kind === "project");
  const fileHome = (path: string, fallback: Home) => projects.find((p) => p.path && path.startsWith(`${p.path}/`)) ?? fallback;
  for (const p of inp.files?.byProject ?? [])
    for (const f of p.files) if (!seenFile.has(f)) seenFile.add(f), projHome(p.project).files.push(f);
  for (const s of inp.files?.bySpace ?? [])
    for (const f of s.files) if (!seenFile.has(f)) seenFile.add(f), fileHome(f, spaceHome(s.space)).files.push(f);

  // topic hubs: a tool or service two or more live pieces are about (as the mirror's 주제/)
  const topics = new Map<string, Topic>();
  for (const m of inp.memory.filter(isLive))
    for (const a of m.about ?? []) {
      const k = topicKey(a);
      if (!k) continue;
      const t = topics.get(k) ?? { key: k, label: a.trim(), mems: [] };
      if (!t.mems.includes(m)) t.mems.push(m);
      topics.set(k, t);
    }
  for (const [k, t] of topics) if (t.mems.length < 2) topics.delete(k);

  const order: string[] = ["g"];
  const kidsOf = (id: string) => [...homes.values()].filter((h) => h.parent === id);
  for (const s of kidsOf("g")) {
    order.push(s.id);
    for (const p of kidsOf(s.id)) order.push(p.id);
  }

  // the tree
  const s = q.trim().toLowerCase();
  const journal = [...(inp.journal ?? [])].sort((a, b) => b.at - a.at);
  const entryById = new Map(journal.map((e) => [e.id, e]));
  const shownJ = match ? journal.filter((e) => entryMatches(e, s)) : journal;
  // 일 기록 inside a space folder: month › day › entry, newest first (as on disk)
  const journalRow = (h: Home): TreeNode | null => {
    const mine = shownJ.filter((e) => `s:${e.space}` === h.id);
    if (!mine.length) return null;
    const months: TreeNode[] = [];
    for (const e of mine) {
      const mk = `${h.id}|j|${monthKey(e.at)}`;
      let mo = months.find((x) => x.key === mk);
      if (!mo) months.push((mo = { key: mk, id: `j|${monthKey(e.at)}`, type: "month", label: `${new Date(e.at).getFullYear()}${pad(new Date(e.at).getMonth() + 1)}`, home: JOURNAL, children: [], count: 0, open0: !months.length }));
      const dk = `${h.id}|j|${dayKey(e.at)}`;
      let day = mo.children!.find((x) => x.key === dk);
      if (!day) mo.children!.push((day = { key: dk, id: `j|${dayKey(e.at)}`, type: "day", label: pad(new Date(e.at).getDate()), home: JOURNAL, children: [], count: 0, open0: !mo.children!.length && !!mo.open0 }));
      day.children!.push({ key: `${dk}>${e.id}`, id: entryId(e), type: "entry", label: `${inp.journalName?.(e.title, e.id) ?? (e.title || e.ask)}.md`, home: JOURNAL, entry: e, count: 0 });
      day.count++;
      mo.count++;
    }
    return { key: `${h.id}|j`, id: JOURNAL, type: "journal", label: "일 기록", home: JOURNAL, children: months, count: mine.length };
  };
  const ok = (m: Memory) => !match || match(m);
  const rowOf = new Map<string, TreeNode>();
  const up = new Map<string, string>();
  const note = (n: TreeNode, parent?: TreeNode) => {
    if (!rowOf.has(n.id)) rowOf.set(n.id, n);
    if (parent) up.set(n.key, parent.key);
    for (const c of n.children ?? []) note(c, n);
    return n;
  };
  const memRows = (folder: string, home: string, list: Memory[]): TreeNode[] =>
    list.map((m) => ({ key: `${folder}>${m.id}`, id: `m:${m.id}`, type: "memory" as const, label: `${inp.names?.get(m.id) ?? m.text}.md`, home, memory: m, count: 0 }));
  const homeRow = (h: Home): TreeNode | null => {
    const kids: TreeNode[] = [];
    for (const n of nows.values())
      if (n.home === h.id && (!match || n.now.text.toLowerCase().includes(s)))
        kids.push({ key: nowId(n.folder), id: nowId(n.folder), type: "now", label: "지금.md", home: h.id, now: n.now, path: n.folder, count: 0 });
    for (const p of kidsOf(h.id)) {
      const r = homeRow(p);
      if (r) kids.push(r);
    }
    for (const k of KINDS) {
      const list = h.live.filter((m) => kindOf(m) === k.id && ok(m)).sort(byWeight);
      if (!list.length) continue;
      const key = kindFolderId(h.id, k.id);
      kids.push({ key, id: key, type: "kind", label: k.label, home: h.id, kind: k.id, mems: list, children: memRows(key, h.id, list), count: list.length });
    }
    const tops: TreeNode[] = [];
    for (const t of topics.values()) {
      const here = t.mems.filter((m) => h.live.includes(m));
      const list = (match && !t.label.toLowerCase().includes(s) ? here.filter(ok) : here).sort(byWeight);
      if (!list.length) continue;
      const key = `${h.id}|t:${t.key}`;
      tops.push({ key, id: `t:${t.key}`, type: "topic", label: `${t.label}.md`, home: h.id, mems: list, count: list.length });
    }
    if (tops.length) {
      tops.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      const key = topicsId(h.id);
      kids.push({ key, id: key, type: "topics", label: "주제", home: h.id, children: tops, count: tops.length });
    }
    const past = h.past.filter(ok).sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0));
    if (past.length) {
      const key = pastId(h.id);
      kids.push({ key, id: key, type: "past", label: "지난 기억", home: h.id, mems: past, children: memRows(key, h.id, past), count: past.length });
    }
    if (h.kind === "space") {
      const j = journalRow(h);
      if (j) kids.push(j);
    }
    for (const f of h.files)
      if (!match || f.toLowerCase().includes(s)) kids.push({ key: `f:${f}`, id: `f:${f}`, type: "file", label: base(f), home: h.id, path: f, count: 0 });
    const count = (n: TreeNode[]): number => n.reduce((x, c) => x + (c.type === "kind" || c.type === "home" ? c.count : 0), 0);
    if (match && !kids.length && !h.label.toLowerCase().includes(s)) return null;
    // no pieces anywhere under it → no folder on disk either
    if (!match && !h.live.length && !h.past.length && !kids.some((c) => c.type === "home" || c.type === "now" || c.type === "journal")) return h.files.length ? { key: h.id, id: h.id, type: "home", label: h.label, home: h.id, path: h.path, children: kids, count: 0 } : null;
    // the folder note (회사/회사.md): links to everything in the folder
    // a space folder's note is its 목차.md (it lives in <space>/.ondra/memory)
    if (h.live.length) kids.push({ key: `${h.id}|note`, id: h.id, type: "index", label: h.kind === "space" && h.path && h.path !== "~" ? "목차.md" : `${h.label}.md`, home: h.id, count: 0 });
    return { key: h.id, id: h.id, type: "home", label: h.label, home: h.id, path: h.path, children: kids, count: count(kids) };
  };
  const roots: TreeNode[] = [];
  const g = homeRow(homes.get("g")!);
  // 모든 일 sits beside the spaces, as on disk (its own pieces only)
  if (g) {
    const own = g.children!.filter((c) => c.type !== "home");
    if (own.some((c) => c.type === "kind" || c.type === "past")) roots.push(note({ ...g, children: own, count: own.reduce((x, c) => x + (c.type === "kind" ? c.count : 0), 0) }));
    for (const c of g.children!) if (c.type === "home") roots.push(note(c));
  }
  return { homes, order, topics, roots, rowOf, up, memById, journal, entryById, nows };
}

/** the rows you can see right now, top to bottom (for the arrow keys) */
export function visibleRows(roots: TreeNode[], isOpen: (n: TreeNode) => boolean, shown: (n: TreeNode) => number): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children && isOpen(n)) walk(n.children.slice(0, shown(n)));
    }
  };
  walk(roots);
  return out;
}

/** every home a home sits in, outermost first */
export function homeChain(model: Model, id: string): Home[] {
  const out: Home[] = [];
  for (let h = model.homes.get(id); h; h = h.parent ? model.homes.get(h.parent) : undefined) out.unshift(h);
  return out;
}

/** the folder a piece is filed in (its kind folder, or 지난 기억) */
export const folderOf = (homeId: string, m: Memory) => (isLive(m) ? kindFolderId(homeId, kindOf(m)) : pastId(homeId));
export const homeIdOf = (m: Memory, expand: (p: string) => string) => (m.scope === "global" ? "g" : m.scope === "space" ? `s:${m.space}` : `p:${expand(m.project ?? "기타")}`);

// ───────────── graph

export type GKind = "global" | "space" | "project" | "folder" | "past" | "topics" | "topic" | "memory" | "file" | "entry";
export interface GNode {
  id: string;
  kind: GKind;
  label: string;
  /** where a new node grows out of */
  anchor?: string;
  r: number;
  mk?: MemoryKind;
  memory?: Memory;
  entry?: JournalEntry;
  path?: string;
  count?: number;
  /** 0 = the focus, 1 = next to it, 2 = two steps away (drawn quieter) */
  ring: number;
  /** a search finds something here (or no search) */
  hit: boolean;
}
export interface GEdge {
  a: string;
  b: string;
  /** own = belongs to, same = linked pieces, old = replaced by, about = piece → topic, tie = topic ↔ folder its pieces are in,
   *  hold = not drawn, only keeps a topic out on the ring around its home */
  kind: "own" | "same" | "old" | "about" | "tie" | "hold";
  /** 0–1, how strong (ties: share of the topic's pieces) */
  w: number;
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  byId: Map<string, GNode>;
  /** the selection drawn as a local graph (null = the whole structure) */
  focus: string | null;
}

const hubR = (n: number, base0: number, k: number) => base0 + Math.sqrt(Math.max(0, n)) * k;
export const isHub = (k: GKind) => k !== "memory" && k !== "file" && k !== "entry";

/**
 * Nothing (or a home / file) selected → the structure only: homes, a node per kind
 * folder, 지난 기억, topic hubs tied to the folders their pieces live in. A folder,
 * topic or piece selected → its local graph, one or two steps out.
 */
export function buildGraph(model: Model, sel: string, match?: (m: Memory) => boolean, q0 = ""): Graph {
  const q = q0.trim().toLowerCase();
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const byId = new Map<string, GNode>();
  const add = (n: Omit<GNode, "hit"> & { hit?: boolean }) => {
    const had = byId.get(n.id);
    if (had) {
      had.ring = Math.min(had.ring, n.ring);
      return had;
    }
    const x = { hit: true, ...n } as GNode;
    nodes.push(x);
    byId.set(x.id, x);
    return x;
  };
  const edge = (a: string, b: string, kind: GEdge["kind"], w = 1) => {
    if (a !== b && byId.has(a) && byId.has(b)) edges.push({ a, b, kind, w });
  };
  const hits = (list: Memory[]) => !match || list.some(match);
  const memHome = new Map<string, string>();
  for (const h of model.homes.values()) for (const m of [...h.live, ...h.past]) memHome.set(m.id, h.id);
  const homeOfMem = (m: Memory) => memHome.get(m.id) ?? "g";
  const subtree = (id: string): Memory[] => {
    const h = model.homes.get(id);
    if (!h) return [];
    return [...h.live, ...[...model.homes.values()].filter((x) => x.parent === id && x.id !== id).flatMap((x) => subtree(x.id))];
  };
  const addHome = (h: Home, ring: number) => {
    const n = h.kind === "global" ? h.live.length : subtree(h.id).length;
    return add({
      id: h.id,
      kind: h.kind,
      label: h.label,
      anchor: h.parent,
      r: h.kind === "global" ? hubR(n, 9, 0.8) : h.kind === "space" ? hubR(n, 10, 0.6) : hubR(n, 8, 0.7),
      path: h.path,
      count: n,
      ring,
      hit: hits(subtree(h.id)),
    });
  };
  const addKind = (h: Home, k: MemoryKind, ring: number) => {
    const list = h.live.filter((m) => kindOf(m) === k);
    if (!list.length) return null;
    return add({ id: kindFolderId(h.id, k), kind: "folder", label: kindLabel(k), anchor: h.id, r: hubR(list.length, 5, 1.5), mk: k, count: list.length, ring, hit: hits(list) });
  };
  const addPast = (h: Home, ring: number) =>
    h.past.length ? add({ id: pastId(h.id), kind: "past", label: "지난 기억", anchor: h.id, r: hubR(h.past.length, 4, 1.2), count: h.past.length, ring, hit: hits(h.past) }) : null;
  const addTopic = (t: Topic, ring: number, anchor?: string) =>
    add({ id: `t:${t.key}`, kind: "topic", label: t.label, anchor, r: hubR(t.mems.length, 3, 1.25), count: t.mems.length, ring, hit: !match || (!!q && t.label.toLowerCase().includes(q)) || hits(t.mems) });
  const addMem = (m: Memory, ring: number, anchor?: string) =>
    add({ id: `m:${m.id}`, kind: "memory", label: m.text, anchor: anchor ?? folderOf(homeOfMem(m), m), r: 3.2 + Math.min(2.5, m.uses * 0.5) + Math.min(1.5, (m.seen ?? 0) * 0.4), mk: kindOf(m), memory: m, ring, hit: !match || match(m) });
  /** links between the pieces drawn, and what replaced what */
  const memLinks = () => {
    const seen = new Set<string>();
    for (const n of nodes) {
      const m = n.memory;
      if (!m) continue;
      for (const l of m.links ?? []) {
        const k = [m.id, l].sort().join("|");
        if (seen.has(k)) continue;
        seen.add(k);
        edge(`m:${m.id}`, `m:${l}`, "same", 1);
      }
      if (m.supersededBy) edge(`m:${m.id}`, `m:${m.supersededBy}`, "old", 1);
    }
  };
  const topicsOf = (m: Memory) => (m.about ?? []).map((a) => model.topics.get(topicKey(a))).filter((t): t is Topic => !!t);

  // which kind of selection
  const kindSel = /^(.+)\|k:(\w+)$/.exec(sel);
  const pastSel = /^(.+)\|past$/.exec(sel);
  const topicSel = sel.startsWith("t:") ? model.topics.get(sel.slice(2)) : undefined;
  const memSel = sel.startsWith("m:") ? model.memById.get(sel.slice(2)) : undefined;
  const entrySel = sel.startsWith("j:") ? model.entryById.get(sel.slice(2)) : undefined;

  if (entrySel) {
    // a finished job: the pieces learned from it, and the folders they went into
    const me = add({ id: sel, kind: "entry", label: entrySel.title || entrySel.ask, r: 7, entry: entrySel, ring: 0 });
    const learned = (entrySel.learned ?? []).map((id) => model.memById.get(id)).filter((m): m is Memory => !!m);
    for (const m of learned) {
      addMem(m, 1, me.id);
      edge(me.id, `m:${m.id}`, "own");
      const h = model.homes.get(homeOfMem(m));
      const f = h && (isLive(m) ? addKind(h, kindOf(m), 2) : addPast(h, 2));
      if (f) edge(f.id, `m:${m.id}`, "own", 0.3);
    }
    memLinks();
    return { nodes, edges, byId, focus: sel };
  }

  if (kindSel || pastSel) {
    const h = model.homes.get((kindSel ?? pastSel)![1]);
    if (h) {
      addHome(h, 1);
      const f = kindSel ? addKind(h, kindSel[2] as MemoryKind, 0) : addPast(h, 0);
      if (f) {
        edge(h.id, f.id, "own");
        const list = kindSel ? h.live.filter((m) => kindOf(m) === kindSel[2]) : h.past;
        for (const m of list) addMem(m, 1, f.id), edge(f.id, `m:${m.id}`, "own", m.about?.some((x) => model.topics.has(topicKey(x))) ? 0.25 : 1);
        // topics two or more of these pieces share (all of them when the folder is small)
        const tc = new Map<string, { t: Topic; ms: Memory[] }>();
        for (const m of list) for (const t of topicsOf(m)) tc.set(t.key, { t, ms: [...(tc.get(t.key)?.ms ?? []), m] });
        for (const { t, ms } of tc.values())
          if (ms.length >= 2 || list.length <= 30) {
            addTopic(t, 2, f.id);
            for (const m of ms) edge(`t:${t.key}`, `m:${m.id}`, "about");
          }
        // replacements of retired pieces
        if (pastSel)
          for (const m of list)
            if (m.supersededBy) {
              const nw = model.memById.get(m.supersededBy);
              if (nw) addMem(nw, 2, f.id);
            }
        memLinks();
        return { nodes, edges, byId, focus: sel };
      }
    }
  }
  if (topicSel) {
    const t = addTopic(topicSel, 0);
    const shared = new Map<string, { t: Topic; n: number }>();
    for (const m of topicSel.mems) {
      const h = model.homes.get(homeOfMem(m))!;
      const f = addKind(h, kindOf(m), 2);
      addMem(m, 1, t.id);
      edge(t.id, `m:${m.id}`, "about");
      if (f) edge(f.id, `m:${m.id}`, "own", 0.4);
      for (const o of topicsOf(m)) if (o.key !== topicSel.key) shared.set(o.key, { t: o, n: (shared.get(o.key)?.n ?? 0) + 1 });
    }
    for (const { t: o, n } of shared.values())
      if (n >= 2 || topicSel.mems.length <= 12) {
        addTopic(o, 2, t.id);
        for (const m of o.mems) if (byId.has(`m:${m.id}`)) edge(`t:${o.key}`, `m:${m.id}`, "about", 0.6);
      }
    memLinks();
    return { nodes, edges, byId, focus: sel };
  }
  if (memSel) {
    const h = model.homes.get(homeOfMem(memSel))!;
    const me = addMem(memSel, 0);
    const f = isLive(memSel) ? addKind(h, kindOf(memSel), 1) : addPast(h, 1);
    if (f) edge(f.id, me.id, "own");
    // one step: its topics, the pieces it links to, what it replaced or was replaced by
    const near: Memory[] = [];
    for (const l of memSel.links ?? []) {
      const m = model.memById.get(l);
      if (m) near.push(m);
    }
    if (memSel.supersededBy) {
      const m = model.memById.get(memSel.supersededBy);
      if (m) near.push(m);
    }
    for (const m of model.memById.values()) if (m.supersededBy === memSel.id) near.push(m);
    for (const m of near) addMem(m, 1, me.id);
    const ts = topicsOf(memSel);
    for (const t of ts) addTopic(t, 1, me.id), edge(`t:${t.key}`, me.id, "about");
    // two steps: the other pieces on those topics and the links of its links, a few at most
    const far: Memory[] = [];
    for (const m of near) for (const l of m.links ?? []) {
      const x = model.memById.get(l);
      if (x && x !== memSel) far.push(x);
    }
    for (const t of ts) far.push(...[...t.mems].sort(byWeight).filter((x) => x !== memSel));
    let room = 40;
    for (const m of far) {
      if (room <= 0) break;
      if (byId.has(`m:${m.id}`)) continue;
      addMem(m, 2, me.id);
      room--;
    }
    for (const t of ts) for (const m of t.mems) edge(`t:${t.key}`, `m:${m.id}`, "about", 0.6);
    memLinks();
    return { nodes, edges, byId, focus: sel };
  }
  const topicsSel = /^(.+)\|t$/.exec(sel);
  if (topicsSel) {
    const h = model.homes.get(topicsSel[1]);
    if (h) {
      addHome(h, 1);
      const hub = add({ id: sel, kind: "topics", label: "주제", anchor: h.id, r: 7, ring: 0, count: 0 });
      edge(h.id, hub.id, "own");
      for (const t of model.topics.values()) {
        const here = t.mems.filter((m) => h.live.includes(m));
        if (!here.length) continue;
        addTopic(t, 1, hub.id);
        edge(hub.id, `t:${t.key}`, "own", 0.5);
        hub.count = (hub.count ?? 0) + 1;
      }
      // topics that share pieces sit together
      const ts = [...model.topics.values()].filter((t) => byId.has(`t:${t.key}`));
      for (let i = 0; i < ts.length; i++)
        for (let j = i + 1; j < ts.length; j++) {
          const n = ts[i].mems.filter((m) => ts[j].mems.includes(m)).length;
          if (n >= 2) edge(`t:${ts[i].key}`, `t:${ts[j].key}`, "tie", Math.min(1, n / 6));
        }
      return { nodes, edges, byId, focus: sel };
    }
  }

  // the whole structure
  for (const id of model.order) {
    const h = model.homes.get(id)!;
    if (h.kind === "project" && !h.live.length && !h.past.length && !h.files.length) {
      addHome(h, 1);
      edge(h.parent!, h.id, "own");
      continue;
    }
    addHome(h, 1);
    if (h.parent) edge(h.parent, h.id, "own");
    for (const k of KINDS) {
      const f = addKind(h, k.id, 1);
      if (f) edge(h.id, f.id, "own");
    }
    const p = addPast(h, 1);
    if (p) edge(h.id, p.id, "own");
    for (const f of h.files) {
      add({ id: `f:${f}`, kind: "file", label: base(f), anchor: h.id, r: 4.5, path: f, ring: 1, hit: !match || f.toLowerCase().includes(q) });
      edge(h.id, `f:${f}`, "own");
    }
  }
  for (const t of model.topics.values()) {
    // tie a topic to the folders its pieces live in, stronger where most of them are
    const at = new Map<string, number>();
    for (const m of t.mems) {
      const f = folderOf(homeOfMem(m), m);
      at.set(f, (at.get(f) ?? 0) + 1);
    }
    // tied to the folder most of its pieces are in, and to others that hold a good share
    const ranked = [...at.entries()].sort((a, b) => b[1] - a[1]);
    addTopic(t, 1, ranked[0]?.[0]);
    ranked.forEach(([f, n], i) => {
      const w = n / t.mems.length;
      if (i === 0 || w >= 0.3) edge(f, `t:${t.key}`, "tie", i === 0 ? 1 : w * 0.6);
    });
    const home = ranked[0]?.[0].replace(/\|(k:\w+|past)$/, "");
    if (home) edge(home, `t:${t.key}`, "hold");
  }
  return { nodes, edges, byId, focus: null };
}

/** pieces under a node of the graph or a folder of the tree (for the side summary) */
export function memsUnder(model: Model, id: string): Memory[] {
  if (id.startsWith("j:")) return (model.entryById.get(id.slice(2))?.learned ?? []).map((x) => model.memById.get(x)).filter((m): m is Memory => !!m);
  const k = /^(.+)\|k:(\w+)$/.exec(id);
  if (k) return model.homes.get(k[1])?.live.filter((m) => kindOf(m) === k[2]) ?? [];
  const p = /^(.+)\|past$/.exec(id);
  if (p) return model.homes.get(p[1])?.past ?? [];
  if (id.startsWith("t:")) return model.topics.get(id.slice(2))?.mems ?? [];
  const t = /^(.+)\|t$/.exec(id);
  if (t) {
    const h = model.homes.get(t[1]);
    return h ? [...model.topics.values()].flatMap((x) => x.mems.filter((m) => h.live.includes(m))).filter((m, i, a) => a.indexOf(m) === i) : [];
  }
  const h = model.homes.get(id);
  if (!h) return [];
  if (id === "g") return h.live;
  const out = [...h.live];
  for (const x of model.homes.values()) if (x.parent === id) out.push(...memsUnder(model, x.id));
  return out;
}
