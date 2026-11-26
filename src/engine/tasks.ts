// Task lifecycle: start an engine session, turn its events into transcript
// entries, roll to a fresh session on a handoff (the relay), pick another
// model when one is rejected, and start queued work once what it waits on is done.
import { liveKey } from "./live";
import { mcpArgs } from "./services";
import { formAnswer, readFields, type FormValues } from "./form";
import { answerRound, readClarity, readRound, roundDecision, roundText } from "./round";
import { answerExtensionUi, clearExtensionUi, extensionUi } from "./extensionUi";
import { far, farDecide, markFarRead, startFar } from "./hosts";
import { hostOfTask, mirroredDecision, splitProjectId, splitSpaceId } from "../state/mirror";
import { logError, logInfo, logWarn } from "../lib/log";
import { track } from "../lib/telemetry";
import { isNetError, waitOnline } from "./net";
import { isUseCall, computerLabel, computerStep, cutTitle, describeBrowser, describeCommand, describeComputer } from "./describe";
import { t as tr } from "../i18n";
import { skillPaths } from "./skillPick";
import { prepareQuery } from "./vectors";
import { batch, createEffect, createRoot, on } from "solid-js";
import { accountById, accountsIn, appQuitting, homeDir, loaded, projectById, projectFor, setState, spaceById, kidsOf, state, taskById, taskProject, uid, updateAccount, updateTask } from "../state/store";
import { refreshLimits, snapshot, usageOf } from "../state/limits";
import { ctx, noteCall, noteCtx, reuse, setCtx, setReuse } from "../state/ctx";
import { handoffAt, handoffSteer, windowFor } from "./handoff";
import { closePlan, moveTo, nextPlan, openAsked, planText, unexplained } from "./plan";
import type { Account, Block, Decision, Entry, Evidence, Handoff, Permission, Priority, PrWatch, Shell, Size, Task, TokenStats, ToolCall, Usage, Weight } from "../state/types";
import { setLive, toast } from "../state/ui";
import { allowedDevices, refreshDevices } from "../state/devices";
import { inTauri, jobDevicesRelease, accountDirPath, agentKill, agentStopCommand, agentSpawn, browserCheck, browserRelease, type Env, gitChanges, spaceEnv, workerEnv, workerExtensions, worktreeCreate, worktreeLanded, worktreeMerge, worktreeRemove, fsRead, ghPrState, gitOnGithub, gitSyncHome, ghWatch } from "../lib/native";
import { canWake, hasNews, parseSnap, prNews, wakeText, type PrNews } from "./prWatch";
import { prose, readFences } from "./fences";
import { notesMarkdown, readNotes, writeNotes } from "./notes";
import { answeredNo, commandKind, isTestRun, runsProgram, SEARCH_STALL_MS, searchCall, searchStalled, shellArg, WAIT_STALL_MS, waitStalled } from "./commandKind";
import { causeFooting, checkEvidence, isBugFix, isCodeFile, leftovers, promisesLater, readUnverified, reproGap, reviewUnresolved, riskyChange, unbackedChecked, unbackedClaim, uncheckedLine, unreasoned } from "./proof";
import { checksCovering, checksFor, checksOwed, loadLocalChecks } from "./localChecks";
import { crosscheckMessage, isPlan, lensesOf, lensKids, planKids, lensText, REVIEW_FIX, reviewGoing, reviewName, reviewSettled } from "./crosscheck";
import { readMemoryCheck, settleMemory } from "./memcheck";
import { addMemory, KINDS, markUsed, memoryLines } from "./memory";
import { recallNow, stepThings } from "./stepRecall";
import { effortFor, failedModelIn, modelFor, nextModel } from "./models";
import { canUseTools, connModel, isDirect, toolsRefused } from "./connections";
import { hostedToolEvents } from "./hostedSearch";
import { handoffPrompt, playbookOf, relatedMemory, relatedQuery, taskPrompt, taskSystem } from "./prompts";
import { clearStderr, engine, expand, explain, isAlive, isModelError, listen, markAlive, markDead, request as rpcRequest, stderrOf } from "./rpc";

const KIND_IDS: unknown[] = KINDS.map((k) => k.id);

interface Run {
  /** what it turned to this session (apps, devices, sites, programs, steps): memory about each is looked up once */
  things?: Set<string>;
  /** searches the provider ran itself, still open (hostedSearch.ts) */
  hosted?: Set<string>;
  text: string;
  cursor: number;
  streaming: boolean;
  done?: string;
  handoff?: Handoff;
  asked: boolean;
  /** what the job said becomes of its branch at the end ({"type":"merge"} / {"type":"discard"});
   *  "fix" = {"type":"merge","kind":"fix"}: a bug or performance fix, merged only when all of it was checked */
  land?: "merge" | "discard" | "fix" | "keep";
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
  /** when the plan last moved (a plan or now block), or the run began */
  planMovedAt?: number;
  planNudges?: number;
  /** the user's words said while it worked, until the model takes them (then `replanCalls` counts) */
  replanFor?: string;
  /** tool calls since it took the user's words without sending a new plan */
  replanCalls?: number;
  /** said done with steps the user asked for still open: sent back once */
  askedGate?: boolean;
  /** when it was told to ask the user about what it left unchecked, instead of finishing */
  uncheckedAt?: number;
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
  /** softer misses written down instead of a second send-back: in the job's record, not asked about */
  noted?: string[];
  /** unverified items given with no real reason they couldn't be done here */
  bare?: string[];
  /** already sent back once for missing review/evidence */
  gated?: boolean;
  /** times the job was sent back before done (max 2) */
  gates?: number;
  /** the summary of the first done: the whole job, kept when the proof check sends it back */
  firstDone?: string;
  /** status looks at running work (sleep, tail, ps …) this run */
  polls?: number;
  /** the look those polls repeat */
  lastPoll?: string;
  /** how many times it was told its context is long (handoff) */
  longNudges?: number;
  /** a handoff sent while subagents still worked: the new session starts once they are done */
  pendingHandoff?: Handoff;
  /** a review it asked for was refused (one per job): said again as a prompt if the turn ended waiting for it */
  refused?: string;
  /** asked once, after a turn ended with no done block, whether it is finished */
  askedDone?: boolean;
  /** the message being written has said or called something (not only reasoned) */
  msgActed?: boolean;
  /** a message that only reasoned past THINK_MAX_MS was cut: the turn's end sends it on to its next step */
  thinkCut?: boolean;
  /** what the turn's end sends after a cut (THINK_CUT by default) */
  cutNote?: string;
  /** when the engine last sent anything (an event of any kind) */
  heardAt?: number;
  /** turns cut because the model sent nothing for MODEL_SILENT_MS */
  silentCuts?: number;
  /** asked to hand off because its account is nearly out (once per session) */
  limitAsked?: boolean;
  /** the engine is compacting the conversation (quiet while it does, not hung) */
  compacting?: boolean;
  /** the user spoke while it waited to hand off: the new session starts at the turn's end, subagents or not */
  handoffNow?: boolean;
  /** the provider refused the session itself (400): it went on once in a fresh session */
  freshAfterRefusal?: boolean;
  /** toolCallId → when that shell's output last changed (the search and wait watchdog) */
  changed?: Map<string, number>;
  /** searches and waits the watchdog already tried to stop */
  searchStops?: Set<string>;
  waitStops?: Set<string>;
  /** its background commands and watches (extensions/background.ts): how many run, and how many
   *  messages from them wait for its next turn */
  bg?: { running: number; queued: number };
  /** its turn ended and it waits on something that wakes it (subagents, background commands) */
  idle?: boolean;
}


const runs = new Map<string, Run>();
export const agentOf = (taskId: string) => `t:${taskId}`;
// a long job's transcript keeps its newest entries; reaching this trims, it never ends the job
const MAX_ENTRIES = 600;
/** tool calls without a step update before a fork is asked where it is, and how often */
export const PLAN_QUIET = 20;
/** and this long without a step update: parallel reads reach 20 calls in a minute (reminders came
 *  47 to 97 seconds into a job, and again right after it had moved on) */
export const PLAN_QUIET_MS = 5 * 60_000;
export const PLAN_NUDGES = 2;
/** tool calls after the user's words came in without a new plan before it is asked to place them */
export const REPLAN_CALLS = 3;
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
/** the account picked for the Discord agent in this workspace, if one is and it is still there */
export function agentAccount(space: Task["space"], channel?: string): string | undefined {
  const a = state.settings.agent;
  const place = channel ? a?.places?.find((p) => p.channel === channel) : undefined;
  // a channel set to its own workspace has its own account there (or that workspace's choice)
  const id = place?.space ? place.account : (place?.account ?? a?.account);
  return id && id !== "auto" && loggedIn(space).some((a) => a.id === id) ? id : undefined;
}

