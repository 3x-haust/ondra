// Task lifecycle: start an engine session, turn its events into transcript
// entries, roll to a fresh session on a handoff (the relay), pick another
// model when one is rejected, and schedule queued work into free slots.
import { isNetError, waitOnline } from "./net";
import { cutTitle, describeBrowser, describeCommand } from "./describe";
import { t as tr } from "../i18n";
import { skillPaths } from "./skillPick";
import { prepareQuery } from "./vectors";
import { batch, createEffect, createRoot, on } from "solid-js";
import { accountById, accountsIn, homeDir, loaded, projectById, projectFor, setState, spaceById, kidsOf, state, taskById, uid, updateAccount, updateTask } from "../state/store";
import { refreshLimits, snapshot, usageOf } from "../state/limits";
import { ctx, noteCall, noteCtx } from "../state/ctx";
import { handoffAt, handoffSteer, windowFor } from "./handoff";
import type { Account, Block, Decision, Entry, Evidence, Handoff, Permission, Priority, PrWatch, Shell, Task, TokenStats, ToolCall, Usage, Weight } from "../state/types";
import { setLive, toast } from "../state/ui";
import { allowedDevices, refreshDevices } from "../state/devices";
import { inTauri, jobDevicesRelease, accountDirPath, agentKill, agentSend, agentStopCommand, agentSpawn, browserCheck, browserRelease, type Env, gitChanges, spaceEnv, workerEnv, workerExtensions, worktreeCreate, worktreeLanded, worktreeMerge, worktreeRemove, fsRead, ghPrState } from "../lib/native";
import { canWake, hasNews, parseSnap, prNews, wakeText, type PrNews } from "./prWatch";
import { prose, readFences } from "./fences";
import { notesMarkdown, readNotes, writeNotes } from "./notes";
import { commandKind, isTestRun, runsProgram, SEARCH_STALL_MS, searchCall, searchStalled, shellArg, WAIT_STALL_MS, waitStalled } from "./commandKind";
import { checkEvidence, isCodeFile, promisesLater, reviewUnresolved, riskyChange, unbackedClaim } from "./proof";
import { crosscheckMessage, isPlan, lensesOf, lensKids, planKids, lensText, REVIEW_FIX, reviewGoing, reviewName, reviewSettled } from "./crosscheck";
import { readMemoryCheck, settleMemory } from "./memcheck";
import { addMemory, KINDS, markUsed, memoryLines } from "./memory";
import { effortFor, failedModelIn, modelFor, nextModel } from "./models";
import { canUseTools, connModel, isDirect, toolsRefused } from "./connections";
import { handoffPrompt, relatedMemory, relatedQuery, taskPrompt, taskSystem } from "./prompts";
import { clearStderr, engine, expand, explain, isAlive, isModelError, listen, markAlive, markDead, request, stderrOf } from "./rpc";

const KIND_IDS: unknown[] = KINDS.map((k) => k.id);

interface Run {
  text: string;
  cursor: number;
  streaming: boolean;
  done?: string;
  handoff?: Handoff;
  asked: boolean;
  error?: string;
  turnStart: number;
  /** time spent generating (between assistant message start and end) this turn */
  genMs?: number;
  turnMs?: number;
  msgAt?: number;
  /** the entry the current message's output goes after (its blocks land while it streams) */
  msgAfter?: string;
  stats: TokenStats;
  /** toolCallId → entry id */
  tools: Map<string, string>;
  /** told once this session to write the lines between tool calls in the user's language */
  langNudged?: boolean;
  /** tool calls since the job last said where it is in its plan, and how often it was reminded */
  quietTools?: number;
  planNudges?: number;
  /** loop guard: each command's last result and how many file edits had happened by then */
  ran?: Map<string, { ok: boolean; edits: number }>;
  edits?: number;
  nudges?: number;
  modelTries: number;
  /** turns cut by a dropped connection in a row (picked up again once it is back) */
  netTries?: number;
  /** a turn has ended since this run started listening */
  ended?: boolean;
  /** done/evidence handed in; checked once before finishing */
  evidence?: Evidence[];
  unverified?: string[];
  /** already sent back once for missing review/evidence */
  gated?: boolean;
  /** times the job was sent back before done (max 2) */
  gates?: number;
  /** the summary of the first done: the whole job, kept when the proof check sends it back */
  firstDone?: string;
  /** status looks at running work (sleep, tail, ps …) this run */
  polls?: number;
  /** how many times it was told its context is long (handoff) */
  longNudges?: number;
  /** a handoff sent while subagents still worked: the new session starts once they are done */
  pendingHandoff?: Handoff;
  /** a review it asked for was refused (one per job): said again as a prompt if the turn ended waiting for it */
  refused?: string;
  /** asked once, after a turn ended with no done block, whether it is finished */
  askedDone?: boolean;
  /** toolCallId → when that shell's output last changed (the search and wait watchdog) */
  changed?: Map<string, number>;
  /** searches and waits the watchdog already tried to stop */
  searchStops?: Set<string>;
  waitStops?: Set<string>;
}


const runs = new Map<string, Run>();
export const agentOf = (taskId: string) => `t:${taskId}`;
// a long job's transcript keeps its newest entries; reaching this trims, it never ends the job
const MAX_ENTRIES = 600;
/** tool calls without a step update before a fork is asked where it is, and how often */
export const PLAN_QUIET = 20;
export const PLAN_NUDGES = 2;
const MAX_SHELLS = 40;
const TAIL = 3000;
const zero = (): TokenStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// ─────────────────────────────── accounts

/**
 * Which account new work runs on. The user's pick wins. Otherwise, routed so the
 * prompt cache stays warm: a cache lives per account, so work stays where its
 * prefix is already cached (same topic within the cache hour, else the account
 * used last — the shared system prompt and tools are cached there) and only moves
 * when that account is nearly out of its plan window. A running job never moves.
 */
export function chooseAccount(space: Task["space"], topic: string): string {
  const all = accountsIn(space);
  const pool = all.filter((a) => a.providers.length).length ? all.filter((a) => a.providers.length) : all;
  // never another space's account: with none here, there is none
  if (!pool.length) return "";
  const pick = state.accountPick?.[space];
  if (pick && pick !== "auto" && pool.some((a) => a.id === pick)) return pick;
  if (pool.length === 1) return pool[0].id;
  // a direct connection (a local model, a gateway) runs work only when picked, unless it is all there is
  const routed = pool.filter((a) => !isDirect(a));
  const auto = routed.length ? routed : pool;
  if (auto.length === 1) return auto[0].id;
  const load = (id: string) => Math.max(0, ...usageOf(id).map((l) => l.used));
  const roomy = auto.filter((a) => load(a.id) < 85);
  const use = roomy.length ? roomy : auto;
  const HOUR = 60 * 60_000;
  const same = state.tasks
    .filter((t) => t.space === space && t.topic === topic && use.some((a) => a.id === t.accountId))
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))[0];
  if (same && Date.now() - (same.finishedAt ?? same.startedAt ?? 0) < HOUR) return same.accountId;
  const warm = [...use].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
  if (warm && Date.now() - (warm.lastUsedAt ?? 0) < HOUR) return warm.id;
  // nothing warm: the one with the most room left
  return [...use].sort((a, b) => load(a.id) - load(b.id) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0].id;
}

export const NO_ACCOUNT = "이 워크스페이스에 계정이 없어요";

/** The account work in this space runs on: the one given if it is this space's, else the space's pick. */
export function spaceAccount(space: Task["space"], topic = "", given?: string): Account | undefined {
  const own = (id?: string) => {
    const a = id ? accountById(id) : undefined;
    return a?.space === space ? a : undefined;
  };
  return own(given) ?? own(chooseAccount(space, topic));
}

export async function accountEnv(accountId: string): Promise<Env> {
  const dir = await accountDirPath(accountId);
  // long prompt-cache retention: Anthropic keeps the prefix 1h instead of 5m, so a
  // job that waited for you (or for its subagents) comes back to a warm cache
  const cache: Env = [["PI_CACHE_RETENTION", "long"]];
  return dir && accountId !== "default" ? [["PI_CODING_AGENT_DIR", dir], ...cache] : cache;
}

/** What one turn used (null if nothing moved). */
const browserCheckAt = new Map<string, number>();
function recheckBrowser(space: string) {
  if (Date.now() - (browserCheckAt.get(space) ?? 0) < 30_000) return;
  browserCheckAt.set(space, Date.now());
  void browserCheck(space).catch(() => {});
}

export function turnUsage(a: TokenStats, b: TokenStats, accountId: string, genMs?: number, ms?: number): Usage | null {
  const reset = b.input < a.input || b.cacheRead < a.cacheRead;
  const from = reset ? zero() : a;
  const u = { input: b.input - from.input, output: b.output - from.output, cacheRead: b.cacheRead - from.cacheRead, cacheWrite: b.cacheWrite - from.cacheWrite };
  if (!u.input && !u.output && !u.cacheRead) return null;
  const tps = genMs && genMs > 300 ? Math.round((u.output / (genMs / 1000)) * 10) / 10 : undefined;
  return { ...u, limits: snapshot(accountId), ...(ms ? { ms } : {}), ...(tps ? { tps } : {}) };
}

/** Token use since `base`, added to the account. */
export async function collectStats(agent: string, accountId: string, base: TokenStats): Promise<TokenStats> {
  try {
    const s = await request(agent, { type: "get_session_stats" }, 8000);
    noteCtx(agent, s);
    const t: TokenStats = {
      input: s?.tokens?.input ?? 0,
      output: s?.tokens?.output ?? 0,
      cacheRead: s?.tokens?.cacheRead ?? 0,
      cacheWrite: s?.tokens?.cacheWrite ?? 0,
    };
    const from = t.input < base.input || t.cacheRead < base.cacheRead ? zero() : base;
    updateAccount(accountId, (a) => {
      a.lastUsedAt = Date.now();
      a.stats.input += t.input - from.input;
      a.stats.output += t.output - from.output;
      a.stats.cacheRead += t.cacheRead - from.cacheRead;
      a.stats.cacheWrite += t.cacheWrite - from.cacheWrite;
    });
    return t;
  } catch {
    return base;
  }
}

// ─────────────────────────────── transcript

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id" | "at"> : never) : never;

function push(t: Task, e: NewEntry): string {
  const id = uid("e");
  t.entries.push({ at: Date.now(), ...e, id } as Entry);
  trimEntries(t.entries);
  return id;
}

/** Drop the oldest entries past the cap, but keep the user's own words: later sessions and main still read them. */
export function trimEntries(entries: Entry[], max = MAX_ENTRIES) {
  let drop = entries.length - max;
  for (let i = 0; i < entries.length && drop > 0; ) {
    if (entries[i].kind === "user") i++;
    else {
      entries.splice(i, 1);
      drop--;
    }
  }
}

/**
 * What a job's model sees up front: the four file/shell tools, memory search and
 * tool_search. Every other tool (phone devices, saving memory, MCP servers, …) is
 * registered as deferred and declared only after tool_search finds it.
 */
// (the engine runs with --no-extensions, so the built-in tool_search is loaded by name)
export const WORKER_TOOLS = ["--extension", "builtin:tool-search", "--tools", "+tool_search"];

/**
 * A job's tool flags: WORKER_TOOLS plus the tools turned on in Settings › 도구.
 * Each one is a "+name" modifier, so the engine's defaults (read, bash, edit, write)
 * stay and nothing can be taken away here. No extra tools = exactly WORKER_TOOLS.
 */
export function workerTools(extra: readonly string[] | undefined = state.settings.extraTools): string[] {
  // exact names only: "+name" entries take no patterns, and a comma would split the list
  const names = [...new Set((extra ?? []).map((n) => n.trim()).filter((n) => /^\w[\w.:-]*$/.test(n) && n !== "tool_search"))];
  if (!names.length) return WORKER_TOOLS;
  return ["--extension", "builtin:tool-search", "--tools", ["+tool_search", ...names.map((n) => `+${n}`)].join(",")];
}

/**
 * The MCP tools switched off in Settings › 도구 (kept in `extraTools` as "-name"), as the engine's denylist: they aren't
 * registered at all (not declared, not found through tool_search). Only MCP tools can
 * be switched off; the engine's own and Ondra's stay.
 */
export function offTools(extra: readonly string[] | undefined = state.settings.extraTools): string[] {
  const names = [...new Set((extra ?? []).filter((n) => n.startsWith("-")).map((n) => n.slice(1).trim()).filter((n) => /^mcp__[\w.:-]+$/.test(n)))];
  return names.length ? ["--exclude-tools", names.join(",")] : [];
}

/** A quiet line in a job's transcript (from outside the event stream, e.g. a tool). */
export function pushNote(id: string, text: string) {
  updateTask(id, (t) => void push(t, { kind: "note", text }));
}

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** Files that hold what was decided or where things stand, not code. */
/** Chinese characters and no Korean: a line the user can't read. */
const stepKey = (s: string) => s.replace(/[\s·.,()]/g, "").toLowerCase();

/** A new plan keeps the steps already finished (same text) as done; the first open one is current. */
export function nextPlan(old: { text: string; state: string }[], steps: string[]): Task["plan"] {
  const finished = new Set(old.filter((s) => s.state === "done").map((s) => stepKey(s.text)));
  const plan: Task["plan"] = steps.map((text) => ({ text, state: finished.has(stepKey(text)) ? "done" : "todo" }));
  const cur = plan.find((s) => s.state !== "done");
  if (cur) cur.state = "now";
  return plan;
}

/** A finished job's plan: the step it was on is done, steps it never reached are skipped (not left open). */
export function closePlan(plan: Task["plan"]): Task["plan"] {
  return plan.map((s) => ({ ...s, state: s.state === "now" ? "done" : s.state === "todo" ? "skip" : s.state }));
}

/** a sentence of English prose shown to a user who writes Korean */
export function notTheirLanguage(text: string, t: Pick<Task, "entries"> | undefined): boolean {
  const said = t?.entries.find((e) => e.kind === "user");
  if (!said || !("text" in said) || !/[\uac00-\ud7a3]/.test(String(said.text))) return false;
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").trim();
  if (prose.length < 20 || /[\uac00-\ud7a3]/.test(prose)) return false;
  return (prose.match(/[A-Za-z]+/g) ?? []).length >= 4;
}

export const chineseOnly = (s: string) => /[\u4e00-\u9fff]/.test(s) && !/[\uac00-\ud7a3]/.test(s);

export const isNotesFile = (p: string) => /(^|\/)(now|handoff|log|MEMORY|memory|NOTES|notes|TODO|todo)\.md$|\/(context|memory|memories|wiki|\.omd\/handoff)\/.*\.md$/.test(p);
const lines = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);

const jobName = (id: unknown) => (typeof id === "string" ? (taskById(id)?.title ?? id) : "");

