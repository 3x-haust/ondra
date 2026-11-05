// The dispatcher (internally "captain"). Every request goes here first and
// comes back as routes: answer now, add to a running task, start new tasks, or
// remember. The chat is kept as text in the app; the engine session under it is
// disposable: it is cleared in the background (when the cache has gone cold or
// the session got long) and a new one starts from a short text recap.
import { prepareQuery } from "./vectors";
import { accountById, addProject, projectById, projectFor, projectsIn, repoHome, setState, spaceById, state, taskById, tasksIn, uid } from "../state/store";
import type { Block, CaptainMessage, Decision, Priority, Route, SpaceId, Task } from "../state/types";
import { setLive } from "../state/ui";
import { agentKill, agentSpawn, ensureDir, fsRead, sessionsPrune, workerExtensions } from "../lib/native";
import { prose, readFences } from "./fences";
import { addMemory, applying, isLive, KINDS, memoryLines, recall } from "./memory";
import { failedModelIn, modelFor, nextModel } from "./models";
import { CAPTAIN_SYSTEM, instructions, projectRules, spaceRules } from "./prompts";
import { engine, expand, explain, isAlive, isModelError, listen, markAlive, markDead, request, stderrOf } from "./rpc";
import { accountEnv, chooseAccount, collectStats, createTask, forkAt, onJobEnded, pauseTask, rawStats, tell, turnUsage, WORKER_TOOLS } from "./tasks";
import { refreshLimits } from "../state/limits";

/** A chat is the main of a space ("work") or of one project in it ("work~pomo"). */
export const chatKey = (space: SpaceId, project?: string) => (project ? `${space}~${project}` : space);
const sp = (key: string) => key.split("~")[0] as SpaceId;
const pj = (key: string) => key.split("~")[1] as string | undefined;
const projectOf = (key: string) => (pj(key) ? (state.projects ?? []).find((p) => p.id === pj(key) && p.space === sp(key)) : undefined);
/** this message belongs to this chat */
export const inChat = (m: CaptainMessage, key: string) => m.space === sp(key) && (m.project ?? undefined) === pj(key);
const sessionDir = (key: string) => `${engine.info.dataDir}/sessions/captain-${key.replace("~", "-")}`;
const agentOf = (space: string) => `captain:${space}`;
const queues = new Map<string, { text: string; replyId: string; cwd?: string; isolate?: boolean; event?: Event }[]>();
/** what main is told about when no user spoke: a fork it started ended, or a project it handed work to finished */
type Event = "fork" | "project";
/** follow-ups main made on its own since the user last spoke, per chat (stops runaway chains) */
const followUps = new Map<string, number>();
const busy = new Set<string>();
const texts = new Map<string, string>();
const errors = new Map<string, string>();
const settled = new Map<string, () => void>();
const accountOf = new Map<string, string>();
const statsOf = new Map<string, any>();
/** generation time of the current reply (for tok/s) */
const genOf = new Map<string, { ms: number; at?: number }>();
/** what the captain's session already has, so each message only carries what changed */
const sentOf = new Map<string, { forks?: string; memory?: string; skills?: string; rules?: string; projects?: string; recap: boolean }>();
/** "own branch per task" choice of the request being routed, per space */
const isolateOf = new Map<string, boolean | undefined>();
/** Captains this page started and listens to. One left over from before a reload
 *  still runs, but nobody hears it, so it is started again. */
const attached = new Set<string>();
/** background clear: after this much quiet the provider cache is cold anyway */
// Keep main's session (and with it the provider's cache key) for an hour: a fresh
// session gets a new key and its first call reads nothing from the cache.
const IDLE_CLEAR_MS = 60 * 60_000;
/** ...and a session never grows past this many context tokens */
const MAX_SESSION_TOKENS = 24_000;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const captainAgent = agentOf;

/** Send a request. Returns the id of the reply message to watch (empty if nothing was sent). */
export function throwThought(text: string, spaceId: SpaceId, opts: { cwd?: string; isolate?: boolean; project?: string } = {}): string {
  const t = text.trim();
  if (!t) return "";
  const project = opts.project || undefined;
  const space = chatKey(spaceId, project);
  const me: CaptainMessage = { id: uid("c"), at: Date.now(), space: spaceId, project, from: "me", text: t };
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: spaceId, project, from: "captain", pending: true };
  setState("captain", (list) => [...list.slice(-300), me, reply]);
  followUps.set(space, 0);
  queues.set(space, [...(queues.get(space) ?? []), { text: t, replyId: reply.id, cwd: opts.cwd, isolate: opts.isolate }]);
  void pump(space);
  return reply.id;
}

/**
 * Main is the orchestrator: when a job it started ends, the result comes back to
 * main, which tells the user what came out and carries on (next job, or a question).
 */
