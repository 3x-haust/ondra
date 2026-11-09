// The left side, after T3 Code: main on top, then one quiet row per job with a
// static status glyph (DESIGN.md §8). The git-style flow lives in the right panel.
import { UpdateButton } from "../ui/UpdateButton";
import { switchSpace } from "../state/workspace";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { anyPop, usePop } from "../ui/ModelPicker";
import { taskDiff, discarded, endTime } from "../state/progress";
import { addProject, decisionsIn, projectsIn, removeProject, renameProject, kidsOf, state, taskById, tasksIn } from "../state/store";
import { pickFolder, revealPath } from "../lib/native";
import { expand } from "../engine/rpc";
import { confirmAsk, ctxFor, onRename, openMenuAt, openTaskMenu, type MenuEntry } from "../ui/taskMenu";
import type { Task } from "../state/types";
import { goMain, hoverTask, openTask, setHoverTask, setMemoryFocus, setPaletteMode, setPaletteOpen, setSidebarHidden, setView, showSidebar, sidebarAway, view } from "../state/ui";
import { ignoredKey, noModifiers, shortcutHint } from "../lib/shortcuts";
import { ago, compact, newTaskOpen, soon, taskTitle } from "../ui/bits";
import { openInSplit, startTaskDrag } from "./PaneControls";
import { bootedDevices, devices, usedBy } from "../state/devices";
import { Icon } from "../ui/Icon";
import { ProjectBadge } from "../ui/ProjectBadge";
import { Fold } from "../ui/Fold";
import { archiveTask, togglePin } from "../engine/tasks";
import { conflictsIn } from "../engine/tidy";
import { t as tr } from "../i18n";

export type Bucket = "you" | "failed" | "review" | "work" | "done";

/** What a job needs from you. A subagent waiting on you pulls its job up.
 *  Failed is its own bucket: never counted or shown as 응답 필요. */
export function bucket(t: Task): Bucket {
  // its changes were thrown away: nothing left to do or look at
  if (discarded(t)) return "done";
  const kids = kidsOf(t.id);
  if (t.status === "waiting" || kids.some((k) => k.status === "waiting")) return "you";
  // a subagent that failed under a job that has finished anyway needs nothing from you
  if (t.status === "failed" || (t.status !== "done" && kids.some((k) => k.status === "failed"))) return "failed";
  if (t.status === "done") return t.worktree?.state === "open" ? "review" : "done";
  return "work";
}
/** needs you: a reply, a failure to look at, or a merge (내 차례) */
export const needsYou = (t: Task) => bucket(t) === "you" || bucket(t) === "failed" || bucket(t) === "review";