/** How a tool call shows up: kind, target, and a "now" line. */
function describeTool(name: string, args: any): ToolCall & { now: string } {
  const path: string = args?.path ?? args?.file_path ?? args?.filePath ?? "";
  switch (name) {
    case "read":
      return { name, kind: "read", target: base(path), detail: path, now: `${base(path)} 읽는 중` };
    case "edit": {
      const edits = Array.isArray(args?.edits) ? args.edits : [args];
      const add = edits.reduce((n: number, e: any) => n + lines(e?.newText ?? e?.new_string), 0);
      const del = edits.reduce((n: number, e: any) => n + lines(e?.oldText ?? e?.old_string), 0);
      if (isNotesFile(path))
        return { name, kind: "edit", note: true, text: edits.map((e: any) => String(e?.newText ?? e?.new_string ?? "")).join("\n…\n").slice(0, 2000), target: base(path), detail: path, add, del, now: `${base(path)}에 적는 중` };
      return { name, kind: "edit", target: base(path), detail: path, add, del, now: `${base(path)} 수정 중` };
    }
    case "write":
      return { name, kind: "write", note: isNotesFile(path) || undefined, text: isNotesFile(path) ? String(args?.content ?? "").slice(0, 2000) : undefined, target: base(path), detail: path, add: lines(args?.content), del: 0, now: isNotesFile(path) ? `${base(path)}에 적는 중` : `${base(path)} 작성 중` };
    case "grep":
    case "find":
    case "ls":
      return { name, kind: "search", target: String(args?.pattern ?? args?.path ?? ""), detail: JSON.stringify(args), now: "찾는 중" };
    case "web_search":
      return { name, kind: "search", target: String(args?.query ?? ""), detail: JSON.stringify(args ?? {}), now: "웹 검색 중" };
    case "web_fetch": {
      const url = String(args?.url ?? "");
      return { name, kind: "read", target: url.replace(/^https?:\/\/(www\.)?/, ""), detail: url, now: "웹 페이지 읽는 중" };
    }
    case "bash": {
      const cmd: string = args?.command ?? "";
      // what the command runs, not what it reads: `sed -n 1,18p a.test.tsx` is no test run
      if (runsProgram(cmd, /\bagent-browser\b|(?:^|\/)browse(?=\s|$)/)) return { name, kind: "browser", target: cmd.replace(/^.*?(?:agent-browser|(?:^|\/)browse)\s+(--\S+\s+\S+\s+)*/, ""), detail: cmd, now: describeBrowser(cmd).nowKo };
      if (runsProgram(cmd, /\bagent-desktop\b/)) return { name, kind: "desktop", target: cmd.replace(/^.*?agent-desktop\s+/, ""), detail: cmd, now: "앱 조작 중" };
      if (isTestRun(cmd)) return { name, kind: "test", target: cmd, detail: cmd, now: "테스트 실행 중" };
      return { name, kind: "bash", target: cmd, detail: cmd, now: describeCommand(cmd).nowKo };
    }
    // other jobs of this space (extensions/jobs.ts): named by what they look for or who they reach
    case "jobs_search":
      return { name, kind: "search", target: String(args?.query ?? ""), detail: JSON.stringify(args ?? {}), now: "작업 찾는 중" };
    case "job_read":
      return { name, kind: "read", target: jobName(args?.id), detail: JSON.stringify(args ?? {}), now: "작업 살펴보는 중" };
    case "job_tell":
      return { name, kind: "other", target: jobName(args?.id), detail: String(args?.message ?? ""), now: "다른 작업에 전달하는 중" };
    default:
      return { name, kind: "other", target: name, detail: JSON.stringify(args ?? {}), now: name };
  }
}

const keepsRunning = (cmd: string) =>
  /(&\s*$|&\s*disown|\bnohup\b|--watch\b|\bwatch\b|tail\s+-f|\b(dev|serve|start)\s*$|\bvite\b(?!\s+build)|tauri dev|next dev)/.test(cmd);

/**
 * The run is over (done, failed, paused or stopped): its shells and the tool calls
 * still open end now, so nothing spins. A call closed here has no `ok`: it was
 * stopped, it neither passed nor failed.
 */
export function closeOpen(t: Task, at = Date.now()) {
  for (const s of t.shells) if (!s.endedAt) (s.endedAt = at), (s.stopped = true);
  for (const e of t.entries) if (e.kind === "tool" && !e.tool.endedAt) (e.tool.endedAt = at), (e.tool.stopped = true);
}

