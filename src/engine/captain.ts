// The dispatcher (internally "captain"). Every request goes here first and
// comes back as routes: answer now, add to a running task, start new tasks, or
// remember. The chat is kept as text in the app; the engine session under it is
// disposable: it is cleared in the background (when the cache has gone cold or
// the session got long) and a new one starts from a short text recap.
import { prepareQuery } from "./vectors";
import { accountById, addProject, projectById, setState, spaceById, state, taskById, tasksIn, uid } from "../state/store";
import type { Block, CaptainMessage, Priority, Route, SpaceId, Task } from "../state/types";
import { setLive } from "../state/ui";
import { agentKill, agentSpawn, ensureDir, fsRead, sessionsPrune, workerExtensions } from "../lib/native";
import { prose, readFences } from "./fences";
import { addMemory, applying, isLive, KINDS, memoryLines, recall } from "./memory";
import { failedModelIn, modelFor, nextModel } from "./models";
import { CAPTAIN_SYSTEM, instructions, projectRules, spaceRules } from "./prompts";
import { engine, expand, explain, isAlive, isModelError, listen, markAlive, markDead, request, stderrOf } from "./rpc";
import { accountEnv, chooseAccount, collectStats, createTask, forkAt, onJobEnded, rawStats, tell, turnUsage, WORKER_TOOLS } from "./tasks";
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
const queues = new Map<string, { text: string; replyId: string; cwd?: string; isolate?: boolean; event?: boolean }[]>();
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
const sentOf = new Map<string, { forks?: string; memory?: string; skills?: string; recap: boolean }>();
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
  // the chat that started it gets the result (main can start a project's first job)
  const from = state.captain.find((m) => m.space === t.space && (m.routes ?? []).some((r) => r.kind === "new" && r.taskId === t.id));
  if (!from) return;
  const space = chatKey(t.space, from.project);
  const n = (followUps.get(space) ?? 0) + 1;
  if (n > 6) return; // six automatic steps in a row: wait for the user
  followUps.set(space, n);
  const lastUser = t.entries.map((e) => e.kind).lastIndexOf("user");
  const said = t.entries.slice(lastUser + 1).filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("\n\n").slice(-3500);
  const evidence = t.entries.filter((e) => e.kind === "block" && e.block.type === "evidence").flatMap((e) => (e.kind === "block" && e.block.type === "evidence" ? e.block.items.map((i) => `${i.kind}: ${i.ref}`) : []));
  const text = [
    `Fork ${t.id} "${t.title}" ${t.status === "done" ? "finished" : "failed"}.`,
    t.status === "done" ? `Summary: ${t.summary ?? ""}` : `Error: ${t.error ?? ""}`,
    t.unverified?.length ? `Not verified: ${t.unverified.join("; ")}` : "",
    evidence.length ? `Evidence: ${evidence.slice(0, 8).join(" | ")}` : "",
    said ? `What it reported:\n${said}` : "",
  ].filter(Boolean).join("\n");
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: t.space, project: from.project, from: "captain", pending: true, after: t.id };
  setState("captain", (list) => [...list.slice(-300), reply]);
  queues.set(space, [...(queues.get(space) ?? []), { text, replyId: reply.id, event: true }]);
  void pump(space);
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
      } catch (e) {
        setState("captain", (m) => m.id === next.replyId, { pending: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    busy.delete(space);
  }
}

async function routeWithRetry(space: string, text: string, cwd?: string, event?: boolean): Promise<{ reply: string; routes: Route[] }> {
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
/** The main chat's tools: tool_search, with read / bash behind it (extensions/main/lazy-core.ts). */
export async function mainTools(): Promise<string[]> {
  const lazy = (await workerExtensions()).find((e) => e.endsWith("/lazy-core.ts"));
  // a copy of the extensions from before this file existed: keep the plain tools
  if (!lazy) return ["--exclude-tools", "edit,write"];
  return ["--no-builtin-tools", "--extension", lazy, ...WORKER_TOOLS];
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
    ...[CAPTAIN_SYSTEM, instructions(), spaceRules(space0), proj ? projectRules(proj) : ""].filter(Boolean).flatMap((p) => ["--append-system-prompt", p]),
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
function context(space: string, text: string, cwd?: string, event?: boolean): string {
  const sent = sentOf.get(space) ?? { recap: true };
  const mine = tasksIn(sp(space)).filter((t) => !pj(space) || t.project === pj(space));
  const tasks = mine.filter((t) => !t.parentId && !t.answer && (t.status !== "done" || (t.finishedAt ?? 0) > Date.now() - 86_400_000));
  const topics = [...new Set(mine.map((t) => t.topic))];
  const forks = [
    tasks.length ? tasks.map((t) => `- ${t.id} | ${t.status} | ${t.topic} | ${t.title} | ${t.cwd} | ${t.now}`).join("\n") : "(none)",
    `Topics: ${topics.join(", ") || "(none)"}`,
  ].join("\n");
  // no always-on memory: a few pieces recalled for this message alone
  const folder = projectOf(space)?.folder;
  const here = applying(sp(space), folder ? expand(folder) : "", expand);
  const others = state.memory.filter((m) => isLive(m) && (m.scope !== "space" || m.space === sp(space)) && (m.scope !== "project" || !folder || here.includes(m)));
  const related = recall(others, text, { max: 3, budget: 500, folder: (m) => m.scope === "project" && here.includes(m) });
  const out: string[] = [];
  out.push(forks === sent.forks ? "# Forks: unchanged since the last message" : `# Forks (running work, as of now)\n${forks}`);
  if (related.length) out.push("", "# Memory that may matter for this message", ...memoryLines(related));
  const skills = state.skills.filter((s) => s.enabled).map((s) => `- ${s.name}: ${s.description.slice(0, 140)}`).join("\n") || "(none)";
  if (skills !== sent.skills) out.push("", `# Skills jobs can use${sent.skills ? " (updated)" : ""}\n${skills}`);
  if (sent.recap) {
    const recent = state.captain
      .filter((m) => inChat(m, space) && !m.pending)
      .slice(-17, -1)
      .map((m) => (m.from === "me" ? `user: ${m.text}` : `you: ${[m.reply, ...(m.routes ?? []).map((r) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[fork ${r.taskId}]` : r.kind === "append" ? `[→ ${r.taskId}]` : "[remembered]"))].filter(Boolean).join(" ")}`));
    if (recent.length) out.push("", "# Recent conversation (oldest first; the session was cleared, this is the text of it)", recent.map((r) => `- ${r!.slice(0, 400)}`).join("\n"));
  }
  if (cwd) out.push("", `# Folder the user selected for this request\n${cwd}`);
  if (event)
    out.push(
      "",
      "# A fork you started has ended (not a user message)",
      text,
      "",
      "Tell the user what came out, short and visual (blocks), as an \"answer\". Then keep going toward what the user wanted: if the next step is clear, route it now (new or append); if a real choice is needed, ask it in the answer. Don't redo finished work.",
    );
  else out.push("", "# Message", text);
  sentOf.set(space, { forks, memory: "", skills, recap: false });
  return out.join("\n");
}

async function route(space: string, text: string, cwd?: string, event?: boolean): Promise<{ reply: string; routes: Route[] }> {
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

async function applyRoutes(space: string, raw: any[], original: string, cwd?: string): Promise<Route[]> {
  const out: Route[] = [];
  const work = raw.filter((r) => r?.kind === "new" || r?.kind === "answer").length;
  // steps of one request name each other by "key"; "after" may also name a running job's id
  const byKey = new Map<string, string>();
  for (const r of raw) {
    if (r?.kind === "answer") {
      const text = String(r.text ?? "");
      const blocks = Array.isArray(r.blocks) ? (r.blocks as Block[]) : [];
      if (text.trim() || blocks.length) out.push({ kind: "answer", text, blocks });
    } else if (r?.kind === "append" && taskById(r.taskId ?? r.workerId)) {
      const id = r.taskId ?? r.workerId;
      const message = String(r.message ?? "").trim();
      if (message) void tell(id, message);
      out.push({ kind: "append", taskId: id, message });
    } else if (r?.kind === "new" && (r.task || r.title)) {
      let proj = projectOf(space);
      // main starting something new: make its folder and project chat first
      if (!proj && r.project && typeof r.project.folder === "string" && r.project.folder.startsWith("/")) {
        const folder = await ensureDir(r.project.folder).catch(() => "");
        if (folder) proj = projectById(addProject(sp(space), folder, String(r.project.name ?? "") || undefined));
      }
      const dir = proj && !projectOf(space) ? proj.folder : typeof r.cwd === "string" && r.cwd ? r.cwd : cwd || proj?.folder;
      const id = createTask({
        space: sp(space),
        title: String(r.title ?? "작업"),
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
