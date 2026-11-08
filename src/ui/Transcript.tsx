// A task's transcript: messages, tool calls as single rows (runs of them
import { nowText } from "../engine/describe";
import { keepBottom } from "./stick";
// collapse into one summary line), visual blocks, handoffs, turn dividers,
// and the live line while the agent works.
import { Fold } from "./Fold";
import { createEffect, onCleanup, createMemo, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import type { Block, Entry, Shell, Task, ToolCall, Usage } from "../state/types";
import { live, previewFile } from "../state/ui";
import { state, taskById } from "../state/store";
import { editTurn, startTask } from "../engine/tasks";
import { describeCommand, mainCommand } from "../engine/describe";
import { ForkCard } from "./ForkCard";
import { BlockView } from "./Blocks";
import { withDiff } from "../state/progress";
import { long, now, short } from "./bits";
import { Icon } from "./Icon";
import { UsageLine } from "./Usage";
import { Markdown } from "./Markdown";
import { MsgActions, UserMsg } from "./MsgActions";
import { costDetail, jobCost } from "./cost";
import { t as tr } from "../i18n";

type Item =
  | { kind: "tools"; id: string; tools: (Entry & { kind: "tool" })[] }
  | { kind: "blocks"; id: string; blocks: Block[] }
  | { kind: "entry"; id: string; entry: Entry };

/** Fold consecutive tool calls and consecutive blocks together. */
function group(entries: Entry[]): Item[] {
  const out: Item[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (e.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(e);
      else out.push({ kind: "tools", id: e.id, tools: [e] });
    } else if (e.kind === "block") {
      if (last?.kind === "blocks") last.blocks.push(e.block);
      else out.push({ kind: "blocks", id: e.id, blocks: [e.block] });
    } else out.push({ kind: "entry", id: e.id, entry: e });
  }
  return out;
}

/** One request and everything the agent did for it (across session hand-offs). */
type Turn = { id: string; user?: Entry & { kind: "user" }; body: Entry[]; ms?: number; usage?: Usage };

function turns(entries: Entry[]): Turn[] {
  const out: Turn[] = [];
  for (const e of entries) {
    if (e.kind === "user" || !out.length) out.push({ id: e.id, body: [], ...(e.kind === "user" ? { user: e } : {}) });
    const t = out[out.length - 1];
    if (e.kind === "user") continue;
    if (e.kind === "turn") {
      t.ms = (t.ms ?? 0) + e.ms;
      if (e.usage) t.usage = e.usage;
    } else t.body.push(e);
  }
  return out;
}

/** Links in a row become one list instead of a stack of boxes. */
function chunkLinks(blocks: Block[]): (Block | Block[])[] {
  const out: (Block | Block[])[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === "link" && Array.isArray(last)) last.push(b);
    else out.push(b.type === "link" ? [b] : b);
  }
  return out;
}

function Items(props: { entries: Entry[]; task: Task; live: boolean; openTools?: boolean }) {
  const items = createMemo(() => group(props.entries));
  return (
    <For each={items()}>
      {(it) => (
        <Switch>
          <Match when={it.kind === "tools" && it}>
            {(g) => (
              <For each={runs(g().tools)}>
                {(r) => (
                  <Show when={r.length > 1} fallback={<ToolLine e={r[0]} shells={props.task.shells} />}>
                    <ToolGroup tools={r} shells={props.task.shells} />
                  </Show>
                )}
              </For>
            )}
          </Match>
          <Match when={it.kind === "blocks" && it}>
            {(g) => (
              <div class="blocks">
                <For each={chunkLinks(g().blocks)}>
                  {(c) => (Array.isArray(c) ? <div class="blk blk-links"><For each={c}>{(b) => <BlockView block={b} />}</For></div> : <BlockView block={withDiff(c, props.task)} />)}
                </For>
              </div>
            )}
          </Match>
          <Match when={it.kind === "entry" && it}>{(x) => <EntryView e={x().entry} task={props.task} />}</Match>
        </Switch>
      )}
    </For>
  );
}

