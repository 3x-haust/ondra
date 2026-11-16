// The left side: main on top, then one quiet row per job with a
// static status glyph (DESIGN.md §8). The git-style flow lives in the right panel.
import { routineOf } from "../engine/routines";
import { version as appVersion } from "../../package.json";
import { isBeta } from "../lib/beta";
import { UpdateButton } from "../ui/UpdateButton";
import { switchSpace } from "../state/workspace";
import { MacBar } from "../ui/MacBar";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { anyPop } from "../ui/ModelPicker";
import { taskDiff, discarded, endTime } from "../state/progress";
import { addProject, decisionsIn, projectsShown, removeProject, renameProject, kidsOf, state, taskById, tasksShown, listed, carriedOn, lineHead } from "../state/store";
import { mirror, splitProjectId } from "../state/mirror";
import { hostState } from "../ui/ComputerPicker";
import { pickFolder, revealPath } from "../lib/native";
import { revealOn } from "../engine/far";
import { expand } from "../engine/rpc";
import { confirmAsk, ctxFor, onRename, openMenuAt, openTaskMenu, type MenuEntry } from "../ui/taskMenu";
import type { Task } from "../state/types";
import { goMain, hoverTask, openTask, setHoverTask, setPaletteMode, setPaletteOpen, setSidebarHidden, setView, showSidebar, sidebarAway, toast, view } from "../state/ui";
import { hideHostProject, showHostProject } from "../engine/hosts";
import { ignoredKey, noModifiers, shortcutHint, type ShortcutId } from "../lib/shortcuts";
import { ago, compact, newTaskOpen, soon, taskTitle } from "../ui/bits";
import { openInSplit, startTaskDrag } from "./PaneControls";
import { bootedDevices, devices, usedBy } from "../state/devices";
import { Icon } from "../ui/Icon";
import { ProjectBadge } from "../ui/ProjectBadge";
import { Fold } from "../ui/Fold";
import { archiveTask, togglePin } from "../engine/tasks";
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
  return tasksShown(space as Task["space"])
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
/** the open job's own top (a subagent's job) */
const openTop = () => {
  let t = openId() ? taskById(openId()!) : undefined;
  while (t?.parentId) t = taskById(t.parentId);
  return t?.id;
};
const openRoot = () => {
  let t = openTop() ? taskById(openTop()!) : undefined;
  // a follow-up shows under the job it carries on
  return t && lineHead(t).id;
};

