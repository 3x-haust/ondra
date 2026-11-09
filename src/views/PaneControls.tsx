// What every pane can do, from its header, the keyboard and the sidebar: split, zoom, close,
// go to the one that needs you, and take a job dragged from the sidebar.
import { createSignal, Show } from "solid-js";
import * as L from "../state/layout";
import { closePane, equalizePanes, focusPane, layout, paneCount, paneRoom, setPaneView, splitPane, toggleZoom, view, type View } from "../state/ui";
import { usePane } from "../state/panes";
import { projectById, state, taskById } from "../state/store";
import { shortcutHint } from "../lib/shortcuts";
import { Icon } from "../ui/Icon";
import { openMenuAt, type MenuEntry } from "../ui/taskMenu";
import { nextWaiting, stateMeta } from "./Sidebar";
import { t } from "../i18n";

const MAIN: View = { name: "main" };

// ───────────── commands the keyboard and menus share

/** The project a new task next to the focused pane starts in: the one in view. */
function projectHere(): string | undefined {
  const v = view();
  const id = v.name === "main" ? v.project : v.name === "task" ? taskById(v.id)?.project : undefined;
  return id && projectById(id)?.space === state.space ? id : undefined;
}
/** A new pane on the new-task screen (start another agent beside the one you watch). */
export function splitNew(dir: L.Dir) {
  splitPane(dir, { view: MAIN, draft: { project: projectHere() }, fresh: true });
}
/** A job in a new pane beside the focused one (or the pane already showing it). */
export const openInSplit = (id: string, dir: L.Dir = "right") => splitPane(dir, { view: { name: "task", id } });

const inPanel = () => !!document.activeElement?.closest?.(".panel");
export const canClosePane = () => paneCount() > 1 && view().name !== "settings" && !inPanel();
let closedAt = 0;
export function closeFocused() {
  if (closePane()) closedAt = Date.now();
}
/** ⌘W from the app menu: the focused pane when there are several, else the panel (false: not handled here). */
export function menuClose(): boolean {
  if (Date.now() - closedAt < 400) return true; // the key itself already closed one
  if (!canClosePane()) return false;
  closeFocused();
  return true;
}

/** What a pane's job needs from you: an answer, a look at a failure, or a merge. */
export function needs(id: string): "ask" | "bad" | "review" | null {
  const v = layout().panes[id]?.view;
  const x = v?.name === "task" ? taskById(v.id) : undefined;
  if (!x) return null;
  const tone = stateMeta(x).tone;
  return tone === "ask" || tone === "bad" || tone === "review" ? tone : null;
}
const shownTask = (id: string) => Object.values(layout().panes).some((p) => p.view.name === "task" && p.view.id === id);
function waitingElsewhere() {
  const x = nextWaiting(state.space);
  return x && !shownTask(x.id) ? x : undefined;
}
export const hasAttention = () => L.leaves(layout().root).some((id) => id !== layout().focus && !!needs(id)) || !!waitingElsewhere();
/** 다음 내 차례 창으로: the next pane whose job needs you, or that job opened beside this one. */
export function nextAttention() {
  const l = layout();
  const ids = L.leaves(l.root);
  const i = ids.indexOf(l.focus);
  for (let k = 1; k < ids.length; k++) {
    const id = ids[(i + k) % ids.length];
    if (needs(id)) return focusPane(id);
  }
  const x = waitingElsewhere();
  if (!x) return;
  const room = paneRoom();
  if (!room || L.canSplit(l, l.focus, "right", room)) openInSplit(x.id);
  else setPaneView(l.focus, { name: "task", id: x.id });
}

// ───────────── the pane's own controls, at the end of its view's header

