// What the agents remember, as one picture (Obsidian-style folders + graph).
//
// What feeds a job, and what a developer needs to see at once:
//   1. memory pieces (state.memory): global › space › project, one rule/fact/
//      decision each, linked to the pieces about the same things; path rules reach
//      a job only when it touches a matching file, the rest are recalled when it fits
//   2. instruction files the engine reads: AGENTS.md / CLAUDE.md in the space and
//      project folders (one of them when CLAUDE.md just points at AGENTS.md)
//   3. 일 기록 (one entry per finished job) and 지금 (what was last going on per project)
// The tree on the left is the same folders the Obsidian mirror writes (home › kind
// › piece, plus 주제 and 지난 기억) and 일 기록 by month and day; the graph shows the
// structure, or the local neighbourhood of what's selected; the right side shows
// one thing, editable, or the saved versions of the memory (MemorySide.tsx).
import { PaneControls } from "./PaneControls";
import { usePaneFocused } from "../state/panes";
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { addMemory, faded, inSpace, journalFileName, kindLabel, kindOf, memoryFileNames, userOwned } from "../engine/memory";
import { parseNowKey, projectNow } from "../engine/journal";
import { tidying, tidyMemory } from "../engine/tidy";
import { absorbing, absorbNotes, findNotes, notesPending } from "../engine/absorb";
import { expand } from "../engine/rpc";
import { fsRead, memoryFolder, revealPath } from "../lib/native";
import { ignoredKey, noModifiers, shortcutOverlay, viewKey } from "../lib/shortcuts";
import { state } from "../state/store";
import type { Memory, MemoryKind, ProjectNow } from "../state/types";
import { memoryFocus, setMemoryFocus } from "../state/ui";
import { ago } from "../ui/bits";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";
import { SidebarToggle } from "./Sidebar";
import { t } from "../i18n";
import { agoIn, Badges, outcomeOf, stampOf, tilde } from "./memoryBits";
import { Detail } from "./MemorySide";
import {
  buildGraph,
  buildModel,
  clock,
  type GEdge,
  type GNode,
  type Graph as G,
  homeName,
  isHub,
  LIMIT,
  type Model,
  type TreeNode,
  VERSIONS,
  visibleRows,
} from "./memoryTree";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get<T>(k: string, d: T): T {
    try {
      return { ...d, ...JSON.parse(localStorage.getItem(k) ?? "{}") };
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/** the instruction files the engine reads in a folder (only what exists; a
 *  CLAUDE.md that's the same text as AGENTS.md is one file, not two) */
async function filesOf(folder: string): Promise<string[]> {
  const root = expand(folder);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const r = await fsRead(`${root}/${f}`).catch(() => null);
    if (!r || (r as { error?: string }).error || r.text === null || seen.has(r.text)) continue;
    seen.add(r.text);
    out.push(`${root}/${f}`);
  }
  return out;
}

// the tree and the detail side can be dragged wider, like the sidebar (kept per machine)
const WIDTH_KEY = "ondra.memory.widths";
const WIDTH0 = { tree: 300, detail: 320 };
const [widths, setWidths] = createSignal<{ tree: number; detail: number }>(store.get(WIDTH_KEY, WIDTH0));
const saveWidths = () => store.set(WIDTH_KEY, widths());
function drag(e: PointerEvent, side: "tree" | "detail") {
  if (e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX;
  const w0 = widths()[side];
  const [min, max] = side === "tree" ? [180, 460] : [260, 720];
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    setWidths((w) => ({ ...w, [side]: Math.round(Math.min(max, Math.max(min, side === "tree" ? w0 + dx : w0 - dx))) }));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("resizing");
    saveWidths();
  };
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
const resetWidth = (side: "tree" | "detail") => (setWidths((w) => ({ ...w, [side]: WIDTH0[side] })), saveWidths());

/** which folders are open (kept per machine); unknown ones use the default */
const OPEN_KEY = "ondra.memory.open";
const [openMap, setOpenMap] = createSignal<Record<string, boolean>>(store.get(OPEN_KEY, {}));
const setOpen = (key: string, v: boolean) => {
  setOpenMap((m) => ({ ...m, [key]: v }));
  store.set(OPEN_KEY, openMap());
};

export function MemoryView() {
  const focused = usePaneFocused();
  // each space is its own workspace: only what belongs to this one (and what every job shares)
  const mySpaces = () => state.spaces.filter((s) => s.id === state.space);
  const myProjects = () => (state.projects ?? []).filter((p) => p.space === state.space);
  const myMemory = createMemo(() => state.memory.filter((m) => inSpace(m, state.space)));
  const myJournal = createMemo(() => (state.journal ?? []).filter((e) => !e.space || e.space === state.space));
  // folder notes of this space only (the other space's notes are brought in there)
  const myNotes = createMemo(() => notesPending().filter((n) => n.space === state.space));
  const [files] = createResource(
    () => [state.space, mySpaces().map((s) => s.folder).join("|"), myProjects().map((p) => p.folder).join("|")],
    async () => {
      const bySpace = await Promise.all(mySpaces().map(async (s) => ({ space: s.id, files: await filesOf(s.folder) })));
      const byProject = await Promise.all(myProjects().map(async (p) => ({ project: p.folder, files: await filesOf(p.folder) })));
      return { bySpace, byProject };
    },
  );
  const [sel, setSel] = createSignal<string>("");
  // opened from elsewhere (context viewer, a job): select that piece; "" = the overview (내 차례's 메모리 확인)
  createEffect(() => {
    const id = memoryFocus();
    if (id !== null) {
      setSel(id ? `m:${id}` : "");
      setMemoryFocus(null);
    }
  });
  onMount(() => {
    void findNotes();
    // Esc goes back from a local graph to the whole structure
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !sel() || !focused() || !viewKey(e) || !noModifiers(e)) return;
      e.preventDefault();
      setSel("");
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });
  const [hover, setHover] = createSignal<string>();
  const [q, setQ] = createSignal("");
  const match = createMemo(() => {
    const s = q().trim().toLowerCase();
    if (!s) return undefined;
    return (m: Memory) => [m.text, m.from ?? "", m.key ?? "", ...(m.keys ?? []), ...(m.about ?? []), ...(m.paths ?? [])].some((x) => x.toLowerCase().includes(s));
  });
  // 지금: only what is still fresh (what the next job there would get)
  const nows = createMemo(() => {
    const out: Record<string, ProjectNow> = {};
    for (const k of Object.keys(state.memoryNow ?? {})) {
      const { space, folder } = parseNowKey(k);
      if (space !== state.space) continue;
      const n = projectNow(folder, space);
      if (n) out[folder] = n;
    }
    return out;
  });
  // the same file names as the memory folder on disk
  const names = createMemo(() => memoryFileNames(state.memory));
  const input = () => ({ spaces: mySpaces(), projects: myProjects(), memory: myMemory(), files: files(), journal: myJournal(), now: nows(), expand, names: names(), journalName: journalFileName });
  const model = createMemo(() => buildModel(input()));
  const tree = createMemo(() => (match() ? buildModel(input(), match(), q()) : model()));
  // 지금 lights its project in the graph; versions leave the graph as it is
  const graphSel = () => {
    const s = sel();
    if (s.startsWith("n:")) return model().nows.get(s.slice(2))?.home ?? "";
    return s === VERSIONS || s === "j" || s.startsWith("j|") ? "" : s;
  };
  const graph = createMemo(() => buildGraph(model(), graphSel(), match(), q()));

  const tidyTitle = () => {
    const x = state.memoryTidy;
    return x ? `${t("마지막 정리 {when}", { when: agoIn(x.at) })}${x.cursor ? `\n${t("{when}까지 학습", { when: stampOf(x.cursor) })}` : ""}` : t("정리");
  };
  // the folder of what's selected: a space's own <folder>/.ondra/memory, else the app's
  const openFolder = async () => {
    const M = model();
    const id = sel();
    let h = M.homes.get(id) ?? (id.startsWith("m:") ? [...M.homes.values()].find((x) => x.live.some((m) => m.id === id.slice(2)) || x.past.some((m) => m.id === id.slice(2))) : undefined);
    while (h && h.kind === "project" && h.parent) h = M.homes.get(h.parent);
    if (!h && id.startsWith("j:")) h = M.homes.get(`s:${M.entryById.get(id.slice(2))?.space}`);
    const sp = h?.kind === "space" && h.path && h.path !== "~" ? expand(h.path) : undefined;
    const dir = sp ? `${sp.replace(/\/$/, "")}/.ondra/memory` : await memoryFolder();
    if (dir) revealPath(dir);
  };

  return (
    <div class="view mem-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">{t("메모리")}</h1>
        {/* the counts live once, in the overview on the right */}
        <span class="spacer" data-tauri-drag-region />
        <Show when={myNotes().length}>
          <button class="btn sm" disabled={absorbing()} onClick={() => void absorbNotes(myNotes())} title={myNotes().map((x) => tilde(x.path)).join("\n")}>
            <Icon name="download" size={14} />
            {absorbing() ? t("가져오는 중…") : t("폴더 노트 {n}개", { n: myNotes().length })}
          </button>
        </Show>
        <button class="btn sm ghost" disabled={tidying()} onClick={() => void tidyMemory(true, state.space)} title={tidyTitle()}>
          <Icon name="refresh" size={14} />
          {tidying() ? t("정리하는 중…") : t("정리")}
        </button>
        <button class="btn sm ghost" classList={{ on: sel() === VERSIONS }} onClick={() => setSel(sel() === VERSIONS ? "" : VERSIONS)} aria-pressed={sel() === VERSIONS}>
          <Icon name="history" size={14} />{t("버전")}
        </button>
        <button class="btn sm ghost" onClick={() => void openFolder()} title={t("Finder에서 보기")}><Icon name="folder" size={14} />{t("폴더 열기")}</button>
        <div class="mem-search">
          <Icon name="search" size={14} />
          <input placeholder={t("검색")} aria-label={t("검색")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => {
            if (e.key !== "Escape" || ignoredKey(e) || !noModifiers(e) || shortcutOverlay()) return;
            e.preventDefault();
            setQ("");
          }} />
        </div>
        <PaneControls />
      </header>
      <div class="mem-body" style={{ "--mt-w": `${widths().tree}px`, "--md-w": `${widths().detail}px` }}>
        <MemTree model={tree()} full={model()} sel={sel()} onSel={setSel} searching={!!match()} />
        <Graph graph={graph()} sel={graphSel()} hover={hover()} onSel={setSel} onHover={setHover} />
        <Detail model={model()} sel={sel()} onSel={setSel} />
        <div class="mem-resize left" onPointerDown={(e) => drag(e, "tree")} onDblClick={() => resetWidth("tree")} title={t("너비 조절")} />
        <div class="mem-resize right" onPointerDown={(e) => drag(e, "detail")} onDblClick={() => resetWidth("detail")} title={t("너비 조절")} />
      </div>
    </div>
  );
}

// ───────────── graph

/**
 * The graph moves like Obsidian's: a small physics simulation (pull along links,
 * push apart nearby nodes, a little gravity) settles the nodes gently instead of
 * jumping. Pushing apart only looks at nodes in the neighbouring grid cells, so a
 * frame stays cheap with hundreds of nodes. Nodes keep their place when the view
 * switches between the whole structure and a local graph; new ones grow out of
 * the node they belong to.
 */
type Body = { x: number; y: number; vx: number; vy: number; fx?: number; fy?: number };
/** 0..1 from a string: the same node starts in the same spot, so the graph lays out the same way every time */
function unit(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}
/** where nodes settled last time, so reopening the view shows the same picture */
const settled = new Map<string, { x: number; y: number }>();
/** where the whole structure settled: coming back from a local graph shows the same picture */
const whole = new Map<string, { x: number; y: number }>();
const keepWhole = (g: G, bodies: Map<string, Body>) => {
  if (g.focus) return;
  whole.clear();
  for (const n of g.nodes) {
    const b = bodies.get(n.id);
    if (b) whole.set(n.id, { x: b.x, y: b.y });
  }
};
type View = { x: number; y: number; z: number };
const CUT = 220;

function edgeLen(e: GEdge, a: GNode, b: GNode) {
  // the picked piece stands well off its folder (a close pair read as squashed)
  if (e.kind === "own") return b.kind === "space" ? 210 : b.kind === "project" ? 140 : b.kind === "memory" ? (e.w < 1 || b.ring === 0 ? 110 : 40) + a.r : b.kind === "file" ? 44 + a.r : 84 + a.r + b.r;
  if (e.kind === "tie") return 70 + a.r + b.r;
  if (e.kind === "hold") return 190 + a.r + b.r;
  if (e.kind === "about") return 34 + a.r;
  return 64;
}
function edgeK(e: GEdge) {
  if (e.kind === "own") return 0.06 * e.w;
  if (e.kind === "tie") return 0.012 * (0.25 + e.w);
  if (e.kind === "hold") return 0.02;
  if (e.kind === "about") return 0.05 * e.w;
  return 0.02;
}

function Graph(props: { graph: G; sel: string; hover?: string; onSel: (id: string) => void; onHover: (id?: string) => void }) {
  let svg!: SVGSVGElement;
  const [view, setView] = createSignal<View>({ x: 0, y: 0, z: 1 });
  const [size, setSize] = createSignal({ w: 800, h: 600 });
  const [tick, setTick] = createSignal(0);
  const bodies = new Map<string, Body>();
  let alpha = 1;
  let raf = 0;
  let frames = 0;
  let userMoved = false;
  let center = { x: 0, y: 0 };
  /** when this graph first laid out from nothing: what arrives right after (the files) is laid out with it, not shaken in */
  let freshAt = 0;
  const at = (id: string) => (tick(), bodies.get(id) ?? { x: 0, y: 0, vx: 0, vy: 0 });

  // the view eases to where it should be instead of jumping
  let tween = 0;
  const goTo = (t: View, ease = true) => {
    cancelAnimationFrame(tween);
    if (!ease || reduced()) return void setView(t);
    const f = view();
    const t0 = performance.now();
    const loop = (now: number) => {
      const k = Math.min(1, (now - t0) / 420);
      const e = 1 - Math.pow(1 - k, 3);
      setView({ x: f.x + (t.x - f.x) * e, y: f.y + (t.y - f.y) * e, z: f.z + (t.z - f.z) * e });
      if (k < 1) tween = requestAnimationFrame(loop);
    };
    tween = requestAnimationFrame(loop);
  };
  const fit = (ease = true) => {
    const ns = props.graph.nodes.map((n) => ({ b: bodies.get(n.id), r: n.r })).filter((x) => x.b);
    if (!ns.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { b, r } of ns) {
      minX = Math.min(minX, b!.x - r - 30), maxX = Math.max(maxX, b!.x + r + 30);
      minY = Math.min(minY, b!.y - r - 10), maxY = Math.max(maxY, b!.y + r + 22);
    }
    // measure now: on the first frame the observer hasn't reported the size yet
    const w = svg?.clientWidth || size().w, h = svg?.clientHeight || size().h;
    const z = Math.min(props.graph.focus ? 1.4 : 1.25, Math.max(0.25, Math.min((w - 60) / (maxX - minX || 1), (h - 70) / (maxY - minY || 1))));
    goTo({ z, x: w / 2 - ((minX + maxX) / 2) * z, y: h / 2 - ((minY + maxY) / 2) * z }, ease);
  };

  const step = () => {
    const ns = props.graph.nodes;
    const bs = ns.map((n) => bodies.get(n.id)!);
    // push apart what's near (grid cells as wide as the cut-off)
    const grid = new Map<number, number[]>();
    const cell = (x: number, y: number) => Math.floor(x / CUT) * 100003 + Math.floor(y / CUT);
    bs.forEach((b, i) => {
      const k = cell(b.x, b.y);
      const l = grid.get(k);
      l ? l.push(i) : grid.set(k, [i]);
    });
    for (let i = 0; i < ns.length; i++) {
      const a = bs[i];
      const cx = Math.floor(a.x / CUT), cy = Math.floor(a.y / CUT);
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const list = grid.get(gx * 100003 + gy);
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const b = bs[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > CUT * CUT) continue;
            if (d2 < 0.01) (dx = ((i * 7 + j * 13) % 10) / 10 - 0.45), (dy = ((i * 11 + j * 5) % 10) / 10 - 0.45), (d2 = 0.5);
            const d = Math.sqrt(d2);
            const rr = ns[i].r + ns[j].r;
            const min = rr + 14;
            const f = (((900 + rr * 70) / d2) * (1 - d2 / (CUT * CUT)) + (d < min ? (min - d) * 0.5 : 0)) * alpha;
            const ux = dx / d, uy = dy / d;
            a.vx -= ux * f, a.vy -= uy * f;
            b.vx += ux * f, b.vy += uy * f;
          }
        }
    }
    // pull along links
    for (const e of props.graph.edges) {
      const a = bodies.get(e.a), b = bodies.get(e.b);
      if (!a || !b) continue;
      const na = props.graph.byId.get(e.a)!, nb = props.graph.byId.get(e.b)!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const k = ((d - edgeLen(e, na, nb)) / d) * edgeK(e) * alpha;
      a.vx += dx * k * 0.5, a.vy += dy * k * 0.5;
      b.vx -= dx * k * 0.5, b.vy -= dy * k * 0.5;
    }
    // a little gravity (to the middle, or to the focus of a local graph), then move with friction
    const gk = props.graph.focus ? 0.008 : 0.004;
    for (const b of bs) {
      b.vx -= (b.x - center.x) * gk * alpha;
      b.vy -= (b.y - center.y) * gk * alpha;
      if (b.fx !== undefined) {
        b.x = b.fx, b.y = b.fy!, b.vx = 0, b.vy = 0;
        continue;
      }
      b.vx *= 0.8, b.vy *= 0.8;
      b.x += Math.max(-30, Math.min(30, b.vx));
      b.y += Math.max(-30, Math.min(30, b.vy));
    }
  };
  const dragging = () => [...bodies.values()].some((b) => b.fx !== undefined);
  const run = () => {
    if (raf) return;
    const loop = () => {
      step();
      alpha *= 0.982;
      frames++;
      setTick((t) => t + 1);
      if (frames === 36 && !userMoved) fit();
      const go = alpha > 0.02 || dragging();
      if (!go) keepWhole(props.graph, bodies);
      if (!go && !userMoved) fit();
      raf = go ? requestAnimationFrame(loop) : 0;
    };
    raf = requestAnimationFrame(loop);
  };
  const heat = (a: number) => {
    alpha = Math.max(alpha, a);
    if (reduced()) {
      for (let i = 0; i < 300 && alpha > 0.02; i++) step(), (alpha *= 0.982);
      setTick((t) => t + 1);
      if (!userMoved) fit(false);
      return;
    }
    run();
  };
  // new nodes grow out of what they belong to; gone ones leave; the view refits
  createEffect(
    on(
      () => props.graph.nodes.map((n) => n.id).join("|"),
      () => {
        const ids = new Set(props.graph.nodes.map((n) => n.id));
        // back to the whole structure as it was laid out before: the same picture, not a new shake
        if (!props.graph.focus && whole.size && props.graph.nodes.every((n) => whole.has(n.id))) {
          const opening = !bodies.size;
          bodies.clear();
          for (const n of props.graph.nodes) bodies.set(n.id, { ...whole.get(n.id)!, vx: 0, vy: 0 });
          center = { x: 0, y: 0 };
          frames = 0;
          userMoved = false;
          alpha = 0;
          setTick((t) => t + 1);
          return fit(!opening);
        }
        const f = props.graph.focus ? bodies.get(props.graph.focus) : undefined;
        center = f ? { x: f.x, y: f.y } : { x: 0, y: 0 };
        let added = 0, restored = 0;
        // a moment after a fresh layout (the instruction files load a beat later): lay it all out
        // again from the same seeds, so the picture is the same every time it opens
        const again = !!freshAt && !userMoved && performance.now() - freshAt < 2500 && props.graph.nodes.some((n) => !bodies.has(n.id));
        if (again) bodies.clear();
        const first = !bodies.size;
        for (const n of props.graph.nodes)
          if (!bodies.has(n.id)) {
            const was = settled.get(n.id);
            if (was) {
              bodies.set(n.id, { ...was, vx: 0, vy: 0 });
              restored++;
              continue;
            }
            const p = (n.anchor && bodies.get(n.anchor)) || f || center;
            const a = unit(n.id) * Math.PI * 2;
            const r = 10 + unit(n.id + "~") * 30;
            bodies.set(n.id, { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: 0, vy: 0 });
            added++;
          }
        for (const id of [...bodies.keys()]) if (!ids.has(id)) bodies.delete(id);
        frames = 0;
        userMoved = false;
        // reopened as it was: show it where it settled instead of shaking it again
        if (restored && !added) {
          if (first) alpha = 0, fit(false);
          return heat(0.03);
        }
        // opened fresh: lay it out before showing it, then fit, so it opens in view and holds still
        if (first) {
          if (!restored && !again) freshAt = performance.now();
          alpha = 1;
          for (let i = 0; i < 400 && alpha > 0.02; i++) step(), (alpha *= 0.982);
          alpha = 0;
          setTick((t) => t + 1);
          keepWhole(props.graph, bodies);
          return fit(false);
        }
        heat(added > 20 ? 0.9 : added ? 0.6 : 0.3);
      },
    ),
  );
  onMount(() => {
    const ro = new ResizeObserver(() => {
      setSize({ w: svg.clientWidth, h: svg.clientHeight });
      if (!userMoved && (!raf || alpha < 0.05)) fit(false);
    });
    ro.observe(svg);
    onCleanup(() => {
      ro.disconnect(), cancelAnimationFrame(raf), cancelAnimationFrame(tween);
      for (const [id, b] of bodies) settled.set(id, { x: b.x, y: b.y });
    });
  });
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    cancelAnimationFrame(tween);
    userMoved = true;
    const r = svg.getBoundingClientRect();
    const v = view();
    if (e.ctrlKey || e.metaKey) {
      const z = Math.min(3, Math.max(0.25, v.z * Math.exp(-e.deltaY * 0.01)));
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      setView({ z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z });
    } else setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
  };
  const toGraph = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect(), v = view();
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const nodeEl = (e.target as Element).closest<SVGGElement>(".mg-node");
    const s = { x: e.clientX, y: e.clientY, v: view() };
    let moved = false;
    if (nodeEl) {
      // drag a node: it follows the pointer and pulls its neighbours along
      const id = nodeEl.dataset.id!;
      const b = bodies.get(id);
      if (!b) return;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < 4) return;
        moved = true;
        const p = toGraph(ev);
        b.fx = p.x, b.fy = p.y;
        heat(0.3);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        b.fx = b.fy = undefined;
        if (!moved) props.onSel(id);
        else (userMoved = true), heat(0.2);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    // pan the background; a plain click on it goes back to the whole graph
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < 4) return;
      moved = userMoved = true;
      cancelAnimationFrame(tween);
      setView({ ...s.v, x: s.v.x + ev.clientX - s.x, y: s.v.y + ev.clientY - s.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved && props.sel) props.onSel("");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // what's lit: the hovered node and its neighbours; in the whole graph also the selection's
  const near = createMemo(() => {
    const id = props.hover ?? (props.graph.focus ? undefined : props.sel || undefined);
    if (!id || !props.graph.byId.has(id)) return null;
    const s = new Set([id]);
    for (const e of props.graph.edges)
      if (e.kind === "hold") continue;
      else if (e.a === id) s.add(e.b);
      else if (e.b === id) s.add(e.a);
    return s;
  });
  const memCount = createMemo(() => props.graph.nodes.filter((n) => n.kind === "memory" && n.ring <= 1).length);
  // in the whole structure only the biggest topics carry a name until you zoom in
  const bigTopics = createMemo(() => new Set(props.graph.nodes.filter((n) => n.kind === "topic").sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, props.graph.focus ? 14 : 10).map((n) => n.id)));
  const showLabel = (n: GNode) => {
    const z = view().z;
    if (n.id === props.sel || n.id === props.hover || near()?.has(n.id)) return true;
    if (n.kind === "topic") return n.ring === 0 || bigTopics().has(n.id) || (!!props.graph.focus && n.ring <= 1 && memCount() <= 36) || z >= 1.3;
    if (isHub(n.kind)) return true;
    if (n.kind === "file") return !!props.graph.focus || z >= 1;
    return (!!props.graph.focus && n.ring <= 1 && memCount() <= 36) || z >= 1.8;
  };
  const labelOf = (n: GNode) => (n.kind === "memory" || n.kind === "entry" ? (n.label.length > 22 ? `${n.label.slice(0, 22)}…` : n.label) : n.label);
  /** the name in less room: a project told apart by its folder keeps its name, tight, with the folder's last
   *  name cut ("ondra·~", "ondra·01_Pr…"), so two homes of one repo still read as that repo; long names are cut */
  const shortOf = (n: GNode) => {
    if (!n.hint) return labelOf(n).length > 12 ? `${labelOf(n).slice(0, 11)}…` : labelOf(n);
    const last = n.hint.split("/").pop() || n.hint;
    return `${n.label}·${last.length > 6 ? `${last.slice(0, 5)}…` : last}`;
  };
  // names never sit on top of each other: the more important one wins, the other fades out
  const FS: Partial<Record<GNode["kind"], number>> = { global: 12, space: 12, project: 12, folder: 12, past: 12, topics: 12, topic: 11, memory: 11, file: 11, entry: 12 };
  /** a name never reads smaller than 11px on screen: zoomed out, it keeps its size (and more of them hide) */
  const MIN_PX = 11;
  const fsOf = (n: GNode) => Math.max(FS[n.kind] ?? 11, MIN_PX / view().z);
  const textW = (t: string, fs: number) => [...t].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 1 : 0.58), 0) * fs;
  /**
   * The names that fit, each "full" or "short", under its node or (when under is taken) over it.
   * A name that would cover another is first moved over its node, then shortened (a project told
   * apart by its folder: "ondra·홈", "ondra·01_Pr…"; a hub drops its count), and only
   * hidden when none of that fits. Hovered, it shows whole; its tooltip names it either way.
   */
  type Spot = { short: boolean; up: boolean; side?: "l" | "r" };
  const labelOn = createMemo(() => {
    tick();
    const rank = (n: GNode) => (n.id === props.sel || n.id === props.hover ? 0 : near()?.has(n.id) ? 1 : isHub(n.kind) ? 2 : 3);
    const cands = props.graph.nodes.filter(showLabel).sort((a, b) => rank(a) - rank(b) || b.r - a.r);
    /** `tight`: names of projects told apart by their folder that go short from the start */
    const place = (tight: Set<string>) => {
      const placed: number[][] = [];
      const on = new Map<string, Spot>();
      const free = (n: GNode, box: number[]) =>
        !placed.some((p) => p[0] < box[2] && box[0] < p[2] && p[1] < box[3] && box[1] < p[3]) &&
        // nor across another node
        !props.graph.nodes.some((o) => {
          const ob = o.id !== n.id && bodies.get(o.id);
          return ob && ob.x + o.r > box[0] && ob.x - o.r < box[2] && ob.y + o.r > box[1] && ob.y - o.r < box[3];
        });
      for (const n of cands) {
        const b = bodies.get(n.id);
        if (!b) continue;
        // file names repeat (AGENTS.md everywhere): only near what's picked or hovered
        if (n.kind === "file" && rank(n) > 1) continue;
        const fs = fsOf(n);
        const boxOf = (text: string, up: boolean, side?: "l" | "r") => {
          const w = textW(text, fs) / 2 + 2;
          if (side === "r") return [b.x + n.r + 2, b.y - fs * 0.6, b.x + n.r + 4 + w * 2, b.y + fs * 0.6];
          if (side === "l") return [b.x - n.r - 4 - w * 2, b.y - fs * 0.6, b.x - n.r - 2, b.y + fs * 0.6];
          return up ? [b.x - w, b.y - n.r - 4 - fs, b.x + w, b.y - n.r - 1] : [b.x - w, b.y + n.r + 1, b.x + w, b.y + n.r + 4 + fs];
        };
        const whole = labelOf(n) + (n.hint ? ` · ${n.hint}` : "") + (isHub(n.kind) && n.count ? ` ${n.count}` : "");
        const tries: Spot[] = n.hint && tight.has(n.label) && rank(n) > 0 ? [] : [{ short: false, up: false }, { short: false, up: true }];
        if (shortOf(n) !== whole) tries.push({ short: true, up: false }, { short: true, up: true });
        // a repo's second home is never left unnamed: beside its node when under and over are taken
        if (n.hint) tries.push({ short: true, up: false, side: "r" }, { short: true, up: false, side: "l" });
        const fit = rank(n) === 0 ? tries[0] : tries.find((x) => free(n, boxOf(x.short ? shortOf(n) : whole, x.up, x.side)));
        if (!fit) continue;
        placed.push(boxOf(fit.short ? shortOf(n) : whole, fit.up, fit.side));
        on.set(n.id, fit);
      }
      return on;
    };
    // two projects of one name read alike: when one has to go short (or can't show), both are short
    // from the start ("ondra·01_Pr…", "ondra·홈"), which also leaves the room for both
    const first = place(new Set());
    const cut = new Set(cands.filter((n) => n.hint && n.id !== props.hover && (first.get(n.id)?.short || !first.has(n.id))).map((n) => n.label));
    return cut.size ? place(cut) : first;
  });
  const nodeIds = createMemo(() => props.graph.nodes.map((n) => n.id));
  const edgeKey = (e: GEdge) => `${e.a}~${e.b}~${e.kind}`;
  const edgeBy = createMemo(() => new Map(props.graph.edges.map((e) => [edgeKey(e), e])));
  const edgeKeys = createMemo(() => props.graph.edges.filter((e) => e.kind !== "hold").map(edgeKey));
  const focusNode = () => (props.graph.focus ? props.graph.byId.get(props.graph.focus) : undefined);
  /** the shapes on screen that aren't circles, for the legend */
  const kinds = createMemo(() => ({ file: props.graph.nodes.some((n) => n.kind === "file"), entry: props.graph.nodes.some((n) => n.kind === "entry") }));
  return (
    <div class="mg" classList={{ local: !!props.graph.focus }}>
      <svg ref={svg} class="mg-svg" onWheel={onWheel} onPointerDown={onDown}>
        <g transform={`translate(${view().x} ${view().y}) scale(${view().z})`}>
          <For each={edgeKeys()}>
            {(k) => {
              const e = () => edgeBy().get(k);
              return (
                <Show when={e()}>
                  {(e) => (
                    <line
                      class={`mg-edge ${e().kind}`}
                      classList={{
                        dim: !!near() && !(near()!.has(e().a) && near()!.has(e().b)),
                        lit: !!near() && near()!.has(e().a) && near()!.has(e().b),
                        far: (props.graph.byId.get(e().a)?.ring ?? 0) >= 2 || (props.graph.byId.get(e().b)?.ring ?? 0) >= 2,
                      }}
                      style={{ "--w": e().w }}
                      x1={at(e().a).x}
                      y1={at(e().a).y}
                      x2={at(e().b).x}
                      y2={at(e().b).y}
                    />
                  )}
                </Show>
              );
            }}
          </For>
          <For each={nodeIds()}>
            {(id) => {
              const node = () => props.graph.byId.get(id);
              return (
                <Show when={node()}>
                  {(n) => (
                    <g
                      class={`mg-node k-${n().kind}${n().mk ? ` mk-${n().mk}` : ""}`}
                      classList={{
                        sel: props.sel === n().id,
                        dim: (!!near() && !near()!.has(n().id)) || !n().hit,
                        far: n().ring >= 2,
                        user: !!n().memory && userOwned(n().memory!),
                        rule: !!n().memory?.paths?.length,
                        past: !!n().memory?.invalidAt,
                        faded: !!n().memory && !n().memory!.invalidAt && faded(n().memory!),
                      }}
                      data-id={n().id}
                      transform={`translate(${at(n().id).x} ${at(n().id).y})`}
                      onPointerEnter={() => props.onHover(n().id)}
                      onPointerLeave={() => props.onHover(undefined)}
                    >
                      <Switch fallback={<circle r={n().r} />}>
                        <Match when={n().kind === "file"}><rect x={-n().r} y={-n().r} width={n().r * 2} height={n().r * 2} rx={1.5} /></Match>
                        <Match when={n().kind === "entry"}>
                          <rect class={`oc-${n().entry ? outcomeOf(n().entry!) : "done"}`} x={-n().r} y={-n().r} width={n().r * 2} height={n().r * 2} rx={2.5} transform="rotate(45)" />
                        </Match>
                      </Switch>
                      {/* the name on hover, also when it's hidden or shortened for room */}
                      <title>{n().kind === "project" && n().path ? `${homeName(n())}\n${tilde(n().path!)}` : n().hint ? homeName(n()) : n().label}</title>
                      <text
                        x={labelOn().get(n().id)?.side === "r" ? n().r + 4 : labelOn().get(n().id)?.side === "l" ? -n().r - 4 : 0}
                        y={labelOn().get(n().id)?.side ? fsOf(n()) * 0.35 : labelOn().get(n().id)?.up ? -n().r - 4 - fsOf(n()) * 0.25 : n().r + fsOf(n())}
                        text-anchor={labelOn().get(n().id)?.side === "r" ? "start" : labelOn().get(n().id)?.side === "l" ? "end" : "middle"} style={{ "font-size": `${fsOf(n())}px` }} classList={{ off: !labelOn().has(n().id) }}>
                        <Show when={!labelOn().get(n().id)?.short} fallback={shortOf(n())}>
                          {labelOf(n())}
                          <Show when={n().hint}><tspan class="mg-hint"> · {n().hint}</tspan></Show>
                          <Show when={isHub(n().kind) && n().count}><tspan class="mg-n"> {n().count}</tspan></Show>
                        </Show>
                      </text>
                    </g>
                  )}
                </Show>
              );
            }}
          </For>
        </g>
      </svg>
      <Show when={focusNode()}>
        {(f) => (
          <div class="mg-where">
            <button class="mg-back" onClick={() => props.onSel("")} title={t("전체 (Esc)")}><Icon name="back" size={14} />{t("전체")}</button>
            <span class="mg-where-name">{f().kind === "memory" ? t("메모리") : f().kind === "entry" ? t("작업 기록") : homeName(f())}</span>
          </div>
        )}
      </Show>
      <Show when={kinds().file || kinds().entry}>
        <div class="mg-legend">
          <Show when={kinds().file}><span><i class="lg-file" />{t("지침 파일")}</span></Show>
          <Show when={kinds().entry}><span><i class="lg-entry" />{t("작업 기록")}</span></Show>
        </div>
      </Show>
      <div class="mg-ctrl">
        <button class="icon-btn sm" title={t("화면에 맞추기")} aria-label={t("화면에 맞추기")} onClick={() => fit()}><Icon name="fit" size={14} /></button>
      </div>
    </div>
  );
}

