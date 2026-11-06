// Task lifecycle: start an engine session, turn its events into transcript
// entries, roll to a fresh session on a handoff (the relay), pick another
// model when one is rejected, and schedule queued work into free slots.
import { describeCommand } from "./describe";
import { jobSkills } from "./skillPick";
import { prepareQuery } from "./vectors";
import { batch, createEffect, createRoot, on } from "solid-js";
import { accountById, accountsIn, homeDir, loaded, projectFor, setState, spaceById, state, taskById, uid, updateAccount, updateTask } from "../state/store";
import { limits, refreshLimits, snapshot } from "../state/limits";
import { noteCall, noteCtx } from "../state/ctx";
import type { Account, Block, Decision, Entry, Evidence, Handoff, Permission, Priority, PrWatch, Task, TokenStats, ToolCall, Usage, Weight } from "../state/types";
import { setLive, toast } from "../state/ui";
import { allowedDevices, refreshDevices } from "../state/devices";
import { inTauri, jobDevicesRelease, accountDirPath, agentKill, agentSend, agentSpawn, browserCheck, browserRelease, type Env, gitChanges, spaceEnv, workerEnv, workerExtensions, worktreeCreate, worktreeLanded, worktreeMerge, worktreeRemove, fsRead, ghPrState } from "../lib/native";
import { canWake, hasNews, parseSnap, prNews, wakeText, type PrNews } from "./prWatch";
import { prose, readFences } from "./fences";
import { commandKind } from "./commandKind";
import { checkEvidence, isCodeFile, reviewUnresolved } from "./proof";
import { addMemory, KINDS, markUsed, memoryLines } from "./memory";
import { effortFor, failedModelIn, modelFor, nextModel } from "./models";
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
  /** prompt size when this session started (the long-context nudge measures growth above it) */
  base?: number;
  /** a handoff sent while subagents still worked: the new session starts once they are done */
  pendingHandoff?: Handoff;
}

// A session that grew this many prompt tokens past where it started is told to
// hand off: every later call re-sends the whole context, so long sessions cost the
// most and think worst. (Measured from the start: the system prompt and tools
// alone take ~30k, a resumed session starts bigger.)
const HANDOFF_AT = [90_000, 150_000];

const runs = new Map<string, Run>();
export const agentOf = (taskId: string) => `t:${taskId}`;
const MAX_ENTRIES = 600;
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
  const load = (id: string) => Math.max(0, ...(limits[id] ?? []).map((l) => l.used));
  const roomy = pool.filter((a) => load(a.id) < 85);
  const use = roomy.length ? roomy : pool;
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

export const NO_ACCOUNT = "이 공간에 계정이 없어요";

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
  if (t.entries.length > MAX_ENTRIES) t.entries.splice(0, t.entries.length - MAX_ENTRIES);
  return id;
}

/**
 * What a job's model sees up front: the four file/shell tools, memory search and
 * tool_search. Every other tool (phone devices, saving memory, MCP servers, …) is
 * registered as deferred and declared only after tool_search finds it.
 */
// (the engine runs with --no-extensions, so the built-in tool_search is loaded by name)
export const WORKER_TOOLS = ["--extension", "builtin:tool-search", "--tools", "+tool_search"];

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
      if (/\bagent-browser\b/.test(cmd)) return { name, kind: "browser", target: cmd.replace(/^.*?agent-browser\s+(--\S+\s+\S+\s+)*/, ""), detail: cmd, now: "브라우저 사용 중" };
      if (/\bagent-desktop\b/.test(cmd)) return { name, kind: "desktop", target: cmd.replace(/^.*?agent-desktop\s+/, ""), detail: cmd, now: "앱 조작 중" };
      if (/\b(test|vitest|jest|pytest|cargo test|xcodebuild test|go test)\b/.test(cmd)) return { name, kind: "test", target: cmd, detail: cmd, now: "테스트 실행 중" };
      return { name, kind: "bash", target: cmd, detail: cmd, now: describeCommand(cmd).now };
    }
    default:
      return { name, kind: "other", target: name, detail: JSON.stringify(args ?? {}), now: name };
  }
}

const keepsRunning = (cmd: string) =>
  /(&\s*$|&\s*disown|\bnohup\b|--watch\b|\bwatch\b|tail\s+-f|\b(dev|serve|start)\s*$|\bvite\b(?!\s+build)|tauri dev|next dev)/.test(cmd);

