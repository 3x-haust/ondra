// The board: every task of the workspace at a glance, as columns by state or
// by project. Cards act in place: pause, start now, merge, and "메시지" sends a
// change to a task without opening it, so several can be steered one after another.
import { nowText } from "../engine/describe";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { decisionFor, projectsIn, kidsOf, state } from "../state/store";
import type { Task } from "../state/types";
import { openTask, setView } from "../state/ui";
import { mergeTask, stopTask, resumeTask, startTask, tell } from "../engine/tasks";
import { ago, compact, IssueTag, now } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { changes, Glyph, glyphOf, SidebarToggle } from "./Sidebar";
import { t } from "../i18n";
import { openTaskMenu, taskMenuItems } from "../ui/taskMenu";
import { discarded } from "../state/progress";

/** about how wide the task menu is: enough to put it beside a card instead of on it */
const MENU_W = 232;
/**
 * A card's right-click menu (board and canvas) through the shared placement: under or
 * over the card at the pointer, else beside it (right, or left when the right has no
 * room). The card itself is never covered.
 */
export const cardMenu = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  const r = (e.currentTarget as Element).getBoundingClientRect();
  // the anchor's left is where the menu starts under or over the card, its right where a menu
  // beside it starts: at the pointer and right of the card, or left of the card when the right is full
  const roomRight = r.right + 4 + MENU_W <= innerWidth - 8;
  // about how tall the menu is (rows and separators), to know if it fits under or over the card
  const items = taskMenuItems(id);
  const h = items.filter((x) => x !== "sep").length * 28 + (items.length ? 10 : 0) + items.filter((x) => x === "sep").length * 9;
  const vertical = r.bottom + 2 + h <= innerHeight - 8 || r.top - 2 - h >= 8;
  const x = roomRight || vertical ? e.clientX : Math.max(8, r.left - MENU_W - 8);
  openTaskMenu(id, new DOMRect(x, r.top, roomRight ? r.right - x : 0, r.height));
};

type Col = { id: string; label: string; tone: string; tasks: Task[] };

const [groupBy, setGroupBy] = createSignal<"state" | "project">("state");
const [showOld, setShowOld] = createSignal(false);

const DAY = 86_400_000;

/** Failed and paused are columns of their own (never counted as needing a reply or as queued).
 *  A discarded task sits under 완료 but reads 버림. */
function stateOf(task: Task): string {
  if (discarded(task)) return "done";
  if (task.status === "failed") return "failed";
  const kids = kidsOf(task.id);
  if (task.status === "waiting" || kids.some((k) => k.status === "waiting")) return "you";
  if (task.status === "running") return "running";
  if (task.status === "paused") return "paused";
  if (task.status === "queued") return "queued";
  if (task.status === "done" && task.worktree?.state === "open") return "review";
  return "done";
}

const STATES: { id: string; label: string; tone: string }[] = [
  { id: "queued", label: "대기", tone: "idle" },
  { id: "running", label: "진행 중", tone: "live" },
  { id: "paused", label: "일시정지", tone: "paused" },
  { id: "you", label: "응답 필요", tone: "ask" },
  { id: "failed", label: "실패", tone: "failed" },
  { id: "review", label: "검토", tone: "review" },
  { id: "done", label: "완료", tone: "done" },
];
const ORDER = ["you", "failed", "review", "running", "paused", "queued", "done"];
/** a card's state in words (the column's word when grouped by state) */
const STATE_WORD: Record<string, string> = Object.fromEntries(STATES.map((s) => [s.id, s.label]));
/** the project a task is filed under, by the same name the sidebar shows (none: 기타) */
const projectOf = (task: Task) => projectsIn(task.space).find((p) => p.id === task.project);
/** a column's mark: the glyph the sidebar draws for a task in that state */
const GLYPH: Record<string, ReturnType<typeof glyphOf>> = { you: "waiting", failed: "failed", running: "running", paused: "paused", queued: "queued", review: "inreview", done: "done" };

/** a task in each state, for drawing that state's glyph where there is no one task */
const SAMPLE: Record<string, Partial<Task>> = {
  waiting: { status: "waiting" },
  failed: { status: "failed" },
  inreview: { status: "done", worktree: { state: "open" } as Task["worktree"] },
  running: { status: "running" },
  paused: { status: "paused" },
  queued: { status: "queued" },
  done: { status: "done" },
  discarded: { status: "done", worktree: { state: "discarded" } as Task["worktree"] },
};

/** The sidebar's status glyph for a state, where there is no one task (a column head, the canvas legend,
 *  memory's finished tasks): drawn by the sidebar's own Glyph, so every place keeps one look. */
export function StateGlyph(props: { g: ReturnType<typeof glyphOf> | "discarded" }) {
  return <Glyph t={{ id: `~${props.g}`, entries: [], plan: [], shells: [], ...SAMPLE[props.g] } as unknown as Task} />;
}