const [alone, setAlone] = createSignal(false);
/** In a view's header: 확대됨, the split menu and ✕ (shown on hover, or while the pane has the focus). */
export function PaneControls() {
  const pane = usePane();
  if (!pane) return null;
  const many = () => paneCount() > 1;
  const zoomed = () => many() && layout().zoom === pane.id;
  const items = (): MenuEntry[] => [
    { id: "right", label: t("오른쪽으로 나누기"), icon: "splitRight", kbd: shortcutHint("splitRight"), run: () => (focusPane(pane.id), splitNew("right")) },
    { id: "down", label: t("아래로 나누기"), icon: "splitDown", kbd: shortcutHint("splitDown"), run: () => (focusPane(pane.id), splitNew("down")) },
    ...(many()
      ? ([
          "sep",
          { id: "zoom", label: zoomed() ? t("확대 해제") : t("창 확대"), icon: "zoom", kbd: shortcutHint("zoomPane"), run: () => (focusPane(pane.id), toggleZoom()) },
          { id: "equal", label: t("창 크기 맞추기"), icon: "equal", kbd: shortcutHint("equalizePanes"), run: () => equalizePanes() },
          "sep",
          { id: "close", label: t("창 닫기"), icon: "x", kbd: shortcutHint("closePane"), run: () => closePane(pane.id) },
        ] as MenuEntry[])
      : []),
  ];
  return (
    <span class="pane-ctl">
      <Show when={zoomed()}>
        <button class="pane-state" onClick={() => toggleZoom()} title={`${t("확대 해제")} ${shortcutHint("zoomPane")}`.trim()}>
          <Icon name="zoom" size={12} />
          {t("확대됨")}
        </button>
      </Show>
      <Show when={many() && !layout().zoom && alone() && pane.focused()}>
        <span class="pane-state quiet">{t("창 {n}개 중 1개", { n: paneCount() })}</span>
      </Show>
      <span class="pane-tools">
        <button
          class="icon-btn"
          title={t("창 나누기")}
          aria-label={t("창 나누기")}
          aria-haspopup="menu"
          onClick={(e) => openMenuAt(`pane:${pane.id}`, items, e.currentTarget.getBoundingClientRect(), e.detail === 0)}
        >
          <Icon name="splitRight" size={16} />
        </button>
        <Show when={many()}>
          <button class="icon-btn" title={`${t("창 닫기")} ${shortcutHint("closePane")}`.trim()} aria-label={t("창 닫기")} onClick={() => closePane(pane.id)}>
            <Icon name="x" size={16} />
          </button>
        </Show>
      </span>
    </span>
  );
}

// ───────────── a sidebar job dragged onto a pane

export type Zone = { pane: string; side: L.Dir | "middle" };
const [drag, setDrag] = createSignal<{ id: string; title: string; x: number; y: number } | null>(null);
const [zone, setZone] = createSignal<Zone | null>(null);
/** where a drop lands, set by the pane host */
let zoneAt: (x: number, y: number) => Zone | null = () => null;
export const setZoneAt = (f: typeof zoneAt) => void (zoneAt = f);
export { drag, zone, setAlone };
/** A sidebar row pressed: past a few pixels of movement it is a drag onto the panes (a click otherwise). */
export function startTaskDrag(e: PointerEvent, id: string) {
  if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const title = taskById(id)?.title ?? "";
  let on = false;
  const move = (m: PointerEvent) => {
    if (!on && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
    on = true;
    document.body.classList.add("pane-dragging");
    setDrag({ id, title, x: m.clientX, y: m.clientY });
    setZone(zoneAt(m.clientX, m.clientY));
  };
  const swallow = (c: MouseEvent) => (c.preventDefault(), c.stopPropagation());
  const up = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    if (!on) return;
    // the click that follows the drag isn't a click on the row
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    document.body.classList.remove("pane-dragging");
    const z = zone();
    setDrag(null);
    setZone(null);
    if (!z) return;
    const v: View = { name: "task", id };
    if (z.side === "middle") {
      const other = Object.keys(layout().panes).find((p) => p !== z.pane && layout().panes[p].view.name === "task" && (layout().panes[p].view as { id: string }).id === id);
      if (other) return focusPane(other);
      focusPane(z.pane);
      setPaneView(z.pane, v);
    } else splitPane(z.side, { view: v }, z.pane);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}

