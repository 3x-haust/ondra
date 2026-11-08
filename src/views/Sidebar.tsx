// The left side, after T3 Code: main on top, then one quiet row per job with a
// static status glyph (DESIGN.md §8). The git-style flow lives in the right panel.
import { switchSpace } from "../state/workspace";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { anyPop, closePops } from "../ui/ModelPicker";
import { addProject, decisionsIn, projectsIn, removeProject, state, taskById, tasksIn } from "../state/store";
import { pickFolder } from "../lib/native";
import type { Task } from "../state/types";
import { toast, goMain, hoverTask, openTask, setHoverTask, setPaletteMode, setPaletteOpen, setSidebarHidden, setView, showSidebar, sidebarAway, view } from "../state/ui";
import { ignoredKey, noModifiers, shortcutHint } from "../lib/shortcuts";
import { ago, compact, now } from "../ui/bits";
import { bootedDevices, devices, usedBy } from "../state/devices";
import { Icon } from "../ui/Icon";
import { ProjectBadge } from "../ui/ProjectBadge";
import { Fold } from "../ui/Fold";
import { archiveTask, duplicateTask, togglePin, transcriptMarkdown } from "../engine/tasks";
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
  let add = 0;
  let del = 0;
  for (const e of t.entries) if (e.kind === "tool" && (e.tool.kind === "edit" || e.tool.kind === "write")) (add += e.tool.add ?? 0), (del += e.tool.del ?? 0);
  return { add, del };
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

// ───────────── one row per job (T3-style thread list)
function Row(props: { t: Task; kid?: boolean; index: number }) {
  const t = () => props.t;
  const kids = () => state.tasks.filter((k) => k.parentId === t().id).sort((a, b) => a.createdAt - b.createdAt);
  const [open, setOpen] = createSignal<boolean | undefined>(undefined);
  const showKids = () => open() ?? (openRoot() === t().id || kids().some((k) => k.status === "waiting" || k.status === "failed"));
  const b = () => bucket(t());
  const tone = () =>
    t().status === "failed" ? "bad" : b() === "you" ? "ask" : b() === "review" ? "ok" : t().status === "running" ? "live" : t().status === "queued" || t().status === "paused" ? "idle" : "done";
  /** the status glyph's shape (st-icon classes): what the row needs, not only its own status */
  const glyph = () => {
    const x = t();
    if (x.status === "failed") return "failed";
    if (b() === "you") return "waiting";
    if (b() === "review") return "done unmerged";
    if (x.status === "running") return "running";
    if (x.status === "paused" || x.status === "queued") return x.status;
    return "done";
  };
  const meta = () => {
    const x = t();
    if (x.status === "failed") return tr("실패");
    if (x.status === "waiting" || (b() === "you" && !props.kid)) return tr("응답 필요");
    if (b() === "review") return "";
    if (x.status === "queued") return tr("대기");
    if (x.status === "paused") return tr("일시정지");
    if (x.status === "running") return x.startedAt ? (now() - x.startedAt < 60_000 ? tr("방금") : compact(now() - x.startedAt)) : "";
    return ago(x.finishedAt ?? x.createdAt);
  };
  return (
    <>
      <button
        class={`sb-row tone-${tone()}`}
        classList={{ menu: menu()?.id === t().id, on: openId() === t().id, kid: props.kid, hot: hoverTask() === t().id, past: ended(t()) }}
        style={{ "--i": props.index }}
        data-task={t().id}
        onClick={() => openTask(t().id)}
        onMouseEnter={() => setHoverTask(props.kid ? t().parentId! : t().id)}
        onMouseLeave={() => setHoverTask(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          closePops();
          setMenu({ id: t().id, x: e.clientX, y: e.clientY });
        }}
        title={t().title}
      >
        <span class={`sb-glyph st-icon sm ${glyph()}`} aria-hidden="true">
          <Show when={glyph() === "running"} fallback={<Show when={glyph().startsWith("done")} fallback={<i />}><Icon name="check" size={9} stroke={2.5} /></Show>}>
            <span class="spin" />
          </Show>
        </span>
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
        <Show when={t().pinned && !props.kid}><Icon name="pin" size={12} class="sb-pin" /></Show>
        <span class="sb-meta">
          <Show when={b() === "review" && !meta() && (changes(t()).add || changes(t()).del)} fallback={meta()}>
            <span class="add">+{changes(t()).add}</span>
            <Show when={changes(t()).del}> <span class="del">−{changes(t()).del}</span></Show>
          </Show>
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
      </button>
      <Show when={!props.kid && showKids() && kids().length}>
        <div class="sb-kid-list">
          <For each={kids()}>{(k, i) => <Row t={k} kid index={i()} />}</For>
        </div>
      </Show>
    </>
  );
}

