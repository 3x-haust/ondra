// Two ways to talk without disturbing the work (after 3xhaustPi's /btw and Side Chat):
//  • btw: a quick question about anything in Ondra. It sees a text picture of
//    every conversation (main chats, every job and sub-job, side chats; the one
//    on screen in most detail) and may read the full session logs, nothing else.
//    It answers once and leaves no trace in the conversation. One engine process
//    per question.
//  • side chat: a second, separate conversation per place (as btw). It can read files but
//    never change them, and knows nothing of the main conversation unless told.
//    Its messages are kept as text; the engine session under it is disposable.
import { createStore } from "solid-js/store";
import { projectById, setState, spaceById, state, taskById, uid } from "../state/store";
import { inChat } from "./captain";
import { view } from "../state/ui";
import type { BtwEntry, SideMessage, SpaceId, Task } from "../state/types";
import { agentKill, agentSpawn, spaceLogs } from "../lib/native";
import { prose } from "./fences";
import { modelFor } from "./models";
import { canUseTools } from "./connections";
import { engine, expand, explain, isAlive, listen, markAlive, markDead, request, stderrOf } from "./rpc";
import { accountEnv, NO_ACCOUNT, spaceAccount } from "./tasks";
import { t as tr } from "../i18n";

/** read-only tools, or none for a connection's model without tool calling */
const readTools = (accountId: string, model: string | undefined) => (canUseTools(accountId, model) ? ["--tools", "read,grep,find,ls"] : ["--no-tools"]);

// ───────────── btw

/** The space a btw / side scope belongs to: "main:<space>[~project]", "task:<id>", "side:<space>". */
function spaceOfScope(scope: string): SpaceId {
  const [kind, id = ""] = scope.split(/:(.*)/s);
  if (kind === "task") return (taskById(id)?.space ?? state.space) as SpaceId;
  return (id.split("~")[0] || state.space) as SpaceId;
}

/**
 * Each place keeps its own btws: main (per project) and every job ("main:<space>[~project]",
 * "task:<id>"). Which one each place's card shows (by id), or none; two panes side by side each
 * have theirs.
 */