function closeShells(t: Task) {
  for (const s of t.shells) if (!s.endedAt) s.endedAt = Date.now();
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
        if (id) push(t, { kind: "note", text: `기억함 · ${String(b.text).slice(0, 120)}` });
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
        const unverified = Array.isArray(b.unverified) ? b.unverified.map(String).filter(Boolean) : [];
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
        const review = b.review === true || /code-review|리뷰/i.test(String(b.title ?? ""));
        // one review per job: after it, the job fixes the findings and re-runs its checks
        const had = review ? state.tasks.find((x) => x.parentId === t.id && x.review && x.status !== "failed") : undefined;
        // the job this carries on was reviewed and this one changed no code since: that review still holds
        const before = review && !had && !editedCode(t) ? reviewedBefore(t) : undefined;
        if (before) {
          push(t, { kind: "note", text: "앞의 일에서 받은 리뷰가 그대로 유효해요" });
          const jobId = t.id;
          const message = `(Ondra) The job this carries on was already reviewed ("${before.title}") and its findings were fixed there; you haven't changed code since. That review covers this: don't start another one, go on with the next step.`;
          queueMicrotask(() => void request(agentOf(jobId), { type: "steer", message }).catch(() => {}));
          break;
        }
        if (had) {
          const going = had.status !== "done";
          push(t, { kind: "note", text: going ? "리뷰가 아직 진행 중이에요" : "리뷰는 이미 한 번 받았어요" });
          const jobId = t.id;
          // a new session may not know about it: say where it is, and what it found
          const message = going
            ? `(Ondra) A review is already running ("${had.title}"). Its findings come to you by themselves when it ends. Don't start another one and never ask the user for them: go on with what doesn't depend on it, or end your turn and wait.`
            : `(Ondra) This job was already reviewed once ("${had.title}"). Don't start another review. What it found:\n\n${had.result ?? had.summary ?? "(nothing written)"}\n\nFix P1·P2 only, re-run the tests that cover them, and finish.`;
          queueMicrotask(() => void request(agentOf(jobId), { type: "steer", message }).catch(() => {}));
          break;
        }
        const child = spawnChild(t, String(b.title ?? "서브에이전트"), String(b.task ?? b.title), review);
        const last = t.entries[t.entries.length - 1];
        if (last?.kind === "spawn") last.childIds.push(child.id);
        else push(t, { kind: "spawn", childIds: [child.id] });
        break;
      }
      default:
        if (b.type === "shot" && b.path) t.shot = b.path;
        push(t, { kind: "block", block: b as Block });
    }
  }
}

// ─────────────────────────────── start / events

// ─────────────────────────────── subagents

/** A subagent of a fork: same folder (and worktree), account and model; never isolated itself. */
function spawnChild(parent: Task, title: string, ask: string, review = false): Task {
  const child: Task = {
    id: uid("t"),
    space: parent.space,
    ...(parent.reach?.length ? { reach: parent.reach } : {}),
    topic: parent.topic,
    title: title.trim().slice(0, 40) || "서브에이전트",
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
  };
  setState("tasks", (list) => [...list, child]);
  queueMicrotask(schedule);
  return child;
}

export const childrenOf = (id: string) => state.tasks.filter((t) => t.parentId === id);
const activeKids = (id: string) => childrenOf(id).filter((t) => t.status === "queued" || t.status === "running" || t.status === "waiting");

