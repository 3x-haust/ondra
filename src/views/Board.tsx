// The board: every job of the space at a glance, as columns
// by state or by project. Cards act in place: stop, start now, merge, and
// "말하기" sends a change to a job without opening it, so several jobs can be
// steered one after another.
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { decisionFor, spaceById, state } from "../state/store";
import type { Task } from "../state/types";
import { openTask, setView } from "../state/ui";
import { mergeTask, stopTask, resumeTask, startTask, tell } from "../engine/tasks";
import { throwThought } from "../engine/captain";
import { ago, compact, now } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { StatusIcon } from "../ui/ForkCard";
import { SidebarToggle } from "./Sidebar";
import { changes } from "./Sidebar";

type Col = { id: string; label: string; tone: string; hint?: string; tasks: Task[] };

const [groupBy, setGroupBy] = createSignal<"state" | "project">("state");
const [showOld, setShowOld] = createSignal(false);

const DAY = 86_400_000;

function stateOf(t: Task): string {
  const kids = state.tasks.filter((k) => k.parentId === t.id);
  if (t.status === "waiting" || t.status === "failed" || kids.some((k) => k.status === "waiting" || k.status === "failed")) return "you";
  if (t.status === "running") return "running";
  if (t.status === "queued" || t.status === "paused") return "queued";
  if (t.status === "done" && t.worktree?.state === "open") return "review";
  return "done";
}

const STATES: { id: string; label: string; tone: string; hint: string }[] = [
  { id: "queued", label: "대기", tone: "idle", hint: "순서가 오면 시작해요" },
  { id: "running", label: "진행 중", tone: "live", hint: "일하는 중이에요" },
  { id: "you", label: "답 필요", tone: "ask", hint: "답하거나 확인해 주세요" },
  { id: "review", label: "검토 대기", tone: "review", hint: "확인하고 합치면 끝나요" },
  { id: "done", label: "끝남", tone: "done", hint: "합쳤거나 끝난 일" },
];
const ORDER = ["you", "review", "running", "queued", "done"];