const [shown, setShown] = createStore<Record<string, string | null>>({});
export const btwList = (scope: string) => (state.btws ?? []).filter((b) => b.scope === scope);
export const btwIndex = (scope: string) => {
  const i = btwList(scope).findIndex((b) => b.id === shown[scope]);
  return i < 0 ? null : i;
};
export const btw = (scope: string) => btwList(scope).find((b) => b.id === shown[scope]) ?? null;
const setBtwAt = (scope: string, i: number) => setShown(scope, btwList(scope)[i]?.id ?? null);
export const closeBtw = (scope: string) => setShown(scope, null);
/** "/btw" with nothing after it: the latest one here */
export function showBtw(scope: string, i = btwList(scope).length - 1) {
  const n = btwList(scope).length;
  if (!n) return false;
  setBtwAt(scope, Math.max(0, Math.min(n - 1, i)));
  return true;
}
const patch = (id: string, v: Partial<BtwEntry>) => setState("btws", (b) => b.id === id, v);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A short text picture of what the user is looking at. */
function observation(scope: string): string {
  const [kind, id] = scope.split(/:(.*)/s);
  if (kind === "main") {
    const space = id.split("~")[0] as SpaceId;
    const chat = state.captain
      .filter((m) => inChat(m, id) && !m.pending)
      .slice(-16)
      .map((m) => (m.from === "me" ? `user: ${clip(m.text ?? "", 500)}` : `main: ${clip([m.reply, ...(m.routes ?? []).map((r) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[새 일 ${taskById(r.taskId ?? "")?.title ?? ""}]` : ""))].filter(Boolean).join(" "), 700)}`))
      // main reacting to a job's end may add nothing
      .filter((l) => l !== "main: ");
    const jobs = state.tasks
      .filter((t) => t.space === space && !t.parentId && !t.answer && !t.archived)
      .slice(-20)
      .map((t) => `- ${t.title} | ${t.status} | ${clip(t.now || t.summary || "", 160)}`);
    return [`# Main conversation (${spaceById(space).label})`, ...chat, "", "# Jobs", ...(jobs.length ? jobs : ["(none)"])].join("\n");
  }
  const t = taskById(id);
  if (!t) return "(job not found)";
  const lines = t.entries.slice(-40).map((e) => {
    if (e.kind === "user") return `user: ${clip(e.text, 500)}`;
    if (e.kind === "text") return `job: ${clip(e.text, 700)}`;
    if (e.kind === "tool") return `[${e.tool.kind} ${clip(e.tool.target ?? "", 120)}${e.tool.ok === false ? " 실패" : ""}]`;
    if (e.kind === "note") return `(${clip(e.text, 200)})`;
    if (e.kind === "error") return `(error: ${clip(e.text, 200)})`;
    return "";
  });
  return [
    `# Job: ${t.title} (${t.status})`,
    `Request: ${clip(t.ask, 600)}`,
    `Folder: ${t.cwd}`,
    t.plan.length ? `Plan: ${t.plan.map((p) => `${p.state === "done" ? "✓" : p.state === "now" ? "→" : "·"} ${p.text}`).join(" / ")}` : "",
    t.now ? `Now: ${t.now}` : "",
    "",
    "# Recent conversation",
    ...lines.filter(Boolean),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const BUDGET = 60_000;

const userWords = (t: Task) =>
  t.entries.flatMap((e) => (e.kind === "user" && !e.text.startsWith("(Ondra") && e.text.trim() !== t.ask.trim() ? [clip(e.text.trim(), 300)] : []));

function jobBlock(t: Task, full: boolean): string {
  const last = [...t.entries].reverse().find((e) => e.kind === "text");
  const parent = t.parentId ? taskById(t.parentId) : undefined;
  const said = userWords(t).slice(full ? -8 : -3);
  return [
    `## ${t.title} [${t.status}] · id ${t.id} · ${spaceById(t.space)?.label ?? t.space}${t.topic ? ` / ${t.topic}` : ""}${parent ? ` · sub-job of "${parent.title}"` : ""}`,
    `when: ${new Date(t.createdAt).toLocaleString("ko-KR")}${t.finishedAt ? ` → ${new Date(t.finishedAt).toLocaleString("ko-KR")}` : ""}`,
    `asked: ${clip(t.ask, full ? 800 : 300)}`,
    ...said.map((m) => `user later: ${m}`),
    t.now && t.status === "running" ? `now: ${clip(t.now, 160)}` : "",
    t.summary ? `summary: ${clip(t.summary, 300)}` : "",
    last && last.kind === "text" ? `last said: ${clip(last.text, full ? 1500 : 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function chatLines(key: string, n: number): string[] {
  return state.captain
    .filter((m) => inChat(m, key) && !m.pending)
    .slice(-n)
    .map((m) =>
      m.from === "me"
        ? `user: ${clip(m.text ?? "", 500)}`
        : `main: ${clip([m.reply, ...(m.routes ?? []).map((r) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[새 일 ${taskById(r.taskId ?? "")?.title ?? ""}]` : ""))].filter(Boolean).join(" "), 700)}`,
    )
    // main reacting to a job's end may add nothing
    .filter((l) => l !== "main: ");
}

/**
 * Everything else in this space, newest first, cut to a budget: every chat with
 * main, every job and sub-job (title, ask, what the user added, how it ended), its
 * side chat. Spaces are separate workspaces: the other one is never in here.
 */
function everything(scope: string): string {
  const space = spaceOfScope(scope);
  const here = scope.startsWith("task:") ? scope.slice(5) : "";
  const chats = [...new Set(state.captain.filter((m) => m.space === space).map((m) => (m.project ? `${m.space}~${m.project}` : m.space)))].filter((k) => `main:${k}` !== scope);
  const out: string[] = [];
  let size = 0;
  const add = (block: string) => {
    if (size + block.length > BUDGET) return false;
    out.push(block);
    size += block.length;
    return true;
  };
  for (const k of chats) {
    const [sp, pj] = k.split("~");
    add([`# Main chat: ${spaceById(sp as SpaceId)?.label ?? sp}${pj ? ` / ${projectById(pj)?.name ?? pj}` : ""}`, ...chatLines(k, 10)].join("\n"));
  }
  const jobs = state.tasks.filter((t) => t.id !== here && t.space === space).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  const rest: string[] = [];
  out.push("# Jobs (newest first)");
  for (const t of jobs) if (!add(jobBlock(t, false))) rest.push(`- ${t.title} [${t.status}] · id ${t.id}`);
  if (rest.length) out.push("# Older jobs (titles only)", ...rest.slice(0, 200));
  const side = scope.startsWith("side:") ? [] : sideOf(space).filter((m) => !m.pending).slice(-8);
  if (side.length) add(["# Side chat", ...side.map((m) => `${m.from === "me" ? "user" : "side"}: ${clip(m.text, 400)}`)].join("\n"));
  return out.join("\n\n");
}

/** This space's logs only (a folder of links), refreshed each time; never the whole sessions folder. */
async function logsOf(space: SpaceId): Promise<string> {
  return spaceLogs(space, state.tasks.filter((t) => t.space === space).map((t) => t.id)).catch(() => "");
}

/** This space's account; never another space's (none: NO_ACCOUNT). */
function accountFor(space: SpaceId) {
  const a = spaceAccount(space);
  if (!a) throw new Error(tr(NO_ACCOUNT));
  return a;
}

/** What a btw question is sent with: the conversation on screen, everything else, where the full logs are. */
export function btwPrompt(scope: string, q: string, logs: string): string {
  return [
    "Answer a BTW question. It is a side question: keep it separate from the conversations below and change nothing.",
    "You know everything that happened in this space of Ondra: the conversation the user is looking at, every chat with main, every job and sub-job, and its side chat. The user's other space is a separate workspace you don't see; if asked about it, say it's in the other space.",
    logs
      ? `When the picture below isn't enough, read the full logs in this folder (${logs}): one folder per job named by its id, main chats in captain-<space>[-<project>], each a set of .jsonl files. Use grep to find things; don't read whole files. Read nothing else of Ondra's data.`
      : "Read nothing of Ondra's data folder.",
    "Answer in Korean, short and plain (a few lines). Name the job when the answer comes from one.",
    "",
    "# What the user is looking at",
    observation(scope),
    "",
    "# Everything else",
    everything(scope),
    "",
    `# Question\n${q}`,
  ].join("\n");
}

/** Ask a btw question. The answer streams into btw(); nothing is added anywhere. */
export async function askBtw(scope: string, question: string, files: string[] = []) {
  const q = question.trim() || (files.length ? "이거 봐줘" : "");
  if (!q) return;
  const att = files.length ? { files } : {};
  const space = (scope.startsWith("main:") ? scope.slice(5).split("~")[0] : taskById(scope.slice(5))?.space ?? state.space) as SpaceId;
  const cant = !engine.checked || !engine.ready ? tr("에이전트를 실행할 수 없어요") : !spaceAccount(space) ? tr(NO_ACCOUNT) : "";
  if (cant) {
    setState("btws", (l) => [...(l ?? []), { id: uid("q"), at: Date.now(), scope, question: q, ...att, answer: "", pending: false, error: cant }]);
    return void setBtwAt(scope, btwList(scope).length - 1);
  }
  const acc = accountFor(space);
  const agent = `btw:${uid("b")}`;
  const id = uid("q");
  setState("btws", (l) => [...(l ?? []).slice(-49), { id, at: Date.now(), scope, question: q, ...att, answer: "", pending: true }]);
  setBtwAt(scope, btwList(scope).length - 1);
  let text = "";
  let err = "";
  const done = new Promise<void>((resolve) =>
    listen(agent, {
      event(ev) {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          text += ev.assistantMessageEvent.delta;
          patch(id, { answer: text });
        }
        if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") err = String(ev.message.errorMessage ?? tr("모델 오류"));
        if (ev.type === "agent_settled") resolve();
      },
      exit() {
        markDead(agent);
        err ||= stderrOf(agent).split("\n").filter(Boolean).pop() ?? "";
        resolve();
      },
    }),
  );
  try {
    const model = modelFor(acc.id);
    const logs = await logsOf(space);
    await agentSpawn(
      agent,
      logs || expand(spaceById(space).folder || "~"),
      ["--no-session", ...readTools(acc.id, model), "--no-skills", "--thinking", "low", ...(model ? ["--model", model] : [])],
      await accountEnv(acc.id),
    );
    markAlive(agent);
    const shown = files.length
      ? `${q}\n\nThe user attached these; open each picture with the read tool and look at it before answering:\n${files.map((f) => `- ${f}`).join("\n")}`
      : q;
    await request(agent, { type: "prompt", message: btwPrompt(scope, shown, logs) });
    await done;
    patch(id, { answer: prose(text) || text, pending: false, error: !text.trim() ? explain(err || tr("응답이 비어 있어요")) : undefined });
  } catch (e) {
    patch(id, { pending: false, error: explain(e instanceof Error ? e.message : String(e)) });
  } finally {
    agentKill(agent);
    markDead(agent);
  }
}

/** What "send to Main / to the job" says: the btw question and the answer it got, so the work can act on both. */
export const btwForward = (question: string, answer: string) =>
  answer.trim() ? `${question}\n\n${tr("btw 답")}:\n${answer.trim()}` : question;

// ───────────── side chat
// One per place, as btw: main (per project) and every job ("main:<space>[~project]", "task:<id>").

/** the place on screen, for its side chat: the job open, else the main chat (of the project open) */
export function sideHere(): string {
  const v = view();
  if (v.name === "task" && taskById(v.id)) return `task:${v.id}`;
  const p = v.name === "main" && v.project ? projectById(v.project) : undefined;
  return `main:${p && p.space === state.space ? `${state.space}~${p.id}` : state.space}`;
}

/** the place a side message belongs to (older ones, kept per space, belong to its main chat) */
export const sideScope = (m: Pick<SideMessage, "scope" | "space">) => m.scope ?? `main:${m.space}`;
const sideAgent = (scope: string) => `side:${scope}`;
const sideBusy = new Set<string>();
const sideAttached = new Set<string>();
const sideText = new Map<string, string>();
const sideErr = new Map<string, string>();
const sideSettled = new Map<string, () => void>();
const sideRecap = new Map<string, boolean>();
/** a btw the user carried over: sent with their next side message */
const sideCarry = new Map<string, string>();
/** when the side chat last got the overview of everything (it changes as work goes on) */
const sideSeen = new Map<string, number>();
const SIDE_FRESH_MS = 3 * 60_000;

/** Carry a btw question and its answer into the side chat of the same place, to go on talking about it there. */
export function continueInSide(scope: string, question: string, answer: string) {
  const at = Date.now();
  const space = spaceOfScope(scope);
  setState("side", (list) => [
    ...(list ?? []).slice(-400),
    { id: uid("s"), space, scope, at, from: "me", text: question },
    { id: uid("s"), space, scope, at, from: "side", text: answer },
  ]);
  sideCarry.set(scope, `# A btw the user carried over to this chat
user: ${clip(question, 1000)}
answer: ${clip(answer, 4000)}`);
}

export const sideOf = (scope: string) => (state.side ?? []).filter((m) => sideScope(m) === scope);

/** what the side chat sits beside, in a line for its prompt */
function besideOf(scope: string): string {
  if (scope.startsWith("task:")) {
    const t = taskById(scope.slice(5));
    return t ? `the job ${t.id} "${t.title}"` : "a job";
  }
  const project = scope.slice(5).split("~")[1];
  return project ? `the main chat of the project "${projectById(project)?.name ?? project}"` : "the main chat";
}

async function ensureSide(scope: string) {
  const agent = sideAgent(scope);
  if (isAlive(agent) && sideAttached.has(scope)) return;
  const space = spaceOfScope(scope);
  const acc = accountFor(space);
  listen(agent, {
    event(ev) {
      if (ev.type === "message_start" && ev.message?.role === "assistant") sideText.set(scope, "");
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const t = (sideText.get(scope) ?? "") + ev.assistantMessageEvent.delta;
        sideText.set(scope, t);
        const last = sideOf(scope).slice(-1)[0];
        if (last?.pending) setState("side", (m) => m.id === last.id, "text", prose(t));
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") sideErr.set(scope, String(ev.message.errorMessage ?? tr("모델 오류")));
      if (ev.type === "agent_settled") sideSettled.get(scope)?.();
    },
    exit() {
      sideAttached.delete(scope);
      markDead(agent);
      sideErr.set(scope, stderrOf(agent).split("\n").filter(Boolean).pop() ?? tr("사이드 채팅이 끝났어요"));
      sideSettled.get(scope)?.();
    },
  });
  const model = modelFor(acc.id);
  const task = scope.startsWith("task:") ? taskById(scope.slice(5)) : undefined;
  await agentSpawn(
    agent,
    expand(task?.cwd || spaceById(space).folder || "~"),
    [
      "--no-session",
      ...readTools(acc.id, model),
      "--thinking",
      "low",
      "--append-system-prompt",
      `This is a Side Chat: a separate conversation next to the user's work, beside ${besideOf(scope)}; what is asked here is most likely about that. You may read files but never change them. With the user's messages comes an overview of everything going on in this space (every main chat, job and sub-job; the one this sits beside in most detail); the user's other space is a separate workspace you don't see. Each job's full log is in ${(await logsOf(space)) || "(not available)"}/<job id>/*.jsonl, read it when the overview isn't enough; read nothing else of Ondra's data. Answer in Korean, short and plain.`,
      ...(model ? ["--model", model] : []),
    ],
    await accountEnv(acc.id),
  );
  markAlive(agent);
  sideAttached.add(scope);
  sideRecap.set(scope, true);
}

/** Send a message to the side chat of a place (a main chat or a job). */
export async function sendSide(scope: string, text: string) {
  const t = text.trim();
  if (!t || sideBusy.has(scope)) return;
  const space = spaceOfScope(scope);
  const before = sideOf(scope).filter((m) => !m.pending && !m.error);
  const me: SideMessage = { id: uid("s"), space, scope, at: Date.now(), from: "me", text: t };
  const reply: SideMessage = { id: uid("s"), space, scope, at: Date.now(), from: "side", text: "", pending: true };
  setState("side", (list) => [...(list ?? []).slice(-400), me, reply]);
  sideBusy.add(scope);
  try {
    // new jobs and sessions since the side chat started show up in its log folder
    void logsOf(space);
    await ensureSide(scope);
    const agent = sideAgent(scope);
    sideText.set(scope, "");
    sideErr.delete(scope);
    const done = new Promise<void>((r) => sideSettled.set(scope, r));
    const parts: string[] = [];
    // what's going on everywhere, again when it may have moved on
    if (sideRecap.get(scope) || Date.now() - (sideSeen.get(scope) ?? 0) > SIDE_FRESH_MS) {
      parts.push(`# Everything going on (as of ${new Date().toLocaleTimeString("ko-KR")})`, everything(scope), "");
      sideSeen.set(scope, Date.now());
    }
    if (sideRecap.get(scope) && before.length) {
      const recap = before.slice(-12).map((m) => `${m.from === "me" ? "user" : "you"}: ${clip(m.text, 500)}`);
      parts.push("# Earlier in this side chat (oldest first)", recap.join("\n"), "");
    } else if (sideCarry.get(scope)) parts.push(sideCarry.get(scope)!, "");
    sideCarry.delete(scope);
    sideRecap.set(scope, false);
    const message = parts.length ? [...parts, "# Message", t].join("\n") : t;
    await request(agent, { type: "prompt", message });
    await done;
    const out = prose(sideText.get(scope) ?? "") || (sideText.get(scope) ?? "");
    const err = sideErr.get(scope);
    setState("side", (m) => m.id === reply.id, { text: out, pending: false, error: !out.trim() ? explain(err || tr("응답이 비어 있어요")) : undefined, at: Date.now() });
  } catch (e) {
    setState("side", (m) => m.id === reply.id, { pending: false, error: explain(e instanceof Error ? e.message : String(e)) });
  } finally {
    sideBusy.delete(scope);
  }
}

export const sideRunning = (scope: string) => sideOf(scope).some((m) => m.pending);

/** Start this place's side chat over (its text goes too). */
export function clearSide(scope: string) {
  setState("side", (list) => (list ?? []).filter((m) => sideScope(m) !== scope));
  sideCarry.delete(scope);
  sideSeen.delete(scope);
  agentKill(sideAgent(scope));
  markDead(sideAgent(scope));
  sideAttached.delete(scope);
}

/** One question, one answer, no tools, nothing kept (for small helper asks). */
export async function oneShot(space: SpaceId, cwd: string, prompt: string): Promise<string> {
  if (!engine.checked || !engine.ready) throw new Error(tr("에이전트를 실행할 수 없어요"));
  const acc = accountFor(space);
  const agent = `ask:${uid("a")}`;
  let text = "";
  let err = "";
  const done = new Promise<void>((resolve) =>
    listen(agent, {
      event(ev) {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") text += ev.assistantMessageEvent.delta;
        if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") err = String(ev.message.errorMessage ?? tr("모델 오류"));
        if (ev.type === "agent_settled") resolve();
      },
      exit() {
        markDead(agent);
        resolve();
      },
    }),
  );
  try {
    const model = modelFor(acc.id);
    await agentSpawn(agent, expand(cwd || "~"), ["--no-session", "--no-tools", "--no-skills", "--thinking", "low", ...(model ? ["--model", model] : [])], await accountEnv(acc.id));
    markAlive(agent);
    await request(agent, { type: "prompt", message: prompt });
    await done;
    if (!text.trim() && err) throw new Error(err);
    return text;
  } finally {
    agentKill(agent);
    markDead(agent);
  }
}