/** A subagent's instructions come from its parent job, not from you. */
const assigner = (t: Task) => {
  const p = t.parentId ? taskById(t.parentId) : undefined;
  return p ? tr("{name}에서", { name: p.title }) : undefined;
};

/** Explanations drawn as pictures: they stay in view when the work folds. */
const VISUAL = new Set(["diagram", "scope", "bars", "tree", "groups", "sequence", "steps", "page", "flow", "deps", "classes", "er", "arch", "states", "diff", "tests", "options", "trace", "git"]);

/**
 * While the job isn't finished you see everything, with nothing to fold or unfold
 * (a steer or a question in between doesn't fold the turn before it). Once the
 * whole job is done, each turn's work folds into "N분 동안 작업 ›" and only its
 * closing summary stays (the answer text and result blocks it ended with); the
 * fold can be opened. Errors never fold.
 */
function TurnView(props: { turn: Turn; task: Task; open: boolean; last?: boolean; tail?: JSX.Element }) {
  const [shown, setShown] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);
  const body = () => props.turn.body;
  /** where the closing summary starts: the run of text and blocks at the very end */
  const tailStart = createMemo(() => {
    let i = body().length;
    // notes added after the answer (merged, remembered) don't push it into the fold
    while (i > 0 && (body()[i - 1].kind === "text" || body()[i - 1].kind === "block" || body()[i - 1].kind === "note")) i--;
    return i;
  });
  /** pictures never fold away: errors and diagrams stay in view after the turn */
  const stays = (e: Entry) => e.kind === "error" || (e.kind === "block" && VISUAL.has(e.block.type));
  const work = () => body().slice(0, tailStart()).filter((e) => !stays(e));
  const rest = () => [...body().slice(0, tailStart()).filter(stays), ...body().slice(tailStart())];
  const answer = () => {
    const r = rest();
    for (let i = r.length - 1; i >= 0; i--) {
      const e = r[i];
      if (e.kind === "text") return e.text;
    }
    return "";
  };
  // a subagent (a review above all) often ends with only a done block: its findings
  // went to the job that asked, so show them here too
  const report = () => (props.last && !answer() && props.task.status === "done" && props.task.result?.trim()) || "";
  const took = () => {
    if (props.turn.ms) return props.turn.ms;
    const to = Math.max(...body().map((e) => (e.kind === "tool" ? (e.tool.endedAt ?? e.at) : e.at)), props.task.finishedAt ?? 0);
    // counted from when the job started, not from when it was asked (the same time "걸림" shows)
    const asked = props.turn.user?.at ?? body()[0]?.at ?? 0;
    const from = props.task.startedAt && props.task.startedAt > asked && props.task.startedAt < to ? props.task.startedAt : asked;
    return to - from;
  };
  const toggle = () => {
    if (!mounted()) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    } else setShown(!shown());
  };
  // the moment the job finishes, the work visibly folds away into one line
  createEffect(
    on(
      () => props.open,
      (open, was) => {
        // only the turn in view folds visibly; earlier ones just close
        if (open || !was || !work().length || !props.last) return;
        setMounted(true);
        setShown(true);
        setTimeout(() => setShown(false), 450);
      },
    ),
  );
  return (
    <>
      <Show when={props.turn.user}>
        {(u) => <UserMsg id={u().id} text={u().text} at={u().at} from={assigner(props.task)} onEdit={(t) => void editTurn(props.task.id, u().id, t)} />}
      </Show>
      <Show when={!props.open} fallback={<Items entries={body()} task={props.task} live />}>
        <Show when={work().length}>
          <div class="work-fold" classList={{ open: shown() }}>
            <button class="work-head" onClick={toggle} aria-expanded={shown()}>
              <span>{tr("{d} 동안 작업", { d: long(took()) })}</span>
              <Icon name="chevron" size={14} class="chev" />
            </button>
            <Show when={mounted()}>
              <div class="work-clip">
                <div class="work-body">
                  <Items entries={work()} task={props.task} live={false} openTools />
                </div>
              </div>
            </Show>
          </div>
        </Show>
        <Items entries={rest()} task={props.task} live={false} />
        <Show when={report()}>
          <Markdown class="msg-text" text={report()} />
        </Show>
        {props.tail}
        <Show when={answer() || report() || props.turn.usage}>
          <div class="reply-foot">
            <Show when={answer() || report()}>
              <MsgActions
                text={answer() || report()}
                onRetry={props.turn.user ? () => void editTurn(props.task.id, props.turn.user!.id, props.turn.user!.text) : undefined}
              />
            </Show>
            <Show when={props.turn.usage}>{(u) => <UsageLine u={u()} />}</Show>
          </div>
        </Show>
      </Show>
    </>
  );
}