export function jobEnded(t: Task) {
  if (t.parentId || t.answer) return;
  // the chat that owns it gets the result: the project's chat when main handed the work down
  const owners = state.captain.filter((m) => m.space === t.space && (m.routes ?? []).some((r) => r.kind === "new" && r.taskId === t.id));
  const from = owners.find((m) => m.project) ?? owners[0];
  if (!from) return;
  const handed = from.project ? handedRequest(from) : undefined;
  const space = chatKey(t.space, from.project);
  const n = (followUps.get(space) ?? 0) + 1;
  if (n > 6) return; // six automatic steps in a row: wait for the user
  followUps.set(space, n);
  const lastUser = t.entries.map((e) => e.kind).lastIndexOf("user");
  const said = t.entries.slice(lastUser + 1).filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("\n\n").slice(-3500);
  const evidence = t.entries.filter((e) => e.kind === "block" && e.block.type === "evidence").flatMap((e) => (e.kind === "block" && e.block.type === "evidence" ? e.block.items.map((i) => `${i.kind}: ${i.ref}`) : []));
  const text = [
    handed ? `Main handed this project the user's request: "${handed.text}". Finish it here; when nothing is left, your answer goes back to main.` : "",
    `Fork ${t.id} "${t.title}" ${t.status === "done" ? "finished" : "failed"}.`,
    t.status === "done" ? `Summary: ${t.summary ?? ""}` : `Error: ${t.error ?? ""}`,
    t.unverified?.length ? `Not verified: ${t.unverified.join("; ")}` : "",
    evidence.length ? `Evidence: ${evidence.slice(0, 8).join(" | ")}` : "",
    said ? `What it reported:\n${said}` : "",
    // steps that build on it get its result on their own when they start
    ((next) => (next.length ? `Already handed this result automatically (they build on it): ${next.map((x) => `${x.id} "${x.title}"`).join(", ")}. Don't append it to them again.` : ""))(
      state.tasks.filter((x) => x.after?.includes(t.id)),
    ),
  ].filter(Boolean).join("\n");
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: t.space, project: from.project, from: "captain", pending: true, after: t.id };
  setState("captain", (list) => [...list.slice(-300), reply]);
  queues.set(space, [...(queues.get(space) ?? []), { text, replyId: reply.id, event: "fork" }]);
  void pump(space);
}

/**
 * The project for a folder inside the space's folder: its top folder there (the
 * repo), made a project when it isn't one yet. The space folder itself, or a
 * folder outside it, is no project.
 */
export function projectForFolder(space: SpaceId, dir?: string) {
  if (!dir?.startsWith("/") && !dir?.startsWith("~")) return undefined;
  const base = expand(spaceById(space).folder || "").replace(/\/+$/, "");
  const full = repoHome(expand(dir));
  // a space on the whole home folder: its top folders are no repos (Documents, Downloads …)
  if (!base || base === expand("~").replace(/\/+$/, "") || !full.startsWith(`${base}/`)) return undefined;
  const top = `${base}/${full.slice(base.length + 1).split("/")[0]}`;
  if (/^\./.test(top.split("/").pop() ?? "")) return undefined;
  const have = projectsIn(space).find((p) => expand(p.folder).replace(/\/+$/, "") === top);
  return have ?? projectById(addProject(space, top));
}

/** The request main handed down that a project-chat message belongs to (the last one before it). */
function handedRequest(m: CaptainMessage): CaptainMessage | undefined {
  const chat = state.captain.filter((x) => x.space === m.space && x.project === m.project);
  const at = chat.findIndex((x) => x.id === m.id);
  const ask = chat.slice(0, at + 1).reverse().find((x) => x.from === "me");
  return ask?.via === "main" ? ask : undefined;
}

/**
 * Main → project → jobs, and back the same way: when main gives a project work,
 * the request lands in that project's chat, which owns the jobs and carries them
 * on. Once nothing it started for that request is still going, its last answer
 * goes back up to main.
 */
function handDown(spaceId: SpaceId, projectId: string, request: string, taskIds: string[]) {
  const ask: CaptainMessage = { id: uid("c"), at: Date.now(), space: spaceId, project: projectId, from: "me", via: "main", text: request };
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: spaceId, project: projectId, from: "captain", routes: taskIds.map((taskId) => ({ kind: "new" as const, taskId })) };
  setState("captain", (list) => [...list.slice(-300), ask, reply]);
}

