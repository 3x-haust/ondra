// One menu for a task, wherever it is right-clicked or opened from ⋯ (DESIGN.md §9.8):
// the sidebar row, the task header, a board card and a canvas card all list the same
// items in the same order, with the same words and icons. Delete asks first (§9.9).
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { kidsOf, taskById } from "../state/store";
import { goMain, openPanel, openTask, shownIn, splitPane, toast, view } from "../state/ui";
import { archiveTask, duplicateTask, finishTask, removeTask, resumeTask, startTask, stopTask, togglePin, transcriptMarkdown } from "../engine/tasks";
import { expand } from "../engine/rpc";
import { discarded } from "../state/progress";
import { openInEditor, revealPath } from "../lib/native";
import { editorOn, revealOn, setFarShell } from "../engine/far";
import { ignoredKey, noModifiers } from "../lib/shortcuts";
import { anyPop, closePops } from "./ModelPicker";
import { Icon } from "./Icon";
import { t } from "../i18n";

export interface MenuItem {
  id: string;
  /** shown text, already in the current language */
  label: string;
  icon: string;
  kbd?: string;
  danger?: boolean;
  /** a setting turned on or off (✓ when on, the icon is not shown) */
  checked?: boolean;
  run: () => void;
}
export type MenuEntry = MenuItem | "sep";

/** set by the sidebar: the task whose title is being edited in place */
let startRename: (id: string) => void = () => {};
export const onRename = (f: (id: string) => void) => (startRename = f);

const isOpen = (id: string) => {
  const v = view();
  return v.name === "task" && v.id === id;
};

/** Every action for one task, in the one order used everywhere. */
export function taskMenuItems(id: string): MenuEntry[] {
  const x = taskById(id);
  if (!x) return [];
  const live = x.status === "running" || x.status === "waiting";
  const groups: MenuItem[][] = [
    [
      ...(isOpen(id) ? [] : [{ id: "open", label: t("열기"), icon: "arrow", run: () => openTask(id) }]),
      ...(shownIn({ name: "task", id }, "") ? [] : [{ id: "split", label: t("옆 창에 열기"), icon: "splitRight", kbd: t("⌥ 클릭"), run: () => void splitPane("right", { view: { name: "task", id } }) }]),
      { id: "rename", label: t("이름 바꾸기"), icon: "pencil", kbd: "F2", run: () => (openTask(id), startRename(id)) },
      { id: "pin", label: x.pinned ? t("고정 해제") : t("고정"), icon: "pin", run: () => togglePin(id) },
    ],
    [
      ...(x.status === "running" || x.status === "waiting" ? [{ id: "pause", label: t("일시정지|action"), icon: "pause", run: () => stopTask(id) }] : []),
      // a failed task is tried again (the same word as its card); a paused one picks up where it stopped
      ...(x.status === "paused" ? [{ id: "resume", label: t("다시 시작"), icon: "play", run: () => resumeTask(id) }] : []),
      ...(x.status === "failed" ? [{ id: "resume", label: t("다시 시도"), icon: "refresh", run: () => resumeTask(id) }] : []),
      ...(x.status === "queued" ? [{ id: "start", label: t("지금 시작"), icon: "play", run: () => void startTask(id) }] : []),
      ...(x.status !== "done" ? [{ id: "done", label: t("완료로 표시"), icon: "flag", run: () => finishTask(id) }] : []),
    ],
    [
      // a fresh run of the same ask: only once it has stopped (running or waiting: paused instead;
      // failed: tried again above)
      ...(live || x.status === "queued" || x.status === "failed" ? [] : [{
        id: "rerun",
        label: t("다시 실행"),
        icon: "refresh",
        // another Mac's job: its new id comes back from there
        run: () => void Promise.resolve(duplicateTask(id)).then((n) => n && openTask(n)),
      }]),
      {
        id: "copy",
        label: t("Markdown으로 복사"),
        icon: "copy",
        run: () => {
          void navigator.clipboard.writeText(transcriptMarkdown(id));
          toast(t("복사했어요"));
        },
      },
    ],
    // its worktree is gone with the discarded changes: nothing to open
    discarded(x)
      ? []
      : x.host
        ? // a job of another Mac: its folder is there; the editor and Finder open on that Mac's screen,
          // the terminal is a shell there inside this app
          [
            { id: "editor", label: t("그 Mac의 편집기에서 열기"), icon: "external", run: () => void editorOn(x.host, expand(x.cwd)) },
            { id: "finder", label: t("그 Mac의 Finder에서 보기"), icon: "folder", run: () => void revealOn(x.host, expand(x.cwd)) },
            { id: "terminal", label: t("터미널 열기"), icon: "shell", run: () => (setFarShell(id), openTask(id), openPanel("terminal")) },
          ]
        : [
          { id: "editor", label: t("편집기에서 열기"), icon: "external", run: () => void openInEditor(expand(x.cwd)) },
          { id: "finder", label: t("Finder에서 보기"), icon: "folder", run: () => void revealPath(expand(x.cwd)) },
          { id: "terminal", label: t("터미널 열기"), icon: "shell", run: () => (openTask(id), openPanel("terminal")) },
        ],
    [
      {
        id: "archive",
        label: x.archived ? t("보관 해제") : t("보관"),
        icon: "archive",
        run: () => {
          const here = isOpen(id);
          archiveTask(id, !x.archived);
          if (here && !x.archived) goMain();
        },
      },
      { id: "delete", label: t("삭제"), icon: "trash", danger: true, run: () => confirmDeleteTask(id) },
    ],
  ];
  const out: MenuEntry[] = [];
  for (const g of groups.filter((g) => g.length)) out.push(...(out.length ? ["sep" as const] : []), ...g);
  return out;
}