const screenshotIn = (cmd: string) => cmd.match(/\bscreenshot\b(?:\s+--\S+)*\s+(["']?)(\/[^"'\s]+\.(?:png|jpe?g))\1/)?.[2];

function applyBlocks(t: Task, items: any[], run: Run) {
  for (const b of items) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
    switch (b.type) {
      case "now":
        // a status line in Chinese (a model slipping language) is dropped, not shown
        if (b.text && !chineseOnly(String(b.text))) t.now = t.intent = String(b.text).slice(0, 140);
        run.quietTools = 0;
        if (typeof b.step === "number" && t.plan.length) {
          t.plan.forEach((s, i) => (s.state = i < b.step ? "done" : i === b.step ? "now" : "todo"));
        }
        break;
      case "plan":
        if (Array.isArray(b.steps)) {
          t.plan = nextPlan(t.plan, b.steps.slice(0, 10).map(String));
          run.quietTools = 0;
        }
        break;
      case "ask": {
        const d: Decision = {
          id: uid("d"),
          taskId: t.id,
          at: Date.now(),
          kind: "ask",
          question: String(b.question ?? "확인 필요"),
          // "label" or {label, note}: the note says what that choice means
          options: (Array.isArray(b.options) && b.options.length ? b.options : ["진행", "중단"]).slice(0, 5).map((o: any, i: number) => {
            const label = String(o && typeof o === "object" ? (o.label ?? o.name ?? "") : o);
            const note = o && typeof o === "object" && o.note ? String(o.note) : undefined;
            return { id: label, label, primary: i === 0, ...(note ? { note } : {}) };
          }),
          context: Array.isArray(b.context) ? b.context : [],
        };
        setState("decisions", (list) => [...list.filter((x) => x.taskId !== t.id), d]);
        run.asked = true;
        break;
      }
      case "remember": {
        const scope = b.scope === "global" || b.scope === "space" ? b.scope : "project";
        const id = addMemory(String(b.text ?? ""), scope, {
          space: t.space,
          project: scope === "project" ? homeDir(t) : undefined,
          kind: KIND_IDS.includes(b.kind) ? b.kind : undefined,
          replaces: typeof b.replaces === "string" ? b.replaces : undefined,
          key: typeof b.key === "string" && b.key.trim() ? b.key.trim().slice(0, 64) : undefined,
          paths: Array.isArray(b.paths) ? b.paths.map(String).slice(0, 8) : undefined,
          taskId: t.id,
          quiet: true,
        });
        if (id) push(t, { kind: "note", text: `메모리에 저장 · ${String(b.text).slice(0, 120)}` });
        break;
      }
      case "notes": {
        // a job of a project leaves where it stands for the next one (not a subagent: its parent does)
        const p = t.project && !t.parentId ? projectById(t.project, t.space) : undefined;
        const md = p ? notesMarkdown(p.name, t.title, b) : undefined;
        if (!p || !md) break;
        void writeNotes(p.id, md).then((ok) => ok && updateTask(t.id, (x) => void push(x, { kind: "note", text: "프로젝트 노트 갱신" })));
        break;
      }
      case "handoff":
        run.handoff = {
          did: Array.isArray(b.did) ? b.did.map(String) : [],
          next: String(b.next ?? ""),
          evidence: Array.isArray(b.evidence) ? b.evidence : [],
          found: Array.isArray(b.found) ? b.found.map(String) : undefined,
          doneWhen: b.doneWhen ? String(b.doneWhen) : undefined,
        };
        break;
      case "done": {
        run.done = String(b.summary ?? "완료");
        t.saidDone = run.done;
        if (b.result) t.result = String(b.result).slice(0, 8000);
        const items: Evidence[] = Array.isArray(b.evidence) ? b.evidence.filter((e: any) => e && e.ref).map((e: any) => ({ kind: String(e.kind ?? "file"), ref: String(e.ref), ok: e.ok !== false, note: e.note ? String(e.note) : undefined })) : [];
        const unverified: string[] = [...new Set<string>(Array.isArray(b.unverified) ? b.unverified.map((u: unknown) => String(u).trim()).filter(Boolean) : [])];
        // a later done replaces what it proves again (same kind + ref)
        run.evidence = [...(run.evidence ?? []).filter((o) => !items.some((n) => n.kind === o.kind && n.ref === o.ref)), ...items];
        run.unverified = unverified;
        if (items.length || unverified.length) push(t, { kind: "block", block: { type: "evidence", items, unverified } });
        break;
      }
      case "subagent": {
        if (t.parentId || !(b.task || b.title)) break;
        const live = state.tasks.filter((x) => x.parentId === t.id && x.status !== "done" && x.status !== "failed").length;
        if (live >= 6) break;
        // 계획 검토: two fresh readers of the plan, once per job, before it builds
        if (b.plan_review === true || /계획 검토|plan review/i.test(String(b.title ?? ""))) {
          const had = state.tasks.find((x) => x.parentId === t.id && isPlan(x) && x.status !== "failed");
          if (had) {
            const jobId = t.id;
            const message = reviewGoing(had)
              ? "(Ondra) The plan review is still running. Its result comes to you by itself: go on with what doesn't depend on it, or end your turn and wait."
              : "(Ondra) This plan was already reviewed once; its result is above. Don't start another: fix the plan and build.";
            run.refused = message;
            queueMicrotask(() => void request(agentOf(jobId), { type: "steer", message }).catch(() => {}));
            break;
          }
          const ids = planKids(String(b.task ?? b.title)).map((k) => spawnChild(t, k.title, k.ask, false, k.extra).id);
          const last = t.entries[t.entries.length - 1];
          if (last?.kind === "spawn") last.childIds.push(...ids);
          else push(t, { kind: "spawn", childIds: ids });
          break;
        }
        const review = b.review === true || /code-review|리뷰|교차 검토|crosscheck/i.test(String(b.title ?? ""));
        // one review per job: after it, the job fixes the findings and re-runs its checks
        const had = review ? state.tasks.find((x) => x.parentId === t.id && x.review && x.status !== "failed") : undefined;
        // the job this carries on was reviewed and this one changed no code since: that review still holds
        const before = review && !had && !editedCode(t) ? reviewedBefore(t) : undefined;
        if (before) {
          push(t, { kind: "note", text: "이전 작업의 리뷰가 그대로 유효해요" });
          const jobId = t.id;
          const message = `(Ondra) The job this carries on was already reviewed ("${reviewName(before)}") and its findings were fixed there; you haven't changed code since. That review covers this: don't start another one, go on with the next step.`;
          run.refused = message;
          queueMicrotask(() => void request(agentOf(jobId), { type: "steer", message }).catch(() => {}));
          break;
        }
        if (had) {
          // 교차 검토: the pair is one review, going while either lens is
          const going = reviewGoing(had);
          push(t, { kind: "note", text: going ? "리뷰가 아직 진행 중이에요" : "리뷰는 이미 한 번 받았어요" });
          const jobId = t.id;
          // a new session may not know about it: say where it is, and what it found
          const message = going
            ? `(Ondra) A review is already running ("${reviewName(had)}"). Its findings come to you by themselves when it ends. Don't start another one and never ask the user for them: go on with what doesn't depend on it, or end your turn and wait.`
            : `(Ondra) This job was already reviewed once ("${reviewName(had)}"). Don't start another review. What it found:\n\n${lensText(lensesOf(had)) || "(nothing written)"}\n\nFix P1·P2 only, re-run the tests that cover them, and finish.`;
          if (!going) {
            run.refused = message;
            // it carries the findings: kept until taken, like the result itself
            t.pending = [...(t.pending ?? []), { text: message, from: had.id }];
          }
          queueMicrotask(() => void request(agentOf(jobId), { type: "steer", message }).catch(() => {}));
          break;
        }
        const ask = String(b.task ?? b.title);
        // a review is 교차 검토: its two lenses start side by side
        const kids = review ? lensKids(t, ask) : [{ title: String(b.title ?? "서브에이전트"), ask, extra: {} }];
        const ids = kids.map((k) => spawnChild(t, k.title, k.ask, review, k.extra).id);
        const last = t.entries[t.entries.length - 1];
        if (last?.kind === "spawn") last.childIds.push(...ids);
        else push(t, { kind: "spawn", childIds: ids });
        break;
      }
      case "memory-check":
        // a review lens's check of the memory it was given: applied once its pair is over
        if (t.review) t.memoryCheck = readMemoryCheck(b.items);
        break;
      default:
        if (b.type === "shot" && b.path) t.shot = b.path;
        push(t, { kind: "block", block: b as Block });
    }
  }
}

// ─────────────────────────────── start / events

// ─────────────────────────────── subagents

/** A subagent of a fork: same folder (and worktree), account and model; never isolated itself. */
function spawnChild(parent: Task, title: string, ask: string, review = false, extra: Partial<Task> = {}): Task {
  const child: Task = {
    id: uid("t"),
    space: parent.space,
    ...(parent.reach?.length ? { reach: parent.reach } : {}),
    topic: parent.topic,
    title: cutTitle(title) || "서브에이전트",
    ask,
    cwd: parent.cwd,
    status: "queued",
    priority: parent.priority,
    weight: "light",
    accountId: parent.accountId,
    createdAt: Date.now(),
    now: "대기 중",
    plan: [],
    legs: [],
    entries: [{ id: uid("e"), at: Date.now(), kind: "user", text: ask }],
    shells: [],
    inbox: [],
    parentId: parent.id,
    review: review || undefined,
    isolate: false,
    model: parent.model,
    thinking: parent.thinking,
    permission: parent.permission,
    ...extra,
  };
  setState("tasks", (list) => [...list, child]);
  queueMicrotask(schedule);
  return child;
}

export const childrenOf = (id: string) => [...kidsOf(id)];
const activeKids = (id: string) => childrenOf(id).filter((t) => t.status === "queued" || t.status === "running" || t.status === "waiting");

/** how a subagent's result to its fork begins (the same in every message carrying it) */
const resultHead = (child: Task) =>
  child.pair ? reviewName(child) : child.status === "done" ? (child.review ? `리뷰 결과가 왔어요 ("${child.title}")` : `서브에이전트 "${child.title}" 완료`) : `서브에이전트 "${child.title}" 실패`;

/** A subagent's result as its fork reads it. */
function resultMessage(child: Task, left: number, memory?: { lines: string[]; split: string[] }) {
  const body = child.pair
    ? crosscheckMessage(lensesOf(child), memory ?? { lines: [], split: [] })
    : child.status === "done"
      ? child.review
        ? `${resultHead(child)}:\n\n${child.result ?? child.summary ?? ""}\n\n${REVIEW_FIX}`
        : `${resultHead(child)}: ${child.summary ?? ""}${child.result ? `\n\n${child.result}` : ""}`
      : `${resultHead(child)}: ${child.error ?? "알 수 없는 오류"}`;
  return `${body}\n\n(남은 서브에이전트: ${left}개)`;
}

/** Sent to the running engine for the model: kept on the job until the model takes it. */
function hold(id: string, text: string, extra: { from?: string; shown?: string } = {}) {
  updateTask(id, (x) => (x.pending = [...(x.pending ?? []), { text, ...extra }]));
}
/** It never went out (the send failed): nothing to keep. */
function unhold(id: string, text: string) {
  updateTask(id, (x) => {
    const i = (x.pending ?? []).findIndex((p) => p.text === text);
    if (i >= 0) x.pending!.splice(i, 1);
    if (!x.pending?.length) x.pending = undefined;
  });
}
const markTaken = (kids: string[]) => {
  const at = Date.now();
  const all = new Set(kids.flatMap((k) => { const c = taskById(k); return c?.pair ? lensesOf(c).map((x) => x.id) : [k]; }));
  for (const k of all) updateTask(k, (c) => (c.taken = at));
};
/** The model took these: a subagent whose result it was is marked as heard. */
function heard(id: string, gone: { text: string; from?: string }[]) {
  if (!gone.length) return;
  updateTask(id, (x) => {
    for (const g of gone) {
      const i = (x.pending ?? []).findIndex((p) => p.text === g.text);
      if (i >= 0) x.pending!.splice(i, 1);
    }
    if (!x.pending?.length) x.pending = undefined;
  });
  markTaken(gone.flatMap((g) => (g.from ? [g.from] : [])));
}

/** A user message started in the engine: a queued one (steer, follow-up) the model now takes. */
function tookMessage(id: string, text: string) {
  const p = (taskById(id)?.pending ?? []).find((x) => text === x.text || text.startsWith(x.text));
  if (p) heard(id, [{ ...p }]);
}

const userText = (m: any): string =>
  typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("") : "";

/**
 * A finished review whose result the job never took: not waiting on the job, and no
 * turn of the job ended after it finished (a queued result is taken before a turn ends).
 * A restart that killed the engine with the result still queued leaves this.
 */
function missedReviews(t: Task): Task[] {
  return childrenOf(t.id).filter(
    (k) =>
      k.review &&
      (k.pair ? !reviewGoing(k) && lensesOf(k)[0]?.id === k.id : k.status === "done") &&
      !k.taken &&
      !(t.pending ?? []).some((p) => p.from && (p.from === k.id || (k.pair && lensesOf(k).some((x) => x.id === p.from)))) &&
      !t.inbox.some((m) => m.startsWith(resultHead(k))) &&
      !t.entries.some((e) => e.kind === "turn" && e.at > (k.finishedAt ?? 0)),
  );
}

/**
 * What a new start of the job is owed besides its inbox: what its last engine was
 * sent and never took, and (resumed) a review result it never got. `kids`: the
 * subagents whose results go in with it.
 */
function owedAtStart(t: Task, resume: boolean): { texts: string[]; kids: string[] } {
  const held = t.pending ?? [];
  const missed = resume ? missedReviews(t) : [];
  const inInbox = childrenOf(t.id).filter((k) => (k.status === "done" || k.status === "failed") && t.inbox.some((m) => m.startsWith(resultHead(k))));
  return {
    texts: [...held.map((p) => p.text), ...missed.map((k) => resultMessage(k, activeKids(t.id).length))],
    kids: [...held.flatMap((p) => (p.from ? [p.from] : [])), ...missed.map((k) => k.id), ...inInbox.map((k) => k.id)],
  };
}

/**
 * The turn ended with messages it was sent still kept: the engine's own queue says
 * which it never took (sent just as the turn ended); the rest it did. True when they
 * went in now as a prompt.
 */
async function untaken(id: string, run: Run, agent: string): Promise<boolean> {
  const held = (taskById(id)?.pending ?? []).map((p) => ({ ...p }));
  if (!held.length) return false;
  const q = await request(agent, { type: "clear_queue" }).catch(() => null);
  const queued: string[] = [...(q?.steering ?? []), ...(q?.followUp ?? [])];
  const left = held.filter((p) => queued.some((m) => m === p.text || m.startsWith(p.text)));
  heard(id, held.filter((p) => !left.some((l) => l.text === p.text)));
  if (!left.length || runs.get(id) !== run) return false;
  // handing off: they go to the next session with the card
  if (run.handoff) {
    updateTask(id, (x) => {
      x.pending = undefined;
      x.inbox.push(...left.map((p) => p.text));
    });
    return false;
  }
  // a refused review's findings among them: this is that wake-up, not one more after it
  if (left.some((p) => p.text === run.refused)) run.refused = undefined;
  try {
    run.turnStart = Date.now();
    // one by one, so each is taken (and stops being kept) on its own
    for (const p of left) await request(agent, { type: "prompt", message: p.text });
    return true;
  } catch {
    return false;
  }
}

/** A subagent ended: hand its result to the fork (now, after its turn, or on its next start). */
async function deliver(child: Task) {
  const parent = child.parentId ? taskById(child.parentId) : undefined;
  if (!parent) return;
  // 교차 검토: nothing until the other lens is over too, then one message for both
  if (child.pair && reviewGoing(child)) return;
  const memory = child.pair ? await settleMemory(parent, lensesOf(child)) : undefined;
  const left = activeKids(parent.id).length;
  const message = resultMessage(child, left, memory);
  const run = runs.get(parent.id);
  const agent = agentOf(parent.id);
  if (!run || !isAlive(agent) || parent.status === "paused" || parent.status === "done" || parent.status === "failed") {
    updateTask(parent.id, (x) => x.inbox.push(message));
    return;
  }
  // it is handing off: the result goes to the next session, which starts once all are in
  if (run.handoff || run.pendingHandoff) {
    updateTask(parent.id, (x) => x.inbox.push(message));
    if (run.pendingHandoff && !left) {
      const card = run.pendingHandoff;
      run.pendingHandoff = undefined;
      await newSession(parent.id, run, card);
    }
    return;
  }
  // a queued result dies with the engine (a restart before the turn ends): kept until taken
  hold(parent.id, message, { from: child.id });
  try {
    if (run.streaming) await request(agent, { type: "follow_up", message });
    else {
      run.turnStart = Date.now();
      updateTask(parent.id, (x) => {
        x.status = "running";
        x.now = "서브에이전트 결과 확인 중";
      });
      await request(agent, { type: "prompt", message });
    }
  } catch {
    unhold(parent.id, message);
    updateTask(parent.id, (x) => x.inbox.push(message));
  }
}

// ─────────────────────────────── worktrees

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "repo";

/** "feat/pstack-coding-rules": a type and a short ascii name, or nothing */
function branchName(b?: string) {
  const m = /^(feat|fix|docs|refactor|test|chore|build|ci|perf|style)\/([a-z0-9][a-z0-9-]{1,40})$/.exec((b ?? "").trim().toLowerCase());
  return m ? `${m[1]}/${m[2].replace(/-+$/, "")}` : undefined;
}

/** First start of a task in a git repo: give it its own worktree. Silent when the folder isn't a repo. */
/** The job had a worktree that is merged, discarded or no longer on disk. */
async function worktreeGone(t: Task): Promise<boolean> {
  const w = t.worktree;
  if (!w || t.parentId || !(t.isolate ?? state.settings.isolate)) return false;
  if (w.state !== "open") return true;
  const there = await fsRead(`${w.path}/.git`).catch(() => null);
  return !there || !!(there as { error?: string }).error;
}

/** Gives the job its own worktree. False when it can't and the job must not start
 * (a repo it would otherwise change in place). */
/** What Ondra's own git commands for a job run with: its space's git identity and logins. */
export const gitEnv = (t: Task) => spaceEnv(spaceById(t.space)).catch((): Env => []);

/** The folder is inside a git worktree (its .git is a file pointing elsewhere), not a main checkout. */
async function inWorktree(dir: string): Promise<boolean> {
  const parts = dir.replace(/\/+$/, "").split("/");
  for (let n = parts.length; n > 1 && parts.length - n < 6; n--) {
    // no .git here: look one folder up; a .git folder (can't be read as a file): a main checkout
    const f = await fsRead(`${parts.slice(0, n).join("/")}/.git`).then(
      (x) => x,
      (e) => (/파일이 없어요/.test(String(e)) ? null : "checkout"),
    );
    if (f === null) continue;
    return f !== "checkout" && typeof f.text === "string" && /^gitdir:/.test(f.text);
  }
  return false;
}

async function isolate(id: string): Promise<boolean> {
  const t = taskById(id);
  if (!t || t.parentId || !(t.isolate ?? state.settings.isolate)) return true;
  const old = t.worktree;
  if (old && !(await worktreeGone(t))) return true;
  // merged, discarded or cleaned up: more work on it starts on a fresh worktree
  // from where the repo is now, never in the user's own checkout
  const cwd = old ? `${old.repo}${old.sub ? `/${old.sub}` : ""}` : expand(t.cwd || spaceById(t.space).folder || "~");
  // already a worktree (one the user or the space's own rules made for this work): work there, no worktree of a worktree
  if (!old && (await inWorktree(cwd))) return true;
  const name = cwd.split("/").filter(Boolean).pop() ?? "repo";
  const again = old ? `-${Date.now().toString(36).slice(-4)}` : "";
  const dest = `${engine.info.dataDir}/worktrees/${slug(name)}-${id}${again}`;
  // the feature's name when main gave one; when that branch already exists (a
  // second job on the feature, or this job's own earlier branch) it gets a suffix
  const branch = branchName(t.branch) ?? `task/${id}`;
  const taken = (e: unknown) => /already exists|이미/.test(String(e instanceof Error ? e.message : e));
  try {
    const env = await gitEnv(t);
    const w = await worktreeCreate(cwd, dest, branch, env).catch((e) =>
      taken(e) ? worktreeCreate(cwd, dest, `${branch}-${Date.now().toString(36).slice(-5)}`, env) : Promise.reject(e),
    );
    updateTask(id, (x) => {
      x.worktree = { ...w, state: "open" };
      x.cwd = w.sub ? `${w.path}/${w.sub}` : w.path;
      push(x, { kind: "note", text: `작업 전용 브랜치 ${w.branch}에서 시작해요` });
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // not a repo / no commits / no folder: there is nothing to keep apart, work in the folder
    if (/저장소가 아니|커밋이 하나도|폴더가 없/.test(msg)) {
      updateTask(id, (x) => (x.isolate = false));
      return true;
    }
    // a repo: never fall back to changing the user's own checkout
    const why = msg.split("\n").map((l) => l.trim()).filter((l) => l && !/^Preparing worktree/.test(l))[0] ?? msg;
    fail(id, `작업 폴더를 만들지 못했어요: ${why}`);
    return false;
  }
}

/** Merge the task's branch into the repo's current branch, then remove the worktree. */
export async function mergeTask(id: string): Promise<boolean> {
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open") return false;
  if (t.status === "running" || t.status === "waiting") pauseTask(id);
  try {
    const env = await gitEnv(t);
    const into = await worktreeMerge(w.repo, w.path, w.branch, t.title, env);
    await worktreeRemove(w.repo, w.path, w.branch, false, env).catch(() => {});
    updateTask(id, (x) => {
      const now = Date.now();
      x.worktree = { ...w, state: "merged", into };
      x.cwd = homeDir(x);
      x.mergedAt = now;
      push(x, { kind: "note", text: `${into}에 병합 · 워크트리 정리` });
      if (x.status !== "done") {
        x.status = "done";
        x.plan = closePlan(x.plan);
        x.finishedAt = now;
        x.summary ||= `${into}에 병합`;
      }
    });
    toast(tr("{into}에 병합했어요", { into }));
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(/conflict|충돌/i.test(msg) ? tr("충돌이 있어서 병합하지 못했어요") : tr("병합하지 못했어요 · {why}", { why: msg.split("\n")[0] }), "bad");
    return false;
  }
}

/** Throw the task's changes away (worktree and branch). */
/** The pull request this job opened or worked on, if its record names one (newest wins). */
export function prOf(t: Task): { url: string; n: string } | undefined {
  const re = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    const text = e.kind === "tool" ? `${e.tool.target} ${e.tool.detail ?? ""}` : "text" in e ? String(e.text ?? "") : "";
    const all = [...text.matchAll(re)];
    if (all.length) {
      const m = all[all.length - 1];
      return { url: m[0], n: m[1] };
    }
  }
  return undefined;
}

/** A job whose work went into a pull request: remove its worktree, keep the branch (the PR needs it). */
export async function closeWorktree(id: string) {
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open") return;
  if (t.status === "running" || t.status === "waiting") pauseTask(id);
  await worktreeRemove(w.repo, w.path, w.branch, true, await gitEnv(t)).catch((e) => toast(String(e), "bad"));
  updateTask(id, (x) => {
    x.worktree = { ...w, state: "discarded" };
    x.cwd = homeDir(x);
    push(x, { kind: "note", text: "워크트리 정리 · 변경은 PR에 있어요" });
  });
}

export async function discardTask(id: string) {
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open") return;
  if (t.status === "running" || t.status === "waiting") pauseTask(id);
  await worktreeRemove(w.repo, w.path, w.branch, false, await gitEnv(t)).catch((e) => toast(String(e), "bad"));
  updateTask(id, (x) => {
    x.worktree = { ...w, state: "discarded" };
    x.cwd = homeDir(x);
    x.discardedAt = Date.now();
    push(x, { kind: "note", text: "변경을 버렸어요" });
  });
}

export async function startTask(id: string, resume = false, rewind?: { from: string; message: string }) {
  if (!taskById(id)) return;
  // claim the slot right away; making the worktree takes a moment and the scheduler may run again
  updateTask(id, (t) => {
    t.status = "running";
    t.startedAt ??= Date.now();
    t.now = "준비 중";
    t.pausedBy = undefined;
  });
  // resuming after its worktree went away would carry on in the user's own
  // checkout with the old paths in mind: go on in a fresh session on a new worktree
  const before = taskById(id);
  if (resume && before && !before.answer && (await worktreeGone(before))) {
    resume = false;
    updateTask(id, (t) => {
      const last = t.legs[t.legs.length - 1];
      if (last && !last.endedAt) last.endedAt = Date.now();
    });
  }
  const carries = taskById(id)?.follows;
  if (!resume && carries && !taskById(id)?.worktree && finished(taskById(carries))) takeBranch(id, carries);
  // carrying on in a folder another finished job's branch lives in (a sibling of the job it follows)
  if (!resume) claimBranch(id);
  // it had already said done when Ondra went down: it is over, don't prompt it again
  const said = taskById(id);
  if (resume && said?.saidDone && !unread(said).length && !said.pending?.length) {
    finish(id, said.saidDone);
    return;
  }
  if (!resume && !taskById(id)?.answer && !(await isolate(id))) return;
  const t0 = taskById(id);
  if (!t0) return;
  const agent = agentOf(id);
  const account = spaceAccount(t0.space, t0.topic, t0.accountId);
  if (!account) return fail(id, tr(NO_ACCOUNT));
  if (account.id !== t0.accountId) updateTask(id, (x) => (x.accountId = account.id));
  const cwd = expand(t0.cwd || spaceById(t0.space).folder || "~");
  const prev = runs.get(id);

  updateTask(id, (t) => {
    t.status = "running";
    t.error = undefined;
    t.cwd = cwd;
    t.startedAt ??= Date.now();
    t.finishedAt = undefined;
    if (!t.legs.length || t.legs[t.legs.length - 1].endedAt) t.legs.push({ startedAt: Date.now() });
    t.now = resume ? "이어서 작업 중" : "시작 중";
    t.intent = undefined;
  });

  const run: Run = { text: "", cursor: 0, streaming: false, asked: false, turnStart: 0, stats: zero(), tools: new Map(), modelTries: prev?.modelTries ?? 0 };
  runs.set(id, run);
  listen(agent, handlers(id, run));
  clearStderr(agent);

  try {
    const t0 = taskById(id)!;
    const t = t0;
    const env = [...(await workerEnv(id, t0.space)), ...(await accountEnv(account.id)), ...(await spaceEnv(spaceById(t0.space))), ["ONDRA_PERMISSION", t0.permission ?? "edits"] as [string, string], ["ONDRA_SPACE", t0.space] as [string, string], ["ONDRA_GITHUB_WRITE", state.settings.githubWrite === false ? "0" : "1"] as [string, string], ["ONDRA_DEVICES_ALLOWED", allowedDevices(t0.space, id).join(",")] as [string, string], ...dataEnv(t0), ...(spaceById(t0.space).aside?.trim() ? [["ONDRA_ASIDE_ACCOUNT", spaceById(t0.space).aside!.trim()] as [string, string]] : [])];
    env.push(["ONDRA_SKILL_PATHS", JSON.stringify(await skillPaths(t0.space))]);
    const model = t.model || modelFor(account.id);
    // a model without tool calling (marked on its connection) runs talk-only instead of failing on its first request
    const talkOnly = !canUseTools(account.id, model);
    if (talkOnly && !resume) updateTask(id, (x) => void push(x, { kind: "note", text: "이 모델은 도구를 못 써서 대화만 해요" }));
    await prepareQuery(relatedQuery(t));
    // the memory given at the first start is kept for every later session (Hermes / Letta:
    // a stable prompt); later saves reach the next job
    if (!t0.memorySnapshot) {
      const picked = relatedMemory(t);
      markUsed(picked.map((m) => m.id));
      updateTask(id, (x) => (x.memorySnapshot = memoryLines(picked)));
    }
    const args = [
      "--session-dir",
      `${engine.info.dataDir}/sessions/${id}`,
      ...taskSystem(t, t.project && !t.parentId ? await readNotes(t.project) : undefined).flatMap((p) => ["--append-system-prompt", p]),
      // The search extension owns discovery; Pi must not advertise a catalog.
      "--no-skills",
      ...(model ? ["--model", model] : []),
      "--thinking",
      t.thinking || effortFor(account.id, model) || "high",
      ...(await workerExtensions()).flatMap((e) => ["--extension", e]),
      ...(talkOnly ? ["--no-tools"] : [...workerTools(), ...offTools()]),
      ...(resume ? ["--continue"] : []),
    ];
    await agentSpawn(agent, cwd, args, env);
    markAlive(agent);
    const fresh = taskById(id)!;
    // a resumed session already has totals; only what happens from here counts
    // (asking also learns the model's context window, which sets the handoff point)
    if (resume) run.stats = await rawStats(agent);
    else void rawStats(agent);
    if (rewind) {
      updateTask(id, (x) => ((x.inbox = []), (x.pending = undefined)));
      await forkAt(agent, rewind.from);
      run.stats = await rawStats(agent);
      await request(agent, { type: "prompt", message: rewind.message });
      return;
    }
    // the command the restart cut off (not a time limit: commands have none unless given one)
    const cut = fresh.shells.filter((s) => !s.endedAt && !s.background).pop()?.command.replace(/\s+/g, " ").slice(0, 160);
    const bg = backgroundShells(fresh.shells);
    if (resume) updateTask(id, (x) => closeOpen(x));
    // answers it already acted on before the restart aren't news
    const handled = new Set(fresh.entries.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text));
    // what the last engine was sent and never took (a restart killed it with them queued)
    const owed = owedAtStart(fresh, resume);
    const fresh2 = unread(fresh).filter((m) => !(fresh.pending ?? []).some((p) => (p.shown ?? p.text) === m));
    for (const m of fresh2) handled.delete(m);
    const given = { ...fresh, inbox: [...fresh.inbox, ...owed.texts.filter((m) => !fresh.inbox.includes(m))] };
    const message = resume
      ? [
          `(Ondra가 다시 시작됐어요. ${cut ? `그때 돌던 명령 \`${cut}\`은 재시작 때문에 끊겼어요. 시간 제한 때문이 아니니 제한이 있다고 여기지 말고, 필요하면 그 로그부터 보고 다시 돌리세요.` : "돌던 명령이 끊겼으면 그 로그부터 확인하세요."}${bg.length ? ` 백그라운드로 띄운 ${bg.map((c) => `\`${c}\``).join(", ")}는 아직 돌 수도, 꺼졌을 수도 있어요. 기다리기 전에 한 번만 확인하고(URL에 curl -m 5, 저장한 pid에 kill -0) 꺼졌으면 다시 띄우세요.` : ""} 하던 일을 이어서 하세요. 이미 보낸 plan은 다시 보내지 마세요.)`,
          ...[...fresh2, ...owed.texts, ...fresh.inbox.filter((m) => !handled.has(m))].filter((m, i, all) => all.indexOf(m) === i).map((m) => `- ${m}`),
        ].join("\n")
      : fresh.legs.length > 1
        ? handoffPrompt(given)
        : taskPrompt(given);
    updateTask(id, (x) => {
      x.inbox = [];
      x.pending = undefined;
    });
    markTaken(owed.kids);
    await request(agent, { type: "prompt", message });
  } catch (e) {
    fail(id, e instanceof Error ? e.message : String(e));
  }
}

