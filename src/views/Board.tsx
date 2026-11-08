// The board: every task of the workspace at a glance, as columns by state or
// by project. Cards act in place: pause, start now, merge, and "메시지" sends a
// change to a task without opening it, so several can be steered one after another.
import { nowText } from "../engine/describe";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { decisionFor, projectsIn, spaceById, state } from "../state/store";
import type { Task } from "../state/types";
import { openTask, setView } from "../state/ui";
import { mergeTask, stopTask, resumeTask, startTask, tell } from "../engine/tasks";
import { throwThought } from "../engine/captain";
import { ago, compact, IssueTag, now, statusLabel } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { changes, Glyph, glyphOf, SidebarToggle } from "./Sidebar";
import { t } from "../i18n";
import { taskContextMenu } from "../ui/taskMenu";

type Col = { id: string; label: string; tone: string; tasks: Task[] };

const [groupBy, setGroupBy] = createSignal<"state" | "project">("state");
const [showOld, setShowOld] = createSignal(false);

const DAY = 86_400_000;

function stateOf(task: Task): string {
  const kids = state.tasks.filter((k) => k.parentId === task.id);
  if (task.status === "waiting" || task.status === "failed" || kids.some((k) => k.status === "waiting" || k.status === "failed")) return "you";
  if (task.status === "running") return "running";
  if (task.status === "queued" || task.status === "paused") return "queued";
  if (task.status === "done" && task.worktree?.state === "open") return "review";
  return "done";
}

const STATES: { id: string; label: string; tone: string }[] = [
  { id: "queued", label: "대기", tone: "idle" },
  { id: "running", label: "진행 중", tone: "live" },
  { id: "you", label: "응답 필요", tone: "ask" },
  { id: "review", label: "검토", tone: "review" },
  { id: "done", label: "완료", tone: "done" },
];
const ORDER = ["you", "review", "running", "queued", "done"];
/** the project a task is filed under, by the same name the sidebar shows (none: 기타) */
const projectOf = (task: Task) => projectsIn(task.space).find((p) => p.id === task.project);
/** a column's mark: the glyph the sidebar draws for a task in that state */
const GLYPH: Record<string, ReturnType<typeof glyphOf>> = { you: "waiting", running: "running", queued: "queued", review: "inreview", done: "done" };

/** The sidebar's status glyph for a state, where there is no one task (a column head). */
function StateGlyph(props: { g: ReturnType<typeof glyphOf> }) {
  return (
    <span class={`sb-glyph st-icon sm ${props.g}`} aria-hidden="true">
      <Show when={props.g === "running"} fallback={<Show when={props.g === "done"} fallback={<i />}><Icon name="check" size={9} stroke={2.5} /></Show>}>
        <span class="spin" />
      </Show>
    </span>
  );
}

/** Subagents of a task, one format on the board and the canvas: ⑂ 1/2 while some run, ⑂ 2 when none do. */
export function Kids(props: { t: Task; class?: string }) {
  const kids = () => state.tasks.filter((k) => k.parentId === props.t.id);
  const live = () => kids().filter((k) => k.status === "running").length;
  return (
    <Show when={kids().length}>
      <span
        class={`kids-n ${props.class ?? ""}`}
        title={live() ? t("서브에이전트 {live}/{n}개 진행 중", { live: live(), n: kids().length }) : t("서브에이전트 {n}개", { n: kids().length })}
      >
        <Icon name="branch" size={12} />
        {live() ? `${live()}/${kids().length}` : kids().length}
      </span>
    </Show>
  );
}

/** 상태별 · 프로젝트별: how the board groups its columns (sits in the header) */
export function BoardGroup() {
  return (
    <div class="seg sm" role="tablist">
      <button role="tab" aria-selected={groupBy() === "state"} classList={{ on: groupBy() === "state" }} onClick={() => setGroupBy("state")}>{t("상태별")}</button>
      <button role="tab" aria-selected={groupBy() === "project"} classList={{ on: groupBy() === "project" }} onClick={() => setGroupBy("project")}>{t("프로젝트별")}</button>
    </div>
  );
}