export function Board(props: { embedded?: boolean } = {}) {
  const roots = createMemo(() =>
    state.tasks
      .filter((t) => !t.parentId && !t.answer && !t.archived && t.space === state.space)
      .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)),
  );
  const old = (t: Task) => stateOf(t) === "done" && (t.finishedAt ?? t.createdAt) < now() - DAY;
  const hiddenOld = () => roots().filter(old).length;
  const shown = () => roots().filter((t) => showOld() || !old(t));

  const cols = createMemo<Col[]>(() => {
    if (groupBy() === "state") return STATES.map((s) => ({ ...s, tasks: shown().filter((t) => stateOf(t) === s.id) }));
    const by = new Map<string, Task[]>();
    for (const t of shown()) by.set(t.topic || "기타", [...(by.get(t.topic || "기타") ?? []), t]);
    return [...by]
      .map(([topic, list]) => ({
        id: topic,
        label: topic,
        tone: list.some((t) => stateOf(t) === "you") ? "ask" : list.some((t) => stateOf(t) === "running") ? "live" : "idle",
        tasks: list.sort((a, b) => ORDER.indexOf(stateOf(a)) - ORDER.indexOf(stateOf(b))),
      }))
      .sort((a, b) => b.tasks.length - a.tasks.length);
  });
  const counts = () => {
    const c: Record<string, number> = {};
    for (const t of roots()) c[stateOf(t)] = (c[stateOf(t)] ?? 0) + 1;
    return c;
  };

  const [ask, setAsk] = createSignal("");
  const send = () => {
    const t = ask().trim();
    if (!t) return;
    throwThought(t, state.space);
    setAsk("");
  };

  return (
    <div class="view board-view" classList={{ embedded: props.embedded }}>
      <Show when={!props.embedded}>
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <span class="head-title">보드</span>
        <span class="board-sum">
          <Show when={counts().running}><span><i class="tone-dot td-live" />진행 {counts().running}</span></Show>
          <Show when={counts().you}><span><i class="tone-dot td-ask" />답 필요 {counts().you}</span></Show>
          <Show when={counts().review}><span><i class="tone-dot td-review" />검토 {counts().review}</span></Show>
          <Show when={counts().queued}><span><i class="tone-dot td-idle" />대기 {counts().queued}</span></Show>
        </span>
        <span class="spacer" data-tauri-drag-region />
        <div class="seg sm">
          <button classList={{ on: groupBy() === "state" }} onClick={() => setGroupBy("state")}>상태별</button>
          <button classList={{ on: groupBy() === "project" }} onClick={() => setGroupBy("project")}>프로젝트별</button>
        </div>
      </header>
      </Show>
      <Show when={props.embedded}>
        <div class="board-bar">
          <div class="seg sm">
            <button classList={{ on: groupBy() === "state" }} onClick={() => setGroupBy("state")}>상태별</button>
            <button classList={{ on: groupBy() === "project" }} onClick={() => setGroupBy("project")}>프로젝트별</button>
          </div>
        </div>
      </Show>

      <form
        class="board-ask"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Icon name="plus" size={15} class="muted" />
        <input
          placeholder={`새 일 맡기기 · ${spaceById(state.space).label} 메인에게 보내요`}
          value={ask()}
          onInput={(e) => setAsk(e.currentTarget.value)}
          onKeyDown={(e) => e.isComposing && e.stopPropagation()}
        />
        <Show when={ask().trim()}><kbd>⏎</kbd></Show>
      </form>

      <div class="board" classList={{ project: groupBy() === "project" }}>
        <For each={cols()} fallback={<div class="board-empty">일 없음</div>}>
          {(c) => (
            <section class="bcol" classList={{ empty: !c.tasks.length }}>
              <div class="bcol-head">
                <i class={`tone-dot td-${c.tone}`} />
                <span class="bcol-name">{c.label}</span>
                <span class="bcol-n">{c.tasks.length}</span>
                <Show when={c.id === "done" && hiddenOld()}>
                  <button class="link-btn bcol-more" onClick={() => setShowOld(!showOld())}>{showOld() ? "최근만" : `이전 ${hiddenOld()}개`}</button>
                </Show>
              </div>
              <div class="bcol-list">
                <For each={c.tasks} fallback={<div class="bcol-empty">{c.hint}</div>}>{(t) => <Card t={t} byProject={groupBy() === "project"} />}</For>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

function Card(props: { t: Task; byProject: boolean }) {
  const t = () => props.t;
  const st = () => stateOf(t());
  const kids = () => state.tasks.filter((k) => k.parentId === t().id);
  const liveKids = () => kids().filter((k) => k.status === "running").length;
  const diff = () => changes(t());
  const [talk, setTalk] = createSignal(false);
  const [msg, setMsg] = createSignal("");
  const [sent, setSent] = createSignal(0);
  let input!: HTMLInputElement;

  const line = (): string => {
    const d = decisionFor(t().id);
    if (d) return d.question;
    if (t().status === "failed") return t().error ?? "멈췄어요";
    if (st() === "running") return t().now || "시작하는 중";
    if (st() === "queued") return t().status === "paused" ? "쉬는 중" : "순서를 기다려요";
    return t().summary || t().now || "";
  };
  const when = () => {
    if (st() === "running" && t().startedAt) return `${compact(now() - t().startedAt!)}째`;
    if (st() === "queued") return ago(t().createdAt);
    return ago(t().finishedAt ?? t().startedAt ?? t().createdAt);
  };
  const say = () => {
    const m = msg().trim();
    if (!m) return;
    void tell(t().id, m);
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
      <Icon name={icon} size={13} />
      <span>{label}</span>
    </button>
  );

  return (
    <article class={`bcard tone-${st()}`} classList={{ talking: talk() }} onClick={() => openTask(t().id)} tabindex="0" onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openTask(t().id)}>
      <div class="bc-top">
        <StatusIcon t={t()} size="sm" />
        <span class="bc-title">{t().title}</span>
      </div>
      <Show when={line()}><p class="bc-line">{line()}</p></Show>
      <div class="bc-meta">
        <Show when={!props.byProject && t().topic}><span class="bc-chip">{t().topic}</span></Show>
        <Show when={kids().length}>
          <span class="bc-kids" title="서브에이전트">
            <Icon name="branch" size={11} />
            {liveKids() ? `${liveKids()}/${kids().length}` : kids().length}
          </span>
        </Show>
        <Show when={diff().add || diff().del}>
          <span class="bc-diff">
            <span class="add">+{diff().add}</span>
            <Show when={diff().del}> <span class="del">−{diff().del}</span></Show>
          </span>
        </Show>
        <span class="spacer" />
        <Show when={sent()}><span class="bc-sent">보냄 {sent()}</span></Show>
        <span class="bc-when">{when()}</span>
      </div>

      <div class="bc-acts">
        <Show when={st() === "running" || st() === "you" || st() === "review" || st() === "queued"}>
          {act("말하기", "message", () => (setTalk(!talk()), queueMicrotask(() => input?.focus())))}
        </Show>
        <Show when={st() === "running"}>{act("멈추기", "pause", () => stopTask(t().id))}</Show>
        <Show when={t().status === "paused"}>{act("다시 시작", "play", () => resumeTask(t().id))}</Show>
        <Show when={t().status === "queued"}>{act("지금 시작", "play", () => void startTask(t().id))}</Show>
        <Show when={st() === "review"}>{act("원래 폴더에 합치기", "merge", () => void mergeTask(t().id), true)}</Show>
        <Show when={st() === "you"}>{act("답하기", "arrow", () => openTask(t().id), true)}</Show>
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
            placeholder={st() === "running" ? "일하는 중에 끼어들어 말하기" : "이어서 시킬 것"}
            value={msg()}
            onInput={(e) => setMsg(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.stopPropagation(), setTalk(false));
            }}
          />
          <button type="submit" class="bc-send" disabled={!msg().trim()} aria-label="보내기">
            <Icon name="send" size={13} />
          </button>
        </form>
      </Show>
    </article>
  );
}

export const openBoard = () => setView({ name: "board" });