/**
 * What the job started in the background (a dev server, a watcher), newest
 * first: after a restart it may still run or be gone, and the job checks once
 * instead of waiting on its log.
 */
export function backgroundShells(shells: Shell[], max = 3): string[] {
  const out: string[] = [];
  for (const s of [...shells].reverse()) {
    if (!s.background) continue;
    const c = s.command.replace(/\s+/g, " ").trim().slice(0, 120);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Messages the job was sent that it never got to: the user's words after its last
 * output. A message steered in while it worked dies with the process when Ondra
 * restarts, so a resumed session is given them again.
 */
export function unread(t: Task): string[] {
  let i = t.entries.length - 1;
  while (i >= 0 && t.entries[i].kind !== "text" && t.entries[i].kind !== "tool" && t.entries[i].kind !== "block") i--;
  return t.entries.slice(i + 1).flatMap((e) => (e.kind === "user" ? [e.text] : []));
}

/**
 * The job is over: its tab in the shared browser goes (the logins stay), and a
 * simulator or emulator it made and didn't shut down goes a few minutes later
 * (a follow-up message in that time still finds it).
 */
const releaseBrowser = (id: string) => {
  const t = taskById(id);
  if (t?.browser) void browserRelease(id, t.space);
  releaseDevicesSoon();
};
const DEVICE_GRACE_MS = 5 * 60_000;
let deviceSweep: ReturnType<typeof setTimeout> | undefined;
export function releaseDevicesSoon(ms = DEVICE_GRACE_MS) {
  clearTimeout(deviceSweep);
  deviceSweep = setTimeout(() => {
    const keep = state.tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "waiting").map((t) => t.id);
    void jobDevicesRelease(keep).then((gone) => gone.length && void refreshDevices());
  }, ms);
}

function fail(id: string, message: string) {
  runs.delete(id);
  agentKill(agentOf(id));
  markDead(agentOf(id));
  setLive(id, "");
  updateTask(id, (t) => {
    closeOpen(t);
    t.status = "failed";
    t.unread = true;
    t.error = explain(message);
    t.now = "실패";
    push(t, { kind: "error", text: explain(message) });
  });
  releaseBrowser(id);
  const t = taskById(id);
  if (t?.parentId) void deliver(t);
  else if (t) endedHook?.(t);
}

function handlers(id: string, run: Run) {
  const agent = agentOf(id);
  return {
    event(ev: any) {
      if (runs.get(id) !== run) return;
      switch (ev.type) {
        case "agent_start":
          run.streaming = true;
          run.turnStart ||= Date.now();
          break;
        case "message_start":
          // a message it was sent goes into the conversation: the model has it now
          if (ev.message?.role === "user") tookMessage(id, userText(ev.message));
          if (ev.message?.role === "assistant") {
            run.text = "";
            run.cursor = 0;
            run.msgAt = Date.now();
            const es = taskById(id)?.entries;
            run.msgAfter = es?.[es.length - 1]?.id;
          }
          break;
        case "message_update": {
          const d = ev.assistantMessageEvent;
          if (d?.type !== "text_delta" || !d.delta) break;
          run.text += d.delta;
          setLive(id, prose(run.text));
          const { items, end } = readFences(run.text, "blocks", run.cursor);
          if (items.length) {
            run.cursor = end;
            updateTask(id, (t) => applyBlocks(t, items, run));
          }
          break;
        }
        case "message_end": {
          if (ev.message?.role !== "assistant") break;
          if (run.msgAt) run.genMs = (run.genMs ?? 0) + (Date.now() - run.msgAt);
          run.msgAt = undefined;
          const { items } = readFences(run.text, "blocks", run.cursor);
          const text = prose(run.text);
          batch(() => {
            setLive(id, "");
            updateTask(id, (t) => {
              if (text) {
                // above the blocks it streamed, so a heading stays over the files it introduces
                const at = run.msgAfter ? t.entries.findIndex((e) => e.id === run.msgAfter) + 1 : -1;
                push(t, { kind: "text", text: text.slice(0, 20000) });
                if (at > 0 && at < t.entries.length - 1) t.entries.splice(at, 0, t.entries.pop()!);
              }
              if (items.length) applyBlocks(t, items, run);
              if (ev.message?.stopReason === "error" && ev.message?.errorMessage) run.error = String(ev.message.errorMessage);
            });
          });
          run.cursor = run.text.length;
          // narration slipping into English for a Korean user: one reminder per session
          if (run.streaming && !run.langNudged && text && notTheirLanguage(text, taskById(id))) {
            run.langNudged = true;
            void request(agentOf(id), { type: "steer", message: "(Ondra) The lines between your tool calls are read by the user: write them in Korean (\"이제 사진을 올려요\"), not English." }).catch(() => {});
          }
          const u = ev.message?.usage;
          noteCall(agentOf(id), u);
          const prompt = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
          // near the model's own context window: ask for a handoff (see handoff.ts)
          const level = run.longNudges ?? 0;
          const job = taskById(id);
          const win = ctx[agentOf(id)]?.window || windowFor(job?.model || (job ? modelFor(job.accountId) : undefined));
          const at = handoffAt(win);
          if (run.streaming && level < at.length && prompt > at[level] && !run.done && !run.handoff) {
            run.longNudges = level + 1;
            void request(agentOf(id), { type: "steer", message: handoffSteer(level, prompt, win) }).catch(() => {});
          }
          break;
        }
        case "tool_execution_start": {
          // it went on after a refused review: the steer reached it
          run.refused = undefined;
          const tool = describeTool(ev.toolName, ev.args);
          updateTask(id, (t) => {
            const { now, ...call } = tool;
            if (ev.toolName === "bash") {
              call.shellId = ev.toolCallId;
              t.shells.push({ id: ev.toolCallId, command: call.detail ?? call.target, startedAt: Date.now(), tail: "", background: keepsRunning(call.detail ?? "") });
              if (t.shells.length > MAX_SHELLS) t.shells.splice(0, t.shells.length - MAX_SHELLS);
            }
            if (call.kind === "browser") t.browser = true;
            t.now = now;
            run.tools.set(ev.toolCallId, push(t, { kind: "tool", tool: call }));
          });
          break;
        }
        case "tool_execution_update": {
          const tail = typeof ev.tail === "string" ? ev.tail : ev.partialResult?.content?.find?.((c: any) => c.type === "text")?.text;
          if (typeof tail !== "string") break;
          updateTask(id, (t) => {
            const sh = t.shells.find((s) => s.id === ev.toolCallId);
            if (!sh) return;
            if (sh.tail !== tail.slice(-TAIL)) (run.changed ??= new Map()).set(ev.toolCallId, Date.now());
            sh.tail = tail.slice(-TAIL);
          });
          break;
        }
        case "tool_execution_end": {
          const entryId = run.tools.get(ev.toolCallId);
          run.tools.delete(ev.toolCallId);
          const out = ev.result?.content?.find?.((c: any) => c.type === "text")?.text;
          const done = taskById(id)?.entries.find((x) => x.id === entryId);
          if (done?.kind === "tool") loopGuard(id, run, done.tool, !ev.isError);
          // a fork's plan that stopped moving: ask where it is. Subagents and reviews
          // aren't asked (their list is short-lived), and a fork at most twice a session:
          // 225 reminders in 312 sessions bought a status line, not a fix.
          run.quietTools = (run.quietTools ?? 0) + 1;
          const job = taskById(id);
          const plan = job?.plan ?? [];
          if (run.streaming && !job?.parentId && run.quietTools >= PLAN_QUIET && (run.planNudges ?? 0) < PLAN_NUDGES && plan.some((s) => s.state !== "done")) {
            run.quietTools = 0;
            run.planNudges = (run.planNudges ?? 0) + 1;
            void request(agentOf(id), { type: "steer", message: `(Ondra) Your to-do list hasn't moved for a while. Current list:\n${plan.map((s, i) => `${i}. [${s.state}] ${s.text}`).join("\n")}\nSend a now block with the step you are on (finished steps before it count as done), or a new plan if it changed.` }).catch(() => {});
          }
          // a job booted or shut down a phone: the hub and the sidebar show it now
          if (done?.kind === "tool" && done.tool.name === "device") void refreshDevices();
          // the shared browser stopped answering: check it now and restart it if it hangs
          if (ev.isError && done?.kind === "tool" && done.tool.kind === "browser" && typeof out === "string" && /Failed to read|os error 35|no response came back|daemon.*(not|no) respon/i.test(out)) recheckBrowser(taskById(id)?.space ?? state.space);
          updateTask(id, (t) => {
            const e = t.entries.find((x) => x.id === entryId);
            if (e?.kind === "tool") {
              e.tool.ok = !ev.isError;
              e.tool.endedAt = Date.now();
              const shot = e.tool.detail && !ev.isError ? screenshotIn(e.tool.detail) : undefined;
              if (shot) t.shot = shot;
            }
            const sh = t.shells.find((s) => s.id === ev.toolCallId);
            if (sh) {
              sh.endedAt = Date.now();
              sh.ok = !ev.isError;
              if (typeof out === "string") sh.tail = out.slice(-TAIL);
            }
          });
          break;
        }
        case "compaction_start":
          updateTask(id, (t) => push(t, { kind: "note", text: "컨텍스트 압축 중" }));
          break;
        case "auto_retry_start":
          updateTask(id, (t) => push(t, { kind: "note", text: `재시도 ${ev.attempt ?? ""}/${ev.maxAttempts ?? ""}` }));
          break;
        case "extension_ui_request":
          if (["select", "confirm", "input"].includes(ev.method)) uiDecision(id, ev);
          break;
        case "agent_settled":
          run.streaming = false;
          run.ended = true;
          if (run.turnStart) {
            const ms = Date.now() - run.turnStart;
            run.turnStart = 0;
            run.turnMs = ms;
            if (ms > 1500) updateTask(id, (t) => push(t, { kind: "turn", ms }));
            void import("../state/artifacts").then((m) => m.loadArtifacts(id));
          }
          void settle(id, run);
          break;
      }
    },
    exit(code: number | null) {
      markDead(agent);
      const t = taskById(id);
      if (t && runs.get(id) === run && (t.status === "running" || t.status === "waiting")) {
        const tail = stderrOf(agent).split("\n").filter(Boolean).slice(-2).join(" · ");
        fail(id, tail || `엔진 종료 (코드 ${code ?? "?"})`);
      }
    },
  };
}

function uiDecision(id: string, ev: any) {
  const options =
    ev.method === "confirm"
      ? [
          { id: "yes", label: "허용", primary: true },
          { id: "no", label: "거부" },
        ]
      : ev.method === "select"
        ? (ev.options ?? []).map((o: string, i: number) => ({ id: o, label: o, primary: i === 0 }))
        : [{ id: "cancel", label: "취소" }];
  const d: Decision = {
    id: uid("d"),
    taskId: id,
    at: Date.now(),
    kind: "ask",
    question: [ev.title, ev.message].filter(Boolean).join(" — ") || "확인 필요",
    options,
    context: [],
    ui: { requestId: ev.id, method: ev.method },
  };
  setState("decisions", (list) => [...list, d]);
  updateTask(id, (t) => {
    t.status = "waiting";
    t.unread = true;
  });
}

/**
 * After the page reloads (⌘R, a dev hot reload) jobs keep running in the engine,
 * but nothing here listens to them: their answers and their end are lost and the
 * job looks stuck. Listen again, and catch up on a turn that ended unheard.
 */
export async function reattachJobs() {
  // devices left by jobs that ended while the app was closed
  releaseDevicesSoon(60_000);
  for (const t of state.tasks.filter((t) => (t.status === "running" || t.status === "waiting") && !runs.get(t.id))) {
    const id = t.id;
    const agent = agentOf(id);
    if (!isAlive(agent)) continue;
    const run: Run = { text: "", cursor: 0, streaming: false, asked: false, turnStart: 0, stats: zero(), tools: new Map(), modelTries: 0 };
    runs.set(id, run);
    const h = handlers(id, run);
    listen(agent, h);
    const st = await request(agent, { type: "get_state" }, 8000).catch(() => null);
    // count from what this session's finished turns recorded, so the turn that was
    // going on when the app reloaded is counted in full when it settles
    const cur = await rawStats(agent);
    const since = t.legs[t.legs.length - 1]?.startedAt ?? 0;
    const seen = zero();
    for (const e of t.entries) if (e.kind === "turn" && e.usage && e.at >= since) for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) seen[k] += e.usage[k];
    run.stats = { input: Math.min(seen.input, cur.input), output: Math.min(seen.output, cur.output), cacheRead: Math.min(seen.cacheRead, cur.cacheRead), cacheWrite: Math.min(seen.cacheWrite, cur.cacheWrite) };
    if (!st) continue;
    // mid-turn (a question on screen is mid-turn too): its own events carry on from here
    if (st.isStreaming || st.isCompacting) {
      run.streaming = true;
      run.turnStart = Date.now();
      continue;
    }
    const now = taskById(id);
    if (!now || now.status !== "running" || runs.get(id) !== run || run.streaming || run.ended || waitsOnKids(now)) continue;
    // idle while "running": the turn ended unheard. Its last answer, unless it was heard before the reload.
    const msgs: any[] = (await request(agent, { type: "get_messages" }, 15000).catch(() => null))?.messages ?? [];
    if (runs.get(id) !== run || run.streaming || run.ended) continue;
    const last = [...msgs].reverse().find((m) => m?.role === "assistant");
    const at = Number(last?.timestamp ?? 0);
    const text = Array.isArray(last?.content) ? last.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("") : "";
    const entries = taskById(id)?.entries ?? [];
    const heard = !last || (at ? entries.some((e) => (e.at ?? 0) >= at) : entries.some((e) => e.kind === "text" && e.text === prose(text).slice(0, 20000)));
    if (!heard && text) {
      h.event({ type: "message_start", message: { role: "assistant" } });
      h.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      h.event({ type: "message_end", message: last });
    }
    h.event({ type: "agent_settled" });
  }
}

