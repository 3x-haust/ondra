// The left side, after T3 Code: main on top, then one quiet row per job with a
// status dot (working sky, needs-you amber/indigo, ready emerald, failed red).
// The git-style flow lives in the right panel's 흐름 tab.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { anyPop, closePops } from "../ui/ModelPicker";
import { addProject, decisionsIn, projectsIn, removeProject, setSpace, state, taskById, tasksIn } from "../state/store";
import { pickFolder } from "../lib/native";
import type { Task } from "../state/types";
import { toast, goMain, hoverTask, openTask, setHoverTask, setPaletteOpen, setSidebarHidden, setView, showSidebar, sidebarAway, view } from "../state/ui";
import { ago, compact, now } from "../ui/bits";
import { bootedDevices, devices, usedBy } from "../state/devices";
import { Icon } from "../ui/Icon";
import { Fold } from "../ui/Fold";
import { archiveTask, duplicateTask, togglePin, transcriptMarkdown } from "../engine/tasks";

export type Bucket = "you" | "review" | "work" | "done";

/** What a job needs from you. A subagent waiting on you pulls its job up. */
export function bucket(t: Task): Bucket {
  const kids = state.tasks.filter((k) => k.parentId === t.id);
  if (t.status === "waiting" || t.status === "failed" || kids.some((k) => k.status === "waiting" || k.status === "failed")) return "you";
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
const ended = (t: Task) => t.status === "done" && t.worktree?.state !== "open";
const DAY = 86_400_000;

// ───────────── one row per job (T3-style thread list)
function Row(props: { t: Task; kid?: boolean; index: number }) {
  const t = () => props.t;
  const kids = () => state.tasks.filter((k) => k.parentId === t().id).sort((a, b) => a.createdAt - b.createdAt);
  const [open, setOpen] = createSignal<boolean | undefined>(undefined);
  const showKids = () => open() ?? (openRoot() === t().id || kids().some((k) => k.status === "waiting" || k.status === "failed"));
  const b = () => bucket(t());
  const tone = () =>
    t().status === "failed" ? "bad" : b() === "you" ? "ask" : b() === "review" ? "ok" : t().status === "running" ? "live" : t().status === "queued" || t().status === "paused" ? "idle" : "done";
  const meta = () => {
    const x = t();
    if (x.status === "failed") return "멈춤";
    if (x.status === "waiting" || (b() === "you" && !props.kid)) return "답 필요";
    if (b() === "review") return "";
    if (x.status === "queued") return "대기";
    if (x.status === "paused") return "쉼";
    if (x.status === "running") return x.startedAt ? (now() - x.startedAt < 60_000 ? "방금 시작" : `${compact(now() - x.startedAt)}째`) : "";
    return ago(x.finishedAt ?? x.createdAt);
  };
  return (
    <>
      <button
        class={`sb-row tone-${tone()}`}
        classList={{ menu: menu()?.id === t().id, on: openId() === t().id, kid: props.kid, hot: hoverTask() === t().id, past: ended(t()) }}
        style={{ "--i": props.index }}
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
        <span class="sb-dot" />
        <span class="sb-title">{t().title}</span>
        <Show when={!props.kid && kids().length}>
          <span
            class="sb-kids"
            classList={{ open: showKids() }}
            role="button"
            title={showKids() ? "서브에이전트 접기" : `서브에이전트 ${kids().length}개`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!showKids());
            }}
          >
            {kids().length}
            <Icon name="chevron" size={10} class="sb-kids-chev" />
          </span>
        </Show>
        <Show when={t().pinned && !props.kid}><Icon name="pin" size={11} class="sb-pin" /></Show>
        <span class="sb-meta">
          <Show when={b() === "review" && !meta()} fallback={meta()}>
            <span class="add">+{changes(t()).add}</span>
            <Show when={changes(t()).del}> <span class="del">−{changes(t()).del}</span></Show>
          </Show>
        </span>
        <Show when={!props.kid}>
          <span class="sb-acts">
            <span class="sb-act" role="button" title={t().pinned ? "고정 풀기" : "위에 고정"} onClick={(e) => (e.stopPropagation(), togglePin(t().id))}>
              <Icon name="pin" size={13} />
            </span>
            <span class="sb-act" role="button" title="보관" onClick={(e) => (e.stopPropagation(), archiveTask(t().id))}>
              <Icon name="archive" size={13} />
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
  const esc = (e: KeyboardEvent) => e.key === "Escape" && projMenu() && (e.stopPropagation(), close());
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
          <button onClick={() => (goMain(m().id), close())}><Icon name="arrow" size={14} class="muted" /><span class="row-title">열기</span></button>
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
            <Icon name="trash" size={14} class="muted" />
            <span class="row-title">{m().sure ? "한 번 더 누르면 삭제" : "프로젝트 삭제"}</span>
          </button>
        </div>
      )}
    </Show>
  );
}
const [renaming, setRenaming] = createSignal<string | null>(null);
export { renaming, setRenaming };

