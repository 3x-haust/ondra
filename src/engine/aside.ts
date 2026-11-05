// Two ways to talk without disturbing the work (after 3xhaustPi's /btw and Side Chat):
//  • btw: a quick question about what is on screen (main, or one job). It sees a
//    short text picture of that conversation, has no tools, answers once, and
//    leaves no trace in the conversation. One engine process per question.
//  • side chat: a second, separate conversation per space. It can read files but
//    never change them, and knows nothing of the main conversation unless told.
//    Its messages are kept as text; the engine session under it is disposable.
import { createSignal } from "solid-js";
import { accountById, projectById, setState, spaceById, state, taskById, uid } from "../state/store";
import { inChat } from "./captain";
import type { BtwEntry, SideMessage, SpaceId } from "../state/types";
import { agentKill, agentSpawn } from "../lib/native";
import { prose } from "./fences";
import { modelFor } from "./models";
import { engine, expand, explain, isAlive, listen, markAlive, markDead, request, stderrOf } from "./rpc";
import { accountEnv, chooseAccount } from "./tasks";

// ───────────── btw

/** which btw the card shows (index into state.btws), or none */
const [btwAt, setBtwAt] = createSignal<number | null>(null);
export const btwList = () => state.btws ?? [];
export const btwIndex = btwAt;
export const btw = () => {
  const i = btwAt();
  return i === null ? null : (btwList()[i] ?? null);
};
export const closeBtw = () => setBtwAt(null);
/** "/btw" with nothing after it: the latest one */
export function showBtw(i = btwList().length - 1) {
  if (!btwList().length) return false;
  setBtwAt(Math.max(0, Math.min(btwList().length - 1, i)));
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
      .map((m) => (m.from === "me" ? `user: ${clip(m.text ?? "", 500)}` : `main: ${clip([m.reply, ...(m.routes ?? []).map((r) => (r.kind === "answer" ? r.text : r.kind === "new" ? `[새 일 ${taskById(r.taskId ?? "")?.title ?? ""}]` : ""))].filter(Boolean).join(" "), 700)}`));
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

function accountFor(space: SpaceId) {
  return accountById(chooseAccount(space, "")) ?? state.accounts[0];
}

/** Ask a btw question. The answer streams into btw(); nothing is added anywhere. */
export async function askBtw(scope: string, question: string) {
  const q = question.trim();
  if (!q) return;
  if (!engine.checked || !engine.ready) {
    setState("btws", (l) => [...(l ?? []), { id: uid("q"), at: Date.now(), scope, question: q, answer: "", pending: false, error: "엔진을 찾을 수 없어요" }]);
    return void setBtwAt(btwList().length - 1);
  }
  const space = (scope.startsWith("main:") ? scope.slice(5).split("~")[0] : taskById(scope.slice(5))?.space ?? state.space) as SpaceId;
  const acc = accountFor(space);
  const agent = `btw:${uid("b")}`;
  const id = uid("q");
  setState("btws", (l) => [...(l ?? []).slice(-49), { id, at: Date.now(), scope, question: q, answer: "", pending: true }]);
  setBtwAt(btwList().length - 1);
  let text = "";
  let err = "";
  const done = new Promise<void>((resolve) =>
    listen(agent, {
      event(ev) {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          text += ev.assistantMessageEvent.delta;
          patch(id, { answer: text });
        }
        if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") err = String(ev.message.errorMessage ?? "모델 오류");
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
    const cwd = scope.startsWith("task:") ? taskById(scope.slice(5))?.cwd : projectById(scope.slice(5).split("~")[1])?.folder ?? spaceById(space).folder;
    await agentSpawn(
      agent,
      expand(cwd || "~"),
      ["--no-session", "--no-tools", "--no-skills", "--thinking", "low", ...(model ? ["--model", model] : [])],
      await accountEnv(acc.id),
    );
    markAlive(agent);
    await request(agent, {
      type: "prompt",
      message: [
        "Answer a BTW question about the conversation below. It is a side question: keep it separate from that conversation.",
        "Do not propose or perform file changes. Answer in Korean, short and plain (a few lines).",
        "",
        observation(scope),
        "",
        `# Question\n${q}`,
      ].join("\n"),
    });
    await done;
    patch(id, { answer: prose(text) || text, pending: false, error: !text.trim() ? explain(err || "답이 비어 있어요") : undefined });
  } catch (e) {
    patch(id, { pending: false, error: explain(e instanceof Error ? e.message : String(e)) });
  } finally {
    agentKill(agent);
    markDead(agent);
  }
}

// ───────────── side chat

const sideAgent = (space: SpaceId) => `side:${space}`;
const sideBusy = new Set<SpaceId>();
const sideAttached = new Set<SpaceId>();
const sideText = new Map<SpaceId, string>();
const sideErr = new Map<SpaceId, string>();
const sideSettled = new Map<SpaceId, () => void>();
const sideRecap = new Map<SpaceId, boolean>();

export const sideOf = (space: SpaceId) => (state.side ?? []).filter((m) => m.space === space);

async function ensureSide(space: SpaceId) {
  const agent = sideAgent(space);
  if (isAlive(agent) && sideAttached.has(space)) return;
  const acc = accountFor(space);
  listen(agent, {
    event(ev) {
      if (ev.type === "message_start" && ev.message?.role === "assistant") sideText.set(space, "");
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const t = (sideText.get(space) ?? "") + ev.assistantMessageEvent.delta;
        sideText.set(space, t);
        const last = sideOf(space).slice(-1)[0];
        if (last?.pending) setState("side", (m) => m.id === last.id, "text", prose(t));
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") sideErr.set(space, String(ev.message.errorMessage ?? "모델 오류"));
      if (ev.type === "agent_settled") sideSettled.get(space)?.();
    },
    exit() {
      sideAttached.delete(space);
      markDead(agent);
      sideErr.set(space, stderrOf(agent).split("\n").filter(Boolean).pop() ?? "사이드챗 세션이 끝났어요");
      sideSettled.get(space)?.();
    },
  });
  const model = modelFor(acc.id);
  await agentSpawn(
    agent,
    expand(spaceById(space).folder || "~"),
    [
      "--no-session",
      "--tools",
      "read,grep,find,ls",
      "--thinking",
      "low",
      "--append-system-prompt",
      "This is a Side Chat: a separate conversation next to the user's main work. You may read files but never change them, and you do not see the main conversation unless the user pastes it. Answer in Korean, short and plain.",
      ...(model ? ["--model", model] : []),
    ],
    await accountEnv(acc.id),
  );
  markAlive(agent);
  sideAttached.add(space);
  sideRecap.set(space, true);
}

/** Send a message to the side chat of a space. */
export async function sendSide(space: SpaceId, text: string) {
  const t = text.trim();
  if (!t || sideBusy.has(space)) return;
  const before = sideOf(space).filter((m) => !m.pending && !m.error);
  const me: SideMessage = { id: uid("s"), space, at: Date.now(), from: "me", text: t };
  const reply: SideMessage = { id: uid("s"), space, at: Date.now(), from: "side", text: "", pending: true };
  setState("side", (list) => [...(list ?? []).slice(-200), me, reply]);
  sideBusy.add(space);
  try {
    await ensureSide(space);
    const agent = sideAgent(space);
    sideText.set(space, "");
    sideErr.delete(space);
    const done = new Promise<void>((r) => sideSettled.set(space, r));
    let message = t;
    if (sideRecap.get(space) && before.length) {
      const recap = before.slice(-12).map((m) => `${m.from === "me" ? "user" : "you"}: ${clip(m.text, 500)}`);
      message = `# Earlier in this side chat (oldest first)\n${recap.join("\n")}\n\n# Message\n${t}`;
    }
    sideRecap.set(space, false);
    await request(agent, { type: "prompt", message });
    await done;
    const out = prose(sideText.get(space) ?? "") || (sideText.get(space) ?? "");
    const err = sideErr.get(space);
    setState("side", (m) => m.id === reply.id, { text: out, pending: false, error: !out.trim() ? explain(err || "답이 비어 있어요") : undefined, at: Date.now() });
  } catch (e) {
    setState("side", (m) => m.id === reply.id, { pending: false, error: explain(e instanceof Error ? e.message : String(e)) });
  } finally {
    sideBusy.delete(space);
  }
}

export const sideRunning = (space: SpaceId) => sideOf(space).some((m) => m.pending);

/** Start the side chat over (its text goes too). */
export function clearSide(space: SpaceId) {
  setState("side", (list) => (list ?? []).filter((m) => m.space !== space));
  agentKill(sideAgent(space));
  markDead(sideAgent(space));
  sideAttached.delete(space);
}

/** One question, one answer, no tools, nothing kept (for small helper asks). */
export async function oneShot(space: SpaceId, cwd: string, prompt: string): Promise<string> {
  if (!engine.checked || !engine.ready) throw new Error("엔진을 찾을 수 없어요");
  const acc = accountFor(space);
  const agent = `ask:${uid("a")}`;
  let text = "";
  let err = "";
  const done = new Promise<void>((resolve) =>
    listen(agent, {
      event(ev) {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") text += ev.assistantMessageEvent.delta;
        if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "error") err = String(ev.message.errorMessage ?? "모델 오류");
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