async function carryOnWhenOnline(id: string, run: Run, agent: string, err: string) {
  run.netTries = (run.netTries ?? 0) + 1;
  updateTask(id, (x) => {
    x.now = "연결 기다리는 중";
    if (run.netTries === 1) push(x, { kind: "note", text: "연결이 끊겼어요 · 다시 연결되면 이어서 해요" });
  });
  await waitOnline(run.netTries);
  // stopped, removed or restarted while it waited
  if (runs.get(id) !== run || taskById(id)?.status !== "running") return;
  run.turnStart = Date.now();
  await request(agent, { type: "prompt", message: "(Ondra) The connection dropped in the middle of your turn and is back now. Carry on from where you stopped; redo the last step only if it didn't finish." }).catch((e) =>
    fail(id, `${err} · ${e instanceof Error ? e.message : String(e)}`),
  );
}

async function settle(id: string, run: Run) {
  const agent = agentOf(id);
  const t = taskById(id);
  if (!t || runs.get(id) !== run) return;
  const before = run.stats;
  run.stats = await collectStats(agent, t.accountId, run.stats);
  await refreshLimits(t.accountId, true);
  const used = turnUsage(before, run.stats, t.accountId, run.genMs, run.turnMs);
  run.genMs = 0;
  run.turnMs = undefined;
  if (used)
    updateTask(id, (x) => {
      const last = [...x.entries].reverse().find((e) => e.kind === "turn" || e.kind === "user");
      if (last?.kind === "turn" && !last.usage) last.usage = used;
      else push(x, { kind: "turn", ms: 0, usage: used });
    });

  // A connection's model turned out to have no tool calling: mark it so and start over talk-only.
  const tm = t.model || modelFor(t.accountId);
  const row = connModel(t.accountId, tm);
  if (run.error && row?.tools && toolsRefused(run.error) && run.modelTries < 4) {
    run.modelTries++;
    updateAccount(t.accountId, (a) => {
      const m = a.connection?.models.find((x) => x.id === row.id);
      if (m) m.tools = false;
    });
    updateTask(id, (x) => {
      x.entries = x.entries.filter((e) => e.kind !== "turn");
      push(x, { kind: "note", text: "이 모델은 도구를 못 써요 · 대화만 하도록 다시 시작해요" });
      x.legs = x.legs.slice(0, -1);
    });
    agentKill(agent);
    markDead(agent);
    void startTask(id, false);
    return;
  }
  // The provider rejected the model: switch and start over (nothing ran yet).
  if (run.error && isModelError(run.error) && run.modelTries < 4) {
    run.modelTries++;
    const failed = failedModelIn(run.error) ?? t.model ?? modelFor(t.accountId);
    if (t.model) updateTask(id, (x) => (x.model = undefined));
    const next = await nextModel(t.accountId, failed);
    if (next) {
      updateTask(id, (x) => {
        x.entries = x.entries.filter((e) => e.kind !== "turn");
        push(x, { kind: "note", text: `모델 변경 → ${next}` });
        x.legs = x.legs.slice(0, -1);
      });
      agentKill(agent);
      markDead(agent);
      void startTask(id, false);
      return;
    }
  }
  // the connection dropped (lid closed, Wi-Fi gone): wait for it and carry on in the same session
  if (run.error && isNetError(run.error) && !run.done && !run.handoff && !run.asked && (run.netTries ?? 0) < 40) {
    const err = run.error;
    run.error = undefined;
    void carryOnWhenOnline(id, run, agent, err);
    return;
  }
  if (run.error && !run.done && !run.handoff && !run.asked) {
    fail(id, run.error);
    return;
  }
  run.error = undefined;
  run.netTries = 0;
  // sent while it worked and not taken by the turn's end: they go in now
  if (await untaken(id, run, agent)) return;

  if (run.asked) {
    run.asked = false;
    updateTask(id, (x) => {
      x.status = "waiting";
      x.unread = true;
    });
    drainQueue(id);
    return;
  }
  if (run.done !== undefined) {
    const missing = (run.gates ?? 0) >= 2 || t.parentId || t.handedOn ? null : await proofMissing(t, run);
    if (missing) {
      run.gates = (run.gates ?? 0) + 1;
      const summary = run.done;
      run.firstDone ??= summary;
      run.done = undefined;
      updateTask(id, (x) => {
        x.saidDone = undefined;
        x.now = "증거를 채우는 중";
        push(x, { kind: "note", text: `확인 필요 · ${missing.label}` });
      });
      try {
        run.turnStart = Date.now();
        await request(agent, { type: "prompt", message: missing.ask });
      } catch {
        finish(id, run.firstDone ?? summary, run);
      }
      return;
    }
    // the done after a send-back only covers the missing proof; the first one says what the job did
    finish(id, run.firstDone ?? run.done, run);
    return;
  }
  if (run.handoff) {
    const card = run.handoff;
    run.handoff = undefined;
    // subagents still at work: the new session starts once their results are in
    if (activeKids(id).length) {
      run.pendingHandoff = card;
      updateTask(id, (x) => {
        x.status = "running";
        x.now = `서브에이전트 ${activeKids(id).length}개 기다리는 중`;
      });
      return;
    }
    // a "handoff" that only waits on the user: no new session, the job waits for the answer
    if (onlyWaits(card)) {
      updateTask(id, (x) => {
        x.status = "waiting";
        x.unread = true;
        x.now = card.next.slice(0, 80);
      });
      return;
    }
    await newSession(id, run, card);
    return;
  }
  // Subagents still working: wait for them; their results wake it up.
  if (activeKids(id).length) {
    updateTask(id, (x) => {
      x.status = "running";
      x.now = `서브에이전트 ${activeKids(id).length}개 기다리는 중`;
    });
    return;
  }
  // It ended its turn waiting for a review that was refused: no result will wake it, so say why now
  if (run.refused) {
    const message = run.refused;
    run.refused = undefined;
    try {
      run.turnStart = Date.now();
      await request(agent, { type: "prompt", message });
      return;
    } catch {
      // fall through to the stalled card
    }
  }
  // Stopped without done / handoff / ask.
  // its last words wait on the user ("병합해 주세요", "알려주시면 이어갈게요"): it needs an answer, not "finished?"
  const said = lastWords(t);
  if (said && waitsOnUser(said)) {
    if (drainQueue(id)) return;
    updateTask(id, (x) => {
      x.status = "waiting";
      x.unread = true;
      x.now = lastReport(x) ?? "답을 기다리는 중";
    });
    return;
  }
  // asked once whether it is finished before the user is
  // (a finished job often just forgets the done block)
  if (drainQueue(id)) return;
  if (!run.askedDone) {
    run.askedDone = true;
    try {
      run.turnStart = Date.now();
      await request(agent, {
        type: "prompt",
        message: "(Ondra) Your turn ended without a done block. If the work is finished, send the done block now with the final answer (don't repeat the work). If it isn't, carry on with the next step; if you need the user, send an ask block.",
      });
      return;
    } catch {
      // fall through
    }
  }
  const d: Decision = {
    id: uid("d"),
    taskId: id,
    at: Date.now(),
    kind: "stalled",
    question: "끝났다는 말 없이 멈췄어요",
    options: [
      { id: "finish", label: "완료로 표시", primary: true },
      { id: "continue", label: "계속 진행" },
    ],
    context: [],
  };
  // queued words come first: they're what to do next
  if (drainQueue(id)) return;
  setState("decisions", (list) => [...list.filter((x) => x.taskId !== id), d]);
  updateTask(id, (x) => {
    x.status = "waiting";
    x.unread = true;
  });
}

/** A handoff card whose only next step is waiting (for the user, a result, a review). */
export function onlyWaits(card: Handoff): boolean {
  const next = (card.next ?? "").trim();
  return (
    !!next &&
    next.length <= 160 &&
    /(wait|기다|(답|응답|결과|리뷰)[이가을를]? (오면|받으면))/i.test(next) &&
    !/(고치|고쳐|만들|돌리|돌려|올리|올려|배포|수정|추가|작성|머지|푸시|\b(fix|build|run|push|deploy|write|implement|merge)\b)/i.test(next)
  );
}

/** Start a fresh session on the handoff card (and the results that came in meanwhile). */
async function newSession(id: string, run: Run, card: Handoff) {
  const agent = agentOf(id);
  run.longNudges = 0;
  updateTask(id, (x) => {
    const leg = x.legs[x.legs.length - 1];
    if (leg) {
      leg.endedAt = Date.now();
      leg.handoff = card;
    }
    x.legs.push({ startedAt: Date.now() });
    x.status = "running";
    x.now = "새 세션으로 이어가는 중";
    push(x, { kind: "handoff", leg: x.legs.length, handoff: card });
  });
  try {
    run.turnStart = Date.now();
    await request(agent, { type: "new_session" });
    const t = taskById(id)!;
    const owed = owedAtStart(t, false);
    await request(agent, { type: "prompt", message: handoffPrompt({ ...t, inbox: [...t.inbox, ...owed.texts.filter((m) => !t.inbox.includes(m))] }) });
    updateTask(id, (x) => {
      x.inbox = [];
      x.pending = undefined;
    });
    markTaken(owed.kids);
  } catch (e) {
    fail(id, e instanceof Error ? e.message : String(e));
  }
}

let endedHook: ((t: Task) => void) | undefined;
/** Main listens here: a job it started has ended (done or failed). */
export const onJobEnded = (f: (t: Task) => void) => (endedHook = f);

/**
 * Before done: changed code needs a review whose P1/P2 got fixed, and every piece of
 * evidence must hold up against the session (ran here, passed, nothing changed after,
 * files exist). Otherwise the job is sent back with exactly what's wrong (twice at most).
 */
/** The job already sent its work out (pushed, merged, released, submitted to a store). */
export function shipped(t: Task): boolean {
  return t.entries.some(
    (e) =>
      e.kind === "tool" &&
      /\bgit push\b|\bgh pr merge\b|\bgh release create\b|\beas submit\b|\bfastlane\b|\basc\b[^\n]*\b(submit|review)|검토를 위해 변경사항 전송|심사.{0,6}제출/.test(`${e.tool.target} ${e.tool.detail ?? ""}`),
  );
}

/** the job edited code files itself (not notes, data or its artifacts) */
function editedCode(t: Task): boolean {
  return t.entries.some((e) => e.kind === "tool" && (e.tool.kind === "edit" || e.tool.kind === "write") && e.tool.ok !== false && isCodeFile((e.tool.detail ?? "").split("\n")[0], t) && !/\.html?$/i.test(e.tool.detail ?? ""));
}

/** a finished review of the job this carries on (or the one before it) */
function reviewedBefore(t: Task): Task | undefined {
  let prev = t.follows ? taskById(t.follows) : undefined;
  for (let i = 0; prev && i < 3; i++) {
    const r = state.tasks.find((x) => x.parentId === prev!.id && x.review && x.status === "done");
    if (r) return r;
    // an earlier job's review only counts when the jobs in between didn't change code either
    if (editedCode(prev)) return undefined;
    prev = prev.follows ? taskById(prev.follows) : undefined;
  }
  return undefined;
}

/** the job's last words to the user, without its blocks */
function lastText(t: Task): string {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    if (e.kind === "text") return e.text.replace(/```blocks[\s\S]*?```/g, "");
    if (e.kind === "user") return "";
  }
  return "";
}

/**
 * Evidence that sends the job back: a run that never happened or failed, a file that
 * isn't there, a screenshot from before the last code change (what it shows is old).
 * A run from before the last edit and a link not opened here are only listed as
 * unverified on the card: 13 send-backs for them in Nov 5–9 cost 37 turns and led
 * to one fix.
 */
export const blocking = (e: Evidence) => e.check === "no-run" || e.check === "failed" || e.check === "missing" || (e.kind === "shot" && e.check === "stale");

