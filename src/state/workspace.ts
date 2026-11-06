// Each space is its own workspace: switching keeps where you were in the one you
// leave (the screen, the right panel and its tabs) and brings back the other's.
import { batch, createEffect, untrack } from "solid-js";
import { projectById, setSpace, state, taskById } from "./store";
import type { SpaceId } from "./types";
import { activeTab, panelOpen, previewPath, ptabs, setActiveTab, setPanelOpen, setPreviewPath, setPtabs, setView, view, type PTab, type View } from "./ui";

interface Place {
  view: View;
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

/** a saved screen that still makes sense in that space */
function valid(v: View | undefined, space: SpaceId): View {
  if (!v || v.name === "settings") return { name: "main" };
  if (v.name === "task") return taskById(v.id)?.space === space ? v : { name: "main" };
  if (v.name === "main" && v.project) return projectById(v.project)?.space === space ? v : { name: "main" };
  return v;
}

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

/** Go to another space, where you left it. */
export function switchSpace(id: SpaceId, then?: View, leaving: View = view()) {
  if (id === state.space) return void (then && setView(then));
  places[state.space] = { view: leaving, panel: panelOpen(), tabs: ptabs(), tab: activeTab(), preview: previewPath() };
  try {
    localStorage.setItem(KEY, JSON.stringify(places));
  } catch {}
  const p = places[id];
  batch(() => {
    setSpace(id);
    setView(then ?? valid(p?.view, id));
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