/** A subagent ended: hand its result to the fork (now, after its turn, or on its next start). */
async function deliver(child: Task) {
  const parent = child.parentId ? taskById(child.parentId) : undefined;
  if (!parent) return;
  const body =
    child.status === "done"
      ? child.review
        ? `리뷰 결과가 왔어요 ("${child.title}"):\n\n${child.result ?? child.summary ?? ""}\n\nP1·P2만 고쳐 줘. P3는 고치지 말고 done의 unverified나 메모에 적기만 해. 고친 뒤에는 그 부분을 다루는 테스트만 다시 돌려(전체 검사·리뷰를 다시 돌리지 말고, 앞에서 통과한 게 그대로 유효하니 다시 안 돌린 걸 unverified에 적지도 마). 그다음 계획에 남은 단계(설치, 사진, 올리기처럼 맡은 일에 있던 것)를 이어서 하고 끝내. 고칠 게 없으면 바로 남은 단계로 넘어가.`
        : `서브에이전트 "${child.title}" 완료: ${child.summary ?? ""}${child.result ? `\n\n${child.result}` : ""}`
      : `서브에이전트 "${child.title}" 실패: ${child.error ?? "알 수 없는 오류"}`;
  const left = activeKids(parent.id).length;
  const message = `${body}\n\n(남은 서브에이전트: ${left}개)`;
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
      x.worktree = { ...w, state: "merged", into };
      x.cwd = homeDir(x);
      push(x, { kind: "note", text: `${into}에 합쳤어요` });
      if (x.status !== "done") {
        x.status = "done";
        x.plan = closePlan(x.plan);
        x.finishedAt = Date.now();
        x.summary ||= `${into}에 합침`;
      }
    });
    toast(`${into}에 합쳤어요`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(/conflict|충돌/i.test(msg) ? "같은 곳을 고친 변경이 있어서 합치지 못했어요" : `합치지 못했어요: ${msg.split("\n")[0]}`, "bad");
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
    push(x, { kind: "note", text: "작업 폴더를 정리했어요. 변경은 PR에 있어요" });
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
  // it had already said done when Ondra went down: it is over, don't prompt it again
  const said = taskById(id);
  if (resume && said?.saidDone && !unread(said).length) {
    finish(id, said.saidDone);
    return;
  }
  if (!resume && !taskById(id)?.answer && !(await isolate(id))) return;
  const t0 = taskById(id);
  if (!t0) return;
  const agent = agentOf(id);
  const account = spaceAccount(t0.space, t0.topic, t0.accountId);
  if (!account) return fail(id, NO_ACCOUNT);
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
    const env = [...(await workerEnv(id, t0.space)), ...(await accountEnv(account.id)), ...(await spaceEnv(spaceById(t0.space))), ["ONDRA_PERMISSION", t0.permission ?? "edits"] as [string, string], ["ONDRA_SPACE", t0.space] as [string, string], ["ONDRA_DEVICES_ALLOWED", allowedDevices(t0.space, id).join(",")] as [string, string], ...dataEnv(t0), ...(spaceById(t0.space).aside?.trim() ? [["ONDRA_ASIDE_ACCOUNT", spaceById(t0.space).aside!.trim()] as [string, string]] : [])];
    const skills = await jobSkills(t0);
    const model = t.model || modelFor(account.id);
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
      ...taskSystem(t).flatMap((p) => ["--append-system-prompt", p]),
      // only the skills picked for this job, not every one found on the machine
      "--no-skills",
      ...skills.flatMap((s) => ["--skill", s]),
      ...(model ? ["--model", model] : []),
      "--thinking",
      t.thinking || effortFor(account.id) || "high",
      ...(await workerExtensions()).flatMap((e) => ["--extension", e]),
      ...WORKER_TOOLS,
      ...(resume ? ["--continue"] : []),
    ];
    await agentSpawn(agent, cwd, args, env);
    markAlive(agent);
    const fresh = taskById(id)!;
    // a resumed session already has totals; only what happens from here counts
    if (resume) run.stats = await rawStats(agent);
    if (rewind) {
      updateTask(id, (x) => (x.inbox = []));
      await forkAt(agent, rewind.from);
      run.stats = await rawStats(agent);
      await request(agent, { type: "prompt", message: rewind.message });
      return;
    }
    // the command the restart cut off (not a time limit: commands have none unless given one)
    const cut = fresh.shells.filter((s) => !s.endedAt && !s.background).pop()?.command.replace(/\s+/g, " ").slice(0, 160);
    if (resume) updateTask(id, (x) => closeShells(x));
    // answers it already acted on before the restart aren't news
    const handled = new Set(fresh.entries.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text));
    const fresh2 = unread(fresh);
    for (const m of fresh2) handled.delete(m);
    const message = resume
      ? [
          `(Ondra가 다시 시작됐어요. ${cut ? `그때 돌던 명령 \`${cut}\`은 재시작 때문에 끊겼어요. 시간 제한 때문이 아니니 제한이 있다고 여기지 말고, 필요하면 그 로그부터 보고 다시 돌리세요.` : "돌던 명령이 끊겼으면 그 로그부터 확인하세요."} 하던 일을 이어서 하세요. 이미 보낸 plan은 다시 보내지 마세요.)`,
          ...[...fresh2, ...fresh.inbox.filter((m) => !handled.has(m))].filter((m, i, all) => all.indexOf(m) === i).map((m) => `- ${m}`),
        ].join("\n")
      : fresh.legs.length > 1
        ? handoffPrompt(fresh)
        : taskPrompt(fresh);
    updateTask(id, (x) => {
      x.inbox = [];
    });
    await request(agent, { type: "prompt", message });
  } catch (e) {
    fail(id, e instanceof Error ? e.message : String(e));
  }
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
    closeShells(t);
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
          if (ev.message?.role === "assistant") {
            run.text = "";
            run.cursor = 0;
            run.msgAt = Date.now();
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
              if (text) push(t, { kind: "text", text: text.slice(0, 20000) });
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
          // where this session started (a resumed one counts from a fresh session's size)
          if (prompt) run.base ??= Math.min(prompt, 40_000);
          const level = run.longNudges ?? 0;
          if (run.streaming && level < HANDOFF_AT.length && prompt - (run.base ?? 30_000) > HANDOFF_AT[level] && !run.done && !run.handoff) {
            run.longNudges = level + 1;
            const k = Math.round(prompt / 1000);
            void request(agentOf(id), {
              type: "steer",
              message:
                level === 0
                  ? `(Ondra) This session is at ${k}k tokens. If only the wrap-up is left (the report, a last check), send done here instead. Otherwise finish the step you are on, then send a {"type":"handoff"} block (did, found, next, doneWhen, evidence) so a fresh session continues. Don't start anything new here.`
                  : `(Ondra) This session is at ${k}k tokens. Send done if only the wrap-up is left, otherwise the {"type":"handoff"} block now.`,
            }).catch(() => {});
          }
          break;
        }
        case "tool_execution_start": {
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
            if (sh) sh.tail = tail.slice(-TAIL);
          });
          break;
        }
        case "tool_execution_end": {
          const entryId = run.tools.get(ev.toolCallId);
          run.tools.delete(ev.toolCallId);
          const out = ev.result?.content?.find?.((c: any) => c.type === "text")?.text;
          const done = taskById(id)?.entries.find((x) => x.id === entryId);
          if (done?.kind === "tool") loopGuard(id, run, done.tool, !ev.isError);
          // a plan that stopped moving: ask where it is (at most three times a session)
          run.quietTools = (run.quietTools ?? 0) + 1;
          const plan = taskById(id)?.plan ?? [];
          if (run.streaming && run.quietTools >= 12 && (run.planNudges ?? 0) < 3 && plan.some((s) => s.state !== "done")) {
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
  if (run.error && !run.done && !run.handoff && !run.asked) {
    fail(id, run.error);
    return;
  }
  run.error = undefined;

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
        push(x, { kind: "note", text: `끝내기 전에 확인 · ${missing.label}` });
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
  // Stopped without done / handoff / ask.
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
  run.base = undefined;
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
    await request(agent, { type: "prompt", message: handoffPrompt(taskById(id)!) });
    updateTask(id, (x) => {
      x.inbox = [];
    });
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

async function proofMissing(t: Task, run: Run): Promise<{ label: string; ask: string } | null> {
  const wrote = t.entries.filter((e) => e.kind === "tool" && (e.tool.kind === "edit" || e.tool.kind === "write") && e.tool.ok !== false && !e.tool.note);
  if (!wrote.length) return null; // looked things up, answered: nothing to prove
  // the job's code: not its notes, data, or what it wrote in the artifacts folder (reports and their scripts)
  const code = (p: string) => isCodeFile(p, t) && !/\.html?$/i.test(p);
  const changed = wrote.some((e) => e.kind === "tool" && code((e.tool.detail ?? "").split("\n")[0]));
  // a review is required only for a large or risky change (as the prompt says)
  const codeFiles = new Set(wrote.map((e) => (e.kind === "tool" ? (e.tool.detail ?? "").split("\n")[0].trim() : "")).filter((p) => p && code(p)));
  const risky = [...codeFiles].some((p) => /auth|login|session|token|secret|payment|billing|checkout|migrat|schema|\.sql$|security|permission|crypto|delete|remove/i.test(p));
  // once it went out, a review can't change what shipped: say so instead of sending the job back
  const out = shipped(t);
  const needsReview = changed && (codeFiles.size >= 5 || risky) && !out;
  if (changed && (codeFiles.size >= 5 || risky) && out && !state.tasks.some((x) => x.parentId === t.id && x.review && x.status === "done"))
    run.unverified = [...(run.unverified ?? []), "리뷰 없이 내보냈어요"];
  const kids = state.tasks.filter((x) => x.parentId === t.id);
  const reviewed = !needsReview || kids.some((x) => x.review && x.status === "done");
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
  const bad = checked.filter((e) => e.why);
  const proven = checked.some((e) => !e.why) || (run.unverified ?? []).length > 0;
  const needs = [changed && !reviewed && "리뷰", unresolved && "리뷰 지적", !proven && "증거", bad.length && "증거 안 맞음"].filter(Boolean) as string[];
  if (!needs.length) return null;
  const lines = [
    "끝내기 전에 빠진 게 있어요.",
    changed && !reviewed ? "- 코드를 바꿨는데 리뷰를 안 받았어요. 리뷰 서브에이전트({\"type\":\"subagent\",\"review\":true,…, code-review 스킬})를 띄우고 결과를 받아 고쳐 줘." : "",
    unresolved ? "- 리뷰에서 P1·P2가 나왔는데 그 뒤로 고친 게 없어요. 고치고, 고친 걸 다시 확인해 줘." : "",
    !proven ? "- done에 evidence가 없어요. 실제로 돌린 테스트·빌드·실행·스크린샷을 evidence에 넣고, 확인 못 한 건 unverified에 적어 줘." : "",
    ...bad.map((e) => `- evidence «${e.ref}»: ${e.why}. ${e.check === "missing" ? "파일을 실제로 만들거나 경로를 고쳐 줘." : e.kind === "shot" ? "지금 화면을 다시 찍어 그 사진을 넣어 줘." : "지금 실제로 돌리고 그 결과를 적어 줘."}`),
    "안 해 본 걸 했다고 하지 말고, 못 한 건 unverified에 적은 뒤 다시 done으로 끝내 줘.",
  ];
  return { label: `${needs.join(" · ")}`, ask: lines.filter(Boolean).join("\n") };
}

function finish(id: string, summary: string, run?: Run) {
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
    closeShells(t);
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
      push(x, { kind: "note", text: pr ? `${into}이 합쳐져서 작업 폴더를 정리했어요` : `${into}에 이미 들어가서 작업 폴더를 정리했어요` });
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
    title: f.title.trim().slice(0, 40) || "작업",
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
      { id: uid("e"), at: Date.now(), kind: "user", text: f.display ?? f.ask },
      ...(prev ? [{ id: uid("e"), at: Date.now(), kind: "note" as const, text: `"${prev.title}" 일의 결과${prev.worktree?.state === "open" ? "와 브랜치" : ""}를 이어받아 새로 시작해요` }] : []),
    ],
    shells: [],
    inbox: [],
    origin: f.origin,
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
    push(x, { kind: "note", text: `브랜치 ${w.branch}는 "${taskById(id)?.title ?? ""}" 일로 넘어갔어요` });
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
    push(x, { kind: "note", text: `"${taskById(nextId)?.title ?? ""}" 일로 넘어가요` });
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
  const ids = [t.id, t.follows, t.parentId, ...(t.after ?? []), ...state.tasks.filter((k) => k.parentId === t.id).map((k) => k.id)].filter((x): x is string => !!x);
  return [
    ["ONDRA_DATA_DIR", data],
    ["ONDRA_SPACE_KEY", key],
    ["ONDRA_RECIPES_DIR", `${data}/browser/${key}/recipes`],
    ...(t.reach?.length ? [] : [["ONDRA_JOBS_ALLOWED", [...new Set(ids)].join(",")] as [string, string]]),
  ];
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
    title: (f.title?.trim() || (first.length > 28 ? `${first.slice(0, 28)}…` : first) || "질문").slice(0, 40),
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
            "(Ondra) You are checking on the same thing turn after turn. Wait for it in one bash call instead: `for i in $(seq 1 60); do <is it done?> && break; sleep 10; done; <show the result>` (up to 10 minutes per call). Don't stop or restart what is running.",
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

export async function tell(id: string, message: string, opts: { now?: boolean } = {}) {
  const t = taskById(id);
  if (!t) return;
  const agent = agentOf(id);
  if (!opts.now && t.status === "running" && isAlive(agent)) {
    updateTask(id, (x) => (x.queue = [...(x.queue ?? []), { id: uid("q"), text: message, at: Date.now() }]));
    return;
  }
  updateTask(id, (x) => {
    x.saidDone = undefined;
    push(x, { kind: "user", text: message });
  });
  if (isAlive(agent) && (t.status === "running" || t.status === "waiting")) {
    const run = runs.get(id);
    setState("decisions", (list) => list.filter((d) => !(d.taskId === id && !d.ui)));
    updateTask(id, (x) => {
      x.status = "running";
    });
    // the user's words may change the plan: the model is asked to update it (the user sees only their words)
    const sent = t.plan.some((s) => s.state !== "done") ? `${message}\n\n(Ondra) If this changes your plan, send a new plan block; mark the steps already finished with a now block's step.` : message;
    try {
      await request(agent, run?.streaming ? { type: "steer", message: sent } : { type: "prompt", message: sent });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    return;
  }
  updateTask(id, (x) => {
    x.inbox.push(message);
    if (x.status !== "queued") requeue(x);
  });
}

/** Steer a queued message in now. */
export function steerQueued(id: string, qid: string) {
  const q = taskById(id)?.queue?.find((x) => x.id === qid);
  if (!q) return;
  updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => y.id !== qid)));
  void tell(id, q.text, { now: true });
}
export function dropQueued(id: string, qid: string) {
  updateTask(id, (x) => (x.queue = (x.queue ?? []).filter((y) => y.id !== qid)));
}
/** The work is done: the next queued message goes in. True if one did. */
function drainQueue(id: string): boolean {
  const q = taskById(id)?.queue?.[0];
  if (!q) return false;
  updateTask(id, (x) => (x.queue = (x.queue ?? []).slice(1)));
  void tell(id, q.text, { now: true });
  return true;
}

