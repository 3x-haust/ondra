import { createSignal } from "solid-js";
// The dispatcher (internally "captain"). Every request goes here first and
// comes back as routes: answer now, add to a running task, start new tasks, or
// remember. The chat is kept as text in the app; the engine session under it is
// disposable: it is cleared in the background (when the cache has gone cold or
// the session got long) and a new one starts from a short text recap.
import { logError, logInfo, logWarn } from "../lib/log";
import { track } from "../lib/telemetry";
import { isNetError, waitOnline } from "./net";
import { jobReport, keepJobResult, keepResult } from "./results";
import { dropOffers } from "./offers";
import { noteCall } from "../state/ctx";
import { prepareQuery } from "./vectors";
import { accountById, addProject, projectById, projectFor, projectsIn, projectsShown, repoHome, setState, spaceById, state, taskById, tasksIn, tasksShown, uid } from "../state/store";
import type { Block, CaptainMessage, Decision, Memory, Priority, Route, SpaceId, Task, Project } from "../state/types";
import { setLive } from "../state/ui";
import { agentKill, agentSpawn, agentStopCommand, bridgeEnv, ensureDir, fsRead, fsRepos, sessionsPrune, spaceEnv, workerExtensions } from "../lib/native";
import { prose, readFences } from "./fences";
import { shellArg } from "./commandKind";
import { readNotes } from "./notes";
import { addMemory, applying, inSpace, isLive, KINDS, memoryLines, namedSpaces, recall } from "./memory";
import { skillScope } from "./skillPick";
import { effortFor, failedModelIn, modelFor, nextModel } from "./models";
import { CAPTAIN_SYSTEM, instructions, projectRules, spaceRules } from "./prompts";
import { engine, expand, explain, isAlive, isModelError, listen, markAlive, markDead, request, stderrOf } from "./rpc";
import { canUseTools, isDirect } from "./connections";
import { accountEnv, collectStats, NO_ACCOUNT, spaceAccount, createTask, finished, forkAt, handOn, onJobEnded, rawStats, stopTask, turnUsage, WORKER_TOOLS } from "./tasks";
import { refreshLimits } from "../state/limits";
import { lastSaid, placeOf, relay, userParked } from "./jobs";

/** A chat is the main of a space ("work") or of one project in it ("work~pomo"). */
export const chatKey = (space: SpaceId, project?: string) => (project ? `${space}~${project}` : space);
// "sim3:home~proj" is a simulated chat (simulateMain): same space and project, its own agent and world
const base = (key: string) => key.replace(/^sim\d*:/, "");
const isSim = (key: string) => /^sim\d*:/.test(key);
const sp = (key: string) => base(key).split("~")[0] as SpaceId;
const pj = (key: string) => base(key).split("~")[1] as string | undefined;
const projectOf = (key: string) => (pj(key) ? (worlds.get(key)?.projects ?? state.projects ?? []).find((p) => p.id === pj(key) && p.space === sp(key)) : undefined);
/** this message belongs to this chat */
export const inChat = (m: CaptainMessage, key: string) => m.space === sp(key) && (m.project ?? undefined) === pj(key);
const sessionDir = (key: string) => `${engine.info.dataDir}/sessions/captain-${key.replace("~", "-").replace(":", "-")}`;
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
type SentHeader = { forks?: string; memory?: string; rules?: string; projects?: string; repos?: string; spaces?: string; model?: string; notes?: string; recap: boolean };
/** a project chat's notes, read before each message */
const notesOf = new Map<string, string>();
const sentOf = new Map<string, SentHeader>();
/** the git repos in each space's folder, looked up again after a few minutes */
const reposOf = new Map<SpaceId, { at: number; list: string[] }>();
async function refreshRepos(space: SpaceId) {
  const had = reposOf.get(space);
  if (had && Date.now() - had.at < 5 * 60_000) return;
  const root = spaceById(space).folder;
  // a space on the whole home folder: scanning it would walk ~/Library and the
  // folders macOS guards (and ask the user for access), so no list there
  const home = expand("~").replace(/\/+$/, "");
  const list = root && expand(root).replace(/\/+$/, "") !== home ? await fsRepos(expand(root)).catch(() => had?.list ?? []) : [];
  reposOf.set(space, { at: Date.now(), list });
}
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
/** chats past the size limit while busy: cleared as soon as they are idle */
const clearWanted = new Set<string>();

/**
 * What the session was last sent (rules, projects, repos, forks), kept
 * with it, so a restart that resumes the session sends only what changed.
 */
const SENT_KEY = (space: string) => `ondra.mainSent.${space}`;
function keepSent(space: string, s: SentHeader | undefined) {
  if (isSim(space)) return;
  try {
    if (s && !s.recap) localStorage.setItem(SENT_KEY(space), JSON.stringify(s));
    else localStorage.removeItem(SENT_KEY(space));
  } catch {
    /* storage is a convenience */
  }
}
function keptSent(space: string): SentHeader | undefined {
  try {
    const raw = localStorage.getItem(SENT_KEY(space));
    return raw ? { ...(JSON.parse(raw) as SentHeader), recap: false } : undefined;
  } catch {
    return undefined;
  }
}

export const captainAgent = agentOf;

/** what main reasons while it answers, per chat; cleared when the next answer starts */
const [thoughtsAll, setThoughtsAll] = createSignal<Record<string, string>>({});
export const mainThought = (key: string) => thoughtsAll()[key] ?? "";
export function addThought(key: string, delta: string) {
  if (!delta) return;
  setThoughtsAll((all) => ({ ...all, [key]: ((all[key] ?? "") + delta).slice(-40_000) }));
}

