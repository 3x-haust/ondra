// Main: the conversation with the one who splits your requests into jobs.
import { RoutineCard } from "./Routines";
import { feedbackCommands } from "../ui/Feedback";
import { nowText, stepParts, type StepKind } from "../engine/describe";
import { skillAsk } from "../ui/Aside";
import { holdScroll, keepBottom, toBottomSent } from "../ui/stick";
import { AnsweredCard, answerOf, DecisionCard } from "../ui/DecisionCard";
// Every reply carries one row for each job it started or relayed to, kept up to
// date; the jobs themselves live in the sidebar, grouped by what they need from you.
import { chooseAccount, createTask, finishTask, NO_ACCOUNT } from "../engine/tasks";
import { createEffect, createMemo, createResource, createRoot, createSignal, onCleanup, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { accountById, accountsIn, addProject, allDecisions, allTasks, decisionFor, projectById, projectsShown, tasksShown, repoHome, setState, spaceById, kidsOf, lineHead, state, taskById, updateAccount } from "../state/store";
import { ProjectBadge } from "../ui/ProjectBadge";
import { switchSpace } from "../state/workspace";
import { discarded } from "../state/progress";
import { fileSrc, fsFiles, pickFolder } from "../lib/native";
import { jobShot, resultOfTask } from "../engine/results";
import { expand, tilde } from "../engine/rpc";
import type { CaptainMessage, Decision, Status, Task } from "../state/types";
import { closePane, focusId, focusPane, hoverTask, inPane, jumpMsg, layout, newTaskOpen, openPanel, openTask, paneCount, paneDraft, paneState, panelOpen, setHoverTask, setJumpMsg, setNewTaskOpen, setPaneDraft, setPaneView, setView, splitPane, toast, togglePanel, view, type Draft, type View, previewFile } from "../state/ui";
import { usePane, usePaneFocused, useView } from "../state/panes";
import { chatKey, editMain, inChat, mainDraft, mainThought, resetMain, STEP_MARK, stopMain, throwThought, warmMain } from "../engine/captain";
import { addMemory } from "../engine/memory";
import { BtwCard, btwCommand, plusFor, skillCommands } from "../ui/Aside";
import { sendSide } from "../engine/aside";
import { allSessions, continueSession } from "../engine/importer";
import { engine } from "../engine/rpc";
import { agoIn, compact, endedAt, midTrim, now, short, soon, statusLabel, titleOf } from "../ui/bits";
import { BlockView } from "../ui/Blocks";
import { Composer, hasDraft } from "../ui/Composer";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { ModelPicker, PermissionPicker, usePop } from "../ui/ModelPicker";
import { effortFor, setModelEffort } from "../engine/models";
import { notesPath, notesVersion, readNotes } from "../engine/notes";
import { MsgActions, UserMsg } from "../ui/MsgActions";
import { StatusLine, UsageLine } from "../ui/Usage";
import { ComputerPicker, HostModel, HostStatus, chosenComputer, hostAccount, type Place } from "../ui/ComputerPicker";

/** the model picked for work on another Mac, when that account there has it */
const hostPick = (p: Place) => {
  const a = hostAccount(p, state.space);
  return p.model && a?.models.includes(p.model) ? { model: p.model, thinking: p.thinking } : p.thinking ? { thinking: p.thinking } : {};
};
import { noModifiers, shortcutHint, withHint } from "../lib/shortcuts";
import { refreshSuggestions, suggestionsFor, suggestLoading } from "../engine/suggest";
import { Glyph, GlyphMark, SidebarToggle, stateMeta, type GlyphKind } from "./Sidebar";
import { openAddAccount } from "./Settings";
import { t, t as tr } from "../i18n";
import { PaneControls } from "./PaneControls";
import { taskContextMenu } from "../ui/taskMenu";

/** "{task}에 전달했어요" with the task name in bold */
function withName(key: string, name: string) {
  const [a, b = ""] = t(key).split("{task}");
  return (
    <>
      {a}
      <b>{name}</b>
      {b}
    </>
  );
}

/** Folder for the next request; "" = let main decide. */

/** Put text in the main input as if typed (the user still presses send). */
function fill(text: string) {
  const el = inPane<HTMLTextAreaElement>("#main-input");
  if (!el) return;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(text.length, text.length);
}

// ───────────── pieces

/** A reply main wrote on its own (a job ended, a project reported back), not to something the user said. */
const onItsOwn = (m: CaptainMessage) => !!(m.after || m.up);
/** the jobs a reply handed work to (started or relayed to), once each, in order */
function handed(m: CaptainMessage): { taskId: string; relayed: boolean }[] {
  const out: { taskId: string; relayed: boolean }[] = [];
  for (const r of m.routes ?? []) {
    if ((r.kind !== "new" && r.kind !== "append") || out.some((x) => x.taskId === r.taskId)) continue;
    out.push({ taskId: r.taskId, relayed: r.kind === "append" });
  }
  return out;
}
/** something of this reply shows in the chat (main reacting to a job's end may add nothing: the job's row says it) */
const shows = (m: CaptainMessage) =>
  !!m.error || !!m.reply?.trim() || (m.routes ?? []).some((r) => r.kind === "new" || r.kind === "append" || r.kind === "stop" || r.kind === "remember" || r.kind === "routine" || (r.kind === "answer" && (!!r.text.trim() || r.blocks.length > 0)));

/** What a job is on while it runs: what it last said it is doing, else its to-do step, else its status line. */
function doingNow(x: Task): string {
  const s = (x.intent || x.plan.find((p) => p.state === "now")?.text || nowText(x.now) || "").trim();
  return s && s !== x.title ? s : "";
}
const oneLine = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * One job main handed work to, as one quiet line that keeps up with it: its step while it runs,
 * its own one-line result (and the screenshot it left) once done, or what it needs. A click opens
 * its result, or the job while there is none; with ⌥/⌘ beside this pane. `live`: the last row
 * for this job in the chat (an earlier one only names it).
 */
/**
 * What a finished job ended on, as it said it: the words and result blocks its last turn closed with
 * (after its steps), else its result line. A project's chat shows it under the job's row, as is.
 */
export function closingOf(t: Task): { text: string; blocks: Extract<Task["entries"][number], { kind: "block" }>["block"][] } {
  const e = t.entries;
  let end = e.length;
  while (end > 0 && (e[end - 1].kind === "note" || e[end - 1].kind === "turn")) end--;
  let i = end;
  while (i > 0 && (e[i - 1].kind === "text" || e[i - 1].kind === "block")) i--;
  const tail = e.slice(i, end);
  const text = tail.flatMap((x) => (x.kind === "text" && x.text.trim() ? [x.text.trim()] : [])).join("\n\n");
  const blocks = tail.flatMap((x) => (x.kind === "block" ? [x.block] : []));
  return { text: text || (blocks.length ? "" : (t.result ?? "").trim()), blocks };
}

function JobRow(props: { taskId: string; relayed: boolean; live: boolean; active?: boolean; full?: boolean }) {
  const task = () => taskById(props.taskId);
  return (
    <Show when={task()}>
      {(x) => {
        const meta = () => stateMeta(x());
        const over = () => x().status === "done" && !discarded(x());
        const result = () => (over() ? resultOfTask(x().id) : undefined);
        const shot = () => (props.live && over() && !props.full ? jobShot(x()) : undefined);
        /** the word on the right: only when it needs you, or isn't moving */
        const word = () => (meta().tone === "bad" || meta().tone === "ask" || meta().tone === "review" || meta().tone === "idle" ? meta().text : "");
        const detail = () => {
          if (!props.live) return "";
          const t = x();
          if (t.status === "failed") return oneLine(t.error).slice(0, 200);
          if (t.status === "waiting") return oneLine(decisionFor(t.id)?.question ?? nowText(t.now));
          if (t.status === "done") return discarded(t) ? "" : oneLine(t.summary);
          if (t.status === "running") return oneLine(doingNow(t));
          return "";
        };
        /** relayed to while it works: said before its step ("전달함 · 버튼 확인"); once it is over, its result alone */
        const line = () => {
          const sent = props.relayed && (!props.live || meta().tone === "live" || x().status === "queued");
          return [sent ? t("전달함|row") : "", detail()].filter(Boolean).join(" · ");
        };
        const open = (e: MouseEvent) => {
          const r = result();
          const v: View = r ? { name: "results", id: r.id } : { name: "task", id: x().id };
          if (e.altKey || e.metaKey) splitPane("right", { view: v });
          else setView(v);
        };
        const row = (
          <button
            class={`job-row tone-${meta().tone}`}
            classList={{ active: props.active, past: !props.live }}
            onClick={open}
            onMouseEnter={() => setHoverTask(x().id)}
            onMouseLeave={() => setHoverTask(null)}
            title={props.relayed ? `${t("{task}에 전달했어요", { task: x().title })}` : x().title}
          >
            <Glyph t={x()} />
            <span class="job-title">{x().title}</span>
            <Show when={line()}>
              <span class="job-detail">{line()}</span>
            </Show>
            <Show when={props.live && word()}>
              <span class="job-word">{word()}</span>
            </Show>
            <Show when={shot()}>{(p) => <img class="job-shot" src={fileSrc(p())} alt="" loading="lazy" />}</Show>
          </button>
        );
        const closing = createMemo(() => (props.full && props.live && over() ? closingOf(x()) : undefined));
        return (
          <>
            {row}
            <Show when={closing()?.text || closing()?.blocks.length ? closing() : undefined}>
              {(c) => (
                <div class="job-result">
                  <Show when={c().text}><Markdown class="msg-text" text={c().text} /></Show>
                  <Show when={c().blocks.length}>
                    <div class="blocks"><For each={c().blocks}>{(b) => <BlockView block={b} task={x()} />}</For></div>
                  </Show>
                </div>
              )}
            </Show>
          </>
        );
      }}
    </Show>
  );
}

const STEP_ICON: Record<StepKind, string> = { jobs: "list", web: "globe", read: "read", search: "search", shell: "shell" };

/** one of main's steps as a row, the way a job's tool rows say it: icon, verb, name ("읽음 SKILL.md") */
function StepRow(props: { text: string; live?: boolean; tail?: string }) {
  const p = () => stepParts(props.text);
  return (
    <span class="step-row">
      <Icon name={p().kind ? STEP_ICON[p().kind!] : "check"} size={14} />
      <span class="step-verb" classList={{ shimmer: !!props.live }}>{p().verb}</span>
      <Show when={p().name}><span class="step-name" classList={{ cmd: p().kind === "shell" }}>{p().name}</span></Show>
      <Show when={props.tail}><span class="step-tail">· {props.tail}</span></Show>
    </span>
  );
}

/** what main's steps did, counted per kind, as a job's work line says it ("살펴봄 · 명령 2개 실행함") */
function stepsSummary(steps: string[]): string {
  const kinds = steps.map((s) => stepParts(s).kind);
  const runs = kinds.filter((k) => k === "shell").length;
  return [...(kinds.some((k) => k !== "shell") ? [t("살펴봄")] : []), ...(runs ? [t("명령 {n}개 실행함", { n: runs })] : [])].join(" · ");
}

/** the opened line: reasoning dim, each step one row, in the order they came */
function StepLines(props: { lines: string[] }) {
  return (
    <For each={props.lines}>
      {(line) => (
        <Show when={line.startsWith(STEP_MARK)} fallback={<p class="reply-thought-line">{line.replace(/^\*\*(.+)\*\*$/, "$1")}</p>}>
          <StepRow text={line.slice(STEP_MARK.length)} />
        </Show>
      )}
    </For>
  );
}

/**
 * While main answers: "생각하는 중 · 12초", or the step it is on ("읽는 중 SKILL.md · 12초").
 * Opened, what it reasons and the steps it took stream under it in order; closed, only the line.
 */
function Thinking(props: { m: CaptainMessage }) {
  const thought = () => mainThought(chatKey(props.m.space, props.m.project)).trim();
  const steps = () => props.m.steps ?? [];
  const has = () => !!thought() || steps().length > 0;
  const time = () => short(soon() - props.m.at);
  const [open, setOpen] = createSignal(false);
  let box: HTMLDivElement | undefined;
  // it follows the newest line while the reader is at the end of it
  let atEnd = true;
  createEffect(on([thought, () => steps().length], () => open() && box && atEnd && queueMicrotask(() => box && (box.scrollTop = box.scrollHeight))));
  // the steps are in the reasoning where they happened; before any reasoning comes, the steps alone
  const lines = () => (thought() ? thought().split("\n").map((l) => l.trim()).filter(Boolean) : steps().map((s) => STEP_MARK + s));
  return (
    <div class="reply-think" classList={{ open: open() && has() }}>
      <button type="button" class="reply-thinking" disabled={!has()} aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Show when={props.m.step} fallback={<span class="shimmer">{t("생각하는 중")} · {time()}</span>}>
          {(s) => <StepRow text={s()} live tail={time()} />}
        </Show>
        <Show when={has()}>
          <Icon name="chevron" size={12} class="reply-think-chev" />
        </Show>
      </button>
      <Show when={open() && has()}>
        <div
          class="reply-thought"
          ref={(el) => ((box = el), queueMicrotask(() => (el.scrollTop = el.scrollHeight)))}
          onScroll={(e) => (atEnd = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}
        >
          <StepLines lines={lines()} />
        </div>
      </Show>
    </div>
  );
}

/** an answered reply that looked things up: one quiet line above it ("살펴봄 · 12초"), opened, each step */
function Worked(props: { m: CaptainMessage }) {
  const [open, setOpen] = createSignal(false);
  const steps = () => props.m.steps ?? [];
  const label = () => [stepsSummary(steps()), ...(props.m.took && props.m.took >= 1000 ? [short(props.m.took)] : [])].join(" · ");
  return (
    <div class="reply-think worked" classList={{ open: open() }}>
      <button type="button" class="reply-thinking" aria-expanded={open()} onClick={() => setOpen(!open())}>
        {label()}
        <Icon name="chevron" size={12} class="reply-think-chev" />
      </button>
      <Show when={open()}>
        <div class="reply-thought">
          <StepLines lines={steps().map((s) => STEP_MARK + s)} />
        </div>
      </Show>
    </div>
  );
}

function Reply(props: { m: CaptainMessage; retry: () => void; active?: string; lastRow: (taskId: string) => string | undefined; full?: boolean }) {
  const routes = () => props.m.routes ?? [];
  const rows = () => handed(props.m);
  const copyText = () => [props.m.reply, ...routes().map((r) => (r.kind === "answer" ? r.text : ""))].filter(Boolean).join("\n\n");
  // the first answer's text: while main writes it, as far as it has come; one Markdown for both,
  // so a board that started drawing while it was written goes on drawing when it is done
  const firstAnswer = () => routes().findIndex((r) => r.kind === "answer");
  const answerText = () => {
    if (props.m.pending) return mainDraft(chatKey(props.m.space, props.m.project), props.m.id);
    if (props.m.error) return "";
    const r = routes()[firstAnswer()];
    return r?.kind === "answer" ? r.text : "";
  };
  return (
    <div class="reply" data-mid={props.m.id} classList={{ linked: rows().some((r) => r.taskId === hoverTask() || r.taskId === props.active) }}>
      <Show when={props.m.up ? projectById(props.m.up) : undefined}>
        {(p) => (
          <button class="reply-from" onClick={() => setView({ name: "main", project: p().id })}>
            <Icon name="folder" size={12} />
            {t("{name}에서", { name: p().name })}
          </button>
        )}
      </Show>
      <div class="reply-body">
        <Switch>
          <Match when={props.m.pending}>
            <Thinking m={props.m} />
          </Match>
          <Match when={props.m.error}>
            {(err) => (
              <div class="reply-error">
                <Icon name="alert" size={14} />
                <span>{isNoAccount(err()) ? t("계정 없음|notice") : err()}</span>
                {/* no account here: trying again can't help, adding one can */}
                <Show
                  when={isNoAccount(err())}
                  fallback={<button class="retry" onClick={props.retry}><Icon name="refresh" size={14} />{t("다시 시도")}</button>}
                >
                  <button class="retry" onClick={() => addAccount()}><Icon name="plus" size={14} />{t("계정 추가")}</button>
                </Show>
              </div>
            )}
          </Match>
          <Match when={true}>
            {/* what it looked up while answering stays as one quiet line above the answer */}
            <Show when={props.m.steps?.length}><Worked m={props.m} /></Show>
            <Show when={props.m.reply}><p class="reply-line">{props.m.reply}</p></Show>
            <Show when={!props.m.reply && !routes().length}>
              <div class="reply-error">
                <Icon name="alert" size={14} />
                <span>{t("응답을 받지 못했어요")}</span>
                <button class="retry" onClick={props.retry}><Icon name="refresh" size={14} />{t("다시 시도")}</button>
              </div>
            </Show>
          </Match>
        </Switch>
        <Show when={answerText()}><Markdown class="msg-text" text={answerText()} /></Show>
        <Show when={!props.m.pending && !props.m.error}>
            <For each={routes()}>
              {(r) => (
                <Switch>
                  <Match when={r.kind === "answer" && r}>
                    {(a) => (
                      <>
                        <Show when={a().text && a() !== routes()[firstAnswer()]}><Markdown class="msg-text" text={a().text} /></Show>
                        <Show when={a().blocks.length}><div class="blocks"><For each={a().blocks}>{(b) => <BlockView block={b} />}</For></div></Show>
                      </>
                    )}
                  </Match>
                  <Match when={r.kind === "stop" && r}>
                    {(a) => (
                      <button class="reply-note" onClick={() => openTask(a().taskId)}>
                        <Icon name="pause" size={14} />
                        <span>{withName("{task} 멈춤", taskById(a().taskId)?.title ?? t("작업"))}</span>
                      </button>
                    )}
                  </Match>
                  <Match when={r.kind === "routine" && r}>
                    {(a) => <RoutineCard id={a().routineId} />}
                  </Match>
                  <Match when={r.kind === "remember" && r}>
                    {(a) => (
                      <div class="reply-note">
                        <Icon name="memory" size={14} />
                        <span>{t("메모리에 저장|note")} · {state.memory.find((x) => x.id === a().memoryId)?.text ?? ""}</span>
                      </div>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
            {/* the jobs it started or relayed to: one row each, kept up to date */}
            <Show when={rows().length}>
              <div class="job-rows">
                <For each={rows()}>{(r) => <JobRow taskId={r.taskId} relayed={r.relayed} live={props.lastRow(r.taskId) === props.m.id} active={props.active === r.taskId} full={props.full} />}</For>
              </div>
            </Show>
        </Show>
        <Show when={!props.m.pending && !props.m.error && (copyText() || props.m.usage)}>
          <div class="reply-foot">
            <Show when={copyText()}><MsgActions text={copyText()} onRetry={props.retry} /></Show>
            <Show when={props.m.usage}>{(u) => <UsageLine u={u()} />}</Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** Empty chat: the input, and a few starts under it. The header already says where you are. */
/** this space's accounts only: jobs here never run on the other space's */
const loggedIn = () => accountsIn(state.space).some((a) => a.providers.length);

const isNoAccount = (err?: string) => !!err && (err === NO_ACCOUNT || err === t(NO_ACCOUNT));

/** Settings › 계정 with 계정 추가 already started for this workspace */
const addAccount = () => openAddAccount(state.space);

/** The app can't start, or this workspace has no account: said above the input until it is fixed.
 *  `quiet`: a no-account card in the chat already says it with its button, so the notice steps aside. */
function SetupNotice(props: { quiet?: boolean }) {
  const none = () => !accountsIn(state.space).length;
  return (
    <>
      <Show when={engine.checked && !engine.ready}>
        <div class="notice bad"><Icon name="alert" size={16} /><div class="notice-body"><b>{t("앱을 시작하지 못했어요")}</b><p>{t("다시 설치해 주세요.")}</p></div></div>
      </Show>
      <Show when={engine.checked && engine.ready && !loggedIn() && !(none() && props.quiet)}>
        <div class="notice">
          <Icon name="key" size={16} />
          {/* no account at all: add one; an account not signed in: its row in Settings */}
          <div class="notice-body"><b>{none() ? t("계정 없음|notice") : t("로그인 필요")}</b></div>
          <Show when={none()} fallback={<button class="btn sm" onClick={() => setView({ name: "settings", tab: "accounts" })}>{t("로그인")}</button>}>
            <button class="btn sm" onClick={addAccount}>{t("계정 추가")}</button>
          </Show>
        </div>
      </Show>
    </>
  );
}

function Hero(props: { project?: string; composer: JSX.Element; asks: Decision[] }) {
  return (
    <div class="page hero-page">
      <div class="hero">
        <SetupNotice />
        <AskDock list={props.asks} />
        {props.composer}
        <Picks project={props.project} wait />
      </div>
    </div>
  );
}

/** What the jobs of this chat are asking, attached above the input: answered here, no need to open the job,
 *  and the newest messages stay in sight above it. The first takes the number keys. */
function AskDock(props: { list: Decision[] }) {
  return (
    <Show when={props.list.length}>
      <div class="ask-dock">
        <For each={props.list}>{(d, i) => <DecisionCard d={d} dock keys={i() === 0} />}</For>
      </div>
    </Show>
  );
}

/** A few starts for an empty chat: suggestions from recent work, and sessions from other apps to carry on. */
function Picks(props: { project?: string; wait?: boolean }) {
  const key = () => chatKey(state.space, props.project);
  createEffect(on(key, () => void refreshSuggestions(state.space, props.project)));
  const picks = () => suggestionsFor(key());
  const imported = () => new Set(state.tasks.map((t) => t.origin?.path).filter(Boolean));
  // only work from this chat's folder: the project's repo (and its worktrees), or the space's folder
  const root = () => {
    const f = props.project ? projectById(props.project)?.folder : spaceById(state.space).folder;
    return f ? expand(f).replace(/\/+$/, "") : "";
  };
  // folders that belong to the other space (its folder and its projects')
  const elsewhere = () =>
    [...state.spaces.filter((s) => s.id !== state.space).map((s) => s.folder), ...(state.projects ?? []).filter((p) => p.space !== state.space).map((p) => p.folder)]
      .filter((f) => f && f !== "~")
      .map((f) => expand(f).replace(/\/+$/, ""));
  const inHere = (cwd: string) => {
    const r = root();
    const c0 = expand(cwd || "").replace(/\/+$/, "");
    if (elsewhere().some((f) => c0 === f || c0.startsWith(`${f}/`))) return false;
    if (!r || r === expand("~").replace(/\/+$/, "")) return !props.project;
    const c = repoHome(expand(cwd || "")).replace(/\/+$/, "");
    return c === r || c.startsWith(`${r}/`);
  };
  const sessions = () => allSessions().filter((s) => !imported().has(s.path) && inHere(s.cwd)).slice(0, 3);
  return (
        <div class="hero-picks">
          <Show when={props.wait && suggestLoading() === key() && !picks().length}>
            <div class="hero-pick wait"><span class="spin xs" /><span>{t("최근 작업 보는 중")}</span></div>
          </Show>
          <For each={picks().slice(0, 3)}>
            {(s) => (
              <button class="hero-pick" onClick={() => fill(s.text)} title={s.why || undefined}>
                <Icon name="arrow" size={14} class="hero-pick-ic" />
                <span class="hero-pick-text">{s.text}</span>
              </button>
            )}
          </For>
          <For each={sessions()}>
            {(s) => (
              <button
                class="hero-pick"
                title={t("{app}에서 이어서 하기", { app: s.sourceName })}
                onClick={async () => {
                  try {
                    openTask(await continueSession(s, state.space, s.sourceName));
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e), "bad");
                  }
                }}
              >
                <Icon name="history" size={14} class="hero-pick-ic" />
                <span class="hero-pick-text">{s.title || t("제목 없음")}</span>
                <span class="hero-pick-meta">{s.sourceName} · {agoIn(s.updatedAt)}</span>
              </button>
            )}
          </For>
        </div>
  );
}

/** The model chip for the account a chat runs on: company and personal keep their own model. */
/** `rest`: the level shown when none was picked (main itself runs at 낮음; new work at 높음) */
function AccountModel(props: { accountId: string; up?: boolean; rest?: string }) {
  return (
    <ModelPicker
      up={props.up}
      accountId={props.accountId}
      model={accountById(props.accountId)?.model ?? ""}
      thinking={effortFor(props.accountId) || props.rest || ""}
      effortOf={(m) => effortFor(props.accountId, m) || props.rest || ""}
      onChange={(m, t) => updateAccount(props.accountId, (x) => setModelEffort(x, m, t))}
    />
  );
}

// ───────────── new task
/** Every 새 작업 (sidebar, ⌘N, canvas, board, a project's menu): a blank task to write, in a project picked here. Any move elsewhere ends it. */
// Each pane has its own (state/ui.ts): any move elsewhere in that pane ends it. Another workspace
// ends it too while the center is one pane (split panes come back with the workspace).
createRoot(() => createEffect(on(() => state.space, () => paneCount() < 2 && setNewTaskOpen(null), { defer: true })));
/** what a pane's new task is typed into (each pane keeps its own text) */
const newKey = (pane: string) => `new:${state.space}:${pane}`;
/** the project each pane's unsent new task was written for: it comes back with its text */
const draftProject = new Map<string, string | undefined>();
createRoot(() => createEffect(() => {
  for (const [id, p] of Object.entries(layout().panes)) if (p.draft) draftProject.set(newKey(id), p.draft.project);
}));
/** × and Esc: close it and go back to where it was opened from (a pane opened for it closes) */
function closeNewTask(pane = focusId()) {
  const p = paneState(pane);
  if (p?.fresh && paneCount() > 1) return void closePane(pane);
  const from = p?.draft?.from;
  setPaneDraft(pane, null);
  if (from) setPaneView(pane, from);
}
/** Open the new-task screen. `preset` picks its project (a project's menu, the canvas lane); without
 *  it the project in view carries over. A project from the other workspace switches to it first. */
export function startNewTask(preset?: string) {
  const v = view();
  const pane = focusId();
  const p = preset ? projectById(preset) : undefined;
  if (p && p.space !== state.space) switchSpace(p.space, { name: "main" });
  // an unsent draft keeps the project it was written for; else the project in view carries over
  const kept = !preset && hasDraft(newKey(pane)) && draftProject.has(newKey(pane));
  const project = preset ?? (kept ? draftProject.get(newKey(pane)) : v.name === "main" ? v.project : v.name === "task" ? taskById(v.id)?.project : undefined);
  // reopened over itself: keep where it first came from
  const from = newTaskOpen()?.from ?? v;
  // in the focused pane, even when another pane shows Main
  setPaneView(focusId(), { name: "main" });
  setNewTaskOpen({ project: project && projectById(project)?.space === state.space ? project : undefined, from });
  setTimeout(() => inPane<HTMLTextAreaElement>("#new-task-input")?.focus(), 30);
}

/** Which project a new task runs in: a chip and its menu, like the permission one. */
function ProjectPick(props: { value?: string; onChange: (id?: string) => void }) {
  const [open, setOpen] = usePop();
  const cur = () => (props.value ? projectById(props.value) : undefined);
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class="chip proj-chip" classList={{ on: open() }} onClick={() => setOpen(!open())} title={cur()?.folder ? tilde(cur()!.folder) : t("프로젝트|one")}>
        <Show when={cur()} fallback={<Icon name="folder" size={14} />}>{(c) => <ProjectBadge name={c().name} />}</Show>
        <span class="proj-chip-name">{cur()?.name ?? t("프로젝트 없음")}</span>
        <Icon name="down" size={12} class="muted" />
      </button>
      <Show when={open()}>
        <div class="pop proj-pop" role="menu">
          <div class="pop-label">{t("프로젝트")}</div>
          <For each={projectsShown(state.space)}>
            {(p) => (
              <button type="button" class="pop-item" role="menuitem" onClick={() => (props.onChange(p.id), setOpen(false))}>
                <ProjectBadge name={p.name} />
                <span class="pop-item-main">{p.name}</span>
                <span class="pop-item-sub">{midTrim(tilde(p.folder), 24)}</span>
                <span class="pop-check">{p.id === props.value && <Icon name="check" size={14} />}</span>
              </button>
            )}
          </For>
          <div class="pop-sep" />
          <button type="button" class="pop-item" role="menuitem" onClick={() => (props.onChange(undefined), setOpen(false))}>
            <Icon name="folder" size={14} class="muted" />
            <span class="pop-item-main">{t("프로젝트 없음")}</span>
            <span class="pop-check">{!props.value && <Icon name="check" size={14} />}</span>
          </button>
          <div class="pop-sep" />
          {/* the same as Main's + menu: pick a folder, it becomes a project and this task's */}
          <button
            type="button"
            class="pop-item"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              const dir = await pickFolder(t("프로젝트 폴더"));
              if (dir) props.onChange(addProject(state.space, dir));
            }}
          >
            <Icon name="plus" size={14} class="muted" />
            <span class="pop-item-main">{t("프로젝트 추가")}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

function NewTask(props: { project?: string; onProject: (id?: string) => void; pane: string }) {
  const p = () => (props.project ? projectById(props.project) : undefined);
  const account = () => chooseAccount(state.space, p()?.name ?? "");
  const computer = () => (p() ? (p()!.host ? { host: p()!.host! } : undefined) : chosenComputer());
  const send = (text: string) => {
    const id = createTask({
      space: state.space,
      title: titleOf(text),
      topic: p()?.name ?? "",
      ask: text,
      cwd: p()?.folder,
      project: p()?.id,
      isolate: state.settings.isolate,
      accountId: account(),
      host: computer()?.host,
      hostSpace: computer()?.space,
      hostAccount: computer() ? hostAccount(computer()!, state.space)?.id : undefined,
      ...(computer() ? hostPick(computer()!) : {}),
    });
    setPaneDraft(props.pane, null);
    focusPane(props.pane);
    openTask(id);
  };
  return (
    <div class="page hero-page new-task-page">
      <div class="hero">
        <Composer
          id="new-task-input"
          draftKey={newKey(props.pane)}
          big
          popDown
          autofocus
          placeholder={t("작업 내용")}
          files={() => fsFiles(expand(p()?.folder || spaceById(state.space).folder || "~"))}
          onSend={send}
          status={
            <Show
              when={computer()}
              fallback={<StatusLine lead={<ComputerPicker fixed={!!p()} />} accountId={account()} space={state.space} />}
            >
              <HostStatus place={computer()!} fixed={!!p()} />
            </Show>
          }
          left={
            <>
              <ProjectPick value={props.project} onChange={props.onProject} />
              <PermissionPicker value={state.settings.permission ?? "edits"} onChange={(x) => setState("settings", "permission", x)} />
            </>
          }
          right={<Show when={computer()} fallback={<AccountModel accountId={account()} />}>{(c) => <HostModel place={c()} />}</Show>}
        />
      </div>
    </div>
  );
}

// ───────────── main
/** Main's conversation: every message, with the jobs each reply handed work to as rows. */
export function MainView() {
  let box!: HTMLDivElement;
  const pane = usePane();
  const here = useView();
  const pid = pane?.id ?? focusId();
  const focused = usePaneFocused();
  const drafting = () => paneDraft(pid);
  const setDrafting = (d: Draft | null) => setPaneDraft(pid, d);
  const openRoot = () => {
    const v = view();
    let t = v.name === "task" ? taskById(v.id) : undefined;
    while (t?.parentId) t = taskById(t.parentId);
    return t?.id;
  };
  const project = () => {
    const v = here();
    const p = v.name === "main" ? projectById(v.project) : undefined;
    return p && p.space === state.space ? p : undefined;
  };
  // a report opened from the results view: scroll to it once it is drawn
  createEffect(() => {
    const id = jumpMsg();
    if (!id) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = box?.querySelector(`[data-mid="${id}"]`);
        if (!el) return;
        // the chat would follow its bottom again while pictures load: it stays on the message
        holdScroll(1000, el);
        el.scrollIntoView({ block: "start" });
        setJumpMsg(undefined);
      }),
    );
  });
  const key = () => chatKey(state.space, project()?.id);
  const msgs = () => state.captain.filter((m) => inChat(m, key()));
  // the account main runs on: the space's pick, or the routed one (same rule as new jobs)
  const account = () => chooseAccount(state.space, project()?.name ?? "");
  const started = (m: CaptainMessage) =>
    (m.routes ?? []).flatMap((r) => (r.kind === "new" ? [taskById(r.taskId)].filter((t): t is Task => !!t) : []));
  // where it runs (the run location): a project's own Mac, else the one picked under the composer
  const computer = () => (project() ? (project()!.host ? { host: project()!.host! } : undefined) : chosenComputer());
  // another Mac's project has its own chat here, as this Mac's do: main (here) routes, follows up and
  // asks, and the jobs it starts go to that Mac. What's typed goes there as a job as it was typed only
  // for work picked for another Mac outside a project, or when main has no account here to run on
  // (a workspace only that Mac has).
  const mainHere = () => accountsIn(state.space).some((a) => a.providers.length > 0);
  const raw = () => (project() && mainHere() ? undefined : computer());
  const sendMain = (text: string) => {
    const p = project();
    const at = raw();
    // on another Mac: what's typed is a job there (its own Ondra takes it from there)
    if (at) return void openTask(createTask({ space: state.space, title: titleOf(text), topic: p?.name ?? "", ask: text, cwd: p?.folder, project: p?.id, accountId: account(), host: at.host, hostSpace: at.space, hostAccount: hostAccount(at, state.space)?.id, ...hostPick(at) }));
    return throwThought(text, state.space, { project: p?.id });
  };
  /** each job's last row in this chat: that one keeps up with it, earlier ones only name it */
  const lastRow = createMemo(() => {
    const at = new Map<string, string>();
    for (const m of msgs()) for (const r of handed(m)) at.set(r.taskId, m.id);
    return at;
  });
  /** ask the message before this reply again: main goes back to that point */
  const retry = (m: CaptainMessage) => {
    const list = msgs();
    const i = list.findIndex((x) => x.id === m.id);
    const ask = list.slice(0, i).reverse().find((x) => x.from === "me");
    if (ask?.text) void editMain(ask.id, ask.text);
  };
  const asks = () =>
    allDecisions().filter((d) => {
      if (d.taskId.startsWith("main:")) return d.taskId === `main:${key()}`;
      const t = taskById(d.taskId);
      return !!t && t.space === state.space && (project() ? t.project === project()!.id : true);
    });
  /** questions of this chat's tasks already answered: one quiet line each where the card was.
   *  Not in a project's chat: each job's own result shows there under its row, and the answers are in it. */
  const answered = createMemo(() => {
    const out: Answered[] = [];
    if (project()) return out;
    for (const t of tasksShown(state.space)) {
      if (t.space !== state.space || (project() && t.project !== project()!.id)) continue;
      for (const e of t.entries) {
        if (e.kind !== "user") continue;
        const a = answerOf(e.text);
        if (!a) continue;
        let x = answeredSeen.get(e.id);
        if (!x || x.a !== a.a) answeredSeen.set(e.id, (x = { id: e.id, at: e.at, taskId: t.id, ...a }));
        out.push(x);
      }
    }
    return out;
  });
  /** the conversation in order: messages, and the answered questions between them */
  const timeline = createMemo(() => {
    const list: (CaptainMessage | Answered)[] = [...msgs()];
    for (const a of answered()) {
      const i = list.findIndex((m) => m.at > a.at);
      list.splice(i < 0 ? list.length : i, 0, a);
    }
    return list;
  });
  /** a project's own chat: how its tasks stand, in the head */
  /** the project's notes, once a job has left them (read again when a job rewrites them) */
  const [hasNotes] = createResource(
    () => (project() ? [project()!.id, notesVersion()] as const : undefined),
    async ([id]) => !!(await readNotes(id)),
  );
  const projCounts = () => {
    const p = project();
    if (!p) return [];
    // the tasks the strip lists, by state; a discarded one counts as 버림, never as 완료
    const top = projectTasks(p.id);
    const kept = top.filter((x) => !discarded(x));
    return [
      ...(["waiting", "failed", "running", "queued", "paused", "done"] as Status[]).map((st) => [st, kept.filter((x) => x.status === st).length, tr(statusLabel[st])] as const),
      ["discarded", top.length - kept.length, tr("버림")] as const,
    ].filter(([, n]) => n);
  };
  const toBottom = () => queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
  createEffect(on(() => [state.space, msgs().length, msgs()[msgs().length - 1]?.pending, asks().length], toBottom));
  // what the user sends always shows: it takes the chat to the bottom and holds it there a moment
  const sent = () => msgs().filter((m) => m.from === "me").length;
  createEffect(on(sent, (n, was) => was !== undefined && n > was && queueMicrotask(() => toBottomSent(box))));
  // warm the cache as soon as a chat is open, so even the first message is cached
  createEffect(on(key, () => void warmMain(state.space, project()?.id)));

  const composer = (big: boolean) => (
    <Composer
      id="main-input"
      draftKey={`main:${key()}`}
      big={big}
      autofocus
      files={() => fsFiles(expand(spaceById(state.space).folder || "~"))}
      commands={[
        btwCommand(() => `main:${key()}`),
        ...feedbackCommands(),
        { name: "side", desc: t("사이드 채팅 열기"), keys: shortcutHint("side"), icon: "message", run: (a) => (openPanel("side"), a.trim() && void sendSide(state.space, a)) },
        { name: "flow", desc: t("작업 흐름 열기"), keys: shortcutHint("flow"), icon: "branch", run: () => openPanel("flow") },
        { name: "ask", desc: t("권한: {name}", { name: t("매번 묻기") }), icon: "lock", run: () => setState("settings", "permission", "ask") },
        { name: "edits", desc: t("권한: {name}", { name: t("편집 허용") }), icon: "pencil", run: () => setState("settings", "permission", "edits") },
        { name: "full", desc: t("권한: {name}", { name: t("전체 권한") }), icon: "shield", run: () => setState("settings", "permission", "full") },
        { name: "remember", desc: t("메모리에 저장"), icon: "memory", run: (a) => a.trim() && addMemory(a, "space", { space: state.space }) },
        { name: "memory", desc: t("메모리 열기"), icon: "memory", run: () => setView({ name: "memory" }) },
        { name: "settings", desc: t("설정 열기"), keys: shortcutHint("settings"), icon: "gear", run: () => setView({ name: "settings" }) },
        // the chat only: jobs, results and memory stay
        { name: "clear", desc: t("이 대화 비우기 · 작업과 결과는 그대로"), icon: "refresh", run: () => void resetMain(state.space, project()?.id).then(() => toast(t("대화를 비웠어요"))) },
        ...skillCommands(() => ({ space: state.space, project: project()?.id })),
      ]}
      placeholder={t("메시지 보내기|input")}
      onSend={sendMain}
      onTyping={() => void warmMain(state.space, project()?.id)}
      top={<BtwCard scope={`main:${key()}`} />}
      status={
        <Show
          when={raw()}
          // main's own account (here); a project of another Mac names that Mac
          fallback={<StatusLine lead={<ComputerPicker fixed={!!project()} value={computer()} />} accountId={account()} space={state.space} agent={`captain:${key()}`} />}
        >
          <HostStatus place={raw()!} fixed={!!project()} />
        </Show>
      }
      plus={plusFor({ main: true })}
      running={msgs().some((m) => m.pending)}
      onStop={() => void stopMain(key())}
      stopKind="stop"
      left={<PermissionPicker value={state.settings.permission ?? "edits"} onChange={(p) => setState("settings", "permission", p)} />}
      right={<Show when={raw()} fallback={<AccountModel accountId={account()} up={!big} rest="low" />}>{(c) => <HostModel place={c()} up={!big} />}</Show>}
    />
  );

  // a new task is written here until it is sent, or until anything else is opened (closeNewTask above).
  // Esc closes it in one press while nothing is written, even from its input (which would only blur);
  // an open menu, or a written draft, takes the Esc first
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drafting() || !focused() || e.defaultPrevented || !noModifiers(e) || e.isComposing) return;
    if (document.querySelector(".new-task-page :is(.pop, .cpick, .plus-menu)")) return;
    const input = inPane<HTMLTextAreaElement>("#new-task-input", pid);
    if (input?.value.trim() && document.activeElement === input) return;
    e.preventDefault();
    e.stopPropagation();
    closeNewTask(pid);
  };
  window.addEventListener("keydown", esc, true);
  onCleanup(() => window.removeEventListener("keydown", esc, true));

  return (
    <div class="view main-view">
      <Show when={drafting()}>
        {(d) => (
          <>
            <header class="head" data-tauri-drag-region>
              <SidebarToggle />
              <h1 class="head-title">{t("새 작업")}</h1>
              <span class="spacer" data-tauri-drag-region />
              {/* a pane opened for it closes with its own ✕ */}
              <Show when={!(paneState(pid)?.fresh && paneCount() > 1)}>
                <button class="icon-btn" title={`${t("닫기")} esc`} aria-label={t("닫기")} onClick={() => closeNewTask(pid)}>
                  <Icon name="x" size={16} />
                </button>
              </Show>
              <PaneControls />
            </header>
            <NewTask pane={pid} project={d().project} onProject={(id) => setDrafting({ ...drafting()!, project: id })} />
          </>
        )}
      </Show>
      <Show when={!drafting()}>
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">
          <Show when={project()} fallback={t("메인")}>
            {(p) => (
              <span class="head-proj-name" title={tilde(p().folder)}>
                <ProjectBadge name={p().name} />
                <span class="head-proj">{p().name}</span>
              </span>
            )}
          </Show>
        </h1>
        {/* Main: what its requests are doing, beside the title; opened, the list hangs from the header */}
        <Show when={!project() && msgs().length}>
          <RequestBoard
            msgs={msgs()}
            started={started}
            onJump={(id) => (holdScroll(900, box), box?.querySelector(`[data-mid="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }))}
          />
        </Show>
        <Show when={projCounts().length}>
          <span class="head-counts">
            <For each={projCounts()}>{([st, n, word]) => <span class={`req-tag ${st}`}>{word} {n}</span>}</For>
          </span>
        </Show>
        <span class="spacer" data-tauri-drag-region />
        <Show when={project() && hasNotes()}>
          <button class="icon-btn" title={t("프로젝트 노트 · 작업이 남긴 진행 상황")} onClick={() => previewFile(notesPath(project()!.id))}>
            <Icon name="file" size={16} />
          </button>
        </Show>
        <button class="icon-btn" classList={{ on: panelOpen() && focused() }} data-shortcut="panel" title={withHint(t("패널"), "panel")} onClick={togglePanel}>
          <Icon name="panel" size={16} />
        </button>
        <PaneControls />
      </header>
      <Show
        when={msgs().length}
        fallback={
          <Show when={project()} fallback={<Hero composer={composer(true)} asks={asks()} />}>
            {(p) => (
              <>
                {/* a project with nothing said yet: its tasks (in the strip they keep once something is said),
                    then what they are asking; its input where it always is */}
                <ProjectStrip project={p().id} all />
                <div class="thread proj-empty">
                  <div class="thread-inner convo">
                    <For each={answered()}>{(a) => <AnsweredLine a={a} />}</For>
                    <Picks project={p().id} />
                  </div>
                </div>
                <div class="dock">
                  <div class="dock-inner">
                    <SetupNotice />
                    <AskDock list={asks()} />
                    {composer(false)}
                  </div>
                </div>
              </>
            )}
          </Show>
        }
      >
        {/* a project's chat: all its tasks stay above the conversation (they include what it started) */}
        <Show when={project()}>{(p) => <ProjectStrip project={p().id} />}</Show>
        <div class="thread" ref={(el) => { box = el; onCleanup(keepBottom(el)); }}>
          <div class="thread-inner convo">
            <For each={timeline()}>
              {(m) => (
                <Show when={!("taskId" in m) && m} fallback={<AnsweredLine a={m as Answered} />}>
                  {(c) => (
                    <Show
                      when={c().from === "me"}
                      fallback={
                        // main reacting to a job's end on its own shows only what it added (nothing while it reads it)
                        <Show when={!onItsOwn(c()) || (!c().pending && shows(c()))}>
                          <Reply m={c()} retry={() => retry(c())} active={openRoot()} lastRow={(id) => lastRow().get(id)} full={!!project()} />
                        </Show>
                      }
                    >
                      {/* main's own question answered: the same compact card a task's thread keeps */}
                      <Show when={answerOf(c().text ?? "")} fallback={<UserMsg id={c().id} text={c().text ?? ""} at={c().at} from={c().via === "main" ? t("메인에서") : undefined} onEdit={c().via === "main" ? undefined : (t) => void editMain(c().id, t)} />}>
                        {(a) => <AnsweredCard q={a().q} a={a().a} />}
                      </Show>
                    </Show>
                  )}
                </Show>
              )}
            </For>
          </div>
        </div>
        <div class="dock">
          <div class="dock-inner">
            <SetupNotice quiet={msgs().some((m) => isNoAccount(m.error))} />
            <AskDock list={asks()} />
            {composer(false)}
          </div>
        </div>
      </Show>
      </Show>
    </div>
  );
}


const TONE_ORDER = ["bad", "ask", "review", "live", "idle", "done"] as const;
const toneRank = (x: Task) => (discarded(x) ? TONE_ORDER.length : TONE_ORDER.indexOf(stateMeta(x).tone));
/** A project's tasks: pinned on top, then what needs you, what runs, what waits, what is over; newest first in each. */
const projectTasks = (project: string) =>
  tasksShown(state.space)
    .filter((x) => x.project === project && x.space === state.space && !x.parentId && !x.answer && !x.archived)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || toneRank(a) - toneRank(b) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));

/** a long list folded or open, per project, while the app runs */
const [stripOpen, setStripOpen] = createSignal<Record<string, boolean>>({});

/**
 * A project's tasks above its conversation. Up to three are rows; more fold into one line like
 * Main's strip (the count and the task that needs you most), opened in place. `all`: nothing said
 * yet, so the whole list shows (and "작업 없음" when there is none).
 */
function ProjectStrip(props: { project: string; all?: boolean }) {
  const list = () => projectTasks(props.project);
  const fold = () => !props.all && list().length > 3;
  const open = () => !fold() || !!stripOpen()[props.project];
  const lead = () => [...list()].sort((a, b) => toneRank(a) - toneRank(b))[0];
  return (
    <Show when={props.all || list().length}>
      <div class="req-board proj-board" classList={{ open: fold() && open(), folded: fold() }}>
        <Show when={fold()}>
          <button class="req-head" onClick={() => setStripOpen({ ...stripOpen(), [props.project]: !open() })} aria-expanded={open()}>
            <span class="req-sum">
              <span class="req-total">{t("작업 {n}|board", { n: list().length })}</span>
            </span>
            <Show when={!open() && lead()}>
              {(x) => (
                <span class="req-now">
                  {x().title}
                  <span class={`proj-lead tone-${stateMeta(x()).tone}`}> · {stateMeta(x()).text}</span>
                </span>
              )}
            </Show>
            <Icon name="chevron" size={12} class="req-chev" />
          </button>
        </Show>
        <Show when={open()}>
          <ProjectTasks list={list()} />
        </Show>
      </div>
    </Show>
  );
}

/** Task rows in the sidebar's look; a click opens one. */
function ProjectTasks(props: { list: Task[] }) {
  const list = () => props.list;
  return (
    <Show when={list().length} fallback={<p class="proj-tasks-empty">{t("작업 없음")}</p>}>
      <div class="proj-tasks">
        <For each={list()}>
          {(x) => {
            const meta = () => stateMeta(x);
            return (
              <button class="sb-row proj-task" classList={{ [`tone-${meta().tone}`]: true, past: x.status === "done" && x.worktree?.state !== "open" }} onClick={() => openTask(x.id)} title={x.title}>
                <Glyph t={x} />
                <span class="sb-title">{x.title}</span>
                <span class="sb-meta">{meta().text}</span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** A task's question answered (in Main or in the task), as Main shows it afterwards. */
type Answered = { id: string; at: number; taskId: string; q: string; a: string };
const answeredSeen = new Map<string, Answered>();

/** "4월 회고 초안 · 초안으로 저장": the task (opens it) and what was answered; the question on hover.
 *  A follow-up goes by the job its line started from, as the sidebar files it */
function AnsweredLine(props: { a: Answered }) {
  const task = () => {
    const x = taskById(props.a.taskId);
    return x && lineHead(x);
  };
  return (
    <button class="answered-line" onClick={() => openTask(props.a.taskId)} title={`${props.a.q} → ${props.a.a}`}>
      <Icon name="check" size={14} />
      <span class="answered-task">{task()?.title ?? t("작업")}</span>
      <span class="answered-sep">·</span>
      <span class="answered-a">{props.a.a}</span>
    </button>
  );
}

type Req = { id: string; text: string; tasks: Task[]; state: "ask" | "live" | "review" | "done"; at: number };

/** A task line's state word: its status, or 병합 필요 (finished, its worktree waiting to be merged), 병합됨, 버림. */
type ReqState = Status | "inreview" | "merged" | "discarded";
const REQ_WORD: Record<ReqState, string> = { ...statusLabel, inreview: "병합 필요", merged: "병합됨", discarded: "버림" };
const reqState = (t: Task): ReqState =>
  discarded(t) ? "discarded" : t.status === "done" ? (t.worktree?.state === "open" ? "inreview" : t.worktree?.state === "merged" ? "merged" : "done") : t.status;

/**
 * What the requests in this chat are doing, one line each, above the chat: the
 * chat scrolls, this stays. Closed it is a single line; only requests still
 * going, waiting on the user, or finished in the last few minutes are listed.
 */
// the request board stays open or closed as the user left it, in each space (across views and restarts)
const BOARD_KEY = "ondra.reqBoardOpen";
const [boards, setBoards] = createSignal<Record<string, boolean>>((() => {
  try {
    const v = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "{}");
    return typeof v === "object" && v ? v : {};
  } catch {
    return {};
  }
})());
const boardOpen = () => !!boards()[state.space];
const setBoardOpen = (v: boolean) => {
  const next = { ...boards(), [state.space]: v };
  setBoards(next);
  try {
    localStorage.setItem(BOARD_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
};

function RequestBoard(props: { msgs: CaptainMessage[]; started: (m: CaptainMessage) => Task[]; onJump: (id: string) => void }) {
  const open = boardOpen;
  const setOpen = setBoardOpen;
  let board!: HTMLDivElement;
  // it opens over the conversation: Escape or a click elsewhere closes it
  const away = (e: PointerEvent) => open() && board && !board.contains(e.target as Node) && setOpen(false);
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open() || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", esc, true);
  onCleanup(() => {
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", esc, true);
  });
  const reqs = createMemo<Req[]>(() => {
    const out: Req[] = [];
    let ask: CaptainMessage | undefined;
    // jobs a later request started belong to that request, even when they carry on this one's
    const own = new Set(props.msgs.filter((m) => m.from !== "me").flatMap((m) => props.started(m).map((t) => t.id)));
    // a job that carries on one of the request's jobs without a request of its own (a follow-up the project started) is part of it
    const carried = (t: Task, seen = new Set<string>()): Task[] => {
      if (seen.has(t.id)) return [];
      seen.add(t.id);
      return [t, ...allTasks().filter((x) => x.follows === t.id && !own.has(x.id)).flatMap((x) => carried(x, seen))];
    };
    for (const m of props.msgs) {
      if (m.from === "me") {
        ask = m;
        continue;
      }
      const tasks = props.started(m).flatMap((t) => carried(t));
      if (!ask || !tasks.length) continue;
      const prev = out.find((r) => r.id === ask!.id);
      if (prev) prev.tasks.push(...tasks.filter((t) => !prev.tasks.includes(t)));
      else out.push({ id: ask.id, text: ((t) => t.split("\n").find((l) => l.trim() && !/^https?:\/\//.test(l.trim())) ?? t)(((a) => a.rest.trim() || a.skills.join(", "))(skillAsk(ask.text ?? ""))), tasks: [...tasks], state: "done", at: 0 });
    }
    for (const r of out) {
      // a finished job is finished, and so is a discarded one (even paused or failed): subagents it
      // left stopped don't keep the request open
      const all = r.tasks.filter((t) => !discarded(t)).flatMap((t) => [t, ...(t.status === "done" ? [] : kidsOf(t.id))]);
      // finished with its worktree still open, it waits on a merge: listed as 검토 until merged or discarded
      r.state = all.some((t) => t.status === "waiting" || t.status === "failed")
        ? "ask"
        : all.some((t) => t.status === "running" || t.status === "queued" || t.status === "paused")
          ? "live"
          : all.some((t) => reqState(t) === "inreview")
            ? "review"
            : "done";
      // when it ended: merged, when it was merged; discarded, when it was discarded
      r.at = Math.max(...r.tasks.map((t) => endedAt(t) ?? t.startedAt ?? t.createdAt));
    }
    const fresh = Date.now() - 10 * 60_000;
    return out.filter((r) => r.state !== "done" || r.at > fresh).reverse();
  });
  /** every task the list shows, once */
  const listed = () => [...new Set(reqs().flatMap((r) => r.tasks))];
  // the order a row picks its word by, most pressing first (검토 is its own word, and a discarded task
  // is 버림, never 완료)
  const ORDER: ReqState[] = ["waiting", "failed", "running", "inreview", "queued", "paused", "done", "merged", "discarded"];
  /** the closed strip: what needs you first, then what runs (응답 필요 1 · 검토 1 · 진행 중 2). Only when
   *  nothing is left to do does it count what is waiting its turn or over */
  const counts = () => {
    const of = (sts: ReqState[]) => sts.map((st) => [st, listed().filter((t) => reqState(t) === st).length, tr(REQ_WORD[st])] as const).filter(([, n]) => n);
    const now = of(["waiting", "failed", "inreview", "running", "paused"]);
    return now.length ? now : of(["queued", "done", "merged", "discarded"]);
  };
  // what the job says it is doing now (its status line), not its title again
  // never the state word again (the row ends with it): "실패" beside 실패, "응답 필요" beside 응답 필요
  // ("대기 중" / "일시정지됨" are the state word too)
  const sameAsState = (s: string, st: ReqState) => {
    const x = s.trim();
    return x.toLowerCase() === tr(REQ_WORD[st]).toLowerCase() || x.replace(/\s*(중|됨)$/, "") === REQ_WORD[st] || (st === "waiting" && x === "응답 대기 중");
  };
  const doing = (t: Task) => {
    const s = (t.status === "waiting" ? nowText(t.now) : t.intent || nowText(t.now)).trim();
    return s && s !== t.title && !sameAsState(s, t.status) ? s : "";
  };
  /** what the row says: its most pressing task's word. Finished: every task of it discarded reads 버림 (the
   *  muted trash), every one kept merged reads 병합됨, never 완료 */
  const rowState = (r: Req): ReqState => {
    if (r.state === "done") {
      const kept = r.tasks.filter((t) => !discarded(t));
      return !kept.length ? "discarded" : kept.every((t) => reqState(t) === "merged") ? "merged" : "done";
    }
    const live = ORDER.filter((st) => st !== "done" && st !== "merged" && st !== "discarded");
    return live.find((st) => r.tasks.some((t) => reqState(t) === st)) ?? (r.state === "review" ? "inreview" : "running");
  };
  /** still under way or waiting on you: the row shows the step it is on */
  const going = (r: Req) => r.state === "ask" || r.state === "live";
  /** main's last report on one of the request's jobs */
  const resultOf = (r: Req) => [...props.msgs].reverse().find((m) => m.after && shows(m) && r.tasks.some((t) => t.id === m.after))?.id;
  /** a one-task request: its to-do list (skipped steps left out) */
  const steps = (r: Req) => {
    const ps = r.tasks[0].plan.filter((p) => p.state !== "skip");
    return ps.length ? { done: ps.filter((p) => p.state === "done").length, all: ps.length } : undefined;
  };
  /** what it is on now: the question it waits on, else the to-do step under way, else its status line */
  const stepNow = (r: Req) => {
    const t = focus(r);
    if (!t) return "";
    const s = ((t.status === "waiting" ? nowText(t.now) : t.plan.find((p) => p.state === "now")?.text ?? doing(t)) ?? "").trim();
    return sameAsState(s, rowState(r)) || sameAsState(s, t.status) ? "" : s;
  };
  /** a request's job to look at: the one that needs you, else the one working, else the last one */
  const focus = (r: Req) => {
    const all = r.tasks.flatMap((t) => [t, ...kidsOf(t.id)]);
    const pick = (ok: (t: Task) => boolean) => all.find(ok);
    return (
      pick((t) => t.status === "waiting" || t.status === "failed") ??
      pick((t) => t.status === "running") ??
      pick((t) => t.status === "queued" || t.status === "paused") ??
      pick((t) => reqState(t) === "inreview") ??
      r.tasks[r.tasks.length - 1]
    );
  };
  /** a task line's right side: how long it has run, or its state */
  const when = (t: Task) => (t.status === "running" && t.startedAt ? compact(now() - t.startedAt) : tr(REQ_WORD[reqState(t)]));
  return (
    <Show when={reqs().length}>
      <div class="req-board" ref={board} classList={{ open: open() }}>
        <button class="req-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
          {/* what each task is doing is said on its own row, opened */}
          <span class="req-sum">
            <For each={counts()}>
              {([st, n, word], i) => (
                <>
                  <Show when={i()}><span class="req-sep">·</span></Show>
                  <span class={`req-tag ${st}`}>
                    <GlyphMark g={(st === "merged" ? "done" : st) as GlyphKind} class="req-g" />
                    {word} <b>{n}</b>
                  </span>
                </>
              )}
            </For>
          </span>
          <Icon name="chevron" size={12} class="req-chev" />
        </button>
        <Show when={open()}>
          <ul class="req-list">
            <For each={reqs()}>
              {(r) => (
                <li classList={{ "req-paused": rowState(r) === "paused" }}>
                  <button class="req-row" onClick={() => (r.state === "done" ? props.onJump(resultOf(r) ?? r.id) : openTask(focus(r).id))} onContextMenu={taskContextMenu(focus(r).id)} title={r.text}>
                    {/* 버림 and 검토 read by shape too: the shared muted trash, the review ring */}
                    <Switch fallback={<i class={`req-dot ${rowState(r) === "merged" ? "done" : rowState(r)}`} />}>
                      <Match when={rowState(r) === "discarded"}><GlyphMark g="discarded" class="req-glyph" /></Match>
                      <Match when={rowState(r) === "inreview"}><GlyphMark g="inreview" class="req-glyph" /></Match>
                    </Switch>
                    <span class="req-text">{r.text}</span>
                    {/* one task: the step it is on and its to-do list; several: how many of the tasks listed below are done */}
                    <Show
                      when={r.tasks.length > 1}
                      fallback={
                        <>
                          <Show when={going(r) && stepNow(r)}>{(n) => <span class="req-step-now">{n()}</span>}</Show>
                          <Show when={going(r) && steps(r)}>
                            {(st) => (
                              <span class="req-steps" title={t("할 일 {done}/{n} 완료", { done: st().done, n: st().all })}>
                                <i class="req-bar"><b style={{ width: `${(st().done / st().all) * 100}%` }} /></i>
                                {t("할 일 {done}/{all}", { done: st().done, all: st().all })}
                              </span>
                            )}
                          </Show>
                        </>
                      }
                    >
                      <span class="req-steps">{t("{n}개 중 {done}개 완료", { done: r.tasks.filter((x) => x.status === "done").length, n: r.tasks.length })}</span>
                    </Show>
                    <span class={`req-state ${rowState(r)}`}>{tr(REQ_WORD[rowState(r)])}</span>
                  </button>
                  {/* paused work stays listed until it goes on or is ended: ending it is right here, on hover */}
                  <Show when={rowState(r) === "paused"}>
                    <button class="req-end" title={tr("이 작업을 여기서 끝내요")} onClick={() => r.tasks.filter((x) => x.status === "paused").forEach((x) => finishTask(x.id))}>
                      {tr("끝내기")}
                    </button>
                  </Show>
                  {/* several tasks: one line each, all of them, so the count above adds up */}
                  <Show when={r.tasks.length > 1}>
                    <For each={r.tasks}>
                      {(x) => (
                        <button class="req-job" onClick={() => openTask(x.id)} title={x.title}>
                          <span class="req-job-title">{x.title}</span>
                          <Show when={x.status !== "done" && doing(x)}><span class="req-job-now">{doing(x)}</span></Show>
                          <span class={`req-job-time ${reqState(x)}`}>{when(x)}</span>
                        </button>
                      )}
                    </For>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}