const ICON: Record<ToolCall["kind"], string> = {
  read: "read",
  search: "search",
  edit: "edit",
  write: "write",
  bash: "shell",
  browser: "globe",
  desktop: "monitor",
  test: "test",
  other: "tools",
};
// short, like Codex ("편집함 a.ts"): the verb leads, the name follows quietly
const VERB: Record<ToolCall["kind"], [string, string]> = {
  read: ["읽는 중", "읽음"],
  search: ["찾는 중", "찾음"],
  edit: ["수정 중", "수정함"],
  write: ["만드는 중", "만듦"],
  bash: ["실행 중", "실행함"],
  browser: ["브라우저 쓰는 중", "브라우저 씀"],
  desktop: ["앱 조작 중", "앱 조작함"],
  test: ["테스트 중", "테스트 돌림"],
  other: ["도구 쓰는 중", "도구 씀"],
};

type ToolEntry = Entry & { kind: "tool" };

/**
 * Which calls belong on one line: reads/searches ("살펴봄", Codex's Explored),
 * file edits ("파일 수정함"), commands ("명령 5개 실행함", Claude Code's "Ran 5
 * shell commands") and browser steps. Memory notes and other tools stay single.
 */
type Family = "explore" | "edit" | "browser" | "run";
const familyOf = (e: ToolEntry): Family | undefined =>
  e.tool.note ? undefined : e.tool.kind === "read" || e.tool.kind === "search" ? "explore" : e.tool.kind === "edit" || e.tool.kind === "write" ? "edit" : e.tool.kind === "browser" ? "browser" : e.tool.kind === "bash" || e.tool.kind === "test" ? "run" : undefined;
function runs(tools: ToolEntry[]): ToolEntry[][] {
  const out: ToolEntry[][] = [];
  for (const t of tools) {
    const last = out[out.length - 1];
    const f = familyOf(t);
    if (f && last && familyOf(last[0]) === f) last.push(t);
    else out.push([t]);
  }
  return out;
}

/**
 * Calls made back to back read as one line, like other agent apps ("Ran 5 shell
 * commands", Codex's "파일 수정함 ⌄"): what was done, counted per kind; open it
 * for each call. While one runs, the line says which.
 */