/** Jobs of a space, most urgent first (the order ⌘⇧[ ] walks). */
export function forkOrder(space: string): Task[] {
  const order: Bucket[] = ["you", "failed", "review", "work", "done"];
  return tasksIn(space as Task["space"])
    .filter((t) => !t.parentId && !t.answer)
    .sort((a, b) => order.indexOf(bucket(a)) - order.indexOf(bucket(b)) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
}

export function changes(t: Task) {
  return taskDiff(t);
}


const openId = () => {
  const v = view();
  return v.name === "task" ? v.id : undefined;
};
const openRoot = () => {
  let t = openId() ? taskById(openId()!) : undefined;
  while (t?.parentId) t = taskById(t.parentId);
  return t?.id;
};

/** A job's line ends when it was merged, thrown away, or had nothing to merge. */
/** how long a finished job stays in the list */
const DONE_FOR = 10 * 60_000;
const ended = (t: Task) => (t.status === "done" && t.worktree?.state !== "open") || discarded(t);

export type GlyphKind = "failed" | "waiting" | "inreview" | "running" | "paused" | "queued" | "done" | "discarded";
/** The status glyph's shape (st-icon classes): what the row needs, not only its own status.
 *  One look everywhere a task's state shows: sidebar, ⌘K, 내 차례, header, board, canvas, flow. */
export function glyphOf(x: Task): GlyphKind {
  const b = bucket(x);
  if (discarded(x)) return "discarded";
  if (x.status === "failed") return "failed";
  if (b === "you") return "waiting";
  if (b === "review") return "inreview";
  if (x.status === "running") return "running";
  if (x.status === "paused" || x.status === "queued") return x.status;
  return "done";
}
/** A state's mark, read by shape as well as colour: done ✓, review ring + dot, paused ring + ‖,
 *  discarded a muted trash, queued a dashed ring, running a pie. For places with no one task. */
export function GlyphMark(props: { g: GlyphKind; class?: string }) {
  return (
    <span class={`sb-glyph st-icon sm ${props.g} ${props.class ?? ""}`} aria-hidden="true">
      <Switch fallback={<i />}>
        <Match when={props.g === "running"}><span class="spin" /></Match>
        <Match when={props.g === "done"}><Icon name="check" size={9} stroke={2.5} /></Match>
        <Match when={props.g === "paused"}><b class="pz" /></Match>
        <Match when={props.g === "discarded"}><Icon name="trash" size={14} /></Match>
      </Switch>
    </span>
  );
}
export function Glyph(props: { t: Task; class?: string }) {
  return <GlyphMark g={glyphOf(props.t)} class={props.class} />;
}

/** What a task's row says on the right, and in which tone: its state when it needs something
 *  (응답 필요, 병합 필요, 실패 ...), else how long it has run or when it finished. Sidebar and ⌘K. */
export function stateMeta(x: Task, kid = false): { text: string; tone: "bad" | "ask" | "review" | "idle" | "live" | "done" } {
  const b = bucket(x);
  if (discarded(x)) return { text: tr("버림"), tone: "idle" };
  if (x.status === "failed") return { text: tr("실패"), tone: "bad" };
  if (x.status === "waiting" || (b === "you" && !kid)) return { text: tr("응답 필요"), tone: "ask" };
  if (b === "review") return { text: tr("병합 필요"), tone: "review" };
  if (x.status === "queued") return { text: tr("대기"), tone: "idle" };
  if (x.status === "paused") return { text: tr("일시정지"), tone: "idle" };
  if (x.status === "running") return { text: x.startedAt ? (soon() - x.startedAt < 60_000 ? tr("방금") : compact(soon() - x.startedAt)) : "", tone: "live" };
  // merged: when it was merged (older tasks without mergedAt: when it finished)
  return { text: ago(endTime(x)), tone: "done" };
}

// ───────────── one row per job (T3-style thread list)
function Row(props: { t: Task; kid?: boolean; index: number }) {
  const t = () => props.t;
  const kids = () => [...kidsOf(t().id)].sort((a, b) => a.createdAt - b.createdAt);
  const [open, setOpen] = createSignal<boolean | undefined>(undefined);
  const showKids = () => open() ?? (openRoot() === t().id || kids().some((k) => k.status === "waiting" || k.status === "failed"));
  const b = () => bucket(t());
  const tone = () => stateMeta(t(), props.kid).tone;
  const meta = () => stateMeta(t(), props.kid).text;
  // a task in review says so; its size is in the tooltip
  const tip = () => {
    const d = changes(t());
    return b() === "review" && (d.add || d.del) ? `${t().title} · +${d.add} −${d.del}` : t().title;
  };
  return (
    <>
      <button
        class="sb-row"
        classList={{ [`tone-${tone()}`]: true, menu: ctxFor() === `task:${t().id}`, on: openId() === t().id, kid: props.kid, hot: hoverTask() === t().id, past: ended(t()) }}
        style={{ "--i": props.index }}
        data-task={t().id}
        // ⌥ or ⌘ opens it in a pane to the right; dragged, it goes where it is dropped
        onClick={(e) => (e.altKey || e.metaKey ? void openInSplit(t().id) : openTask(t().id))}
        onPointerDown={(e) => startTaskDrag(e, t().id)}
        onMouseEnter={() => setHoverTask(props.kid ? t().parentId! : t().id)}
        onMouseLeave={() => setHoverTask(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          openTaskMenu(t().id, e);
        }}
        title={tip()}
      >
        <Glyph t={t()} />
        <span class="sb-title">{taskTitle(t())}</span>
        <Show when={!props.kid && kids().length}>
          <span
            class="sb-kids"
            classList={{ open: showKids() }}
            role="button"
            title={showKids() ? tr("서브에이전트 접기") : tr("서브에이전트 {n}개", { n: kids().length })}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!showKids());
            }}
          >
            {kids().length}
            <Icon name="chevron" size={12} class="sb-kids-chev" />
          </span>
        </Show>
        {/* the time and the hover actions share one slot: hovering swaps them, the title keeps its width */}
        <span class="sb-trail" classList={{ acts: !props.kid }}>
          <span class="sb-meta">
            <Show when={t().pinned && !props.kid}><Icon name="pin" size={12} class="sb-pin" /></Show>
            {meta()}
          </span>
          <Show when={!props.kid}>
            <span class="sb-acts">
              <span class="sb-act" role="button" title={t().pinned ? tr("고정 해제") : tr("고정")} aria-label={t().pinned ? tr("고정 해제") : tr("고정")} onClick={(e) => (e.stopPropagation(), togglePin(t().id))}>
                <Icon name="pin" size={14} />
              </span>
              <span class="sb-act" role="button" title={tr("보관")} aria-label={tr("보관")} onClick={(e) => (e.stopPropagation(), archiveTask(t().id))}>
                <Icon name="archive" size={14} />
              </span>
            </span>
          </Show>
        </span>
      </button>
      <Show when={!props.kid && showKids() && kids().length}>
        <div class="sb-kid-list">
          <For each={kids()}>{(k, i) => <Row t={k} kid index={i()} />}</For>
        </div>
      </Show>
    </>
  );
}

