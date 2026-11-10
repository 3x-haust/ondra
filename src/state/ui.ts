// Live, unsaved UI state: routing, panels, streaming text, toasts.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as L from "./layout";

export type View =
  /** the main conversation of the current space */
  | { name: "main"; project?: string }
  /** a fork or one of its subagents */
  | { name: "task"; id: string }
  /** every job at a glance */
  | { name: "board" }
  /** simulators, emulators and phones */
  | { name: "devices"; device?: string }
  /** the one browser every job shares (sign in here once) */
  /** what the agents remember: graph + file tree */
  | { name: "memory" }
  /** what finished jobs came back with */
  | { name: "results"; id?: string }
  /** a job's changes in a full-size diff editor, on one of its files */
  | { name: "changes"; id: string; path?: string }
  | { name: "settings"; tab?: SettingsTab };

export type SettingsTab = "general" | "shortcuts" | "accounts" | "import" | "skills" | "agent-tools" | "hooks" | "tools";
/** What a panel tab shows. "new" is the empty tab that lists the tools. */
export type PanelTab = "new" | "flow" | "side" | "artifacts" | "changes" | "pr" | "files" | "terminal" | "browser" | "overview" | "preview" | "reverse" | "issues";

// ── the center is a tree of panes (src/state/layout.ts), each with its own view and history.
// One pane has the focus: `view()` is its view, and the sidebar, palette and openTask() act on it.
/** The new-task screen open over Main in a pane: the project it is for, and the view to go back to. */
export interface Draft {
  project?: string;
  from?: View;
}
export interface PaneState {
  view: View;
  past: View[];
  ahead: View[];
  draft?: Draft | null;
  /** opened as a split and not moved yet: closing its new-task screen closes the pane */
  fresh?: boolean;
}
export type PaneLayout = L.Layout<PaneState>;
export const blankPane = (v: View = { name: "main" }): PaneState => ({ view: v, past: [], ahead: [] });
let paneSeq = 1;
export const newPaneId = () => `p${Date.now().toString(36)}${(++paneSeq).toString(36)}`;
const [layout, setLayoutShown] = createSignal<PaneLayout>(L.single("p1", blankPane()));
const [view, setViewShown] = createSignal<View>({ name: "main" });
export { layout, view };
export const focusId = () => layout().focus;
export const paneCount = () => Object.keys(layout().panes).length;
export const paneState = (id: string): PaneState | undefined => layout().panes[id];
// what lives only on Main (the new-task screen) closes when you go anywhere else
const leavingMain: (() => void)[] = [];
export const onLeaveMain = (f: () => void) => void leavingMain.push(f);
/** Put a layout on screen; the focused pane's view becomes the app's view (and the panel follows it). */
export function setLayout(l: PaneLayout) {
  const was = layout();
  const before = was.panes[was.focus]?.view;
  const to = l.panes[l.focus].view;
  if (to !== before || l.focus !== was.focus) {
    if (to.name !== "main" && before?.name === "main") leavingMain.forEach((f) => f());
    // the panel's tabs first, so the view opens on its own tab
    enterPlace(to);
  }
  setLayoutShown(l);
  setViewShown(to);
}
function updatePane(id: string, f: (p: PaneState) => PaneState) {
  const l = layout();
  const p = l.panes[id];
  if (p) setLayout({ ...l, panes: { ...l.panes, [id]: f(p) } });
}

// Where you have been, for ⌘[ and ⌘]: each move to another place is kept; moving
// within one place (another result, another settings tab) replaces it. Every pane has its own.
const HISTORY = 50;
const samePlace = (a: View, b: View) =>
  a.name === b.name && (a.name === "task" || a.name === "main" ? JSON.stringify(a) === JSON.stringify(b) : a.name === "changes" ? a.id === (b as { id: string }).id : true);
