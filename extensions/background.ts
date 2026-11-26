// Long commands in the background, for jobs, so nobody waits in sleep loops:
//   bash {run_in_background: true} → the command starts and the call returns at once with its id
//                                    and output file; a message comes when it ends
//   monitor {command, timeout}     → each stdout line of a watch command comes as a message, until
//                                    the command exits or its deadline (5 minutes, 30 at most)
//   bash_stop {id}                 → stops one of them
// A message that comes while a turn runs is steered into it. One that comes while the engine is
// idle is kept for the next turn. The status "background" tells Ondra what runs, what waits for a
// turn and how each backgrounded bash call ended (src/engine/tasks.ts: it wakes the job, and keeps
// a check's result to its real exit code). What runs here is below the engine: it stops with the
// engine and with the session (a new session after a handoff).
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { auditSecrets, redact, secretSource } from "./secrets";

export const STATUS_KEY = "background";
export const MONITOR_DEFAULT_S = 300;
export const MONITOR_MAX_S = 1800;
/** a burst of watch lines goes as one message: this long after the last line, or after the first */
const QUIET_MS = 1000;
const BURST_MS = 5000;
/** a watch that speaks more often than this is stopped: it would wake the job all the time */
const FLOOD_NOTICES = 8;
const FLOOD_MS = 60_000;
/** a message shows a burst's first and last lines; the rest is in the output file */
const HEAD_LINES = 10;
const TAIL_LINES = 10;
const NOTICE_LINES = 20;
const NOTICE_BYTES = 4000;
const TAIL_BYTES = 16_000;
/** how each backgrounded bash call ended, kept for Ondra: this many, newest */
const ENDED_KEEP = 20;
const ENDED_TAIL = 300;

type Kind = "bash" | "monitor";
export type End = { how: "exited"; code: number } | { how: "timed out" } | { how: "stopped" } | { how: "flooded" } | { how: "failed"; error: string };
export interface Status {
  running: number;
  queued: number;
  /** backgrounded bash commands still running */
  cmds: string[];
  /** tool call id → how it ended: its exit code (null: stopped, timed out or failed) and last output */
  ended: Record<string, { code: number | null; tail: string }>;
}
interface Item {
  id: string;
  kind: Kind;
  /** the bash call that started it */
  callId?: string;
  command: string;
  description?: string;
  file: string;
  started: number;
  end?: End;
  stop: AbortController;
  decoder: StringDecoder;
  /** the output's last bytes, for the message at its end */
  tail: string;
  /** a watch's stdout: the unfinished line, and the burst not yet sent (its first and last lines) */
  partial: string;
  head: string[];
  last: string[];
  count: number;
  flushAt?: ReturnType<typeof setTimeout>;
  burstAt?: number;
  deadline?: ReturnType<typeof setTimeout>;
  notices: number[];
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The last `n` lines of `text`, at most NOTICE_BYTES of them. */
export function lastLines(text: string, n = NOTICE_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  let out = lines.slice(-n).join("\n");
  if (out.length > NOTICE_BYTES) out = `…${out.slice(-NOTICE_BYTES)}`;
  return out;
}

/** Whole lines from a stream chunk, and the unfinished rest. */
export function splitLines(partial: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (partial + chunk).split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim()), rest };
}

/** A burst's message body: its first and last lines, with how many were left out between. */
export function burstBody(head: string[], last: string[], count: number, file: string): string {
  const skipped = count - head.length - last.length;
  const lines = skipped > 0 ? [...head, `… ${skipped} more lines (in ${file}) …`, ...last] : [...head, ...last];
  let body = lines.join("\n");
  if (body.length > NOTICE_BYTES) body = `${body.slice(0, NOTICE_BYTES / 2)}\n…\n${body.slice(-NOTICE_BYTES / 2)}`;
  return body;
}

const short = (cmd: string) => {
  const c = cmd.replace(/\s+/g, " ").trim();
  return c.length > 100 ? `${c.slice(0, 100)}…` : c;
};
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const text = (t: string) => ({ content: [{ type: "text", text: t }], details: undefined });

