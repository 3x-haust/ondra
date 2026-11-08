// One menu for a task, wherever it is right-clicked or opened from ⋯ (DESIGN.md §9.8):
// the sidebar row, the task header, a board card and a canvas card all list the same
// items in the same order, with the same words and icons. Delete asks first (§9.9).
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { state, taskById } from "../state/store";
import { goMain, openPanel, openTask, toast, view } from "../state/ui";
import { archiveTask, discardTask, duplicateTask, finishTask, mergeTask, removeTask, resumeTask, startTask, stopTask, togglePin, transcriptMarkdown } from "../engine/tasks";
import { expand } from "../engine/rpc";
import { openInEditor, revealPath } from "../lib/native";
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
      { id: "rename", label: t("이름 바꾸기"), icon: "pencil", kbd: "F2", run: () => (openTask(id), startRename(id)) },
      { id: "pin", label: x.pinned ? t("고정 해제") : t("고정"), icon: "pin", run: () => togglePin(id) },
    ],
    [
      ...(x.status === "running" || x.status === "waiting" ? [{ id: "pause", label: t("일시정지|action"), icon: "pause", run: () => stopTask(id) }] : []),
      ...(x.status === "paused" || x.status === "failed" ? [{ id: "resume", label: t("다시 시작"), icon: "play", run: () => resumeTask(id) }] : []),
      ...(x.status === "queued" ? [{ id: "start", label: t("지금 시작"), icon: "play", run: () => void startTask(id) }] : []),
      ...(x.status !== "done" ? [{ id: "done", label: t("완료로 표시"), icon: "flag", run: () => finishTask(id) }] : []),
    ],
    x.worktree?.state === "open" && !live
      ? [
          { id: "merge", label: t("병합"), icon: "merge", run: () => void mergeTask(id) },
          { id: "discard", label: t("변경 버리기"), icon: "undo", run: () => void discardTask(id) },
        ]
      : [],
    [
      {
        id: "rerun",
        label: t("다시 실행"),
        icon: "refresh",
        run: () => {
          const n = duplicateTask(id);
          if (n) openTask(n);
        },
      },
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
    [
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
          <button role="menuitem" classList={{ danger: !!it.danger }} onClick={() => (props.done(), it.run())}>
            <Icon name={it.icon} size={16} />
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

const [ctx, setCtx] = createSignal<{ items: () => MenuEntry[]; x: number; y: number; key: string; keyboard?: boolean } | null>(null);
/** what the open right-click menu belongs to ("task:t1", "project:ondra"), to mark its row */
export const ctxFor = () => ctx()?.key;
export const closeCtx = () => setCtx(null);

/** Open a menu at a point (a right-click) or under an element (⇧F10, a ⋯ button). */
export function openMenuAt(key: string, items: () => MenuEntry[], at: MouseEvent | DOMRect, keyboard = false) {
  closePops();
  const p = at instanceof MouseEvent ? { x: at.clientX, y: at.clientY } : { x: at.left, y: at.bottom + 4 };
  setCtx({ key, items, ...p, keyboard });
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
          // no room below the pointer: it opens upward, like a macOS menu
          const top = m.y + r.height > innerHeight - 8 ? m.y - r.height : m.y;
          setPos({ left: Math.max(8, Math.min(m.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(top, innerHeight - r.height - 8)) });
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
  body?: string;
  action: string;
  danger?: boolean;
  run: () => void;
}
const [ask, setAsk] = createSignal<Ask | null>(null);
export const confirmAsk = (a: Ask) => (closePops(), setCtx(null), setAsk(a));

export function confirmDeleteTask(id: string) {
  const x = taskById(id);
  if (!x) return;
  const kids = state.tasks.filter((k) => k.parentId === id).length;
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
        let ok!: HTMLButtonElement;
        const close = () => setAsk(null);
        const go = () => (close(), a.run());
        const key = (e: KeyboardEvent) => {
          if (ignoredKey(e)) return;
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), close());
          else if (e.key === "Enter" && noModifiers(e) && document.activeElement?.tagName !== "BUTTON") (e.preventDefault(), e.stopPropagation(), go());
        };
        onMount(() => {
          window.addEventListener("keydown", key, true);
          ok.focus();
        });
        onCleanup(() => window.removeEventListener("keydown", key, true));
        return (
          <Portal>
            <div class="backdrop confirm-backdrop" onClick={close}>
              <div class="confirm" role="alertdialog" aria-modal="true" aria-label={a.title} onClick={(e) => e.stopPropagation()}>
                <h3 class="confirm-title">{a.title}</h3>
                <Show when={a.body}><p class="confirm-body">{a.body}</p></Show>
                <div class="confirm-foot">
                  <button class="btn sm" onClick={close}>{t("취소")}</button>
                  <button ref={ok} class="btn sm" classList={{ danger: !!a.danger, primary: !a.danger }} onClick={go}>{a.action}</button>
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
