// ⌘K: jump to any task or place, or send what you typed to Main.
import { checkUpdate } from "../engine/update";
import { resultsIn, resultText } from "../engine/results";
import { switchSpace } from "../state/workspace";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { setState, spaceById, state, taskById } from "../state/store";
import { Glyph, stateMeta } from "./Sidebar";
import { openTask, paletteMode, setPaletteMode, setPaletteOpen, setView } from "../state/ui";
import { ignoredKey, matchesShortcut, noModifiers, shortcutLabel, shortcuts, type ShortcutCommand } from "../lib/shortcuts";
import { throwThought } from "../engine/captain";
import { ago } from "../ui/bits";
import { lang } from "../i18n";
import { Icon } from "../ui/Icon";
import { t as tr } from "../i18n";

interface Item {
  id: string;
  label: string;
  /** keys, shown as a key chip */
  keys?: string;
  /** plain text on the right (a task's state or age, a result's date) */
  hint?: string;
  /** the hint's tone, as on the sidebar row (검토 in the accent, 응답 필요 in amber) */
  tone?: string;
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

  // commands come with their labels already in the current language (appCommands)
  const places: Item[] = [
    ...props.commands.filter((c) => c.id !== "search").map((c) => ({ ...c, keys: c.shortcut ? shortcutLabel(c.shortcut) : c.keys })),
    { id: "s-accounts", label: tr("계정"), icon: "key", section: tr("설정"), run: () => setView({ name: "settings", tab: "accounts" }) },
    { id: "s-agent-tools", label: tr("도구"), icon: "tools", section: tr("설정"), run: () => setView({ name: "settings", tab: "agent-tools" }) },
    { id: "s-tools", label: tr("권한"), icon: "shield", section: tr("설정"), run: () => setView({ name: "settings", tab: "tools" }) },
    { id: "s-import", label: tr("가져오기"), icon: "download", section: tr("설정"), run: () => setView({ name: "settings", tab: "import" }) },
    { id: "update", label: tr("업데이트 확인"), icon: "update", section: tr("설정"), run: () => void checkUpdate(true) },
    { id: "theme", label: tr("테마 전환"), icon: "theme", section: tr("설정"), run: () => setState("settings", "theme", ({ system: "light", light: "dark", dark: "system" } as const)[state.settings.theme] ?? "system") },
    // the other language, named in itself
    { id: "language", label: tr("언어 전환"), hint: lang() === "ko" ? "English" : "한국어", icon: "language", section: tr("설정"), run: () => setState("settings", "language", lang() === "ko" ? "en" : "ko") },
  ];
  /** with nothing typed: a few tasks, then the places you go to most */
  const START = ["main", "new", "board", "memory", "results", "devices", "settings"];

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
        // the same word as the task's sidebar row (검토 for one in review, not its age)
        hint: [t.space === state.space ? "" : tr(spaceById(t.space).label), stateMeta(t, !!t.parentId).text].filter(Boolean).join(" · "),
        tone: stateMeta(t, !!t.parentId).tone,
        status: t.status,
        section: tr("작업"),
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
          .map((r) => ({ id: `r-${r.id}`, label: r.title, hint: ago(r.at), icon: "inbox", section: tr("결과물"), run: () => setView({ name: "results", id: r.id }) }))
      : [];
    // the command list doesn't list itself
    const cmds = commandsOnly() ? places.filter((i) => i.id !== "commands") : places;
    const all = commandsOnly() ? cmds : needle ? [...tasks, ...cmds] : [...tasks.slice(0, 6), ...START.map((id) => cmds.find((i) => i.id === id)!).filter(Boolean)];
    const found = needle ? all.filter((i) => `${i.label} ${i.hint ?? ""} ${i.keys ?? ""}`.toLowerCase().includes(needle)) : all;
    // each section once: its items together, sections in the order they first appear
    // (settings last, as in the sidebar and the shortcut sheet)
    const order = [...new Set(found.map((i) => i.section))].sort((a, b) => Number(a === tr("설정")) - Number(b === tr("설정")));
    const hits = order.flatMap((sec) => found.filter((i) => i.section === sec));
    const send: Item[] = text && !commandsOnly()
      ? [{ id: "send", label: text, hint: tr("메인에 보내기"), icon: "send", section: tr("보내기"), run: () => { throwThought(text, state.space); setView({ name: "main" }); } }]
      : [];
    return [...(commandsOnly() || !needle ? hits : hits.slice(0, 13)), ...results, ...send];
  });

  // the picked row stays in view when it moves or the query changes (not when a clock tick
  // re-renders the list, which would pull a scrolled list back)
  createEffect(on([sel, q, paletteMode], () => {
    queueMicrotask(() => document.querySelector<HTMLElement>(".palette-list .palette-item.on")?.scrollIntoView({ block: "nearest" }));
  }));
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
      <div class="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={tr("검색")}>
        <div class="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q()}
            placeholder={commandsOnly() ? tr("명령 검색") : tr("검색하거나 메인에 보내기")}
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
          <For each={items()} fallback={<div class="palette-empty">{tr("결과 없음")}</div>}>
            {(it, i) => (
              <>
                <Show when={i() === 0 || items()[i() - 1].section !== it.section}>
                  <div class="palette-sec">{it.section}</div>
                </Show>
                <button class="palette-item" disabled={it.enabled?.() === false} title={it.enabled?.() === false ? tr("여기서는 사용할 수 없어요") : undefined} classList={{ on: sel() === i() }} onMouseMove={() => setSel(i())} onClick={() => choose(i())}>
                  <span class="palette-ic">
                    <Show when={it.status} fallback={<Icon name={it.icon ?? "dot"} size={16} />}>
                      <Show when={taskById(it.id)}>{(t) => <Glyph t={t()} />}</Show>
                    </Show>
                  </span>
                  <span class="label">{it.label}</span>
                  <Show when={it.hint}><span class={`hint ${it.tone ? `tone-${it.tone}` : ""}`}>{it.hint}</span></Show>
                  <Show when={it.keys}><kbd class="hint-keys">{it.keys}</kbd></Show>
                </button>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