async function proofMissing(t: Task, run: Run): Promise<{ label: string; ask: string } | null> {
  // "done" that still promises the work for later
  if (promisesLater(run.done ?? ""))
    return {
      label: "남은 작업 있음",
      ask: "끝냈다고 했는데 요약이 앞으로 할 일이에요. 그 일을 지금 끝내고 done으로 끝내 줘. 지금 할 수 없으면 무엇이 막혔는지 사용자에게 묻거나, 못 한 걸 unverified에 적고 요약은 실제로 한 것만 적어 줘.",
    };
  const wrote = t.entries.filter((e) => e.kind === "tool" && (e.tool.kind === "edit" || e.tool.kind === "write") && e.tool.ok !== false && !e.tool.note);
  if (!wrote.length) return null; // looked things up, answered: nothing to prove
  // the job's code: not its notes, data, or what it wrote in the artifacts folder (reports and their scripts)
  const code = (p: string) => isCodeFile(p, t) && !/\.html?$/i.test(p);
  const changed = wrote.some((e) => e.kind === "tool" && code((e.tool.detail ?? "").split("\n")[0]));
  // a review is required only for a risky change (security, money, data loss), as the prompt says
  const codeFiles = new Set(wrote.map((e) => (e.kind === "tool" ? (e.tool.detail ?? "").split("\n")[0].trim() : "")).filter((p) => p && code(p)));
  const risky = riskyChange(codeFiles);
  // once it went out, a review can't change what shipped: say so instead of sending the job back
  const out = shipped(t);
  const needsReview = changed && risky && !out;
  if (changed && risky && out && !state.tasks.some((x) => x.parentId === t.id && x.review && x.status === "done"))
    run.unverified = [...(run.unverified ?? []), "리뷰 없이 내보냈어요"];
  const kids = state.tasks.filter((x) => x.parentId === t.id);
  const reviewed = !needsReview || reviewSettled(kids);
  const reviewing = !reviewed && kids.some((x) => x.review && reviewGoing(x));
  const unresolved = changed && reviewed && !out && reviewUnresolved(t, kids);
  // check the evidence of this done against the session, and show the result on its block
  const checked = await checkEvidence(t, run.evidence ?? []);
  run.evidence = checked;
  updateTask(t.id, (x) => {
    for (let i = x.entries.length - 1; i >= 0; i--) {
      const e = x.entries[i];
      if (e.kind === "block" && e.block.type === "evidence") {
        e.block.items = e.block.items.map((it) => checked.find((c) => c.kind === it.kind && c.ref === it.ref) ?? it);
        break;
      }
    }
  });
  // stale runs and unopened links don't send the job back; finish lists every `why` as unverified
  const bad = checked.filter((e) => e.why && blocking(e));
  const soft = checked.filter((e) => e.why && !blocking(e));
  const proven = checked.some((e) => !e.why) || soft.length > 0 || (run.unverified ?? []).length > 0;
  // the answer says it looked at the screen: something in the session has to show it did
  const said = [run.done ?? "", lastText(t)].join("\n");
  const claim = unbackedClaim(t, said, checked, run.unverified ?? []);
  const needs = [changed && !reviewed && "리뷰", unresolved && "리뷰 지적", !proven && "증거", bad.length && "증거 안 맞음", claim && "확인 안 한 말"].filter(Boolean) as string[];
  if (!needs.length) return null;
  const lines = [
    "끝내기 전에 빠진 게 있어요.",
    changed && !reviewed
      ? reviewing
        ? "- 교차 검토가 아직 끝나지 않았어요. 다른 리뷰를 띄우지 말고 턴을 끝내 기다렸다가, 결과가 오면 고치고 끝내 줘."
        : "- 코드를 바꿨는데 리뷰를 안 받았어요. 교차 검토({\"type\":\"subagent\",\"review\":true,…})를 한 번 띄우고 결과를 받아 고쳐 줘."
      : "",
    unresolved ? "- 리뷰에서 P1·P2가 나왔는데 그 뒤로 고친 게 없어요. 고치고, 고친 걸 다시 확인해 줘." : "",
    !proven ? "- done에 evidence가 없어요. 실제로 돌린 테스트·빌드·실행·스크린샷을 evidence에 넣고, 확인 못 한 건 unverified에 적어 줘." : "",
    claim
      ? claim.why.startsWith("unverified")
        ? `- 답에는 "${claim.claim}"라고 했는데 ${claim.why}. 둘 중 맞는 쪽으로 고쳐 줘: 둘 다 맞으면 unverified에 무엇을 확인 못 했는지 정확히 적어.`
        : `- 답에 "${claim.claim}"라고 했는데 ${claim.why}. 지금 실제로 화면에서 확인하고 스크린샷을 evidence에 넣거나, 답에서 그 말을 빼고 unverified에 적어 줘.`
      : "",
    ...bad.map((e) => `- evidence «${e.ref}»: ${e.why}. ${e.check === "missing" ? "파일을 실제로 만들거나 경로를 고쳐 줘." : e.kind === "shot" ? "지금 화면을 다시 찍어 그 사진을 넣어 줘." : "지금 실제로 돌리고 그 결과를 적어 줘."}`),
    "안 해 본 걸 했다고 하지 말고, 못 한 건 unverified에 적은 뒤 다시 done으로 끝내 줘.",
  ];
  return { label: `${needs.join(" · ")}`, ask: lines.filter(Boolean).join("\n") };
}

function finish(id: string, summary: string, run?: Run) {
  // it worked in a finished job's branch folder: the branch (and its merge) ends up here
  claimBranch(id);
  // its subagents are for it: once it is done, ones that never started go away
  // and running ones stop (a review that runs after its job ended is wasted)
  for (const k of activeKids(id)) {
    if (k.status === "queued" && !k.entries.some((e) => e.kind === "tool")) removeTask(k.id);
    else pauseTask(k.id);
  }
  runs.delete(id);
  agentKill(agentOf(id));
  markDead(agentOf(id));
  setLive(id, "");
  setState("decisions", (list) => list.filter((d) => d.taskId !== id));
  updateTask(id, (t) => {
    t.status = "done";
    t.plan = closePlan(t.plan);
    t.unread = true;
    t.saidDone = undefined;
    t.summary = summary;
    t.now = summary;
    const proven = (run?.evidence ?? []).filter((e) => e.ok !== false && !e.why).length;
    // what still doesn't hold after the job was sent back is listed, not hidden
    const broken = (run?.evidence ?? []).filter((e) => e.why).map((e) => `${e.ref} · ${e.why}`);
    const open = [...(run?.unverified ?? []), ...broken];
    t.unverified = run && !t.parentId ? (open.length ? open : proven ? undefined : ["증거 없이 끝났어요"]) : undefined;
    t.finishedAt = Date.now();
    closeOpen(t);
    const leg = t.legs[t.legs.length - 1];
    if (leg && !leg.endedAt) leg.endedAt = Date.now();
  });
  for (const k of activeKids(id)) pauseTask(k.id);
  const t = taskById(id);
  if (t?.parentId) {
    releaseBrowser(id);
    void deliver(t);
  } else if (t && !drainQueue(id)) {
    releaseBrowser(id);
    void dropEmptyBranch(id);
    endedHook?.(t);
  }
}

/**
 * A job that finished without changing any file (a question, research, a check)
 * has nothing to merge: its worktree and branch go away on their own, so no
 * merge bar or "+0" is left behind.
 */
async function dropEmptyBranch(id: string) {
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open" || t.status !== "done") return;
  const c = await gitChanges(w.path, w.base).catch(() => null);
  if (!c?.isRepo) return;
  const env = await gitEnv(t);
  if (c.files.length) {
    // the job pushed and its PR was merged: there is nothing left to merge here
    let into = await worktreeLanded(w.path, env).catch(() => null);
    // a rebase or squash merge leaves the branch's own commits off main: ask GitHub instead
    const pr = into ? undefined : prOf(t);
    if (pr && prMerged(await ghPrState(pr.url, env).catch(() => ""))) into = `PR #${pr.n}`;
    if (!into) return;
    // through a PR the branch stays, and anything left in the folder is saved on it
    await worktreeRemove(w.repo, w.path, w.branch, !!pr, env).catch(() => {});
    updateTask(id, (x) => {
      x.cwd = homeDir(x);
      x.worktree = { ...w, state: "merged", into };
      x.mergedAt = Date.now();
      push(x, { kind: "note", text: pr ? `${into} 병합됨 · 워크트리 정리` : `${into}에 이미 반영됨 · 워크트리 정리` });
    });
    return;
  }
  await worktreeRemove(w.repo, w.path, w.branch, false, env).catch(() => {});
  updateTask(id, (x) => {
    x.cwd = homeDir(x);
    x.worktree = undefined;
  });
}

const prMerged = (raw: string) => {
  try {
    return JSON.parse(raw).pr?.state === "MERGED";
  } catch {
    return false;
  }
};

/** Finished jobs whose branch has landed since (merged on GitHub later, or before this check existed). */
export async function sweepLanded() {
  for (const t of state.tasks.filter((x) => x.status === "done" && x.worktree?.state === "open" && !x.parentId)) await dropEmptyBranch(t.id);
}

// ─────────────────────────────── watching pull requests

const DAY = 86_400_000;
const patchWatch = (url: string, p: Partial<PrWatch>) => setState("prWatch", (m) => ({ ...(m ?? {}), [url]: { ...(m ?? {})[url], ...p } as PrWatch }));
let prPolling = false;

/**
 * Pull requests jobs opened: new reviews and comments from others, failed
 * checks and conflicts go back to the job that carries the PR (a finished one
 * gets a follow-on job on its branch). Merged or closed PRs, and ones quiet for
 * a week, stop being watched.
 */
export async function watchPrs() {
  if (prPolling || !state.settings.watchPullRequests) return;
  prPolling = true;
  try {
    const now = Date.now();
    for (const t of state.tasks) {
      if (t.parentId || t.answer) continue;
      const pr = prOf(t);
      if (!pr) continue;
      const live = t.status === "running" || t.status === "waiting" || t.status === "queued";
      const ended = t.finishedAt ?? t.legs[t.legs.length - 1]?.endedAt;
      if (!live && (!ended || now - ended > 7 * DAY)) continue;
      const w = state.prWatch?.[pr.url];
      if (!w) {
        // a PR opened just now: what came since it was opened counts; an older one starts from here
        const fresh = live || (!!ended && now - ended < 15 * 60_000);
        patchWatch(pr.url, { url: pr.url, task: t.id, since: fresh ? now - 15 * 60_000 : now, seen: [], failed: [], conflict: false, wakes: [], last: now });
      } else if (!w.done && w.task !== t.id && (taskById(w.task)?.createdAt ?? 0) < t.createdAt) {
        patchWatch(pr.url, { task: t.id });
      }
    }
    for (const w of Object.values(state.prWatch ?? {})) {
      if (w.done) continue;
      const t = taskById(w.task);
      if (!t || now - w.last > 7 * DAY) {
        patchWatch(w.url, { done: true });
        continue;
      }
      if (t.status === "paused") continue;
      const raw = await ghPrState(w.url, await gitEnv(t)).catch(() => "");
      if (!raw) continue;
      let snap;
      try {
        snap = parseSnap(raw);
      } catch {
        continue;
      }
      if (snap.state && snap.state !== "OPEN") {
        patchWatch(w.url, { done: true });
        continue;
      }
      if (w.conflict && snap.mergeable !== "CONFLICTING") patchWatch(w.url, { conflict: false });
      const news = prNews(state.prWatch![w.url], snap);
      if (hasNews(news) && canWake(w, now)) wakeForPr(state.prWatch![w.url], t, news, now);
    }
  } finally {
    prPolling = false;
  }
}

/** PR news for a job: a finished job is closed, so it starts a follow-on job on its branch; a live one hears it. Returns the job that got it. */
function prToJob(t: Task, text: string): string {
  if (!finished(t)) {
    void tell(t.id, text);
    return t.id;
  }
  return createTask({ space: t.space, title: t.title, topic: t.topic, ask: text, project: t.project, priority: t.priority, weight: t.weight, reach: t.reach, follows: t.id });
}

/** From the PR view: hand one comment or thread to the job (the watch won't send it again). */
export function passPrNote(id: string, url: string, notes: PrNews["notes"]): string | undefined {
  const t = taskById(id);
  if (!t || !notes.length) return;
  const to = prToJob(t, wakeText(url, { notes, failed: [], conflict: false }));
  const w = state.prWatch?.[url];
  if (w) patchWatch(url, { task: to, seen: [...w.seen, ...notes.map((n) => n.id)] });
  return to;
}

function wakeForPr(w: PrWatch, t: Task, news: PrNews, now: number) {
  const id = prToJob(t, wakeText(w.url, news));
  patchWatch(w.url, {
    task: id,
    seen: [...w.seen, ...news.notes.map((n) => n.id)],
    failed: [...w.failed, ...news.failed],
    conflict: w.conflict || news.conflict,
    wakes: [...w.wakes.filter((x) => now - x < DAY), now],
    last: now,
  });
}

// ─────────────────────────────── creating

export function createTask(f: {
  space: Task["space"];
  title: string;
  branch?: string;
  topic: string;
  ask: string;
  cwd?: string;
  priority?: Priority;
  weight?: Weight;
  accountId?: string;
  origin?: Task["origin"];
  /** Shown as the first message instead of the full ask (for long imported context). */
  display?: string;
  isolate?: boolean;
  project?: string;
  after?: string[];
  reach?: Task["reach"];
  /** a finished job this carries on: its branch is handed over */
  follows?: string;
  issue?: Task["issue"];
  /** another agent asked for it (see Entry's `by`) */
  by?: string;
}): string {
  const id = uid("t");
  const prev = f.follows ? taskById(f.follows) : undefined;
  // its branch moves over now when it has finished; a job still wrapping up hands it over when this one starts
  const takes = !!prev && finished(prev) && prev.worktree?.state === "open";
  const topic = f.topic.trim() || "기타";
  const task: Task = {
    id,
    space: f.space,
    topic,
    title: cutTitle(f.title) || "작업",
    ask: f.ask,
    ...(f.branch ? { branch: f.branch } : {}),
    ...(f.after?.length ? { after: f.after } : {}),
    ...(f.reach?.length ? { reach: f.reach } : {}),
    ...(prev ? { follows: prev.id } : {}),
    cwd: (takes ? prev!.cwd : f.cwd?.trim()) || (prev?.worktree ? `${prev.worktree.repo}${prev.worktree.sub ? `/${prev.worktree.sub}` : ""}` : prev?.cwd) || spaceById(f.space).folder || "~",
    project: f.project ?? prev?.project ?? projectFor(f.space, f.cwd),
    // the branch it carries on moves with it: merge and discard act on the new card
    ...(takes ? { worktree: prev!.worktree } : {}),
    status: "queued",
    priority: f.priority ?? 2,
    weight: f.weight ?? "light",
    accountId: f.accountId ?? chooseAccount(f.space, topic),
    createdAt: Date.now(),
    now: "대기 중",
    plan: [],
    legs: [],
    entries: [
      { id: uid("e"), at: Date.now(), kind: "user", text: f.display ?? f.ask, ...(f.by ? { by: f.by } : {}) },
      ...(prev ? [{ id: uid("e"), at: Date.now(), kind: "note" as const, text: `"${prev.title}" 작업의 결과${prev.worktree?.state === "open" ? "와 브랜치" : ""}를 이어받아 시작해요` }] : []),
    ],
    shells: [],
    inbox: [],
    origin: f.origin,
    ...(f.issue ? { issue: f.issue } : {}),
    isolate: f.isolate,
    // no model of its own: it runs on its account's model (each account picks its own)
    model: undefined,
    thinking: undefined,
    permission: state.settings.permission ?? "edits",
  };
  setState("tasks", (list) => [...list, task]);
  if (takes) takeBranch(id, prev!.id);
  return id;
}

