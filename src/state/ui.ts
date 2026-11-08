// Live, unsaved UI state: routing, panels, streaming text, toasts.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

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
  | { name: "settings"; tab?: SettingsTab };

export type SettingsTab = "general" | "shortcuts" | "accounts" | "import" | "skills" | "agent-tools" | "hooks" | "tools";
/** What a panel tab shows. "new" is the empty tab that lists the tools. */
export type PanelTab = "new" | "flow" | "side" | "artifacts" | "changes" | "pr" | "files" | "terminal" | "browser" | "overview" | "preview" | "reverse";

export const [view, setView] = createSignal<View>({ name: "main" });
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
/** The list is out of the way: folded by you, or making room for a panel in a narrow window. */
export const sidebarAway = () => sidebarHidden() || (!roomy() && panelOpen());
/** The job the pointer is over, in the graph or a chip: main lights up the message that started it. */
export const [hoverTask, setHoverTask] = createSignal<string | null>(null);
/** Bring the list back (in a narrow window that means closing the panel). */
export function showSidebar() {
  setSidebarHidden(false);
  if (!roomy()) closePanel();
}

export function toggleSidebar() {
  if (sidebarAway()) showSidebar();
  else setSidebarHidden(true);
}

export const openTask = (id: string) => setView({ name: "task", id });
export const goMain = (project?: string) => {
  setView(project ? { name: "main", project } : { name: "main" });
  setTimeout(() => document.getElementById("main-input")?.focus(), 30);
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
export const dropToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
export function toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"], opts: { stay?: boolean; ms?: number } = {}) {
  const id = ++seq;
  setToasts((t) => [...t.slice(-2), { id, text, tone, action, stay: opts.stay }]);
  if (!opts.stay) setTimeout(() => dropToast(id), opts.ms ?? (tone === "bad" ? 7000 : 4000));
  return id;
}

/** Set by the open panel: plays its slide-out and resolves when done. */
let leave: (() => Promise<unknown>) | null = null;
export const setPanelLeave = (f: (() => Promise<unknown>) | null) => (leave = f);
/** Close the right panel (the center stays as it is). */
export async function closePanel() {
  if (!panelOpen()) return;
  const f = leave;
  leave = null;
  if (f) await f().catch(() => undefined);
  setPanelOpen(false);
}
export function togglePanel() {
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