/** Subagents of a task, one format on the board and the canvas: ⑂ 1/2 while some run, ⑂ 2 when none do
 *  (or `short`, where room is tight: the count alone, the fraction in the tooltip). */
export function Kids(props: { t: Task; class?: string; short?: boolean }) {
  const kids = () => kidsOf(props.t.id);
  const live = () => kids().filter((k) => k.status === "running").length;
  return (
    <Show when={kids().length}>
      <span
        class={`kids-n ${props.class ?? ""}`}
        title={live() ? t("서브에이전트 {n}개 중 {live}개 진행 중", { live: live(), n: kids().length }) : t("서브에이전트 {n}개", { n: kids().length })}
      >
        <Icon name="branch" size={12} />
        {live() && !props.short ? `${live()}/${kids().length}` : kids().length}
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

/** 새 작업: the same new-task screen as the sidebar and ⌘N, preset to `project` when one is in focus. */
export function NewTask(props: { project?: () => string | undefined }) {
  /** the project it is preset to, named in the tooltip */
  const name = () => {
    const id = props.project?.();
    return id ? projectsIn(state.space).find((p) => p.id === id)?.name : undefined;
  };
  return (
    <button class="btn sm new-task-btn" title={name() ? t("{name}에 새 작업", { name: name()! }) : undefined} onClick={() => void import("./MainView").then((m) => m.startNewTask(props.project?.()))}>
      <Icon name="plus" size={14} />
      {t("새 작업")}
    </button>
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
    if (groupBy() === "state")
    {
      // 대기 and 완료 always stand (an empty 대기 gives way to 일시정지); the others only when something is in them
      const all = STATES.map((s) => ({ ...s, tasks: shown().filter((x) => stateOf(x) === s.id) }));
      const paused = all.some((c) => c.id === "paused" && c.tasks.length);
      return all.filter((c) => c.tasks.length || c.id === "done" || (c.id === "queued" && !paused));
    }
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
        tone: list.some((x) => stateOf(x) === "you") ? "ask" : list.some((x) => stateOf(x) === "failed") ? "failed" : list.some((x) => stateOf(x) === "running") ? "live" : "idle",
        tasks: list.sort((a, b) => ORDER.indexOf(stateOf(a)) - ORDER.indexOf(stateOf(b))),
      }));
  });

  /** a column counts every card it lists: 완료 2 · 버림 1 when discarded ones sit under 완료 */
  const doneCount = (c: Col) => {
    const gone = groupBy() === "state" && c.id === "done" ? c.tasks.filter(discarded).length : 0;
    return gone ? t("{n} · 버림 {m}", { n: c.tasks.length - gone, m: gone }) : String(c.tasks.length);
  };

  // columns that run past an edge get a soft fade there, so the board reads as scrollable
  const [edge, setEdge] = createSignal({ l: false, r: false });
  const watch = (el: HTMLDivElement) => {
    const check = () => setEdge({ l: el.scrollLeft > 1, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true });
    queueMicrotask(check);
    onCleanup(() => (ro.disconnect(), mo.disconnect()));
  };

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
      <div class="board" ref={watch} classList={{ project: groupBy() === "project", "fade-l": edge().l, "fade-r": edge().r }}>
        <For each={cols()}>
          {(c) => (
            <section class="bcol" classList={{ empty: !c.tasks.length }}>
              <div class="bcol-head">
                <Show when={groupBy() === "state"} fallback={<Icon name="folder" size={14} class="bcol-ic" />}>
                  <StateGlyph g={GLYPH[c.id]} />
                </Show>
                <span class="bcol-name">{groupBy() === "state" || !c.label ? t(c.label || "기타") : c.label}</span>
                <span class="bcol-n">{doneCount(c)}</span>
                <Show when={c.id === "done" && hiddenOld()}>
                  <button class="bcol-more" onClick={() => setShowOld(!showOld())}>{showOld() ? t("최근만") : t("이전 {n}개", { n: hiddenOld() })}</button>
                </Show>
                {/* a project's column starts a task in that project (the same new-task screen) */}
                <Show when={groupBy() === "project" && c.id}>
                  <button class="icon-btn sm bcol-add" title={t("새 작업")} aria-label={t("{name}에 새 작업", { name: c.label })} onClick={() => void import("./MainView").then((m) => m.startNewTask(c.id))}>
                    <Icon name="plus" size={14} />
                  </button>
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
  const gone = () => discarded(job());
  /** merged by Ondra: its changes are in, nothing of it is left to count or check */
  const merged = () => !gone() && job().worktree?.state === "merged";
  /** the state in the column's words (under 완료, a discarded one says 버림 and a merged one 병합됨) */
  const word = () => (gone() ? "버림" : merged() ? "병합됨" : STATE_WORD[st()]);
  /** finished with checks it couldn't do: the canvas card's badge */
  const unchecked = () => job().status === "done" && !gone() && !merged() && !!job().unverified?.length;
  const kids = () => kidsOf(job().id);
  /** thrown away or merged: nothing of it is left to count */
  const diff = () => (gone() || merged() ? { add: 0, del: 0 } : changes(job()));
  const [talk, setTalk] = createSignal(false);
  const [msg, setMsg] = createSignal("");
  const [sent, setSent] = createSignal(0);
  let input!: HTMLInputElement;

  const line = (): string => {
    const d = decisionFor(job().id);
    if (d) return d.question;
    if (job().status === "failed" && !gone()) return job().error ?? "";
    if (st() === "running") return job().now ? nowText(job().now) : t("시작하는 중");
    // the column (or the state word) already says it's queued or paused
    if (st() === "queued" || st() === "paused") return "";
    const body = job().summary || (job().now ? nowText(job().now) : "");
    // a line that only says the state again says nothing
    return body.trim() === t(word()) ? "" : body;
  };
  const when = () => {
    if (st() === "running" && job().startedAt) return compact(now() - job().startedAt!);
    if (st() === "queued") return ago(job().createdAt);
    // paused: the task's own header says since when; a bare time here would read as something else
    if (st() === "paused") return "";
    // merged: when it was merged; discarded: when it was thrown away (older tasks: when they finished)
    const merged = job().worktree?.state === "merged" && !gone() ? job().mergedAt : undefined;
    const thrown = gone() ? job().discardedAt : undefined;
    return ago(thrown ?? merged ?? job().finishedAt ?? job().startedAt ?? job().createdAt);
  };
  const say = () => {
    const m = msg().trim();
    if (!m) return;
    void tell(job().id, m);
    setMsg("");
    setSent((n) => n + 1);
    input?.focus();
  };

  // icons in the top row, where the time is: the state word and the title stay in view
  const act = (label: string, icon: string, run: () => void, primary = false): JSX.Element => (
    <button
      class="bc-act"
      classList={{ primary }}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );
  /** under 완료 a discarded (or merged) card says so where its changes would be */
  const goneWord = () => (gone() || merged()) && !props.byProject;
  const foot = () => !!(kids().length || diff().add || diff().del || sent() || goneWord() || unchecked());

  return (
    <article class={`bcard tone-${st()}${talk() ? " talking" : ""}`} onClick={() => openTask(job().id)} onContextMenu={cardMenu(job().id)} tabindex="0" onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openTask(job().id)}>
      <div class="bc-top">
        <span class="bc-glyph" title={props.byProject ? undefined : t(word())}>
          <Glyph t={job()} />
        </span>
        {/* grouped by project, no column says the state: the card does */}
        <Show when={props.byProject}><span class={`bc-state tone-${gone() ? "discarded" : merged() ? "merged" : st()}`}>{t(word())}</span></Show>
        <IssueTag t={job()} />
        <Show when={!props.byProject}><span class="bc-proj">{projectOf(job())?.name ?? t("기타")}</span></Show>
        <span class="spacer" />
        <Show when={when()}><span class="bc-when">{when()}</span></Show>
      </div>
      <span class="bc-title">{job().title}</span>
      <Show when={line()}><p class="bc-line">{line()}</p></Show>
      <Show when={foot()}>
        <div class="bc-meta">
          {/* what it couldn't check, first in the line under the title (the top row has no room) */}
          <Show when={unchecked()}>
            <span class="unverified-badge" title={job().unverified!.join("\n")}>{t("{n}개 확인 안 됨", { n: job().unverified!.length })}</span>
          </Show>
          <Kids t={job()} class="bc-kids" />
          <Show when={diff().add || diff().del}>
            <span class="bc-diff">
              <span class="add">+{diff().add}</span>
              <Show when={diff().del}> <span class="del">−{diff().del}</span></Show>
            </span>
          </Show>
          <Show when={goneWord()}><span class={`bc-state tone-${gone() ? "discarded" : "merged"}`}>{t(word())}</span></Show>
          <Show when={sent()}><span class="bc-sent">{t("보냄 {n}", { n: sent() })}</span></Show>
        </div>
      </Show>

      <div class="bc-acts">
        <Show when={!gone() && (st() === "running" || st() === "you" || st() === "review" || st() === "queued" || st() === "paused")}>
          {act(t("메시지"), "message", () => (setTalk(!talk()), queueMicrotask(() => input?.focus())))}
        </Show>
        <Show when={st() === "running"}>{act(t("일시정지|action"), "pause", () => stopTask(job().id))}</Show>
        <Show when={job().status === "paused" && !gone()}>{act(t("다시 시작"), "play", () => resumeTask(job().id))}</Show>
        <Show when={job().status === "failed" && !gone()}>{act(t("다시 시도"), "refresh", () => resumeTask(job().id), true)}</Show>
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
            placeholder={job().status === "running" ? t("작업 중에 말하기") : job().status === "queued" ? t("메시지 보내기") : t("이어서 말하기")}
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