function ToolGroup(props: { tools: ToolEntry[]; shells: Shell[] }) {
  const [open, setOpen] = createSignal(false);
  const live = () => props.tools.find((t) => !t.tool.endedAt);
  const failed = () => props.tools.filter((t) => t.tool.ok === false).length;
  const fam = () => familyOf(props.tools[0])!;
  const names = (list: ToolEntry[]) => {
    const seen: string[] = [];
    for (const t of list) {
      const n = shortName(t.tool);
      if (n && !seen.includes(n)) seen.push(n);
    }
    return seen.length > 3 ? tr("{names} 외 {n}개", { names: seen.slice(0, 3).join(", "), n: seen.length - 3 }) : seen.join(", ");
  };
  // "살펴봄 a.ts, b.ts", "파일 3개 수정함", "브라우저 5번 씀"
  const summary = () => {
    const done = !live();
    if (fam() === "explore") return done ? tr("살펴봄") : tr("살펴보는 중");
    if (fam() === "edit") {
      const n = new Set(props.tools.map((t) => t.tool.target ?? t.id)).size;
      return done ? tr("파일 {n}개 수정함", { n }) : tr("파일 {n}개 수정 중", { n });
    }
    // commands too, as Claude Code does ("Ran 5 shell commands")
    if (fam() === "run") return done ? tr("명령 {n}개 실행함", { n: props.tools.length }) : tr("명령 {n}개 실행 중", { n: props.tools.length });
    return done ? tr("브라우저 {n}번 씀", { n: props.tools.length }) : tr("브라우저 쓰는 중");
  };
  // what it touched; for commands and the browser, the one running now (or the last)
  const detail = () => (fam() === "explore" || fam() === "edit" ? names(props.tools) : shortName((live() ?? props.tools[props.tools.length - 1]).tool));
  const lead = () => (fam() === "explore" ? "read" : fam() === "edit" ? "edit" : fam() === "run" ? "bash" : "browser") as ToolCall["kind"];
  return (
    <div class="tool group" classList={{ open: open() }}>
      <button class="tool-row click" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <Show when={live()} fallback={<Icon name={ICON[lead()]} size={14} />}>
          <span class="spin" />
        </Show>
        <span class="tool-verb" classList={{ shimmer: !!live() }}>{summary()}</span>
        <span class="tool-target">{detail()}</span>
        <Show when={failed()}><span class="tool-fail">{tr("실패 {n}", { n: failed() })}</span></Show>
        <Icon name="chevron" size={12} class="tool-chev" />
      </button>
      <Fold open={open()}>
        <div class="explore-body">
          <For each={props.tools}>{(e) => <ToolLine e={e} shells={props.shells} />}</For>
        </div>
      </Fold>
    </div>
  );
}

/** a short name for what a call touched: a file's name, a command's first words */
function shortName(t: ToolCall) {
  const x = (t.target ?? "").trim();
  if (["bash", "test", "browser", "desktop"].includes(t.kind)) {
    // the command doing the work, not the setup in front of it ("pkill -f …; npm run dev")
    const head = (t.kind === "bash" || t.kind === "test" ? mainCommand(x) : x.split(/;|&&|\|\||\||\n/)[0].trim()).split(/\s+/).slice(0, 3).join(" ");
    return head.length > 36 ? `${head.slice(0, 35)}…` : head;
  }
  return /^[~/.]/.test(x) || x.includes("/") ? x.replace(/\/+$/, "").split("/").pop() || x : x;
}