/** 새 작업: one button in the header (canvas and board alike); the field drops down under it. */
export function NewTask() {
  const [open, setOpen] = createSignal(false);
  const [ask, setAsk] = createSignal("");
  let input!: HTMLInputElement;
  let box!: HTMLDivElement;
  const send = () => {
    const text = ask().trim();
    if (!text) return;
    throwThought(text, state.space);
    setAsk("");
    setOpen(false);
  };
  const away = (e: PointerEvent) => open() && !box.contains(e.target as Node) && !ask().trim() && setOpen(false);
  window.addEventListener("pointerdown", away, true);
  onCleanup(() => window.removeEventListener("pointerdown", away, true));
  return (
    <div class="cv-new-task" ref={box}>
      <button class="btn sm new-task-btn" classList={{ on: open() }} aria-expanded={open()} onClick={() => (setOpen(!open()), queueMicrotask(() => input?.focus()))}>
        <Icon name="plus" size={14} />
        {t("새 작업")}
      </button>
      <Show when={open()}>
        <form
          class="new-task-pop"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={input}
            placeholder={t("새 작업")}
            aria-label={t("새 작업")}
            title={t("{space} 메인으로 보내요", { space: t(spaceById(state.space).label) })}
            value={ask()}
            onInput={(e) => setAsk(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.isComposing) return;
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <button type="submit" class="cv-send" disabled={!ask().trim()} aria-label={t("보내기")} title={t("보내기")}>
            <Icon name="send" size={13} />
          </button>
        </form>
      </Show>
    </div>
  );
}

export function Board(props: { embedded?: boolean } = {}) {
  const roots = createMemo(() =>
    state.tasks
      .filter((x) => !x.parentId && !x.answer && !x.archived && x.space === state.space)
      .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)),
  );
  const old = (x: Task) => stateOf(x) === "done" && (x.finishedAt ?? x.createdAt) < now() - DAY;
  const hiddenOld = () => roots().filter(old).length;
  const shown = () => roots().filter((x) => showOld() || !old(x));

  const cols = createMemo<Col[]>(() => {
    if (groupBy() === "state") return STATES.map((s) => ({ ...s, tasks: shown().filter((x) => stateOf(x) === s.id) }));
    // by the task's project, in the sidebar's order; tasks without one go last under 기타
    const by = new Map<string, Task[]>();
    for (const x of shown()) {
      const id = projectOf(x)?.id ?? "";
      by.set(id, [...(by.get(id) ?? []), x]);
    }
    const order = projectsIn(state.space).map((p) => p.id);
    return [...by]
      .sort((a, b) => (a[0] ? order.indexOf(a[0]) : order.length) - (b[0] ? order.indexOf(b[0]) : order.length))
      .map(([id, list]) => ({
        id,
        label: id ? (projectsIn(state.space).find((p) => p.id === id)?.name ?? "") : "",
        tone: list.some((x) => stateOf(x) === "you") ? "ask" : list.some((x) => stateOf(x) === "running") ? "live" : "idle",
        tasks: list.sort((a, b) => ORDER.indexOf(stateOf(a)) - ORDER.indexOf(stateOf(b))),
      }));
  });

  return (
    <div class="view board-view" classList={{ embedded: props.embedded }}>
      <Show when={!props.embedded}>
        <header class="head" data-tauri-drag-region>
          <SidebarToggle />
          <span class="head-title">{t("보드")}</span>
          <span class="spacer" data-tauri-drag-region />
          <BoardGroup />
          <NewTask />
        </header>
      </Show>

      <Show
        when={roots().length}
        fallback={
          <div class="pane-empty cv-empty">
            <Icon name="board" size={20} />
            <span>{t("작업 없음")}</span>
          </div>
        }
      >
      <div class="board" classList={{ project: groupBy() === "project" }}>
        <For each={cols()}>
          {(c) => (
            <section class="bcol" classList={{ empty: !c.tasks.length }}>
              <div class="bcol-head">
                <Show when={groupBy() === "state"} fallback={<Icon name="folder" size={14} class="bcol-ic" />}>
                  <StateGlyph g={GLYPH[c.id]} />
                </Show>
                <span class="bcol-name">{groupBy() === "state" || !c.label ? t(c.label || "기타") : c.label}</span>
                <span class="bcol-n">{c.tasks.length}</span>
                <Show when={c.id === "done" && hiddenOld()}>
                  <button class="bcol-more" onClick={() => setShowOld(!showOld())}>{showOld() ? t("최근만") : t("이전 {n}개", { n: hiddenOld() })}</button>
                </Show>
              </div>
              <div class="bcol-list">
                <For each={c.tasks} fallback={<div class="bcol-empty">{t("없음")}</div>}>{(x) => <Card t={x} byProject={groupBy() === "project"} />}</For>
              </div>
            </section>
          )}
        </For>
      </div>
      </Show>
    </div>
  );
}