/** The job it carries on gives it its branch and worktree. */
const inside = (dir: string, root: string) => !!root && (dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`));

/**
 * A job working in another job's open worktree takes its branch once that job is
 * finished: merge and discard live on the newest job in the folder, so an older
 * card doesn't sit there as 검토 while the work goes on elsewhere.
 */
export function claimBranch(id: string) {
  const t = taskById(id);
  if (!t || t.parentId || t.answer || t.worktree) return;
  const holder = state.tasks.find((x) => x.id !== id && x.worktree?.state === "open" && inside(t.cwd, x.worktree.path));
  if (holder && finished(holder)) takeBranch(id, holder.id);
}

function takeBranch(id: string, prevId: string) {
  const prev = taskById(prevId);
  const w = prev?.worktree;
  if (!w || w.state !== "open") return;
  updateTask(id, (x) => {
    x.worktree = w;
    x.cwd = prev!.cwd;
  });
  updateTask(prevId, (x) => {
    x.worktree = undefined;
    push(x, { kind: "note", text: `브랜치 ${w.branch}는 "${taskById(id)?.title ?? ""}" 작업으로 넘어갔어요` });
  });
}

/**
 * The user turned a job in a new direction ("확인만" → "고쳐서 배포까지"): it wraps up
 * what it has so far and ends; the new job waits for it, then starts with a fresh
 * context on its result and branch.
 */
export function handOn(prevId: string, nextId: string) {
  const prev = taskById(prevId);
  if (!prev || finished(prev)) return;
  updateTask(prevId, (x) => {
    x.handedOn = nextId;
    push(x, { kind: "note", text: `"${taskById(nextId)?.title ?? ""}" 작업으로 넘어가요` });
  });
  if ((prev.status === "running" || prev.status === "waiting") && isAlive(agentOf(prevId))) {
    void tell(
      prevId,
      "The user turned this work in a new direction; a new job takes it from here with a fresh context. Stop where you are: don't start anything new. End now with done: what you found and changed so far (with its evidence), and what you didn't get to in \"unverified\".",
      { now: true },
    );
    return;
  }
  // not running (queued, paused, waiting with no session): it ends here as it is
  updateTask(prevId, (x) => {
    x.status = "done";
    x.plan = closePlan(x.plan);
    x.finishedAt = Date.now();
    x.summary ||= "새 일로 넘어갔어요";
    x.now = x.summary;
  });
}

/**
 * What keeps a job to its own space's data: Ondra's data folder, the jobs whose
 * logs and folders it may read (itself, what it follows or builds on, its parent
 * and sub-agents; no list when the user opened another space to it), its space's
 * own folders (browser recipes).
 */
export function dataEnv(t: Task): [string, string][] {
  const data = engine.info.dataDir;
  if (!data) return [];
  const key = t.space.replace(/[^A-Za-z0-9_-]/g, "") || "home";
  const ids = jobsAllowed(t);
  return [
    ["ONDRA_DATA_DIR", data],
    ["ONDRA_SPACE_KEY", key],
    ["ONDRA_RECIPES_DIR", `${data}/browser/${key}/recipes`],
    ...(ids ? [["ONDRA_JOBS_ALLOWED", ids.join(",")] as [string, string]] : []),
  ];
}

/** The jobs whose logs a job may read (see dataEnv); undefined = no list (the user opened another space to it). */
export function jobsAllowed(t: Task): string[] | undefined {
  if (t.reach?.length) return undefined;
  const ids = [t.id, t.follows, t.parentId, ...(t.after ?? []), ...state.tasks.filter((k) => k.parentId === t.id).map((k) => k.id)].filter((x): x is string => !!x);
  return [...new Set(ids)];
}

/** A finished job (not a quick answer): more work on it starts as a new job that follows it. */
export const finished = (t: Task | undefined) => !!t && !t.parentId && !t.answer && (t.status === "done" || t.status === "failed");

/** A question answered on the spot: a finished thread the user can keep talking in. */
export function createAnswer(f: { space: Task["space"]; question: string; text: string; blocks: Block[]; title?: string; topic?: string }): string {
  const id = uid("t");
  const at = Date.now();
  const first = f.question.split("\n")[0].trim();
  const entries: Entry[] = [
    { id: uid("e"), at, kind: "user", text: f.question },
    ...(f.text.trim() ? [{ id: uid("e"), at, kind: "text" as const, text: f.text }] : []),
    ...f.blocks.map((block) => ({ id: uid("e"), at, kind: "block" as const, block })),
  ];
  const topic = f.topic?.trim() || "대화";
  const task: Task = {
    id,
    space: f.space,
    topic,
    title: cutTitle(f.title?.trim() || cutTitle(first, 29) || "질문"),
    ask: f.question,
    cwd: spaceById(f.space).folder || "~",
    status: "done",
    priority: 2,
    weight: "light",
    accountId: chooseAccount(f.space, topic),
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    now: "답변함",
    plan: [],
    legs: [],
    entries,
    shells: [],
    inbox: [],
    answer: true,
  };
  setState("tasks", (list) => [...list, task]);
  return id;
}

// ─────────────────────────────── user actions

/**
 * Talk to a task. While it works, the words wait in its queue and go in once the
 * work is done (`now` steers them in right away). Waiting on you, or stopped: they
 * go in at once.
 */
/**
 * The command watchdog. A find/rg/du … that has printed nothing new for
 * SEARCH_STALL_MS is walking a folder far too big (all of ~, Library). A wait on
 * a local server or its log that has shown nothing new for WAIT_STALL_MS waits
 * for something that isn't coming (the server crashed, its port was taken, a
 * restart took it down). Only that command is stopped, never the job, a build
 * or the server it waits for, and the agent is told why.
 */
function stopStalledCommands() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (!run.streaming) continue;
    for (const s of taskById(id)?.shells ?? []) {
      if (!run.tools.has(s.id)) continue;
      // one command can be both (wait for the server, then find the pages): each is tried once
      const seen = { ...s, changedAt: run.changed?.get(s.id) };
      if (!run.searchStops?.has(s.id) && searchStalled(seen, now)) void stopSearch(id, run, s);
      if (!run.waitStops?.has(s.id) && waitStalled(seen, now)) void stopWait(id, run, s);
    }
  }
}

const shortCmd = (cmd: string) => {
  const c = cmd.replace(/\s+/g, " ").trim();
  return c.length > 120 ? `${c.slice(0, 120)}…` : c;
};

const waitStoppedSteer = (cmd: string) =>
  `(Ondra) Stopped \`${shortCmd(cmd)}\` after ${WAIT_STALL_MS / 1000}s with nothing new: the local server or log line it waited for isn't coming. Read the log tail and check the process is alive (\`kill -0 <pid>\`) before waiting again; if it exited, fix why and start it again.`;

async function stopWait(id: string, run: Run, s: Shell) {
  (run.waitStops ??= new Set()).add(s.id);
  const beside = (taskById(id)?.shells ?? []).filter((x) => x.id !== s.id && run.tools.has(x.id)).map((x) => x.command);
  const arg = shellArg(s.command, beside);
  if (!arg) return;
  // the shell running the wait (`/bin/bash -c <command>`), not the server it waits for
  const stopped = await agentStopCommand(agentOf(id), "bash", arg).catch(() => 0);
  if (!stopped || runs.get(id) !== run) return;
  updateTask(id, (t) => push(t, { kind: "note", text: "기다림 멈춤 · 2분 넘게 변화 없음" }));
  if (run.streaming) void request(agentOf(id), { type: "steer", message: waitStoppedSteer(s.command) }).catch(() => {});
}

async function stopSearch(id: string, run: Run, s: Shell) {
  (run.searchStops ??= new Set()).add(s.id);
  const call = searchCall(s.command);
  if (!call) return;
  const stopped = await agentStopCommand(agentOf(id), call.program, call.arg).catch(() => 0);
  if (!stopped || runs.get(id) !== run) return;
  updateTask(id, (t) => push(t, { kind: "note", text: "검색 멈춤 · 1분 넘게 결과 없음" }));
  if (run.streaming)
    void request(agentOf(id), {
      type: "steer",
      message: `(Ondra) Stopped \`${shortCmd(s.command)}\` after ${SEARCH_STALL_MS / 1000}s with no output: it was walking too big a folder. Search a named project folder with rg --files / rg, skip node_modules/.git/Library.`,
    }).catch(() => {});
}

/**
 * Catches the two loops that waste a job's time: the same command failing again
 * with no file changed in between, and re-running a check that already passed
 * when nothing changed since. The agent is told once per command, at most 3 times a run.
 */
function loopGuard(id: string, run: Run, call: ToolCall, ok: boolean) {
  if (call.kind === "edit" || call.kind === "write") {
    if (ok) run.edits = (run.edits ?? 0) + 1;
    return;
  }
  if (call.kind !== "bash" && call.kind !== "test") return;
  // it already said done or handed off: a nudge now only drags it into more turns
  if (run.done !== undefined || run.handoff || run.pendingHandoff) return;
  const cmd = (call.detail ?? call.target ?? "").replace(/\s+/g, " ").trim();
  if (!cmd || keepsRunning(cmd)) return;
  const kind = commandKind(cmd);
  // looking in on something still running (sleep, tail, ps, pgrep) is waiting, not
  // re-running a check: telling it "that passed, finish" made a job stop its own
  // check halfway. Repeated looks get a nudge to wait in one call instead.
  if (kind === "poll") {
    run.polls = (run.polls ?? 0) + 1;
    if (run.polls % 4 === 0 && (run.nudges ?? 0) < 3) {
      run.nudges = (run.nudges ?? 0) + 1;
      if (run.streaming)
        void request(agentOf(id), {
          type: "steer",
          message:
            "(Ondra) You are checking on the same thing turn after turn. Wait for it in one bash call instead: `for i in $(seq 1 60); do <is it done?> && break; <is it still running?> || break; sleep 10; done; <show the result>`. Give it a deadline that fits: 90s for a local server, 10 minutes for a build or test run, longer only for CI or a store review. Don't stop or restart what is running.",
        }).catch(() => {});
    }
    return;
  }
  const ran = (run.ran ??= new Map());
  const edits = run.edits ?? 0;
  const before = ran.get(cmd);
  ran.set(cmd, { ok, edits });
  if (!before || before.edits !== edits || (run.nudges ?? 0) >= 3) return;
  let msg = "";
  if (!ok && !before.ok)
    msg = "That exact command just failed the same way again and no file changed in between. Don't run it again as is: read the error, find the cause, and change the approach.";
  else if (ok && before.ok && kind === "check")
    msg = "That check already passed and nothing changed since. Don't re-run it; go on with the next step.";
  if (!msg) return;
  run.nudges = (run.nudges ?? 0) + 1;
  updateTask(id, (t) => push(t, { kind: "note", text: ok ? "같은 검사 반복" : "같은 실패 반복" }));
  if (run.streaming) void request(agentOf(id), { type: "steer", message: msg }).catch(() => {});
}

export async function tell(id: string, message: string, opts: { now?: boolean; shown?: string; by?: string } = {}) {
  const t = taskById(id);
  if (!t) return;
  const wasPaused = t.status === "paused";
  const agent = agentOf(id);
  if (!opts.now && t.status === "running" && isAlive(agent)) {
    const q = { id: uid("q"), text: opts.shown ?? message, at: Date.now(), ...(opts.by ? { by: opts.by } : {}), ...(opts.shown && opts.shown !== message ? { sent: message } : {}) };
    updateTask(id, (x) => (x.queue = [...(x.queue ?? []), q]));
    return;
  }
  if (restartBeforeNext.delete(id) && isAlive(agent)) {
    agentKill(agent);
    markDead(agent);
  }
  updateTask(id, (x) => {
    x.saidDone = undefined;
    // what the user sees in the bubble (a button's label), when the message is meant for the model;
    // `by`: another agent sent it (main, or a job through job_tell)
    push(x, { kind: "user", text: opts.shown ?? message, ...(opts.by ? { by: opts.by } : {}) });
  });
  if (isAlive(agent) && (t.status === "running" || t.status === "waiting")) {
    const run = runs.get(id);
    setState("decisions", (list) => list.filter((d) => !(d.taskId === id && !d.ui)));
    updateTask(id, (x) => {
      x.status = "running";
    });
    // the user's words may change the plan: the model is asked to update it (the user sees only their words)
    const sent = t.plan.some((s) => s.state !== "done") ? `${message}\n\n(Ondra) If this changes your plan, send a new plan block; mark the steps already finished with a now block's step.` : message;
    // steered words wait for the current tool calls: kept until taken, as a restart loses them
    hold(id, sent, { shown: opts.shown ?? message });
    try {
      await request(agent, run?.streaming ? { type: "steer", message: sent } : { type: "prompt", message: sent });
    } catch (e) {
      unhold(id, sent);
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    return;
  }
  updateTask(id, (x) => {
    x.inbox.push(message);
    if (x.status !== "queued") requeue(x);
  });
  if (wasPaused) resumeKids(id);
}

/** Steer a queued message in now. */
export function steerQueued(id: string, qid: string) {
  const q = taskById(id)?.queue?.find((x) => x.id === qid);
  if (!q) return;
  updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => y.id !== qid)));
  void tell(id, q.sent ?? q.text, queuedOpts(q));
}
const queuedOpts = (q: NonNullable<Task["queue"]>[number]) => ({ now: true, ...(q.sent ? { shown: q.text } : {}), ...(q.by ? { by: q.by } : {}) });
/** Change a queued message where it is; an emptied one is taken out. Edited, it is the user's own words. */
export function editQueued(id: string, qid: string, text: string) {
  const t = text.trim();
  if (!t) return dropQueued(id, qid);
  updateTask(id, (x) => (x.queue = (x.queue ?? []).map((y) => (y.id === qid ? { id: y.id, at: y.at, text: t } : y))));
}
export function dropQueued(id: string, qid: string) {
  updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => y.id !== qid)));
}
/** The work is done: the next queued message goes in. True if one did. */
function drainQueue(id: string): boolean {
  const q = taskById(id)?.queue?.[0];
  if (!q) return false;
  updateTask(id, (x) => (x.queue = (x.queue ?? []).slice(1)));
  void tell(id, q.sent ?? q.text, queuedOpts(q));
  return true;
}

function requeue(t: Task) {
  t.parkedAt = undefined;
  t.status = "queued";
  t.now = "대기 중";
  t.error = undefined;
}

export async function decide(decisionId: string, optionId: string) {
  const d = state.decisions.find((x) => x.id === decisionId);
  if (!d) return;
  setState("decisions", (list) => list.filter((x) => x.id !== decisionId));
  // main asked it: the answer goes back to main as the user's message
  if (d.taskId.startsWith("main:")) {
    const [space, project] = d.taskId.slice(5).split("~");
    const label = d.options.find((o) => o.id === optionId)?.label ?? optionId;
    const { throwThought } = await import("./captain");
    void throwThought(`"${d.question}" → ${label}`, space as Task["space"], { project });
    return;
  }
  const t = taskById(d.taskId);
  if (!t) return;
  const agent = agentOf(t.id);
  const label = d.options.find((o) => o.id === optionId)?.label ?? optionId;

  if (d.ui && isAlive(agent)) {
    const reply =
      d.ui.method === "confirm"
        ? { type: "extension_ui_response", id: d.ui.requestId, confirmed: optionId === "yes" }
        : d.ui.method === "select"
          ? { type: "extension_ui_response", id: d.ui.requestId, value: optionId }
          : { type: "extension_ui_response", id: d.ui.requestId, cancelled: true };
    updateTask(t.id, (x) => {
      x.status = "running";
      push(x, { kind: "user", text: label });
    });
    void agentSend(agent, reply);
    return;
  }
  if (d.kind === "stalled" && optionId === "finish") {
    // its last report, not "now" (that is what it was doing, e.g. "명령 실행 중")
    updateTask(t.id, (x) => (x.endedBy = "user"));
    finish(t.id, lastReport(t) ?? "완료");
    return;
  }
  // "멈춰", "계속 멈춤", "stop": the job stops now, it isn't asked to stop itself
  if (meansStop(label)) {
    updateTask(t.id, (x) => push(x, { kind: "user", text: `"${d.question}" → ${label}` }));
    stopTask(t.id);
    return;
  }
  if (d.kind === "stalled") {
    await tell(t.id, "이어서 진행하세요. 모두 끝났으면 done을 보내세요. 사용자에게 받아야 할 것이 있으면 ask 블록으로 물어보세요.", { shown: label });
    return;
  }
  await tell(t.id, `"${d.question}" → ${label}`);
}

