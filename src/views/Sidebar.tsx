// The left side, after T3 Code: main on top, then one quiet row per job with a
// static status glyph (DESIGN.md §8). The git-style flow lives in the right panel.
import { switchSpace } from "../state/workspace";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { anyPop } from "../ui/ModelPicker";
import { taskDiff } from "../state/progress";
import { addProject, decisionsIn, projectsIn, removeProject, renameProject, state, taskById, tasksIn } from "../state/store";
import { pickFolder, revealPath } from "../lib/native";
import { expand } from "../engine/rpc";
import { confirmAsk, ctxFor, onRename, openMenuAt, openTaskMenu, type MenuEntry } from "../ui/taskMenu";
import type { Task } from "../state/types";
import { goMain, hoverTask, openTask, setHoverTask, setPaletteMode, setPaletteOpen, setSidebarHidden, setView, showSidebar, sidebarAway, view } from "../state/ui";
import { ignoredKey, noModifiers, shortcutHint } from "../lib/shortcuts";
import { ago, compact, now } from "../ui/bits";
import { bootedDevices, devices, usedBy } from "../state/devices";
import { Icon } from "../ui/Icon";
import { ProjectBadge } from "../ui/ProjectBadge";
import { Fold } from "../ui/Fold";
import { archiveTask, togglePin } from "../engine/tasks";
import { t as tr } from "../i18n";

export type Bucket = "you" | "review" | "work" | "done";

/** What a job needs from you. A subagent waiting on you pulls its job up. */
export function bucket(t: Task): Bucket {
  const kids = state.tasks.filter((k) => k.parentId === t.id);
  // a subagent that failed under a job that has finished anyway needs nothing from you
  const open = t.status !== "done";
  if (t.status === "waiting" || t.status === "failed" || kids.some((k) => k.status === "waiting" || (open && k.status === "failed"))) return "you";
  if (t.status === "done") return t.worktree?.state === "open" ? "review" : "done";
  return "work";
}

