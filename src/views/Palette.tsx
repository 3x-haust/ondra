// ⌘K: jump to any task or place, or send what you typed to the captain.
import { switchSpace } from "../state/workspace";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { setState, spaceById, state, taskById } from "../state/store";
import { StatusIcon } from "../ui/ForkCard";
import { newTask, openPanel, openTask, setPaletteOpen, setSidebarHidden, setView, sidebarHidden, togglePanel } from "../state/ui";
import { throwThought } from "../engine/captain";
import { ago, compact, now } from "../ui/bits";
import { Icon } from "../ui/Icon";

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  status?: string;
  section: string;
  run: () => void;
}

const rank = (t: { status: string }) => ({ waiting: 0, failed: 0, running: 1, queued: 2, paused: 2, done: 3 } as Record<string, number>)[t.status] ?? 2;

export function Palette() {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input!: HTMLInputElement;
  const close = () => setPaletteOpen(false);

  const places: Item[] = [
    { id: "new", label: "메인으로", hint: "⌘0", icon: "message", section: "이동", run: () => newTask() },
    { id: "s-general", label: "설정", hint: "⌘,", icon: "gear", section: "앱", run: () => setView({ name: "settings", tab: "general" }) },
    { id: "s-accounts", label: "계정", icon: "key", section: "앱", run: () => setView({ name: "settings", tab: "accounts" }) },
    { id: "s-import", label: "가져오기", icon: "download", section: "앱", run: () => setView({ name: "settings", tab: "import" }) },
    { id: "s-memory", label: "기억", icon: "memory", section: "앱", run: () => setView({ name: "memory" }) },
    { id: "s-tools", label: "도구 · 권한", icon: "shield", section: "앱", run: () => setView({ name: "settings", tab: "tools" }) },
    ...state.spaces.map((s) => ({ id: `sp-${s.id}`, label: `${s.label} 공간으로 전환`, icon: "arrow", section: "공간", run: () => switchSpace(s.id) })),
    { id: "board", label: "캔버스 (모든 일)", hint: "⌘⇧B", icon: "canvas", section: "이동", run: () => setView({ name: "board" }) },
    { id: "panel", label: "패널 열기 · 닫기", hint: "⌘\\", icon: "panel", section: "보기", run: () => togglePanel() },
    { id: "flow", label: "흐름 보기", icon: "branch", section: "보기", run: () => openPanel("flow") },
    { id: "sidebar", label: "왼쪽 목록 접기 · 펴기", hint: "⌘B", icon: "panelLeft", section: "보기", run: () => setSidebarHidden(!sidebarHidden()) },
    { id: "theme", label: "테마 바꾸기 (라이트 · 다크 · 시스템)", icon: "spark", section: "보기", run: () => setState("settings", "theme", ({ system: "light", light: "dark", dark: "system" } as const)[state.settings.theme] ?? "system") },
  ];

  const items = createMemo<Item[]>(() => {
    const text = q().trim();
    const needle = text.toLowerCase();
    // each space is its own workspace: only this one's jobs
    const tasks: Item[] = [...state.tasks.filter((t) => t.space === state.space)]
      .sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))
      .filter((t) => !t.answer && (!t.parentId || needle))
      .map((t) => ({
        id: t.id,
        label: t.title,
        hint: [t.space === state.space ? "" : spaceById(t.space).label, t.status === "done" ? ago(t.finishedAt ?? t.createdAt) : t.status === "waiting" ? "답 필요" : t.startedAt ? compact(now() - t.startedAt) : "대기"].filter(Boolean).join(" · "),
        status: t.status,
        section: "일",
        run: () => {
          switchSpace(t.space, { name: "task", id: t.id });
          openTask(t.id);
        },
      }));
    const all = [...tasks, ...places];
    const hits = needle ? all.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(needle)) : all;
    const send: Item[] = text
      ? [{ id: "send", label: text, hint: "메인에게 보내기", icon: "send", section: "보내기", run: () => { throwThought(text, state.space); setView({ name: "main" }); } }]
      : [];
    return [...hits.slice(0, needle ? 13 : 10), ...send];
  });

  const choose = (i: number) => {
    const it = items()[i];
    if (!it) return;
    close();
    it.run();
  };
  onMount(() => input.focus());
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="backdrop" onClick={close}>
      <div class="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="명령">
        <div class="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q()}
            placeholder="일 찾기, 이동, 또는 메인에게 보내기"
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items().length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(sel());
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div class="palette-list">
          <For each={items()} fallback={<div class="pane-empty">결과 없음</div>}>
            {(it, i) => (
              <>
                <Show when={i() === 0 || items()[i() - 1].section !== it.section}>
                  <div class="palette-sec">{it.section}</div>
                </Show>
                <button class="palette-item" classList={{ on: sel() === i() }} onMouseMove={() => setSel(i())} onClick={() => choose(i())}>
                  <Show when={it.status} fallback={<Icon name={it.icon ?? "dot"} size={15} />}>
                    <Show when={taskById(it.id)}>{(t) => <StatusIcon t={t()} size="sm" />}</Show>
                  </Show>
                  <span class="label">{it.label}</span>
                  <Show when={it.hint}><span class="hint">{it.hint}</span></Show>
                </button>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