/** What the agent is told when one ends on its own. */
export function endNotice(it: Pick<Item, "id" | "kind" | "command" | "description" | "file" | "started" | "tail">, end: End, now = Date.now()): string {
  const took = duration(now - it.started);
  const what = it.kind === "monitor" ? `Monitor ${it.id}${it.description ? ` (${it.description})` : ""}` : `Background command ${it.id}`;
  const how =
    end.how === "exited"
      ? it.kind === "monitor" ? `ended: its command exited with code ${end.code} after ${took}` : `ended with exit code ${end.code} after ${took}`
      : end.how === "timed out"
        ? it.kind === "monitor" ? `reached its deadline after ${took} and was stopped; start it again if you still need to watch` : `was stopped by its timeout after ${took}`
        : end.how === "flooded"
          ? `was stopped after ${took}: it sent more than ${FLOOD_NOTICES} messages a minute. Start it again with a filter that prints only the lines that matter`
          : end.how === "failed" ? `could not run: ${end.error}` : `was stopped after ${took}`;
  // a watch's lines came as they appeared
  const tail = it.kind === "monitor" ? "" : lastLines(it.tail);
  return [
    `[background] ${what} ${how}.`,
    `Command: ${short(it.command)}`,
    `Output: ${it.file}${tail ? " (last lines below; read the file for the rest)" : it.kind === "monitor" ? "" : " (empty)"}`,
    ...(tail ? ["", tail] : []),
  ].join("\n");
}