// ───────────── tree

/** Folders like the ones on disk: 모든 일 · 공간 · 프로젝트, each with a folder per kind, 주제, 지난 기억 and its files. */
function MemTree(props: { model: Model; full: Model; sel: string; onSel: (id: string) => void; searching: boolean }) {
  let list!: HTMLDivElement;
  const [cursor, setCursor] = createSignal<string>();
  const [more, setMore] = createSignal<Record<string, number>>({});
  const isOpen = (n: TreeNode) => props.searching || (openMap()[n.key] ?? (n.key === `s:${state.space}` || !!n.open0));
  const shown = (n: TreeNode) => more()[n.key] ?? LIMIT;
  const toggle = (n: TreeNode, v = !isOpen(n)) => {
    if (n.children?.length) setOpen(n.key, v);
  };
  const scrollTo = (key: string) =>
    requestAnimationFrame(() => list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }));
  const choose = (n: TreeNode) => {
    setCursor(n.key);
    props.onSel(n.id);
    scrollTo(n.key);
  };

  // something picked in the graph or the side: open the folders down to it
  createEffect(
    on(
      () => props.sel,
      (id) => {
        if (!id) return setCursor(undefined);
        const cur = cursor();
        const rows = visibleRows(props.model.roots, isOpen, shown);
        if (cur && rows.some((r) => r.key === cur && r.id === id)) return;
        const row = rows.find((r) => r.id === id) ?? props.model.rowOf.get(id);
        if (!row) return;
        for (let k = props.model.up.get(row.key), child = row.key; k; child = k, k = props.model.up.get(k)) {
          const kn = findRow(props.model.roots, k);
          if (!props.searching && kn && !isOpen(kn)) setOpen(k, true);
          const parent = findRow(props.model.roots, k);
          const i = parent?.children?.findIndex((c) => c.key === child) ?? -1;
          if (parent && i >= shown(parent)) setMore((m) => ({ ...m, [parent.key]: i + 1 + LIMIT }));
        }
        setCursor(row.key);
        scrollTo(row.key);
      },
      { defer: true },
    ),
  );

  const onKey = (e: KeyboardEvent) => {
    if (!viewKey(e) || !noModifiers(e)) return;
    const rows = visibleRows(props.model.roots, isOpen, shown);
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.key === cursor());
    const n = rows[i];
    const go = (r?: TreeNode) => r && (e.preventDefault(), choose(r));
    if (e.key === "ArrowDown") go(rows[Math.min(rows.length - 1, i + 1)]);
    else if (e.key === "ArrowUp") go(rows[Math.max(0, i - 1)]);
    else if (e.key === "ArrowRight" && n) {
      e.preventDefault();
      if (n.children?.length && !isOpen(n)) toggle(n, true);
      else if (n.children?.length) go(rows[i + 1]);
    } else if (e.key === "ArrowLeft" && n) {
      e.preventDefault();
      if (n.children?.length && isOpen(n) && !props.searching) toggle(n, false);
      else go(rows.find((r) => r.key === props.model.up.get(n.key)));
    } else if ((e.key === "Enter" || e.key === " ") && n) {
      e.preventDefault();
      toggle(n);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onSel("");
    }
  };

  const Row = (p: { n: TreeNode; depth: number }) => {
    const folder = () => !!p.n.children?.length;
    const open = () => folder() && isOpen(p.n);
    const kids = () => p.n.children!.slice(0, shown(p.n));
    const rest = () => (p.n.children?.length ?? 0) - shown(p.n);
    const m = p.n.memory;
    return (
      <>
        <div
          class={`mt-row t-${p.n.type}${p.n.kind ? ` mk-${p.n.kind}` : ""}`}
          classList={{ on: props.sel === p.n.id, cur: cursor() === p.n.key, folder: folder() }}
          style={{ "--d": p.depth }}
          role="treeitem"
          aria-expanded={folder() ? open() : undefined}
          aria-selected={props.sel === p.n.id}
          data-key={p.n.key}
          title={m ? (m.uses ? `${m.text} · ${t("{n}번 사용", { n: m.uses })}` : m.text) : p.n.entry ? p.n.entry.title : p.n.now ? p.n.now.text : p.n.type === "home" && p.n.path && !props.full.homes.get(p.n.id)?.parent?.startsWith("s:") ? `${tilde(p.n.path)}/.ondra/memory` : p.n.path ? tilde(p.n.path) : undefined}
          onClick={() => {
            if (folder() && (props.sel === p.n.id || !open())) toggle(p.n, props.sel === p.n.id ? !open() : true);
            choose(p.n);
          }}
        >
          <Show when={folder()} fallback={<span class="mt-chev" />}>
            <span
              class="mt-chev"
              classList={{ on: open() }}
              onClick={(e) => {
                e.stopPropagation();
                toggle(p.n);
              }}
            >
              <Icon name="chevron" size={11} />
            </span>
          </Show>
          <Switch fallback={<Icon name="folder" size={13} class="mt-ic dir" />}>
            <Match when={p.n.type === "file"}><Icon name="file" size={13} class="mt-ic ext" /></Match>
            <Match when={p.n.type === "entry"}><Icon name="file" size={13} class={`mt-ic md oc-${outcomeOf(p.n.entry!)}`} /></Match>
            <Match when={p.n.type === "memory"}><Icon name="file" size={13} class={`mt-ic md mk-${m ? kindOf(m) : "fact"}${m?.invalidAt ? " past" : ""}`} /></Match>
            <Match when={p.n.type === "now" || p.n.type === "index" || p.n.type === "topic"}><Icon name="file" size={13} class="mt-ic md" /></Match>
          </Switch>
          <span class="mt-name" classList={{ past: !!m?.invalidAt, faint: !!m && !m.invalidAt && faded(m) }}>
            {p.n.label}
            <Show when={p.n.hint}><span class="mt-hint"> · {p.n.hint}</span></Show>
          </span>
          <Switch>
            <Match when={m}>{(mm) => <Badges m={mm()} />}</Match>
            <Match when={p.n.type === "entry"}>
              <Show when={p.n.entry!.learned?.length}><span class="mt-learn" title={t("배운 메모리")}>+{p.n.entry!.learned!.length}</span></Show>
              <span class="mt-n">{clock(p.n.entry!.at)}</span>
            </Match>
            <Match when={p.n.type === "now"}><span class="mt-n">{ago(p.n.now!.at)}</span></Match>
            <Match when={p.n.type !== "file" && p.n.count}><span class="mt-n">{p.n.count}</span></Match>
          </Switch>
        </div>
        <Show when={folder()}>
          <Fold open={open()}>
            <div class="mt-kids" style={{ "--d": p.depth }} role="group">
              <For each={kids()}>{(k) => <Row n={k} depth={p.depth + 1} />}</For>
              <Show when={rest() > 0}>
                <button class="mt-row mt-more" style={{ "--d": p.depth + 1 }} onClick={() => setMore((x) => ({ ...x, [p.n.key]: shown(p.n) + 200 }))}>
                  <span class="mt-chev" />
                  {t("{n}개 더", { n: rest() })}
                </button>
              </Show>
            </div>
          </Fold>
        </Show>
      </>
    );
  };

  // add a piece where you are: the folder's home, its kind, its topic
  const [text, setText] = createSignal("");
  const target = createMemo(() => {
    const id = props.sel;
    const full = props.full;
    let home = "g";
    let kind: MemoryKind | undefined;
    let about: string | undefined;
    const curRow = cursor() ? findRow(props.model.roots, cursor()!) : undefined;
    if (id.startsWith("m:")) {
      const m = full.memById.get(id.slice(2));
      if (m) home = [...full.homes.values()].find((h) => h.live.includes(m) || h.past.includes(m))?.id ?? "g";
    } else if (id.startsWith("t:")) {
      home = curRow?.home ?? "g";
      about = full.topics.get(id.slice(2))?.label;
    } else if (id.startsWith("f:")) home = curRow?.home ?? "g";
    else if (id.startsWith("n:")) home = full.nows.get(id.slice(2))?.home ?? "g";
    else if (id && !id.startsWith("j")) {
      const k = /^(.+)\|k:(\w+)$/.exec(id);
      home = k ? k[1] : id.replace(/\|(past|t)$/, "");
      if (k) kind = k[2] as MemoryKind;
    }
    const h = full.homes.get(home) ?? full.homes.get("g")!;
    const where = [homeName(h), kind ? t(kindLabel(kind)) : about].filter(Boolean).join(" · ");
    return { h, kind, about, where };
  });
  const addHere = () => {
    const t = target();
    const v = text().trim();
    if (!v) return;
    const opts = { quiet: true, kind: t.kind, about: t.about ? [t.about] : undefined };
    if (t.h.kind === "project") {
      const p = (state.projects ?? []).find((x) => expand(x.folder) === t.h.path);
      addMemory(v, "project", { ...opts, project: p?.folder ?? t.h.path, space: t.h.space });
    } else if (t.h.kind === "space") addMemory(v, "space", { ...opts, space: t.h.space });
    else addMemory(v, "global", opts);
    setText("");
  };
  return (
    <aside class="mt">
      <div class="mt-list" classList={{ searching: props.searching }} ref={list} tabindex="0" role="tree" aria-label={t("메모리 폴더")} onKeyDown={onKey}>
        <For each={props.model.roots} fallback={<div class="mt-none">{t("없음")}</div>}>{(n) => <Row n={n} depth={0} />}</For>
      </div>
      <form class="mt-add" onSubmit={(e) => (e.preventDefault(), addHere())}>
        <input placeholder={t("{where}에 메모리 추가", { where: target().where })} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </form>
    </aside>
  );
}

function findRow(roots: TreeNode[], key: string): TreeNode | undefined {
  for (const n of roots) {
    if (n.key === key) return n;
    if (n.children) {
      const f = findRow(n.children, key);
      if (f) return f;
    }
  }
  return undefined;
}
