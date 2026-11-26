import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// the engine provides typebox at run time; the schemas don't matter here
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
// the engine's local shell: /bin/sh, its process group stopped on abort
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createLocalBashOperations: () => ({
    exec: (command: string, cwd: string, o: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number }) =>
      new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", o.onData);
        child.stderr.on("data", o.onData);
        let timedOut = false;
        const kill = () => child.pid && process.kill(-child.pid, "SIGKILL");
        const timer = o.timeout ? setTimeout(() => ((timedOut = true), kill()), o.timeout * 1000) : undefined;
        o.signal?.addEventListener("abort", kill, { once: true });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (o.signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${o.timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  }),
  createBashToolDefinition: () => ({
    name: "bash",
    label: "bash",
    description: "Execute a bash command.",
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "foreground" }], details: undefined }),
  }),
}));

const { default: background, endNotice, splitLines, lastLines, STATUS_KEY } = await import("./background");

function load(env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { APP_SCRATCH_DIR: `${process.env.TMPDIR ?? "/tmp"}/ondra-bg-test`, ...env });
  const tools: Record<string, any> = {};
  const on: Record<string, (e: unknown, c: unknown) => void> = {};
  const sent: { content: string; deliverAs?: string }[] = [];
  const status: (string | undefined)[] = [];
  let idle = true;
  const ctx = { isIdle: () => idle, ui: { setStatus: (k: string, v?: string) => k === STATUS_KEY && status.push(v) } };
  background({
    registerTool: (t: any) => (tools[t.name] = t),
    on: (e: string, f: any) => (on[e] = f),
    sendMessage: (m: { content: string }, o: { deliverAs?: string }) => sent.push({ content: m.content, deliverAs: o.deliverAs }),
  });
  process.env = saved;
  on.session_start?.({}, ctx);
  const run = (name: string, args: unknown) => tools[name].execute("call", args, undefined, undefined, ctx);
  const out = async (name: string, args: unknown) => (await run(name, args)).content[0].text as string;
  return { tools, on, sent, status, ctx, out, setIdle: (v: boolean) => (idle = v) };
}
const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const idOf = (s: string) => /(bg_\w+|mon_\w+)/.exec(s)![1];

describe("background", () => {
  let x: ReturnType<typeof load>;
  afterEach(() => x?.on.session_shutdown?.({}, x.ctx));

  it("runs a command in the background and says when it ends", async () => {
    x = load();
    const said = await x.out("bash", { command: "sleep 0.3; echo built; exit 3", run_in_background: true });
    expect(said).toMatch(/Started in the background as bg_\w+/);
    expect(x.status.at(-1)).toBe(JSON.stringify({ running: 1, queued: 0 }));
    await until(() => x.sent.length > 0);
    expect(x.sent[0].content).toContain(`Background command ${idOf(said)} ended with exit code 3`);
    expect(x.sent[0].content).toContain("built");
    expect(readFileSync(/Output: (\S+)/.exec(said)![1], "utf8")).toBe("built\n");
    // the engine was idle: kept for the next turn, and Ondra is told to wake the job
    expect(x.status.at(-1)).toBe(JSON.stringify({ running: 0, queued: 1 }));
    x.on.agent_start({}, x.ctx);
    expect(x.status.at(-1)).toBeUndefined();
  });

  it("steers the end into a turn that runs, without asking Ondra to wake it", async () => {
    x = load();
    x.setIdle(false);
    await x.out("bash", { command: "true", run_in_background: true });
    await until(() => x.sent.length > 0);
    expect(x.sent[0].deliverAs).toBe("steer");
    expect(x.status.at(-1)).toBeUndefined();
  });

  it("leaves a foreground command to the built-in bash", async () => {
    x = load();
    expect(await x.out("bash", { command: "echo hi" })).toBe("foreground");
  });

  it("sends a watch's stdout lines as one burst, keeps stderr in the file, and says when it ends", async () => {
    x = load();
    const said = await x.out("monitor", { command: "echo one; echo two; echo noise >&2; sleep 1.5", description: "ticks" });
    await until(() => x.sent.length >= 2, 6000);
    expect(x.sent[0].content).toMatch(/Monitor mon_\w+ \(ticks\): 2 new lines\none\ntwo$/);
    expect(x.sent[1].content).toContain("ended: its command exited with code 0");
    expect(x.sent.map((s) => s.content).join("\n")).not.toMatch(/^noise$/m);
    expect(readFileSync(/Output: (\S+?)\.\s/.exec(said)![1], "utf8")).toContain("noise");
  });

  it("stops a watch at its deadline with one message", async () => {
    x = load();
    await x.out("monitor", { command: "sleep 30", timeout: 1 });
    await until(() => x.sent.length > 0, 4000);
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0].content).toContain("reached its deadline");
    expect(x.status.at(-1)).toBe(JSON.stringify({ running: 0, queued: 1 }));
  });

  it("stops one by its id, quietly", async () => {
    x = load();
    const id = idOf(await x.out("bash", { command: "echo started; sleep 30", run_in_background: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await x.out("bash_stop", { id })).toMatch(new RegExp(`Stopped ${id} after \\d+s[\\s\\S]*started`));
    await new Promise((r) => setTimeout(r, 300));
    expect(x.sent).toHaveLength(0);
    expect(x.status.at(-1)).toBeUndefined();
    expect(await x.out("bash_stop", { id: "bg_nope" })).toContain("None is running");
  });

  it("hides secret values in what it sends", async () => {
    x = load({ ONDRA_SECRET_NAMES: "BG_TEST_KEY", BG_TEST_KEY: "sk_live_bgtest123456" });
    await x.out("bash", { command: "echo sk_live_bgtest123456", run_in_background: true });
    await until(() => x.sent.length > 0);
    expect(x.sent[0].content).not.toContain("sk_live_bgtest123456");
    expect(x.sent[0].content).toContain("[secret:BG_TEST_KEY]");
  });
});

describe("background helpers", () => {
  it("splits whole lines and keeps the unfinished rest", () => {
    expect(splitLines("pa", "rt\nnext\r\n\nlast")).toEqual({ lines: ["part", "next"], rest: "last" });
  });
  it("keeps the last lines", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
  });
  it("says how a command ended", () => {
    const it = { id: "bg_1", kind: "bash" as const, command: "make", file: "/t/bg_1.log", started: 0, tail: "" };
    expect(endNotice(it, { how: "exited", code: 0 }, 75_000)).toBe("[background] Background command bg_1 ended with exit code 0 after 1m 15s.\nCommand: make\nOutput: /t/bg_1.log (empty)");
    expect(endNotice(it, { how: "timed out" }, 1000)).toContain("was stopped by its timeout after 1s");
  });
});