/** Right-click on a job in the list. */
const [menu, setMenu] = createSignal<{ id: string; x: number; y: number } | null>(null);
const [projMenu, setProjMenu] = createSignal<{ id: string; x: number; y: number; sure?: boolean } | null>(null);

/** right-click on a project: delete it (the folder and its jobs stay) */
function ProjectMenu() {
  const close = () => setProjMenu(null);
  const esc = (e: KeyboardEvent) => !ignoredKey(e) && noModifiers(e) && e.key === "Escape" && projMenu() && (e.preventDefault(), e.stopPropagation(), close());
  window.addEventListener("click", close);
  window.addEventListener("blur", close);
  window.addEventListener("keydown", esc, true);
  createEffect(() => anyPop() && close());
  onCleanup(() => {
    window.removeEventListener("click", close);
    window.removeEventListener("blur", close);
    window.removeEventListener("keydown", esc, true);
  });
  return (
    <Show when={projMenu()}>
      {(m) => (
        <div class="menu ctx-menu" style={{ left: `${Math.min(m().x, window.innerWidth - 220)}px`, top: `${Math.min(m().y, window.innerHeight - 120)}px` }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (goMain(m().id), close())}><Icon name="arrow" size={16} class="muted" /><span class="row-title">{tr("열기")}</span></button>
          <div class="menu-sep" />
          <button
            class="danger"
            onClick={() => {
              if (!m().sure) return setProjMenu({ ...m(), sure: true });
              const v = view();
              if (v.name === "main" && v.project === m().id) goMain();
              removeProject(m().id);
              close();
            }}
          >
            <Icon name="trash" size={16} class="muted" />
            <span class="row-title">{m().sure ? tr("다시 눌러 삭제") : tr("프로젝트 삭제")}</span>
          </button>
        </div>
      )}
    </Show>
  );
}
/** 확인 필요: the jobs waiting on you, to pick one */
const [needsMenu, setNeedsMenu] = createSignal<{ x: number; y: number; w: number } | null>(null);
function NeedsMenu() {
  const close = () => setNeedsMenu(null);
  const esc = (e: KeyboardEvent) => !ignoredKey(e) && noModifiers(e) && e.key === "Escape" && needsMenu() && (e.preventDefault(), e.stopPropagation(), close());
  window.addEventListener("click", close);
  window.addEventListener("blur", close);
  window.addEventListener("keydown", esc, true);
  createEffect(() => anyPop() && close());
  onCleanup(() => {
    window.removeEventListener("click", close);
    window.removeEventListener("blur", close);
    window.removeEventListener("keydown", esc, true);
  });
  const list = () => forkOrder(state.space).filter((t) => !t.archived && (bucket(t) === "you" || bucket(t) === "review"));
  const where = (t: Task) => projectsIn(state.space).find((p) => p.id === t.project)?.name;
  return (
    <Show when={needsMenu()}>
      {(m) => (
        <div class="menu ctx-menu needs-menu" style={{ left: `${m().x}px`, width: `${m().w}px`, top: `${Math.min(m().y, window.innerHeight - 24 - list().length * 28)}px` }} onClick={(e) => e.stopPropagation()}>
          <For each={list()}>
            {(t) => (
              <button onClick={() => (openTask(t.id), close())}>
                <span class={`st-icon sm ${t.status === "failed" ? "failed" : bucket(t) === "you" ? "waiting" : "done unmerged"}`} aria-hidden="true">
                  <Show when={bucket(t) === "review"} fallback={<i />}><Icon name="check" size={9} stroke={2.5} /></Show>
                </span>
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
  if (!id) return;
  if (e.key === "F2") {
    e.preventDefault();
    openTask(id);
    setRenaming(id);
  } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    e.preventDefault();
    const r = row.getBoundingClientRect();
    closePops();
    setMenu({ id, x: r.left + 24, y: r.bottom + 2 });
  }
}

function RowMenu() {
  const close = () => setMenu(null);
  const esc = (e: KeyboardEvent) => !ignoredKey(e) && noModifiers(e) && e.key === "Escape" && menu() && (e.preventDefault(), e.stopPropagation(), close());
  window.addEventListener("click", close);
  window.addEventListener("blur", close);
  window.addEventListener("keydown", esc, true);
  // one menu at a time: a picker or the ⋯ menu opening closes this one
  createEffect(() => anyPop() && close());
  onCleanup(() => {
    window.removeEventListener("click", close);
    window.removeEventListener("blur", close);
    window.removeEventListener("keydown", esc, true);
  });
  return (
    <Show when={menu()}>
      {(m) => {
        const t = () => taskById(m().id);
        return (
          <Show when={t()}>
            {(x) => (
              <div class="menu ctx-menu" style={{ left: `${Math.min(m().x, window.innerWidth - 220)}px`, top: `${Math.min(m().y, window.innerHeight - 260)}px` }} onClick={(e) => e.stopPropagation()}>
                <button onClick={() => (openTask(x().id), close())}><Icon name="arrow" size={16} class="muted" /><span class="row-title">{tr("열기")}</span></button>
                <button onClick={() => (openTask(x().id), setRenaming(x().id), close())}><Icon name="pencil" size={16} class="muted" /><span class="row-title">{tr("이름 바꾸기")}</span><span class="menu-kbd">F2</span></button>
                <button onClick={() => (togglePin(x().id), close())}><Icon name="pin" size={16} class="muted" /><span class="row-title">{x().pinned ? tr("고정 해제") : tr("고정")}</span></button>
                <button onClick={() => { const n = duplicateTask(x().id); close(); if (n) openTask(n); }}><Icon name="refresh" size={16} class="muted" /><span class="row-title">{tr("다시 실행")}</span></button>
                <button onClick={() => { void navigator.clipboard.writeText(transcriptMarkdown(x().id)); toast(tr("복사했어요")); close(); }}><Icon name="copy" size={16} class="muted" /><span class="row-title">{tr("Markdown으로 복사")}</span></button>
                <div class="menu-sep" />
                <button onClick={() => (archiveTask(x().id, !x().archived), close())}><Icon name="archive" size={16} class="muted" /><span class="row-title">{x().archived ? tr("보관 해제") : tr("보관")}</span></button>
              </div>
            )}
          </Show>
        );
      }}
    </Show>
  );
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
        {/* jobs anywhere in this space that need an answer or a merge: a row of its own, not under one section */}
        <Show when={needs()}>
          <button
            class="sb-row sb-main sb-todo"
            classList={{ on: !!needsMenu() }}
            onClick={(e) => {
              e.stopPropagation();
              if (needs() === 1) return void openTask(nextWaiting(state.space)!.id);
              if (needsMenu()) return setNeedsMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setNeedsMenu({ x: r.left, y: r.bottom + 4, w: r.width });
            }}
            data-shortcut="waiting"
            title={`${tr("다음")} ${shortcutHint("waiting")}`}
          >
            <Icon name="alert" size={16} class="sb-main-ic" />
            <span class="sb-title">{tr("확인 필요")}</span>
            <span class="sb-need">{needs()}</span>
          </button>
        </Show>
        <Head id="projects" label={tr("프로젝트")} count={projectsIn(state.space).length}>
          <button class="icon-btn xs" title={tr("프로젝트 추가")} aria-label={tr("프로젝트 추가")} onClick={() => void addFolder()}>
            <Icon name="plus" size={14} />
          </button>
        </Head>
        <Fold open={!fold("projects")}>
        <div class="sb-projects">
          <For each={projectsIn(state.space)} >
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
                    classList={{ on: curProject() === p.id, has: all() > 0, open: open(), menu: projMenu()?.id === p.id }}
                    onClick={() => goMain(p.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      closePops();
                      setMenu(null);
                      setProjMenu({ id: p.id, x: e.clientX, y: e.clientY });
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
                    <span class="sb-title">{p.name}</span>
                    <Show when={busy()} fallback={<Show when={live()} fallback={<Show when={all() && !open()}><span class="sb-meta">{all()}</span></Show>}><span class="sb-live" title={tr("진행 중 {n}개", { n: live() })}><span class="spin xs" />{live()}</span></Show>}>
                      <span class="spin sm" />
                    </Show>
                    <span class="sb-acts">
                      <span
                        class="sb-act"
                        role="button"
                        title={tr("더보기")}
                        aria-label={tr("더보기")}
                        onClick={(e) => {
                          e.stopPropagation();
                          closePops();
                          setMenu(null);
                          const r = e.currentTarget.getBoundingClientRect();
                          setProjMenu({ id: p.id, x: r.left, y: r.bottom + 4 });
                        }}
                      >
                        <Icon name="more" size={14} />
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
      <RowMenu />
      <ProjectMenu />
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