/** Send a request. Returns the id of the reply message to watch (empty if nothing was sent). */
export function throwThought(text: string, spaceId: SpaceId, opts: { cwd?: string; isolate?: boolean; project?: string } = {}): string {
  const t = text.trim();
  if (!t) return "";
  track("message_sent", { where: "main" });
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

export { userParked } from "./jobs";

/**
 * Main is the orchestrator: when a job it started ends, the result comes back to
 * main, which carries on (next job, or a question). The chat's row for the job
 * already shows what came out, so main adds only what needs the user.
 */
export function jobEnded(t: Task) {
  if (t.parentId || t.answer) return;
  // the chat that owns it gets the result: the project's chat when main handed the work down
  const owners = state.captain.filter((m) => m.space === t.space && (m.routes ?? []).some((r) => r.kind === "new" && r.taskId === t.id));
  const from = owners.find((m) => m.project) ?? owners[0];
  if (!from) return;
  // its own result, kept now: the chat's row for it opens this
  keepJobResult(t);
  const space = chatKey(t.space, from.project);
  const handed = from.project ? requestsOf(space).find((q) => q.jobs.has(t.id))?.ask : undefined;
  const n = (followUps.get(space) ?? 0) + 1;
  if (n > 6) return; // six automatic steps in a row: wait for the user
  followUps.set(space, n);
  const { said, blocks } = reportOf(t);
  const evidence = jobReport(t).blocks.flatMap((b) => (b.type === "evidence" ? b.items.map((i) => `${i.kind}: ${i.ref}`) : [])).slice(-8);
  const asked = userFollowUps(t.space, [t.id]);
  // main already sent this fork back since the user last spoke: once is enough
  const chat = state.captain.filter((m) => m.space === t.space && (m.project ?? undefined) === from.project);
  const sentBack = chat.slice(chat.map((m) => m.from).lastIndexOf("me") + 1).some((m) => m.after && (m.routes ?? []).some((r) => r.kind === "append" && r.taskId === t.id));
  const text = [
    handed?.via === "main" ? `Main handed this project the user's request: "${handed.text}". Finish it here; when nothing is left, the jobs' results go back to main on their own.` : "",
    `Fork ${t.id} "${t.title}" ${t.status === "done" ? "finished" : "failed"}.`,
    t.status === "done" ? `Summary: ${t.summary ?? ""}` : `Error: ${t.error ?? ""}`,
    t.unverified?.length ? `Not verified: ${t.unverified.join("; ")}` : "",
    evidence.length ? `Evidence: ${evidence.join(" | ")}` : "",
    said ? `What it reported:\n${said.slice(-3500)}` : "",
    blocks.length ? `Its result blocks:\n${blocks.join("\n")}` : "",
    asked.length ? `User follow-ups since then (answer every question in them, the 왜 first):\n${asked.map((q) => `- ${q}`).join("\n")}` : "",
    sentBack ? "You already sent this fork back once since the user last spoke. Stop here: no append to it until the user asks; say in one line what is still open, if anything." : "",
    userParked(t) ? "The user ended or stopped this work themselves. Its row shows what came out; say in one line what is left, if anything, then stop: no new fork to carry it on and no append to it until the user asks." : "",
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

/** What a job reported since it was last given work: its words and its result blocks in lines. */
function reportOf(t: Task): { said: string; blocks: string[] } {
  const { said, blocks } = jobReport(t);
  return { said, blocks: blocks.map(blockLine).filter(Boolean).slice(-10) };
}

/**
 * What the user said to these jobs after they started (main passed it on as an
 * append): their own words, so a "왜 …?" asked on the way gets its answer.
 */
function userFollowUps(spaceId: SpaceId, jobIds: string[]): string[] {
  const out: string[] = [];
  for (const chatMsgs of [...new Set(state.captain.filter((m) => m.space === spaceId).map((m) => m.project ?? ""))].map((p) => state.captain.filter((m) => m.space === spaceId && (m.project ?? "") === p))) {
    chatMsgs.forEach((m, i) => {
      if (m.from !== "captain" || m.after || !(m.routes ?? []).some((r) => r.kind === "append" && jobIds.includes(r.taskId))) return;
      const me = chatMsgs.slice(0, i).reverse().find((x) => x.from === "me");
      if (me?.text && !out.includes(me.text.trim())) out.push(me.text.trim().slice(0, 400));
    });
  }
  return out.slice(-5);
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
  return have ?? projectById(addProject(space, top), space);
}

/** A result block in a line main can retell (checklists, links, tables, numbers keep their content). */
function blockLine(b: Block): string {
  const x = b as unknown as { type: string; say?: string; [k: string]: any };
  const label = x.label ?? x.title ?? "";
  const say = x.say ? ` — ${x.say}` : "";
  const line = (() => {
    switch (x.type) {
      case "checklist":
        return `[${label || "checklist"}] ${(x.items ?? []).map((i: any) => `${i.done ? "✓" : "○"} ${i.label ?? i.text ?? ""}`).join(" · ")}`;
      case "evidence":
        return `[evidence] ${(x.items ?? []).map((i: any) => `${i.kind}: ${i.ref}${i.ok === false ? " (failed)" : ""}`).join(" · ")}`;
      case "link":
        return `[link] ${x.title ?? ""} ${x.ref ?? x.url ?? ""}`.trim();
      case "table":
        return `[table${label ? ` ${label}` : ""}] ${JSON.stringify({ columns: x.columns, rows: (x.rows ?? []).slice(0, 10) })}`;
      case "metric":
        return `[${label}] ${x.value}${x.delta ? ` (${x.delta})` : ""}`;
      case "compare":
        return `[${label}] ${x.before} → ${x.after}${x.unit ? ` ${x.unit}` : ""}`;
      case "tests":
        return `[tests] ${(x.suites ?? []).map((s: any) => `${s.name}: ${s.pass} pass${s.fail ? `, ${s.fail} fail` : ""}`).join(" · ")}${(x.failures ?? []).length ? ` · failures: ${(x.failures ?? []).map((f: any) => f.name).join(", ")}` : ""}`;
      case "options":
        return `[options${label ? ` ${label}` : ""}] ${(x.options ?? []).map((o: any) => `${o.chosen ? "★ " : ""}${o.name}${o.note ? ` (${o.note})` : ""}`).join(" · ")}${x.why ? ` — ${x.why}` : ""}`;
      case "timeline":
        return `[${label || "timeline"}] ${(x.items ?? []).map((i: any) => `${i.state === "done" ? "✓" : i.state === "now" ? "▶" : "○"} ${i.label}`).join(" · ")}`;
      case "text":
        return `[text] ${x.text ?? ""}`;
      case "shot":
        return `[picture] ${x.path ?? ""}${x.caption ? ` ${x.caption}` : ""}`;
      case "page":
        return `[page${label ? ` ${label}` : ""}] ${x.path ?? ""}`;
      default:
        return x.say ? `[${x.type}${label ? ` ${label}` : ""}]` : "";
    }
  })();
  return line ? `${line}${say}`.slice(0, 900) : "";
}

/**
 * A project chat's requests, each with what belongs to it: the replies made for
 * it (in order, or about one of its jobs ending) and the jobs those started.
 * A request handed down earlier keeps its own jobs, so a later one never hides it.
 */
export function requestsOf(space: string): { ask: CaptainMessage; msgs: CaptainMessage[]; jobs: Set<string> }[] {
  const reqs: { ask: CaptainMessage; msgs: CaptainMessage[]; jobs: Set<string> }[] = [];
  const owner = new Map<string, number>();
  for (const m of state.captain.filter((x) => inChat(x, space))) {
    if (m.from === "me") {
      reqs.push({ ask: m, msgs: [], jobs: new Set() });
      continue;
    }
    const at = m.after && owner.has(m.after) ? owner.get(m.after)! : reqs.length - 1;
    if (at < 0) continue;
    reqs[at].msgs.push(m);
    for (const r of m.routes ?? []) if (r.kind === "new") {
      reqs[at].jobs.add(r.taskId);
      owner.set(r.taskId, at);
    }
  }
  return reqs;
}

/**
 * Main → project → jobs, and back the same way: when main gives a project work,
 * the request lands in that project's chat, which owns the jobs and carries them
 * on. Once nothing it started for that request is still going, its last answer
 * goes back up to main.
 */
function handDown(spaceId: SpaceId, projectId: string, request: string, taskIds: string[]) {
  const ask: CaptainMessage = { id: uid("c"), at: Date.now(), space: spaceId, project: projectId, from: "me", via: "main", text: request };
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: spaceId, project: projectId, from: "captain", relay: true, routes: taskIds.map((taskId) => ({ kind: "new" as const, taskId })) };
  setState("captain", (list) => [...list.slice(-300), ask, reply]);
}

/** this chat message started the job or relayed to it (the chat shows it as the job's row) */
const handsTo = (m: CaptainMessage, id: string) => (m.routes ?? []).some((r) => (r.kind === "new" || r.kind === "append") && r.taskId === id);

export function reportUp(space: string) {
  const projectId = pj(space);
  if (!projectId) return;
  const reqs = requestsOf(space);
  const latest = reqs[reqs.length - 1];
  for (const q of reqs) {
    const last = q.ask;
    // a request main handed down, not reported yet (one from long ago stays as it is)
    if (last.via !== "main" || last.reported || Date.now() - last.at > 86_400_000) continue;
    if (!q.msgs.length || q.msgs.some((m) => m.pending)) continue;
    const jobs = [...q.jobs].map((id) => taskById(id)).filter((t): t is Task => !!t);
    if (jobs.some((t) => t.status !== "done" && t.status !== "failed")) continue;
    // a question waiting on the user stays in the project; it goes up once answered
    if (state.decisions.some((d) => (q === latest && d.taskId === `main:${space}`) || jobs.some((t) => t.id === d.taskId))) continue;
    setState("captain", (m) => m.id === last.id, "reported", true);
    const answers = q.msgs.flatMap((m) => (m.routes ?? []).flatMap((r) => (r.kind === "answer" && r.text.trim() ? [r.text.trim()] : []))).slice(-2).join("\n\n").slice(-3000);
    // what each job itself reported (its words and its result blocks), so main can tell the details itself
    const reported = jobs
      .map((t) => {
        const { said, blocks } = reportOf(t);
        const body = [said.slice(-2500), ...blocks].filter(Boolean).join("\n");
        return body ? `${t.title}:\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    const asked = userFollowUps(sp(space), jobs.map((t) => t.id));
    const proj = projectById(projectId);
    // a job the project started on its own (a next step) has no row in main's chat
    const rowInMain = (id: string) => state.captain.some((m) => m.space === sp(space) && !m.project && handsTo(m, id));
    const text = [
      `Project "${proj?.name ?? projectId}" finished the request you handed it: "${last.text}".`,
      jobs.length ? `Jobs: ${jobs.map((t) => `${t.id} "${t.title}" ${t.status}${t.summary ? ` — ${t.summary}` : ""}${rowInMain(t.id) ? "" : " (no row in your chat)"}`).join(" | ")}` : "",
      answers ? `What the project reported:\n${answers}` : "",
      reported ? `What the jobs reported:\n${reported}` : "",
      asked.length ? `User follow-ups since then (answer every question in them, the 왜 first):\n${asked.map((x) => `- ${x}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
    const main = chatKey(sp(space));
    const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space: sp(space), from: "captain", pending: true, up: projectId };
    setState("captain", (list) => [...list.slice(-300), reply]);
    queues.set(main, [...(queues.get(main) ?? []), { text, replyId: reply.id, event: "project" }]);
    void pump(main);
  }
}

/**
 * Every minute, every project chat: a request whose work is all done goes up to
 * main now, even when the moment that should have sent it was missed (a reload
 * in between, a reply that failed). Requests already reported are skipped.
 */
let sweeping: ReturnType<typeof setInterval> | undefined;
export function startRelaySweep() {
  if (sweeping) return;
  const sweep = () => {
    for (const p of state.projects ?? []) {
      const key = chatKey(p.space, p.id);
      if (!busy.has(key)) reportUp(key);
    }
  };
  setTimeout(sweep, 15_000);
  sweeping = setInterval(sweep, 60_000);
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
        keepResult(next.replyId);
        if (pj(space)) reportUp(space);
      } catch (e) {
        logError("main", `${space} answer failed: ${e instanceof Error ? e.message : String(e)}`);
        setState("captain", (m) => m.id === next.replyId, { pending: false, error: e instanceof Error ? e.message : String(e) });
        // the project couldn't answer: main still gets what the jobs reported
        if (pj(space)) reportUp(space);
      }
    }
  } finally {
    busy.delete(space);
    if (clearWanted.delete(space)) void clearSession(space);
  }
}

async function routeWithRetry(space: string, text: string, cwd?: string, event?: Event): Promise<{ reply: string; routes: Route[] }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await route(space, text, cwd, event);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // the connection dropped: wait for it to come back and send again
      if (attempt < 8 && isNetError(msg)) {
        await waitOnline(attempt + 1);
        continue;
      }
      if (attempt < 3 && isModelError(msg) && mainModel(accountOf.get(space)) === modelFor(accountOf.get(space) ?? "")) {
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
/** Main searches skills and jobs directly; read / bash / web_fetch load through tool_search. */
export async function mainTools(): Promise<string[]> {
  const all = await workerExtensions();
  const lazy = all.find((e) => e.endsWith("/lazy-core.ts"));
  const direct = all.filter((e) => e.endsWith("/web.ts") || e.endsWith("/skills.ts") || e.endsWith("/jobs.ts")).flatMap((e) => ["--extension", e]);
  // a copy of the extensions from before this file existed: keep the plain tools
  if (!lazy) return ["--exclude-tools", "edit,write", ...direct];
  return ["--no-builtin-tools", "--extension", lazy, ...direct, ...WORKER_TOOLS];
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
// main's own instructions count too: when they change, an idle main restarts on them
const promptSig = () => {
  let h = 0;
  for (let i = 0; i < CAPTAIN_SYSTEM.length; i++) h = (h * 31 + CAPTAIN_SYSTEM.charCodeAt(i)) | 0;
  return h.toString(36);
};
/** How hard main thinks: the level picked under its chat, else 낮음 (it answers and hands work on, fast). */
export const mainEffort = (accountId: string | undefined) => (accountId && effortFor(accountId, mainModel(accountId))) || "low";
/** The model main runs on: the account's, or the one set for main (not on a direct connection, whose models are its own). */
export function mainModel(accountId: string | undefined): string | undefined {
  const acc = state.accounts.find((a) => a.id === accountId);
  return (!isDirect(acc) && state.settings.captainModel) || (accountId ? modelFor(accountId) : undefined);
}
/** main's tool flags; a model without tool calling runs talk-only */
export async function mainToolArgs(accountId: string | undefined): Promise<string[]> {
  return canUseTools(accountId, mainModel(accountId)) ? mainTools() : ["--no-tools"];
}
/** The account main should run on now: the one picked for the space (a direct connection included), else the one it runs on. */
const wantedAccount = (space: string): string | undefined => {
  const pick = state.accountPick?.[sp(space)];
  if (pick && pick !== "auto" && accountById(pick)?.space === sp(space)) return pick;
  return accountOf.get(space);
};
// picking another account or model under the chat restarts main on it (auto routing alone doesn't: a warm cache stays)
const startSig = async (dir: string, skills: string, space: string) => {
  const id = wantedAccount(space);
  return `${id}\n${mainModel(id)}\n${mainEffort(id)}\n${await instructionSig(dir)}\n${(await mainToolArgs(id)).join(" ")}\n${promptSig()}\n${skills}`;
};
export async function restartIfStale(space: string): Promise<boolean> {
  if (busy.has(space)) return false;
  return restartStale(space, (await skillScope(sp(space))).signature);
}
async function restartStale(space: string, skills: string): Promise<boolean> {
  const agent = agentOf(space);
  if (!isAlive(agent) || !attached.has(space) || !sigOf.has(space)) return false;
  if ((await startSig(folderOf(space), skills, space)) === sigOf.get(space)) return false;
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

/**
 * Main answers and hands work on, on any model. A command of its own that runs past MAIN_CMD_MS is
 * stopped, and a turn that keeps calling tools (or keeps finding none) is brought back to the message:
 * a model can lose the request on the way (asked for a game, it grepped ~/.config for eleven minutes).
 */
const MAIN_CMD_MS = 30_000;
const MAIN_CALLS = 10;
type Turn = { text: string; calls: number; misses: number; nudged: boolean; cmds: Map<string, { command: string; at: number; stopped?: boolean }> };
const turnOf = new Map<string, Turn>();
const steerMain = (space: string, message: string) => void request(agentOf(space), { type: "steer", message }).catch(() => {});
function guardTurn(space: string, ev: any) {
  const t = turnOf.get(space);
  if (!t) return;
  const id = String(ev.toolCallId ?? "");
  const tool = String(ev.toolName ?? "");
  if (ev.type === "tool_execution_start") {
    t.calls++;
    if (tool === "bash" && typeof ev.args?.command === "string") t.cmds.set(id, { command: ev.args.command, at: Date.now() });
  } else {
    t.cmds.delete(id);
    const out = ev.result?.content?.find?.((c: any) => c?.type === "text")?.text;
    if (tool === "tool_search" && (ev.isError || /No matching tools|Repeated call/i.test(String(out ?? "")))) t.misses++;
  }
  if (t.nudged || (t.calls < MAIN_CALLS && t.misses < 2)) return;
  t.nudged = true;
  steerMain(
    space,
    `(Ondra) ${t.calls} tool calls on this message so far. The message you are answering: «${t.text.slice(0, 300)}». Send your route block now: answer what you know, and hand anything that needs more work to a fork (kind "new").`,
  );
}
/** an engine that has sent nothing for this long, with no command of its own running, is stuck: it is restarted */
const MAIN_SILENT_MS = 4 * 60_000;
const heardAt = new Map<string, number>();
function watchCommands(space: string) {
  const t = turnOf.get(space);
  if (!t) return;
  const now = Date.now();
  if (!t.cmds.size && now - (heardAt.get(space) ?? now) > MAIN_SILENT_MS) {
    turnOf.delete(space);
    const agent = agentOf(space);
    agentKill(agent);
    markDead(agent);
    errors.set(space, "메인이 4분 넘게 아무 응답이 없어서 멈췄어요. 다시 보내 주세요.");
    logWarn("main", `${space} engine silent for 4 minutes: restarted`);
    settled.get(space)?.();
    return;
  }
  for (const [id, c] of t.cmds) {
    if (c.stopped || now - c.at < MAIN_CMD_MS) continue;
    c.stopped = true;
    const others = [...t.cmds].filter(([k]) => k !== id).map(([, x]) => x.command);
    const arg = shellArg(c.command, others);
    if (!arg) continue;
    void agentStopCommand(agentOf(space), "bash", arg)
      .catch(() => 0)
      .then((n) => {
        if (!n || turnOf.get(space) !== t) return;
        const cmd = c.command.replace(/\s+/g, " ").trim();
        steerMain(space, `(Ondra) Stopped \`${cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}\` after ${MAIN_CMD_MS / 1000}s. You answer and hand work on: anything that runs long is a fork (kind "new"). The message: «${t.text.slice(0, 300)}».`);
      });
  }
}

/** main looking jobs up: the step shows on its pending reply, then stays above the reply */
const stepsOf = new Map<string, string>();
function noteStep(space: string, ev: any) {
  const id = `${space}:${ev.toolCallId ?? ""}`;
  // the end event carries no arguments: the finished line is worked out at the start
  if (ev.type === "tool_execution_start") {
    const done = mainStep(String(ev.toolName ?? ""), ev.args ?? {}, true);
    if (done) stepsOf.set(id, done);
  }
  const step = ev.type === "tool_execution_start" ? mainStep(String(ev.toolName ?? ""), ev.args ?? {}, false) : stepsOf.get(id);
  if (ev.type === "tool_execution_end") stepsOf.delete(id);
  if (!step) return;
  const m = [...state.captain].reverse().find((x) => inChat(x, space) && x.pending);
  if (!m) return;
  if (ev.type === "tool_execution_start") setState("captain", (x) => x.id === m.id, "step", step);
  else setState("captain", (x) => x.id === m.id, (x) => ({ step: undefined, steps: x.steps?.includes(step) ? x.steps : [...(x.steps ?? []), step].slice(-4) }));
}
const stepName = (s: unknown, n = 24) => {
  const x = String(s ?? "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};
/** "작업 찾는 중 · 리디자인" / "작업 찾음 · 리디자인", "작업 살펴봄 · 비로그인 먼저 쓰기" (noteText lines) */
export function mainStep(tool: string, args: any, done: boolean): string | undefined {
  if (tool === "jobs_search") {
    const q = stepName(args?.query);
    return q ? (done ? `작업 찾음 · ${q}` : `작업 찾는 중 · ${q}`) : done ? "작업 목록 봄" : "작업 목록 보는 중";
  }
  if (tool === "job_read") {
    const name = stepName(taskById(String(args?.id ?? ""))?.title ?? args?.id, 30);
    return done ? `작업 살펴봄 · ${name}` : `작업 살펴보는 중 · ${name}`;
  }
  return undefined;
}

async function ensureCaptain(space: string) {
  const agent = agentOf(space);
  const skills = await skillScope(sp(space));
  // Called before the next request; pump already owns the busy flag here.
  if (isAlive(agent) && attached.has(space) && !(await restartStale(space, skills.signature))) return;
  if (!engine.checked || !engine.ready) throw new Error("엔진을 찾을 수 없습니다. 앱을 다시 설치하세요.");
  const acc = spaceAccount(sp(space), projectOf(space)?.name ?? "");
  if (!acc) throw new Error(NO_ACCOUNT);
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
        noteCall(agent, ev.message.usage);
        const g = genOf.get(space);
        if (g?.at) {
          g.ms += Date.now() - g.at;
          g.at = undefined;
        }
      }
      // what it reasons, as it comes: shown under "생각하는 중" when opened
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "thinking_delta") addThought(space, String(ev.assistantMessageEvent.delta ?? ""));
      if (ev.type === "message_start" && ev.message?.role === "assistant" && (thoughtsAll()[space] ?? "").trim()) addThought(space, "\n\n");
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const t = (texts.get(space) ?? "") + ev.assistantMessageEvent.delta;
        texts.set(space, t);
        setLive(agent, prose(t));
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error")
        errors.set(space, String(ev.message.errorMessage ?? "모델 오류"));
      heardAt.set(space, Date.now());
      if (ev.type === "tool_execution_start" || ev.type === "tool_execution_end") (noteStep(space, ev), guardTurn(space, ev));
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
  const model = mainModel(acc.id);
  // A reload or restart soon after the last reply keeps the session: its prefix
  // is still in the provider cache. After a quiet spell it would be cold anyway,
  // so a fresh session with a text recap is cheaper.
  const lastAt = Math.max(0, ...state.captain.filter((m) => inChat(m, space) && m.from === "captain" && !m.pending && !m.error && !m.relay).map((m) => m.at));
  const resume = !isSim(space) && Date.now() - lastAt < IDLE_CLEAR_MS;
  const args = [
    "--session-dir",
    sessionDir(space),
    ...(resume ? ["--continue"] : []),
    // Search tools are declared; read and bash load when needed.
    ...(await mainToolArgs(acc.id)),
    // one cache key for every main session with this system prompt: a fresh
    // session's first call reads what the last one (or the warm-up) wrote
    "--shared-prompt-cache",
    // The search extension owns discovery, not Pi's prompt catalog.
    "--no-skills",
    // the level its chip under the chat shows (낮음 unless one was picked)
    "--thinking",
    mainEffort(acc.id),
    // the same system prompt in every main chat (any space, any project): one
    // shared cached prefix per account. What differs per chat (space and project
    // rules) goes into the first message instead.
    ...[CAPTAIN_SYSTEM, instructions()].filter(Boolean).flatMap((p) => ["--append-system-prompt", p]),
    ...(model ? ["--model", model] : []),
  ];
  // a simulated project's folder is made up: main runs in the space's folder then
  const cwd = expand((isSim(space) ? "" : proj?.folder) || space0.folder || "~");
  const signature = await startSig(cwd, skills.signature, space);
  // the bridge and main's worker id: its job tools (extensions/jobs.ts) reach this chat's space
  const door = isSim(space) ? [] : [...(await bridgeEnv()), ["APP_WORKER_ID", agent] as [string, string]];
  await agentSpawn(agent, cwd, args, [...(await accountEnv(acc.id)), ...(await spaceEnv(space0)), ["ONDRA_MAIN", "1"], ["ONDRA_SKILL_PATHS", JSON.stringify(skills.paths)], ...door]);
  logInfo("main", `${space} engine started (${model || "account model"})`);
  sigOf.set(space, signature);
  markAlive(agent);
  attached.add(space);
  statsOf.delete(space);
  if (resume) {
    // the session still holds the conversation; job list and memory are re-sent once
    statsOf.set(space, await rawStats(agent).catch(() => undefined));
    sentOf.set(space, keptSent(space) ?? { recap: false });
    armIdleClear(space);
  } else {
    sentOf.set(space, { recap: true });
    keepSent(space, undefined);
    if (!isSim(space)) void sessionsPrune(sessionDir(space)).catch(() => {});
  }
}

/** Throw the engine session away (the chat itself stays as text). Next message starts small. */
async function clearSession(space: string) {
  const agent = agentOf(space);
  if (!isAlive(agent)) return;
  if (busy.has(space)) {
    clearWanted.add(space);
    return;
  }
  try {
    await request(agent, { type: "new_session" }, 8000);
    statsOf.delete(space);
    sentOf.set(space, { recap: true });
    keepSent(space, undefined);
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
  keepSent(space, undefined);
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


/**
 * What main does when a fork it started ends. The chat shows each job main started or
 * relayed to as one row that updates by itself (title, the job's own one-line summary,
 * its screenshot; a click opens the full result), so main doesn't retell it.
 */
export const FORK_ENDED = [
  "The chat already shows this fork as one row that updates by itself: its title, its own one-line summary and its screenshot, and a click opens its full result. Don't retell it: no report of what came out, what changed or how it was checked, no screenshots or blocks.",
  'When it finished as asked and nothing needs the user, add nothing: {"reply":"","routes":[]}.',
  "Otherwise add only what needs them: one short line as an \"answer\" (no blocks; a 왜 answer may take two sentences), or a route:",
  "- it failed, or stopped short of what the user asked: its row already shows the error, so say plainly what is left or what the user can do about it. Keep the fork's own words on what isn't done or wasn't checked (\"CI 결과는 기다리지 않았어요\" stays that, never \"아직 안 나왔어요\").",
  "- the user's follow-ups ask something its summary doesn't answer: answer every such question, the 왜 first.",
  "- what the user asked for still isn't done and the next step is clear (the next step of what they asked, a part the fork left out): route it now instead of offering it. Its row shows it, so \"reply\" stays empty or one short line.",
  "- a real choice only the user can make (intent, taste, scope, cost, anything leaving this machine): one \"ask\", your recommendation first.",
  "\"Not verified\" items stay in its result, not chased: send the fork back only for a check the user's request itself depends on (their feature really runs) that it can do here, and never for checks, evals or polish the user didn't ask for, or to re-confirm what it already reported. Don't redo finished work.",
].join("\n");

/**
 * A project's own chat is about that project's work alone: under the fork's row it shows the fork's own
 * closing answer as the fork wrote it (words, blocks, screenshots), so it's there even if main never gets
 * to speak; main adds only what that answer doesn't say.
 */
export const FORK_REPORT = [
  "The chat shows this fork as a row and, right under it, the fork's own closing answer as it wrote it (its words, blocks and screenshots). Don't retell or summarise it: no second report of what came out, what changed or how it was checked.",
  'When it finished as asked and nothing needs the user, add nothing: {"reply":"","routes":[]}.',
  FORK_ENDED.split("\n").slice(2).join("\n"),
].join("\n");

/** What main does when a project it handed work to has finished: its jobs show as rows here too. */
export const PROJECT_ENDED = [
  "The chat already shows each of these jobs as one row that updates by itself (title, the job's own one-line summary, its screenshot; a click opens the full result), here and in the project's chat. Don't retell what came out and never point the user to the project's chat. A job marked \"no row in your chat\" (a next step the project started) is the exception: give its result in one line.",
  'When the request is done as asked and nothing needs the user, add nothing: {"reply":"","routes":[]}.',
  "Otherwise add only what needs them, in one short line (no blocks): a failure or what is still open (keep the jobs' own words on what isn't done or wasn't checked: \"CI 결과는 기다리지 않았어요\" stays that, never \"아직 안 나왔어요\"), an answer to every question in the user's follow-ups the summaries don't answer (the 왜 first), or a choice only the user can make (one \"ask\", your recommendation first).",
  "Don't redo it. Route a next step only if what the user asked still needs one.",
].join("\n");

function context(space: string, text: string, cwd?: string, event?: Event): string {
  const sent = sentOf.get(space) ?? { recap: true };
  const w = worlds.get(space);
  const mine = (w ? w.tasks : tasksShown(sp(space))).filter((t) => !pj(space) || t.project === pj(space));
  const tasks = mine.filter((t) => !t.parentId && !t.answer && (t.status !== "done" || (t.finishedAt ?? 0) > Date.now() - 86_400_000));
  const topics = [...new Set(mine.map((t) => t.topic))];
  const forks = [
    tasks.length
      ? tasks
          .map((t) => {
            // what it is on (running), what it asks (waiting), what it did (done), why it stopped (failed)
            const l = lastSaid(t, w?.decisions ?? state.decisions);
            const said = l.tag === "now" ? l.text : `${l.tag}: ${l.text}`;
            return `- ${t.id} | ${t.status} | ${t.topic} | ${t.title} | ${placeOf(t)} | ${String(said ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
          })
          .join("\n")
      : "(none)",
    `Topics: ${topics.join(", ") || "(none)"}`,
  ].join("\n");
  const space0 = spaceById(sp(space));
  const proj = projectOf(space);
  const rules = [spaceRules(space0), proj ? projectRules(proj) : ""].filter(Boolean).join("\n\n");
  // projects added from other Macs (Settings › 연결) are listed too: a job there runs on that Mac
  const projs = w ? w.projects : projectsShown(sp(space));
  const projects = projs.map((p) => `- ${p.name}: ${p.folder}${"hostName" in p && p.hostName ? ` (on ${p.hostName}, another Mac: its jobs run there)` : ""}`).join("\n") || "(none)";
  const taken = new Set(projs.map((p) => expand(p.folder).replace(/\/+$/, "")));
  const repos = ((w?.repos ?? reposOf.get(sp(space))?.list) ?? []).filter((r) => !taken.has(r)).map((r) => `- ${r}`).join("\n");
  // no always-on memory: a few pieces recalled for this message alone
  const folder = projectOf(space)?.folder;
  const here = applying(sp(space), folder ? expand(folder) : "", expand);
  // this space's pieces only (a project piece of another space never comes up here)
  const others = (w?.memory ?? state.memory).filter((m) => isLive(m) && inSpace(m, sp(space)) && (m.scope !== "project" || !folder || here.includes(m)));
  const related = recall(others, text, { max: 6, budget: 1200, folder: (m) => m.scope === "project" && here.includes(m) });
  const out: string[] = [];
  if (rules !== sent.rules) out.push(`# This chat${sent.rules ? " (updated)" : ""}\n${rules}`, "");
  if (projects !== sent.projects) out.push(`# Projects in this space${sent.projects ? " (updated)" : ""} (name: folder)\n${projects}`, "");
  if (repos && repos !== sent.repos) out.push(`# Repos in this space without a project${sent.repos ? " (updated)" : ""}\n${repos}`, "");
  out.push(forksBlock(forks, sent.forks));
  if (related.length) out.push("", "# Memory that may matter for this message", ...memoryLines(related));
  // spaces are separate; the user pointing at another one opens it for this message
  const others0 = state.spaces.filter((s) => s.id !== sp(space));
  const spacesLine = others0.map((s) => `- ${s.id}: ${s.label} (${s.folder})`).join("\n");
  if (spacesLine && spacesLine !== sent.spaces) out.push("", "# Other spaces (separate; open one only when the user asks, with \"reach\")", spacesLine);
  for (const id of event ? [] : namedSpaces(text, sp(space), state.spaces)) {
    const s = spaceById(id);
    const theirs = state.memory.filter((m) => isLive(m) && m.scope === "space" && m.space === id);
    const found = recall(theirs, text, { max: 4, budget: 700 });
    const jobs = tasksIn(id).filter((t) => !t.parentId && !t.answer).slice(-8).map((t) => `- ${t.title} [${t.status}]${t.project ? ` · ${projectById(t.project)?.name ?? ""}` : ""}`);
    const projs = projectsIn(id).map((p) => `- ${p.name}: ${p.folder}`);
    out.push("", `# The user pointed at the ${s.label} space (reach "${id}")`);
    if (found.length) out.push("Its memory that may matter:", ...memoryLines(found));
    if (projs.length) out.push("Its projects:", ...projs);
    if (jobs.length) out.push("Its recent jobs:", ...jobs);
  }
  if (sent.recap) {
    const recent = (w ? w.chat : state.captain)
      .filter((m) => inChat(m, space) && !m.pending)
      .slice(-17, -1)
      // a job's end main added nothing to still shows: its row said it
      .map((m) => (m.from === "me" ? `user: ${m.text}` : `you: ${[m.reply, ...(m.routes ?? []).map((r) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[fork ${r.taskId}]` : r.kind === "append" ? `[→ ${r.taskId}]` : r.kind === "stop" ? `[stopped ${r.taskId}]` : r.kind === "ask" ? `[asked: ${r.question ?? "a question"}]` : r.kind === "remember" ? "[remembered]" : ""))].filter(Boolean).join(" ") || (m.after ? `[fork ${m.after} ended]` : m.up ? `[project ${m.up} reported]` : "")}`));
    if (recent.length) out.push("", "# Recent conversation (oldest first; the session was cleared, this is the text of it)", recent.map((r) => `- ${r!.slice(0, 400)}`).join("\n"));
  }
  // which model this is, said when it changes: asked "너 무슨 모델이야?", main answers from this, not a guess
  const accId = accountOf.get(space);
  const runOn = mainModel(accId);
  const acct = accId ? accountById(accId) : undefined;
  const model = runOn
    ? `You run on the model ${runOn.split("/").slice(1).join("/") || runOn} (${runOn}), through ${acct?.label || "this account"}. Asked which model you are, say this.`
    : "";
  if (model && model !== sent.model) out.push("", `# You${sent.model ? " (changed)" : ""}`, model);
  // a project chat: where the project stands, as its jobs left it
  const notes = pj(space) ? (notesOf.get(space) ?? "") : "";
  if (notes && notes !== sent.notes) out.push("", `# Project notes${sent.notes ? " (updated)" : ""} (left by this project's jobs: where it stands, what is left)`, notes.slice(0, 8000));
  if (cwd) out.push("", `# Folder the user selected for this request\n${cwd}`);
  if (event === "project") out.push("", "# A project you handed work to has finished (not a user message)", text, "", PROJECT_ENDED);
  else if (event) out.push("", "# A fork you started has ended (not a user message)", text, "", pj(space) ? FORK_REPORT : FORK_ENDED);
  else out.push("", "# Message", text);
  sentOf.set(space, { forks, memory: "", rules, projects, repos, spaces: spacesLine, model: model || sent.model, notes: notes || sent.notes, recap: false });
  keepSent(space, sentOf.get(space));
  return out.join("\n");
}

async function route(space: string, text: string, cwd?: string, event?: Event): Promise<{ reply: string; routes: Route[] }> {
  clearTimeout(idleTimers.get(space));
  await ensureCaptain(space);
  const agent = agentOf(space);
  texts.set(space, "");
  setThoughtsAll((all) => ({ ...all, [space]: "" }));
  errors.delete(space);
  const done = new Promise<void>((resolve) => settled.set(space, resolve));
  genOf.set(space, { ms: 0 });
  const t0 = Date.now();
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    await Promise.all([prepareQuery(text), refreshRepos(sp(space)), pj(space) ? readNotes(pj(space)!).then((n) => void notesOf.set(space, n)) : undefined]);
    turnOf.set(space, { text: event ? "a job's end (see above)" : text, calls: 0, misses: 0, nudged: false, cmds: new Map() });
    heardAt.set(space, Date.now());
    watch = setInterval(() => watchCommands(space), 5_000);
    await request(agent, { type: "prompt", message: context(space, text, cwd, event) });
    await done;
  } finally {
    clearInterval(watch);
    turnOf.delete(space);
    setLive(agent, "");
  }
  const raw = texts.get(space) ?? "";
  const err = errors.get(space);
  if (err && !raw.trim()) throw new Error(err);
  if (!isSim(space)) void tidy(space, Date.now() - t0);

  const objs = readFences(raw, "route").items;
  const reply = dropOffers(String(objs.find((x: any) => typeof x?.reply === "string")?.reply ?? "").trim());
  // models sometimes write "type" for "kind"
  const parsed = objs
    .flatMap((x: any) => (Array.isArray(x?.routes) ? x.routes : x?.kind || x?.type ? [x] : []))
    .map((r: any) => (r && !r.kind && typeof r.type === "string" ? { ...r, kind: r.type } : r))
    .map((r: any) => (r?.kind === "answer" && typeof r.text === "string" ? { ...r, text: dropOffers(r.text) } : r));
  // a simulation only shows what main decided; nothing is started
  if (isSim(space)) return { reply, routes: parsed as Route[] };
  const routes = await applyRoutes(space, parsed, text, cwd, !event);
  // the reply said again as the answer ("안녕하세요, 뭐 도와드릴까요?" and "안녕하세요! 무엇을 도와드릴까요?"): said once
  const said = parsed.filter((r: any) => r?.kind === "answer" && typeof r.text === "string").map((r: any) => r.text as string);
  if (reply && said.some((a: string) => sameSaid(reply, a))) return { reply: "", routes };
  if (!routes.length) {
    // nothing usable came back: whatever it said is the answer
    const loose = parsed.map((r: any) => (typeof r?.text === "string" ? r.text : "")).filter(Boolean).join("\n\n");
    const p = strayProse(prose(raw), reply) || loose;
    if (p) return { reply, routes: [{ kind: "answer", text: p, blocks: [] }] };
    if (reply) return { reply, routes: [] };
    // a job's end that needs nothing from the user: its row in the chat already says it
    if (event) return { reply: "", routes: [] };
    throw new Error("응답이 비어 있어요");
  }
  return { reply, routes };
}

/** Two lines that say the same thing (a greeting or a short answer worded a little differently). */
export function sameSaid(a: string, b: string): boolean {
  const flat = (s: string) => s.replace(/[\s.,!?~"'`*_:;·…()\-]/g, "").toLowerCase();
  const x = flat(a);
  const y = flat(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const grams = (s: string) => {
    const g = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) g.set(s.slice(i, i + 2), (g.get(s.slice(i, i + 2)) ?? 0) + 1);
    return g;
  };
  const gx = grams(x);
  const gy = grams(y);
  let both = 0;
  for (const [k, n] of gx) both += Math.min(n, gy.get(k) ?? 0);
  return (2 * both) / (x.length - 1 + (y.length - 1)) >= 0.6;
}

/**
 * What a reply said outside its route, kept as its answer unless it is the route again: the reply
 * restated ("하이!" after {"reply":"하이!"}) or the route written out as fields ("kind: answer", "text: …"),
 * as some models do after the fence.
 */
export function strayProse(text: string, reply: string): string {
  const t = text.trim();
  if (!t) return "";
  const flat = (s: string) => s.replace(/[\s"'`*_\-:>]/g, "");
  if (reply && flat(t).includes(flat(reply))) return "";
  if (/^\s*[-*]?\s*(kind|text|reply|routes)\s*:/im.test(t) && /^\s*[-*]?\s*kind\s*:/im.test(t)) return "";
  return t;
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

/** A message without its attached files' list and without any file path in it. */
export function spokenPart(text: string): string {
  const i = text.startsWith("첨부한 파일:\n") ? 0 : text.indexOf("\n\n첨부한 파일:\n");
  return (i >= 0 ? text.slice(0, i) : text).replace(/(?:~|\/)[^\s"'`]*\/[^\s"'`]*/g, " ");
}

/**
 * The project a new fork from the space chat belongs to: the one main named,
 * the one its folder is in, or the one the user's message or the task names
 * (by name or repo folder, "acme pc" → acme). New projects are made by
 * main with a folder; this only finds ones that exist.
 */
function existingProject(space: SpaceId, r: any, original: string) {
  const list = projectsShown(space);
  if (!list.length) return undefined;
  const named = typeof r.project === "string" ? r.project : typeof r.project?.name === "string" && !r.project.folder ? r.project.name : "";
  const low = (x: string) => x.toLowerCase().replace(/\s+/g, "");
  // the user's words, without the files they attached: a screenshot saved by an app
  // ("…/Orbit/Captures/x.png") says where the file lives, not what the work is about
  const words = low(spokenPart(original));
  const onlyInPaths = (p: Project) => !words.includes(low(p.name)) && low(original).includes(low(p.name));
  if (named) {
    const hit = list.find((p) => low(p.name) === low(named) || p.id === named || low(p.folder.split("/").pop() ?? "") === low(named));
    if (hit && !onlyInPaths(hit)) return hit;
    if (hit) return undefined;
  }
  if (typeof r.cwd === "string" && r.cwd) {
    const id = projectFor(space, r.cwd);
    // a folder outside every project is its own work: words in the brief don't move it into one
    return id ? list.find((p) => p.id === id) : undefined;
  }
  // only what the user said and main's title: a brief names other things ("not an Ondra change")
  const said = low(`${spokenPart(original)} ${r.title ?? ""}`);
  const hits = list.filter((p) => {
    const base = (p.folder.split("/").pop() ?? "").toLowerCase();
    return said.includes(low(p.name)) || (base.length > 3 && said.includes(base));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

export async function applyRoutes(space: string, raw: any[], original: string, cwd?: string, fromUser = true): Promise<Route[]> {
  const out: Route[] = [];
  const work = raw.filter((r) => r?.kind === "new" || r?.kind === "answer").length;
  // steps of one request name each other by "key"; "after" may also name a running job's id
  const byKey = new Map<string, string>();
  // work main gives a project goes through that project's chat
  const handed = new Map<string, string[]>();
  // main only acts on this space's jobs and memory: an id from the other space is ignored
  const job = (id: unknown) => {
    const t = id == null ? undefined : taskById(String(id));
    return t?.space === sp(space) ? t : undefined;
  };
  const piece = (id: unknown) => {
    const m = typeof id === "string" ? state.memory.find((x) => x.id === id) : undefined;
    return m && (m.space ? m.space === sp(space) : m.scope === "global") ? m.id : undefined;
  };
  for (const r of raw) {
    // main reacting to a job's end never carries on work the user ended or stopped
    if (!fromUser && (r?.kind === "append" || r?.kind === "new") && userParked(job(r.kind === "new" ? r.from : (r.taskId ?? r.workerId)))) continue;
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
        out.push({ kind: "ask", decisionId: d.id, question: d.question });
      }
    } else if (r?.kind === "stop" && job(r.taskId)) {
      // the user said stop: the job stops now (it can be resumed), it isn't asked to wind down
      stopTask(r.taskId);
      out.push({ kind: "stop", taskId: r.taskId });
    } else if (r?.kind === "append" && job(r.taskId ?? r.workerId)) {
      // any job of this space, listed or found with jobs_search (a subagent, an older one, another project's)
      const target = job(r.taskId ?? r.workerId)!;
      const message = String(r.message ?? "").trim();
      if (!message) {
        out.push({ kind: "append", taskId: target.id, message });
        continue;
      }
      // main's word is for now, not for after the fork's current turn; a finished job is
      // closed: more on it is a new job with a fresh context, on its branch (jobs.ts relay)
      const sent = relay(target, message, {
        by: "main",
        now: true,
        display: raw.filter((x) => x?.kind !== "remember").length === 1 && fromUser ? original : undefined,
        isolate: isolateOf.get(space),
      });
      out.push(sent.outcome === "continued" ? { kind: "new", taskId: sent.taskId } : { kind: "append", taskId: target.id, message });
    } else if (r?.kind === "new" && (r.task || r.title)) {
      // carrying on a job keeps its project; main naming a folder makes or finds that one, never a guess
      const before = job(r.from)?.project ? projectById(job(r.from)!.project!, sp(space)) : undefined;
      const making = !!r.project && typeof r.project === "object" && typeof r.project.folder === "string";
      let proj = projectOf(space) ?? before ?? (making ? undefined : existingProject(sp(space), r, original));
      // main starting something new: make its folder and project chat first
      if (!proj && r.project && typeof r.project.folder === "string" && r.project.folder.startsWith("/")) {
        // a project is the repo, never one of its branch/worktree folders
        const wt = r.project.folder.match(/^(.*)\/worktrees\/([^/]+)(?:\/|$)/);
        if (wt) r.project = { name: wt[2], folder: `${wt[1]}/projects/${wt[2]}` };
        const folder = await ensureDir(r.project.folder).catch(() => "");
        if (folder) proj = projectById(addProject(sp(space), folder, String(r.project.name ?? "") || undefined), sp(space));
      }
      // work in a folder of this space with no project yet ("ondra 에 넣어줘"): that folder is the project
      if (!proj && !projectOf(space)) proj = projectForFolder(sp(space), typeof r.cwd === "string" && r.cwd ? r.cwd : cwd);
      // the repo the user or the task names comes first; the project's folder is the fallback
      const named = typeof r.cwd === "string" && /^[/~]/.test(r.cwd) ? r.cwd : undefined;
      const dir = named ?? (proj && !projectOf(space) ? proj.folder : cwd || proj?.folder);
      // carrying on a job: a finished one hands over now; one still going wraps up first and this waits for it
      const from = job(r.from) && !job(r.from)!.parentId ? job(r.from) : undefined;
      const still = from && !finished(from) ? from.id : undefined;
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
        // another space only when the user asked: main's "reach", or the message pointing at it
        reach: [...new Set([...(Array.isArray(r.reach) ? r.reach.map(String) : []), ...(fromUser ? namedSpaces(original, sp(space), state.spaces) : [])])]
          .map((x) => state.spaces.find((s) => s.id === x || s.label === x)?.id)
          .filter((x): x is SpaceId => !!x && x !== sp(space)),
        after: [
          ...new Set([
            ...(Array.isArray(r.after) ? r.after : []).map((k: unknown) => byKey.get(String(k)) ?? job(k)?.id ?? "").filter(Boolean),
            ...(still ? [still] : []),
          ]),
        ],
        follows: from?.id,
      });
      if (still) handOn(still, id);
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
        replaces: piece(r.replaces),
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
    keepSent(space, undefined);
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

// ───────────────────────────── simulation (evals/main-sim.mjs)

/** A made-up world main decides in: its jobs, projects, repos, memory and chat. */
interface World {
  tasks: Task[];
  projects: { id: string; space: SpaceId; name: string; folder: string }[];
  repos?: string[];
  memory?: Memory[];
  chat: CaptainMessage[];
  decisions?: { taskId: string; question: string }[];
}
const worlds = new Map<string, World>();
let simSeq = 0;

export interface SimCase {
  space: SpaceId;
  /** the project chat it happens in (a project's name), else the space's main chat */
  project?: string;
  /** a waiting job's question goes in "question" */
  tasks?: (Partial<Task> & { id: string; title: string; status: Task["status"]; project?: string; question?: string })[];
  projects?: { name: string; folder: string }[];
  repos?: string[];
  /** pieces of memory (space scope); leave out to use the space's real memory */
  memory?: string[];
  /** what was said before, oldest first */
  chat?: { from: "me" | "captain"; text: string }[];
  /** the user's messages, or what main is told when a fork or a handed-down project ends */
  messages: (string | { event: Event; text: string })[];
}
export interface SimStep {
  text: string;
  reply: string;
  routes: any[];
  /** what main's message was sent with (for finding why it decided so) */
  context: string;
  ms: number;
  error?: string;
}

/**
 * Run main on made-up situations with the real prompt and model, without starting
 * anything: each message's routes come back, and new jobs / projects join the world
 * so later messages see them.
 */
export async function simulateMain(c: SimCase): Promise<SimStep[]> {
  const pid = (name: string) => `p-${name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-")}`;
  const now = Date.now();
  const w: World = {
    projects: (c.projects ?? []).map((p) => ({ id: pid(p.name), space: c.space, name: p.name, folder: p.folder })),
    repos: c.repos,
    memory: c.memory?.map((text, i) => ({ id: `m${i}`, text, scope: "space", space: c.space, createdAt: now, updatedAt: now, by: "user" }) as unknown as Memory),
    tasks: [],
    chat: [],
    decisions: (c.tasks ?? []).filter((t) => t.question).map((t) => ({ taskId: t.id, question: t.question! })),
  };
  const key = `sim${++simSeq}:${c.space}${c.project ? `~${pid(c.project)}` : ""}`;
  const projectId = c.project ? pid(c.project) : undefined;
  w.tasks = (c.tasks ?? []).map(
    (t) =>
      ({
        topic: t.project ?? "기타",
        cwd: spaceById(c.space).folder,
        now: t.status === "running" ? "작업 중" : "",
        createdAt: now - 3_600_000,
        finishedAt: t.status === "done" ? now - 600_000 : undefined,
        entries: [],
        legs: [],
        inbox: [],
        shells: [],
        ...t,
        space: c.space,
        project: t.project ? pid(t.project) : undefined,
      }) as unknown as Task,
  );
  w.chat = (c.chat ?? []).map((m, i) => ({ id: `c${i}`, at: now - 60_000 * (100 - i), space: c.space, project: projectId, from: m.from, text: m.from === "me" ? m.text : undefined, reply: m.from === "captain" ? m.text : undefined }) as unknown as CaptainMessage);
  worlds.set(key, w);
  const steps: SimStep[] = [];
  let n = 0;
  try {
    for (const m of c.messages) {
      const text = typeof m === "string" ? m : m.text;
      const event = typeof m === "string" ? undefined : m.event;
      const t0 = Date.now();
      const ctx = (() => {
        try {
          // the same text main gets (computed before sentOf moves on)
          const saved = sentOf.get(key);
          const s = context(key, text, undefined, event);
          if (saved) sentOf.set(key, saved);
          else sentOf.delete(key);
          return s;
        } catch {
          return "";
        }
      })();
      try {
        const r = await route(key, text, undefined, event);
        steps.push({ text, reply: r.reply, routes: r.routes, context: ctx, ms: Date.now() - t0 });
        // what main started becomes part of the world for the next message
        for (const x of r.routes as any[]) {
          if (x?.kind === "new") {
            let proj = typeof x.project === "string" ? w.projects.find((p) => p.name === x.project)?.id : undefined;
            if (x.project && typeof x.project === "object" && x.project.name) {
              proj = pid(String(x.project.name));
              if (!w.projects.some((p) => p.id === proj)) w.projects.push({ id: proj, space: c.space, name: String(x.project.name), folder: String(x.project.folder ?? "") });
            }
            w.tasks.push({ id: `sim-t${++n}`, space: c.space, title: String(x.title ?? "작업"), topic: String(x.topic ?? "기타"), status: "running", cwd: String(x.cwd || spaceById(c.space).folder), now: "시작 중", project: proj ?? projectId, createdAt: Date.now(), entries: [], legs: [], inbox: [], shells: [] } as unknown as Task);
          }
        }
        if (!event) w.chat.push({ id: `c-me-${steps.length}`, at: Date.now(), space: c.space, project: projectId, from: "me", text } as unknown as CaptainMessage);
      } catch (e) {
        steps.push({ text, reply: "", routes: [], context: ctx, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    const agent = agentOf(key);
    agentKill(agent);
    markDead(agent);
    attached.delete(key);
    worlds.delete(key);
    sentOf.delete(key);
    for (const m of [texts, errors, settled, accountOf, statsOf, genOf, idleTimers, sigOf]) m.delete(key);
  }
  return steps;
}

/**
 * A real message again, in the situation it was sent in: the jobs that existed then
 * (finished or still going at that moment), this space's projects and memory, and the
 * chat before it. Main decides again; nothing starts.
 */
export async function replayMain(messageId: string): Promise<SimStep[]> {
  const m = state.captain.find((x) => x.id === messageId);
  if (!m || m.from !== "me" || !m.text) return [];
  const space = (m.space ?? state.space) as SpaceId;
  const at = m.at;
  const projName = (id?: string) => (id ? projectById(id)?.name : undefined);
  const tasks = tasksIn(space)
    .filter((t) => !t.parentId && !t.answer && t.createdAt < at)
    .slice(-12)
    .map((t) => {
      const over = (t.finishedAt ?? Infinity) < at;
      return { ...JSON.parse(JSON.stringify(t)), entries: [], legs: [], shells: [], status: over ? (t.status === "failed" ? "failed" : "done") : "running", summary: over ? t.summary : undefined, now: over ? "" : t.now, project: projName(t.project) };
    });
  const chat = state.captain
    .filter((x) => x.space === space && (x.project ?? undefined) === (m.project ?? undefined) && x.at < at && !x.pending)
    .slice(-10)
    .map((x) => ({ from: x.from === "me" ? ("me" as const) : ("captain" as const), text: x.from === "me" ? String(x.text ?? "") : [x.reply, ...(x.routes ?? []).map((r: any) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[fork ${r.taskId ?? r.title}]` : ""))].filter(Boolean).join(" ") }));
  return simulateMain({
    space,
    project: projName(m.project),
    projects: projectsIn(space).map((p) => ({ name: p.name, folder: p.folder })),
    tasks,
    chat,
    messages: [m.text],
  });
}
