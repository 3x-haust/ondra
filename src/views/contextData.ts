// What an agent's model receives, asked from the engine (`get_context`).
// A live agent answers itself; a stopped job or chat is rebuilt in a short-lived
// engine started with the same arguments (no session, so no conversation).
import { skillPaths } from "../engine/skillPick";
import { mainTools, restartIfStale } from "../engine/captain";
import { agentKill, agentSpawn, type Env, inTauri, workerEnv, workerExtensions } from "../lib/native";
import { clearStderr, engine, expand, isAlive, request } from "../engine/rpc";
import { accountEnv, offTools, workerTools } from "../engine/tasks";
import { CAPTAIN_SYSTEM, instructions, projectRules, relatedMemory, spaceRules, SUB_SYSTEM, TASK_SYSTEM, taskSystem } from "../engine/prompts";
import { applying, inSpace, isLive, recall } from "../engine/memory";
import { modelFor } from "../engine/models";
import { homeDir, spaceById, state, taskById } from "../state/store";
import type { Memory, SpaceId } from "../state/types";
import { t as tr } from "../i18n";

export interface SourceInfo {
  path: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
}
export interface CtxTool {
  name: string;
  description: string;
  active: boolean;
  exposure: string;
  namespace?: string;
  sourceInfo: SourceInfo;
  schemaTokens: number;
}
export interface CtxMessage {
  role: string;
  tokens: number;
  preview: string;
  toolName?: string;
  toolCalls?: string[];
  isError?: boolean;
}
export interface EngineContext {
  cwd: string;
  systemPrompt: string;
  systemPromptTokens: number;
  forced: boolean;
  sections: { name: string; text: string; tokens: number }[];
  appendSystemPrompt: { text: string; tokens: number }[];
  contextFiles: { path: string; content: string; tokens: number }[];
  skills: { name: string; description: string; path: string; modelInvocable: boolean; sourceInfo: SourceInfo }[];
  tools: CtxTool[];
  messages: CtxMessage[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** chars/4 with multi-byte text weighted, the way the engine estimates. */
export function estimate(text: string): number {
  let w = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x80) w += c >= 0x0800 ? 3 : 1;
  }
  return Math.ceil(w / 4);
}

let probeSeq = 0;
/** Start an engine with these arguments, ask for its context, stop it. */
async function probe(cwd: string, args: string[], env: Env): Promise<EngineContext> {
  if (!inTauri) return sample(args);
  const agent = `probe:${Date.now()}:${++probeSeq}`;
  await agentSpawn(agent, cwd, ["--no-session", ...args], env);
  try {
    return (await request(agent, { type: "get_context" }, 30_000)) as EngineContext;
  } finally {
    void agentKill(agent).finally(() => setTimeout(() => clearStderr(agent), 1000));
  }
}

/** The engine's own context if it runs (and knows `get_context`), else a probe. */
async function liveOr(agent: string, rebuild: () => Promise<EngineContext>): Promise<{ ctx: EngineContext; live: boolean }> {
  if (!inTauri) return { ctx: await rebuild(), live: true };
  if (isAlive(agent)) {
    try {
      return { ctx: (await request(agent, { type: "get_context" }, 10_000)) as EngineContext, live: true };
    } catch {
      /* an engine from before get_context: rebuild below */
    }
  }
  return { ctx: await rebuild(), live: false };
}

/** A labelled `--append-system-prompt` part Ondra passes. */
export interface Part {
  title: string;
  text: string;
}
export interface Loaded {
  ctx: EngineContext;
  /** the engine is running now (messages are its real conversation) */
  live: boolean;
  /** what Ondra appends to the system prompt, labelled */
  parts: Part[];
  /** always-on memory (inside the system prompt) */
  pinned: Memory[];
  /** memory recalled into the first message (job) or the last message (chat) */
  recalled: Memory[];
  recalledWhere: string;
  /** the skills agents can load, as Settings lists them (filled by the sheet) */
  skills?: { name: string; description: string; path: string; own?: boolean }[];
}

const firstLine = (t: string) => t.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";

/** Name each appended part by matching it to what Ondra would send now. */
function label(texts: string[], known: Part[]): Part[] {
  return texts.map((text) => known.find((k) => k.text === text) ?? { title: firstLine(text).slice(0, 60) || tr("추가 지시"), text });
}

// ───────────── a job

async function jobArgs(id: string): Promise<{ cwd: string; args: string[]; env: Env }> {
  const t = taskById(id)!;
  const model = t.model || modelFor(t.accountId);
  const args = [
    ...taskSystem(t).flatMap((p) => ["--append-system-prompt", p]),
    "--no-skills",
    ...(model ? ["--model", model] : []),
    "--thinking",
    t.thinking || "high",
    ...(await workerExtensions()).flatMap((e) => ["--extension", e]),
    ...workerTools(),
    ...offTools(),
  ];
  const env: Env = [...(await workerEnv(id, t.space)), ...(await accountEnv(t.accountId)), ["ONDRA_PERMISSION", t.permission ?? "edits"], ["ONDRA_SKILL_PATHS", JSON.stringify(await skillPaths(t.space))]];
  return { cwd: expand(t.cwd || homeDir(t) || "~"), args, env };
}