function Card(props: { t: Task; byProject: boolean }) {
  const job = () => props.t;
  const st = () => stateOf(job());
  const kids = () => state.tasks.filter((k) => k.parentId === job().id);
  const diff = () => changes(job());
  const [talk, setTalk] = createSignal(false);
  const [msg, setMsg] = createSignal("");
  const [sent, setSent] = createSignal(0);
  let input!: HTMLInputElement;

  const line = (): string => {
    const d = decisionFor(job().id);
    if (d) return d.question;
    if (job().status === "failed") return job().error ?? t("실패");
    if (st() === "running") return job().now ? nowText(job().now) : t("시작하는 중");
    // the column (or the glyph) already says it's waiting: only a pause is worth a word
    if (st() === "queued") return job().status === "paused" ? t("일시정지") : "";
    return job().summary || (job().now ? nowText(job().now) : "");
  };
  const when = () => {
    if (st() === "running" && job().startedAt) return compact(now() - job().startedAt!);
    if (st() === "queued") return ago(job().createdAt);
    return ago(job().finishedAt ?? job().startedAt ?? job().createdAt);
  };
  const say = () => {
    const m = msg().trim();
    if (!m) return;
    void tell(job().id, m);
    setMsg("");
    setSent((n) => n + 1);
    input?.focus();
  };

  const act = (label: string, icon: string, run: () => void, primary = false): JSX.Element => (
    <button
      class="bc-act"
      classList={{ primary }}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
  const foot = () => !!(kids().length || diff().add || diff().del || sent());

  return (
    <article class={`bcard tone-${st()}`} classList={{ talking: talk() }} onClick={() => openTask(job().id)} onContextMenu={taskContextMenu(job().id)} tabindex="0" onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openTask(job().id)}>
      <div class="bc-top">
        <span class="bc-glyph" title={t(st() === "review" ? "검토" : st() === "you" && job().status !== "failed" ? "응답 필요" : statusLabel[job().status])}><Glyph t={job()} /></span>
        <IssueTag t={job()} />
        <Show when={!props.byProject}><span class="bc-proj">{projectOf(job())?.name ?? t("기타")}</span></Show>
        <span class="spacer" />
        <span class="bc-when">{when()}</span>
      </div>
      <span class="bc-title">{job().title}</span>
      <Show when={line()}><p class="bc-line">{line()}</p></Show>
      <Show when={foot()}>
        <div class="bc-meta">
          <Kids t={job()} class="bc-kids" />
          <Show when={diff().add || diff().del}>
            <span class="bc-diff">
              <span class="add">+{diff().add}</span>
              <Show when={diff().del}> <span class="del">−{diff().del}</span></Show>
            </span>
          </Show>
          <Show when={sent()}><span class="bc-sent">{t("보냄 {n}", { n: sent() })}</span></Show>
        </div>
      </Show>

      <div class="bc-acts">
        <Show when={st() === "running" || st() === "you" || st() === "review" || st() === "queued"}>
          {act(t("메시지"), "message", () => (setTalk(!talk()), queueMicrotask(() => input?.focus())))}
        </Show>
        <Show when={st() === "running"}>{act(t("일시정지"), "pause", () => stopTask(job().id))}</Show>
        <Show when={job().status === "paused"}>{act(t("다시 시작"), "play", () => resumeTask(job().id))}</Show>
        <Show when={job().status === "queued"}>{act(t("지금 시작"), "play", () => void startTask(job().id))}</Show>
        <Show when={st() === "review"}>{act(t("병합"), "merge", () => void mergeTask(job().id), true)}</Show>
        <Show when={st() === "you"}>{act(t("응답"), "arrow", () => openTask(job().id), true)}</Show>
      </div>

      <Show when={talk()}>
        <form
          class="bc-talk"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            say();
          }}
        >
          <input
            ref={input}
            placeholder={job().status === "running" ? t("작업 중에 말하기") : t("이어서 말하기")}
            value={msg()}
            onInput={(e) => setMsg(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.stopPropagation(), setTalk(false));
            }}
          />
          <button type="submit" class="bc-send" disabled={!msg().trim()} aria-label={t("보내기")} title={t("보내기")}>
            <Icon name="send" size={14} />
          </button>
        </form>
      </Show>
    </article>
  );
}

export const openBoard = () => setView({ name: "board" });
