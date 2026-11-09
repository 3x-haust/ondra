// A task's transcript: messages, tool calls as single rows (runs of them
import { noteText, nowText } from "../engine/describe";
import { keepBottom } from "./stick";
// collapse into one summary line), visual blocks, handoffs, turn dividers,
// and the live line while the agent works.
import { Fold } from "./Fold";
import { createEffect, onCleanup, createMemo, createSignal, For, Index, type JSX, Match, on, Show, Switch } from "solid-js";
import type { Block, Entry, Shell, Task, ToolCall, Usage } from "../state/types";
import { live, previewFile } from "../state/ui";
import { kidsOf, state, taskById } from "../state/store";
import { editTurn, startTask } from "../engine/tasks";
import { describeBrowser, describeCommand, mainCommand } from "../engine/describe";
import { ForkCard } from "./ForkCard";
import { BlockView } from "./Blocks";
import { discarded, withDiff } from "../state/progress";
import { long, now, short, statusLabel } from "./bits";
import { Icon } from "./Icon";
import { UsageLine } from "./Usage";
import { Markdown } from "./Markdown";
import { MsgActions, UserMsg } from "./MsgActions";
import { AnsweredCard, answerOf } from "./DecisionCard";
import { costDetail, jobCost } from "./cost";
import { Glyph } from "../views/Sidebar";
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

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameItem = (a: Item, b: Item) =>
  a.kind === b.kind && a.id === b.id && (a.kind === "tools" ? sameList(a.tools, (b as typeof a).tools) : a.kind === "blocks" ? sameList(a.blocks, (b as typeof a).blocks) : a.entry === (b as typeof a).entry);
const sameTurn = (a: Turn, b: Turn) => a.id === b.id && a.user === b.user && a.ms === b.ms && a.usage === b.usage && sameList(a.body, b.body);
/**
 * The new list, but with the previous object wherever nothing in it changed: a streamed
 * line then redraws only the row it lands in, not the whole thread (and an opened row stays open).
 */