/** The items as menu buttons; `done` closes whatever holds them. */
export function MenuList(props: { items: MenuEntry[]; done: () => void }) {
  return (
    <For each={props.items}>
      {(it) =>
        it === "sep" ? (
          <div class="menu-sep" />
        ) : (
          <button
            role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={it.checked}
            classList={{ danger: !!it.danger, check: it.checked !== undefined }}
            onClick={() => (props.done(), it.run())}
          >
            <Show when={it.checked !== undefined} fallback={<Icon name={it.icon} size={16} />}>
              <span class="menu-check"><Show when={it.checked}><Icon name="check" size={16} /></Show></span>
            </Show>
            <span class="row-title">{it.label}</span>
            <Show when={it.kbd}><span class="menu-kbd">{it.kbd}</span></Show>
          </button>
        )
      }
    </For>
  );
}

/** ↑↓ move between a menu's items, Home/End jump */
function arrowKeys(e: KeyboardEvent, root: HTMLElement) {
  const items = [...root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  const go = (n: number) => (e.preventDefault(), items[(n + items.length) % items.length].focus());
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
}

// ───────────── a right-click menu at the pointer (one at a time)

/** `row`: the top and bottom of what was clicked when it is a list row, which the menu must not cover */
const [ctx, setCtx] = createSignal<{ items: () => MenuEntry[]; x: number; y: number; key: string; keyboard?: boolean; row?: { top: number; bottom: number; right: number } } | null>(null);
/** what the open right-click menu belongs to ("task:t1", "project:ondra"), to mark its row */
export const ctxFor = () => ctx()?.key;
export const closeCtx = () => setCtx(null);

/** Open a menu at a point (a right-click) or under an element (⇧F10, a ⋯ button). */
export function openMenuAt(key: string, items: () => MenuEntry[], at: MouseEvent | DOMRect, keyboard = false) {
  closePops();
  if (!(at instanceof MouseEvent)) return void setCtx({ key, items, x: at.left, y: at.bottom + 4, keyboard, row: { top: at.top, bottom: at.bottom, right: at.right } });
  // a right-click on a list row (sidebar, menu-sized things): the menu opens beside the pointer,
  // below the row or above it, never over it. On a big card it opens at the pointer.
  const el = at.currentTarget instanceof Element ? at.currentTarget : null;
  const r = el?.getBoundingClientRect();
  setCtx({ key, items, x: at.clientX, y: at.clientY, keyboard, row: r && r.height <= 48 ? { top: r.top, bottom: r.bottom, right: r.right } : undefined });
}
export function openTaskMenu(id: string, at: MouseEvent | DOMRect, keyboard = false) {
  openMenuAt(`task:${id}`, () => taskMenuItems(id), at, keyboard);
}
/** for a card's onContextMenu */
export const taskContextMenu = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  openTaskMenu(id, e);
};