export function chooseAccount(space: Task["space"], topic: string): string {
  const pool = loggedIn(space);
  // never another space's account: with none here, there is none
  if (!pool.length) return "";
  const pick = state.accountPick?.[space];
  if (pick && pick !== "auto" && pool.some((a) => a.id === pick)) return pick;
  if (pool.length === 1) return pool[0].id;
  const auto = autoPool(space);
  if (auto.length === 1) return auto[0].id;
  // one the provider just said no to, or nearly out, sits out; the rest is kept under 85% of every window
  const open = auto.filter((a) => !accountFull(a.id));
  const roomy = open.filter((a) => load(a.id) < 85);
  const use = roomy.length ? roomy : open.length ? open : auto;
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

/** the space's accounts that are logged in (all of them when none is yet) */
const loggedIn = (space: Task["space"]) => {
  const all = accountsIn(space);
  const on = all.filter((a) => a.providers.length);
  return on.length ? on : all;
};
/** the accounts 자동 routes between: a direct connection (a local model, a gateway) only when it is all there is */
const autoPool = (space: Task["space"]) => {
  const pool = loggedIn(space);
  const routed = pool.filter((a) => !isDirect(a));
  return routed.length ? routed : pool;
};
/** how full an account's fullest plan window is, in percent */
const load = (id: string) => Math.max(0, ...usageOf(id).map((l) => l.used));

/** The provider refused for the account's limit (a plan window used up, or too much at once). */
export const isUsageLimit = (e: string) => /rate.?limit|usage.?limit|exceed your account|\b429\b|quota|too many requests/i.test(e) && !/context|too long|prompt is too/i.test(e);

/** accounts the provider said no to → until when they sit out 자동 routing */
const limitedUntil = new Map<string, number>();
const limited = (id: string, at = Date.now()) => (limitedUntil.get(id) ?? 0) > at;
/** An account hit its limit: 자동 leaves it until its full window resets (10 minutes for a short burst limit). */
export function markLimited(accountId: string, at = Date.now()) {
  const full = usageOf(accountId, at).filter((l) => l.used >= 95 && l.resetsAt);
  limitedUntil.set(accountId, full.length ? Math.max(...full.map((l) => l.resetsAt!)) : at + 10 * 60_000);
  void refreshLimits(accountId, true);
}
/** A window this full (%) is nearly out: no new work goes there, and a job on it hands off while it still can. */
const FULL = 95;
/** too full to keep sending work to: refused lately, or a window at FULL or more */
export const accountFull = (id: string) => limited(id) || load(id) >= FULL;

/** The space routes on 자동 and the job wasn't put on an account by hand. */
export const autoRouted = (t: Pick<Task, "space" | "accountPinned">) => !t.accountPinned && (state.accountPick?.[t.space] ?? "auto") === "auto";

/**
 * Where work goes on when its account is full: another account of the space with room,
 * one on the same service first (the conversation and its model carry over as they are),
 * the emptiest of them. None with room: undefined.
 */
export function spareAccount(space: Task["space"], from: string): string | undefined {
  const cur = accountById(from);
  const free = autoPool(space).filter((a) => a.id !== from && !accountFull(a.id));
  if (!free.length) return undefined;
  const same = free.filter((a) => a.providers.some((p) => cur?.providers.includes(p)));
  return [...(same.length ? same : free)].sort((a, b) => load(a.id) - load(b.id) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0].id;
}
/** The account a job on 자동 moves to at a fresh session: its own is full, or past 85% with one under it free. */
export function movesAt(t: Pick<Task, "space" | "accountId" | "accountPinned">): string | undefined {
  if (!autoRouted(t)) return undefined;
  const spare = spareAccount(t.space, t.accountId);
  if (!spare) return undefined;
  return accountFull(t.accountId) || (load(t.accountId) >= 85 && load(spare) < 85) ? spare : undefined;
}
/** a refusal for the account's limit; a 503 counts on an account nearly out (GPT answers its limit with 503 now) */
export const hitLimit = (e: string, accountId: string) => isUsageLimit(e) || (/\b503\b|service unavailable/i.test(e) && load(accountId) >= 90);
/** Kill a job's engine and wait for its exit, so it doesn't land on the next engine's listeners. */
async function stopEngine(agent: string) {
  const gone = new Promise<void>((done) => {
    listen(agent, { event() {}, exit: () => done() });
    setTimeout(done, 3000);
  });
  void agentKill(agent);
  await gone;
  markDead(agent);
}

/** whether two accounts sign in to the same service (a model of one runs on the other) */
const sameService = (a: string, b: string) => {
  const x = accountById(a)?.providers ?? [];
  return (accountById(b)?.providers ?? []).some((p) => x.includes(p));
};

export const NO_ACCOUNT = "이 워크스페이스에 계정이 없어요";

/** what a job is told when its account is nearly out: it never tells it to stop working */
const LIMIT_STEER =
  '(Ondra) The account this job runs on has nearly used up its usage limit. Finish the step you are on without starting a new one, then send a {"type":"handoff"} block (did, found, next, doneWhen, evidence) right away: a fresh session on another account continues from it. If only the wrap-up is left, send done instead.';

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

const browserCheckAt = new Map<string, number>();
function recheckBrowser(space: string) {
  if (Date.now() - (browserCheckAt.get(space) ?? 0) < 30_000) return;
  browserCheckAt.set(space, Date.now());
  void browserCheck(space).catch(() => {});
}

/** What one turn used (null if nothing moved). */
export function turnUsage(a: TokenStats, b: TokenStats, accountId: string, genMs?: number, ms?: number): Usage | null {
  const reset = b.input < a.input || b.cacheRead < a.cacheRead || b.output < a.output;
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
 * What a job's model sees up front: the four file/shell tools, memory search and use.
 * Every other tool (phone devices, saving memory, web, jobs, skills …) is registered as
 * deferred and called through use by name (extensions/use.ts). No tool_search: Ondra loads
 * no MCP servers (the engine runs with --no-extensions), so use reaches everything.
 */
export const WORKER_TOOLS: string[] = [];

/**
 * A job's tool flags: WORKER_TOOLS plus the tools turned on in Settings › 도구.
 * Each one is a "+name" modifier, so the engine's defaults (read, bash, edit, write)
 * stay and nothing can be taken away here. No extra tools = exactly WORKER_TOOLS.
 */
export function workerTools(extra: readonly string[] | undefined = state.settings.extraTools): string[] {
  // exact names only: "+name" entries take no patterns, and a comma would split the list
  const names = [...new Set((extra ?? []).map((n) => n.trim()).filter((n) => /^\w[\w.:-]*$/.test(n)))];
  if (!names.length) return WORKER_TOOLS;
  return ["--tools", names.map((n) => `+${n}`).join(",")];
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
export { closePlan, nextPlan } from "./plan";

/** a sentence of English prose shown to a user who writes Korean */
/** the user writes Korean in this job (the first words it was given) */
const writesKorean = (t: Pick<Task, "entries"> | undefined) => {
  const said = t?.entries.find((e) => e.kind === "user");
  return !!said && "text" in said && /[\uac00-\ud7a3]/.test(String(said.text));
};

/**
 * Ondra's own words to a job ("(Ondra) …") are English. In a long run with many of them a job
 * drifts into answering in English; each one says which language the user reads.
 */
function request(agent: string, command: Record<string, unknown>, timeoutMs?: number) {
  const msg = command.message;
  if (agent.startsWith("t:") && typeof msg === "string" && msg.startsWith("(Ondra)") && writesKorean(taskById(agent.slice(2))))
    command = { ...command, message: `${msg}\n(What the user reads stays in Korean.)` };
  return rpcRequest(agent, command, timeoutMs);
}

export function notTheirLanguage(text: string, t: Pick<Task, "entries"> | undefined): boolean {
  if (!writesKorean(t)) return false;
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").trim();
  if (prose.length < 20 || /[\uac00-\ud7a3]/.test(prose)) return false;
  return (prose.match(/[A-Za-z]+/g) ?? []).length >= 4;
}

export const chineseOnly = (s: string) => /[\u4e00-\u9fff]/.test(s) && !/[\uac00-\ud7a3]/.test(s);

const isNotesFile = (p: string) => /(^|\/)(now|handoff|log|MEMORY|memory|NOTES|notes|TODO|todo)\.md$|\/(context|memory|memories|wiki|\.omd\/handoff)\/.*\.md$/.test(p);
const lines = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);

const jobName = (id: unknown) => (typeof id === "string" ? (taskById(id)?.title ?? id) : "");

/** The app the task's latest computer session works in. */
function sessionApp(t: Task): string | undefined {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    if (e.kind === "tool" && e.tool.name === "computer" && e.tool.app) return e.tool.app;
  }
  return undefined;
}

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
    case "skill":
      return { name, kind: "read", target: String(args?.query ?? ""), detail: String(args?.query ?? ""), now: "스킬 읽는 중" };
    case "web_search":
    case "web_lookup":
      return { name, kind: "search", target: String(args?.query ?? ""), detail: JSON.stringify(args ?? {}), now: "웹 검색 중" };
    case "web_fetch": {
      const url = String(args?.url ?? "");
      return { name, kind: "read", target: url.replace(/^https?:\/\/(www\.)?/, ""), detail: url, now: "웹 페이지 읽는 중" };
    }
    case "bash": {
      const cmd: string = args?.command ?? "";
      // what the command runs, not what it reads: `sed -n 1,18p a.test.tsx` is no test run
      if (runsProgram(cmd, /\bondra-browser\b|(?:^|\/)browse(?=\s|$)/)) return { name, kind: "browser", target: cmd.replace(/^.*?(?:ondra-browser|(?:^|\/)browse)\s+(--\S+\s+\S+\s+)*/, ""), detail: cmd, now: describeBrowser(cmd).nowKo };
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
    // a Mac app driven in the background: the step and what it worked on ("클릭함 ‘보내기’")
    case "computer": {
      const s = computerStep(args);
      return { name, kind: "desktop", act: s.action, target: s.target ?? "", detail: JSON.stringify(args ?? {}), now: describeComputer(s.action, s.target).nowKo };
    }
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

/**
 * A later handoff card on top of an earlier one of the same session: what was done, found and
 * shown adds up, the next step and the finish line are the newest. Replaced whole, a detailed
 * card became "checked the last install log" and the next session redid the rest.
 */
export function mergeCards(before: Handoff | undefined, after: Handoff): Handoff {
  if (!before) return after;
  const both = <T,>(a: T[] = [], b: T[] = [], key: (x: T) => string = String) => [...a, ...b].filter((x, i, all) => all.findIndex((y) => key(y) === key(x)) === i);
  const found = both(before.found, after.found);
  return {
    did: both(before.did, after.did),
    next: after.next || before.next,
    evidence: both(before.evidence, after.evidence, (e) => `${e.kind}:${e.ref}`),
    ...(found.length ? { found } : {}),
    ...(after.doneWhen || before.doneWhen ? { doneWhen: after.doneWhen || before.doneWhen } : {}),
  };
}

/** The unticked items of the checklists sent alongside a done, not already in its unverified list. */
export function openChecks(blocks: any[], listed: { what: string }[]): string[] {
  const said = listed.map((u) => u.what.trim());
  return blocks
    .filter((b) => b?.type === "checklist" && Array.isArray(b.items))
    .flatMap((b) => b.items.filter((i: any) => i && i.done === false && String(i.label ?? "").trim()).map((i: any) => String(i.label).trim()))
    .filter((l: string, i: number, all: string[]) => all.indexOf(l) === i && !said.some((w) => w.includes(l) || l.includes(w)));
}

/** the same question with the same choices and things to fill in */
const sameAsk = (a: Decision, b: Decision) =>
  !a.ui && a.kind === b.kind && a.question.trim() === b.question.trim() &&
  a.options.map((o) => o.label).join("\n") === b.options.map((o) => o.label).join("\n") &&
  (a.form ?? []).map((f) => f.label).join("\n") === (b.form ?? []).map((f) => f.label).join("\n");

function applyBlocks(t: Task, items: any[], run: Run) {
  const sent = items;
  for (const b of items) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
    switch (b.type) {
      case "now":
        // a status line in Chinese (a model slipping language) is dropped, not shown
        if (b.text && !chineseOnly(String(b.text))) {
          t.now = t.intent = String(b.text).slice(0, 140);
          const said = t.now;
          queueMicrotask(() => recallOnTheWay(t.id, run, [said], false));
        }
        run.quietTools = 0;
        run.planMovedAt = Date.now();
        if (b.step !== undefined) moveTo(t.plan, b.step);
        break;
      case "plan":
        if (Array.isArray(b.steps)) {
          t.plan = nextPlan(t.plan, b.steps);
          run.quietTools = 0;
          run.planMovedAt = Date.now();
          // the user's words said while it worked are in the plan now
          run.replanCalls = undefined;
          t.planAsk = undefined;
        }
        break;
      case "ask": {
        if (t.self) {
          // nobody is asked in a job Ondra started by itself: it decides
          push(t, { kind: "note", text: "자동 검사라 묻지 않고 스스로 정해요" });
          void tell(t.id, SELF_DECIDES, { by: "ondra", shown: tr("묻지 않고 정하기") });
          break;
        }
        // a round of questions (the sharpen skill): one card at a time, its recommendation the one choice
        const round = readRound(b);
        const clarity = readClarity(b.clarity);
        const fields = readFields(b.fields);
        const d: Decision = round ? roundDecision({ id: uid("d"), taskId: t.id, at: Date.now(), context: Array.isArray(b.context) ? b.context : [] }, round.qs, [], round.clarity) : {
          id: uid("d"),
          taskId: t.id,
          at: Date.now(),
          kind: "ask",
          ...(clarity ? { clarity } : {}),
          question: String(b.question ?? "확인 필요"),
          ...(fields ? { form: fields } : {}),
          // "label" or {label, note}: the note says what that choice means; a form is sent with one button
          options: (Array.isArray(b.options) && b.options.length ? b.options : fields ? ["보내기"] : ["진행", "중단"]).slice(0, 5).map((o: any, i: number) => {
            const label = String(o && typeof o === "object" ? (o.label ?? o.name ?? "") : o);
            const note = o && typeof o === "object" && o.note ? String(o.note) : undefined;
            return { id: label, label, primary: i === 0, ...(note ? { note } : {}) };
          }),
          context: Array.isArray(b.context) ? b.context : [],
        };
        // the same question asked again (woken before it was answered): the card it has stays
        const open = state.decisions.find((x) => x.taskId === t.id);
        if (!open || !sameAsk(open, d)) setState("decisions", (list) => [...list.filter((x) => x.taskId !== t.id), d]);
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
      // a pet job made a pet (skills/pet-maker): it goes on the screen
      case "pet": {
        const id = typeof b.id === "string" ? b.id : "";
        if (!id || t.parentId) break;
        void import("./pet").then((m) => m.wearPet(id));
        push(t, { kind: "note", text: "펫을 화면에 띄웠어요" });
        break;
      }
      // the branch's fate, when the user (or a memory rule) already said: done after the turn
      case "merge":
      case "discard":
      case "keep":
        run.land = b.type === "merge" && b.kind === "fix" ? "fix" : b.type;
        break;
      case "handoff":
        // sent again before the new session started (a late result woke it): the cards add up
        run.handoff = mergeCards(run.handoff ?? run.pendingHandoff, {
          did: Array.isArray(b.did) ? b.did.map(String) : [],
          next: String(b.next ?? ""),
          evidence: Array.isArray(b.evidence) ? b.evidence : [],
          found: Array.isArray(b.found) ? b.found.map(String) : undefined,
          doneWhen: b.doneWhen ? String(b.doneWhen) : undefined,
        });
        break;
      case "done": {
        run.done = String(b.summary ?? "완료");
        t.saidDone = run.done;
        if (b.result) t.result = String(b.result).slice(0, 8000);
        const items: Evidence[] = Array.isArray(b.evidence) ? b.evidence.filter((e: any) => e && e.ref).map((e: any) => ({ kind: String(e.kind ?? "file"), ref: String(e.ref), ok: e.ok !== false, note: e.note ? String(e.note) : undefined })) : [];
        const listed = readUnverified(b.unverified);
        // a checklist it sent with this done, with items left unticked: those weren't checked either
        const unverified = [...listed.map(uncheckedLine), ...openChecks(sent, listed)];
        run.bare = unreasoned(listed).map((u) => u.what);
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
      default: {
        if (b.type === "shot" && b.path) t.shot = b.path;
        // a card that keeps changing: the earlier one goes, the newest is at the end
        const live = liveKey(b.live);
        if (live) {
          b.live = live;
          const i = t.entries.findIndex((e) => e.kind === "block" && e.block.live === live);
          if (i >= 0) t.entries.splice(i, 1);
        }
        push(t, { kind: "block", block: b as Block });
      }
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
    ...(parent.agent ? { agent: parent.agent } : {}),
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

/**
 * Memory about what the job just turned to (a step, or an app, device, site or program), sent to it
 * once when there is some it wasn't given. Names are looked up once a session; a piece never twice.
 */
function recallOnTheWay(id: string, run: Run, about: string[], names: boolean) {
  const seen = (run.things ??= new Set());
  const todo = about.filter((x) => !seen.has(x.toLowerCase()));
  if (!todo.length) return;
  for (const x of todo) seen.add(x.toLowerCase());
  const t0 = taskById(id);
  // a review lens checks the memory it was given, nothing more
  if (!t0 || t0.lens) return;
  const query = todo.join(" ");
  void (async () => {
    await prepareQuery(query, 800);
    const t = taskById(id);
    // a job that just asked waits on the user: a steer now would wake it to ask again
    if (!t || runs.get(id) !== run || !run.streaming || run.asked) return;
    const hits = recallNow(t, query, names);
    if (!hits.length) return;
    markUsed(hits.map((m) => m.id));
    const more = hits.length > 1 ? ` 외 ${hits.length - 1}개` : "";
    updateTask(id, (x) => {
      x.recalled = [...(x.recalled ?? []), ...hits.map((m) => m.id)];
      push(x, { kind: "note", text: `기억 불러옴 · ${hits[0].text.slice(0, 80)}${more}` });
    });
    const what = names ? todo.join(", ") : "the step you're on";
    void request(agentOf(id), {
      type: "steer",
      message: `(Ondra) From the user's memory, about ${what} (not in what you were given at the start):\n${memoryLines(hits).join("\n")}\nFollow what applies to this work; ignore what doesn't.`,
    }).catch(() => {});
  })();
}

/** A user message started in the engine: a queued one (steer, follow-up) the model now takes. */
function tookMessage(id: string, text: string) {
  const p = (taskById(id)?.pending ?? []).find((x) => text === x.text || text.startsWith(x.text));
  if (p) heard(id, [{ ...p }]);
  // the user's words said while it worked: from now on it has them, and places them in its plan
  const run = runs.get(id);
  if (run?.replanFor && (text === run.replanFor || text.startsWith(run.replanFor))) {
    run.replanFor = undefined;
    run.replanCalls = 0;
  }
}

/**
 * It took the user's words a few tool calls ago and its plan hasn't changed: asked once to put
 * them where they belong (or carry on, when they only asked something).
 */
function askReplan(id: string, run: Run) {
  run.replanCalls = undefined;
  const t = taskById(id);
  if (!t) return;
  if (t.planAsk) updateTask(id, (x) => (x.planAsk = undefined));
  if (!run.streaming) return;
  const list = t.plan.length ? `\nCurrent list:\n${planText(t.plan).join("\n")}` : "";
  void request(agentOf(id), {
    type: "steer",
    message: `(Ondra) The user's message came in ${REPLAN_CALLS} tool calls ago and your to-do list hasn't changed.${list}\nIf it added or changed work, send the updated plan block now: put it where it belongs by what depends on what, mark it "user": true, and say in one line where it went. If it only asked something, carry on.`,
  }).catch(() => {});
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
    // a turn still going (something woke the old session) ends first: new_session in the middle
    // of it aborts the turn, and the abort read as the job failing (settle starts it instead)
    if (run.pendingHandoff && !left && !run.streaming) {
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

/** "feat/signup-email-check": a type and a short ascii name, or nothing */
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
    // what the original folder had checked out: where "합치기" would put it back
    const at = (await gitChanges(w.repo).catch(() => null))?.branch;
    // a detached checkout has no branch to go back to
    const from = at && at !== "HEAD" ? at : undefined;
    updateTask(id, (x) => {
      x.worktree = { ...w, state: "open", ...(from ? { from } : {}) };
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
  { const r = far(id, "mergeTask", [id]); if (r) return r as never; }
  const why = await mergeWhy(id);
  if (why === undefined) return true;
  toast(/conflict|충돌/i.test(why) ? tr("충돌이 있어서 병합하지 못했어요") : tr("병합하지 못했어요 · {why}", { why: why.split("\n")[0] }), "bad");
  return false;
}

/** Merge here and now: nothing back when it went in, else git's own words for what stopped it. */
async function mergeWhy(id: string): Promise<string | undefined> {
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open") return "이 작업에는 합칠 브랜치가 없어요";
  if (t.status === "running" || t.status === "waiting") pauseTask(id);
  try {
    const env = await gitEnv(t);
    const into = await worktreeMerge(w.repo, w.path, w.branch, t.title, env);
    const left = await dropWorktree(t, false, env);
    updateTask(id, (x) => {
      const now = Date.now();
      x.worktree = { ...w, state: "merged", into, ...(left ? { left } : {}) };
      x.cwd = homeDir(x);
      x.mergedAt = now;
      push(x, { kind: "note", text: left ? `${into}에 병합` : `${into}에 병합 · 워크트리 정리` });
      if (x.status !== "done") {
        x.status = "done";
        x.plan = closePlan(x.plan);
        x.finishedAt = now;
        x.summary ||= `${into}에 병합`;
      }
    });
    toast(tr("{into}에 병합했어요", { into }));
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** What the job is told when its merge did not go in: it finds out why and sorts it out with the user. */
const mergeFailed = (why: string, home: string) =>
  `(Ondra) Merging your branch into ${home} failed. Git said:\n${why.trim()}\n` +
  "Find out why. If the original folder has the user's own uncommitted changes in the way, don't touch them: " +
  "name the files and ask (an ask block) what to do with them. A conflict: resolve it on your branch (merge the target in, fix, commit). " +
  'Once the way is clear, send {"type":"merge"} with your done to try again.';

/**
 * A finished job with changes on its branch: it asks the user what becomes of
 * them (merge, a pull request, or throw them away), every time. Nothing to ask
 * when the work went into a PR or has already landed.
 */
async function askMerge(id: string, why?: string) {
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || t.parentId || !w || w.kept || t.status !== "done") return;
  if (state.decisions.some((d) => d.taskId === id)) return;
  const pr = prOf(t);
  if (pr) return askMergePr(id, pr);
  if (w.state !== "open") return;
  const c = await gitChanges(w.path, w.base).catch(() => null);
  if (!c?.isRepo || !c.files.length) return;
  const home = homeDir(t).split("/").filter(Boolean).pop() ?? homeDir(t);
  // on GitHub: the user's own folder is never merged into, only kept up to date (syncHome)
  const github = await gitOnGithub(homeDir(t)).catch(() => false);
  if (t.self) return selfLands(id, github);
  const into = github ? null : await homeBranch(t);
  if (taskById(id)?.worktree?.state !== "open" || state.decisions.some((x) => x.taskId === id)) return;
  const d: Decision = {
    id: uid("d"),
    taskId: id,
    at: Date.now(),
    kind: "merge",
    question: `${why ? `${why} · ` : ""}${
      github
        ? tr("바뀐 파일 {n}개를 PR로 올릴까요?", { n: c.files.length })
        : into
          ? tr("바뀐 파일 {n}개를 {home}의 {branch} 브랜치에 합칠까요?", { n: c.files.length, home, branch: into })
          : tr("바뀐 파일 {n}개를 {home}에 합칠까요?", { n: c.files.length, home })
    }`,
    options: [
      { id: "pr", label: tr("PR로 올리기"), primary: true, note: tr("브랜치를 올리고 풀 리퀘스트를 열어요") },
      ...(github ? [] : [{ id: "merge", label: tr("합치기"), note: into ? tr("원래 폴더의 지금 브랜치({branch})에 합쳐요", { branch: into }) : tr("원래 폴더의 지금 브랜치에 합쳐요") }]),
      { id: "discard", label: tr("버리기"), note: tr("이 작업이 바꾼 것을 지워요") },
    ],
    context: [],
  };
  setState("decisions", (list) => [...list.filter((x) => x.taskId !== id), d]);
  updateTask(id, (x) => (x.unread = true));
}

/** A job's pull request still open on GitHub: whether to merge it is asked, not left as a badge.
 *  Its job merges it when told to (it knows the repo's way). */
async function askMergePr(id: string, pr: { url: string; n: string }) {
  const t = taskById(id);
  if (!t) return;
  let open = false;
  try {
    open = JSON.parse(await ghPrState(pr.url, await gitEnv(t))).pr?.state === "OPEN";
  } catch {
    open = false;
  }
  const now = taskById(id);
  if (!open || !now || now.worktree?.kept || state.decisions.some((x) => x.taskId === id)) return;
  const d: Decision = {
    id: uid("d"),
    taskId: id,
    at: Date.now(),
    kind: "merge",
    question: tr("PR #{n} 머지할까요?", { n: pr.n }),
    options: [
      { id: "merge-pr", label: tr("머지하기"), primary: true, note: tr("GitHub에서 PR을 합치고 브랜치를 지워요") },
      { id: "keep", label: tr("그대로 두기"), note: tr("PR을 열어 둔 채로 둬요") },
    ],
    context: [],
  };
  setState("decisions", (list) => [...list.filter((x) => x.taskId !== id), d]);
  updateTask(id, (x) => (x.unread = true));
}

/** A job Ondra started by itself is never asked about: on GitHub it goes up as a PR (someone reviews
 *  it there), elsewhere its branch stays as it is; either is said once in its record. */
async function selfLands(id: string, github: boolean) {
  const note = github ? "자동 검사라 묻지 않고 PR로 올려요" : "자동 검사라 묻지 않고 브랜치로 남겨 둬요";
  if (taskById(id)?.entries.some((e) => e.kind === "note" && e.text === note)) return;
  updateTask(id, (x) => push(x, { kind: "note", text: note }));
  if (github) await tell(id, PR_ASK, { by: "ondra", shown: tr("PR로 올리기") });
}

/** the branch the original folder has checked out now: where a local merge goes */
const homeBranch = async (t: Task): Promise<string | null> => {
  const b = t.worktree ? (await gitChanges(t.worktree.repo).catch(() => null))?.branch : null;
  return b && b !== "HEAD" ? b : null;
};

/** The last done's evidence has a test or build the app saw run and pass in the session (not the job's word). */
const ranChecks = (t: Pick<Task, "entries">) => {
  for (let i = (t.entries ?? []).length - 1; i >= 0; i--) {
    const e = t.entries[i];
    if (e.kind === "block" && e.block.type === "evidence")
      return e.block.items.some((x) => (x.kind === "test" || x.kind === "build") && x.check === "ran" && x.ok !== false && !x.why);
  }
  return false;
};

/**
 * A fix lands on its own: a bug or performance fix that changes nothing the user sees, nothing
 * left unchecked, and a test or build the app saw pass. Otherwise, or the setting off: the user is asked.
 */
export const fixLands = (t: Pick<Task, "unverified" | "entries">) => state.settings.autoMergeFixes !== false && !t.unverified?.length && ranChecks(t);

/** the same answer this many times in a row for a project's branches: it stops being asked */
export const LAND_STREAK = 3;

/**
 * The user answered "what becomes of this branch": kept per project. The same merge or PR
 * answer LAND_STREAK times in a row becomes a project decision in memory, and jobs act on it
 * without asking (the git note tells them to). A discard is about that one job, not a habit.
 */
export function noteLandAnswer(t: Task, pick: "merge" | "pr" | "discard", now = Date.now()): string | null {
  const folder = projectById(t.project, t.space)?.folder;
  if (!folder) return null;
  const list = [...(state.landAnswers ?? []), { folder, pick, at: now }].slice(-60);
  setState("landAnswers", list);
  if (pick === "discard") return null;
  const last = list.filter((a) => a.folder === folder && a.pick !== "discard").slice(-LAND_STREAK);
  if (last.length < LAND_STREAK || last.some((a) => a.pick !== pick)) return null;
  const text =
    pick === "merge"
      ? tr("이 프로젝트에서 작업이 끝나면 묻지 않고 원래 폴더에 합쳐요 (사용자가 {n}번 연속 합치기를 골랐어요)", { n: LAND_STREAK })
      : tr("이 프로젝트에서 작업이 끝나면 묻지 않고 PR로 올려요 (사용자가 {n}번 연속 PR을 골랐어요)", { n: LAND_STREAK });
  const had = state.memory.find((m) => !m.invalidAt && m.scope === "project" && m.project === folder && m.key === "land");
  if (had?.text === text) return null;
  // the key names the one decision per project: a new streak replaces the old one; the user's own words stay
  return addMemory(text, "project", { space: t.space, project: folder, kind: "decision", key: "land", importance: 4, by: "agent", source: "ondra", taskId: t.id });
}

/** what a job Ondra started by itself is told when it asks the user something */
export const SELF_DECIDES =
  "(Ondra) Ondra started this job by itself, so nobody is asked here: the user doesn't know about it. Decide yourself from the rule and the code; when it isn't clear, change nothing and say why with done. What you couldn't check goes in unverified.";

const PR_ASK = "Push your branch and open a pull request for it (follow the project's memory for the base branch, account and PR rules), then send done with the PR link.";

/**
 * A job's PR was merged on GitHub (its worktree is gone by then): the user's local main of that
 * project becomes GitHub's latest, as a fast-forward only (gitSyncHome), checked out or not.
 */
export async function syncHome(t: Task) {
  const home = homeDir(t);
  if (!(await gitOnGithub(home).catch(() => false))) return;
  const r = await gitSyncHome(home, await gitEnv(t)).catch((e) => ({ state: "skipped", branch: "", note: String(e) }) as const);
  logInfo("land", `${t.id} home ${home}: ${r.state} ${r.branch} ${r.note}`);
  if (r.state === "updated") updateTask(t.id, (x) => push(x, { kind: "note", text: r.branch === "main" ? "로컬 main을 GitHub 최신으로 맞췄어요" : "로컬 기본 브랜치를 GitHub 최신으로 맞췄어요" }));
}

/** The job put its branch in a pull request: the merge is GitHub's now (cleaned up when it's
 *  merged there), so the job isn't 병합 필요. */
function markPr(id: string) {
  const t = taskById(id);
  const pr = t && !t.parentId && t.worktree?.state === "open" && !t.worktree.pr ? prOf(t) : undefined;
  if (pr) updateTask(id, (x) => x.worktree && (x.worktree.pr = pr.url));
}

/** The job's own say on its branch, then the question if it is still open. */
export async function landBranch(id: string, land?: "merge" | "discard" | "fix" | "keep") {
  const t = taskById(id);
  if (!t || t.worktree?.state !== "open") return;
  if (land === "discard") return discardTask(id);
  markPr(id);
  if (land === "keep") {
    updateTask(id, (x) => {
      if (x.worktree) x.worktree.kept = true;
      push(x, { kind: "note", text: "브랜치를 그대로 남겨 뒀어요" });
    });
    return;
  }
  if (land === "fix" && !fixLands(t) && t.self) return askMerge(id);
  if (land === "fix" && !fixLands(t))
    return askMerge(id, state.settings.autoMergeFixes === false ? undefined : t.unverified?.length ? tr("확인 못 한 게 있어요") : tr("테스트·빌드를 돌린 기록이 없어요"));
  if ((land === "merge" || land === "fix") && (await gitOnGithub(homeDir(t)).catch(() => false))) {
    // the project lives on GitHub: what lands without asking goes up as a PR, the user's folder is left alone
    updateTask(id, (x) => push(x, { kind: "note", text: land === "fix" ? "확인된 수정이라 묻지 않고 PR로 올려요" : "묻지 않고 PR로 올려요" }));
    return void (await tell(id, PR_ASK, { by: "ondra", shown: tr("PR로 올리기") }));
  }
  // the original folder moved to another branch since the job started: not merged there without a word
  if (land === "merge" || land === "fix") {
    const from = t.worktree?.from;
    const now = from ? await homeBranch(t) : null;
    if (from && now && now !== from) return askMerge(id, tr("원래 폴더가 지금 {now} 브랜치예요 ({from}에서 시작했어요)", { now, from }));
  }
  if (land === "fix") updateTask(id, (x) => push(x, { kind: "note", text: "확인된 수정이라 묻지 않고 합쳐요" }));
  if (land === "merge" || land === "fix") {
    const why = await mergeWhy(id);
    if (why !== undefined) await tell(id, mergeFailed(why, homeDir(t)), { by: "ondra", shown: tr("병합하지 못했어요") });
    return;
  }
  // nothing settled by the job: asked (a PR it opened: merge it?; a branch: PR, merge or discard), so
  // 병합 필요 never sits there as a badge alone. A job Ondra started by itself still goes up as a PR first.
  await askMerge(id);
}

/** Throw the task's changes away (worktree and branch). */
/** The pull request this job opened or worked on, if its record names one (newest wins). */
export function prOf(t: Task): { url: string; n: string } | undefined {
  const re = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    const text = e.kind === "tool" ? `${e.tool.target} ${e.tool.detail ?? ""}` : e.kind === "block" ? JSON.stringify(e.block) : "text" in e ? String(e.text ?? "") : "";
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
  { const r = far(id, "closeWorktree", [id]); if (r) return r as never; }
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open") return;
  if (t.status === "running" || t.status === "waiting") pauseTask(id);
  const left = await dropWorktree(t, true, await gitEnv(t), true);
  updateTask(id, (x) => {
    x.worktree = { ...w, state: "discarded", ...(left ? { left } : {}) };
    x.cwd = homeDir(x);
    push(x, { kind: "note", text: "워크트리 정리 · 변경은 PR에 있어요" });
  });
}

export async function discardTask(id: string) {
  { const r = far(id, "discardTask", [id]); if (r) return r as never; }
  const t = taskById(id);
  const w = t?.worktree;
  if (!t || !w || w.state !== "open") return;
  if (t.status === "running" || t.status === "waiting") pauseTask(id);
  const left = await dropWorktree(t, false, await gitEnv(t), true);
  updateTask(id, (x) => {
    x.worktree = { ...w, state: "discarded", ...(left ? { left } : {}) };
    x.cwd = homeDir(x);
    x.discardedAt = Date.now();
    push(x, { kind: "note", text: "변경을 버렸어요" });
  });
}

export async function startTask(id: string, resume = false, rewind?: { from: string; message: string }) {
  { const r = far(id, "startTask", [id, resume, rewind]); if (r) return r as never; }
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
  // on 자동, a fresh session on an account that is full starts on one with room instead (nothing is
  // cached for it anywhere yet). A resumed session stays: moving it would re-send it all uncached; if
  // the limit refuses it, it goes on in a fresh session from a card (settle).
  const spare = !resume && autoRouted(t0) && accountFull(t0.accountId) ? spareAccount(t0.space, t0.accountId) : undefined;
  const account = spaceAccount(t0.space, t0.topic, spare ?? t0.accountId);
  if (!account) return fail(id, tr(NO_ACCOUNT));
  if (account.id !== t0.accountId)
    updateTask(id, (x) => {
      // its model runs on the new account only when that signs in to the same service
      if (!sameService(x.accountId, account.id)) x.model = undefined;
      x.accountId = account.id;
    });
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

  const run: Run = { text: "", cursor: 0, streaming: false, asked: false, turnStart: 0, planMovedAt: Date.now(), stats: zero(), tools: new Map(), modelTries: prev?.modelTries ?? 0 };
  runs.set(id, run);
  listen(agent, handlers(id, run));
  clearStderr(agent);

  try {
    const t0 = taskById(id)!;
    const t = t0;
    const env = [...(await workerEnv(id, t0.space)), ...(await accountEnv(account.id)), ...(await spaceEnv(spaceById(t0.space))), ["ONDRA_PERMISSION", t0.permission ?? "auto"] as [string, string], ["ONDRA_SPACE", t0.space] as [string, string], ["ONDRA_GITHUB_WRITE", state.settings.githubWrite === false ? "0" : "1"] as [string, string], ["ONDRA_DEVICES_ALLOWED", allowedDevices(t0.space, id).join(",")] as [string, string], ...dataEnv(t0)];
    env.push(["ONDRA_SKILL_PATHS", JSON.stringify(await skillPaths(t0.space))]);
    // the project's secrets on top of the global ones (Settings › 시크릿; native side reads them)
    const secretProject = taskProject(t0);
    if (secretProject) env.push(["ONDRA_SECRETS", `p:${secretProject}`]);
    const model = t.model || modelFor(account.id);
    // a model without tool calling (marked on its connection) runs talk-only instead of failing on its first request
    const talkOnly = !canUseTools(account.id, model);
    if (talkOnly && !resume) updateTask(id, (x) => void push(x, { kind: "note", text: "이 모델은 도구를 못 써서 대화만 해요" }));
    await prepareQuery(relatedQuery(t));
    // this user's own checks for the project, as they are now (a check job may have just added one)
    if (!t.parentId) await loadLocalChecks().catch(() => []);
    // the memory given at the first start is kept for every later session (a
    // stable prompt); later saves reach the next job
    if (!t0.memorySnapshot) {
      const picked = relatedMemory(t);
      markUsed(picked.map((m) => m.id));
      updateTask(id, (x) => (x.memorySnapshot = memoryLines(picked)));
    }
    const args = [
      "--session-dir",
      `${engine.info.dataDir}/sessions/${id}`,
      ...taskSystem(t, t.project && !t.parentId ? await readNotes(t.project) : undefined, model).flatMap((p) => ["--append-system-prompt", p]),
      // The search extension owns discovery; Pi must not advertise a catalog.
      "--no-skills",
      ...(model ? ["--model", model] : []),
      "--thinking",
      t.thinking || effortFor(account.id, model) || "high",
      ...(await workerExtensions()).flatMap((e) => ["--extension", e]),
      ...(talkOnly ? ["--no-tools"] : [...workerTools(), ...offTools(), ...(await mcpArgs(t0.space))]),
      ...(resume ? ["--continue"] : []),
    ];
    await agentSpawn(agent, cwd, args, env);
    // paused or ended while the engine was starting (it may wait on a keychain question): the
    // stop came first, so this engine goes too and is never prompted
    if (runs.get(id) !== run) return agentKill(agent);
    logInfo("engine", `${id} engine started (${model || "account model"}, ${resume ? "resumed" : "new session"}${talkOnly ? ", no tools" : ""}${t.worktree ? ", worktree" : ""})`);
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
    // a start refused because the job was stopped meanwhile is that stop, not a failure
    if (runs.get(id) !== run) return;
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
function releaseDevicesSoon(ms = DEVICE_GRACE_MS) {
  clearTimeout(deviceSweep);
  deviceSweep = setTimeout(() => {
    const keep = state.tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "waiting").map((t) => t.id);
    void jobDevicesRelease(keep).then((gone) => gone.length && void refreshDevices());
  }, ms);
}

function fail(id: string, message: string) {
  clearExtensionUi(id);
  logError("task", `${id} failed: ${message}`);
  // a folder left for it (it ran in a branch it had handed on) can go now
  setTimeout(() => void sweepWorktrees(), 0);
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
    // a summary or unverified list here is an earlier run's (one finished, then reopened): shown on
    // a failed job they told the user it had shipped ("릴리스를 공개했어요" on a job that failed later)
    t.summary = undefined;
    t.digest = undefined;
    t.unverified = undefined;
    push(t, { kind: "error", text: explain(message) });
  });
  releaseBrowser(id);
  const t = taskById(id);
  if (t?.parentId) void deliver(t);
  else if (t) endedHook?.(t);
}

function handlers(id: string, run: Run) {
  const agent = agentOf(id);
  const ui = extensionUi(id, agent, () => runs.get(id) === run);
  const self = {
    event(ev: any) {
      if (runs.get(id) !== run) return;
      run.heardAt = Date.now();
      ui.event(ev);
      // `use` only carries a call: the tool it called shows (its own events, parentToolCallId set)
      if (isUseCall(ev)) return;
      // a search its provider ran itself: a step like any tool's
      for (const x of hostedToolEvents(ev, (run.hosted ??= new Set()))) self.event(x);
      switch (ev.type) {
        case "agent_start":
          run.streaming = true;
          run.idle = false;
          run.turnStart ||= Date.now();
          break;
        case "extension_ui_request":
          if (ev.method !== "setStatus" || ev.statusKey !== BG_STATUS) break;
          run.bg = readBg(ev.statusText);
          // a command ended (or a watch spoke) after its turn ended: it goes on with that now
          if (run.bg.queued && run.idle) void wakeForBackground(id, run);
          break;
        case "message_start":
          // a message it was sent goes into the conversation: the model has it now
          if (ev.message?.role === "user") tookMessage(id, userText(ev.message));
          if (ev.message?.role === "assistant") {
            run.text = "";
            run.cursor = 0;
            run.msgAt = Date.now();
            run.msgActed = false;
            const es = taskById(id)?.entries;
            run.msgAfter = es?.[es.length - 1]?.id;
          }
          break;
        case "message_update": {
          const d = ev.assistantMessageEvent;
          if (d?.type && !String(d.type).startsWith("thinking")) run.msgActed = true;
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
          // narration slipping into English for a user who writes Korean: one reminder per session
          if (run.streaming && !run.asked && !run.langNudged && text && notTheirLanguage(text, taskById(id))) {
            run.langNudged = true;
            void request(agentOf(id), { type: "steer", message: "(Ondra) The lines between your tool calls are read by the user: write them in the language they write in (here Korean: \"이제 사진을 올려요\"), not English." }).catch(() => {});
          }
          const u = ev.message?.usage;
          noteCall(agentOf(id), u);
          const prompt = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
          // near the model's own context window: ask for a handoff (see handoff.ts)
          const level = run.longNudges ?? 0;
          const job = taskById(id);
          const win = ctx[agentOf(id)]?.window || windowFor(job?.model || (job ? modelFor(job.accountId) : undefined));
          // the gauge follows every call (the engine's own count only comes when the turn ends)
          if (prompt && win) setCtx(agentOf(id), { tokens: prompt, window: win, percent: (prompt / win) * 100 });
          const at = handoffAt(win);
          if (run.streaming && level < at.length && prompt > at[level] && !run.done && !run.handoff && !run.asked) {
            run.longNudges = level + 1;
            void request(agentOf(id), { type: "steer", message: handoffSteer(level, prompt, win) }).catch(() => {});
          }
          // its account is nearly out (on 자동, with another that has room): it hands off while it can still
          // write the card, and the fresh session goes on on the other account (newSession)
          if (job) void refreshLimits(job.accountId);
          if (run.streaming && !run.limitAsked && !run.done && !run.handoff && !run.asked && job && autoRouted(job) && accountFull(job.accountId) && spareAccount(job.space, job.accountId)) {
            run.limitAsked = true;
            void request(agentOf(id), { type: "steer", message: LIMIT_STEER }).catch(() => {});
          }
          break;
        }
        case "tool_execution_start": {
          // it went on after a refused review: the steer reached it
          run.refused = undefined;
          if (run.replanCalls !== undefined && ++run.replanCalls >= REPLAN_CALLS) askReplan(id, run);
          const tool = describeTool(ev.toolName, ev.args);
          recallOnTheWay(id, run, stepThings(ev.toolName, ev.args), true);
          updateTask(id, (t) => {
            const { now, ...call } = tool;
            // reading a picture is looking at it: the row shows it ("이미지 1개 확인함")
            if (call.kind === "read" && call.detail && /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i.test(call.detail)) {
              const p = expand(call.detail);
              call.image = p.startsWith("/") ? p : `${expand(t.cwd).replace(/\/+$/, "")}/${p.replace(/^\.\//, "")}`;
            }
            if (ev.toolName === "bash") {
              call.shellId = ev.toolCallId;
              t.shells.push({ id: ev.toolCallId, command: call.detail ?? call.target, startedAt: Date.now(), tail: "", background: keepsRunning(call.detail ?? "") });
              if (t.shells.length > MAX_SHELLS) t.shells.splice(0, t.shells.length - MAX_SHELLS);
            }
            if (call.kind === "browser") t.browser = true;
            // the app a computer step works in: the one its session opened
            if (call.name === "computer")
              call.app = call.act === "open" ? call.target : sessionApp(t);
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
          // a search that found nothing (exit 1) is an answer, not a failed step
          const failed = !!ev.isError && !(done?.kind === "tool" && done.tool.name === "bash" && answeredNo(done.tool.target ?? "", out));
          if (done?.kind === "tool") loopGuard(id, run, done.tool, !failed);
          // a fork's plan that stopped moving: ask where it is. Subagents and reviews
          // aren't asked (their list is short-lived), and a fork at most twice a session:
          // 225 reminders in 312 sessions bought a status line, not a fix.
          run.quietTools = (run.quietTools ?? 0) + 1;
          const job = taskById(id);
          const plan = job?.plan ?? [];
          // a fork that never sent a plan is asked for one the same way (not a small job: it owes none)
          const none = !plan.length && !!job && job.size !== "small";
          if (run.streaming && !job?.parentId && run.quietTools >= PLAN_QUIET && Date.now() - (run.planMovedAt ?? 0) >= PLAN_QUIET_MS && (run.planNudges ?? 0) < PLAN_NUDGES && (none || plan.some((s) => s.state !== "done"))) {
            run.quietTools = 0;
            run.planMovedAt = Date.now();
            run.planNudges = (run.planNudges ?? 0) + 1;
            const book = job && playbookOf(job);
            const message = none
              ? `(Ondra) You haven't sent a plan yet. Send a plan block now ({"type":"plan","steps":[…]}, the steps you already did as {"text":"…","done":true}), then a now block with the step you are on.${book ? ` This is ${book} work: the coding-playbooks ${book} playbook's steps are your steps; one you skip stays with "skip":"why".` : ""}`
              : `(Ondra) Your to-do list hasn't moved for a while. Current list:\n${planText(plan).join("\n")}\nSend a now block with the step you are on (the step you were on before it counts as done; one you never were on needs {"text":"…","done":true} or {"text":"…","skip":"why"} in a plan block), or a new plan if it changed.`;
            void request(agentOf(id), { type: "steer", message }).catch(() => {});
          }
          // a job booted or shut down a phone: the hub and the sidebar show it now
          if (done?.kind === "tool" && done.tool.name === "device") void refreshDevices();
          // the shared browser stopped answering: check it now and restart it if it hangs
          if (ev.isError && done?.kind === "tool" && done.tool.kind === "browser" && typeof out === "string" && /Failed to read|os error 35|no response came back|daemon.*(not|no) respon/i.test(out)) recheckBrowser(taskById(id)?.space ?? state.space);
          updateTask(id, (t) => {
            const e = t.entries.find((x) => x.id === entryId);
            if (e?.kind === "tool") {
              e.tool.ok = !failed;
              // a click names its element once the call returns ("클릭함 ‘보내기’")
              const label = ev.result?.details?.label;
              if (e.tool.name === "computer" && !e.tool.target && typeof label === "string" && label.trim()) e.tool.target = computerLabel(label) ?? "";
              // a look or read names the screen it was on ("화면 읽음 · Instagram · 받은 메시지함")
              const screen = ev.result?.details?.screen;
              if (e.tool.name === "computer" && !e.tool.target && typeof screen === "string" && screen.trim()) e.tool.target = screen.trim();
              e.tool.endedAt = Date.now();
              const shot = e.tool.detail && !ev.isError ? screenshotIn(e.tool.detail) : undefined;
              if (shot) t.shot = shot;
            }
            const sh = t.shells.find((s) => s.id === ev.toolCallId);
            if (sh) {
              sh.endedAt = Date.now();
              sh.ok = !failed;
              if (typeof out === "string") sh.tail = out.slice(-TAIL);
            }
          });
          break;
        }
        case "compaction_start":
          run.compacting = true;
          updateTask(id, (t) => push(t, { kind: "note", text: "컨텍스트 압축 중" }));
          break;
        case "compaction_end":
          run.compacting = false;
          break;
        case "auto_retry_start":
          // waiting on a dropped connection: its note says so already, the engine's retries would only pile up under it
          if (!run.netTries) updateTask(id, (t) => push(t, { kind: "note", text: `재시도 ${ev.attempt ?? ""}/${ev.maxAttempts ?? ""}` }));
          break;
        case "agent_settled":
          run.streaming = false;
          run.ended = true;
          // the turn ended on the user's words (a question answered): nothing is left to place
          if (!run.replanFor) {
            run.replanCalls = undefined;
            if (taskById(id)?.planAsk) updateTask(id, (t) => (t.planAsk = undefined));
          }
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
      ui.close();
      markDead(agent);
      const t = taskById(id);
      // the app quitting took it down: it stays running and picks up again when the app opens
      if (appQuitting()) return;
      // it waits on the user's answer: nothing is lost (the answer starts it again, with the
      // question and the answer), and failing it drops the question the user hasn't read yet
      if (t && runs.get(id) === run && t.status === "waiting" && state.decisions.some((d) => d.taskId === id && !d.ui)) {
        logWarn("engine", `${id} engine exited (${code ?? "signal"}) while it waited on the user: the answer starts it again`);
        runs.delete(id);
        return;
      }
      if (t && runs.get(id) === run && (t.status === "running" || t.status === "waiting")) {
        // it died while working (a job that ended, or one Ondra stopped, is no news)
        const tail = stderrOf(agent).split("\n").filter(Boolean).slice(-2).join(" · ");
        logWarn("engine", `${id} engine exited (${code ?? "signal"}): ${tail}`);
        fail(id, tail || `엔진 종료 (코드 ${code ?? "?"})`);
      }
    },
  };
  return self;
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

  // Ondra cut the turn itself (reasoning in circles, a request that hung): its abort is not the job failing
  if (run.thinkCut && run.error && /abort/i.test(run.error)) run.error = undefined;
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
  // the account hit its limit (a 503 counts on one nearly out: GPT says that now instead of 429):
  // 자동 sits it out, and a job routed on 자동 can't write its own handoff card any more, so one is
  // made from the thread and a fresh session goes on with it on an account with room. A fresh
  // session, not the same one moved: re-sending the whole conversation uncached would cost the new
  // account as much as the old one had used on it.
  if (run.error && hitLimit(run.error, t.accountId)) {
    markLimited(t.accountId);
    const next = !run.done && !run.handoff && !run.asked && autoRouted(t) ? spareAccount(t.space, t.accountId) : undefined;
    if (next) {
      logWarn("task", `${id} ${t.accountId} hit its limit (${run.error.slice(0, 120)}): a fresh session on ${next}`);
      run.error = undefined;
      await newSession(id, run, cardFromThread(taskById(id)!), next);
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
  // the provider refuses the whole request (400 Bad Request): something in the session's history
  // can't be sent again, so retrying the same session fails every time. It goes on once in a fresh
  // session from what the thread shows; a second refusal there is a real failure.
  if (run.error && isRefusedRequest(run.error) && !run.freshAfterRefusal && !run.done && !run.handoff && !run.asked) {
    run.freshAfterRefusal = true;
    logWarn("task", `${id} request refused (${run.error.slice(0, 120)}): going on in a fresh session`);
    run.error = undefined;
    updateTask(id, (x) => push(x, { kind: "note", text: "요청이 거부돼서 새 세션으로 이어가요" }));
    void newSession(id, run, cardFromThread(taskById(id)!));
    return;
  }
  if (run.error && !run.done && !run.handoff && !run.asked && !run.pendingHandoff) {
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
    // steps the user asked for while it worked and it never reached: not dropped without a word
    const asked = run.askedGate || t.parentId ? [] : openAsked(t.plan);
    if (asked.length) {
      run.askedGate = true;
      const summary = run.done;
      run.done = undefined;
      updateTask(id, (x) => {
        x.saidDone = undefined;
        x.now = "요청받은 일을 마저 하는 중";
        push(x, { kind: "note", text: asked.length > 1 ? `남은 요청 · ${asked[0]} 외 ${asked.length - 1}개` : `남은 요청 · ${asked[0]}` });
      });
      try {
        run.turnStart = Date.now();
        await request(agent, {
          type: "prompt",
          message: `(Ondra) You said done, but steps the user asked for while you worked are still open in your plan:\n${asked.map((a) => `- ${a}`).join("\n")}\nDo them now. If one is already done, send it in a plan block as {"text":"…","done":true}; if one turned out not to be needed or can't be done, send it as {"text":"…","skip":"why"} and say why in a sentence. Then send done again.`,
        });
      } catch {
        finish(id, summary, run);
      }
      return;
    }
    // every done gets its proof checked and shown, also one that changed nothing (a look, a capture)
    const checked = await markEvidence(t, run);
    const missing = (run.gates ?? 0) >= 2 || t.parentId || t.handedOn ? null : await proofMissing(t, run, checked, (run.gates ?? 0) >= 1);
    if (missing) {
      run.gates = (run.gates ?? 0) + 1;
      const summary = run.done;
      run.firstDone ??= summary;
      run.done = undefined;
      // what it left unchecked is asked about in the same send-back, not in a turn of its own after it
      const open = run.uncheckedAt === undefined ? stillUnchecked(id, run, t) : [];
      if (open.length) run.uncheckedAt = Date.now();
      updateTask(id, (x) => {
        x.saidDone = undefined;
        x.now = "증거를 채우는 중";
        if (open.length) x.uncheckedAsked = { at: run.uncheckedAt!, items: open };
        push(x, { kind: "note", text: `확인 필요 · ${missing.label}` });
      });
      try {
        run.turnStart = Date.now();
        await request(agent, { type: "prompt", message: open.length ? `${missing.ask}\n\n${uncheckedAsk(open)}` : missing.ask });
      } catch {
        finish(id, run.firstDone ?? summary, run);
      }
      return;
    }
    // something left unchecked: not done yet. The user hears about it first, as a question
    if (await uncheckedHeld(id, t, run, agent)) return;
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
  // it was waiting to hand off and a turn came in between (a subagent's message), or the user spoke: go on now
  if (run.pendingHandoff && (!activeKids(id).length || run.handoffNow)) {
    const card = run.pendingHandoff;
    run.pendingHandoff = undefined;
    run.handoffNow = false;
    await newSession(id, run, card);
    return;
  }
  // a background command ended, or a watch spoke, while no turn ran: it goes on with that now
  if (run.bg?.queued) {
    await wakeForBackground(id, run);
    return;
  }
  // Subagents or background commands still working: wait for them; their results wake it up.
  if (activeKids(id).length || run.bg?.running) {
    run.idle = true;
    updateTask(id, (x) => {
      x.status = "running";
      x.now = activeKids(id).length ? `서브에이전트 ${activeKids(id).length}개 기다리는 중` : `백그라운드 명령 ${run.bg!.running}개 기다리는 중`;
    });
    return;
  }
  // its reasoning ran on and was cut: it goes on to the next step, briefly
  if (run.thinkCut) {
    run.thinkCut = false;
    try {
      run.turnStart = Date.now();
      await request(agent, { type: "prompt", message: run.cutNote ?? THINK_CUT });
      return;
    } catch {
      // fall through to the stalled card
    }
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

/** The status extensions/background.ts sends: {running, queued}, or nothing once all is over. */
const BG_STATUS = "background";
export function readBg(text: unknown): { running: number; queued: number } {
  try {
    const v = typeof text === "string" ? JSON.parse(text) : {};
    return { running: Number(v?.running) || 0, queued: Number(v?.queued) || 0 };
  } catch {
    return { running: 0, queued: 0 };
  }
}

/** Its background news waits in the engine for the next turn: start that turn. */
async function wakeForBackground(id: string, run: Run) {
  run.idle = false;
  updateTask(id, (x) => {
    x.status = "running";
    x.now = "백그라운드 결과로 이어가는 중";
  });
  try {
    run.turnStart = Date.now();
    await request(agentOf(id), { type: "prompt", message: BG_WAKE });
  } catch {
    // a turn started meanwhile (a subagent's result, the user): the news goes in with it
  }
}
const BG_WAKE = "(Ondra) Your background command or monitor has news (the message above). Carry on from it.";

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

/** A 400 for the request as a whole, not a limit or an outage. */
export const isRefusedRequest = (e: string) => /\bBad Request\b|"status":\s*400\b|\b400\b.*invalid_request|invalid_request_error/i.test(e) && !/context|too long|maximum|rate|quota|limit/i.test(e);

/** A handoff card made from the thread, for a session that couldn't write its own. */
export function cardFromThread(t: Task): Handoff {
  // the card the session before it wrote holds what this thread alone can't (findings, evidence):
  // it goes on, with what the cut-off session said after it
  let at = -1;
  for (let i = t.entries.length - 1; i >= 0; i--) if (t.entries[i].kind === "handoff") { at = i; break; }
  if (at >= 0) {
    const last = (t.entries[at] as Extract<Task["entries"][number], { kind: "handoff" }>).handoff;
    const since = t.entries.slice(at + 1).flatMap((e) => (e.kind === "text" && e.text.trim() ? [e.text.trim().replace(/```blocks[\s\S]*?```/g, "").trim().slice(0, 600)] : [])).filter(Boolean).slice(-4);
    return mergeCards(last, { did: since, next: `${last.next ?? "Pick up where the last session stopped"} (the session after this card was cut off by a provider error: check where it stood first)`, evidence: [] });
  }
  const said = t.entries.flatMap((e) => (e.kind === "text" && e.text.trim() ? [e.text.trim().replace(/```blocks[\s\S]*?```/g, "").trim().slice(0, 600)] : [])).filter(Boolean).slice(-4);
  const done = t.plan.filter((p) => p.state === "done").map((p) => p.text);
  const open = t.plan.find((p) => p.state === "now" || p.state === "todo")?.text;
  return {
    did: [...done.map((d) => `(plan) ${d}`), ...said],
    next: open ? `${open} (the last session was cut off by a provider error: check where it stood first)` : "Pick up where the last session stopped (it was cut off by a provider error): check the state first.",
    evidence: [],
  };
}

/**
 * Start a fresh session on the handoff card (and the results that came in meanwhile).
 * `to`: the account it goes on on (its own hit the limit). Without it, a job on 자동 whose
 * account is full, or past 85% with a roomier one free, moves at this point anyway: a fresh
 * session starts its cache over wherever it runs, so this move costs nothing.
 */
async function newSession(id: string, run: Run, card: Handoff, to?: string) {
  clearExtensionUi(id);
  const agent = agentOf(id);
  run.longNudges = 0;
  run.limitAsked = false;
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
  const next = to ?? movesAt(taskById(id)!);
  if (next) {
    // the engine restarts on the other account; the new session is given the card (startTask, its leg already open)
    runs.delete(id);
    await stopEngine(agent);
    // stopped or removed while it waited
    if (taskById(id)?.status !== "running") return;
    updateTask(id, (x) => {
      if (!sameService(x.accountId, next)) x.model = undefined;
      x.accountId = next;
      push(x, { kind: "note", text: "사용 한도가 차서 다른 계정의 새 세션에서 이어가요" });
    });
    void startTask(id, false);
    return;
  }
  try {
    run.turnStart = Date.now();
    await request(agent, { type: "new_session" });
    // the old session's size is gone with it: the gauge starts from empty, not from the last call
    if (ctx[agent]) setCtx(agent, { tokens: 0, window: ctx[agent]!.window, percent: 0 });
    // nothing recorded for it yet (its first call, or a restart cleared it): there is nothing to reset,
    // and setting a field of the missing record threw, failing the job at its handoff
    if (reuse[agent]) setReuse(agent, "last", 0);
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

/** check the evidence of this done against the session, and show the result on its block */
async function markEvidence(t: Task, run: Run): Promise<Evidence[]> {
  const checked = await checkEvidence(t, run.evidence ?? []);
  updateTask(t.id, (x) => {
    for (let i = x.entries.length - 1; i >= 0; i--) {
      const e = x.entries[i];
      if (e.kind === "block" && e.block.type === "evidence") {
        e.block.items = e.block.items.map((it) => checked.find((c) => c.kind === it.kind && c.ref === it.ref) ?? it);
        break;
      }
    }
  });
  return checked;
}

/**
 * What a job of normal size or more owes before done, beyond its evidence: a reason for each
 * plan step it skipped or left open, a reason for each thing it lists as not checked, a
 * footing for the cause it names. Small jobs (a wording, a colour) owe none of it.
 */
/**
 * A step left open that the done itself settles: the plan's last step (its report, the PR, the
 * release is what the done says), or any step once the user spoke after the plan last moved
 * (they may have turned the work: "끝내", "릴리스는 하지 마"). Sending it back for those only
 * costs a turn that says "done".
 */
function settledBy(t: Task, run: Run, step: string): boolean {
  const steps = t.plan.filter((s) => !s.user);
  if (steps.length > 1 && steps[steps.length - 1].text === step && unexplained(t.plan).length === 1) return true;
  return userSaidSince(t, run.planMovedAt ?? Number.MAX_SAFE_INTEGER);
}

function owedReasons(t: Task, run: Run, said: string): { needs: string[]; lines: string[] } {
  if (t.size === "small") return { needs: [], lines: [] };
  const needs: string[] = [];
  const lines: string[] = [];
  // a playbook's steps are checked through the plan: with no plan, none of them ever was
  const book = playbookOf(t);
  if (book && !t.plan.length) {
    needs.push("계획");
    lines.push(`- 이 일은 ${book} 플레이북대로 하기로 했는데 계획을 한 번도 보내지 않았어요(plan 블록). 그 플레이북의 단계를 plan 블록으로 보내 줘: 한 단계는 {"text":"…","done":true}, 안 하기로 한 단계는 {"text":"…","skip":"이유"}. 빠뜨린 단계가 있으면 지금 하고 보내 줘.`);
  }
  const open = unexplained(t.plan).filter((s) => !settledBy(t, run, s));
  if (open.length) {
    needs.push("건너뛴 단계");
    lines.push(`- 계획에서 이유 없이 지나치거나 남긴 단계가 있어요: ${open.map((s) => `«${s}»`).join(", ")}. 한 단계면 지금 하고, 이미 했으면 plan 블록에서 {"text":"…","done":true}로, 안 하기로 했으면 {"text":"…","skip":"이유"}로 다시 보내 줘. 말없이 지우지 마.`);
  }
  if (run.bare?.length) {
    needs.push("확인 못 한 이유");
    lines.push(`- unverified에 이유가 없거나 이유가 아닌 항목이 있어요: ${run.bare.map((s) => `«${s}»`).join(", ")}. 여기서 도구로 할 수 있는 일(테스트·실행·스크린샷·첨부·PR에 올리기)이면 지금 하고 evidence에 넣어 줘. 정말 못 하면 {"what":"…","why":"막힌 이유"}로 적어 줘: 사용자의 손이 필요함(기기·계정·로그인), 여기 도구가 닿지 않음, 허락 없이 밖으로 나가는 일, 사용자가 빼라고 함, 변경과 무관한 이유로 두 번 실패함.`);
  }
  const cause = causeFooting(said);
  if (cause === "bare") {
    needs.push("원인 근거");
    lines.push("- **원인**에 근거 라벨이 없어요. 실행해서 직접 본 거면 (확인함), 코드를 읽고 판단했으면 (추론), 둘 다 아니면 (추측)을 붙여 줘. (추측)이면 지금 확인할 수 있는지 먼저 봐 줘.");
  }
  const checkedClaim = unbackedChecked(t, said);
  if (checkedClaim) {
    needs.push("확인 안 한 라벨");
    lines.push(`- "${checkedClaim}"에 (확인함)을 붙였는데 이 세션에서 돌리거나 본 기록이 없어요. 지금 돌려서 확인하거나 라벨을 (추론)·(추측)으로 고쳐 줘.`);
  }
  return { needs, lines };
}

/** a fix/ job: the reproduction it ran before changing code, and the same run passing after */
function reproOwed(t: Task, checked: Evidence[], unverified: string[]): string | null {
  if (t.size === "small" || !isBugFix(t)) return null;
  const repro = checked.find((e) => e.kind === "repro");
  if (!repro) {
    if (unverified.some((u) => /재현|repro/i.test(u))) return null;
    return '- 버그 작업인데 재현 기록이 없어요. 고치기 전에 돌린 재현(명령이나 화면 조작)을 고친 뒤 같은 방법으로 다시 돌리고, evidence에 {"kind":"repro","ref":"그 명령"}으로 넣어 줘. 재현이 안 됐으면 unverified에 {"what":"재현","why":"무엇을 해 봤고 왜 안 됐는지"}로 적어 줘.';
  }
  const gap = reproGap(t, repro.ref);
  if (gap === "before") return `- 재현 «${repro.ref}»을 코드를 바꾸기 전에 돌린 기록이 없어요. 고친 결과만으로는 원래 실패가 고쳐졌는지 알 수 없어요: 수정 전 상태에서 재현을 보여 주거나(되돌려 돌리기, 실패하는 테스트 먼저), 못 하면 unverified에 이유와 함께 적어 줘.`;
  if (gap === "after") return `- 재현 «${repro.ref}»을 마지막 수정 뒤에 다시 돌려 통과한 기록이 없어요. 지금 같은 방법으로 돌려 줘.`;
  return null;
}

/** its branch still changes code (against where it started); unknown counts as yes */
async function keptCode(t: Task, codeFiles: Set<string>): Promise<boolean> {
  const w = t.worktree?.state === "open" ? t.worktree : undefined;
  if (!w?.base) return true;
  const c = await gitChanges(w.path, w.base).catch(() => null);
  if (!c?.isRepo) return true;
  const mine = [...codeFiles].map((p) => expand(p));
  return c.files.some((f) => mine.some((p) => p === f.path || p.endsWith(`/${f.path}`)));
}

/** debug output, code left commented out and fix-later notes the job's own changes add */
async function leftoversOwed(t: Task, codeFiles: Set<string>): Promise<string[]> {
  if (t.size === "small" || !codeFiles.size) return [];
  const w = t.worktree?.state === "open" ? t.worktree : undefined;
  const c = await gitChanges(w?.path ?? expand(t.cwd), w?.base).catch(() => null);
  if (!c?.patch) return [];
  const mine = [...codeFiles].map((p) => expand(p));
  return leftovers(c.patch, (f) => mine.some((p) => p === f || p.endsWith(`/${f}`)));
}

/** what sends a job back only once: the second time it is written down as unchecked instead */
const SOFT = new Set(["확인 안 한 말", "재현", "계획", "건너뛴 단계", "확인 못 한 이유", "원인 근거", "확인 안 한 라벨", "언어", "로컬 검사"]);
const SOFT_NOTE: Record<string, string> = {
  "확인 안 한 말": "답에서 확인했다고 한 말 중 이 세션 기록으로 뒷받침되지 않는 게 있어요",
  재현: "고치기 전·후 재현 기록이 없어요",
  계획: "플레이북 계획을 보내지 않았어요",
  "건너뛴 단계": "계획에서 이유 없이 남은 단계가 있어요",
  "확인 못 한 이유": "확인 못 한 항목 중 이유가 없는 게 있어요",
  언어: "답의 일부가 영어로 쓰였어요",
  "로컬 검사": "이 프로젝트의 로컬 검사를 돌리지 않았거나 실패한 채로 끝냈어요",
  "원인 근거": "원인에 근거 라벨이 없어요",
  "확인 안 한 라벨": "(확인함)을 붙였지만 돌린 기록이 없는 말이 있어요",
};

async function proofMissing(t: Task, run: Run, checked: Evidence[], again = false): Promise<{ label: string; ask: string } | null> {
  const r = await proofMissingAll(t, run, checked);
  if (!r || !again) return r;
  // sent back once already: a second turn only for what really doesn't hold (no proof, a review,
  // leftovers); the softer misses are written down where the user sees them, not argued again
  const hard = r.needs.filter((n) => !SOFT.has(n));
  const soft = r.needs.filter((n) => SOFT.has(n) && SOFT_NOTE[n]);
  if (soft.length) run.noted = [...new Set([...(run.noted ?? []), ...soft.map((n) => SOFT_NOTE[n])])];
  return hard.length ? { label: hard.join(" · "), ask: r.ask } : null;
}

async function proofMissingAll(t: Task, run: Run, checked: Evidence[]): Promise<{ label: string; ask: string; needs: string[] } | null> {
  // "done" that still promises the work for later
  if (promisesLater(run.done ?? ""))
    return {
      needs: ["남은 작업 있음"],
      label: "남은 작업 있음",
      ask: "끝냈다고 했는데 요약이 앞으로 할 일이에요. 그 일을 지금 끝내고 done으로 끝내 줘. 지금 할 수 없으면 무엇이 막혔는지 사용자에게 묻거나, 못 한 걸 unverified에 적고 요약은 실제로 한 것만 적어 줘.",
    };
  const said = [run.done ?? "", lastText(t)].join("\n");
  const owed = owedReasons(t, run, said);
  // the answer slipped into English for a user who writes Korean
  if (notTheirLanguage(run.done ?? "", t) || notTheirLanguage(lastText(t), t)) {
    owed.needs.push("언어");
    owed.lines.push("- 답이 영어예요. 사용자는 한국어로 써요: 같은 내용을 한국어로 다시 써서 done으로 보내 줘.");
  }
  const wrote = t.entries.filter((e) => e.kind === "tool" && (e.tool.kind === "edit" || e.tool.kind === "write") && e.tool.ok !== false && !e.tool.note);
  // this user's own checks for the project that the work falls under: run, and passing
  if (!t.parentId) {
    const files = wrote.map((e) => (e.kind === "tool" ? (e.tool.detail ?? "").split("\n")[0].trim() : "")).filter((p) => p && isCodeFile(p, t));
    const covering = checksCovering(t, checksFor(projectById(t.project, t.space)?.folder ?? t.cwd), files);
    const lines = checksOwed(covering);
    if (lines.length) (owed.needs.push("로컬 검사"), owed.lines.push(...lines));
  }
  // looked things up, answered: nothing to prove but its reasons
  if (!wrote.length) return owed.needs.length ? { needs: owed.needs, label: owed.needs.join(" · "), ask: ["끝내기 전에 빠진 게 있어요.", ...owed.lines, "안 해 본 걸 했다고 하지 말고, 고친 뒤 다시 done으로 끝내 줘."].join("\n") } : null;
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
  run.evidence = checked;
  // stale runs and unopened links don't send the job back; finish lists every `why` as unverified
  const bad = checked.filter((e) => e.why && blocking(e));
  const soft = checked.filter((e) => e.why && !blocking(e));
  const proven = checked.some((e) => !e.why) || soft.length > 0 || (run.unverified ?? []).length > 0;
  // the answer says it looked at the screen: something in the session has to show it did
  const claim = unbackedClaim(t, said, checked, run.unverified ?? []);
  // a cause left as a guess: the fix can't be called checked (and doesn't merge on its own)
  if (changed && causeFooting(said) === "guess" && !(run.unverified ?? []).some((u) => u.startsWith("원인을 확인하지 못했어요")))
    run.unverified = [...(run.unverified ?? []), "원인을 확인하지 못했어요 — 보고에서 원인이 (추측)이에요"];
  // the work ended with its code changes taken back (the user chose not to make it): nothing to reproduce
  const repro = changed && !out && (await keptCode(t, codeFiles)) ? reproOwed(t, checked, run.unverified ?? []) : null;
  const left = changed ? await leftoversOwed(t, codeFiles) : [];
  const needs = [changed && !reviewed && "리뷰", unresolved && "리뷰 지적", !proven && "증거", bad.length && "증거 안 맞음", claim && "확인 안 한 말", repro && "재현", left.length && "남은 디버그·임시 코드", ...owed.needs].filter(Boolean) as string[];
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
    repro ?? "",
    left.length ? `- 바꾼 코드에 남기면 안 되는 줄이 있어요: ${left.join(", ")}. 지우거나 제대로 고쳐 줘(임시라는 주석 대신 지금 고치거나, 못 하면 보고에 한 줄).` : "",
    ...owed.lines,
    "안 해 본 걸 했다고 하지 말고, 못 한 건 unverified에 적은 뒤 다시 done으로 끝내 줘.",
  ];
  return { needs, label: `${needs.join(" · ")}`, ask: lines.filter(Boolean).join("\n") };
}

/** what the job could not check (with why), as the user is told it */
const uncheckedOf = (run: Run) => (run.unverified ?? []).filter(Boolean);

/** what the job is told when it said done with something unchecked */
export const uncheckedAsk = (open: string[]) =>
  [
    "(Ondra) Don't finish yet: you left these unchecked:",
    ...open.map((u) => `- ${u}`),
    "For each one you can still check here with your tools, check it now and put it in evidence.",
    "The rest is your call, from what it is and what the user and memory say: when it matters and the user can give what's needed to check it (a device, an account, their hand…), ask them with an ask block and wait; when it doesn't, or they already said, send done again with it in unverified.",
  ].join("\n");

/**
 * A done with something left unchecked: the job is sent back once to check what it can (the
 * coding discipline); whether the user is asked about the rest is its own call. Its next done
 * goes through, with what is still unchecked in its record: nothing set is asked.
 * Returns true when the job was held back.
 */
async function uncheckedHeld(id: string, t: Task, run: Run, agent: string): Promise<boolean> {
  const open = stillUnchecked(id, run, t);
  if (!open.length) return false;
  // sent back once already: this done goes through, what is still unchecked stays in its record
  if (run.uncheckedAt !== undefined) return false;
  const summary = run.done;
  run.firstDone ??= summary;
  run.done = undefined;
  {
    run.uncheckedAt = Date.now();
    updateTask(id, (x) => {
      x.saidDone = undefined;
      x.uncheckedAsked = { at: run.uncheckedAt!, items: open };
      x.now = "확인 못 한 걸 다시 보는 중";
      push(x, { kind: "note", text: `확인 못 한 게 있어 한 번 더 봐요 · ${open.length}개` });
    });
    try {
      run.turnStart = Date.now();
      await request(agent, { type: "prompt", message: uncheckedAsk(open) });
      return true;
    } catch {
      // the job is gone: its done goes through as it was
    }
  }
  run.done = summary;
  return false;
}

/** the user's own words since `at` (typed, an answer to a question, or relayed from main), not another job's or Ondra's */
const userSaidSince = (t: Pick<Task, "entries">, at: number) => t.entries.some((e) => e.kind === "user" && (!e.by || e.by === "main") && e.at >= at);

/**
 * What the done leaves unchecked that the user still has to hear about. Kept on the job, not the
 * run: once the user answered a hold (in this turn or an earlier one, however the job words the
 * item now), what was asked stays answered. Nothing for a job Ondra started by itself: nobody is
 * asked there, it stays in the record.
 */
function stillUnchecked(id: string, run: Run, t?: Task): string[] {
  let now = taskById(id) ?? t;
  if (!now || now.self || now.parentId || now.handedOn) return [];
  const asked = now.uncheckedAsked;
  if (asked && userSaidSince(now, asked.at)) {
    leftAsIs(id, asked.items);
    updateTask(id, (x) => (x.uncheckedAsked = undefined));
    now = taskById(id) ?? now;
  }
  const ok = new Set((now.uncheckedOk ?? []).map(uncheckedKey));
  return uncheckedOf(run).filter((u) => !ok.has(uncheckedKey(u)));
}

/** an unchecked item by what it is, not how it was worded this time ("X — why" or "X (why)") */
export const uncheckedKey = (u: string) =>
  u.split(/ — | - | \(|: /)[0].replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase().slice(0, 40);

/** the user answered about these: they stay unchecked, and aren't asked about again */
function leftAsIs(id: string, open: string[]) {
  updateTask(id, (x) => (x.uncheckedOk = [...new Set([...(x.uncheckedOk ?? []), ...open])].slice(-20)));
}


function finish(id: string, summary: string, run?: Run) {
  clearExtensionUi(id);
  // it worked in a finished job's branch folder: the branch (and its merge) ends up here
  claimBranch(id);
  // a folder left for it (it ran in a branch it had handed on) can go now
  setTimeout(() => void sweepWorktrees(), 0);
  // its subagents are for it: once it is done, ones that never started go away
  // and running ones stop (a review that runs after its job ended is wasted)
  for (const k of activeKids(id)) {
    if (k.status === "queued" && !k.entries.some((e) => e.kind === "tool")) removeTask(k.id);
    else endKid(k.id);
  }
  runs.delete(id);
  agentKill(agentOf(id));
  markDead(agentOf(id));
  setLive(id, "");
  setState("decisions", (list) => list.filter((d) => d.taskId !== id));
  updateTask(id, (t) => {
    t.status = "done";
    t.plan = closePlan(t.plan);
    t.planAsk = undefined;
    t.unread = true;
    t.saidDone = undefined;
    t.summary = summary;
    t.digest = undefined;
    t.now = summary;
    const proven = (run?.evidence ?? []).filter((e) => e.ok !== false && !e.why).length;
    // what still doesn't hold after the job was sent back is listed, not hidden
    const broken = (run?.evidence ?? []).filter((e) => e.why).map((e) => `${e.ref} · ${e.why}`);
    const open = [...(run?.unverified ?? []), ...(run?.noted ?? []), ...broken];
    t.unverified = run && !t.parentId ? (open.length ? open : proven ? undefined : ["증거 없이 끝났어요"]) : undefined;
    t.finishedAt = Date.now();
    closeOpen(t);
    const leg = t.legs[t.legs.length - 1];
    if (leg && !leg.endedAt) leg.endedAt = Date.now();
  });
  for (const k of activeKids(id)) endKid(k.id);
  const t = taskById(id);
  if (t?.parentId) {
    releaseBrowser(id);
    void deliver(t);
  } else if (t && !drainQueue(id)) {
    releaseBrowser(id);
    const land = run?.land;
    void dropEmptyBranch(id).then(() => landBranch(id, land));
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
    if (prOf(t)) void syncHome(t);
    // through a PR the branch stays, and anything left in the folder is saved on it
    const left = await dropWorktree(t, !!pr, env);
    updateTask(id, (x) => {
      x.cwd = homeDir(x);
      x.worktree = { ...w, state: "merged", into, ...(left ? { left } : {}) };
      x.mergedAt = Date.now();
      push(x, { kind: "note", text: pr ? `${into} 병합됨${left ? "" : " · 워크트리 정리"}` : `${into}에 이미 반영됨${left ? "" : " · 워크트리 정리"}` });
    });
    return;
  }
  // another job still in the folder: it stays (merged in effect: nothing was left on it) until that one is done
  if (await dropWorktree(t, false, env)) return updateTask(id, (x) => ((x.cwd = homeDir(x)), (x.worktree = { ...w, state: "merged", into: w.into ?? "", left: true })));
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
  for (const t of state.tasks.filter((x) => x.status === "done" && x.worktree?.state === "open" && !x.parentId)) {
    markPr(t.id);
    await dropEmptyBranch(t.id);
    // what becomes of one still holding changes is its own and the user's to say (landBranch), not asked
    // here; one Ondra started by itself still goes up as a PR or stays a branch
    const n = taskById(t.id);
    if (n && (n.self || n.worktree?.pr) && Date.now() - (n.finishedAt ?? 0) < 7 * DAY) await askMerge(t.id);
  }
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
async function watchPrs() {
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
        // merged: a finished job's folder goes now, not at the next half-hourly sweep
        if (snap.state === "MERGED") await dropEmptyBranch(t.id);
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
  /** how much rigor the work earns (main's call); none = normal */
  size?: Size;
  /** a new app or repo started from nothing */
  fresh?: boolean;
  accountId?: string;
  /** the account was picked by hand (another device's picker): 자동 doesn't move it */
  accountPinned?: boolean;
  origin?: Task["origin"];
  /** Shown as the first message instead of the full ask (for long imported context). */
  display?: string;
  isolate?: boolean;
  project?: string;
  after?: string[];
  reach?: Task["reach"];
  /** a finished job this carries on: its branch is handed over */
  follows?: string;
  /** the root of the work this is a part of (Task.group) */
  group?: string;
  issue?: Task["issue"];
  /** another agent asked for it (see Entry's `by`) */
  by?: string;
  /** its id, when another device chose it (a job started from there) */
  id?: string;
  /** run it on another device (Settings › 연결), in this workspace and on this account there */
  host?: string;
  hostSpace?: string;
  hostAccount?: string;
  /** its own model and level (else its account's) */
  model?: string;
  thinking?: string;
  /** another device asked for it */
  from?: Task["from"];
  /** a run of this routine */
  routine?: string;
  /** Ondra started it by itself (a rule made into a check): it never asks the user */
  self?: Task["self"];
  /** the Discord agent's work (else the job it carries on decides) */
  agent?: Task["agent"];
}): string {
  const id = f.id && !taskById(f.id) ? f.id : uid("t");
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
    ...(f.group && taskById(f.group) ? { group: f.group } : {}),
    cwd: (takes ? prev!.cwd : f.cwd?.trim()) || (prev?.worktree ? `${prev.worktree.repo}${prev.worktree.sub ? `/${prev.worktree.sub}` : ""}` : prev?.cwd) || spaceById(f.space).folder || "~",
    project: f.project ?? prev?.project ?? projectFor(f.space, f.cwd),
    // the branch it carries on moves with it: merge and discard act on the new card
    ...(takes ? { worktree: prev!.worktree } : {}),
    status: "queued",
    priority: f.priority ?? 2,
    weight: f.weight ?? "light",
    ...(f.size && f.size !== "normal" ? { size: f.size } : {}),
    ...(f.fresh ? { fresh: true } : {}),
    // the Discord agent's work runs on its own account when one is picked for it
    accountId: f.accountId ?? ((f.agent ?? prev?.agent) ? agentAccount(f.space, (f.agent ?? prev?.agent)?.channel) : undefined) ?? chooseAccount(f.space, topic),
    ...(f.accountPinned ? { accountPinned: true } : {}),
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
    // no model of its own unless asked for one: it runs on its account's model (each account picks its own)
    model: f.model || undefined,
    thinking: f.thinking || undefined,
    permission: state.settings.permission ?? "auto",
    ...(f.from ? { from: f.from } : {}),
    ...(f.routine ? { routine: f.routine } : {}),
    ...(f.self ? { self: f.self } : {}),
    ...((f.agent ?? prev?.agent) ? { agent: f.agent ?? prev!.agent } : {}),
  };
  // a project of another device: the job is made and run there; here it shows until that device's copy comes
  // (or one asked in that device's workspace: everything there runs there)
  const far_ = splitProjectId(f.project);
  const theirs = splitSpaceId(f.space);
  const farHost = far_?.host ?? f.host ?? theirs?.host;
  if (farHost) {
    // the rest of what it was asked with goes too: the ids it follows or waits for are that device's own
    // (a job of it shows here under its id there); a Mac too old to know a field leaves it out
    startFar(farHost, { ...task, host: farHost, project: far_ ? f.project : undefined }, {
      id, title: task.title, ask: f.ask, project: far_?.id, space: f.space, hostSpace: f.hostSpace ?? (theirs?.host === farHost ? theirs?.id : undefined), spaceLabel: state.spaces.find((x) => x.id === f.space)?.label,
      account: f.hostAccount, model: f.model, thinking: f.thinking, display: f.display,
      branch: f.branch, priority: task.priority, weight: task.weight, origin: f.origin, isolate: f.isolate, after: task.after,
      // the other workspaces it may reach, by name (that device's workspaces of the same names)
      reach: task.reach?.map((x) => state.spaces.find((s) => s.id === x)?.label).filter((x): x is string => !!x), follows: task.follows, issue: f.issue, by: f.by,
      permission: task.permission,
    });
    return id;
  }
  setState("tasks", (list) => [...list, task]);
  if (takes) takeBranch(id, prev!.id);
  return id;
}

/** The job it carries on gives it its branch and worktree. */
const inside = (dir: string, root: string) => !!root && (dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`));

/** a job not done yet that works in this folder, other than its owner: one that handed its branch on
 *  and was picked up again keeps the folder it ran in */
const usedBy = (path: string, owner: string) =>
  state.tasks.find((x) => x.id !== owner && !x.parentId && !x.answer && x.status !== "done" && x.status !== "failed" && inside(x.cwd, path));

/** Remove a job's worktree. While another job still works in that folder it stays (true), so that
 *  job doesn't find its folder gone and make it again; sweepWorktrees removes it once that job is done. */
async function dropWorktree(t: Task, keepBranch: boolean, env: Env, loud = false): Promise<boolean> {
  const w = t.worktree!;
  if (usedBy(w.path, t.id)) return true;
  await worktreeRemove(w.repo, w.path, w.branch, keepBranch, env).catch((e) => (loud ? toast(String(e), "bad") : undefined));
  return false;
}

/** Remove the worktree folders jobs are done with: those left for a job that was still in them, and
 *  (at start) any a job's record says are merged or discarded but are still on disk. The branch stays. */
export async function sweepWorktrees(all = false) {
  for (const t of [...state.tasks]) {
    const w = t.worktree;
    if (!w || w.state === "open" || !(all || w.left)) continue;
    if (usedBy(w.path, t.id) || state.tasks.some((x) => x.worktree?.state === "open" && x.worktree.path === w.path)) continue;
    const there = await fsRead(w.path).then(
      () => true,
      (e) => !/파일이 없어요/.test(String(e)),
    );
    if (there) await worktreeRemove(w.repo, w.path, w.branch, true, await gitEnv(t)).catch(() => {});
    if (w.left) updateTask(t.id, (x) => void (x.worktree && (x.worktree = { ...x.worktree, left: undefined })));
  }
}

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
  { const r = far(prevId, "handOn", [prevId, nextId]); if (r) return r as never; }
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
function dataEnv(t: Task): [string, string][] {
  const data = engine.info.dataDir;
  if (!data) return [];
  const key = t.space.replace(/[^A-Za-z0-9_-]/g, "") || "home";
  const ids = jobsAllowed(t);
  return [
    ["ONDRA_DATA_DIR", data],
    ["ONDRA_SPACE_KEY", key],
    ["ONDRA_RECIPES_DIR", `${data}/browser/${key}/recipes`],
    ["ONDRA_FLOWS_DIR", `${data}/computer/${key}`],
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
/** One message that only reasons this long (no words, no tool call) is going in circles: it is cut. */
const THINK_MAX_MS = 10 * 60_000;
const THINK_CUT =
  "(Ondra) You reasoned for over 10 minutes without writing anything or calling a tool, so that message was cut. Don't plan everything again: take the next step now with a tool call, and keep the reasoning before each step short.";
async function cutThinking(id: string, run: Run) {
  run.thinkCut = true;
  run.cutNote = THINK_CUT;
  updateTask(id, (t) => void push(t, { kind: "note", text: "생각이 10분 넘게 이어져서 끊고 다음 단계로 넘겼어요" }));
  await request(agentOf(id), { type: "abort" }, 8000).catch(() => {});
}

/**
 * A turn whose engine sends nothing at all (no token, no reasoning, no tool) while no tool of it runs
 * is a model request that hangs: on 11-13 one sat 5 hours 50 minutes before the provider timed it
 * out, the job showing "working" the whole time. It is cut and asked again, a few times a run.
 */
const MODEL_SILENT_MS = 10 * 60_000;
const SILENT_CUT = "(Ondra) The model sent nothing for over 10 minutes, so that request was cut. Carry on from where you stopped; redo the last step only if it didn't finish.";
async function cutSilent(id: string, run: Run) {
  run.thinkCut = true;
  run.cutNote = SILENT_CUT;
  run.silentCuts = (run.silentCuts ?? 0) + 1;
  run.heardAt = Date.now();
  logWarn("task", `${id} model silent for ${MODEL_SILENT_MS / 60_000} minutes: cut and asked again`);
  updateTask(id, (t) => void push(t, { kind: "note", text: "모델 응답이 10분 넘게 없어서 다시 요청했어요" }));
  await request(agentOf(id), { type: "abort" }, 8000).catch(() => {});
}

/**
 * The Mac slept for `ms`: the watchdogs' clocks move on by that much. On 11-13 a closed lid made
 * every dark wake look like ten silent minutes: the job was cut four times and told it "reasoned
 * too long", about five hours of a night's work.
 */
export function sleptFor(ms: number) {
  for (const [id, run] of runs) {
    if (run.msgAt) run.msgAt += ms;
    if (run.heardAt) run.heardAt += ms;
    for (const sh of taskById(id)?.shells ?? []) {
      if (!run.tools.has(sh.id)) continue;
      const was = run.changed?.get(sh.id);
      if (was) run.changed!.set(sh.id, was + ms);
      else (run.changed ??= new Map()).set(sh.id, Date.now());
    }
  }
}

let wallAt = 0;
let monoAt = 0;
/**
 * How long the Mac slept since the last look: how far the wall clock ran ahead of the monotonic
 * one, which stops while the Mac sleeps. Not a late timer: a hidden window's timers are throttled
 * without any sleep, and the watchdogs must still run then.
 */
function sleptSinceLastLook(): number {
  const wall = Date.now();
  const mono = performance.now();
  const drift = wallAt ? wall - wallAt - (mono - monoAt) : 0;
  wallAt = wall;
  monoAt = mono;
  return drift > 30_000 ? drift : 0;
}

export function stopStalledCommands(now = Date.now()) {
  for (const [id, run] of runs) {
    if (!run.streaming) continue;
    if (!run.thinkCut && !run.msgActed && run.msgAt && now - run.msgAt > THINK_MAX_MS) void cutThinking(id, run);
    else if (!run.thinkCut && !run.compacting && !run.tools.size && run.heardAt && now - run.heardAt > MODEL_SILENT_MS && (run.silentCuts ?? 0) < 3) void cutSilent(id, run);
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
    // the same look again and again is waiting; different looks (git status, then a log, then
    // gh pr view) and reading a tool's help are finding things out, not "the same thing"
    if (/(^|\s)(--help|-h|-help)(\s|$)/.test(cmd)) return;
    run.polls = run.lastPoll === cmd ? (run.polls ?? 0) + 1 : 1;
    run.lastPoll = cmd;
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

/** what the model is told with the user's words said while it worked */
const midNote = (open: boolean) =>
  `\n\n(Ondra) The user said this while you were working. Answer them first, now: a short reply in your own voice before your next tool call, the way someone busy with something else looks up and answers, not after the step in your hands is over. Then decide where it goes:
- a question: the reply is the answer, a sentence or two; don't change files for it, and go on.
- a change to the step you are on: say so and apply it now.
- something for a later step (how to deploy, what to check at the end) or new work: don't jump to it. Put it in your plan where it belongs by what depends on what, not by when it came (a survey that ships with the deploy is built before the deploy), with "user": true. The reply says where it went ("설문 먼저 끝내고, 배포할 때 말씀하신 방식으로 할게요"); finish the small step in your hands, and go on in plan order.
- stop, now, or instead of what you are doing: switch now.
${open ? "Added or changed work: send the updated plan block before any other tool call." : "Added work: send a plan block with the whole job in it (what is done, this, what is left) before any other tool call."}`;

/**
 * Its own commands still running in the foreground: steered words wait for them, so the user's go in
 * only once they are stopped. Left running on purpose (a dev server, a watcher) is not among them.
 */
function commandsToStop(id: string, run: Run) {
  const live = (taskById(id)?.shells ?? []).filter((s) => run.tools.has(s.id) && !s.endedAt && !s.background);
  return live.flatMap((s) => {
    const arg = shellArg(s.command, live.filter((x) => x.id !== s.id).map((x) => x.command));
    return arg ? [{ id: s.id, command: s.command, arg }] : [];
  });
}
/** the shells running them (`/bin/bash -c <command>`): the call returns and the steered words go in */
function stopShells(id: string, list: { arg: string }[]) {
  for (const w of list) void agentStopCommand(agentOf(id), "bash", w.arg).catch(() => 0);
  updateTask(id, (t) => void push(t, { kind: "note", text: "명령 멈춤 · 새 메시지를 바로 전해요" }));
}

/** A word from Ondra itself to a job at work: taken after its current step, not shown in its
 *  chat as the user's. False when it isn't mid-turn (nothing to say it to). */
export function whisper(id: string, message: string): boolean {
  // a job on another device isn't reached this way
  if (taskById(id)?.host || !runs.get(id)?.streaming) return false;
  void request(agentOf(id), { type: "steer", message }).catch(() => {});
  return true;
}

export async function tell(id: string, message: string, opts: { now?: boolean; shown?: string; by?: string } = {}) {
  { const r = far(id, "tell", [id, message, opts]); if (r) return r as never; }
  const t = taskById(id);
  if (!t) return;
  const wasPaused = t.status === "paused";
  if (!opts.by) track("message_sent", { where: "task" });
  const agent = agentOf(id);
  // it handed off and waits for its subagents: the old session is over (waking it starts work in a
  // full context, and the new session then cut that turn off and failed the job). Another job's
  // words wait for the next session; the user's start it now (the subagents report to it). Not the
  // queue: nothing drains it until a turn ends, and none comes while it waits.
  const waiting = runs.get(id);
  if (isAlive(agent) && waiting?.pendingHandoff) {
    updateTask(id, (x) => {
      x.saidDone = undefined;
      push(x, { kind: "user", text: opts.shown ?? message, ...(opts.by ? { by: opts.by } : {}) });
      x.inbox.push(message);
    });
    if (opts.by && opts.by !== "main") return;
    if (waiting.streaming) {
      waiting.handoffNow = true;
      return;
    }
    const card = waiting.pendingHandoff;
    waiting.pendingHandoff = undefined;
    await newSession(id, waiting, card);
    return;
  }
  // the user's words wait in line while it works; another agent's (a subagent reporting, its parent
  // answering) go in right away, after its current tool calls: they are part of the work, not the user's turn
  if (!opts.now && !(opts.by && opts.by !== "main") && t.status === "running" && isAlive(agent)) {
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
    // the user's words start a new piece of work: its done is what the job says next, with its own
    // send-backs (the first done of before would stay as the job's summary)
    if (run && (!opts.by || opts.by === "main")) {
      run.firstDone = undefined;
      run.gates = 0;
    }
    setState("decisions", (list) => list.filter((d) => !(d.taskId === id && !d.ui)));
    updateTask(id, (x) => {
      x.status = "running";
    });
    const open = t.plan.some((s) => s.state !== "done" && s.state !== "skip");
    // said in the middle of the work: placed in the plan by what depends on what, not done on arrival.
    // Only the user's (or main relaying them): a job's message already says it is not the user
    const mid = !!run?.streaming && (!opts.by || opts.by === "main");
    // a running command would keep these words from it until it ends (a login poll, a build): it stops
    const cut = mid && run ? commandsToStop(id, run) : [];
    const stopNote = cut.length
      ? `\n\n(Ondra) To bring you this now, Ondra stopped ${cut.map((w) => `\`${shortCmd(w.command)}\``).join(", ")}: its result above is cut off, not finished. If you still need it (a build, a test, a deploy, a wait), run it again when you are back at that step; what a wait waited on still runs.`
      : "";
    // the user's words may change the plan: the model is asked to update it (the user sees only their words)
    const planNote = !mid && open ? "\n\n(Ondra) If this changes your plan, send a new plan block; mark the steps already finished with a now block's step." : "";
    const sent = `${message}${mid ? midNote(open) : ""}${stopNote}${planNote}`;
    // steered words wait for the current tool calls: kept until taken, as a restart loses them
    hold(id, sent, { shown: opts.shown ?? message });
    if (mid && run) {
      run.replanFor = sent;
      run.replanCalls = undefined;
      const said = (opts.shown ?? message).replace(/\s+/g, " ").trim();
      updateTask(id, (x) => (x.planAsk = said.length > 80 ? `${said.slice(0, 80)}…` : said));
    }
    try {
      await request(agent, run?.streaming ? { type: "steer", message: sent } : { type: "prompt", message: sent });
      if (cut.length) stopShells(id, cut);
    } catch (e) {
      if (run?.replanFor === sent) run.replanFor = undefined;
      updateTask(id, (x) => (x.planAsk = undefined));
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
  { const r = far(id, "steerQueued", [id, qid]); if (r) return r as never; }
  const q = taskById(id)?.queue?.find((x) => x.id === qid);
  if (!q) return;
  updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => y.id !== qid)));
  void tell(id, q.sent ?? q.text, queuedOpts(q));
}
const queuedOpts = (q: NonNullable<Task["queue"]>[number]) => ({ now: true, ...(q.sent ? { shown: q.text } : {}), ...(q.by ? { by: q.by } : {}) });
/** Change a queued message where it is; an emptied one is taken out. Edited, it is the user's own words. */
export function editQueued(id: string, qid: string, text: string) {
  { const r = far(id, "editQueued", [id, qid, text]); if (r) return r as never; }
  const t = text.trim();
  if (!t) return dropQueued(id, qid);
  updateTask(id, (x) => (x.queue = (x.queue ?? []).map((y) => (y.id === qid ? { id: y.id, at: y.at, text: t } : y))));
}
/** Move a queued message to another place in line (`to` is its new index). */
export function moveQueued(id: string, qid: string, to: number) {
  { const r = far(id, "moveQueued", [id, qid, to]); if (r) return r as never; }
  updateTask(id, (x) => {
    const q = [...(x.queue ?? [])];
    const from = q.findIndex((y) => y.id === qid);
    if (from < 0) return;
    const [it] = q.splice(from, 1);
    q.splice(Math.max(0, Math.min(to, q.length)), 0, it!);
    x.queue = q;
  });
}
export function dropQueued(id: string, qid: string) {
  { const r = far(id, "dropQueued", [id, qid]); if (r) return r as never; }
  updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => y.id !== qid)));
}
/** The work is done: the next queued message goes in. True if one did. */
function drainQueue(id: string): boolean {
  const q = taskById(id)?.queue?.[0];
  if (!q) return false;
  // what other agents left in line (from before they went straight in) goes in as one message
  if (q.by) {
    const theirs = (taskById(id)?.queue ?? []).filter((x) => x.by);
    updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => !y.by)));
    void tell(id, theirs.map((x) => x.sent ?? x.text).join("\n\n"), { now: true, shown: theirs.map((x) => x.text).join("\n\n"), by: q.by });
    return true;
  }
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

/**
 * Main's question answered long after it was asked: what the project's jobs did since. A
 * "릴리즈할까요?" answered 8 hours later started a release of what another job had released
 * meanwhile, an empty 1.5.0 the same as 1.4.18.
 */
export async function staleAnswerNote(askedAt: number, space: string, project: string | undefined, now = Date.now()): Promise<string | undefined> {
  if (now - askedAt < 30 * 60_000) return undefined;
  // a release made outside Ondra's jobs (by hand, another tool) is on GitHub only
  const released = await releasesSince(askedAt, space, project);
  const mins = Math.round((now - askedAt) / 60_000);
  const ago = mins < 120 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`;
  const since = state.tasks
    .filter((t) => t.space === space && !t.parentId && (!project || t.project === project) && (t.finishedAt ?? 0) > askedAt)
    .map((t) => `- "${t.title}" (${t.id}) ${t.status}${t.summary ? `: ${t.summary}` : ""}`);
  return [
    `(Ondra) This answers a question you asked ${ago} ago.${since.length ? " Jobs that ended since:" : ""}`,
    ...since,
    ...(released.length ? ["Releases published on GitHub since you asked:", ...released] : []),
    "Check what it would do is still to do (the latest release, the branch, these jobs) before routing it; if it was done meanwhile, say so in one line instead of doing it again.",
  ].join("\n");
}

/** the project's GitHub releases published after `at`, one line each */
async function releasesSince(at: number, space: string, project: string | undefined): Promise<string[]> {
  const p = project ? projectById(project, space as Task["space"]) : undefined;
  if (!p?.folder || !(await gitOnGithub(expand(p.folder)).catch(() => false))) return [];
  try {
    const env = await spaceEnv(spaceById(space as Task["space"])).catch((): Env => []);
    const list = JSON.parse(await ghWatch(expand(p.folder), "release", "", env)) as { tagName?: string; name?: string; publishedAt?: string; isDraft?: boolean }[];
    return list
      .filter((r) => !r.isDraft && r.publishedAt && Date.parse(r.publishedAt) > at)
      .map((r) => `- ${r.tagName}${r.name && r.name !== r.tagName ? ` (${r.name})` : ""} at ${r.publishedAt}`);
  } catch {
    return [];
  }
}

export async function decide(decisionId: string, optionId: string, values?: FormValues) {
  const d = state.decisions.find((x) => x.id === decisionId);
  if (!d) {
    // a question of another device's job: answered there, as if the user had answered it on that device
    const m = mirroredDecision(decisionId);
    if (m) await farDecide(m, optionId, values);
    return;
  }
  // a card with things to fill in: what was filled goes back under the choice pressed
  const filled = d.form?.length && values && d.options.some((o) => o.id === optionId) ? formAnswer(d, optionId, values) : undefined;
  track("decision_answered", { waited_s: Math.max(0, Math.round((Date.now() - d.at) / 1000)) });
  setState("decisions", (list) => list.filter((x) => x.id !== decisionId));
  if (d.ui) {
    if (await answerExtensionUi(d, optionId)) {
      const label = d.options.find((o) => o.id === optionId)?.label ?? optionId;
      updateTask(d.taskId, (t) => push(t, { kind: "user", text: label }));
    }
    return;
  }
  if (d.round && (await answerInRound(d, optionId))) return;
  // main asked it: the answer goes back to main as the user's message
  if (d.taskId.startsWith("main:")) {
    const [space, project] = d.taskId.slice(5).split("~");
    const label = filled ?? d.options.find((o) => o.id === optionId)?.label ?? optionId;
    const { throwThought } = await import("./captain");
    // asked on Discord: the answer goes on where it was asked, wherever it was pressed
    const { askedWhere } = await import("./discord");
    const where = askedWhere(d);
    const note = [where.note, await staleAnswerNote(d.at, space, project)].filter(Boolean).join("\n") || undefined;
    void throwThought(`"${d.question}" → ${label}`, space as Task["space"], { project, note, ...(where.discord ? { discord: where.discord } : {}) });
    return;
  }
  const t = taskById(d.taskId);
  if (!t) return;
  const label = d.options.find((o) => o.id === optionId)?.label ?? optionId;
  if (d.kind === "merge" && optionId === "merge-pr") {
    const pr = prOf(t);
    updateTask(t.id, (x) => push(x, { kind: "user", text: `"${d.question}" → ${label}` }));
    return void (await tell(t.id, `Merge your pull request ${pr?.url ?? ""} now, the repo's way (else a squash merge that deletes the branch), then send done in one line.`, { by: "ondra", shown: label }));
  }
  if (d.kind === "merge" && optionId === "keep") {
    updateTask(t.id, (x) => {
      if (x.worktree) x.worktree.kept = true;
      push(x, { kind: "user", text: `"${d.question}" → ${label}` });
    });
    return;
  }
  if (d.kind === "merge" && (optionId === "merge" || optionId === "pr" || optionId === "discard")) {
    updateTask(t.id, (x) => push(x, { kind: "user", text: `"${d.question}" → ${label}` }));
    noteLandAnswer(t, optionId);
    if (optionId === "discard") return void (await discardTask(t.id));
    if (optionId === "pr") return void (await tell(t.id, PR_ASK, { shown: label }));
    const why = await mergeWhy(t.id);
    if (why !== undefined) await tell(t.id, mergeFailed(why, homeDir(t)), { by: "ondra", shown: tr("병합하지 못했어요") });
    return;
  }
  if (d.kind === "unchecked") {
    const run = runs.get(t.id);
    if (optionId === "finish") {
      updateTask(t.id, (x) => push(x, { kind: "user", text: `"${d.question.split("\n")[0]}" → ${label}` }));
      const open = d.question.split("\n").slice(1).map((l) => l.replace(/^· /, ""));
      leftAsIs(t.id, open);
      if (run) finish(t.id, run.firstDone ?? lastReport(t) ?? "완료", run);
      else {
        finish(t.id, lastReport(t) ?? "완료");
        updateTask(t.id, (x) => (x.unverified = open.length ? open : x.unverified));
      }
      return;
    }
    if (optionId === "check") {
      await tell(t.id, "Check what you still can with your tools now. For anything you can't, ask the user with an ask block what you need from them, and wait. Then send done.", { shown: label });
      // "keep checking" isn't an answer about what stays unchecked: the next done is held again
      if (run) run.uncheckedAt = Date.now() + 1;
      updateTask(t.id, (x) => x.uncheckedAsked && (x.uncheckedAsked = { ...x.uncheckedAsked, at: Date.now() + 1 }));
      return;
    }
    // their own words: what they said goes to the job, and the next done goes through
    await tell(t.id, `"${d.question.split("\n")[0]}" → ${label}`, { shown: label });
    return;
  }
  if (d.kind === "stalled" && optionId === "finish") {
    // its last report, not "now" (that is what it was doing, e.g. "명령 실행 중")
    updateTask(t.id, (x) => (x.endedBy = "user"));
    finish(t.id, lastReport(t) ?? "완료");
    return;
  }
  // "멈춰", "계속 멈춤", "stop": the job stops now, it isn't asked to stop itself. Not an option
  // the job offered ("영상 유지 목표로 보류" parked a job that would have wrapped up itself):
  // that is its answer
  const offered = d.kind !== "stalled" && d.options.some((o) => o.id === optionId);
  if (filled) return void (await tell(t.id, `"${d.question}" → ${filled}`, { shown: filled }));
  if (!offered && meansStop(label)) {
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

/**
 * One answer of a round: the next question at once (no model turn), or after the last, every
 * answer together, to the job (or main) that asked. A typed stop word to a job is left to
 * decide (it stops the job, as for any question): false.
 */
async function answerInRound(d: Decision, optionId: string): Promise<boolean> {
  const main = d.taskId.startsWith("main:");
  const typed = !d.options.some((o) => o.id === optionId);
  if (!main && typed && meansStop(optionId)) return false;
  const t = main ? undefined : taskById(d.taskId);
  if (!main && !t) return true;
  const step = answerRound(d, optionId);
  const fresh = step.answers.slice(d.round!.answers.length);
  const line = (a: { q: string; a: string }) => `"${a.q}" → ${a.a}`;
  // each answer shows in the job's thread as it is given
  const show = (list: typeof fresh) => t && list.length && updateTask(t.id, (x) => list.forEach((a) => push(x, { kind: "user", text: line(a) })));
  if (step.next) {
    show(fresh);
    setState("decisions", (list) => [...list.filter((x) => x.taskId !== d.taskId), step.next!]);
    return true;
  }
  const text = roundText(step.answers);
  if (main) {
    const [space, project] = d.taskId.slice(5).split("~");
    const { throwThought } = await import("./captain");
    const { askedWhere } = await import("./discord");
    const where = askedWhere(d);
    const note = [where.note, await staleAnswerNote(d.at, space, project)].filter(Boolean).join("\n") || undefined;
    void throwThought(text, space as Task["space"], { project, note, ...(where.discord ? { discord: where.discord } : {}) });
    return true;
  }
  show(fresh.slice(0, -1));
  await tell(t!.id, text, { shown: line(fresh[fresh.length - 1]) });
  return true;
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
const meansStop = (text: string) => /멈춰|멈추|멈춤|그만|중지|중단|보류|\bstop\b|\bpause\b|\bhold\b/i.test(text) && !/말고|않|안 ?멈|계속 (진행|해)|don'?t stop|keep going|continue/i.test(text);

export function pauseTask(id: string) {
  { const r = far(id, "pauseTask", [id]); if (r) return r as never; }
  clearExtensionUi(id);
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

/**
 * A subagent whose job ended: stopped for good. Paused, it stayed in the list for weeks with
 * nothing that would ever resume it (its job was over).
 */
function endKid(id: string) {
  clearExtensionUi(id);
  runs.delete(id);
  agentKill(agentOf(id));
  markDead(agentOf(id));
  setLive(id, "");
  updateTask(id, (x) => {
    const now = Date.now();
    x.status = "done";
    x.pausedBy = undefined;
    x.summary ||= "작업이 끝나서 멈췄어요";
    x.now = x.summary;
    x.finishedAt = now;
    closeOpen(x);
    push(x, { kind: "note", text: "작업이 끝나서 멈췄어요" });
    const leg = x.legs[x.legs.length - 1];
    if (leg && !leg.endedAt) leg.endedAt = now;
  });
  for (const k of childrenOf(id).filter((k) => k.status !== "done" && k.status !== "failed")) endKid(k.id);
}

/** subagents left paused (or waiting) under a job that has ended: they end too */
export function endOrphanKids() {
  const over = (t: Task | undefined): boolean => !t || t.status === "done" || t.status === "failed" || !!t.archived;
  for (const k of state.tasks.filter((k) => k.parentId && (k.status === "paused" || k.status === "waiting" || k.status === "queued"))) {
    let top = taskById(k.parentId!);
    while (top?.parentId && !over(top)) top = taskById(top.parentId);
    if (over(taskById(k.parentId!)) || over(top)) endKid(k.id);
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
  { const r = far(id, "stopTask", [id]); if (r) return r as never; }
  pauseTask(id);
  updateTask(id, (t) => (t.parkedAt = Date.now()));
}

export function resumeTask(id: string) {
  { const r = far(id, "resumeTask", [id]); if (r) return r as never; }
  // a session the provider refused fails the same way on every retry: the retry starts a fresh one
  // from what the thread shows (the scheduler continues only a session whose leg is still open)
  const t = taskById(id);
  if (t?.status === "failed" && t.error && isRefusedRequest(t.error)) {
    const card = cardFromThread(t);
    updateTask(id, (x) => {
      const leg = x.legs[x.legs.length - 1];
      // the next start opens a new leg and gives it this card (a still-open leg would be continued)
      if (leg && !leg.endedAt) (leg.endedAt = Date.now()), (leg.handoff = card);
      push(x, { kind: "note", text: "요청이 거부돼서 새 세션으로 이어가요" });
    });
  }
  // another job carried this one on after it stopped (main starts one when a job fails): two jobs on
  // one branch redo each other's work, and the follower may have merged and removed the folder
  const next = t && state.tasks.find((x) => x.follows === id && !x.parentId);
  if (next && (next.status === "queued" || next.status === "running" || next.status === "waiting")) {
    toast(tr("\"{title}\" 작업이 이어받아 진행 중이에요. 그 작업에서 계속해 주세요", { title: next.title }), "bad");
    return;
  }
  // resumed on its own: it no longer waits for the fork that paused it
  updateTask(id, (t) => {
    requeue(t);
    t.pausedBy = undefined;
    t.resumedAt = Date.now();
    if (next)
      t.inbox.push(
        `(Ondra) After this job stopped, the job "${next.title}" (${next.id}) carried it on and is ${next.status}${next.summary ? `: ${next.summary}` : ""}${next.worktree ? ` (branch ${next.worktree.branch}, ${next.worktree.state})` : ""}. Read what it did (job_read ${next.id}) before you change anything, and don't redo work it already merged.`,
      );
  });
  resumeKids(id);
}
export const finishTask = (id: string) => {
  { const r = far(id, "finishTask", [id]); if (r) return r as never; }
  updateTask(id, (t) => (t.endedBy = "user"));
  finish(id, "직접 완료 처리");
};

export function removeTask(id: string) {
  { const r = far(id, "removeTask", [id]); if (r) return r as never; }
  clearExtensionUi(id);
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
  { const r = far(id, "setTaskPermission", [id, p]); if (r) return r as never; }
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
  { const r = far(id, "setTaskModel", [id, model, thinking]); if (r) return r as never; }
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

export const setPriority = (id: string, p: Priority) => void (far(id, "setPriority", [id, p]) ?? updateTask(id, (t) => (t.priority = p)));
export const setWeight = (id: string, w: Weight) => void (far(id, "setWeight", [id, w]) ?? updateTask(id, (t) => (t.weight = w)));
/** The account a job runs on (작업 정보): it runs on that account's own model from then on. */
export function setTaskAccount(id: string, accountId: string) {
  { const r = far(id, "setTaskAccount", [id, accountId]); if (r) return r as never; }
  // one of its own workspace's accounts only (another device names one this Mac showed it)
  const t = taskById(id);
  if (!t || accountById(accountId)?.space !== t.space) return;
  if (t.accountId === accountId) return void (t.accountPinned || updateTask(id, (x) => (x.accountPinned = true)));
  updateTask(id, (x) => ((x.accountId = accountId), (x.model = undefined), (x.accountPinned = true)));
}

// ─────────────────────────────── scheduler

/** Start queued work in priority order: all of it at once, no cap on how many run (a step waits for the steps it builds on). */
export function schedule() {
  if (!inTauri || !loaded() || !engine.checked || !engine.ready) return;
  endOrphanKids();
  // subagents run beside their fork (up to 4 at once per fork)
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
      endKid(k.id);
      continue;
    }
    void startTask(k.id, !k.legs[k.legs.length - 1].endedAt);
  }
  // a step waits until the steps it builds on are done
  const ready = (t: Task) => !(t.after ?? []).some((id) => { const d = taskById(id); return d && d.status !== "done"; });
  const queue = state.tasks.filter((t) => t.status === "queued" && !t.parentId && ready(t)).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  for (const t of queue) {
    if (waitsOnKids(t)) continue;
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
  // branches merged on GitHub since: their folders go; checked again every ten minutes (a watched PR sooner)
  setTimeout(() => void sweepLanded(), 20_000);
  setInterval(() => void sweepLanded(), 10 * 60_000);
  // pull requests jobs opened: reviews, failed checks and conflicts go back to the job
  setTimeout(() => void watchPrs(), 40_000);
  setInterval(() => void watchPrs(), 3 * 60_000);
  setInterval(() => {
    const slept = sleptSinceLastLook();
    if (slept) {
      logInfo("task", `the Mac slept ${Math.round(slept / 60_000)} min: watchdogs move on by that`);
      sleptFor(slept);
    }
    stopStalledCommands();
  }, 10_000);
  createRoot(() => {
    createEffect(
      on(
        () => state.tasks.map((t) => t.status).join(),
        () => queueMicrotask(schedule),
      ),
    );
  });
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
  { const r = far(id, "editTurn", [id, entryId, text]); if (r) return r as never; }
  const t = taskById(id);
  if (!t) return;
  const at = t.entries.findIndex((e) => e.id === entryId);
  const old = t.entries[at];
  if (at < 0 || old.kind !== "user") return;
  clearExtensionUi(id);
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

export const togglePin = (id: string) => void (far(id, "togglePin", [id]) ?? updateTask(id, (t) => (t.pinned = !t.pinned)));
/** Seen: its unread dot goes. Another Mac's job keeps its dot there (that device's user may not have
 *  seen it); here it stays gone until the job says more. */
export function markRead(id: string) {
  if (hostOfTask(id)) return markFarRead(id);
  updateTask(id, (x) => (x.unread = false));
}
export function archiveTask(id: string, on = true, o: { quiet?: boolean } = {}) {
  { const r = far(id, "archiveTask", [id, on]); if (r) return r as never; }
  updateTask(id, (t) => {
    t.archived = on;
    if (on) t.pinned = false;
  });
  if (on && !o.quiet) toast(tr("보관했어요"), "info", { label: tr("되돌리기"), run: () => archiveTask(id, false) });
}
export function renameTask(id: string, title: string) {
  { const r = far(id, "renameTask", [id, title]); if (r) return r as never; }
  const v = title.trim().slice(0, 80);
  if (v) updateTask(id, (t) => (t.title = v));
}
/** Same request again as a new job (same folder, model and permission). Another Mac's job runs
 *  again there: the new one's id comes back once that device made it. */
export function duplicateTask(id: string): string | undefined | Promise<string | undefined> {
  { const r = far(id, "duplicateTask", [id]); if (r) return r.then((n) => (typeof n === "string" ? n : undefined)); }
  const t = taskById(id);
  if (!t) return;
  // one another device asked for stays its: that device keeps a copy of it as of the first one
  const n = createTask({ space: t.space, title: `${t.title} (복제)`, topic: t.topic, ask: t.ask, cwd: homeDir(t), priority: t.priority, weight: t.weight, accountId: t.accountId, ...(t.from ? { from: t.from } : {}), ...(t.agent ? { agent: t.agent } : {}) });
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