function keep<T>(prev: T[] | undefined, next: T[], same: (a: T, b: T) => boolean): T[] {
  if (!prev?.length) return next;
  const out = next.map((x, i) => (prev[i] !== undefined && same(prev[i], x) ? prev[i] : x));
  return out.length === prev.length && out.every((x, i) => x === prev[i]) ? prev : out;
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

/** the index of the last entry that matches, or -1 */
const lastAt = (es: Entry[], ok: (e: Entry) => boolean) => {
  for (let i = es.length - 1; i >= 0; i--) if (ok(es[i])) return i;
  return -1;
};

/** A call left open on a task that isn't working (paused, failed, stopped) isn't running: it shows as stopped. */
const halted = (t: Task) => t.status !== "running" && t.status !== "waiting";

/** What Ondra's watchdog stopped, by the note it leaves: a search that printed nothing, a wait that saw nothing new. */
type Halt = "search" | "wait";
const HALT_NOTES: [string, Halt][] = [["검색 멈춤", "search"], ["기다림 멈춤", "wait"]];
const SEARCHY = /(^|[\s;&|(])(find|fd|rg|grep|egrep|ag|ack|du|locate|mdfind|tree|ls\s+-\w*R)\b/;

/**
 * The calls Ondra stopped (not failures: the agent is told why and goes on). The note is pushed
 * while the call still runs, so the call is just before it: the last command since the request
 * that does what the note says (a search for 검색 멈춤), else the last command.
 */
function haltsOf(entries: Entry[]): Map<string, Halt> {
  const out = new Map<string, Halt>();
  entries.forEach((e, i) => {
    const kind = e.kind === "note" ? HALT_NOTES.find(([p]) => e.text.startsWith(p))?.[1] : undefined;
    if (!kind) return;
    const before: ToolEntry[] = [];
    for (let j = i - 1; j >= 0 && entries[j].kind !== "user"; j--) {
      const x = entries[j];
      if (x.kind === "tool" && x.tool.name === "bash" && !out.has(x.id)) before.push(x);
    }
    const hit = before.find((x) => (kind === "search" ? SEARCHY.test(x.tool.detail ?? x.tool.target) : !SEARCHY.test(x.tool.detail ?? x.tool.target))) ?? before[0];
    if (hit) out.set(hit.id, kind);
  });
  return out;
}

/** How many rows a run of entries shows: tool runs fold into one line each, links into one list. */
function rowCount(entries: Entry[]): number {
  let n = 0;
  for (const it of group(entries)) n += it.kind === "tools" ? runs(it.tools).length : it.kind === "blocks" ? chunkLinks(it.blocks).length : 1;
  return n;
}

function Items(props: { entries: Entry[]; task: Task; live: boolean; openTools?: boolean }) {
  // by position: the thread grows at its end, so a row keeps its place (and its open fold) while lines stream in
  const items = createMemo<Item[]>((prev) => keep(prev, group(props.entries), sameItem));
  const stopped = () => halted(props.task);
  const halts = createMemo(() => haltsOf(props.task.entries));
  return (
    <Index each={items()}>
      {(item) => (
        <Switch>
          <Match when={item().kind === "tools" && (item() as Item & { kind: "tools" })}>
            {(g) => (
              <Index each={runs(g().tools)}>
                {(r) => (
                  <Show when={r().length > 1} fallback={<ToolLine e={r()[0]} shells={props.task.shells} stopped={stopped()} halt={halts().get(r()[0].id)} />}>
                    <ToolGroup tools={r()} shells={props.task.shells} stopped={stopped()} halts={halts()} />
                  </Show>
                )}
              </Index>
            )}
          </Match>
          <Match when={item().kind === "blocks" && (item() as Item & { kind: "blocks" })}>
            {(g) => (
              <div class="blocks">
                <For each={chunkLinks(g().blocks)}>
                  {(c) => (Array.isArray(c) ? <div class="blk blk-links"><For each={c}>{(b) => <BlockView block={b} />}</For></div> : <BlockView block={withDiff(c, props.task)} />)}
                </For>
              </div>
            )}
          </Match>
          <Match when={item().kind === "entry" && (item() as Item & { kind: "entry" })}>{(x) => <EntryView e={x().entry} task={props.task} />}</Match>
        </Switch>
      )}
    </Index>
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
 * whole job is done, each turn's work folds into "작업 과정 N단계 ›" (the time is said once, on the
 * end line) and only its
 * closing summary stays (the answer text and result blocks it ended with); the
 * fold can be opened (a fold of one row is just that row). Errors never fold.
 */
function TurnView(props: { turn: Turn; task: Task; open: boolean; last?: boolean; end?: boolean }) {
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
  /** a fold that would hold one row is just that row */
  const lone = createMemo(() => rowCount(work()) === 1);
  /** notes at the very end (merged, remembered) come after the answer's actions, not between the two */
  const notesFrom = createMemo(() => {
    let i = body().length;
    while (i > tailStart() && body()[i - 1].kind === "note") i--;
    return i;
  });
  const rest = () => [...body().slice(0, tailStart()).filter(stays), ...body().slice(tailStart(), notesFrom())];
  const after = () => body().slice(notesFrom());
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
        if (open || !was || !work().length || lone() || !props.last) return;
        setMounted(true);
        setShown(true);
        setTimeout(() => setShown(false), 450);
      },
    ),
  );
  return (
    <>
      <Show when={props.turn.user}>
        {(u) => (
          <Show when={answerOf(u().text)} fallback={<UserMsg id={u().id} text={u().text} at={u().at} from={assigner(props.task)} onEdit={(t) => void editTurn(props.task.id, u().id, t)} />}>
            {(a) => <AnsweredCard q={a().q} a={a().a} />}
          </Show>
        )}
      </Show>
      <Show when={!props.open} fallback={<Items entries={body()} task={props.task} live />}>
        <Show when={work().length && !lone()} fallback={<Show when={lone()}><Items entries={work()} task={props.task} live={false} /></Show>}>
          <div class="work-fold" classList={{ open: shown() }}>
            <button class="work-head" onClick={toggle} aria-expanded={shown()}>
              <span>{tr("작업 과정 {n}단계", { n: rowCount(work()) })}</span>
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
        {/* the end of the job: one row with the end line ("19분 동안 작업"), the answer's actions on hover,
            then the notes (병합, 버림, 메모리); an action row with nothing shown takes no room */}
        <Show when={answer() || report() || props.turn.usage || props.end}>
          <div class="reply-foot" classList={{ end: !!props.end, newest: !!props.last && !after().length }}>
            <Show when={props.end}>
              <JobEndLine t={props.task} />
            </Show>
            <Show when={answer() || report()}>
              <MsgActions
                text={answer() || report()}
                onRetry={props.turn.user ? () => void editTurn(props.task.id, props.turn.user!.id, props.turn.user!.text) : undefined}
              />
            </Show>
            <Show when={props.turn.usage}>{(u) => <UsageLine u={u()} />}</Show>
          </div>
        </Show>
        <Show when={after().length}>
          <Items entries={after()} task={props.task} live={false} />
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
function ToolGroup(props: { tools: ToolEntry[]; shells: Shell[]; stopped?: boolean; halts?: Map<string, Halt> }) {
  const [open, setOpen] = createSignal(false);
  /** Ondra stopped it: neither running nor failed */
  const halt = (t: ToolEntry) => props.halts?.get(t.id);
  const open_ = () => props.tools.find((t) => !t.tool.endedAt && !halt(t));
  const live = () => (props.stopped ? undefined : open_());
  const failed = () => props.tools.filter((t) => t.tool.ok === false && !halt(t)).length;
  const halts = () => props.tools.filter((t) => halt(t)).length;
  const fam = () => familyOf(props.tools[0])!;
  const names = (list: (string | undefined)[]) => {
    const seen = [...new Set(list.filter((n): n is string => !!n))];
    return seen.length > 3 ? tr("{names} 외 {n}개", { names: seen.slice(0, 3).join(", "), n: seen.length - 3 }) : seen.join(", ");
  };
  // browser steps: the one going on, or the one target they all worked on ("클릭 중 ‘프로 시작하기’",
  // "열었음 acme.dev/pricing"); several targets read "브라우저 5번 씀" with the sites opened
  const steps = () => props.tools.map((t) => describeBrowser(t.tool.target ?? ""));
  const step = () => {
    if (fam() !== "browser") return undefined;
    const l = live();
    if (l) return ((d) => ({ verb: d.now, target: d.target ?? (d.action === "other" ? shortName(l.tool) : "") }))(steps()[props.tools.indexOf(l)]);
    const on = [...new Set(steps().map((d) => d.target).filter(Boolean))];
    const d = on.length === 1 ? steps().find((x) => x.target === on[0]) : undefined;
    return d ? { verb: d.label, target: d.target! } : undefined;
  };
  const sites = () => names(steps().map((d) => (d.action === "open" ? d.target?.split("/")[0] : undefined)));
  // "살펴봄 a.ts, b.ts", "파일 3개 수정함", "브라우저 5번 씀"
  const summary = () => {
    const s = step();
    if (s) return s.verb;
    const done = !live();
    if (fam() === "explore") return done ? tr("살펴봄") : tr("살펴보는 중");
    if (fam() === "edit") {
      const n = new Set(props.tools.map((t) => t.tool.target ?? t.id)).size;
      return done ? tr("파일 {n}개 수정함", { n }) : tr("파일 {n}개 수정 중", { n });
    }
    // commands too, as Claude Code does ("Ran 5 shell commands")
    // while running, the ones still running, not the ones already done
    if (fam() === "run") return done ? tr("명령 {n}개 실행함", { n: props.tools.length }) : tr("명령 {n}개 실행 중", { n: props.tools.filter((t) => !t.tool.endedAt && !halt(t)).length });
    return done ? tr("브라우저 {n}번 씀", { n: props.tools.length }) : tr("브라우저 쓰는 중");
  };
  // what it touched; for commands the one running now (or the last), for the browser the step's target or the sites
  const detail = () =>
    fam() === "explore" || fam() === "edit" ? names(props.tools.map((t) => shortName(t.tool))) : fam() === "browser" ? (step()?.target ?? sites()) : shortName((open_() ?? props.tools[props.tools.length - 1]).tool);
  const lead = () => (fam() === "explore" ? "read" : fam() === "edit" ? "edit" : fam() === "run" ? "bash" : "browser") as ToolCall["kind"];
  return (
    <div class="tool group" classList={{ open: open() }}>
      <button class="tool-row click" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <Show when={live()} fallback={<Icon name={ICON[lead()]} size={14} />}>
          <span class="spin" />
        </Show>
        <span class="tool-verb" classList={{ shimmer: !!live() }}>{summary()}</span>
        <span class="tool-target" classList={{ cmd: fam() === "run" }}>{detail()}</span>
        <span class="tool-end">
          {/* a browser step named by its verb ("클릭 중 ‘프로 시작하기’") says how many steps the row holds */}
          <Show when={step()}><span class="tool-count">{tr("{n}단계|count", { n: props.tools.length })}</span></Show>
          <Show when={failed()}><span class="tool-fail">{tr("실패 {n}", { n: failed() })}</span></Show>
          <Show when={halts() && !failed()}><span class="tool-stopped">{tr("멈춤|tool")}</span></Show>
          <Show when={(props.stopped && open_()) || props.tools.some((e) => e.tool.stopped && !halt(e))}><span class="tool-stopped">{tr("중단됨")}</span></Show>
        </span>
        <Icon name="chevron" size={12} class="tool-chev" />
      </button>
      <Fold open={open()}>
        <div class="explore-body">
          <For each={props.tools}>{(e) => <ToolLine e={e} shells={props.shells} stopped={props.stopped} halt={halt(e)} />}</For>
        </div>
      </Fold>
    </div>
  );
}

/** a short name for what a call touched: a file's name, a command's first words */
function shortName(t: ToolCall) {
  const x = (t.target ?? "").trim();
  if (t.kind === "bash" || t.kind === "test") {
    // the command doing the work, without the setup in front of it or what wraps it
    // ("pkill -f …; npm run dev", "list=$(find . -name …)" → "find . -name …"); the row cuts it
    const c = mainCommand(x).replace(/\s+/g, " ");
    return c.length > 120 ? `${c.slice(0, 119)}…` : c;
  }
  if (t.kind === "browser" || t.kind === "desktop") {
    const head = x.split(/;|&&|\|\||\||\n/)[0].trim().split(/\s+/).slice(0, 3).join(" ");
    return head.length > 36 ? `${head.slice(0, 35)}…` : head;
  }
  return /^[~/.]/.test(x) || x.includes("/") ? x.replace(/\/+$/, "").split("/").pop() || x : x;
}

function ToolLine(props: { e: Entry & { kind: "tool" }; shells: Shell[]; stopped?: boolean; halt?: Halt }) {
  const t = () => props.e.tool;
  const shell = () => (t().shellId ? props.shells.find((s) => s.id === t().shellId) : undefined);
  /** never finished, and the task stopped working: not running any more (Ondra's stop says 멈춤 instead) */
  const cut = () => !props.halt && (!!t().stopped || (!t().endedAt && !!props.stopped));
  const running = () => !t().endedAt && !props.stopped && !props.halt;
  /** how long it took or has run: nothing under a second ("0초째" says nothing) */
  const took = () => (t().endedAt ?? now()) - props.e.at;
  const browser = () => (t().kind === "browser" ? describeBrowser(t().target ?? "") : undefined);
  const what = () => ((b) => (b && b.action !== "other" ? (b.target ?? "") : shortName(t())))(browser());
  const [open, setOpen] = createSignal(false);
  const canOpen = () => !!shell() || t().kind === "other" || t().kind === "search" || !!t().note;
  const click = () => {
    if (canOpen()) setOpen(!open());
    else if (t().detail?.startsWith("/")) previewFile(t().detail!.split("\n")[0]);
  };
  let pre: HTMLPreElement | undefined;
  createEffect(on(() => shell()?.tail, () => queueMicrotask(() => pre && (pre.scrollTop = pre.scrollHeight))));
  return (
    <div class="tool" classList={{ bad: t().ok === false && !props.halt, halted: !!props.halt }}>
      <button class="tool-row click" onClick={click} title={t().detail}>
        <Show when={running()} fallback={<Icon name={t().note ? "memory" : ICON[t().kind]} size={14} />}>
          <span class="spin" />
        </Show>
        <span class="tool-verb" classList={{ shimmer: running() }}>
          {t().note
            ? running() ? tr("메모리에 쓰는 중") : cut() ? tr("메모리") : tr("메모리에 저장함")
            : props.halt === "search"
              ? tr("검색함") // stopped with nothing found: it searched, it didn't find
              : t().kind === "bash" || t().kind === "browser"
              ? ((d) => (running() ? d.now : d.label))(browser() ?? describeCommand(t().target ?? ""))
              : tr(VERB[t().kind][running() ? 0 : 1])}
        </span>
        <span class="tool-target" classList={{ cmd: !t().note && (t().kind === "bash" || t().kind === "test") }}>{what()}</span>
        {/* one trailing column on every row: the time (on hover), the counts, or 중단됨 end at the same edge */}
        <span class="tool-end">
          <Switch>
            <Match when={props.halt}><span class="tool-stopped">{tr("멈춤|tool")}</span></Match>
            <Match when={cut()}><span class="tool-stopped">{tr("중단됨")}</span></Match>
            <Match when={took() >= 1000}>
              <span class="tool-time">{t().endedAt ? short(took()) : tr("{d}째", { d: short(took()) })}</span>
            </Match>
          </Switch>
          {/* after the time (shown on hover), so 실패 keeps the row's end like 멈춤 and 중단됨 */}
          <Show when={t().ok === false && !props.halt}><span class="tool-fail">{tr("실패")}</span></Show>
          <Show when={t().add || t().del}>
            <span class="tool-stat"><span class="add">+{t().add ?? 0}</span><Show when={t().del}> <span class="del">−{t().del}</span></Show></span>
          </Show>
        </span>
        <Icon name="chevron" size={12} class={canOpen() ? "tool-chev" : "tool-chev none"} />
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
                  <span class="exit" classList={{ bad: s().ok === false && !props.halt, cut: !!s().stopped || !!props.halt }}>
                    {props.halt ? tr("멈춤|tool") : s().stopped ? tr("중단됨") : s().ok === false ? tr("실패") : tr("완료")} · {long((s().endedAt ?? 0) - s().startedAt)}
                  </span>
                </Show>
              </>
            )}
          </Show>
        </pre>
      </Fold>
    </div>
  );
}

