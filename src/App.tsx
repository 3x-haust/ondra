import { createEffect, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { costShort, jobCost } from "./ui/cost";
import { loaded, loadState, seedProjects, setSpace, state } from "./state/store";
import type { SpaceId } from "./state/types";
import type { View } from "./state/ui";
import { closePanel, goMain, newPanelTab, newTask, openPanel, openTask, paletteOpen, panelOpen, panelTab, setPaletteOpen, setSidebarHidden, setView, showSidebar, sidebarAway, toast, toasts, dropToast, togglePanel, view } from "./state/ui";
import { taskById } from "./state/store";
import { throwThought } from "./engine/captain";
import { scan } from "./engine/importer";
import { startRpc } from "./engine/rpc";
import { startScheduler } from "./engine/tasks";
import { notify, onEvent, setTrayCount } from "./lib/native";
import { MainView } from "./views/MainView";
import { Canvas } from "./views/Canvas";
import { MemoryView } from "./views/Memory";
import { Devices } from "./views/Devices";
import { watchDevices } from "./state/devices";
import { Onboarding } from "./views/Onboarding";
import { Palette } from "./views/Palette";
import { Lightbox } from "./ui/Lightbox";
import { SettingsNav, SettingsPage } from "./views/Settings";
import { nextWaiting, Sidebar, stepFork } from "./views/Sidebar";
import { Panel } from "./views/Panel";
import { TaskView } from "./views/TaskView";
import { migrateMemory } from "./engine/memory";
import { startTidy } from "./engine/tidy";
import { Icon } from "./ui/Icon";
import { startUpdates } from "./engine/update";
import { VisualViewer } from "./ui/exportVisual";
import { warmModels } from "./engine/modelList";
import { soonIndex } from "./engine/vectors";
import { startBridge } from "./engine/bridge";
import "./engine/journal";
import "./engine/memgit";

let firstSlide = true;
/** The center's content slides in from the side it comes from (not on first paint). */
function Slide(props: { from: 1 | -1; children: JSX.Element }) {
  let el!: HTMLDivElement;
  onMount(() => {
    if (firstSlide) return void (firstSlide = false);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ transform: `translateX(${props.from * 36}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, easing: "cubic-bezier(.32,.72,0,1)" });
  });
  return <div class="slide" ref={el}>{props.children}</div>;
}

export default function App() {
  // settings fill the window; "back" returns to wherever you were
  let lastView: View = { name: "main" };
  createEffect(() => {
    const v = view();
    if (v.name !== "settings") lastView = v;
  });
  const back = () => setView(lastView);
  onMount(() => watchDevices());
  // ⌘W (menu): close the right panel; the window stays
  onMount(() => {
    let un: (() => void) | undefined;
    void onEvent("panel:close", () => panelOpen() && closePanel()).then((u) => (un = u));
    onCleanup(() => un?.());
  });
  if (import.meta.env.DEV)
    void Promise.all([import("./state/store"), import("./engine/tasks"), import("./engine/captain"), import("./state/ui"), import("./lib/native"), import("./engine/memory"), import("./engine/absorb"), import("./engine/tidy")]).then(
      ([store, tasks, captain, ui, native, memory, absorb, tidy]) => ((window as any).__ui = { setView, store, tasks, captain, ui, native, memory, absorb, tidy }),
    );
  let unCapture: (() => void) | undefined;
  onCleanup(() => unCapture?.());
  onMount(async () => {
    await loadState();
    if (!location.search.includes("fixture")) seedProjects();
    migrateMemory();
    await startRpc();
    // jobs still running in the engine from before a reload: hear them again
    if (!location.search.includes("fixture")) await import("./engine/tasks").then((m) => m.reattachJobs()).catch(() => {});
    startScheduler();
    warmModels();
    startBridge();
    // memory changed → its vectors are refreshed a moment later
    createEffect(() => {
      for (const m of state.memory) void (m.text, m.invalidAt, m.keys, m.about);
      soonIndex();
    });
    if (!location.search.includes("fixture")) startTidy();
    if (!location.search.includes("fixture")) startUpdates();
    void scan();
    unCapture = await onEvent<{ text: string; space: SpaceId | "" }>("capture:submitted", ({ text, space }) => {
      const target = state.spaces.some((s) => s.id === space) ? space : state.space;
      setSpace(target);
      throwThought(text, target);
      setView({ name: "main" });
      toast("메인에게 전달했어요");
    });
  });

  const onKey = (e: KeyboardEvent) => {
    // panel tools, as in Codex: ⌃⇧G changes, ⌃` terminal
    if (e.ctrlKey && !e.metaKey && e.shiftKey && e.code === "KeyG") {
      e.preventDefault();
      return openPanel("changes");
    }
    if (e.ctrlKey && !e.metaKey && e.code === "Backquote") {
      e.preventDefault();
      return openPanel("terminal");
    }
    if (e.key === "Escape" && panelOpen() && view().name !== "task" && !paletteOpen()) {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !["TEXTAREA", "INPUT"].includes(el.tagName) || !(el as HTMLTextAreaElement).value) void closePanel();
      return;
    }
    if (!e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "k") {
      e.preventDefault();
      setPaletteOpen(!paletteOpen());
    } else if (k === "n") {
      e.preventDefault();
      newTask();
    } else if (k === ",") {
      e.preventDefault();
      setView({ name: "settings" });
    } else if (k === "0") {
      e.preventDefault();
      goMain();
    } else if (/^[1-9]$/.test(k) && !e.shiftKey && !e.altKey && state.spaces[Number(k) - 1]) {
      // ⌘1, ⌘2 …: the spaces in the order the sidebar shows them (회사, 개인)
      e.preventDefault();
      setSpace(state.spaces[Number(k) - 1].id);
      goMain();
    } else if (k === "j") {
      e.preventDefault();
      if (panelOpen() && panelTab() === "side") void closePanel();
      else {
        openPanel("side");
        setTimeout(() => document.getElementById("side-input")?.focus(), 80);
      }
    } else if (k === "b" && e.shiftKey) {
      e.preventDefault();
      setView(view().name === "board" ? { name: "main" } : { name: "board" });
    } else if (k === "b") {
      e.preventDefault();
      if (sidebarAway()) showSidebar();
      else setSidebarHidden(true);
    } else if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      e.preventDefault();
      const t = stepFork(state.space, e.code === "BracketRight" ? 1 : -1);
      if (t) openTask(t.id);
    } else if (k === ".") {
      e.preventDefault();
      const t = nextWaiting(state.space);
      if (t) openTask(t.id);
    } else if (k === "\\") {
      e.preventDefault();
      togglePanel();
    } else if (k === "p" && !e.shiftKey) {
      e.preventDefault();
      openPanel("files");
    } else if (k === "t" && panelOpen()) {
      e.preventDefault();
      newPanelTab();
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // a job that finishes or needs you while Ondra is in the background: tell the system
  const seen = new Map<string, string>();
  createEffect(() => {
    for (const t of state.tasks) {
      const was = seen.get(t.id);
      seen.set(t.id, t.status);
      if (!was || was === t.status || document.hasFocus()) continue;
      if (t.status === "waiting") void notify(t.title, "답이 필요해요");
      else if (t.status === "done" && !t.parentId) void notify(t.title, t.answer ? "답했어요" : ["끝났어요", costShort(jobCost(t))].filter(Boolean).join(" · "));
      else if (t.status === "failed") void notify(t.title, "멈췄어요");
    }
  });
  createEffect(() => {
    setTrayCount(state.tasks.filter((t) => t.status === "running").length, state.decisions.length);
  });
  createEffect(() => {
    const t = state.settings.theme;
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  });

  return (
    <Show when={loaded()}>
      <div class="app" classList={{ "sb-hidden": sidebarAway() }}>
        <div class="sb-wrap" inert={sidebarAway() || undefined}>
          <Show when={view().name === "settings"} fallback={<Sidebar />}><SettingsNav onBack={back} /></Show>
        </div>
        <main class="main">
          <Show when={view().name === "settings"}><SettingsPage onBack={back} /></Show>
          <Show when={view().name !== "settings"}>
          {/* the center is main or the job you picked; it slides over when you switch */}
          <Show when={view().name === "task" && (view() as { id: string }).id} keyed fallback={<Show when={view().name === "board"} fallback={<Show when={view().name === "devices"} fallback={<Show when={view().name === "memory"} fallback={<Slide from={-1}><MainView /></Slide>}><Slide from={-1}><MemoryView /></Slide></Show>}><Slide from={-1}><Devices /></Slide></Show>}><Slide from={-1}><Canvas /></Slide></Show>}>
            {(id) => <Slide from={1}><TaskView id={id} /></Slide>}
          </Show>
          </Show>
        </main>
        <Show when={panelOpen() && view().name !== "settings"}>
          <Panel t={view().name === "task" ? taskById((view() as { id: string }).id) : undefined} onClose={() => void closePanel()} />
        </Show>
      </div>
      <Show when={!state.onboarded}><Onboarding /></Show>
      <Show when={paletteOpen()}><Palette /></Show>
      <Lightbox />
      <VisualViewer />
      <div class="toasts" aria-live="polite">
        <For each={toasts()}>
          {(t) => (
            <div class={`toast ${t.tone}`}>
              <span>{t.text}</span>
              <Show when={t.action}>{(a) => <button onClick={() => (dropToast(t.id), a().run())}>{a().label}</button>}</Show>
              <Show when={t.stay}>
                <button class="toast-x" aria-label="닫기" onClick={() => dropToast(t.id)}><Icon name="x" size={13} /></button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