function jobParts(id: string): Part[] {
  const t = taskById(id)!;
  const space = spaceById(t.space);
  const [role, ...rest] = taskSystem(t);
  return [
    { title: t.parentId ? tr("서브에이전트 규칙") : tr("작업 규칙"), text: role ?? (t.parentId ? SUB_SYSTEM : TASK_SYSTEM) },
    ...rest.map((text) => ({
      title: text === instructions() ? tr("공통 지침") : text === spaceRules(space) ? tr("워크스페이스 · {name}", { name: tr(space.label) }) : text.startsWith("# Memory") ? tr("메모리 (항상)") : firstLine(text),
      text,
    })),
  ];
}

export async function loadJob(id: string): Promise<Loaded> {
  const t = taskById(id);
  if (!t) throw new Error(tr("작업을 찾을 수 없어요"));
  const { ctx, live } = await liveOr(`t:${id}`, async () => {
    const a = await jobArgs(id);
    return probe(a.cwd, a.args, a.env).catch(async () => probe(engine.info.home, a.args, a.env));
  });
  return {
    ctx,
    live,
    parts: label(ctx.appendSystemPrompt.map((p) => p.text), jobParts(id)),
    pinned: [],
    recalled: relatedMemory(t),
    recalledWhere: "첫 요청에 함께 보냈어요",
  };
}

// ───────────── a chat (main of a space or a project)

const spOf = (key: string) => key.split("~")[0] as SpaceId;
const pjOf = (key: string) => key.split("~")[1] as string | undefined;
const projectOf = (key: string) => (pjOf(key) ? (state.projects ?? []).find((p) => p.id === pjOf(key) && p.space === spOf(key)) : undefined);

function chatParts(key: string): Part[] {
  const space = spaceById(spOf(key));
  const proj = projectOf(key);
  return [
    { title: tr("메인 규칙"), text: CAPTAIN_SYSTEM },
    { title: tr("공통 지침"), text: instructions() },
    { title: tr("워크스페이스 · {name}", { name: tr(space.label) }), text: spaceRules(space) },
    ...(proj ? [{ title: tr("프로젝트 · {name}", { name: proj.name }), text: projectRules(proj) }] : []),
  ].filter((p) => p.text);
}

export async function loadChat(key: string, accountId: string): Promise<Loaded> {
  const space = spaceById(spOf(key));
  const proj = projectOf(key);
  // an instruction file changed since the chat's engine started: restart it now
  // (next message would anyway), so what's shown is what the model gets
  await restartIfStale(key).catch(() => false);
  const { ctx, live } = await liveOr(`captain:${key}`, async () => {
    const model = state.settings.captainModel || modelFor(accountId);
    const args = [
      ...(await mainTools()),
      "--no-skills",
      "--thinking",
      "low",
      ...chatParts(key).flatMap((p) => ["--append-system-prompt", p.text]),
      ...(model ? ["--model", model] : []),
    ];
    return probe(expand(proj?.folder || space.folder || "~"), args, [...(await accountEnv(accountId)), ["ONDRA_MAIN", "1"], ["ONDRA_SKILL_PATHS", JSON.stringify(await skillPaths(space.id))]]);
  });
  // the chat sends its memory inside each message: the always-on pieces once,
  // and pieces recalled for that message alone
  const folder = proj?.folder;
  const here = applying(space.id, folder ? expand(folder) : "", expand);
  const others = state.memory.filter((m) => isLive(m) && inSpace(m, space.id) && (m.scope !== "project" || !folder || here.includes(m)));
  const last = [...state.captain].reverse().find((m) => m.from === "me" && m.space === space.id && (m.project ?? undefined) === pjOf(key));
  return {
    ctx,
    live,
    parts: label(ctx.appendSystemPrompt.map((p) => p.text), chatParts(key)),
    pinned: [],
    recalled: last?.text ? recall(others, last.text, { max: 3, budget: 500, folder: (m) => m.scope === "project" && here.includes(m) }) : [],
    recalledWhere: "마지막 메시지에 함께 보냈어요",
  };
}

// ───────────── what agents can use (Settings › Tools)