function RowMenu() {
  const close = () => setMenu(null);
  const esc = (e: KeyboardEvent) => e.key === "Escape" && menu() && (e.stopPropagation(), close());
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
                <button onClick={() => (openTask(x().id), close())}><Icon name="arrow" size={14} class="muted" /><span class="row-title">열기</span></button>
                <button onClick={() => (openTask(x().id), setRenaming(x().id), close())}><Icon name="pencil" size={14} class="muted" /><span class="row-title">이름 바꾸기</span></button>
                <button onClick={() => (togglePin(x().id), close())}><Icon name="pin" size={14} class="muted" /><span class="row-title">{x().pinned ? "고정 풀기" : "위에 고정"}</span></button>
                <button onClick={() => { const n = duplicateTask(x().id); close(); if (n) openTask(n); }}><Icon name="refresh" size={14} class="muted" /><span class="row-title">같은 요청으로 다시 시작</span></button>
                <button onClick={() => { void navigator.clipboard.writeText(transcriptMarkdown(x().id)); toast("대화를 Markdown으로 복사했어요"); close(); }}><Icon name="copy" size={14} class="muted" /><span class="row-title">마크다운으로 복사</span></button>
                <div class="menu-sep" />
                <button onClick={() => (archiveTask(x().id, !x().archived), close())}><Icon name="archive" size={14} class="muted" /><span class="row-title">{x().archived ? "보관 풀기" : "보관"}</span></button>
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
const setFold = (k: string, v: boolean) => {
  const next = { ...folds(), [k]: v };
  setFolds(next);
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(next));
  } catch {}
};