/** Mounted once (App): the open right-click menu, kept inside the window. */
export function ContextMenuHost() {
  return (
    <Show when={ctx()} keyed>
      {(m) => {
        let el!: HTMLDivElement;
        const [pos, setPos] = createSignal({ left: m.x, top: m.y });
        const close = () => setCtx(null);
        const esc = (e: KeyboardEvent) => {
          if (ignoredKey(e)) return;
          if (e.key === "Escape" && noModifiers(e)) (e.preventDefault(), e.stopPropagation(), close());
          else if (el.contains(document.activeElement) || m.keyboard) arrowKeys(e, el);
        };
        const away = (e: Event) => !el.contains(e.target as Node) && close();
        onMount(() => {
          const r = el.getBoundingClientRect();
          // below the row (or the pointer) when it fits, else above it; with room for neither,
          // beside the row: the clicked row always stays in view
          const below = m.row ? m.row.bottom + 2 : m.y;
          const above = (m.row ? m.row.top - 2 : m.y) - r.height;
          const fitsBelow = below + r.height <= innerHeight - 8;
          const fitsAbove = above >= 8;
          const beside = m.row && !fitsBelow && !fitsAbove && m.row.right + 4 + r.width <= innerWidth - 8;
          const top = beside ? m.row!.top - 4 : fitsBelow || !fitsAbove ? below : above;
          const left = beside ? m.row!.right + 4 : m.x + 2;
          setPos({ left: Math.max(8, Math.min(left, innerWidth - r.width - 8)), top: Math.max(8, Math.min(top, innerHeight - r.height - 8)) });
          if (m.keyboard) el.querySelector<HTMLButtonElement>("button")?.focus();
          // the click that opened it is over; any later one outside closes it
          setTimeout(() => window.addEventListener("pointerdown", away, true));
          window.addEventListener("blur", close);
          window.addEventListener("keydown", esc, true);
          window.addEventListener("resize", close);
        });
        onCleanup(() => {
          window.removeEventListener("pointerdown", away, true);
          window.removeEventListener("blur", close);
          window.removeEventListener("keydown", esc, true);
          window.removeEventListener("resize", close);
        });
        // one popover at a time: a picker opening closes this one
        createEffect(() => anyPop() && close());
        // the task went away (deleted elsewhere): nothing left to act on
        createEffect(() => !m.items().length && close());
        return (
          <Portal>
            <div ref={el} class="menu ctx-menu" role="menu" style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px` }} onContextMenu={(e) => e.preventDefault()}>
              <MenuList items={m.items()} done={close} />
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

// ───────────── confirm (§9.9): a question, one line on what happens, cancel then the action

interface Ask {
  title: string;
  /** what is lost; a function when it can still change while the dialog is up (a diff still being counted) */
  body?: JSX.Element | (() => JSX.Element);
  action: string;
  danger?: boolean;
  run: () => void;
}
const [ask, setAsk] = createSignal<Ask | null>(null);
export const confirmAsk = (a: Ask) => (closePops(), setCtx(null), setAsk(a));

/** 버리기 / Discard, wherever it is offered (menu, review bar, /discard, Panel): asked once, same words */
export function confirmDeleteTask(id: string) {
  const x = taskById(id);
  if (!x) return;
  const kids = kidsOf(id).length;
  confirmAsk({
    title: t("이 작업을 삭제할까요?"),
    body: [x.title, kids ? t("서브에이전트 {n}개 포함", { n: kids }) : "", x.worktree?.state === "open" ? t("브랜치는 남아요") : ""].filter(Boolean).join(" · "),
    action: t("삭제"),
    danger: true,
    run: () => {
      const here = isOpen(id) || (() => { const v = view(); return v.name === "task" && taskById(v.id)?.parentId === id; })();
      removeTask(id);
      if (here) goMain();
    },
  });
}

export function ConfirmHost() {
  return (
    <Show when={ask()} keyed>
      {(a) => {
        let cancel!: HTMLButtonElement;
        const body = () => (typeof a.body === "function" ? (a.body as () => JSX.Element)() : a.body);
        const close = () => setAsk(null);
        const go = () => (close(), a.run());
        const key = (e: KeyboardEvent) => {
          if (ignoredKey(e)) return;
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), close());
          else if (e.key === "Enter" && noModifiers(e) && document.activeElement?.tagName !== "BUTTON") (e.preventDefault(), e.stopPropagation(), go());
        };
        onMount(() => {
          window.addEventListener("keydown", key, true);
          // Cancel takes the focus: Enter or a stray Space never confirms by itself
          cancel.focus();
        });
        onCleanup(() => window.removeEventListener("keydown", key, true));
        return (
          <Portal>
            <div class="backdrop confirm-backdrop" onClick={close}>
              <div class="confirm" role="alertdialog" aria-modal="true" aria-label={a.title} onClick={(e) => e.stopPropagation()}>
                <h3 class="confirm-title">{a.title}</h3>
                <Show when={body()}><p class="confirm-body">{body()}</p></Show>
                <div class="confirm-foot">
                  <button ref={cancel} class="btn sm" onClick={close}>{t("취소")}</button>
                  <button class="btn sm" classList={{ danger: !!a.danger, primary: !a.danger }} onClick={go}>{a.action}</button>
                </div>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

/** A small helper for the ⋯ menu in a header: the same list inside an anchored .menu. */
export function TaskMenuPanel(props: { id: string; done: () => void; style?: JSX.CSSProperties }) {
  let el!: HTMLDivElement;
  return (
    <div ref={el} class="menu" role="menu" style={props.style} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => arrowKeys(e, el)}>
      <MenuList items={taskMenuItems(props.id)} done={props.done} />
    </div>
  );
}