let toolsCache: EngineContext | null = null;
/** A fresh engine with what every job gets: extensions, skills, the first account. */
export async function loadWorkerTools(force = false): Promise<EngineContext> {
  if (toolsCache && !force) return toolsCache;
  const paths = await skillPaths(state.spaces[0]?.id ?? state.space);
  const args = ["--no-skills", ...(await workerExtensions()).flatMap((e) => ["--extension", e]), ...workerTools()];
  const acc = state.accounts[0];
  // the app's door too, so the memory tools register as they do in a job
  const env: Env = [...(await workerEnv("tools", state.spaces[0]?.id)), ...(acc ? await accountEnv(acc.id) : []), ["ONDRA_SKILL_PATHS", JSON.stringify(paths)]];
  toolsCache = await probe(expand(state.spaces[0]?.folder || "~"), args, env);
  return toolsCache;
}

// ───────────── outside the app (fixture): a believable sample

function sample(args: string[]): EngineContext {
  const appended = args.flatMap((a, i) => (args[i - 1] === "--append-system-prompt" ? [a] : []));
  const sec = (name: string, text: string) => ({ name, text: name === "preamble" ? text : `<${name}>\n${text}\n</${name}>`, tokens: estimate(text) });
  const agents = "# Repo rules\n- pnpm only\n- Conventional Commits\n- Never commit secrets\n".repeat(6);
  const sections = [
    sec("preamble", "You are a coding assistant running inside pi, a coding agent harness."),
    sec("tools", "- read: Read file contents\n- bash: Execute bash commands\n- edit: Make precise edits\n- write: Create or overwrite files\n\nAdditional tools may be available."),
    sec("rules", "- Use bash for file operations like ls, rg, find\n- Be concise in your responses\n- Show file paths clearly when working with files"),
    sec("docs", "Pi documentation (read only when the user asks about the harness itself)...".repeat(8)),
    sec("addendum", appended.join("\n\n")),
    sec("project_context", agents),
    sec("cwd", "/Users/me/app"),
  ].filter((s) => s.tokens);
  const tool = (name: string, description: string, path: string, schemaTokens: number, active = true, namespace?: string): CtxTool => ({
    name, description, active, exposure: "direct", namespace, schemaTokens,
    sourceInfo: { path, source: path.startsWith("builtin:") ? "builtin" : "cli", scope: "temporary", origin: "top-level" },
  });
  const msgs: CtxMessage[] = [
    { role: "user", tokens: 412, preview: "# Task: 로그인 리다이렉트 고치기 Project: app Folder: ~/app 로그인 후 원래 보던 페이지로 돌아가게 해 주세요." },
    { role: "assistant", tokens: 96, preview: "라우터부터 볼게요. [read] [bash]", toolCalls: ["read", "bash"] },
    { role: "toolResult", tokens: 2310, preview: "import { createRouter } from './router'; export function guard(to) { ...", toolName: "read" },
    { role: "toolResult", tokens: 640, preview: "src/router.ts src/auth/session.ts src/auth/oauth.ts", toolName: "bash" },
    { role: "assistant", tokens: 180, preview: "세션 복원을 기다리도록 바꿀게요. [edit]", toolCalls: ["edit"] },
    { role: "toolResult", tokens: 120, preview: "Successfully replaced text in src/router.ts.", toolName: "edit" },
    { role: "toolResult", tokens: 5120, preview: "PASS src/auth/session.test.ts (12 tests) ...", toolName: "bash" },
    { role: "assistant", tokens: 220, preview: "고쳤어요. 로그인 뒤 원래 페이지로 돌아가요." },
  ];
  return {
    cwd: "/Users/me/app",
    systemPrompt: sections.map((s) => s.text).join("\n\n"),
    systemPromptTokens: sections.reduce((n, s) => n + s.tokens, 0),
    forced: false,
    sections,
    appendSystemPrompt: appended.map((text) => ({ text, tokens: estimate(text) })),
    contextFiles: [{ path: "/Users/me/app/AGENTS.md", content: agents, tokens: estimate(agents) }],
    skills: [],
    tools: [
      tool("read", "Read the contents of a file. Supports text files and images.", "builtin:read", 164),
      tool("bash", "Execute a bash command in the current working directory.", "builtin:bash", 128),
      tool("edit", "Edit a single file using exact text replacement.", "builtin:edit", 287),
      tool("write", "Write content to a file. Creates the file if it doesn't exist.", "builtin:write", 100),
      tool("grep", "Search file contents for a pattern.", "builtin:grep", 252, false),
      tool("find", "Search for files by glob pattern.", "builtin:find", 147, false),
      tool("ls", "List directory contents.", "builtin:ls", 111, false),
      // the line Settings › Tools shows for it, in the app's language
      tool("device", tr("시뮬레이터와 에뮬레이터를 켜고, 화면을 찍고, 눌러요"), "/ondra/extensions/device.ts", 410),
      tool("memory", "Save or replace a memory piece the user's agents will see later.", "/ondra/extensions/memory.ts", 230),
      tool("mcp__docs__search", "Search the product documentation.", "builtin:mcp", 190, true, "mcp__docs"),
    ],
    messages: msgs,
    contextUsage: { tokens: 31_400, contextWindow: 272_000, percent: 11.5 },
  };
}
