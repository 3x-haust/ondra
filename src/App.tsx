import { createMemo, createRoot, createSignal, createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import { keepSpaces, switchSpace } from "./state/workspace";
import { costShort, jobCost } from "./ui/cost";
import { loaded, loadState, seedProjects, state } from "./state/store";
import type { SpaceId } from "./state/types";
import type { View } from "./state/ui";
import { closePanel, layout, paletteOpen, paneCount, paneEl, panelShown, setView, sidebarAway, toast, toasts, dropToast, holdToast, releaseToast, view } from "./state/ui";
import { keepPanes } from "./state/panes";
import { Panes } from "./views/Panes";
import { menuClose } from "./views/PaneControls";
import { appCommands } from "./state/commands";
import { applyZoom, zoom } from "./state/zoom";
import { keyText, ShortcutSheet, sheetOpen } from "./views/ShortcutSheet";
import { binding, chordText, dispatchShortcut, NATIVE, noModifiers, shortcutContext, shortcutLabel, shortcutOverlay, viewKey } from "./lib/shortcuts";
import { anyPop } from "./ui/ModelPicker";
import { spaceById, taskById } from "./state/store";
import { throwThought } from "./engine/captain";
import { scan } from "./engine/importer";
import { refreshEngine, startRpc } from "./engine/rpc";
import { startComponents } from "./engine/components";
import { startScheduler } from "./engine/tasks";
import { applyKeys, notify, onEvent, setFocusGuard, setTrayCount } from "./lib/native";
import { watchDevices } from "./state/devices";
import { Onboarding } from "./views/Onboarding";
import { Palette } from "./views/Palette";
import { Lightbox } from "./ui/Lightbox";
import { recordingKeys, SettingsNav, SettingsPage } from "./views/Settings";
import { Sidebar } from "./views/Sidebar";
import { Panel } from "./views/Panel";
import { migrateMemory } from "./engine/memory";
import { startTidy } from "./engine/tidy";
import { Icon } from "./ui/Icon";
import { ShortcutHints } from "./ui/ShortcutHints";
import { QuoteBar } from "./ui/QuoteBar";
import { startUpdates } from "./engine/update";
import { afterLaunch, notesFor } from "./engine/releaseNotes";
import { ReleaseNotes } from "./ui/ReleaseNotes";
import { ConfirmHost, ContextMenuHost } from "./ui/taskMenu";
import { getVersion } from "@tauri-apps/api/app";
import { VisualViewer } from "./ui/exportVisual";
import { warmModels } from "./engine/modelList";
import { soonIndex } from "./engine/vectors";
import { startBridge } from "./engine/bridge";
import "./engine/journal";
import "./engine/memgit";
import { lang, t as tr } from "./i18n";

export default function App() {
  const [appVersion, setAppVersion] = createSignal("");
  keepSpaces();
  // settings fill the window; "back" returns to wherever you were
  let lastView: View = { name: "main" };
  createEffect(() => applyZoom(zoom()));
  createEffect(() => {
    const v = view();
    if (v.name !== "settings") lastView = v;
  });
  const back = () => setView(lastView);
  onMount(() => watchDevices(() => Object.values(layout().panes).some((p) => p.view.name === "devices")));
  onMount(() => {
    let un: (() => void) | undefined;
    // ⌘W (menu): the focused pane when there are several, else the right panel
    void onEvent("panel:close", () => !shortcutOverlay() && !anyPop() && !menuClose() && panelShown() && closePanel()).then((u) => (un = u));
    // Quit's key tapped, not held (Rust quits once it has been held)
    let hint = 0;
    let unq: (() => void) | undefined;
    void onEvent("quit:hold", () => {
      if (Date.now() - hint > 4000) toast(tr("{keys} 눌러 종료", { keys: keyText("quit") }));
      hint = Date.now();
    }).then((u) => (unq = u));
    onCleanup(() => (un?.(), unq?.()));
  });
  if (import.meta.env.DEV)
    void Promise.all([import("./state/store"), import("./engine/tasks"), import("./engine/captain"), import("./state/ui"), import("./lib/native"), import("./engine/memory"), import("./engine/absorb"), import("./engine/tidy")]).then(
      ([store, tasks, captain, ui, native, memory, absorb, tidy]) => ((window as any).__ui = { setView, store, tasks, captain, ui, native, memory, absorb, tidy }),
    );
  let unCapture: (() => void) | undefined;
  onCleanup(() => unCapture?.());
  onMount(async () => {
    await loadState();
    // the panes as they were left, without jobs deleted since
    createRoot(() => keepPanes(() => state.space, (v) => (v.name !== "task" && v.name !== "changes") || !!taskById(v.id)));
    if (!location.search.includes("fixture")) seedProjects();
    migrateMemory();
    await startRpc();
    // the engine, the browser and the analyzer, as each comes in (the engine's version shows once it's here)
    void startComponents((name) => name === "engine" && void refreshEngine());
    // jobs still running in the engine from before a reload: hear them again
    if (!location.search.includes("fixture")) await import("./engine/tasks").then((m) => m.reattachJobs()).catch(() => {});
    startScheduler();
    void import("./state/limits").then((m) => m.watchLimits(() => state.accounts.map((a) => a.id)));
    if (!location.search.includes("fixture")) void import("./engine/captain").then((m) => m.startRelaySweep());
    void import("./engine/results").then((m) => m.backfillResults());
    warmModels();
    startBridge();
    // memory changed → its vectors are refreshed a moment later
    createEffect(() => {
      for (const m of state.memory) void (m.text, m.invalidAt, m.keys, m.about);
      soonIndex();
    });
    if (!location.search.includes("fixture")) startTidy();
    if (!location.search.includes("fixture")) {
      startUpdates();
      void getVersion().then((v) => { setAppVersion(v); void afterLaunch(v); }).catch(() => {});
    }
    void scan();
    unCapture = await onEvent<{ text: string; space: SpaceId | "" }>("capture:submitted", ({ text, space }) => {
      const target = state.spaces.some((s) => s.id === space) ? space : state.space;
      switchSpace(target, { name: "main" });
      throwThought(text, target);
      toast(tr("메인에 보냈어요"));
    });
  });

  const onKey = (e: KeyboardEvent) => {
    if (!loaded() || !state.onboarded || anyPop()) return;
    const ctx = shortcutContext(e);
    if (dispatchShortcut(e, appCommands(), ctx)) return;
    // Local views handle Escape first; only an unclaimed Escape closes the panel.
    if (e.key === "Escape" && noModifiers(e) && viewKey(e) && panelShown()) {
      e.preventDefault();
      void closePanel();
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // toasts sit centred on the main pane, just above its composer and what is docked on it (or its foot)
  const [toastAt, setToastAt] = createSignal<{ left: number; bottom: number }>();
  const placeToast = () => {
    const main = paneEl() ?? document.querySelector<HTMLElement>("main.main");
    if (!main) return;
    const r = main.getBoundingClientRect();
    const box = [...main.querySelectorAll<HTMLElement>(".composer-wrap")].map((c) => c.getBoundingClientRect()).filter((c) => c.height && c.top > r.top + r.height / 2).pop();
    setToastAt({ left: r.left + r.width / 2, bottom: innerHeight - (box ? box.top - 12 : r.bottom - 16) });
  };
  createEffect(on(toasts, (l) => l.length && placeToast()));
  window.addEventListener("resize", placeToast);
  onCleanup(() => window.removeEventListener("resize", placeToast));

  // a job that finishes or needs you while Ondra is in the background: tell the system
  const seen = new Map<string, string>();
  createEffect(() => {
    for (const t of state.tasks) {
      const was = seen.get(t.id);
      seen.set(t.id, t.status);
      if (!was || was === t.status || document.hasFocus()) continue;
      // which space it is in, so a company job never reads as a personal one
      const title = `${tr(spaceById(t.space)?.label ?? t.space)} · ${t.title}`;
      if (t.status === "waiting") void notify(title, tr("응답이 필요해요"));
      else if (t.status === "done" && !t.parentId) void notify(title, t.answer ? tr("답변했어요") : [tr("완료했어요"), costShort(jobCost(t))].filter(Boolean).join(" · "));
      else if (t.status === "failed") void notify(title, tr("실패했어요"));
    }
  });
  createEffect(() => {
    setTrayCount(state.tasks.filter((t) => t.status === "running" && !t.parentId).length, state.decisions.length);
  });
  createEffect(() => {
    void setFocusGuard(state.settings.focusGuard);
  });
  // the keys the native side answers to (quick input, Quit, Close), live and from the next launch;
  // none while Settings › 단축키 records one, so the page can take them
  const nativeKeys = createMemo(() => {
    const text = (id: (typeof NATIVE)[number]) => { const b = !recordingKeys() && binding(id); return b ? chordText(b) : null; };
    return loaded() ? JSON.stringify({ capture: text("capture"), quit: text("quit"), closePane: text("closePane") }) : "";
  });
  createEffect(on(nativeKeys, (json, before) => {
    if (!json) return;
    const keys = JSON.parse(json) as Parameters<typeof applyKeys>[0];
    void applyKeys(keys, !recordingKeys()).then((failed) => {
      // said when it is changed, not at every launch
      if (before && keys.capture && failed.includes("capture")) toast(tr("{keys}는 다른 앱이 쓰고 있어요", { keys: shortcutLabel("capture") }), "bad");
    });
  }));
  createEffect(() => {
    document.documentElement.lang = lang();
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
        <main class="main" classList={{ split: paneCount() > 1 && view().name !== "settings" }}>
          <Show when={view().name === "settings"}><SettingsPage onBack={back} /></Show>
          {/* the center: split panes, each with its own view (one fills it when alone) */}
          <Show when={view().name !== "settings"}><Panes /></Show>
        </main>
        <Show when={panelShown()}>
          <Panel t={view().name === "task" ? taskById((view() as { id: string }).id) : undefined} onClose={() => void closePanel()} />
        </Show>
      </div>
      <Show when={!state.onboarded}><Onboarding /></Show>
      <Show when={paletteOpen()}><Palette commands={appCommands()} /></Show>
      <Show when={sheetOpen()}><ShortcutSheet /></Show>
      <QuoteBar />
      <Show when={notesFor() !== null}><ReleaseNotes current={appVersion()} /></Show>
      <ShortcutHints commands={appCommands} enabled={() => loaded() && state.onboarded && !anyPop()} />
      <Lightbox />
      <VisualViewer />
      {/* one toast at a time (DESIGN.md §9.10): the newest shows; a kept one comes back after it */}
      <ContextMenuHost />
      <ConfirmHost />
      <div class="toasts" aria-live="polite" style={toastAt() ? { left: `${toastAt()!.left}px`, bottom: `${toastAt()!.bottom}px` } : undefined}>
        <For each={toasts().slice(-1)}>
          {(t) => (
            <div class={`toast ${t.tone}`} role={t.tone === "bad" ? "alert" : "status"} onMouseEnter={() => holdToast(t.id)} onMouseLeave={() => releaseToast(t.id)}>
              <Show when={t.tone === "bad"}><Icon name="alert" size={14} class="toast-ic" /></Show>
              <span class="toast-text">{tr(t.text)}</span>
              <Show when={t.action}>{(a) => <button class="toast-act" onClick={() => (dropToast(t.id), a().run())}>{tr(a().label)}</button>}</Show>
              <Show when={t.stay}>
                <button class="toast-x" aria-label={tr("닫기")} title={tr("닫기")} onClick={() => dropToast(t.id)}><Icon name="x" size={14} /></button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
