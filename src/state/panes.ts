// Panes on screen: which pane a component is drawn in, and the layouts kept between launches
// (one per space, like the panel's tabs in workspace.ts).
import { type Accessor, createContext, createEffect, onCleanup, useContext } from "solid-js";
import * as L from "./layout";
import { layout, setLayout, view, type PaneLayout, type PaneState, type View } from "./ui";

export interface PaneInfo {
  id: string;
  /** what this pane shows */
  view: Accessor<View>;
  /** it has the focus (the sidebar and the keyboard act on it) */
  focused: Accessor<boolean>;
}
export const PaneCtx = createContext<PaneInfo>();
/** The pane this component is drawn in (none outside the panes: settings, the panel, overlays). */
export const usePane = () => useContext(PaneCtx);
/** The view this component belongs to: its pane's, or the focused one's outside the panes. */
export const useView = (): Accessor<View> => usePane()?.view ?? view;
/** Keys and focus a component takes only while its pane has the focus (always outside the panes). */
export const usePaneFocused = (): Accessor<boolean> => usePane()?.focused ?? (() => true);

// ── kept between launches
const KEY = "ondra.panes";
const NAMES = new Set(["main", "task", "board", "devices", "memory", "results", "changes"]);
const read = (): Record<string, unknown> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};
/** the other spaces' layouts, as left (read back when switching to them) */
const kept: Record<string, unknown> = typeof localStorage === "undefined" ? {} : read();

/** A stored pane, or null when it can't come back (its job is gone). */
function paneFrom(x: unknown, exists: (v: View) => boolean): PaneState | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Partial<PaneState>;
  const ok = (v: unknown): v is View => !!v && typeof v === "object" && NAMES.has((v as View).name) && exists(v as View);
  if (!ok(p.view)) return null;
  const list = (l: unknown) => (Array.isArray(l) ? l.filter(ok).slice(-20) : []);
  const draft = p.draft && typeof p.draft === "object" ? { project: typeof p.draft.project === "string" ? p.draft.project : undefined, from: ok(p.draft.from) ? p.draft.from : undefined } : null;
  return { view: p.view, past: list(p.past), ahead: list(p.ahead), draft, fresh: !!p.fresh && !!draft };
}
/** settings fill the window and aren't a pane's place: a pane on settings comes back where it was before */
function storable(l: PaneLayout): PaneLayout {
  const panes = Object.fromEntries(
    Object.entries(l.panes).map(([id, p]) => {
      if (p.view.name !== "settings") return [id, { ...p, past: p.past.slice(-20), ahead: p.ahead.slice(-20) }];
      const back = [...p.past].reverse().find((v) => v.name !== "settings") ?? { name: "main" as const };
      return [id, { ...p, view: back, past: [], ahead: [] }];
    }),
  );
  return { ...l, panes };
}

/** The layout a space was left with, its gone jobs dropped; null when none (or nothing is left). */
export function layoutOf(space: string, exists: (v: View) => boolean): PaneLayout | null {
  return L.parse(kept[space], (x) => paneFrom(x, exists));
}
/** Keep a space's layout (when leaving it, and as it changes). */
export function keepLayout(space: string, l: PaneLayout) {
  kept[space] = storable(l);
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* private mode */
  }
}

/** On launch: the space's last layout comes back; then every change is kept (a moment later). */
export function keepPanes(space: () => string, exists: (v: View) => boolean) {
  const back = layoutOf(space(), exists);
  if (back) setLayout(back);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const l = layout();
    const sp = space();
    clearTimeout(timer);
    timer = setTimeout(() => keepLayout(sp, l), 300);
  });
  onCleanup(() => clearTimeout(timer));
}