function ToolLine(props: { e: Entry & { kind: "tool" }; shells: Shell[] }) {
  const t = () => props.e.tool;
  const shell = () => (t().shellId ? props.shells.find((s) => s.id === t().shellId) : undefined);
  const running = () => !t().endedAt;
  const what = () => shortName(t());
  const [open, setOpen] = createSignal(false);
  const canOpen = () => !!shell() || t().kind === "other" || t().kind === "search" || !!t().note;
  const click = () => {
    if (canOpen()) setOpen(!open());
    else if (t().detail?.startsWith("/")) previewFile(t().detail!.split("\n")[0]);
  };
  let pre: HTMLPreElement | undefined;
  createEffect(on(() => shell()?.tail, () => queueMicrotask(() => pre && (pre.scrollTop = pre.scrollHeight))));
  return (
    <div class="tool" classList={{ bad: t().ok === false }}>
      <button class="tool-row click" onClick={click} title={t().detail}>
        <Show when={running()} fallback={<Icon name={t().note ? "memory" : ICON[t().kind]} size={14} />}>
          <span class="spin" />
        </Show>
        <span class="tool-verb" classList={{ shimmer: running() }}>
          {t().note ? (running() ? tr("메모리에 쓰는 중") : tr("메모리에 저장함")) : tr(t().kind === "bash" ? ((d) => (running() ? d.now : d.label))(describeCommand(t().target ?? "")) : VERB[t().kind][running() ? 0 : 1])}
        </span>
        <span class="tool-target">{what()}</span>
        <Show when={t().add || t().del}>
          <span class="tool-stat"><span class="add">+{t().add ?? 0}</span><Show when={t().del}> <span class="del">−{t().del}</span></Show></span>
        </Show>
        <Show when={t().ok === false}><span class="tool-fail">{tr("실패")}</span></Show>
        <span class="tool-time">{t().endedAt ? short(t().endedAt! - props.e.at) : tr("{d}째", { d: short(now() - props.e.at) })}</span>
        <Show when={canOpen()}><Icon name="chevron" size={12} class="tool-chev" /></Show>
      </button>
      <Fold open={open() && !!t().note}>
        <div class="tool-note">
          <Markdown text={t().text || tr("(내용 없음)")} />
          <button class="btn sm ghost" onClick={() => t().detail && previewFile(t().detail!.split("\n")[0])}>{tr("파일 열기")}</button>
        </div>
      </Fold>
      <Fold open={open() && !t().note}>
        <pre class="tool-out" ref={pre}>
          <Show when={shell()} fallback={t().detail}>
            {(s) => (
              <>
                {s().tail.trim() || (s().endedAt ? tr("출력 없음") : tr("출력 대기 중…"))}
                <Show when={s().endedAt}>
                  <span class="exit" classList={{ bad: s().ok === false }}>{s().ok === false ? tr("실패") : tr("완료")} · {long((s().endedAt ?? 0) - s().startedAt)}</span>
                </Show>
              </>
            )}
          </Show>
        </pre>
      </Fold>
    </div>
  );
}