/** A section title you can click to fold what's under it. */
function Head(props: { id: string; label: string; count?: number; children?: any }) {
  const shut = () => !!folds()[props.id];
  return (
    <div class="sb-head">
      <button class="sb-head-btn" classList={{ shut: shut() }} onClick={() => setFold(props.id, !shut())} aria-expanded={!shut()}>
        {props.label}
        <Icon name="chevron" size={10} class="sb-head-chev" />
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
  const old = (t: Task) => !t.pinned && ended(t) && (t.finishedAt ?? t.createdAt) < now() - DAY && t.id !== openRoot();
  const shown = () => roots().filter((t) => older() || !old(t));
  const hidden = () => roots().filter(old).length;
  // jobs not filed under a project row (no project, or one not in this space)
  const loose = () => shown().filter((t) => !t.project || !projectsIn(state.space).some((p) => p.id === t.project));
  const needs = () => roots().filter((t) => bucket(t) === "you" || bucket(t) === "review").length;
  const boardLive = () => roots().filter((t) => t.status === "running").length;
  const mainBusy = () => state.captain.some((m) => m.space === state.space && !m.project && m.pending);
  const curProject = () => (view().name === "main" ? (view() as { project?: string }).project : undefined);
  const addFolder = async () => {
    const dir = await pickFolder("채팅을 따로 둘 프로젝트 폴더");
    if (!dir) return;
    const id = addProject(state.space, dir);
    goMain(id);
  };
  return (
    <aside class="sidebar">
      <div class="sb-top" data-tauri-drag-region>
        <span class="spacer" data-tauri-drag-region />
        <button class="icon-btn" title="새로 맡기기 (⌘N)" onClick={() => { goMain(); setTimeout(() => document.getElementById("main-input")?.focus(), 60); }}>
          <Icon name="compose" size={16} />
        </button>
        <button class="icon-btn" title="찾기 (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={16} />
        </button>
        <button class="icon-btn" title="접기 (⌘B)" onClick={() => setSidebarHidden(true)}>
          <Icon name="panelLeft" size={16} />
        </button>
      </div>
      <Show when={state.spaces.length > 1}>
      <div class="space-seg" style={{ "grid-template-columns": `repeat(${Math.min(3, state.spaces.length)}, minmax(0, 1fr))` }}>
        <For each={state.spaces}>
          {(s) => (
            <button classList={{ on: state.space === s.id }} onClick={() => (setSpace(s.id), goMain())} title={s.label}>
              <span class="space-name">{s.label}</span>
              <Show when={s.id !== state.space && decisionsIn(s.id).length}><i class="space-alert" /></Show>
            </button>
          )}
        </For>
      </div>
      </Show>

      <div class="sb-scroll">
        <button class="sb-row sb-main" classList={{ on: view().name === "main" && !curProject() }} onClick={() => goMain()} title="메인에게 말하기 (⌘0)">
          <Icon name="message" size={15} class="sb-main-ic" />
          <span class="sb-title">메인</span>
          <Show when={mainBusy()} fallback={<kbd class="sb-kbd">⌘0</kbd>}>
            <span class="spin sm" />
          </Show>
        </button>
        <button class="sb-row sb-main" classList={{ on: view().name === "board" }} onClick={() => setView({ name: "board" })} title="모든 일을 한 장에서 (⌘⇧B)">
          <Icon name="canvas" size={15} class="sb-main-ic" />
          <span class="sb-title">캔버스</span>
          <Show when={boardLive()} fallback={<kbd class="sb-kbd">⌘⇧B</kbd>}>
            <span class="sb-live" title={`지금 일하는 중 ${boardLive()}개`}><i />{boardLive()}</span>
          </Show>
        </button>
        <button class="sb-row sb-main" classList={{ on: view().name === "memory" }} onClick={() => setView({ name: "memory" })} title="에이전트가 기억하는 것: 그래프와 파일">
          <Icon name="memory" size={15} class="sb-main-ic" />
          <span class="sb-title">기억</span>
        </button>
        <button class="sb-row sb-main" classList={{ on: view().name === "browser" }} onClick={() => setView({ name: "browser" })} title="일들이 쓰는 브라우저: 여기서 로그인하면 모든 일이 로그인돼요">
          <Icon name="globe" size={15} class="sb-main-ic" />
          <span class="sb-title">브라우저</span>
        </button>

        <Head id="projects" label="프로젝트" count={projectsIn(state.space).length}>
          <button class="icon-btn xs" title="프로젝트 폴더 추가" onClick={() => void addFolder()}>
            <Icon name="plus" size={13} />
          </button>
        </Head>
        <Fold open={!folds().projects}>
        <div class="sb-projects">
          <For each={projectsIn(state.space)} >
            {(p) => {
              const busy = () => state.captain.some((m) => m.space === state.space && m.project === p.id && m.pending);
              const live = () => state.tasks.filter((t) => t.project === p.id && t.status === "running").length;
              // this project's jobs live under it; open by default while one is going or needs you
              const jobs = () => shown().filter((t) => t.project === p.id);
              const all = () => roots().filter((t) => t.project === p.id).length;
              const open = () => folds()[`p:${p.id}`] ?? (curProject() === p.id || jobs().some((t) => !ended(t) || t.id === openRoot()));
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
                      title={all() ? (open() ? "일 접기" : "일 펴기") : undefined}
                      onClick={(e) => {
                        if (!all()) return;
                        e.stopPropagation();
                        setFold(`p:${p.id}`, !open());
                      }}
                    >
                      <Icon name="folder" size={14} class="sb-main-ic ic-folder" />
                      <Icon name="chevron" size={11} class="ic-chev" />
                    </span>
                    <span class="sb-title">{p.name}</span>
                    <Show when={busy()} fallback={<Show when={live()} fallback={<Show when={all() && !open()}><span class="sb-meta">{all()}</span></Show>}><span class="sb-live" title={`이 프로젝트에서 일하는 중 ${live()}개`}><i />{live()}</span></Show>}>
                      <span class="spin sm" />
                    </Show>
                  </button>
                  <Show when={all()}>
                    <Fold open={open()}>
                      <div class="sb-proj-jobs">
                        <For each={jobs()} fallback={<p class="sb-empty sm">지난 일만 있어요</p>}>{(t, i) => <Row t={t} index={i()} />}</For>
                      </div>
                    </Fold>
                  </Show>
                </>
              );
            }}
          </For>
        </div>
        </Fold>

        <Head id="devices" label="디바이스" count={bootedDevices().length}>
          <button class="icon-btn xs" title="디바이스 허브 열기" onClick={() => setView({ name: "devices" })}>
            <Icon name="arrow" size={13} />
          </button>
        </Head>
        <Fold open={!folds().devices}>
        <div class="sb-projects">
          <For
            each={bootedDevices()}
            fallback={
              <button class="sb-row sb-proj" onClick={() => setView({ name: "devices" })}>
                <Icon name="phone" size={14} class="sb-main-ic" />
                <span class="sb-title muted">켜진 기기 없음</span>
                <span class="sb-hint">전체 {devices().length}개</span>
              </button>
            }
          >
            {(d) => {
              const job = () => usedBy(d);
              return (
                <button class="sb-row sb-proj" classList={{ on: (() => { const v = view(); return v.name === "devices" && v.device === d.id; })() }} onClick={() => setView({ name: "devices", device: d.id })} title={`${d.name} · ${d.runtime}${job() ? ` · ${job()!.title}` : ""}`}>
                  <Icon name="phone" size={14} class="sb-main-ic" />
                  <span class="sb-title">{d.name}</span>
                  <span class="sb-meta">{d.platform === "ios" ? "iOS" : "Android"}</span>
                  <Show when={job()?.status === "running"}><span class="spin sm" /></Show>
                </button>
              );
            }}
          </For>
        </div>
        </Fold>

        <Head id="jobs" label={projectsIn(state.space).length ? "그 밖의 일" : "맡긴 일"} count={loose().length}>
          <Show when={needs()}>
            <button class="sb-need" title="답하거나 확인할 다음 일로 (⌘.)" onClick={() => { const t = nextWaiting(state.space); if (t) openTask(t.id); }}>
              확인할 일 {needs()}
            </button>
          </Show>
        </Head>
        <Fold open={!folds().jobs}>
        <div class="sb-list">
          <For each={loose()} fallback={<p class="sb-empty">{projectsIn(state.space).length ? "프로젝트 밖에서 맡긴 일이 여기에 생겨요" : "메인에게 일을 맡기면 여기에 생겨요"}</p>}>
            {(t, i) => <Row t={t} index={i()} />}
          </For>
          <Show when={hidden()}>
            <button class="sb-older" classList={{ open: older() }} onClick={() => setOlder(!older())}>
              <Icon name="chevron" size={11} class="sb-older-chev" />
              {older() ? "이전 일 접기" : `이전 ${hidden()}개`}
            </button>
          </Show>
          <Show when={archived().length}>
            <button class="sb-older" classList={{ open: showArchived() }} onClick={() => setShowArchived(!showArchived())}>
              <Icon name="chevron" size={11} class="sb-older-chev" />
              보관함 {archived().length}
            </button>
            <Show when={showArchived()}>
              <For each={archived()}>{(t, i) => <Row t={t} index={i()} />}</For>
            </Show>
          </Show>
        </div>
        </Fold>
      </div>
      <RowMenu />
      <ProjectMenu />

      <div class="sb-foot">
        <button class="row" onClick={() => setView({ name: "settings" })}>
          <Icon name="gear" size={16} />
          <span class="row-title">설정</span>
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
      <button class="icon-btn sb-show" title="펴기 (⌘B)" onClick={showSidebar}>
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
