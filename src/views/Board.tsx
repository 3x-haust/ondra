// The board: every task of the workspace at a glance, as columns by state or
// by project. Cards act in place: pause, start now, merge, and "메시지" sends a
// change to a task without opening it, so several can be steered one after another.
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { decisionFor, spaceById, state } from "../state/store";
import type { Task } from "../state/types";
import { openTask, setView } from "../state/ui";
import { mergeTask, stopTask, resumeTask, startTask, tell } from "../engine/tasks";
import { throwThought } from "../engine/captain";
import { ago, compact, IssueTag, now } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { changes, SidebarToggle } from "./Sidebar";
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
/** a task's state as the canvas draws it (the same status glyph) */
const TONE: Record<string, string> = { you: "ask", running: "live", queued: "idle", review: "review", done: "done" };

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
    const by = new Map<string, Task[]>();
    for (const x of shown()) by.set(x.topic || "", [...(by.get(x.topic || "") ?? []), x]);
    return [...by]
      .map(([topic, list]) => ({
        id: topic,
        label: topic,
        tone: list.some((x) => stateOf(x) === "you") ? "ask" : list.some((x) => stateOf(x) === "running") ? "live" : "idle",
        tasks: list.sort((a, b) => ORDER.indexOf(stateOf(a)) - ORDER.indexOf(stateOf(b))),
      }))
      .sort((a, b) => b.tasks.length - a.tasks.length);
  });
  const counts = () => {
    const c: Record<string, number> = {};
    for (const x of roots()) c[stateOf(x)] = (c[stateOf(x)] ?? 0) + 1;
    return c;
  };

  const [ask, setAsk] = createSignal("");
  const send = () => {
    const text = ask().trim();
    if (!text) return;
    throwThought(text, state.space);
    setAsk("");
  };
  const Group = () => (
    <div class="seg sm" role="tablist">
      <button role="tab" aria-selected={groupBy() === "state"} classList={{ on: groupBy() === "state" }} onClick={() => setGroupBy("state")}>{t("상태별")}</button>
      <button role="tab" aria-selected={groupBy() === "project"} classList={{ on: groupBy() === "project" }} onClick={() => setGroupBy("project")}>{t("프로젝트별")}</button>
    </div>
  );

  return (
    <div class="view board-view" classList={{ embedded: props.embedded }}>
      <Show when={!props.embedded}>
        <header class="head" data-tauri-drag-region>
          <SidebarToggle />
          <span class="head-title">{t("보드")}</span>
          <span class="board-sum">
            <Show when={counts().running}><span><i class="tone-dot td-live" />{t("진행 중")} <b>{counts().running}</b></span></Show>
            <Show when={counts().you}><span><i class="tone-dot td-ask" />{t("응답 필요")} <b>{counts().you}</b></span></Show>
            <Show when={counts().review}><span><i class="tone-dot td-review" />{t("검토")} <b>{counts().review}</b></span></Show>
            <Show when={counts().queued}><span><i class="tone-dot td-idle" />{t("대기")} <b>{counts().queued}</b></span></Show>
          </span>
          <span class="spacer" data-tauri-drag-region />
          <Group />
        </header>
      </Show>

      <div class="board-bar">
        <form
          class="board-ask"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Icon name="plus" size={14} class="muted" />
          <input
            placeholder={t("무엇을 할까요?")}
            title={t("{space} 메인으로 보내요", { space: t(spaceById(state.space).label) })}
            value={ask()}
            onInput={(e) => setAsk(e.currentTarget.value)}
            onKeyDown={(e) => e.isComposing && e.stopPropagation()}
          />
          <Show when={ask().trim()}><kbd>⏎</kbd></Show>
        </form>
        <Show when={props.embedded}>
          <span class="spacer" />
          <Group />
        </Show>
      </div>

      <div class="board" classList={{ project: groupBy() === "project" }}>
        <For each={cols()} fallback={<div class="board-empty">{t("작업 없음")}</div>}>
          {(c) => (
            <section class="bcol" classList={{ empty: !c.tasks.length }}>
              <div class="bcol-head">
                <i class={`cv-st t-${c.tone}`} />
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
    </div>
  );
}

function Card(props: { t: Task; byProject: boolean }) {
  const job = () => props.t;
  const st = () => stateOf(job());
  const kids = () => state.tasks.filter((k) => k.parentId === job().id);
  const liveKids = () => kids().filter((k) => k.status === "running").length;
  const diff = () => changes(job());
  const [talk, setTalk] = createSignal(false);
  const [msg, setMsg] = createSignal("");
  const [sent, setSent] = createSignal(0);
  let input!: HTMLInputElement;

  const line = (): string => {
    const d = decisionFor(job().id);
    if (d) return d.question;
    if (job().status === "failed") return job().error ?? t("실패");
    if (st() === "running") return job().now || t("시작하는 중");
    if (st() === "queued") return job().status === "paused" ? t("일시정지") : t("대기 중");
    return job().summary || job().now || "";
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
        <i class={`cv-st t-${TONE[st()]}`} classList={{ failed: job().status === "failed", paused: job().status === "paused" }} />
        <IssueTag t={job()} />
        <Show when={!props.byProject && job().topic}><span class="bc-proj">{job().topic}</span></Show>
        <span class="spacer" />
        <span class="bc-when">{when()}</span>
      </div>
      <span class="bc-title">{job().title}</span>
      <Show when={line()}><p class="bc-line">{line()}</p></Show>
      <Show when={foot()}>
        <div class="bc-meta">
          <Show when={kids().length}>
            <span class="bc-kids" title={t("서브에이전트")}>
              <Icon name="branch" size={12} />
              {liveKids() ? `${liveKids()}/${kids().length}` : kids().length}
            </span>
          </Show>
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
            placeholder={t("메시지 보내기")}
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