/** Jobs of a space, most urgent first (the order ⌘⇧[ ] walks). */
export function forkOrder(space: string): Task[] {
  const order: Bucket[] = ["you", "review", "work", "done"];
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
const ended = (t: Task) => t.status === "done" && t.worktree?.state !== "open";

/** The status glyph's shape (st-icon classes): what the row needs, not only its own status.
 *  One look everywhere a task is listed: sidebar, ⌘K, the 내 차례 popover. */
export function glyphOf(x: Task): "failed" | "waiting" | "inreview" | "running" | "paused" | "queued" | "done" {
  const b = bucket(x);
  if (x.status === "failed") return "failed";
  if (b === "you") return "waiting";
  if (b === "review") return "inreview";
  if (x.status === "running") return "running";
  if (x.status === "paused" || x.status === "queued") return x.status;
  return "done";
}
export function Glyph(props: { t: Task; class?: string }) {
  const g = () => glyphOf(props.t);
  return (
    <span class={`sb-glyph st-icon sm ${g()} ${props.class ?? ""}`} aria-hidden="true">
      <Show when={g() === "running"} fallback={<Show when={g() === "done"} fallback={<i />}><Icon name="check" size={9} stroke={2.5} /></Show>}>
        <span class="spin" />
      </Show>
    </span>
  );
}

// ───────────── one row per job (T3-style thread list)
function Row(props: { t: Task; kid?: boolean; index: number }) {
  const t = () => props.t;
  const kids = () => state.tasks.filter((k) => k.parentId === t().id).sort((a, b) => a.createdAt - b.createdAt);
  const [open, setOpen] = createSignal<boolean | undefined>(undefined);
  const showKids = () => open() ?? (openRoot() === t().id || kids().some((k) => k.status === "waiting" || k.status === "failed"));
  const b = () => bucket(t());
  const tone = () =>
    t().status === "failed" ? "bad" : b() === "you" ? "ask" : b() === "review" ? "review" : t().status === "running" ? "live" : t().status === "queued" || t().status === "paused" ? "idle" : "done";
  const meta = () => {
    const x = t();
    if (x.status === "failed") return tr("실패");
    if (x.status === "waiting" || (b() === "you" && !props.kid)) return tr("응답 필요");
    if (b() === "review") return tr("검토");
    if (x.status === "queued") return tr("대기");
    if (x.status === "paused") return tr("일시정지");
    if (x.status === "running") return x.startedAt ? (now() - x.startedAt < 60_000 ? tr("방금") : compact(now() - x.startedAt)) : "";
    return ago(x.finishedAt ?? x.createdAt);
  };
  // a task in review says so; its size is in the tooltip
  const tip = () => {
    const d = changes(t());
    return b() === "review" && (d.add || d.del) ? `${t().title} · +${d.add} −${d.del}` : t().title;
  };
  return (
    <>
      <button
        class={`sb-row tone-${tone()}`}
        classList={{ menu: ctxFor() === `task:${t().id}`, on: openId() === t().id, kid: props.kid, hot: hoverTask() === t().id, past: ended(t()) }}
        style={{ "--i": props.index }}
        data-task={t().id}
        onClick={() => openTask(t().id)}
        onMouseEnter={() => setHoverTask(props.kid ? t().parentId! : t().id)}
        onMouseLeave={() => setHoverTask(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          openTaskMenu(t().id, e);
        }}
        title={tip()}
      >
        <Glyph t={t()} />
        <span class="sb-title">{t().title}</span>
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
    { id: "new", label: tr("새 작업"), icon: "compose", run: () => (goMain(p.id), setTimeout(() => document.getElementById("main-input")?.focus(), 60)) },
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
const [needsMenu, setNeedsMenu] = createSignal<{ x: number; y: number } | null>(null);
function NeedsMenu() {
  let el!: HTMLDivElement;
  const close = () => setNeedsMenu(null);
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
  const list = () => forkOrder(state.space).filter((t) => !t.archived && (bucket(t) === "you" || bucket(t) === "review"));
  const where = (t: Task) => projectsIn(state.space).find((p) => p.id === t.project)?.name;
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
                <Glyph t={t} />
                <span class="row-title">{t.title}</span>
                <span class="row-hint">{bucket(t) === "you" ? (t.status === "failed" ? tr("실패") : tr("응답 필요")) : tr("검토")}{where(t) ? ` · ${where(t)}` : ""}</span>
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
function Head(props: { id: string; label: string; count?: number; children?: any }) {
  const shut = () => !!fold(props.id);
  return (
    <div class="sb-head">
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

export function Sidebar() {
  const [older, setOlder] = createSignal(false);
  const [showArchived, setShowArchived] = createSignal(false);
  const roots = createMemo(() =>
    tasksIn(state.space)
      .filter((t) => !t.parentId && !t.answer && !t.archived)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)),
  );
  const archived = createMemo(() => tasksIn(state.space).filter((t) => !t.parentId && t.archived).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)));
  // finished (and merged) jobs leave the list after a few minutes; the canvas keeps them
  const old = (t: Task) => !t.pinned && ended(t) && (t.finishedAt ?? t.createdAt) < now() - DONE_FOR && t.id !== openRoot();
  const shown = () => roots().filter((t) => !old(t));
  const hidden = () => roots().filter(old).length;
  // jobs not filed under a project row (no project, or one not in this space)
  const loose = () => shown().filter((t) => !t.project || !projectsIn(state.space).some((p) => p.id === t.project));
  const needs = () => roots().filter((t) => bucket(t) === "you" || bucket(t) === "review").length;
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
        <span class="spacer" data-tauri-drag-region />
        <button class="icon-btn" data-shortcut="new" title={`${tr("새 작업")} ${shortcutHint("new")}`} aria-label={tr("새 작업")} onClick={() => { goMain(); setTimeout(() => document.getElementById("main-input")?.focus(), 60); }}>
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
            <button classList={{ on: state.space === s.id }} onClick={() => switchSpace(s.id)} data-shortcut={`sp-${s.id}`} title={`⌘${state.spaces.indexOf(s) + 1}`} aria-pressed={state.space === s.id}>
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
        <button class="sb-row sb-main" classList={{ on: view().name === "main" && !curProject() }} onClick={() => goMain()} data-shortcut="main">
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
        <Show when={needs()}>
          <button
            class="sb-row sb-main sb-todo"
            classList={{ open: !!needsMenu() }}
            aria-haspopup="menu"
            aria-expanded={!!needsMenu()}
            onClick={(e) => {
              e.stopPropagation();
              if (needs() === 1) return void openTask(nextWaiting(state.space)!.id);
              if (needsMenu()) return setNeedsMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setNeedsMenu({ x: r.right + 8, y: r.top - 4 });
            }}
            data-shortcut="waiting"
            title={`${tr("다음 내 차례")} ${shortcutHint("waiting")}`}
          >
            <Icon name="hand" size={16} class="sb-main-ic" />
            <span class="sb-title">{tr("내 차례")}</span>
            <span class="sb-need">{needs()}</span>
          </button>
        </Show>
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
              const live = () => state.tasks.filter((t) => t.space === p.space && t.project === p.id && t.status === "running").length;
              // this project's jobs live under it; open by default while one is going or needs you
              const jobs = () => shown().filter((t) => t.project === p.id);
              // the number and the fold go by what the row shows when opened (older finished jobs live under 끝난 일)
              const all = () => jobs().length;
              const open = () => fold(`p:${p.id}`) ?? (curProject() === p.id || jobs().some((t) => !ended(t) || t.id === openRoot()));
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
                        <For each={jobs()} fallback={<p class="sb-empty sm">{tr("완료된 작업만 있어요")}</p>}>{(t, i) => <Row t={t} index={i()} />}</For>
                      </div>
                    </Fold>
                  </Show>
                </>
              );
            }}
          </For>
        </div>
        </Fold>

        <Head id="devices" label={tr("디바이스")} count={bootedDevices().length}>
          <button class="icon-btn xs" classList={{ on: view().name === "devices" }} data-shortcut="devices" title={`${tr("디바이스 열기")} ${shortcutHint("devices")}`} aria-label={tr("디바이스 열기")} onClick={() => setView({ name: "devices" })}>
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
                <button class="sb-row sb-proj" classList={{ on: (() => { const v = view(); return v.name === "devices" && v.device === d.id; })() }} onClick={() => setView({ name: "devices", device: d.id })} title={`${d.name} · ${d.runtime}${job() ? ` · ${job()!.title}` : ""}`}>
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

        <Show when={loose().length || hidden() || archived().length}>
        <Head id="jobs" label={projectsIn(state.space).length ? tr("기타 작업") : tr("작업")} count={loose().length} />
        <Fold open={!fold("jobs")}>
        <div class="sb-list">
          <For each={loose()}>
            {(t, i) => <Row t={t} index={i()} />}
          </For>
          <Show when={hidden()}>
            <button class="sb-older" classList={{ open: older() }} onClick={() => setOlder(!older())}>
              <Icon name="chevron" size={12} class="sb-older-chev" />
              {tr("완료 {n}개", { n: hidden() })}
            </button>
            {/* they open right here, under the button, not back in their places above */}
            <Show when={older()}>
              <For each={roots().filter(old)}>{(t, i) => <Row t={t} index={i()} />}</For>
            </Show>
          </Show>
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

/** Shown in a header while the sidebar is folded away. */
export function SidebarToggle() {
  const waiting = () => forkOrder(state.space).filter((t) => bucket(t) === "you").length;
  return (
    <Show when={sidebarAway()}>
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
  const list = forkOrder(space).filter((t) => bucket(t) === "you" || bucket(t) === "review");
  const i = list.findIndex((t) => t.id === openRoot());
  return list[(i + 1) % Math.max(1, list.length)];
}
