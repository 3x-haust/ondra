// Each space is its own workspace: switching keeps the screen you're on when the
// other space has it too (memory, results, the board, devices, settings), and
// brings back the other's right panel and its tabs. A task or a project, which
// belong to one space, land on the other's Main.
import { batch, createEffect, untrack } from "solid-js";
import { projectById, setSpace, state, taskById } from "./store";
import type { SpaceId } from "./types";
import { devicesIn } from "./devices";
import { activeTab, blankPane, layout, newPaneId, panelOpen, previewPath, ptabs, setActiveTab, setLayout, setPanelOpen, setPreviewPath, setPtabs, setView, view, type PTab, type View } from "./ui";
import * as L from "./layout";
import { keepLayout, layoutOf } from "./panes";

interface Place {
  panel: boolean;
  tabs: PTab[];
  tab: number;
  preview: string | null;
}
const KEY = "ondra.workspace";
const places: Record<string, Place> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
})();

/** The screen to show in `space` when you switch to it from `v`: the same one when that space has it. */
export function carried(v: View, space: SpaceId): View {
  if (v.name === "task") return taskById(v.id)?.space === space ? v : { name: "main" };
  if (v.name === "main") return v.project && projectById(v.project, space) ? v : { name: "main" };
  // a result is one space's own: that space's list opens at its first
  if (v.name === "results") return v.id ? { name: "results" } : v;
  if (v.name === "devices" && v.device) return devicesIn(space).some((d) => d.id === v.device) ? v : { name: "devices" };
  return v;
}

/** A screen that can be shown in `space` (its job or project is that space's). */
const inSpace = (v: View, space: SpaceId) => (v.name === "task" ? taskById(v.id)?.space === space : v.name === "main" && v.project ? projectById(v.project)?.space === space : true);

/** The space a screen belongs to, if it belongs to one. */
function spaceOfView(v: View): SpaceId | undefined {
  if (v.name === "task") return taskById(v.id)?.space;
  if (v.name === "main" && v.project) return projectById(v.project)?.space;
  return undefined;
}

/**
 * One rule for every way in (a notification, a link in a reply, search, a btw
 * naming a job): a job or project of the other space opens in that space, with
 * its sidebar, chats and panel, never inside this one.
 */
export function keepSpaces() {
  // the last screen that was this space's own, kept for coming back to it
  let here: View = view();
  createEffect(() => {
    const v = view();
    const sp = spaceOfView(v);
    if (sp && sp !== untrack(() => state.space)) untrack(() => switchSpace(sp, v, here));
    else here = v;
  });
}

/** Go to another space: the same screen when it has one, with its own panel as you left it. */
export function switchSpace(id: SpaceId, then?: View, leaving: View = view()) {
  if (id === state.space) return void (then && setView(then));
  places[state.space] = { panel: panelOpen(), tabs: ptabs(), tab: activeTab(), preview: previewPath() };
  try {
    localStorage.setItem(KEY, JSON.stringify(places));
  } catch {}
  const p = places[id];
  // this space's panes as they were, the focused one back on the screen that was this space's own
  const l = layout();
  const f = l.panes[l.focus];
  keepLayout(state.space, f.view === leaving ? l : { ...l, panes: { ...l.panes, [l.focus]: { ...f, view: leaving, past: f.past[f.past.length - 1] === leaving ? f.past.slice(0, -1) : f.past, ahead: [] } } });
  const there = layoutOf(id, (v) => inSpace(v, id));
  const split = (x: typeof l) => L.leaves(x.root).length > 1;
  batch(() => {
    setSpace(id);
    // the other space's split panes come back; one pane carries the screen over, as before splits
    if (there && split(there)) {
      setLayout(there);
      if (then) setView(then);
    } else if (split(l)) setLayout(L.single(newPaneId(), blankPane(then ?? carried(leaving, id))));
    else setView(then ?? carried(leaving, id));
    if (p) {
      setPtabs(p.tabs?.length ? p.tabs : [{ id: 1, kind: "flow" }]);
      setActiveTab(p.tab ?? p.tabs?.[0]?.id ?? 1);
      setPreviewPath(p.preview ?? null);
      setPanelOpen(!!p.panel);
    } else {
      setPanelOpen(false);
    }
  });
}