/** a project's menu: open, start a task there, rename, show the folder, remove it from the list */
function projectMenu(id: string): MenuEntry[] {
  const p = projectsIn(state.space).find((x) => x.id === id);
  if (!p) return [];
  const n = state.tasks.filter((t) => t.space === p.space && t.project === p.id && !t.parentId && !t.answer).length;
  return [
    { id: "open", label: tr("열기"), icon: "arrow", run: () => goMain(p.id) },
    { id: "new", label: tr("새 작업"), icon: "compose", run: () => void import("./MainView").then((m) => m.startNewTask(p.id)) },
    "sep",
    { id: "rename", label: tr("이름 바꾸기"), icon: "pencil", run: () => setRenamingProject(p.id) },
    { id: "finder", label: tr("Finder에서 보기"), icon: "folder", run: () => void revealPath(expand(p.folder)) },
    "sep",
    {
      id: "remove",
      label: tr("목록에서 제거"),
      icon: "trash",
      danger: true,
      run: () =>
        confirmAsk({
          title: tr("{name} 프로젝트를 목록에서 제거할까요?", { name: p.name }),
          body: n ? tr("폴더와 작업 {n}개는 그대로 남아요", { n }) : tr("폴더는 그대로 남아요"),
          action: tr("제거"),
          danger: true,
          run: () => {
            const v = view();
            if (v.name === "main" && v.project === p.id) goMain();
            removeProject(p.id);
          },
        }),
    },
  ];
}
const [renamingProject, setRenamingProject] = createSignal<string | null>(null);