/** What the job said since the user last spoke. */
function lastWords(t: Task): string {
  const out: string[] = [];
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    if (e.kind === "user") break;
    if (e.kind === "text") out.unshift(e.text);
  }
  return out.join("\n").replace(/```[\s\S]*?```/g, "").trim();
}

/** Words that hand the next step to the user: asking them to do or tell something, or waiting for them. */
export const waitsOnUser = (text: string) =>
  /기다릴게요|기다리고 있어요|기다리겠|알려\s?주시면|알려\s?주세요|해\s?주세요|해\s?주시면|주시면 이어|정해\s?주세요|골라\s?주세요|waiting for (you|your)|let me know|once you('ve| have)?\b/i.test(text.slice(-600));

/** The first line of the job's last report to the user, if it wrote one. */
export function lastReport(t: Task): string | undefined {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    if (e.kind !== "text") continue;
    const line = e.text
      .replace(/```[\s\S]*?```/g, "")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .map((l) => l.replace(/^[>*\-\s]+/, "").replace(/\*\*/g, "").trim())
      .find(Boolean);
    if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  }
  return undefined;
}

/** The user's words ask to stop or hold the work (not "don't stop"). */
export const meansStop = (text: string) => /멈춰|멈추|멈춤|그만|중지|중단|보류|\bstop\b|\bpause\b|\bhold\b/i.test(text) && !/말고|않|안 ?멈|계속 (진행|해)|don'?t stop|keep going|continue/i.test(text);

export function pauseTask(id: string) {
  runs.delete(id);
  agentKill(agentOf(id));
  markDead(agentOf(id));
  setLive(id, "");
  updateTask(id, (t) => {
    t.status = "paused";
    t.now = "일시정지됨";
    closeOpen(t);
    push(t, { kind: "note", text: "일시정지" });
  });
  // its subagents stop with it, and remember it was this pause that stopped them
  for (const k of activeKids(id)) {
    pauseTask(k.id);
    updateTask(k.id, (x) => (x.pausedBy = id));
  }
}

/** The subagents a task's own pause stopped go back in line with it (and theirs with them). */
function resumeKids(id: string) {
  for (const k of childrenOf(id).filter((k) => k.pausedBy === id && k.status === "paused")) {
    updateTask(k.id, (x) => (requeue(x), (x.resumedAt = Date.now())));
    resumeKids(k.id);
  }
}

/** The user stopped it: paused, and main doesn't carry it on by itself. */
export function stopTask(id: string) {
  pauseTask(id);
  updateTask(id, (t) => (t.parkedAt = Date.now()));
}

export function resumeTask(id: string) {
  // resumed on its own: it no longer waits for the fork that paused it
  updateTask(id, (t) => (requeue(t), (t.pausedBy = undefined), (t.resumedAt = Date.now())));
  resumeKids(id);
}
export const finishTask = (id: string) => {
  updateTask(id, (t) => (t.endedBy = "user"));
  finish(id, "직접 완료 처리");
};

export function removeTask(id: string) {
  for (const k of childrenOf(id)) removeTask(k.id);
  releaseBrowser(id);
  const gone = taskById(id);
  const w = gone?.worktree;
  // keep the branch (with everything committed) so deleting never loses work
  if (gone && w?.state === "open") void gitEnv(gone).then((env) => worktreeRemove(w.repo, w.path, w.branch, true, env)).catch(() => {});
  runs.delete(id);
  agentKill(agentOf(id));
  markDead(agentOf(id));
  setLive(id, "");
  setState("decisions", (list) => list.filter((d) => d.taskId !== id));
  setState("tasks", (list) => list.filter((t) => t.id !== id));
}

/** What a job may do without asking; a live session switches right away. */
export async function setTaskPermission(id: string, p: Permission) {
  updateTask(id, (t) => {
    t.permission = p;
  });
  const agent = agentOf(id);
  if (!isAlive(agent)) return;
  try {
    await request(agent, { type: "prompt", message: `/ondra-permission ${p}` });
  } catch (e) {
    toast(tr("권한을 바꾸지 못했어요 · {why}", { why: e instanceof Error ? e.message : String(e) }), "bad");
  }
}

/** jobs whose engine must start again (with the new model's tools on or off) before the next message */
const restartBeforeNext = new Set<string>();

/** Model / effort for one task; applied to its live session right away. */
export async function setTaskModel(id: string, model: string, thinking: string) {
  const before = taskById(id);
  const was = before ? before.model || modelFor(before.accountId) : undefined;
  updateTask(id, (t) => {
    t.model = model || undefined;
    t.thinking = thinking || undefined;
  });
  const agent = agentOf(id);
  if (!isAlive(agent)) return;
  try {
    const t = taskById(id)!;
    const m = model || modelFor(t.accountId);
    // tools on or off is fixed when the engine starts: a switch across that line takes a new start
    if (canUseTools(t.accountId, was) !== canUseTools(t.accountId, m)) {
      if (t.status === "running") {
        restartBeforeNext.add(id);
        return void updateTask(id, (x) => void push(x, { kind: "note", text: "도구 사용 여부가 달라서 다음 메시지부터 이 모델로 바꿔요" }));
      }
      agentKill(agent);
      markDead(agent);
      return void updateTask(id, (x) => void push(x, { kind: "note", text: `모델 → ${(m ?? "").split("/").pop()}` }));
    }
    if (m) {
      const i = m.indexOf("/");
      await request(agent, { type: "set_model", provider: m.slice(0, i), modelId: m.slice(i + 1) });
    }
    if (thinking) await request(agent, { type: "set_thinking_level", level: thinking });
    updateTask(id, (t) => push(t, { kind: "note", text: `모델 → ${(m ?? "").split("/").pop()}${thinking ? ` · ${thinking}` : ""}` }));
  } catch (e) {
    toast(tr("모델을 바꾸지 못했어요 · {why}", { why: e instanceof Error ? e.message : String(e) }), "bad");
  }
}

export const setPriority = (id: string, p: Priority) => updateTask(id, (t) => (t.priority = p));
export const setWeight = (id: string, w: Weight) => updateTask(id, (t) => (t.weight = w));

// ─────────────────────────────── scheduler

/** Start queued work in priority order while slots are free (both spaces share one Mac). */
export function schedule() {
  if (!inTauri || !loaded() || !engine.checked || !engine.ready) return;
  // subagents run beside their fork (up to 4 at once per fork), outside the slots
  for (const p of state.tasks.filter((t) => !t.parentId && (t.status === "running" || t.status === "waiting"))) {
    const kids = childrenOf(p.id);
    let running = kids.filter((k) => k.status === "running").length;
    for (const k of kids.filter((k) => k.status === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
      if (running >= 4) break;
      running++;
      void startTask(k.id, k.legs.length > 0 && !k.legs[k.legs.length - 1].endedAt);
    }
  }
  // a subagent that was already under way when its fork ended (resumed by the user,
  // or cut off by a restart) carries on by itself instead of waiting for the fork forever
  for (const k of state.tasks.filter((k) => k.parentId && k.status === "queued" && k.legs.length > 0)) {
    const p = taskById(k.parentId!);
    if (p && (p.status === "running" || p.status === "waiting")) continue;
    // resumed with its fork: it starts beside the fork once the fork is running
    if (p && k.pausedBy === p.id && p.status === "queued") continue;
    // a review of a job that has ended has no one to report to
    if (k.review && (!p || p.status === "done" || p.status === "failed")) {
      pauseTask(k.id);
      continue;
    }
    void startTask(k.id, !k.legs[k.legs.length - 1].endedAt);
  }
  const busy = state.tasks.filter((t) => !t.parentId && (t.status === "running" || (t.status === "waiting" && isAlive(agentOf(t.id)))));
  let light = busy.filter((t) => t.weight === "light").length;
  // a heavy job waiting on the user isn't using the screen or a device: it
  // gives up its slot, so other heavy jobs don't queue behind a question
  let heavy = busy.filter((t) => t.weight === "heavy" && t.status === "running").length;
  // a step waits until the steps it builds on are done
  const ready = (t: Task) => !(t.after ?? []).some((id) => { const d = taskById(id); return d && d.status !== "done"; });
  const queue = state.tasks.filter((t) => t.status === "queued" && !t.parentId && ready(t)).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  for (const t of queue) {
    if (waitsOnKids(t)) continue;
    if (t.weight === "heavy" ? heavy >= state.settings.slots.heavy : light >= state.settings.slots.light) continue;
    t.weight === "heavy" ? heavy++ : light++;
    // A task that already had a session continues it.
    void startTask(t.id, t.legs.length > 0 && !t.legs[t.legs.length - 1].endedAt);
  }
}

/** A job cut off while it was only waiting for its subagents: it stays asleep until
 * one reports back (their result wakes it), instead of spending a turn on nothing. */
const waitsOnKids = (t: Task) =>
  t.legs.length > 0 &&
  !t.legs[t.legs.length - 1].endedAt &&
  !t.inbox.length &&
  !t.pending?.length &&
  childrenOf(t.id).some((k) => k.status === "running" || k.status === "waiting" || (k.status === "queued" && k.legs.length > 0));

export function startScheduler() {
  if (!inTauri) return;
  // After a restart nothing runs any more: put live work back in line.
  // (jobs whose engine still runs, after a page reload, were picked up again by reattachJobs)
  for (const t of state.tasks) if (t.status === "running" && !runs.get(t.id)) updateTask(t.id, (x) => requeue(x));
  // finished jobs from before plans were closed on finish
  for (const t of state.tasks) if (t.status === "done" && t.plan.some((s) => s.state === "now" || s.state === "todo")) updateTask(t.id, (x) => (x.plan = closePlan(x.plan)));
  // branches merged on GitHub since: their merge bar goes; checked again every half hour
  setTimeout(() => void sweepLanded(), 20_000);
  setInterval(() => void sweepLanded(), 30 * 60_000);
  // pull requests jobs opened: reviews, failed checks and conflicts go back to the job
  setTimeout(() => void watchPrs(), 40_000);
  setInterval(() => void watchPrs(), 3 * 60_000);
  setInterval(stopStalledCommands, 10_000);
  createRoot(() => {
    createEffect(
      on(
        () => [state.tasks.map((t) => t.status).join(), state.settings.slots.light, state.settings.slots.heavy],
        () => queueMicrotask(schedule),
      ),
    );
  });
}

export const slotsUsed = () => {
  const busy = state.tasks.filter((t) => t.status === "running" && !t.parentId);
  return { light: busy.filter((t) => t.weight === "light").length, heavy: busy.filter((t) => t.weight === "heavy").length };
};

/** Summarize the conversation so far and keep going in the same session (frees context). */
export async function compactAgent(agent: string) {
  if (!isAlive(agent)) return toast(tr("압축할 대화가 없어요"));
  toast(tr("대화 압축 중"));
  try {
    await request(agent, { type: "compact" }, 180_000);
    noteCtx(agent, await request(agent, { type: "get_session_stats" }, 8000));
    toast(tr("대화를 압축했어요"));
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "bad");
  }
}

// ─────────────────────────────── edit / retry (rewind the session)

/** The session's token totals as they are now, without adding them to the account. */
export async function rawStats(agent: string): Promise<TokenStats> {
  try {
    const s = await request(agent, { type: "get_session_stats" }, 8000);
    noteCtx(agent, s);
    return { input: s?.tokens?.input ?? 0, output: s?.tokens?.output ?? 0, cacheRead: s?.tokens?.cacheRead ?? 0, cacheWrite: s?.tokens?.cacheWrite ?? 0 };
  } catch {
    return zero();
  }
}

/**
 * Branch the engine session to just before the user message that carried `text`
 * (the last one that matches). The history before it stays byte-identical, so the
 * prompt cache still hits. Returns false if no such message was found.
 */
export async function forkAt(agent: string, text: string): Promise<boolean> {
  try {
    const r = await request(agent, { type: "get_fork_messages" }, 8000);
    const list: { entryId: string; text: string }[] = r?.messages ?? [];
    const key = text.trim();
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i].text.trim();
      if (m === key || m.includes(key) || (m.length > 20 && key.includes(m))) {
        await request(agent, { type: "fork", entryId: list[i].entryId }, 15_000);
        return true;
      }
    }
  } catch {
    /* fall through: send it as a new message */
  }
  return false;
}

/**
 * Edit a message you sent to a job (or send it again): everything after it goes
 * away, the session goes back to just before it, and the job runs from there.
 */
export async function editTurn(id: string, entryId: string, text: string) {
  const t = taskById(id);
  if (!t) return;
  const at = t.entries.findIndex((e) => e.id === entryId);
  const old = t.entries[at];
  if (at < 0 || old.kind !== "user") return;
  const first = !t.entries.slice(0, at).some((e) => e.kind === "user");
  const agent = agentOf(id);
  const run = runs.get(id);
  // stop what it's doing now
  if (isAlive(agent) && run?.streaming) {
    try {
      await request(agent, { type: "abort" }, 8000);
    } catch {
      /* already stopped */
    }
  }
  setState("decisions", (list) => list.filter((d) => d.taskId !== id));
  updateTask(id, (x) => {
    x.entries = x.entries.slice(0, at);
    if (first) {
      x.ask = text;
    }
    push(x, { kind: "user", text });
    x.status = "running";
    x.finishedAt = undefined;
    x.error = undefined;
    x.now = "다시 하는 중";
    x.unread = false;
  });
  const fresh = taskById(id)!;
  // the first message is the whole task prompt; later ones are sent as written
  const from = first ? t.ask : old.text;
  const message = first ? taskPrompt(fresh) : text;
  if (isAlive(agent) && runs.get(id)) {
    try {
      await forkAt(agent, from);
      const r = runs.get(id);
      if (r) r.stats = await rawStats(agent);
      await request(agent, { type: "prompt", message });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    return;
  }
  await startTask(id, true, { from, message });
}

// ─────────────────────────────── list housekeeping

export const togglePin = (id: string) => updateTask(id, (t) => (t.pinned = !t.pinned));
export function archiveTask(id: string, on = true) {
  updateTask(id, (t) => {
    t.archived = on;
    if (on) t.pinned = false;
  });
  if (on) toast(tr("보관했어요"), "info", { label: tr("되돌리기"), run: () => archiveTask(id, false) });
}
export function renameTask(id: string, title: string) {
  const v = title.trim().slice(0, 80);
  if (v) updateTask(id, (t) => (t.title = v));
}
/** Same request again as a new job (same folder, model and permission). */
export function duplicateTask(id: string): string | undefined {
  const t = taskById(id);
  if (!t) return;
  const n = createTask({ space: t.space, title: `${t.title} (복제)`, topic: t.topic, ask: t.ask, cwd: homeDir(t), priority: t.priority, weight: t.weight, accountId: t.accountId });
  updateTask(n, (x) => {
    x.model = t.model;
    x.thinking = t.thinking;
    x.permission = t.permission;
  });
  return n;
}
/** The conversation as Markdown (for pasting into a doc or an issue). */
export function transcriptMarkdown(id: string): string {
  const t = taskById(id);
  if (!t) return "";
  const out = [`# ${t.title}`, ""];
  for (const e of t.entries) {
    if (e.kind === "user") out.push(`**나:** ${e.text}`, "");
    else if (e.kind === "text") out.push(e.text, "");
    else if (e.kind === "tool") out.push(`- \`${e.tool.name}\` ${e.tool.target ?? ""}`);
    else if (e.kind === "error") out.push(`> 오류: ${e.text}`, "");
  }
  return out.join("\n");
}