/** Show a view in one pane (its new-task screen closes, as on any move). */
export function setPaneView(id: string, v: View) {
  const p = layout().panes[id];
  if (!p || JSON.stringify(p.view) === JSON.stringify(v)) return;
  const prev = p.view;
  updatePane(id, (p) =>
    samePlace(prev, v)
      ? { ...p, view: v, draft: null, fresh: false }
      : { ...p, view: v, past: [...p.past, prev].slice(-HISTORY), ahead: [], draft: null, fresh: false },
  );
}
/** The other pane already showing this place (a job, a chat, the board…), so it isn't opened twice. */
export function shownIn(v: View, except = layout().focus): string | undefined {
  if (v.name === "settings") return undefined;
  const l = layout();
  return L.leaves(l.root).find((id) => {
    const p = l.panes[id];
    if (id === except || p.draft) return false;
    if (v.name === "task" || v.name === "main" || v.name === "changes") return p.view.name === v.name && samePlace(p.view, v);
    return p.view.name === v.name;
  });
}
export function setView(v: View) {
  const other = shownIn(v);
  if (other) {
    focusPane(other);
    return setPaneView(other, v);
  }
  setPaneView(layout().focus, v);
}
/** Go back (-1) or forward (1) in the focused pane; `ok` skips places that are gone (a deleted job). */
export function stepView(dir: -1 | 1, ok: (v: View) => boolean = () => true) {
  const id = layout().focus;
  const p = layout().panes[id];
  const from = dir < 0 ? p.past : p.ahead;
  let i = from.length - 1;
  while (i >= 0 && !ok(from[i])) i--;
  if (i < 0) return false;
  const rest = from.slice(0, i);
  updatePane(id, (p) =>
    dir < 0
      ? { ...p, view: from[i], past: rest, ahead: [...p.ahead, p.view], draft: null, fresh: false }
      : { ...p, view: from[i], ahead: rest, past: [...p.past, p.view].slice(-HISTORY), draft: null, fresh: false },
  );
  return true;
}
export const canStep = (dir: -1 | 1) => {
  const p = layout().panes[layout().focus];
  return (dir < 0 ? p.past : p.ahead).length > 0;
};
/** The new-task screen of the focused pane (the sidebar's 새 작업 lights up for it). */
export const newTaskOpen = () => layout().panes[layout().focus].draft ?? null;
export const paneDraft = (id: string) => layout().panes[id]?.draft ?? null;
export function setPaneDraft(id: string, d: Draft | null) {
  const p = layout().panes[id];
  if (p && (p.draft ?? null) !== d) updatePane(id, (p) => ({ ...p, draft: d, fresh: d ? p.fresh : false }));
}
export const setNewTaskOpen = (d: Draft | null) => setPaneDraft(layout().focus, d);