/** every job down a job's line of follow-ups, oldest first */
function followUps(t: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set([t.id]);
  let ring = new Set([t.id]);
  while (ring.size) {
    const next = tasksShown(t.space).filter((x) => !seen.has(x.id) && listed(x) && ring.has(x.follows ?? "") && carriedOn(x));
    for (const x of next) seen.add(x.id);
    out.push(...next);
    ring = new Set(next.map((x) => x.id));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
/** still going: working, waiting on you, queued or paused */
const going = (t: Task) => t.status === "running" || t.status === "waiting" || t.status === "queued" || t.status === "paused";
/** a job and its follow-ups: the line sorts, folds away and counts as one */
const lineOf = (t: Task) => [t, ...followUps(t)];

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
function Row(props: { t: Task; kid?: boolean; follow?: boolean; index: number }) {
  const t = () => props.t;
  const kids = () => [...kidsOf(t().id)].sort((a, b) => a.createdAt - b.createdAt);
  const ups = () => (props.kid || props.follow ? [] : followUps(t()));
  // what folds under the row: its follow-ups and its subagents, opened and closed together
  const nested = () => kids().length + ups().length;
  const [open, setOpen] = createSignal<boolean | undefined>(undefined);
  // open by itself while something under it is going on, needs you, or is open
  const showKids = () =>
    open() ??
    (openTop() === t().id ||
      (ups().length > 0 && openRoot() === t().id) ||
      kids().some((k) => k.status === "waiting" || k.status === "failed") ||
      ups().some((f) => !ended(f) || needsYou(f)));
  // folded, a line whose newest follow-up is still going stands for that one: its state shows on
  // the row and a click goes there (opened, each row is its own job again)
  const liveUp = () => [...ups()].reverse().find(going);
  const face = () => (!showKids() && !going(t()) && liveUp()) || t();
  const foldTip = () => {
    if (showKids()) return tr("접기");
    if (!ups().length) return tr("서브에이전트 {n}개", { n: kids().length });
    if (!kids().length) return tr("이어진 작업 {n}개", { n: ups().length });
    return `${tr("이어진 작업 {n}개", { n: ups().length })} · ${tr("서브에이전트 {n}개", { n: kids().length })}`;
  };
  const b = () => bucket(t());
  const tone = () => stateMeta(face(), props.kid).tone;
  const meta = () => stateMeta(face(), props.kid).text;
  // a task in review says so; its size is in the tooltip
  const tip = () => {
    const d = changes(t());
    if (face() !== t()) return `${t().title} → ${face().title}`;
    return b() === "review" && (d.add || d.del) ? `${t().title} · +${d.add} −${d.del}` : t().title;
  };
  return (
    <>
      <button
        class="sb-row"
        classList={{ [`tone-${tone()}`]: true, menu: ctxFor() === `task:${t().id}`, on: openId() === t().id || openId() === face().id, kid: props.kid, follow: props.follow, shut: ups().length > 0 && !showKids(), hot: hoverTask() === t().id, past: ended(t()) }}
        style={{ "--i": props.index }}
        data-task={t().id}
        // ⌥ or ⌘ opens it in a pane to the right; dragged, it goes where it is dropped
        onClick={(e) => (e.altKey || e.metaKey ? void openInSplit(face().id) : openTask(face().id))}
        onPointerDown={(e) => startTaskDrag(e, t().id)}
        onMouseEnter={() => setHoverTask(props.kid ? t().parentId! : t().id)}
        onMouseLeave={() => setHoverTask(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          openTaskMenu(t().id, e);
        }}
        title={tip()}
      >
        <Glyph t={face()} />
        <Show when={!props.kid && routineOf(t())}><Icon name="repeat" size={12} class="sb-rt" /></Show>
        <span class="sb-title">{taskTitle(t())}</span>
        <Show when={!props.kid && nested()}>
          <span
            class="sb-kids"
            classList={{ open: showKids() }}
            role="button"
            aria-expanded={showKids()}
            title={foldTip()}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!showKids());
            }}
          >
            {nested()}
            <Icon name="chevron" size={12} class="sb-kids-chev" />
          </span>
        </Show>
        {/* the time and the hover actions share one slot: hovering swaps them, the title keeps its width */}
        <span class="sb-trail" classList={{ acts: !props.kid }}>
          <span class="sb-meta">
            <Show when={t().pinned && !props.kid}><Icon name="pin" size={12} class="sb-pin" fill /></Show>
            {meta()}
          </span>
          <Show when={!props.kid}>
            <span class="sb-acts">
              <span class="sb-act" classList={{ on: !!t().pinned }} role="button" aria-pressed={!!t().pinned} title={t().pinned ? tr("고정 해제") : tr("고정")} aria-label={t().pinned ? tr("고정 해제") : tr("고정")} onClick={(e) => (e.stopPropagation(), togglePin(t().id))}>
                <Icon name="pin" size={14} fill={!!t().pinned} />
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
      <Show when={showKids() && ups().length}>
        <div class="sb-follow-list">
          <For each={ups()}>{(f, i) => <Row t={f} follow index={i()} />}</For>
        </div>
      </Show>
    </>
  );
}