const isPause = (e: Entry) => e.kind === "note" && e.text === "일시정지";

/**
 * A pause the task has come back from: "over" once it left paused (it isn't paused now, or paused
 * again later), and how long it lasted when the task records when it left: the next message or work
 * after the note, or the time it was resumed. undefined while this is the pause it is in.
 */
export function pauseSpan(task: Pick<Task, "entries" | "status" | "resumedAt">, id: string): { over: boolean; ms?: number } | undefined {
  const es = task.entries;
  const i = es.findIndex((x) => x.id === id);
  if (i < 0) return undefined;
  const at = es[i].at;
  const later = es.slice(i + 1);
  const again = later.find(isPause);
  const over = task.status !== "paused" || !!again;
  if (!over) return undefined;
  const ends = [
    later.find((x) => x.kind !== "note")?.at,
    task.resumedAt !== undefined && task.resumedAt >= at && (!again || task.resumedAt <= again.at) ? task.resumedAt : undefined,
  ].filter((x): x is number => x !== undefined && (!again || x <= again.at));
  return { over, ms: ends.length ? Math.max(0, Math.min(...ends) - at) : undefined };
}

/** what a note is about, as its icon: 버림, 병합, 메모리, 모델 ... */
function noteIcon(text: string): string {
  if (/^변경(을)? 버(림|렸어요)$/.test(text)) return "trash";
  if (/ 병합|에 이미 반영됨|합쳤어요|합쳐져서|들어가서/.test(text)) return "merge";
  if (/^워크트리 정리 · |^작업 폴더를 정리/.test(text)) return "pr";
  if (/^(기억함|메모리에? 저장) · /.test(text)) return "memory";
  if (text.startsWith("모델")) return "refresh";
  if (text.startsWith("검색 멈춤")) return "search";
  if (text.startsWith("기다림 멈춤")) return "clock";
  return "dot";
}