function requeue(t: Task) {
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
    finish(t.id, lastReport(t) ?? "완료");
    return;
  }
  // "멈춰", "계속 멈춤", "stop": the job stops now, it isn't asked to stop itself
  if (meansStop(label)) {
    updateTask(t.id, (x) => push(x, { kind: "user", text: `"${d.question}" → ${label}` }));
    pauseTask(t.id);
    return;
  }
  const message =
    d.kind === "stalled"
      ? "이어서 진행하세요. 모두 끝났으면 done을 보내세요. 사용자나 서브에이전트를 기다려야 하면 그냥 턴을 끝내세요."
      : `"${d.question}" → ${label}`;
  await tell(t.id, message);
}

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
    closeShells(t);
    push(t, { kind: "note", text: "일시정지" });
  });
  for (const k of activeKids(id)) pauseTask(k.id);
}

export const resumeTask = (id: string) => updateTask(id, (t) => requeue(t));
export const finishTask = (id: string) => finish(id, "직접 완료 처리");

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
    toast(`권한을 바꾸지 못했어요: ${e instanceof Error ? e.message : String(e)}`, "bad");
  }
}

/** Model / effort for one task; applied to its live session right away. */
export async function setTaskModel(id: string, model: string, thinking: string) {
  updateTask(id, (t) => {
    t.model = model || undefined;
    t.thinking = thinking || undefined;
  });
  const agent = agentOf(id);
  if (!isAlive(agent)) return;
  try {
    const t = taskById(id)!;
    const m = model || modelFor(t.accountId);
    if (m) {
      const i = m.indexOf("/");
      await request(agent, { type: "set_model", provider: m.slice(0, i), modelId: m.slice(i + 1) });
    }
    if (thinking) await request(agent, { type: "set_thinking_level", level: thinking });
    updateTask(id, (t) => push(t, { kind: "note", text: `모델 → ${(m ?? "").split("/").pop()}${thinking ? ` · ${thinking}` : ""}` }));
  } catch (e) {
    toast(`모델을 바꾸지 못했어요: ${e instanceof Error ? e.message : String(e)}`, "bad");
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
  if (!isAlive(agent)) return toast("지금은 정리할 대화가 없어요");
  toast("대화를 요약해서 정리하는 중이에요");
  try {
    await request(agent, { type: "compact" }, 180_000);
    noteCtx(agent, await request(agent, { type: "get_session_stats" }, 8000));
    toast("정리했어요");
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
  if (on) toast("보관했어요", "info", { label: "되돌리기", run: () => archiveTask(id, false) });
}
export function renameTask(id: string, title: string) {
  const v = title.trim().slice(0, 60);
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