/** a project's menu: open, start a task there, rename, show the folder, remove it from the list */
function projectMenu(id: string): MenuEntry[] {
  const p = projectsShown(state.space).find((x) => x.id === id);
  if (!p) return [];
  const n = tasksShown(p.space).filter((t) => t.project === p.id && !t.parentId && !t.answer).length;
  const far = splitProjectId(p.id);
  // another Mac's project: it is that Mac's, shown here as it is there (it goes when it goes there);
  // it can be kept off the list here (Settings › 연결 brings it back)
  if (far)
    return [
      { id: "open", label: tr("열기"), icon: "arrow", run: () => goMain(p.id) },
      { id: "new", label: tr("새 작업"), icon: "compose", run: () => void import("./MainView").then((m) => m.startNewTask(p.id)) },
      "sep",
      {
        id: "hide",
        label: tr("목록에서 숨기기"),
        icon: "eyeOff",
        run: () => {
          hideHostProject(far.host, far.id);
          toast(tr("{name} 프로젝트를 숨겼어요", { name: p.name }), "info", { label: tr("다시 보이기"), run: () => showHostProject(far.host, far.id) });
        },
      },
      // its folder is there: Finder opens on that Mac's screen
      { id: "finder", label: tr("그 Mac의 Finder에서 보기"), icon: "folder", run: () => void revealOn(far.host, p.folder) },
    ];
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
  const where = (t: Task) => projectsShown(state.space).find((p) => p.id === t.project)?.name;
  createEffect(() => needsMenu() && !list().length && close());
  return (
    <Show when={needsMenu()}>
      {(m) => (
        <div
          ref={el}
          class="menu ctx-menu needs-menu"
          role="menu"
          aria-label={tr("내 차례")}
          style={{ left: `${m().x}px`, top: `${Math.max(8, Math.min(m().y, window.innerHeight - 16 - list().length * 28))}px` }}
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
  // every job in the list, follow-ups too (counts go by these)
  const every = createMemo(() => tasksShown(state.space).filter(listed));
  // the rows: a job with its follow-ups under it, placed by the newest of its line
  const latest = (t: Task) => Math.max(...lineOf(t).map((x) => x.startedAt ?? x.createdAt));
  const pinned = (t: Task) => lineOf(t).some((x) => x.pinned);
  const roots = createMemo(() =>
    every()
      .filter((t) => !carriedOn(t))
      .sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || latest(b) - latest(a)),
  );
  const archived = createMemo(() => tasksShown(state.space).filter((t) => !t.parentId && t.archived).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)));
  // finished (and merged) jobs fold away under their group after a few minutes; opening one
  // doesn't move it back up: it shows where it is, in its group's done fold
  const old = (t: Task) => lineOf(t).every((x) => !x.pinned && ended(x) && (x.finishedAt ?? x.createdAt) < soon() - DONE_FOR);
  const shown = createMemo(() => roots().filter((t) => !old(t)));
  const filed = (t: Task) => !!t.project && projectsShown(state.space).some((p) => p.id === t.project);
  // jobs not filed under a project row (no project, or one not in this space)
  const loose = createMemo(() => shown().filter((t) => !filed(t)));
  const looseDone = createMemo(() => roots().filter((t) => old(t) && !filed(t)));
  const needs = createMemo(() => every().filter(needsYou).length);
  const boardLive = () => every().filter((t) => t.status === "running").length;
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
      <div class="space-seg" style={{ "grid-template-columns": `repeat(${Math.min(3, state.spaces.length)}, minmax(0, 1fr))` }}>
        <For each={state.spaces}>
          {(s) => (
            <button classList={{ on: state.space === s.id }} onClick={() => switchSpace(s.id)} data-shortcut={`sp-${s.id}`} title={shortcutHint(`ws${state.spaces.indexOf(s) + 1}` as ShortcutId) || undefined} aria-pressed={state.space === s.id}>
              <span class="space-name">{tr(s.label)}</span>
              <Show when={s.id !== state.space && decisionsIn(s.id).length}><i class="space-alert" /></Show>
            </button>
          )}
        </For>
      </div>
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
          <kbd class="sb-kbd">{shortcutHint("memory")}</kbd>
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
            classList={{ open: !!needsMenu(), empty: !needs() }}
            aria-haspopup={needs() > 1 ? "menu" : undefined}
            aria-expanded={needs() > 1 ? !!needsMenu() : undefined}
            aria-disabled={!needs()}
            onClick={(e) => {
              e.stopPropagation();
              if (!needs()) return;
              if (needs() === 1) return void openTask(nextWaiting(state.space)!.id);
              if (needsMenu()) return setNeedsMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setNeedsMenu({ x: r.right + 8, y: r.top - 4, keyboard: e.detail === 0 });
            }}
            data-shortcut="waiting"
            title={needs() ? `${tr("다음 내 차례")} ${shortcutHint("waiting")}` : undefined}
          >
            <Icon name="hand" size={16} class="sb-main-ic" />
            <span class="sb-title">{tr("내 차례")}</span>
            <Show when={needs()}><span class="sb-need">{needs()}</span></Show>
          </button>
        <Head id="projects" label={tr("프로젝트")} count={projectsShown(state.space).length}>
          <Show when={projectsShown(state.space).length}>
            <button class="icon-btn xs" title={tr("프로젝트 추가")} aria-label={tr("프로젝트 추가")} onClick={() => void addFolder()}>
              <Icon name="plus" size={14} />
            </button>
          </Show>
        </Head>
        <Fold open={!fold("projects")}>
        <div class="sb-projects">
          <For
            each={projectsShown(state.space)}
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
              const live = () => tasksShown(p.space).filter((t) => t.project === p.id && !t.parentId && t.status === "running").length;
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
                    classList={{ on: curProject() === p.id, has: all() > 0, open: open(), menu: ctxFor() === `project:${p.id}`, away: !!p.host && mirror.hosts[p.host]?.status !== "ok" }}
                    data-project={p.id}
                    onClick={() => renamingProject() !== p.id && goMain(p.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenuAt(`project:${p.id}`, () => projectMenu(p.id), e);
                    }}
                    title={p.host ? `${p.hostName} · ${hostState(p.host)} · ${p.folder}` : p.folder}
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
                    <Show when={renamingProject() === p.id} fallback={<span class="sb-title">{p.name}<Show when={p.hostName}><span class="sb-host"><i class={`cn-dot is-${mirror.hosts[p.host!]?.status ?? "connecting"}`} aria-hidden="true" />{p.hostName}</span></Show></span>}>
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
        <Head id="jobs" label={projectsShown(state.space).length ? tr("프로젝트 없음") : tr("작업")} count={loose().length} />
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
          {/* Ondra is in beta until 1.0: the mark sits right after the word */}
          <span class="row-title">{tr("설정")}<Show when={isBeta(appVersion)}><span class="beta-chip">{tr("베타")}</span></Show></span>
          <kbd class="sb-kbd">{shortcutHint("settings")}</kbd>
        </button>
        <UpdateButton />
      </div>
      {/* this Mac, and once another is added, which Mac the current workspace's new work runs on (⌃1…) */}
      <MacBar />
    </aside>
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