/** the shared paused glyph (a ring with pause bars), for a pause in the thread */
const PAUSED = { id: "", status: "paused" } as Task;

function EntryView(props: { e: Entry; task: Task }) {
  // read through props: a row kept in place can be handed another line
  const as = <K extends Entry["kind"]>(k: K) => (props.e.kind === k ? (props.e as Extract<Entry, { kind: K }>) : undefined);
  return (
    <Switch>
      <Match when={as("user")}>{(x) => <UserMsg text={x().text} at={x().at} from={assigner(props.task)} />}</Match>
      <Match when={as("text")}>{(x) => <Markdown class="msg-text" text={x().text} />}</Match>
      <Match when={as("turn")}>
        {(x) => (
          <Show when={x().usage} fallback={<div class="turn-sep">{tr("{d} 동안 작업", { d: long(x().ms) })}</div>}>
            {(u) => <UsageLine u={u()} lead={x().ms ? tr("{d} 동안 작업", { d: long(x().ms) }) : undefined} />}
          </Show>
        )}
      </Match>
      {/* a pause it has come back from: history, with how long it stayed paused */}
      <Match when={isPause(props.e) && as("note")}>
        {(x) => {
          const span = () => pauseSpan(props.task, x().id);
          return (
            <div class="note pause-note" classList={{ past: !!span() }}>
              <Glyph t={PAUSED} class="note-glyph" />
              <span>
                {span()?.ms !== undefined
                  ? tr("일시정지 · {d} 뒤 다시 시작", { d: short(span()!.ms!) })
                  : span()
                    ? tr("일시정지 · 다시 시작함")
                    : noteText(x().text)}
              </span>
            </div>
          );
        }}
      </Match>
      <Match when={as("note")}>
        {(x) => (
          <div class="note">
            <Icon name={noteIcon(x().text)} size={14} />
            <span>{noteText(x().text)}</span>
          </div>
        )}
      </Match>
      <Match when={as("error")}>
        {(x) => (
          <Show
            when={props.task.status === "failed" && props.task.entries[lastAt(props.task.entries, (y) => y.kind === "error")]?.id === x().id}
            fallback={
              // tried again since: what went wrong then is history, not the state now
              <div class="note err-past" title={x().text}>
                <Icon name="alert" size={13} />
                <span>{tr("이전 시도 실패 · {text}", { text: x().text })}</span>
              </div>
            }
          >
            <div class="err-line">
              <Icon name="alert" size={14} />
              <span>{x().text}</span>
            </div>
          </Show>
        )}
      </Match>
      <Match when={as("spawn")}>
        {(x) => {
          const kids = () => x().childIds.map((id) => taskById(id)).filter(Boolean);
          // how they stand, counted by state: "1개 일시정지 · 1개 완료" (a discarded one is 버림, never 완료)
          const tally = () =>
            [
              ...(["running", "waiting", "failed", "queued", "paused", "done"] as const).map((st) => [tr(statusLabel[st]), kids().filter((k) => k!.status === st && !discarded(k!)).length] as const),
              [tr("버림"), kids().filter((k) => discarded(k!)).length] as const,
            ]
              .filter(([, n]) => n)
              .map(([word, n]) => tr("{n}개 {state}", { n, state: word.toLowerCase() }))
              .join(" · ");
          return (
            <div class="sub-group">
              <div class="sub-head">
                <Icon name="branch" size={13} />
                <b>{tr("서브에이전트 {n}개", { n: x().childIds.length })}</b>
                <span>{tally()}</span>
              </div>
              <For each={x().childIds}>{(id) => <ForkCard id={id} compact />}</For>
            </div>
          );
        }}
      </Match>
      <Match when={as("handoff")}>
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

/** a finished task ends on a line saying how long it worked (in review or merged alike) */
const hasEnd = (t: Task) => t.status === "done" && !!jobCost(t).ms;

/** The line a finished task ends on: "19분 동안 작업", what it used on hover. */
function JobEndLine(props: { t: Task }) {
  const c = () => jobCost(props.t);
  return (
    <div class="job-cost" title={costDetail(c()) || undefined}>
      {tr("{d} 동안 작업", { d: short(c().ms) })}
    </div>
  );
}

export function Transcript(props: { task: Task; agentId: string; footer?: JSX.Element }) {
  let scroller!: HTMLDivElement;
  // a failed task's error is said once, by the card under the thread with 다시 시도: its last
  // error line here would only repeat it
  // the same for a paused one: the bar above the input says 일시정지 with 다시 시작, so its note goes
  const shownEntries = createMemo(() => {
    const es = props.task.entries;
    if (props.task.status === "paused" && !discarded(props.task)) {
      const at = lastAt(es, (e) => e.kind === "note" && e.text === "일시정지");
      return at < 0 ? es : [...es.slice(0, at), ...es.slice(at + 1)];
    }
    if (props.task.status !== "failed" || !props.task.error) return es;
    const at = es.map((e) => e.kind).lastIndexOf("error");
    const e = es[at];
    return e?.kind === "error" && e.text === props.task.error ? [...es.slice(0, at), ...es.slice(at + 1)] : es;
  });
  const list = createMemo<Turn[]>((prev) => keep(prev, turns(shownEntries()), sameTurn));
  /** nothing was recorded but its summary: that is the answer the thread ends on */
  const summaryOnly = () => !props.task.entries.some((e) => e.kind !== "user") && props.task.status === "done" && !!props.task.summary;
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
        <Index each={list()}>
          {(t, i) => (
            <TurnView
              turn={t()}
              task={props.task}
              open={!settled()}
              last={i === list().length - 1}
              end={i === list().length - 1 && !summaryOnly() && hasEnd(props.task)}
            />
          )}
        </Index>
        <Show when={summaryOnly()}>
          <Markdown class="msg-text" text={props.task.summary!} />
          <Show when={hasEnd(props.task)}>
            <div class="reply-foot end newest"><JobEndLine t={props.task} /></div>
          </Show>
        </Show>
        <Show when={liveText()}>
          <Markdown class="msg-text" text={liveText()} />
        </Show>
        <Show when={props.task.status === "queued"}>
          <div class="live-line muted queued-line">
            <Icon name="clock" size={14} />
            <span>{queuePos() <= 1 ? tr("다음 차례") : tr("앞에 작업 {n}개", { n: queuePos() - 1 })}</span>
            <span class="spacer" />
            <button class="btn sm" onClick={() => void startTask(props.task.id)}>{tr("지금 시작")}</button>
          </div>
        </Show>
        {/* waiting on its subagents: their card above already shows that */}
        <Show when={working() && !liveText() && !toolRunning() && !kidsOf(props.task.id).some((k) => k.status === "running" || k.status === "queued")}>
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