function EntryView(props: { e: Entry; task: Task }) {
  const e = props.e;
  return (
    <Switch>
      <Match when={e.kind === "user" && e}>{(x) => <UserMsg text={x().text} at={x().at} from={assigner(props.task)} />}</Match>
      <Match when={e.kind === "text" && e}>{(x) => <Markdown class="msg-text" text={x().text} />}</Match>
      <Match when={e.kind === "turn" && e}>
        {(x) => (
          <Show when={x().usage} fallback={<div class="turn-sep">{tr("{d} 동안 작업", { d: long(x().ms) })}</div>}>
            {(u) => <UsageLine u={u()} lead={x().ms ? tr("{d} 동안 작업", { d: long(x().ms) }) : undefined} />}
          </Show>
        )}
      </Match>
      <Match when={e.kind === "note" && e}>
        {(x) => (
          <div class="note">
            <Icon name={x().text.startsWith("기억함") ? "memory" : x().text.startsWith("모델") ? "refresh" : "dot"} size={13} />
            {x().text}
          </div>
        )}
      </Match>
      <Match when={e.kind === "error" && e}>
        {(x) => (
          <div class="err-line">
            <Icon name="alert" size={14} />
            <span>{x().text}</span>
          </div>
        )}
      </Match>
      <Match when={e.kind === "spawn" && e}>
        {(x) => {
          const kids = () => x().childIds.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean);
          const busy = () => kids().filter((k) => k!.status === "running" || k!.status === "queued").length;
          return (
            <div class="sub-group">
              <div class="sub-head">
                <Icon name="branch" size={13} />
                <b>{tr("서브에이전트 {n}개", { n: x().childIds.length })}</b>
                <span>{busy() ? tr("{n}개 진행 중", { n: busy() }) : tr("모두 완료")}</span>
              </div>
              <For each={x().childIds}>{(id) => <ForkCard id={id} compact />}</For>
            </div>
          );
        }}
      </Match>
      <Match when={e.kind === "handoff" && e}>
        {(x) => (
          <div class="handoff">
            <div class="handoff-head"><Icon name="handoff" size={14} />{tr("세션 {n}에서 계속", { n: x().leg })}</div>
            <Show when={x().handoff.did.length}>
              <ul><For each={x().handoff.did}>{(d) => <li>{d}</li>}</For></ul>
            </Show>
            <div class="handoff-next">{tr("다음: {next}", { next: x().handoff.next })}</div>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/** The line a finished task ends on: "완료 · 19분", what it used on hover. While its changes wait for
 *  review it isn't done yet (the review bar below says so): only how long it worked. */
export function JobEnd(props: { t: Task }) {
  const c = () => jobCost(props.t);
  return (
    <Show when={props.t.status === "done" && c().ms}>
      <div class="job-cost" title={costDetail(c()) || undefined}>
        {props.t.worktree?.state === "open" ? tr("{d} 동안 작업", { d: long(c().ms) }) : `${tr("완료")} · ${long(c().ms)}`}
      </div>
    </Show>
  );
}

export function Transcript(props: { task: Task; agentId: string; footer?: JSX.Element }) {
  let scroller!: HTMLDivElement;
  const list = createMemo(() => turns(props.task.entries));
  const liveText = () => live[props.agentId] ?? "";
  const working = () => props.task.status === "running";
  /** all its work is over: only then do turns fold */
  const settled = () => props.task.status === "done" || props.task.status === "failed";
  /** a running tool row already says what is happening */
  const toolRunning = () => {
    const last = props.task.entries[props.task.entries.length - 1];
    return last?.kind === "tool" && !last.tool.endedAt;
  };
  const [stick, setStick] = createSignal(true);
  const queuePos = () => {
    const q = state.tasks.filter((t) => t.status === "queued" && !t.parentId).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    const i = q.findIndex((t) => t.id === props.task.id);
    return i >= 0 ? i + 1 : 0;
  };

  return (
    <div class="thread" ref={(el) => { scroller = el; onCleanup(keepBottom(el, setStick)); }}>
      <Show when={!stick()}>
        <button class="jump-latest" title={tr("맨 아래로")} aria-label={tr("맨 아래로")} onClick={() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })}>
          <Icon name="down" size={14} />
        </button>
      </Show>
      <div class="thread-inner">
        <Show when={!props.task.entries.some((e) => e.kind === "user")}>
          <UserMsg text={props.task.ask} at={props.task.createdAt} from={assigner(props.task)} />
        </Show>
        <For each={list()}>
          {(t, i) => (
            <TurnView
              turn={t}
              task={props.task}
              open={!settled()}
              last={i() === list().length - 1}
            />
          )}
        </For>
        <Show when={!props.task.entries.some((e) => e.kind !== "user") && props.task.status === "done" && props.task.summary}>
          <Markdown class="msg-text" text={props.task.summary!} />
        </Show>
        <Show when={liveText()}>
          <Markdown class="msg-text" text={liveText()} />
        </Show>
        <Show when={props.task.status === "queued"}>
          <div class="live-line muted queued-line">
            <Icon name="clock" size={14} />
            <span>{queuePos() <= 1 ? tr("다음 차례") : tr("앞에 {n}개 대기", { n: queuePos() - 1 })}</span>
            <span class="spacer" />
            <button class="btn sm" onClick={() => void startTask(props.task.id)}>{tr("지금 시작")}</button>
          </div>
        </Show>
        {/* waiting on its subagents: their card above already shows that */}
        <Show when={working() && !liveText() && !toolRunning() && !state.tasks.some((k) => k.parentId === props.task.id && (k.status === "running" || k.status === "queued"))}>
          <div class="live-line">
            <span class="spin" />
            <span class="shimmer">{props.task.now ? nowText(props.task.now) : tr("작업 중")}</span>
          </div>
        </Show>
        {/* a question waiting on the user: last in the conversation, so it scrolls with it */}
        {props.footer}
      </div>
    </div>
  );
}
