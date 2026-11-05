// Ondra hooks: shell commands the user set in Settings › 훅, run on engine events.
//   before_tool — before a tool runs. A non-zero exit blocks the call; stderr is the reason.
//   after_tool  — after a tool ran. A non-zero exit adds stderr to the result the model sees.
//   prompt      — when a request arrives. stdout is added to the request.
//   start       — when the job's engine starts.
//   stop        — when the agent has finished answering.
// The command gets the event as JSON on stdin and ONDRA_HOOK_EVENT / ONDRA_TOOL_NAME
// in its environment. Hooks are read from ONDRA_HOOKS_FILE (re-read when it changes).
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

type HookEvent = "before_tool" | "after_tool" | "prompt" | "start" | "stop";
interface Hook {
  id: string;
  event: HookEvent;
  /** tool names, as a regular expression ("edit|write"); empty or "*" = every tool */
  matcher?: string;
  command: string;
  enabled?: boolean;
}

const TIMEOUT_MS = 60_000;
const MAX_OUT = 8_000;

let cache: { mtime: number; hooks: Hook[] } = { mtime: -1, hooks: [] };
function hooks(): Hook[] {
  const file = process.env.ONDRA_HOOKS_FILE;
  if (!file) return [];
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime !== cache.mtime) {
      const list = JSON.parse(readFileSync(file, "utf8"));
      cache = { mtime, hooks: Array.isArray(list) ? list : [] };
    }
  } catch {
    cache = { mtime: -1, hooks: [] };
  }
  return cache.hooks.filter((h) => h && h.enabled !== false && typeof h.command === "string" && h.command.trim());
}

function matches(h: Hook, tool?: string): boolean {
  const m = (h.matcher ?? "").trim();
  if (!m || m === "*" || !tool) return true;
  try {
    return new RegExp(`^(?:${m})$`).test(tool);
  } catch {
    return tool.includes(m);
  }
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}
function run(command: string, cwd: string, payload: unknown, env: Record<string, string>, signal?: AbortSignal): Promise<Ran> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], signal });
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-MAX_OUT)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-MAX_OUT)));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 1, stdout, stderr: stderr || String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n").slice(0, MAX_OUT) : "";

export default function (pi: any) {
  const base = (event: HookEvent, cwd: string, tool?: string) => ({
    payload: { event, cwd, workerId: process.env.APP_WORKER_ID ?? null, tool: tool ?? null },
    env: { ONDRA_HOOK_EVENT: event, ONDRA_TOOL_NAME: tool ?? "" },
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const list = hooks().filter((h) => h.event === "before_tool" && matches(h, event.toolName));
    for (const h of list) {
      const b = base("before_tool", ctx.cwd, event.toolName);
      const r = await run(h.command, ctx.cwd, { ...b.payload, input: event.input ?? {} }, b.env, ctx.signal);
      if (r.code !== 0) return { block: true, reason: r.stderr || r.stdout || `훅이 막았어요 (${h.command.slice(0, 80)})` };
    }
    return undefined;
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const list = hooks().filter((h) => h.event === "after_tool" && matches(h, event.toolName));
    const notes: string[] = [];
    for (const h of list) {
      const b = base("after_tool", ctx.cwd, event.toolName);
      const r = await run(h.command, ctx.cwd, { ...b.payload, input: event.input ?? {}, isError: !!event.isError, output: textOf(event.content) }, b.env, ctx.signal);
      if (r.code !== 0 && (r.stderr || r.stdout)) notes.push(r.stderr || r.stdout);
    }
    if (!notes.length) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: `[hook]\n${notes.join("\n")}` }] };
  });

  pi.on("input", async (event: any, ctx: any) => {
    if (event.source === "extension") return { action: "continue" };
    const list = hooks().filter((h) => h.event === "prompt");
    const added: string[] = [];
    for (const h of list) {
      const b = base("prompt", ctx.cwd);
      const r = await run(h.command, ctx.cwd, { ...b.payload, prompt: event.text ?? "" }, b.env);
      if (r.code === 0 && r.stdout) added.push(r.stdout);
    }
    if (!added.length) return { action: "continue" };
    return { action: "transform", text: `${event.text ?? ""}\n\n${added.join("\n\n")}`, images: event.images };
  });

  // start and stop only report; they never hold the agent up
  pi.on("session_start", async (_event: any, ctx: any) => {
    for (const h of hooks().filter((x) => x.event === "start")) {
      const b = base("start", ctx.cwd);
      void run(h.command, ctx.cwd, b.payload, b.env);
    }
  });

  pi.on("agent_settled", async (event: any, ctx: any) => {
    for (const h of hooks().filter((x) => x.event === "stop")) {
      const b = base("stop", ctx.cwd);
      void run(h.command, ctx.cwd, { ...b.payload, aborted: !!event?.aborted }, b.env);
    }
  });
}
