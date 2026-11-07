// ⌘K: jump to any task or place, or send what you typed to the captain.
import { checkUpdate } from "../engine/update";
import { resultsIn, resultText } from "../engine/results";
import { switchSpace } from "../state/workspace";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { setState, spaceById, state, taskById } from "../state/store";
import { StatusIcon } from "../ui/ForkCard";
import { openTask, paletteMode, setPaletteMode, setPaletteOpen, setView } from "../state/ui";
import { ignoredKey, matchesShortcut, noModifiers, shortcutLabel, shortcuts, type ShortcutCommand } from "../lib/shortcuts";
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
  enabled?: () => boolean;
}

const rank = (t: { status: string }) => ({ waiting: 0, failed: 0, running: 1, queued: 2, paused: 2, done: 3 } as Record<string, number>)[t.status] ?? 2;

export function Palette(props: { commands: ShortcutCommand[] }) {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input!: HTMLInputElement;
  const previousFocus = document.activeElement as HTMLElement | null;
  const close = (restore = true) => {
    setPaletteOpen(false);
    if (restore && previousFocus?.isConnected && !previousFocus.closest("[inert]")) previousFocus.focus();
  };
  const commandsOnly = () => paletteMode() === "commands" || q().startsWith(">");

  const places: Item[] = [
    ...props.commands.filter((c) => c.id !== "search").map((c) => ({ ...c, hint: c.shortcut ? shortcutLabel(c.shortcut) : undefined })),
    { id: "s-accounts", label: "계정", icon: "key", section: "앱", run: () => setView({ name: "settings", tab: "accounts" }) },
    { id: "s-import", label: "가져오기", icon: "download", section: "앱", run: () => setView({ name: "settings", tab: "import" }) },
    { id: "s-results", label: "결과", icon: "inbox", section: "이동", run: () => setView({ name: "results" }) },
    { id: "update", label: "업데이트 확인", icon: "download", section: "앱", run: () => void checkUpdate(true) },
    { id: "s-tools", label: "도구 · 권한", icon: "shield", section: "앱", run: () => setView({ name: "settings", tab: "tools" }) },
    { id: "theme", label: "테마 바꾸기 (라이트 · 다크 · 시스템)", icon: "spark", section: "보기", run: () => setState("settings", "theme", ({ system: "light", light: "dark", dark: "system" } as const)[state.settings.theme] ?? "system") },
  ];

  const items = createMemo<Item[]>(() => {
    const text = q().replace(/^>/, "").trim();
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
    // finished jobs' reports: found by what they said, not only their title
    const results: Item[] = needle && !commandsOnly()
      ? resultsIn(state.space)
          .filter((r) => resultText(r).toLowerCase().includes(needle))
          .slice(0, 5)
          .map((r) => ({ id: `r-${r.id}`, label: r.title, hint: ago(r.at), icon: "inbox", section: "결과", run: () => setView({ name: "results", id: r.id }) }))
      : [];
    const all = commandsOnly() ? places : [...tasks, ...places];
    const hits = needle ? all.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(needle)) : all;
    const send: Item[] = text && !commandsOnly()
      ? [{ id: "send", label: text, hint: "메인에게 보내기", icon: "send", section: "보내기", run: () => { throwThought(text, state.space); setView({ name: "main" }); } }]
      : [];
    return [...(commandsOnly() ? hits : hits.slice(0, needle ? 13 : 10)), ...results, ...send];
  });

  createEffect(() => {
    sel();
    items();
    queueMicrotask(() => document.querySelector<HTMLElement>(".palette-list .palette-item.on")?.scrollIntoView({ block: "nearest" }));
  });
  const move = (direction: 1 | -1) => {
    const list = items();
    for (let i = sel() + direction; i >= 0 && i < list.length; i += direction) {
      if (list[i].enabled?.() !== false) return setSel(i);
    }
  };
  const choose = (i: number) => {
    const it = items()[i];
    if (!it || it.enabled?.() === false) return;
    close(false);
    it.run();
  };
  onMount(() => input.focus());
  const onKey = (e: KeyboardEvent) => {
    if (ignoredKey(e)) return;
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const controls = [...document.querySelectorAll<HTMLElement>(".palette input, .palette button:not(:disabled)")];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      return;
    }
    if ((e.key === "Escape" && noModifiers(e)) || matchesShortcut(e, shortcuts.search)) {
      e.preventDefault();
      close();
    } else if (matchesShortcut(e, shortcuts.commands)) {
      e.preventDefault();
      setPaletteMode("commands");
      setQ("");
      setSel(0);
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="backdrop" onClick={() => close()}>
      <div class="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="명령">
        <div class="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q()}
            placeholder={commandsOnly() ? "명령과 단축키 찾기" : "일 찾기, 이동, 또는 메인에게 보내기"}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (ignoredKey(e) || !noModifiers(e)) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
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
                <button class="palette-item" disabled={it.enabled?.() === false} title={it.enabled?.() === false ? "현재 화면에서는 사용할 수 없어요" : undefined} classList={{ on: sel() === i() }} onMouseMove={() => setSel(i())} onClick={() => choose(i())}>
                  <Show when={it.status} fallback={<Icon name={it.icon ?? "dot"} size={15} />}>
                    <Show when={taskById(it.id)}>{(t) => <StatusIcon t={t()} size="sm" />}</Show>
                  </Show>
                  <span class="label">{it.label}</span>
                  <Show when={it.hint}><span class="hint">{it.hint}{it.enabled?.() === false ? " · 사용 불가" : ""}</span></Show>
                </button>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