/** The pane's element on screen (none outside the app, or in settings). */
export function paneEl(id = layout().focus): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-pane="${id}"]`);
}
/** An element of the focused pane (of the document when no pane is on screen). */
export function inPane<T extends Element = HTMLElement>(sel: string, id?: string): T | null {
  if (typeof document === "undefined") return null;
  const el = paneEl(id);
  return el ? el.querySelector<T>(sel) : document.querySelector<T>(sel);
}

// ── pane commands (Ghostty's split actions)
/** The area the panes share, measured by the pane host (none in tests: everything fits). */
let roomOf: () => L.Room | null = () => null;
export const setPaneRoom = (f: () => L.Room | null) => void (roomOf = f);
export const paneRoom = () => roomOf();
/** when the focus last moved to another pane (a click on its panel button right after shouldn't close the panel) */
let movedAt = 0;
export function focusPane(id: string) {
  const l = layout();
  if (!l.panes[id]) return;
  if (l.focus !== id) movedAt = Date.now();
  setLayout(L.focus(l, id));
}
/** A new pane beside the focused one (or `target`), showing `p` (the new-task screen when not given).
 *  Returns its id, or null when it wouldn't leave every pane its minimum size. */
export function splitPane(dir: L.Dir, p?: Partial<PaneState>, target = layout().focus): string | null {
  const l = layout();
  if (p?.view && !p.draft) {
    const other = shownIn(p.view, "");
    if (other) return (focusPane(other), other);
  }
  const room = roomOf();
  if (room && !L.canSplit(l, target, dir, room)) {
    toast("창을 나눌 공간이 부족해요");
    return null;
  }
  const id = newPaneId();
  const pane: PaneState = p?.view ? { ...blankPane(p.view), ...p } : { ...blankPane(), draft: {}, fresh: true, ...p };
  setLayout(L.split(l, target, dir, id, pane));
  return id;
}
/** Close a pane (the focused one): the last pane stays; a job shown in it keeps running. */
export function closePane(id = layout().focus) {
  const l = layout();
  if (L.leaves(l.root).length < 2) return false;
  setLayout(L.remove(l, id));
  return true;
}
export function gotoPane(to: L.Dir | "previous" | "next") {
  const l = layout();
  const id = to === "previous" || to === "next" ? L.step(l.root, l.focus, to === "next" ? 1 : -1) : L.neighbour(l.root, l.focus, to);
  if (id) focusPane(id);
  return !!id;
}
export const toggleZoom = () => setLayout(L.toggleZoom(layout()));
export const equalizePanes = (only?: string) => setLayout(L.equalize(layout(), only));
/** Ghostty moves the divider 10px a press; a chat column needs bigger steps to feel like it moved. */
const RESIZE_STEP = 40;
export function resizePane(dir: L.Dir, px = RESIZE_STEP) {
  const room = roomOf() ?? { w: 1440, h: 900, gap: 0, minW: 0, minH: 0 };
  setLayout(L.resize(layout(), layout().focus, dir, px, room));
}
export function setSplitRatio(splitId: string, ratio: number) {
  setLayout(L.setRatio(layout(), splitId, ratio, roomOf() ?? undefined));
}
/** A memory piece the Memory view should select when it opens (set with setView({ name: "memory" })). */
export const [memoryFocus, setMemoryFocus] = createSignal<string | null>(null);
export const [panelOpen, setPanelOpen] = createSignal(false);

// ── the right panel works like a browser: tabs you open (+), switch and close (×)
export interface PTab {
  id: number;
  kind: PanelTab;
}
let tabSeq = 1;
export const [ptabs, setPtabs] = createSignal<PTab[]>([{ id: 1, kind: "flow" }]);
export const [activeTab, setActiveTab] = createSignal(1);
export const panelTab = (): PanelTab => ptabs().find((t) => t.id === activeTab())?.kind ?? "new";
/** Show a tool: switch to its tab, or turn the empty tab into it, or open a new tab. */
export function setPanelTab(kind: PanelTab) {
  const have = ptabs().find((t) => t.kind === kind);
  if (have) return setActiveTab(have.id);
  const cur = ptabs().find((t) => t.id === activeTab());
  if (cur?.kind === "new" && kind !== "new") {
    setPtabs((l) => l.map((t) => (t.id === cur.id ? { ...t, kind } : t)));
    return;
  }
  const id = ++tabSeq;
  setPtabs((l) => [...l, { id, kind }]);
  setActiveTab(id);
}
export function newPanelTab() {
  setPanelTab("new");
  setPanelOpen(true);
}
export function closePanelTab(id: number) {
  const list = ptabs();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return;
  const rest = list.filter((t) => t.id !== id);
  if (!rest.length) {
    closePanel();
    setTimeout(() => {
      setPtabs([{ id: ++tabSeq, kind: "new" }]);
      setActiveTab(tabSeq);
    }, 300);
    return;
  }
  setPtabs(rest);
  if (activeTab() === id) setActiveTab(rest[Math.min(i, rest.length - 1)].id);
}

// ── the panel's tabs follow you between places (Main, each task): every place comes back
// on the tab it was left on; a tab that only makes sense for the last task (its browser page,
// a file it opened) doesn't carry to the next one, and a place seen for the first time
// keeps the tab you were on if it applies there, else Flow.
type Place = string;
const placeOf = (v: View): Place | null => (v.name === "task" ? v.id : v.name === "main" ? "main" : null);
let place: Place | null = "main";
const lastTab = new Map<Place, PanelTab>();
/** What a tab is to a place: shown, kept out of sight for later (a task's tab on Main), or dropped.
 *  The panel fills this in (it knows the tasks). */
export type TabFit = "use" | "keep" | "drop";
let tabFits: (place: Place, kind: PanelTab) => TabFit = () => "use";
export const setTabFits = (f: typeof tabFits) => void (tabFits = f);
/** The place was left on a tab before (it comes back on that one). */
export const hadTab = (p: Place) => lastTab.has(p);
/** Where the file preview was opened: it belongs there. */
let previewAt: Place | null = null;
export const previewPlace = () => previewAt;
function enterPlace(v: View) {
  const to = placeOf(v);
  if (!to || to === place) return;
  if (place) lastTab.set(place, panelTab());
  place = to;
  const cur = ptabs().find((t) => t.id === activeTab());
  const keep = ptabs().filter((t) => t.kind === "new" || tabFits(to, t.kind) !== "drop");
  if (keep.length !== ptabs().length) setPtabs(keep.length ? keep : [{ id: ++tabSeq, kind: "flow" }]);
  const back = lastTab.get(to);
  if (back && back !== "new" && tabFits(to, back) === "use") return setPanelTab(back);
  if (cur && keep.includes(cur) && (cur.kind === "new" || tabFits(to, cur.kind) === "use")) return;
  setPanelTab("flow");
}
/** File the panel should show: its diff (Changes) or its contents (Files). Path is relative to the task folder. */
export const [panelFile, setPanelFile] = createSignal<{ path: string; mode: "diff" | "file"; n: number } | null>(null);
let fileSeq = 0;
/** The panel's browser shows the shared browser (sign in, browse) rather than the job's own tab. */
export const [panelShared, setPanelShared] = createSignal(false);
export function openPanel(tab: PanelTab, file?: string, mode: "diff" | "file" = tab === "files" ? "file" : "diff") {
  if (tab === "browser") setPanelShared(false);
  setPanelTab(tab);
  setPanelOpen(true);
  if (file) setPanelFile({ path: file, mode, n: ++fileSeq });
}
/** A page the in-app browser should open next (it takes it when shown). */
export const [browserTarget, setBrowserTarget] = createSignal<string | null>(null);
/** The page the panel's browser shows now ("" when none), for 기본 브라우저에서 열기 in the palette. */
export const [browserPage, setBrowserPage] = createSignal("");
/** The in-app browser in the right panel, next to the conversation; opens `url` when given. */
export function openBrowser(url?: string) {
  if (url) setBrowserTarget(url);
  openPanel("browser");
  setPanelShared(true);
}
/** Any file, opened inside the app (panel "미리보기"); VS Code and Finder are a click away. */
export const [previewPath, setPreviewPath] = createSignal<string | null>(null);
export function previewFile(path: string) {
  // links come URL-encoded ("Application%20Support"): open the real file
  let p = path.replace(/^file:\/\//, "").replace(/:\d+(:\d+)?$/, "");
  if (/%[0-9a-f]{2}/i.test(p)) {
    try {
      p = decodeURIComponent(p);
    } catch {}
  }
  setPreviewPath(p.startsWith("~/") ? p : p);
  previewAt = placeOf(view());
  openPanel("preview");
}
export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [paletteMode, setPaletteMode] = createSignal<"all" | "commands">("all");
/** The user message being edited in place (entry or message id). */
export const [editing, setEditing] = createSignal<string | null>(null);
/** The left list folded away (⌘B). */
export const [sidebarHidden, setSidebarHidden] = createSignal(false);
/** Window wide enough for list + chat + panel side by side. */
export const [roomy, setRoomy] = createSignal(typeof window === "undefined" || window.innerWidth >= 1200);
if (typeof window !== "undefined") window.addEventListener("resize", () => setRoomy(window.innerWidth >= 1200));
/** The panel belongs to a task (and Main): elsewhere it stays hidden, its tabs kept for later. */
export const panelShown = () => panelOpen() && (view().name === "task" || view().name === "main");
/** The list is out of the way: folded by you, or making room for a panel in a narrow window. */
export const sidebarAway = () => sidebarHidden() || (crowded() && panelShown());
/** The narrowest the split panes can be side by side (set by the pane host; 0 for one pane). */
export const [splitNeed, setSplitNeed] = createSignal(0);
const [winW, setWinW] = createSignal(typeof window === "undefined" ? 1440 : window.innerWidth);
if (typeof window !== "undefined") window.addEventListener("resize", () => setWinW(window.innerWidth));
/** list, panes and panel can't all be side by side: the list makes room (the widest list and the panel's own width) */
const crowded = () => !roomy() || winW() - 320 - 440 - 32 < splitNeed();
/** The job the pointer is over, in the graph or a chip: main lights up the message that started it. */
export const [hoverTask, setHoverTask] = createSignal<string | null>(null);
/** Bring the list back (in a narrow window that means closing the panel). */
export function showSidebar() {
  setSidebarHidden(false);
  if (crowded()) closePanel();
}

export function toggleSidebar() {
  if (sidebarAway()) showSidebar();
  else setSidebarHidden(true);
}

export const openTask = (id: string) => setView({ name: "task", id });
/** A job's changes in the full-size editor, on `path` (from the repo top) when given; the pane already showing them moves to it. */
export const openChanges = (id: string, path?: string) => setView(path ? { name: "changes", id, path } : { name: "changes", id });
export const goMain = (project?: string) => {
  const v: View = project ? { name: "main", project } : { name: "main" };
  // the new-task screen over this same chat closes (it is already the view, so nothing else would)
  const p = layout().panes[layout().focus];
  if (p.draft && !shownIn(v) && samePlace(p.view, v)) setPaneDraft(layout().focus, null);
  setView(v);
  setTimeout(() => inPane<HTMLTextAreaElement>("#main-input")?.focus(), 30);
};
/** old name, used by shortcuts */
export const newTask = goMain;

/** Text an agent is writing right now, per agent id (task id or captain:<space>). */
export const [live, setLive] = createStore<Record<string, string>>({});

// ── toasts ──
export interface Toast {
  id: number;
  text: string;
  tone: "info" | "bad";
  action?: { label: string; run: () => void };
  /** stays until its button or close is pressed */
  stay?: boolean;
}
export const [toasts, setToasts] = createSignal<Toast[]>([]);
let seq = 0;
/** each passing toast's timer and how long it stays; hovering a toast holds it */
const timers = new Map<number, { ms: number; timer?: ReturnType<typeof setTimeout> }>();
export const dropToast = (id: number) => {
  clearTimeout(timers.get(id)?.timer);
  timers.delete(id);
  setToasts((t) => t.filter((x) => x.id !== id));
};
export function holdToast(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t.timer);
}
export function releaseToast(id: number) {
  const t = timers.get(id);
  if (t) t.timer = setTimeout(() => dropToast(id), Math.min(t.ms, 2000));
}
/** One toast at a time (DESIGN.md §9.10): a new one replaces the passing one; kept ones wait under it. 3s, 6s with an action or an error. */
export function toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"], opts: { stay?: boolean; ms?: number } = {}) {
  const id = ++seq;
  for (const x of toasts()) if (!x.stay) (clearTimeout(timers.get(x.id)?.timer), timers.delete(x.id));
  setToasts((t) => [...t.filter((x) => x.stay), { id, text, tone, action, stay: opts.stay }]);
  if (!opts.stay) {
    const ms = opts.ms ?? (action || tone === "bad" ? 6000 : 3000);
    timers.set(id, { ms, timer: setTimeout(() => dropToast(id), ms) });
  }
  return id;
}

/** Set by the open panel: plays its slide-out and resolves when done. */
let leave: (() => Promise<unknown>) | null = null;
export const setPanelLeave = (f: (() => Promise<unknown>) | null) => (leave = f);
/** Close the right panel (the center stays as it is). */
/** The panel takes the whole center (the chat steps aside) until it's put back, closed, or another view is picked. */
export const [panelWide, setPanelWide] = createSignal(false);
export async function closePanel() {
  setPanelWide(false);
  if (!panelOpen()) return;
  const f = leave;
  leave = null;
  if (f) await f().catch(() => undefined);
  setPanelOpen(false);
}
export function togglePanel() {
  // pressed in a pane beside the one it showed: the panel now shows this pane's tools, open
  if (panelOpen() && Date.now() - movedAt < 350) return;
  if (panelOpen()) void closePanel();
  else {
    if (!ptabs().length) setPanelTab("flow");
    setPanelOpen(true);
  }
}
/** Open the right side on the flow (no job needed). */
export function openFlow() {
  setPanelTab("flow");
  setPanelOpen(true);
}

/** A main message to scroll to once the main view shows it (set before switching to it). */
export const [jumpMsg, setJumpMsg] = createSignal<string>();