export function reportUp(space: string) {
  const projectId = pj(space);
  if (!projectId) return;
  const chat = state.captain.filter((m) => inChat(m, space));
  const last = [...chat].reverse().find((m) => m.from === "me");
  if (!last || last.via !== "main" || last.reported) return;
  const after = chat.slice(chat.indexOf(last) + 1);
  if (after.some((m) => m.pending)) return;
  const jobs = after.flatMap((m) => (m.routes ?? []).flatMap((r) => (r.kind === "new" ? [taskById(r.taskId)].filter((t): t is Task => !!t) : [])));
  if (jobs.some((t) => t.status !== "done" && t.status !== "failed")) return;
  // a question waiting on the user stays in the project; it goes up once answered
  if (state.decisions.some((d) => d.taskId === `main:${space}` || jobs.some((t) => t.id === d.taskId))) return;
  setState("captain", (m) => m.id === last.id, "reported", true);
  const answers = after.flatMap((m) => (m.routes ?? []).flatMap((r) => (r.kind === "answer" && r.text.trim() ? [r.text.trim()] : []))).slice(-2).join("\n\n").slice(-3000);
  // no answer from the project (it failed or said nothing): what each job itself reported
  const reported = answers
    ? ""
    : jobs
        .map((t) => {
          const lastUser = t.entries.map((e) => e.kind).lastIndexOf("user");
          const said = t.entries.slice(lastUser + 1).filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("\n\n");
          return said.trim() ? `${t.title}:\n${said.trim().slice(-2500)}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
  const proj = projectById(projectId);
  const text = [
    `Project "${proj?.name ?? projectId}" finished the request you handed it: "${last.text}".`,
    jobs.length ? `Jobs: ${jobs.map((t) => `${t.id} "${t.title}" ${t.status}${t.summary ? ` — ${t.summary}` : ""}`).join(" | ")}` : "",
    answers ? `What the project reported:\n${answers}` : "",
    reported ? `What the jobs reported:\n${reported}` : "",
  ].filter(Boolean).join("\n");
  const main = chatKey(sp(space));
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: sp(space), from: "captain", pending: true, up: projectId };
  setState("captain", (list) => [...list.slice(-300), reply]);
  queues.set(main, [...(queues.get(main) ?? []), { text, replyId: reply.id, event: "project" }]);
  void pump(main);
}

async function pump(space: string) {
  if (busy.has(space)) return;
  busy.add(space);
  try {
    for (let next = queues.get(space)?.shift(); next; next = queues.get(space)?.shift()) {
      try {
        isolateOf.set(space, next.isolate);
        const { reply, routes } = await routeWithRetry(space, next.text, next.cwd, next.event);
        setState("captain", (m) => m.id === next.replyId, { pending: false, routes, reply, at: Date.now() });
        if (pj(space)) reportUp(space);
      } catch (e) {
        setState("captain", (m) => m.id === next.replyId, { pending: false, error: e instanceof Error ? e.message : String(e) });
        // the project couldn't answer: main still gets what the jobs reported
        if (pj(space)) reportUp(space);
      }
    }
  } finally {
    busy.delete(space);
  }
}

async function routeWithRetry(space: string, text: string, cwd?: string, event?: Event): Promise<{ reply: string; routes: Route[] }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await route(space, text, cwd, event);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 3 && isModelError(msg) && !state.settings.captainModel) {
        const acc = accountOf.get(space)!;
        const next = await nextModel(acc, failedModelIn(msg) ?? modelFor(acc));
        if (next) {
          agentKill(agentOf(space));
          markDead(agentOf(space));
          continue;
        }
      }
      throw new Error(explain(msg));
    }
  }
}

/**
 * Warm main's prompt cache before the user sends: a one-token request with the
 * same prefix, so the real first message reads it instead of paying for it.
 * Runs when main opens and when typing starts; at most every 3 minutes per chat.
 */
const warmedAt = new Map<string, number>();
export async function warmMain(spaceId: SpaceId, project?: string, force = false): Promise<{ warmed: boolean; cacheWrite?: number; skipped?: string; error?: string }> {
  const space = chatKey(spaceId, project);
  if (busy.has(space)) return { warmed: false, skipped: "busy" };
  if (!force && Date.now() - (warmedAt.get(space) ?? 0) < 3 * 60_000) return { warmed: false, skipped: "recent" };
  // the app may still be starting: wait for the engine instead of giving up
  for (let i = 0; i < 40 && !(engine.checked && engine.ready); i++) await new Promise((r) => setTimeout(r, 250));
  warmedAt.set(space, Date.now());
  try {
    await ensureCaptain(space);
    if (busy.has(space)) return { warmed: false, skipped: "busy" };
    const r = await request(agentOf(space), { type: "warm" }, 60_000);
    if (!r?.warmed) warmedAt.delete(space);
    return r;
  } catch (e) {
    // best effort: a cold first message is the only cost; try again next time
    warmedAt.delete(space);
    return { warmed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The instruction files the engine read at start (AGENTS.md / CLAUDE.md in the
 * folder and every folder above it). When one changes, the engine is restarted
 * on the same session before the next message, so the change applies at once
 * (one uncached request instead of a stale prompt for the rest of the chat).
 */
const sigOf = new Map<string, string>();
/** The main chat's tools: tool_search and web_search, with read / bash / web_fetch behind it (extensions/lazy-core.ts, extensions/web.ts). */
export async function mainTools(): Promise<string[]> {
  const all = await workerExtensions();
  const lazy = all.find((e) => e.endsWith("/lazy-core.ts"));
  // main looks things up on the web itself (web_search / web_fetch)
  const web = all.filter((e) => e.endsWith("/web.ts")).flatMap((e) => ["--extension", e]);
  // a copy of the extensions from before this file existed: keep the plain tools
  if (!lazy) return ["--exclude-tools", "edit,write", ...web];
  return ["--no-builtin-tools", "--extension", lazy, ...web, ...WORKER_TOOLS];
}
async function instructionSig(dir: string): Promise<string> {
  const dirs: string[] = [];
  for (let d = dir.replace(/\/$/, ""); d && d !== "/"; d = d.slice(0, d.lastIndexOf("/"))) dirs.push(d);
  dirs.push(`${engine.info.home}/.pi/agent`);
  const parts = await Promise.all(
    dirs.flatMap((d) => ["AGENTS.md", "CLAUDE.md"].map((f) => fsRead(`${d}/${f}`).then((r) => (r.text ? `${d}/${f}:${r.text}` : "")).catch(() => ""))),
  );
  return parts.filter(Boolean).join("\n");
}
const folderOf = (space: string) => expand(projectOf(space)?.folder || spaceById(sp(space)).folder || "~");

/** Restart an idle main engine whose instruction files changed since it started. */
/** What the chat was started with: its instruction files and its tools. */
const startSig = async (dir: string) => `${await instructionSig(dir)}\n${(await mainTools()).join(" ")}`;
export async function restartIfStale(space: string): Promise<boolean> {
  const agent = agentOf(space);
  if (!isAlive(agent) || !attached.has(space) || busy.has(space) || !sigOf.has(space)) return false;
  if ((await startSig(folderOf(space))) === sigOf.get(space)) return false;
  const gone = new Promise<void>((done) => {
    listen(agent, { event() {}, exit: () => done() });
    setTimeout(done, 3000);
  });
  await agentKill(agent);
  await gone;
  markDead(agent);
  attached.delete(space);
  errors.delete(space);
  sigOf.delete(space);
  return true;
}

async function ensureCaptain(space: string) {
  const agent = agentOf(space);
  if (isAlive(agent) && attached.has(space) && !(await restartIfStale(space))) return;
  if (!engine.checked || !engine.ready) throw new Error("엔진을 찾을 수 없습니다. 앱을 다시 설치하세요.");
  const acc = accountById(chooseAccount(sp(space), projectOf(space)?.name ?? "")) ?? state.accounts[0];
  accountOf.set(space, acc.id);
  listen(agent, {
    event(ev) {
      if (ev.type === "message_start" && ev.message?.role === "assistant") {
        texts.set(space, "");
        const g = genOf.get(space) ?? { ms: 0 };
        g.at = Date.now();
        genOf.set(space, g);
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        // the finished message is the source of truth, not the deltas added up
        const parts = Array.isArray(ev.message.content) ? ev.message.content : [];
        const full = parts.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("");
        if (full) texts.set(space, full);
        const g = genOf.get(space);
        if (g?.at) {
          g.ms += Date.now() - g.at;
          g.at = undefined;
        }
      }
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const t = (texts.get(space) ?? "") + ev.assistantMessageEvent.delta;
        texts.set(space, t);
        setLive(agent, prose(t));
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error")
        errors.set(space, String(ev.message.errorMessage ?? "모델 오류"));
      if (ev.type === "agent_settled") settled.get(space)?.();
    },
    exit() {
      attached.delete(space);
      markDead(agent);
      const tail = stderrOf(agent).split("\n").filter(Boolean).pop();
      errors.set(space, tail ?? "요청 처리 세션이 종료됐습니다");
      settled.get(space)?.();
    },
  });
  const space0 = spaceById(sp(space));
  const proj = projectOf(space);
  const model = state.settings.captainModel || modelFor(acc.id);
  // A reload or restart soon after the last reply keeps the session: its prefix
  // is still in the provider cache. After a quiet spell it would be cold anyway,
  // so a fresh session with a text recap is cheaper.
  const lastAt = Math.max(0, ...state.captain.filter((m) => inChat(m, space) && m.from === "captain" && !m.pending && !m.error).map((m) => m.at));
  const resume = Date.now() - lastAt < IDLE_CLEAR_MS;
  const args = [
    "--session-dir",
    sessionDir(space),
    ...(resume ? ["--continue"] : []),
    // only tool_search is declared; read and bash load through it when needed
    ...(await mainTools()),
    // one cache key for every main session with this system prompt: a fresh
    // session's first call reads what the last one (or the warm-up) wrote
    "--shared-prompt-cache",
    // main delegates; the skills (≈8K tokens of descriptions) are for jobs
    "--no-skills",
    "--thinking",
    "low",
    // the same system prompt in every main chat (any space, any project): one
    // shared cached prefix per account. What differs per chat (space and project
    // rules) goes into the first message instead.
    ...[CAPTAIN_SYSTEM, instructions()].filter(Boolean).flatMap((p) => ["--append-system-prompt", p]),
    ...(model ? ["--model", model] : []),
  ];
  const cwd = expand(proj?.folder || space0.folder || "~");
  void startSig(cwd).then((x) => sigOf.set(space, x));
  await agentSpawn(agent, cwd, args, [...(await accountEnv(acc.id)), ["ONDRA_MAIN", "1"]]);
  markAlive(agent);
  attached.add(space);
  statsOf.delete(space);
  if (resume) {
    // the session still holds the conversation; job list and memory are re-sent once
    statsOf.set(space, await rawStats(agent).catch(() => undefined));
    sentOf.set(space, { recap: false });
    armIdleClear(space);
  } else {
    sentOf.set(space, { recap: true });
    void sessionsPrune(sessionDir(space)).catch(() => {});
  }
}

/** Throw the engine session away (the chat itself stays as text). Next message starts small. */
async function clearSession(space: string) {
  const agent = agentOf(space);
  if (busy.has(space) || !isAlive(agent)) return;
  try {
    await request(agent, { type: "new_session" }, 8000);
    statsOf.delete(space);
    sentOf.set(space, { recap: true });
    void sessionsPrune(sessionDir(space)).catch(() => {});
  } catch {
    /* next message will try again */
  }
}

/**
 * Start this chat over: messages gone, engine restarted on an empty session
 * (old session files pruned), then the cache is warmed for the first message.
 */
export async function resetMain(spaceId: SpaceId, project?: string) {
  const space = chatKey(spaceId, project);
  const agent = agentOf(space);
  // Kill and wait until its exit has come through: a late exit would mark the
  // new engine dead, and a spawn that ran first would be the one killed.
  if (isAlive(agent)) {
    const gone = new Promise<void>((done) => {
      listen(agent, { event() {}, exit: () => done() });
      setTimeout(done, 3000);
    });
    await agentKill(agent);
    await gone;
  }
  markDead(agent);
  attached.delete(space);
  busy.delete(space);
  queues.delete(space);
  followUps.delete(space);
  statsOf.delete(space);
  sentOf.delete(space);
  warmedAt.delete(space);
  clearTimeout(idleTimers.get(space));
  setState("captain", (l) => l.filter((m) => !inChat(m, space)));
  await ensureCaptain(space);
  await request(agent, { type: "new_session" }, 8000);
  sentOf.set(space, { recap: false });
  await sessionsPrune(sessionDir(space)).catch(() => {});
  await warmMain(spaceId, project);
}

function armIdleClear(space: string) {
  clearTimeout(idleTimers.get(space));
  idleTimers.set(space, setTimeout(() => void clearSession(space), IDLE_CLEAR_MS));
}

/**
 * What the captain needs to know right now. It goes in the message (the system
 * prompt never changes, so the whole session stays one cached prefix), and only
 * what changed since the last message: the session already holds the rest.
 * That keeps each request to a few hundred new tokens on top of a cached prefix.
 */
/** Only the fork lines that changed since the last message (the session already holds the rest). */
function forksBlock(now: string, before?: string): string {
  if (now === before) return "# Forks: unchanged since the last message";
  if (!before) return `# Forks (running work, as of now)\n${now}`;
  const key = (l: string) => (l.startsWith("- ") ? l.slice(2).split(" | ")[0] : l.split(":")[0]);
  const was = new Map(before.split("\n").map((l) => [key(l), l]));
  const is = new Map(now.split("\n").map((l) => [key(l), l]));
  const changed = [...is].filter(([k, l]) => was.get(k) !== l).map(([, l]) => l);
  const gone = [...was.keys()].filter((k) => !is.has(k) && k !== "(none)");
  return [
    "# Forks: changes since the last message (the rest are as before)",
    ...changed,
    ...(gone.length ? [`no longer listed: ${gone.join(", ")}`] : []),
  ].join("\n");
}

function context(space: string, text: string, cwd?: string, event?: Event): string {
  const sent = sentOf.get(space) ?? { recap: true };
  const mine = tasksIn(sp(space)).filter((t) => !pj(space) || t.project === pj(space));
  const tasks = mine.filter((t) => !t.parentId && !t.answer && (t.status !== "done" || (t.finishedAt ?? 0) > Date.now() - 86_400_000));
  const topics = [...new Set(mine.map((t) => t.topic))];
  const forks = [
    tasks.length ? tasks.map((t) => `- ${t.id} | ${t.status} | ${t.topic} | ${t.title} | ${t.worktree?.state === "open" ? `branch ${t.worktree.branch}` : t.cwd} | ${t.now}`).join("\n") : "(none)",
    `Topics: ${topics.join(", ") || "(none)"}`,
  ].join("\n");
  const space0 = spaceById(sp(space));
  const proj = projectOf(space);
  const rules = [spaceRules(space0), proj ? projectRules(proj) : ""].filter(Boolean).join("\n\n");
  const projects = projectsIn(sp(space)).map((p) => `- ${p.name}: ${p.folder}`).join("\n") || "(none)";
  // no always-on memory: a few pieces recalled for this message alone
  const folder = projectOf(space)?.folder;
  const here = applying(sp(space), folder ? expand(folder) : "", expand);
  const others = state.memory.filter((m) => isLive(m) && (m.scope !== "space" || m.space === sp(space)) && (m.scope !== "project" || !folder || here.includes(m)));
  const related = recall(others, text, { max: 3, budget: 500, folder: (m) => m.scope === "project" && here.includes(m) });
  const out: string[] = [];
  if (rules !== sent.rules) out.push(`# This chat${sent.rules ? " (updated)" : ""}\n${rules}`, "");
  if (projects !== sent.projects) out.push(`# Projects in this space${sent.projects ? " (updated)" : ""} (name: folder)\n${projects}`, "");
  out.push(forksBlock(forks, sent.forks));
  if (related.length) out.push("", "# Memory that may matter for this message", ...memoryLines(related));
  const skills = state.skills.filter((s) => s.enabled).map((s) => `- ${s.name}: ${s.description.slice(0, 140)}`).join("\n") || "(none)";
  if (skills !== sent.skills) out.push("", `# Skills jobs can use${sent.skills ? " (updated)" : ""}\n${skills}`);
  if (sent.recap) {
    const recent = state.captain
      .filter((m) => inChat(m, space) && !m.pending)
      .slice(-17, -1)
      .map((m) => (m.from === "me" ? `user: ${m.text}` : `you: ${[m.reply, ...(m.routes ?? []).map((r) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[fork ${r.taskId}]` : r.kind === "append" ? `[→ ${r.taskId}]` : r.kind === "stop" ? `[stopped ${r.taskId}]` : "[remembered]"))].filter(Boolean).join(" ")}`));
    if (recent.length) out.push("", "# Recent conversation (oldest first; the session was cleared, this is the text of it)", recent.map((r) => `- ${r!.slice(0, 400)}`).join("\n"));
  }
  if (cwd) out.push("", `# Folder the user selected for this request\n${cwd}`);
  if (event === "project")
    out.push(
      "",
      "# A project you handed work to has finished (not a user message)",
      text,
      "",
      "Tell the user what came out, short (the project's chat has the details), as an \"answer\". Don't redo it. Route a next step only if what the user asked still needs one.",
    );
  else if (event)
    out.push(
      "",
      "# A fork you started has ended (not a user message)",
      text,
      "",
      "Tell the user what came out, short and visual (blocks), as an \"answer\". Then keep going toward what the user wanted: if the next step is clear, route it now (new or append) instead of offering it. Anything it couldn't verify that can be verified (does it really run, do the events really go out) is the next step: route it. Ask only a real choice only the user can make (intent, taste, scope, cost, anything leaving this machine): one question, your recommendation first. Don't redo finished work.",
    );
  else out.push("", "# Message", text);
  sentOf.set(space, { forks, memory: "", skills, rules, projects, recap: false });
  return out.join("\n");
}

async function route(space: string, text: string, cwd?: string, event?: Event): Promise<{ reply: string; routes: Route[] }> {
  clearTimeout(idleTimers.get(space));
  await ensureCaptain(space);
  const agent = agentOf(space);
  texts.set(space, "");
  errors.delete(space);
  const done = new Promise<void>((resolve) => settled.set(space, resolve));
  genOf.set(space, { ms: 0 });
  const t0 = Date.now();
  try {
    await prepareQuery(text);
    await request(agent, { type: "prompt", message: context(space, text, cwd, event) });
    await done;
  } finally {
    setLive(agent, "");
  }
  const raw = texts.get(space) ?? "";
  const err = errors.get(space);
  if (err && !raw.trim()) throw new Error(err);
  void tidy(space, Date.now() - t0);

  const objs = readFences(raw, "route").items;
  const reply = String(objs.find((x: any) => typeof x?.reply === "string")?.reply ?? "").trim();
  // models sometimes write "type" for "kind"
  const parsed = objs
    .flatMap((x: any) => (Array.isArray(x?.routes) ? x.routes : x?.kind || x?.type ? [x] : []))
    .map((r: any) => (r && !r.kind && typeof r.type === "string" ? { ...r, kind: r.type } : r));
  const routes = await applyRoutes(space, parsed, text, cwd);
  if (!routes.length) {
    // nothing usable came back: whatever it said is the answer
    const loose = parsed.map((r: any) => (typeof r?.text === "string" ? r.text : "")).filter(Boolean).join("\n\n");
    const p = prose(raw) || loose;
    if (p) return { reply, routes: [{ kind: "answer", text: p, blocks: [] }] };
    if (reply) return { reply, routes: [] };
    throw new Error("응답이 비어 있어요");
  }
  return { reply, routes };
}

/** Record what the reply used; clear the session in the background when it got long, else when it goes quiet. */
async function tidy(space: string, ms?: number) {
  const agent = agentOf(space);
  try {
    const s = await request(agent, { type: "get_session_stats" }, 8000);
    const acc = accountOf.get(space)!;
    const before = statsOf.get(space) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    statsOf.set(space, await collectStats(agent, acc, before));
    await refreshLimits(acc, true);
    const used = turnUsage(before, statsOf.get(space), acc, genOf.get(space)?.ms, ms);
    if (used) {
      const last = [...state.captain].reverse().find((m) => inChat(m, space) && m.from === "captain");
      if (last && !last.usage) setState("captain", (m) => m.id === last.id, "usage", used);
    }
    const tokens = s?.contextUsage?.tokens ?? 0;
    if (tokens > MAX_SESSION_TOKENS) queueMicrotask(() => void clearSession(space));
    else armIdleClear(space);
  } catch {
    /* stats are best effort */
  }
}

const clampPriority = (p: unknown): Priority => (p === 0 || p === 1 || p === 2 || p === 3 ? p : 2);

/**
 * The project a new fork from the space chat belongs to: the one main named,
 * the one its folder is in, or the one the user's message or the task names
 * (by name or repo folder, "acme pc" → acme). New projects are made by
 * main with a folder; this only finds ones that exist.
 */
function existingProject(space: SpaceId, r: any, original: string) {
  const list = projectsIn(space);
  if (!list.length) return undefined;
  const named = typeof r.project === "string" ? r.project : typeof r.project?.name === "string" && !r.project.folder ? r.project.name : "";
  const low = (x: string) => x.toLowerCase().replace(/\s+/g, "");
  if (named) {
    const hit = list.find((p) => low(p.name) === low(named) || p.id === named || low(p.folder.split("/").pop() ?? "") === low(named));
    if (hit) return hit;
  }
  if (typeof r.cwd === "string" && r.cwd) {
    const id = projectFor(space, r.cwd);
    if (id) return list.find((p) => p.id === id);
  }
  const said = low(`${original} ${r.title ?? ""} ${r.task ?? ""} ${r.topic ?? ""}`);
  const hits = list.filter((p) => {
    const base = (p.folder.split("/").pop() ?? "").toLowerCase();
    return said.includes(low(p.name)) || (base.length > 3 && said.includes(base));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

async function applyRoutes(space: string, raw: any[], original: string, cwd?: string): Promise<Route[]> {
  const out: Route[] = [];
  const work = raw.filter((r) => r?.kind === "new" || r?.kind === "answer").length;
  // steps of one request name each other by "key"; "after" may also name a running job's id
  const byKey = new Map<string, string>();
  // work main gives a project goes through that project's chat
  const handed = new Map<string, string[]>();
  for (const r of raw) {
    if (r?.kind === "answer") {
      const text = String(r.text ?? "");
      const blocks = Array.isArray(r.blocks) ? (r.blocks as Block[]) : [];
      if (text.trim() || blocks.length) out.push({ kind: "answer", text, blocks });
    } else if (r?.kind === "ask" && typeof r.question === "string" && Array.isArray(r.options)) {
      // main's own question, as the same card a job's question gets
      const options = (r.options as unknown[])
        .slice(0, 4)
        .map((o: any, i) => (typeof o === "string" ? { id: `o${i}`, label: o } : { id: `o${i}`, label: String(o?.label ?? ""), note: o?.note ? String(o.note) : undefined }))
        .filter((o) => o.label.trim())
        .map((o, i) => ({ ...o, primary: i === 0 }));
      if (options.length) {
        const d: Decision = { id: uid("d"), taskId: `main:${space}`, at: Date.now(), question: r.question.trim(), options, context: Array.isArray(r.context) ? (r.context as Block[]) : [], kind: "ask" };
        setState("decisions", (list) => [...list.filter((x) => x.taskId !== d.taskId), d]);
        out.push({ kind: "ask", decisionId: d.id });
      }
    } else if (r?.kind === "stop" && taskById(r.taskId)) {
      // the user said stop: the job stops now (it can be resumed), it isn't asked to wind down
      pauseTask(r.taskId);
      out.push({ kind: "stop", taskId: r.taskId });
    } else if (r?.kind === "append" && taskById(r.taskId ?? r.workerId)) {
      const id = r.taskId ?? r.workerId;
      const message = String(r.message ?? "").trim();
      // main's word is for now, not for after the fork's current turn
      if (message) void tell(id, message, { now: true });
      out.push({ kind: "append", taskId: id, message });
    } else if (r?.kind === "new" && (r.task || r.title)) {
      let proj = projectOf(space) ?? existingProject(sp(space), r, original);
      // main starting something new: make its folder and project chat first
      if (!proj && r.project && typeof r.project.folder === "string" && r.project.folder.startsWith("/")) {
        // a project is the repo, never one of its branch/worktree folders
        const wt = r.project.folder.match(/^(.*)\/worktrees\/([^/]+)(?:\/|$)/);
        if (wt) r.project = { name: wt[2], folder: `${wt[1]}/projects/${wt[2]}` };
        const folder = await ensureDir(r.project.folder).catch(() => "");
        if (folder) proj = projectById(addProject(sp(space), folder, String(r.project.name ?? "") || undefined));
      }
      // work in a folder of this space with no project yet ("ondra 에 넣어줘"): that folder is the project
      if (!proj && !projectOf(space)) proj = projectForFolder(sp(space), typeof r.cwd === "string" && r.cwd ? r.cwd : cwd);
      const dir = proj && !projectOf(space) ? proj.folder : typeof r.cwd === "string" && r.cwd ? r.cwd : cwd || proj?.folder;
      const id = createTask({
        space: sp(space),
        title: String(r.title ?? "작업"),
        branch: typeof r.branch === "string" ? r.branch : undefined,
        topic: proj?.name ?? String(r.topic ?? "기타"),
        ask: String(r.task ?? r.title),
        cwd: dir,
        project: proj?.id,
        priority: clampPriority(r.priority),
        weight: r.weight === "heavy" ? "heavy" : "light",
        // one request → one task: show what the user typed, not the rewrite
        display: work === 1 ? original : undefined,
        isolate: isolateOf.get(space),
        after: (Array.isArray(r.after) ? r.after : [])
          .map((k: unknown) => byKey.get(String(k)) ?? (taskById(String(k)) ? String(k) : ""))
          .filter(Boolean),
      });
      if (r.key) byKey.set(String(r.key), id);
      out.push({ kind: "new", taskId: id });
      if (proj && !projectOf(space)) handed.set(proj.id, [...(handed.get(proj.id) ?? []), id]);
    } else if (r?.kind === "remember" && r.text && state.settings.learn) {
      const scope = r.scope === "global" || r.scope === "project" ? r.scope : "space";
      // project memory is filed by folder (that's how jobs find it)
      const folder = scope === "project" ? (typeof r.project === "string" && r.project.startsWith("/") ? r.project : projectOf(space)?.folder) : undefined;
      const id = addMemory(String(r.text), folder || scope !== "project" ? scope : "space", {
        space: sp(space),
        project: folder,
        kind: KINDS.some((k) => k.id === r.type) ? r.type : undefined,
        importance: r.pin === false ? undefined : 4,
        by: "user",
        replaces: typeof r.replaces === "string" ? r.replaces : undefined,
      });
      if (id) out.push({ kind: "remember", memoryId: id });
    }
  }
  for (const [projectId, ids] of handed) handDown(sp(space), projectId, original, ids);
  return out;
}

export function captainBusy(space: string) {
  return busy.has(space);
}

/**
 * Edit a message you sent to main (or ask again): it and everything after it in
 * this space go away, main's session goes back to just before it, and the new text
 * is sent. Jobs it already started keep running.
 */
export async function editMain(messageId: string, text: string) {
  const m = state.captain.find((x) => x.id === messageId);
  const space = m ? chatKey(m.space, m.project) : "";
  if (!m || m.from !== "me") return;
  // still answering: stop that answer first, then send the edit
  if (busy.has(space)) {
    await stopMain(space);
    for (let i = 0; i < 50 && busy.has(space); i++) await new Promise((r) => setTimeout(r, 100));
    if (busy.has(space)) return;
  }
  const list = state.captain.filter((x) => inChat(x, space));
  const later = new Set(list.slice(list.findIndex((x) => x.id === messageId)).map((x) => x.id));
  setState("captain", (all) => all.filter((x) => !later.has(x.id)));
  const agent = agentOf(space);
  if (isAlive(agent) && attached.has(space) && m.text) {
    const ok = await forkAt(agent, `# Message\n${m.text}`);
    // not in this session any more (it was cleared): start clean from the text instead
    if (!ok) await request(agent, { type: "new_session" }, 8000).catch(() => {});
    // forks and memory are re-sent, since the branch may predate them
    sentOf.set(space, { recap: !ok });
    statsOf.set(space, await rawStats(agent));
  }
  throwThought(text, m.space, { project: m.project });
}

/** Stop main's current reply. */
export async function stopMain(space: string) {
  const agent = agentOf(space);
  if (!isAlive(agent)) return;
  try {
    await request(agent, { type: "abort" }, 8000);
  } catch {
    /* already idle */
  }
}

onJobEnded(jobEnded);
