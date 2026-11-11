import { mkdtempSync, writeFileSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { default: computer } = await import("../../extensions/computer");

const vision = { model: { provider: "fixture", id: "vision", input: ["text", "image"] } };
const data = (r: any) => JSON.parse(r.content[0].text);

// A fake ondra-cuhost: launches return a pid + env; observe returns a tiny tree;
// act echoes backgroundPreserved and a changed tree; look returns a 1x1 PNG.
function fakeHelperBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "cuhost-tool-"));
  const path = join(dir, "fake.mjs");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
  writeFileSync(path, `#!${process.execPath}
const ENV = { frontmostApp: "aside", frontmostPid: 7, frontmostKeyWindow: "W", mouse: { x: 1, y: 2 } };
const tree = v => ({ id: "w", role: "AXWindow", children: [
  { id: "w/AXTextField#entry", role: "AXTextField", value: v, settable: true },
  { id: "w/AXButton#go", role: "AXButton", title: "Go", actions: ["AXPress"] } ] });
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue;
    const r = JSON.parse(line); let res;
    if (r.op === "launch" && r.app === "Nope") { process.stdout.write(JSON.stringify({ version: 1, id: r.id, ok: false, error: { code: "LAUNCH_FAILED", message: "app not found" } }) + "\\n"); continue; }
    if (r.op === "launch") res = { pid: 4242, env: ENV, backgroundPreserved: true };
    else if (r.op === "observe") res = { tree: tree("a"), env: ENV };
    else if (r.op === "act") res = { actionMs: 5, env: ENV, backgroundPreserved: true, tree: tree(r.action.kind === "set-value" ? r.action.value : "a") };
    else if (r.op === "look") res = { image: { mimeType: "image/png", data: ${JSON.stringify(png)}, width: 1, height: 1 }, env: ENV };
    else res = { env: ENV };
    process.stdout.write(JSON.stringify({ version: 1, id: r.id, ok: true, result: res }) + "\\n");
  }
});
`);
  chmodSync(path, 0o755);
  return path;
}

function load() {
  let tool: any;
  const hooks = new Map<string, (...a: any[]) => unknown>();
  computer({ registerTool: (v: any) => { tool = v; }, on: (e: string, h: (...a: any[]) => unknown) => hooks.set(e, h) });
  const ready = hooks.get("session_start")!({}, { sessionManager: { getSessionId: () => "s" } });
  return { tool, hooks, call: async (input: unknown, signal?: AbortSignal, ctx: unknown = vision) => { await ready; return tool.execute("call", input, signal, undefined, ctx); } };
}

describe("computer tool — host background mode", () => {
  beforeEach(() => {
    vi.stubEnv("ONDRA_COMPUTER_HOST", "1");
    vi.stubEnv("ONDRA_COMPUTER_HOST_BIN", fakeHelperBin());
    vi.stubEnv("APP_WORKER_ID", "job");
    vi.stubEnv("APP_ARTIFACTS_DIR", realpathSync(mkdtempSync(join(tmpdir(), "cu-art-"))));
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("starts, observes with stable-id tree, acts in one round trip, looks, and never breaks the background invariant", async () => {
    const { call } = load();
    const start = data(await call({ action: "start", app: "TextEdit" }));
    expect(start.pid).toBe(4242);
    expect(start.observation.kind).toBe("full");
    const epoch = start.observation.epoch;
    const set = data(await call({ action: "act", input: { kind: "set-value", epoch, ref: "w/AXTextField#entry", value: "hello" } }));
    expect(set.action.outcome).toBe("verified");
    // the re-observation after the action carries the change, in the same call
    expect(JSON.stringify(set.observation)).toContain("hello");
    const look = await call({ action: "look" });
    expect(look.content.length).toBe(2);
    expect(look.content[1].type).toBe("image");
    const stopped = data(await call({ action: "stop" }));
    expect(stopped.stopped).toBe(true);
  });

  it("leaves no session behind after a start that failed, so another name can be tried", async () => {
    const { call } = load();
    await expect(call({ action: "start", app: "Nope" })).rejects.toThrow(/app not found/);
    const start = data(await call({ action: "start", app: "TextEdit" }));
    expect(start.pid).toBe(4242);
    await call({ action: "stop" });
  });

  it("names the clicked element for the step line, outside what the model reads", async () => {
    const { call } = load();
    const epoch = data(await call({ action: "start", app: "TextEdit" })).observation.epoch;
    const r = await call({ action: "act", input: { kind: "click", epoch, ref: "w/AXButton#go" } });
    expect(r.details).toEqual({ label: "Go" });
    expect(r.content[0].text).not.toContain("label");
    await call({ action: "stop" });
  });

  it("registers a deferred sequential tool without spawning the helper", () => {
    const { tool } = load();
    expect(tool).toMatchObject({ name: "computer", exposure: "deferred", executionMode: "sequential" });
    expect(tool.parameters.properties.action.enum).toEqual(["start", "observe", "look", "act", "stop"]);
    expect(tool.description).not.toMatch(/guest|isolated/i);
  });

  it("refuses to start when the helper is not bundled", async () => {
    vi.stubEnv("ONDRA_COMPUTER_HOST", undefined);
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("not bundled");
  });

  it("rejects fields that do not belong to the action", async () => {
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    await expect(call({ action: "look", screen: true })).rejects.toThrow("Invalid computer action fields");
    await expect(call({ action: "observe", app: "x" })).rejects.toThrow("Invalid computer action fields");
    await call({ action: "stop" });
  });

  it("omits an unchanged image, and resends it after the context resets", async () => {
    const { call, hooks } = load();
    await call({ action: "start", app: "TextEdit" });
    expect((await call({ action: "look" })).content).toHaveLength(2);
    const again = await call({ action: "look" });
    expect(again.content).toHaveLength(1);
    expect(data(again)).toMatchObject({ kind: "unchanged", imageIncluded: false });
    hooks.get("session_compact")!();
    expect((await call({ action: "look" })).content).toHaveLength(2);
    await call({ action: "stop" });
  });

  it.each([{ model: { input: ["text"] } }, {}])("does not send image data to a text-only or unknown model", async ctx => {
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    const look = await call({ action: "look" }, undefined, ctx);
    expect(look.isError).toBe(true);
    expect(look.content).toHaveLength(1);
    expect(data(look)).toMatchObject({ error: "MODEL_IMAGE_UNSUPPORTED", imageIncluded: false });
    await call({ action: "stop" });
  });

  it("forces full observations in forced-full evaluation mode", async () => {
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", "forced-full");
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    expect(data(await call({ action: "observe" })).kind).toBe("full");
    await call({ action: "stop" });
  });

  it("observes compactly by default", async () => {
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    expect(data(await call({ action: "observe" })).kind).toBe("unchanged");
    await call({ action: "stop" });
  });

  it("fails closed on an invalid evaluation mode", async () => {
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", "secret-invalid-mode");
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("Invalid computer evaluation configuration");
  });

  it("serializes overlapping calls", async () => {
    const { call } = load();
    const starting = call({ action: "start", app: "TextEdit" });
    await expect(call({ action: "observe" })).rejects.toThrow("in progress");
    await starting;
    await call({ action: "stop" });
  });

  it("stops the helper on session shutdown", async () => {
    const { call, hooks } = load();
    await call({ action: "start", app: "TextEdit" });
    await hooks.get("session_shutdown")!();
    await expect(call({ action: "observe" })).rejects.toThrow("in progress");
  });
});