/** 내 차례: the tasks waiting on you, in a popover beside the row (§9.8) */
const [needsMenu, setNeedsMenu] = createSignal<{ x: number; y: number; keyboard?: boolean } | null>(null);
/** memory conflicts wait on the user too: one 메모리 확인 row in 내 차례, a count on 메모리 */
const memAsks = () => conflictsIn(state.space).length;
const openMemoryAsks = () => (setMemoryFocus(""), setView({ name: "memory" }));
function NeedsMenu() {
  let el!: HTMLDivElement;
  const close = () => {
    const m = needsMenu();
    if (!m) return;
    setNeedsMenu(null);
    const row = document.querySelector<HTMLElement>(".sidebar .sb-todo");
    if (m.keyboard) row?.focus();
    else if (document.activeElement === row) row?.blur();
  };
  const esc = (e: KeyboardEvent) => !ignoredKey(e) && noModifiers(e) && e.key === "Escape" && needsMenu() && (e.preventDefault(), e.stopPropagation(), close());
  const away = (e: Event) => needsMenu() && el && !el.contains(e.target as Node) && !(e.target as Element).closest?.(".sb-todo") && close();
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("blur", close);
  window.addEventListener("keydown", esc, true);
  createEffect(() => anyPop() && close());
  createEffect(() => ctxFor() && close());
  onCleanup(() => {
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("keydown", esc, true);
  });
  const list = () => forkOrder(state.space).filter((t) => !t.archived && needsYou(t));
  const where = (t: Task) => projectsIn(state.space).find((p) => p.id === t.project)?.name;
  createEffect(() => needsMenu() && !list().length && !memAsks() && close());
  return (
    <Show when={needsMenu()}>
      {(m) => (
        <div
          ref={el}
          class="menu ctx-menu needs-menu"
          role="menu"
          aria-label={tr("내 차례")}
          style={{ left: `${m().x}px`, top: `${Math.max(8, Math.min(m().y, window.innerHeight - 16 - (list().length + (memAsks() ? 1 : 0)) * 28))}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <For each={list()}>
            {(t) => (
              <button role="menuitem" onClick={() => (openTask(t.id), close())}>
                {/* a job whose subagent failed shows the failure: red glyph, 실패 */}
                <Show when={bucket(t) === "failed" && t.status !== "failed"} fallback={<Glyph t={t} />}>
                  <span class="sb-glyph st-icon sm failed" aria-hidden="true"><i /></span>
                </Show>
                <span class="row-title">{t.title}</span>
                {/* the state word in its tone, as on the sidebar row; the project in its own right-aligned column */}
                <span class={`needs-word tone-${bucket(t) === "failed" ? "bad" : bucket(t) === "you" ? "ask" : "review"}`}>{bucket(t) === "failed" ? tr("실패") : bucket(t) === "you" ? tr("응답 필요") : tr("병합 필요")}</span>
                <span class="needs-where">{where(t) ?? tr("프로젝트 없음")}</span>
              </button>
            )}
          </For>
          <Show when={memAsks()}>
            <Show when={list().length}><div class="menu-sep" role="separator" /></Show>
            <button role="menuitem" class="needs-mem" onClick={() => (openMemoryAsks(), close())}>
              <Icon name="memory" size={14} class="needs-mem-ic" />
              <span class="row-title">{tr("메모리 확인")}</span>
              <span class="needs-word tone-ask">{memAsks()}</span>
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

const [renaming, setRenaming] = createSignal<string | null>(null);
export { renaming, setRenaming };
// the shared task menu's 이름 바꾸기 edits the title in the task's header
onRename((id) => setRenaming(id));

/** The sidebar from the keyboard: ↑↓ move between rows, F2 renames a job, ⇧F10 or the menu key opens its menu (Enter opens it, as a button). */
function rowKeys(e: KeyboardEvent) {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".sb-row");
  if (!row || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const rows = [...document.querySelectorAll<HTMLElement>(".sidebar .sb-row")].filter((r) => r.offsetParent !== null);
    const next = rows[rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) (e.preventDefault(), next.focus(), next.scrollIntoView({ block: "nearest" }));
    return;
  }
  const id = row.dataset.task;
  const proj = row.dataset.project;
  if (e.key === "F2" && (id || proj)) {
    e.preventDefault();
    if (id) (openTask(id), setRenaming(id));
    else setRenamingProject(proj!);
  } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const at = new DOMRect(r.left + 24, r.top, 0, r.height);
    if (id) openTaskMenu(id, at, true);
    else if (proj) openMenuAt(`project:${proj}`, () => projectMenu(proj), at, true);
  }
}

// what's folded in the sidebar (sections, and each project's jobs), kept per machine
const FOLD_KEY = "ondra.sidebar.fold";
const [folds, setFolds] = createSignal<Record<string, boolean>>((() => {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}");
  } catch {
    return {};
  }
})());
// per space: each space's sidebar stays folded the way it was left
const fold = (k: string): boolean | undefined => folds()[`${state.space}:${k}`] ?? folds()[k];
const setFold = (k: string, v: boolean) => {
  const next = { ...folds(), [`${state.space}:${k}`]: v };
  setFolds(next);
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(next));
  } catch {}
};

/** A section title you can click to fold what's under it. */
function Head(props: { id: string; label: string; count?: number; on?: boolean; children?: any }) {
  const shut = () => !!fold(props.id);
  return (
    <div class="sb-head" classList={{ on: !!props.on }}>
      <button class="sb-head-btn" classList={{ shut: shut() }} onClick={() => setFold(props.id, !shut())} aria-expanded={!shut()}>
        {props.label}
        <Icon name="chevron" size={12} class="sb-head-chev" />
        <Show when={shut() && props.count}><span class="sb-head-n">{props.count}</span></Show>
      </button>
      <span class="spacer" />
      {props.children}
    </div>
  );
}

/** finished tasks folded away under their group; the count covers every row in the fold
 *  ("완료 2 · 버림 1" when some were thrown away); the open one shows in place, so its fold opens */
const [doneOpen, setDoneOpen] = createSignal<Record<string, boolean>>({});
function DoneFold(props: { id: string; tasks: Task[] }) {
  const has = () => props.tasks.some((t) => t.id === openRoot());
  const open = () => doneOpen()[props.id] ?? has();
  const label = () => {
    const gone = props.tasks.filter(discarded).length;
    const n = props.tasks.length - gone;
    if (n && gone) return tr("완료 {n}개 · 버림 {m}개", { n, m: gone });
    return n ? tr("완료 {n}개", { n }) : tr("버림 {n}개", { n: gone });
  };
  return (
    <Show when={props.tasks.length}>
      <button class="sb-older" classList={{ open: open() }} aria-expanded={open()} onClick={() => setDoneOpen((m) => ({ ...m, [props.id]: !open() }))}>
        <Icon name="chevron" size={12} class="sb-older-chev" />
        {label()}
      </button>
      <Fold open={open()}>
        <div class="sb-done-list">
          <For each={props.tasks}>{(t, i) => <Row t={t} index={i()} />}</For>
        </div>
      </Fold>
    </Show>
  );
}

export function Sidebar() {
  const [showArchived, setShowArchived] = createSignal(false);
  const roots = createMemo(() =>
    tasksIn(state.space)
      .filter((t) => !t.parentId && !t.answer && !t.archived)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)),
  );
  const archived = createMemo(() => tasksIn(state.space).filter((t) => !t.parentId && t.archived).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)));
  // finished (and merged) jobs fold away under their group after a few minutes; opening one
  // doesn't move it back up: it shows where it is, in its group's done fold
  const old = (t: Task) => !t.pinned && ended(t) && (t.finishedAt ?? t.createdAt) < soon() - DONE_FOR;
  const shown = createMemo(() => roots().filter((t) => !old(t)));
  const filed = (t: Task) => !!t.project && projectsIn(state.space).some((p) => p.id === t.project);
  // jobs not filed under a project row (no project, or one not in this space)
  const loose = createMemo(() => shown().filter((t) => !filed(t)));
  const looseDone = createMemo(() => roots().filter((t) => old(t) && !filed(t)));
  const needs = createMemo(() => roots().filter(needsYou).length);
  // 내 차례 counts memory conflicts too; the popover has a row per task and one 메모리 확인 row
  const turn = () => needs() + memAsks();
  const turnRows = () => needs() + (memAsks() ? 1 : 0);
  const boardLive = () => roots().filter((t) => t.status === "running").length;
  const mainBusy = () => state.captain.some((m) => m.space === state.space && !m.project && m.pending);
  const curProject = () => (view().name === "main" ? (view() as { project?: string }).project : undefined);
  const addFolder = async () => {
    const dir = await pickFolder(tr("프로젝트 폴더 선택"));
    if (!dir) return;
    const id = addProject(state.space, dir);
    goMain(id);
  };
  return (
    <aside class="sidebar" onKeyDown={rowKeys}>
      <div class="sb-top" data-tauri-drag-region>
        <UpdateButton />
        <span class="spacer" data-tauri-drag-region />
        <button class="icon-btn" classList={{ on: !!newTaskOpen() && view().name === "main" }} data-shortcut="new" title={`${tr("새 작업")} ${shortcutHint("new")}`} aria-label={tr("새 작업")} onClick={() => void import("./MainView").then((m) => m.startNewTask())}>
          <Icon name="compose" size={16} />
        </button>
        <button class="icon-btn" data-shortcut="search" title={`${tr("검색")} ${shortcutHint("search")}`} aria-label={tr("검색")} onClick={() => { setPaletteMode("all"); setPaletteOpen(true); }}>
          <Icon name="search" size={16} />
        </button>
        <button class="icon-btn" data-shortcut="sidebar" title={`${tr("사이드바 접기")} ${shortcutHint("sidebar")}`} aria-label={tr("사이드바 접기")} onClick={() => setSidebarHidden(true)}>
          <Icon name="panelLeft" size={16} />
        </button>
      </div>
      <Show when={state.spaces.length > 1}>
        <SpaceSwitch />
      </Show>

      <div
        class="sb-scroll"
        ref={(el) => {
          // more rows below the fold: the list fades out at the bottom instead of a clean cut
          const mark = () => el.classList.toggle("more", el.scrollTop + el.clientHeight < el.scrollHeight - 4);
          el.addEventListener("scroll", mark, { passive: true });
          const ro = new ResizeObserver(mark);
          ro.observe(el);
          const mo = new MutationObserver(mark);
          mo.observe(el, { childList: true, subtree: true });
          onCleanup(() => (ro.disconnect(), mo.disconnect()));
        }}
      >
        <button class="sb-row sb-main" classList={{ on: view().name === "main" && !curProject() && !newTaskOpen() }} onClick={() => goMain()} data-shortcut="main">
          <Icon name="message" size={16} class="sb-main-ic" />
          <span class="sb-title">{tr("메인")}</span>
          <Show when={mainBusy()} fallback={<kbd class="sb-kbd">{shortcutHint("main")}</kbd>}>
            <span class="spin sm" />
          </Show>
        </button>
        <button class="sb-row sb-main" classList={{ on: view().name === "board" }} onClick={() => setView({ name: "board" })} data-shortcut="board">
          <Icon name="canvas" size={16} class="sb-main-ic" />
          <span class="sb-title">{tr("캔버스")}</span>
          <Show when={boardLive()} fallback={<kbd class="sb-kbd">{shortcutHint("board")}</kbd>}>
            <span class="sb-live" title={tr("진행 중 {n}개", { n: boardLive() })}><span class="spin xs" />{boardLive()}</span>
          </Show>
        </button>
        <button class="sb-row sb-main" classList={{ on: view().name === "memory" }} onClick={() => setView({ name: "memory" })} data-shortcut="memory">
          <Icon name="memory" size={16} class="sb-main-ic" />
          <span class="sb-title">{tr("메모리")}</span>
          <Show when={memAsks()} fallback={<kbd class="sb-kbd">{shortcutHint("memory")}</kbd>}>
            <span class="sb-need" title={tr("확인 필요 {n}개", { n: memAsks() })}>{memAsks()}</span>
          </Show>
        </button>
        <button class="sb-row sb-main" classList={{ on: view().name === "results" }} onClick={() => setView({ name: "results" })} data-shortcut="results">
          <Icon name="inbox" size={16} class="sb-main-ic" />
          <span class="sb-title">{tr("결과물")}</span>
          <kbd class="sb-kbd">{shortcutHint("results")}</kbd>
        </button>
        {/* tasks anywhere in this space that need a reply or a merge: a row of its own, not under one section */}
        {/* the row stays when nothing waits (greyed, no count), so nothing below it moves */}
          <button
            class="sb-row sb-main sb-todo"
            classList={{ open: !!needsMenu(), empty: !turn() }}
            aria-haspopup={turnRows() > 1 ? "menu" : undefined}
            aria-expanded={turnRows() > 1 ? !!needsMenu() : undefined}
            aria-disabled={!turn()}
            onClick={(e) => {
              e.stopPropagation();
              if (!turn()) return;
              if (turnRows() === 1) return void (needs() ? openTask(nextWaiting(state.space)!.id) : openMemoryAsks());
              if (needsMenu()) return setNeedsMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setNeedsMenu({ x: r.right + 8, y: r.top - 4, keyboard: e.detail === 0 });
            }}
            data-shortcut="waiting"
            title={needs() ? `${tr("다음 내 차례")} ${shortcutHint("waiting")}` : undefined}
          >
            <Icon name="hand" size={16} class="sb-main-ic" />
            <span class="sb-title">{tr("내 차례")}</span>
            <Show when={turn()}><span class="sb-need">{turn()}</span></Show>
          </button>
        <Head id="projects" label={tr("프로젝트")} count={projectsIn(state.space).length}>
          <Show when={projectsIn(state.space).length}>
            <button class="icon-btn xs" title={tr("프로젝트 추가")} aria-label={tr("프로젝트 추가")} onClick={() => void addFolder()}>
              <Icon name="plus" size={14} />
            </button>
          </Show>
        </Head>
        <Fold open={!fold("projects")}>
        <div class="sb-projects">
          <For
            each={projectsIn(state.space)}
            fallback={
              <button class="sb-row sb-proj sb-add" onClick={() => void addFolder()}>
                <Icon name="plus" size={16} class="sb-main-ic" />
                <span class="sb-title">{tr("프로젝트 추가")}</span>
              </button>
            }
          >
            {(p) => {
              const busy = () => state.captain.some((m) => m.space === state.space && m.project === p.id && m.pending);
              // top-level tasks only, like every running count (a subagent is part of its task)
              const live = () => state.tasks.filter((t) => t.space === p.space && t.project === p.id && !t.parentId && t.status === "running").length;
              // this project's jobs live under it; open by default while one is going or needs you
              const jobs = createMemo(() => shown().filter((t) => t.project === p.id));
              const done = createMemo(() => roots().filter((t) => old(t) && t.project === p.id));
              // the number and the fold go by what the row holds: its jobs and its done fold
              const all = () => jobs().length + done().length;
              const open = () => fold(`p:${p.id}`) ?? (curProject() === p.id || jobs().some((t) => !ended(t)) || [...jobs(), ...done()].some((t) => t.id === openRoot()));
              return (
                <>
                  <button
                    class="sb-row sb-proj"
                    classList={{ on: curProject() === p.id, has: all() > 0, open: open(), menu: ctxFor() === `project:${p.id}` }}
                    data-project={p.id}
                    onClick={() => renamingProject() !== p.id && goMain(p.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenuAt(`project:${p.id}`, () => projectMenu(p.id), e);
                    }}
                    title={p.folder}
                  >
                    <span
                      class="sb-proj-ic"
                      title={all() ? (open() ? tr("접기") : tr("펼치기")) : undefined}
                      onClick={(e) => {
                        if (!all()) return;
                        e.stopPropagation();
                        setFold(`p:${p.id}`, !open());
                      }}
                    >
                      <ProjectBadge name={p.name} class="ic-folder" />
                      <Icon name="chevron" size={12} class="ic-chev" />
                    </span>
                    <Show when={renamingProject() === p.id} fallback={<span class="sb-title">{p.name}</span>}>
                      <input
                        class="sb-rename"
                        value={p.name}
                        aria-label={tr("이름 바꾸기")}
                        ref={(el) => setTimeout(() => (el.focus(), el.select()), 0)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter" && !e.isComposing) (renameProject(p.id, e.currentTarget.value), setRenamingProject(null));
                          else if (e.key === "Escape") setRenamingProject(null);
                        }}
                        onBlur={(e) => renamingProject() === p.id && (renameProject(p.id, e.currentTarget.value), setRenamingProject(null))}
                      />
                    </Show>
                    <span class="sb-trail acts">
                      <span class="sb-meta">
                        <Show when={busy()} fallback={<Show when={live()} fallback={<Show when={all() && !open()}>{all()}</Show>}><span class="sb-live" title={tr("진행 중 {n}개", { n: live() })}><span class="spin xs" />{live()}</span></Show>}>
                          <span class="spin sm" />
                        </Show>
                      </span>
                      <span class="sb-acts">
                        <span
                          class="sb-act"
                          role="button"
                          title={tr("더보기")}
                          aria-label={tr("더보기")}
                          onClick={(e) => {
                            e.stopPropagation();
                            openMenuAt(`project:${p.id}`, () => projectMenu(p.id), e.currentTarget.getBoundingClientRect());
                          }}
                        >
                          <Icon name="more" size={14} />
                        </span>
                      </span>
                    </span>
                  </button>
                  <Show when={all()}>
                    <Fold open={open()}>
                      <div class="sb-proj-jobs">
                        <For each={jobs()}>{(t, i) => <Row t={t} index={i()} />}</For>
                        <DoneFold id={`p:${p.id}`} tasks={done()} />
                      </div>
                    </Fold>
                  </Show>
                </>
              );
            }}
          </For>
        </div>
        </Fold>

        <Head id="devices" label={tr("디바이스")} count={bootedDevices().length} on={(() => { const v = view(); return v.name === "devices" && !bootedDevices().some((d) => d.id === v.device); })()}>
          <button class="icon-btn xs" data-shortcut="devices" title={`${tr("디바이스 열기")} ${shortcutHint("devices")}`} aria-label={tr("디바이스 열기")} onClick={() => setView({ name: "devices" })}>
            <Icon name="arrow" size={14} />
          </button>
        </Head>
        <Fold open={!fold("devices")}>
        <div class="sb-projects">
          <For
            each={bootedDevices()}
            fallback={
              <button class="sb-row sb-proj" onClick={() => setView({ name: "devices" })}>
                <Icon name="phone" size={16} class="sb-main-ic" />
                <span class="sb-title muted">{tr("켜진 기기 없음")}</span>
                <span class="sb-meta">{tr("전체 {n}개", { n: devices().length })}</span>
              </button>
            }
          >
            {(d) => {
              const job = () => usedBy(d);
              return (
                <button class="sb-row sb-proj" classList={{ on: (() => { const v = view(); return v.name === "devices" && v.device === d.id; })() }} onClick={() => setView({ name: "devices", device: d.id })} title={[d.name, tr(d.runtime), job()?.title].filter(Boolean).join(" · ")}>
                  <Icon name="phone" size={16} class="sb-main-ic" />
                  <span class="sb-title">{d.name}</span>
                  <span class="sb-meta">{d.platform === "ios" ? "iOS" : "Android"}</span>
                  <Show when={job()?.status === "running"}><span class="spin sm" /></Show>
                </button>
              );
            }}
          </For>
        </div>
        </Fold>

        <Show when={loose().length || looseDone().length || archived().length}>
        <Head id="jobs" label={projectsIn(state.space).length ? tr("프로젝트 없음") : tr("작업")} count={loose().length} />
        <Fold open={!fold("jobs")}>
        <div class="sb-list">
          <For each={loose()}>
            {(t, i) => <Row t={t} index={i()} />}
          </For>
          <DoneFold id="loose" tasks={looseDone()} />
          <Show when={archived().length}>
            <button class="sb-older" classList={{ open: showArchived() }} onClick={() => setShowArchived(!showArchived())}>
              <Icon name="chevron" size={12} class="sb-older-chev" />
              {tr("보관함 {n}개", { n: archived().length })}
            </button>
            <Show when={showArchived()}>
              <For each={archived()}>{(t, i) => <Row t={t} index={i()} />}</For>
            </Show>
          </Show>
        </div>
        </Fold>
        </Show>
      </div>
      <NeedsMenu />

      <div class="sb-foot">
        <button class="row" data-shortcut="settings" onClick={() => setView({ name: "settings" })}>
          <Icon name="gear" size={16} />
          <span class="row-title">{tr("설정")}</span>
          <kbd class="sb-kbd">{shortcutHint("settings")}</kbd>
        </button>
      </div>
    </aside>
  );
}

/** The workspace switcher: the current workspace by name, the others in a menu (⌘1–9 switch directly).
 *  A dot on it when another workspace has something waiting on you. */
function SpaceSwitch() {
  const [open, setOpen] = usePop();
  const cur = () => state.spaces.find((s) => s.id === state.space);
  const waits = (id: string) => decisionsIn(id).length > 0;
  const elsewhere = () => state.spaces.some((s) => s.id !== state.space && waits(s.id));
  const key = (i: number) => (i < 9 ? `⌘${i + 1}` : "");
  return (
    <div class="picker sb-space" onClick={(e) => e.stopPropagation()}>
      <button
        class="sb-space-btn"
        classList={{ on: open() }}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={tr("워크스페이스: {name}", { name: tr(cur()?.label ?? "") })}
        title={tr("워크스페이스 전환")}
        onClick={() => setOpen(!open())}
      >
        <ProjectBadge name={tr(cur()?.label ?? "")} class="sb-space-badge" />
        <span class="sb-space-name">{tr(cur()?.label ?? "")}</span>
        <Show when={elsewhere()}><i class="space-alert" title={tr("다른 워크스페이스에 응답 필요")} /></Show>
        <Icon name="down" size={14} class="sb-space-chev" />
      </button>
      <Show when={open()}>
        <div class="pop left sb-space-pop" role="menu" aria-label={tr("워크스페이스")}>
          <div class="pop-label">{tr("워크스페이스")}</div>
          <For each={state.spaces}>
            {(s, i) => (
              <button type="button" role="menuitemradio" aria-checked={s.id === state.space} class="pop-item" data-shortcut={`sp-${s.id}`} onClick={() => (setOpen(false), switchSpace(s.id))}>
                <ProjectBadge name={tr(s.label)} class="sb-space-badge" />
                <span class="pop-item-main">{tr(s.label)}</span>
                <Show when={s.id !== state.space && waits(s.id)}><i class="space-alert" title={tr("응답 필요")} /></Show>
                <Show when={s.id === state.space}><Icon name="check" size={14} class="sb-space-check" /></Show>
                <span class="menu-kbd">{key(i())}</span>
              </button>
            )}
          </For>
          <div class="pop-sep" />
          <button type="button" role="menuitem" class="pop-item" onClick={() => (setOpen(false), setView({ name: "settings", tab: "general" }))}>
            <span class="pop-item-main">{tr("워크스페이스 관리")}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

/** Shown in a header while the sidebar is folded away. */
export function SidebarToggle() {
  const waiting = () => forkOrder(state.space).filter((t) => bucket(t) === "you" || bucket(t) === "failed").length;
  return (
    <Show when={sidebarAway()}>
      <UpdateButton />
      <button class="icon-btn sb-show" data-shortcut="sidebar" title={`${tr("사이드바 펼치기")} ${shortcutHint("sidebar")}`} aria-label={tr("사이드바 펼치기")} onClick={showSidebar}>
        <Icon name="panelLeft" size={16} />
        <Show when={waiting()}><i class="sb-show-dot" /></Show>
      </button>
    </Show>
  );
}

/** For shortcuts: the job ⌘⇧[ / ⌘⇧] lands on, and the next thing that needs you (⌘.). */
export function stepFork(space: string, dir: 1 | -1): Task | undefined {
  const list = forkOrder(space).filter((t) => bucket(t) !== "done");
  if (!list.length) return undefined;
  const i = list.findIndex((t) => t.id === openRoot());
  return list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
}
export function nextWaiting(space: string): Task | undefined {
  const list = forkOrder(space).filter(needsYou);
  const i = list.findIndex((t) => t.id === openRoot());
  return list[(i + 1) % Math.max(1, list.length)];
}