export default function (pi: any) {
  // jobs only: the main chat has no turn for a message to wake
  if (process.env.ONDRA_MAIN === "1") return;
  const cwd = process.cwd();
  const dir = join(process.env.APP_SCRATCH_DIR || tmpdir(), "background");
  const items = new Map<string, Item>();
  const ended: Status["ended"] = {};
  // these messages pass no tool result, where secrets.ts hides values: hidden here the same way
  const secretsIn = secretSource(process.env);
  const hide = (s: string, what: string) => {
    const r = redact(s, secretsIn(cwd));
    if (r.hits.length) auditSecrets({ kind: "hidden", tool: what, names: r.hits });
    return r.text;
  };
  let ctx: any;
  let queued = 0;
  let shown = "";

  // the user's shell settings (shellPath, shellCommandPrefix), as the engine's own bash uses them
  let shell: { ops: any; base: any; prefix?: string } | undefined;
  const shellOf = () => {
    if (shell) return shell;
    const s = pi.getSettings?.() ?? {};
    const shellPath = typeof s.shellPath === "string" && s.shellPath ? s.shellPath : undefined;
    const prefix = typeof s.shellCommandPrefix === "string" && s.shellCommandPrefix ? s.shellCommandPrefix : undefined;
    shell = { ops: createLocalBashOperations({ shellPath }), base: createBashToolDefinition(cwd, { shellPath, commandPrefix: prefix }), prefix };
    return shell;
  };

  const running = () => [...items.values()].filter((i) => !i.end);
  const publish = () => {
    const live = running();
    const status: Status = { running: live.length, queued, cmds: live.filter((i) => i.kind === "bash").map((i) => short(i.command)), ended };
    const s = live.length || queued || Object.keys(ended).length ? JSON.stringify(status) : undefined;
    if ((s ?? "") === shown) return;
    shown = s ?? "";
    ctx?.ui?.setStatus?.(STATUS_KEY, s);
  };
  const tell = (content: string, details: Record<string, unknown>) => {
    // idle (or no turn seen yet): kept for the next turn, and Ondra wakes the job for it
    const idle = ctx?.isIdle?.() ?? true;
    pi.sendMessage({ customType: "background", content: hide(content, "background"), display: true, details }, { deliverAs: "steer" });
    if (idle) queued++;
  };

  const flush = (it: Item) => {
    clearTimeout(it.flushAt);
    it.flushAt = undefined;
    it.burstAt = undefined;
    if (!it.count) return;
    const body = burstBody(it.head, it.last, it.count, it.file);
    const n = it.count;
    it.head = [];
    it.last = [];
    it.count = 0;
    tell(`[background] Monitor ${it.id}${it.description ? ` (${it.description})` : ""}: ${n === 1 ? "new line" : `${n} new lines`}\n${body}`, { id: it.id, kind: it.kind, lines: n });
    const now = Date.now();
    it.notices = [...it.notices.filter((t) => now - t < FLOOD_MS), now];
    if (it.notices.length > FLOOD_NOTICES && !it.end) {
      finish(it, { how: "flooded" });
      it.stop.abort();
      return;
    }
    publish();
  };

  function finish(it: Item, end: End) {
    if (it.end) return;
    it.end = end;
    clearTimeout(it.deadline);
    if (it.callId) {
      ended[it.callId] = { code: end.how === "exited" ? end.code : null, tail: hide(it.tail.slice(-ENDED_TAIL), "background") };
      const keys = Object.keys(ended);
      for (const k of keys.slice(0, Math.max(0, keys.length - ENDED_KEEP))) delete ended[k];
    }
    if (it.kind === "monitor") {
      if (it.partial.trim()) take(it, [it.partial]);
      it.partial = "";
      flush(it);
    }
    // a stop the agent asked for is answered by bash_stop itself
    if (end.how !== "stopped") tell(endNotice(it, end), { id: it.id, kind: it.kind, end });
    publish();
  }

  const take = (it: Item, lines: string[]) => {
    for (const l of lines) {
      it.count++;
      if (it.head.length < HEAD_LINES) it.head.push(l);
      else {
        it.last.push(l);
        if (it.last.length > TAIL_LINES) it.last.shift();
      }
    }
  };

  const start = (kind: Kind, command: string, opts: { timeout?: number; description?: string; callId?: string }): Item => {
    const sh = shellOf();
    // the raw output can hold what notices hide: only this user reads it
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = `${kind === "monitor" ? "mon" : "bg"}_${randomBytes(3).toString("hex")}`;
    const file = join(dir, `${id}.log`);
    writeFileSync(file, "", { mode: 0o600 });
    const it: Item = { id, kind, callId: opts.callId, command, description: opts.description, file, started: Date.now(), stop: new AbortController(), decoder: new StringDecoder("utf8"), tail: "", partial: "", head: [], last: [], count: 0, notices: [] };
    items.set(id, it);
    // a watch's events are its stdout lines: its stderr goes to the file only
    const body = kind === "monitor" ? `{ ${command}\n} 2>>${quote(file)}` : command;
    const run = sh.prefix ? `${sh.prefix}\n${body}` : body;
    const onData = (data: Buffer) => {
      appendFileSync(file, data);
      const chunk = it.decoder.write(data);
      it.tail = (it.tail + chunk).slice(-TAIL_BYTES);
      if (kind !== "monitor" || it.end) return;
      const { lines, rest } = splitLines(it.partial, chunk);
      it.partial = rest.length > TAIL_BYTES ? rest.slice(-TAIL_BYTES) : rest;
      if (!lines.length) return;
      take(it, lines);
      it.burstAt ??= Date.now();
      clearTimeout(it.flushAt);
      it.flushAt = setTimeout(() => flush(it), Math.max(0, Math.min(QUIET_MS, it.burstAt + BURST_MS - Date.now())));
    };
    if (kind === "monitor") {
      const s = Math.min(Math.max(opts.timeout ?? MONITOR_DEFAULT_S, 1), MONITOR_MAX_S);
      it.deadline = setTimeout(() => {
        finish(it, { how: "timed out" });
        it.stop.abort();
      }, s * 1000);
    }
    sh.ops
      .exec(run, cwd, { onData, signal: it.stop.signal, timeout: kind === "bash" ? opts.timeout : undefined })
      .then(
        (r: { exitCode: number | null }) => finish(it, { how: "exited", code: r.exitCode ?? 1 }),
        (e: Error) => {
          const m = String(e?.message ?? e);
          finish(it, m === "aborted" ? { how: "stopped" } : m.startsWith("timeout:") ? { how: "timed out" } : { how: "failed", error: m });
        },
      );
    publish();
    return it;
  };

  pi.on("session_start", (_e: unknown, c: any) => {
    ctx = c;
    publish();
  });
  // a turn has begun: what was kept for it is in it now
  pi.on("agent_start", (_e: unknown, c: any) => {
    ctx = c;
    queued = 0;
    publish();
  });
  // the session ends (the engine stops, or a new session after a handoff): so does what runs here
  pi.on("session_shutdown", () => {
    for (const it of running()) {
      clearTimeout(it.flushAt);
      finish(it, { how: "stopped" });
      it.stop.abort();
    }
    queued = 0;
    publish();
  });

  const schema = createBashToolDefinition(cwd);
  pi.registerTool({
    ...schema,
    description: `${schema.description} Set run_in_background for a long command that ends (a build, a test run, a deploy): it returns at once with an id and an output file, you keep working, and a message comes when the command ends.`,
    parameters: Type.Object({
      ...schema.parameters.properties,
      run_in_background: Type.Optional(
        Type.Boolean({ description: "Run the command in the background and return at once. A message comes when it ends; read its output file meanwhile; stop it with bash_stop (through use). Never wait for it with sleep." }),
      ),
    }),
    async execute(callId: string, p: { command: string; timeout?: number; run_in_background?: boolean }, signal: AbortSignal | undefined, onUpdate: unknown, c: any) {
      ctx = c ?? ctx;
      if (!p.run_in_background) return shellOf().base.execute(callId, { command: p.command, timeout: p.timeout }, signal, onUpdate, c);
      const it = start("bash", p.command, { timeout: p.timeout, callId });
      const output = `Started in the background as ${it.id}. Output: ${it.file}\nA message comes when it ends: keep working, or end your turn if only waiting is left (the job stays open). Read the output file to look at it now, use monitor to react to lines as they come, use bash_stop {"id":"${it.id}"} to stop it.`;
      return { content: [{ type: "text", text: output }], details: { background: it.id }, structuredContent: { output, truncated: false, exit_code: 0, wall_time_seconds: 0 } };
    },
  });

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    exposure: "deferred",
    description: `Watch something in the background and react when it changes, without waiting in a loop: runs a command whose stdout lines are events, and each burst of new lines comes to you as a message while you keep working (or wakes you after your turn ended). Stderr only goes to its output file. It ends when the command exits or at its deadline (timeout, ${MONITOR_DEFAULT_S} s by default, ${MONITOR_MAX_S} at most), with one message; one that sends more than ${FLOOD_NOTICES} messages a minute is stopped. Filter to the lines that matter: \`tail -n0 -F build.log | grep --line-buffered -E 'error|done'\`, a status poll that prints only on change. Stop it early with bash_stop.`,
    parameters: Type.Object({
      command: Type.String({ description: "shell command whose stdout lines are the events" }),
      description: Type.Optional(Type.String({ description: "what it watches, a few words" })),
      timeout: Type.Optional(Type.Number({ description: `deadline in seconds (default ${MONITOR_DEFAULT_S}, at most ${MONITOR_MAX_S})` })),
    }),
    async execute(_id: string, p: { command: string; description?: string; timeout?: number }, _signal: unknown, _u: unknown, c: any) {
      ctx = c ?? ctx;
      const it = start("monitor", p.command, p);
      const s = Math.min(Math.max(p.timeout ?? MONITOR_DEFAULT_S, 1), MONITOR_MAX_S);
      return text(`Monitor ${it.id} is watching (deadline ${duration(s * 1000)}). New stdout lines come as messages; one more comes when it ends. Output: ${it.file}. Stop it with use bash_stop {"id":"${it.id}"}.`);
    },
  });

  pi.registerTool({
    name: "bash_stop",
    label: "Stop background",
    exposure: "deferred",
    description: "Stop a background command (bash run_in_background) or a monitor by its id, with everything it started.",
    parameters: Type.Object({ id: Type.String({ description: "the id it started with (bg_… or mon_…)" }) }),
    async execute(_id: string, p: { id: string }) {
      const it = items.get(p.id.trim());
      if (!it) {
        const live = running().map((i) => `${i.id} (${short(i.command)})`);
        return text(`No background command ${p.id}. ${live.length ? `Running: ${live.join(", ")}` : "None is running."}`);
      }
      if (it.end) return text(`${it.id} already ended (${it.end.how}${it.end.how === "exited" ? ` ${it.end.code}` : ""}). Output: ${it.file}`);
      finish(it, { how: "stopped" });
      it.stop.abort();
      const tail = lastLines(it.tail);
      return text(`Stopped ${it.id} after ${duration(Date.now() - it.started)}. Output: ${it.file}${tail ? `\n\n${tail}` : ""}`);
    },
  });
}
