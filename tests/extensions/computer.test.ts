import { mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ execute: vi.fn(), dispose: vi.fn(), create: vi.fn(), register: vi.fn(), unregister: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock("../../extensions/lib/computer-runtime", () => ({ createComputerRuntime: boundary.create, registerComputerGuest: boundary.register }));
vi.mock("../../extensions/lib/computer-native", () => ({ connectComputerNative: boundary.connect }));
const { default: computer } = await import("../../extensions/computer");

const ok = (command: string, data: unknown) => ({ version: "2.6", command, ok: true, data });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const screenshot = () => ok("screenshot", { image: { mimeType: "image/png", data: png, width: 1, height: 1 } });
const vision = { model: { provider: "fixture", id: "vision", input: ["text", "image"] } };
const snapshot = (id: string, value = "initial") => ok("snapshot", {
  snapshot_id: id, complete: true, tree: { role: "window", children: [
    { role: "text", name: "fixture", value, ref_id: `@${id}:e1` },
  ] },
});
function load(initialize = true) {
  let tool: any;
  const hooks = new Map<string, (...args: any[]) => unknown>();
  computer({ registerTool: (value: any) => { tool = value; }, on: (event: string, hook: (...args: any[]) => unknown) => hooks.set(event, hook) });
  const ready = initialize ? hooks.get("session_start")!({}, { sessionManager: { getSessionId: () => "fixture-session" } }) : undefined;
  return { tool, hooks, ready, call: async (input: unknown, signal?: AbortSignal, ctx: unknown = vision) => {
    await ready;
    return tool.execute("call", input, signal, undefined, ctx);
  } };
}
const data = (result: any) => JSON.parse(result.content[0].text);
function startResponses(value?: string) {
  boundary.execute.mockResolvedValueOnce(ok("session", { session_id: "fixture" }))
    .mockResolvedValueOnce(ok("launch", { app: "TextEdit" }))
    .mockResolvedValueOnce(snapshot("s1", value));
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.create.mockReturnValue({ execute: boundary.execute, dispose: boundary.dispose });
  boundary.dispose.mockResolvedValue(undefined);
  boundary.register.mockReturnValue(boundary.unregister);
  boundary.connect.mockResolvedValue({ connectionDir: "/fixture/connection", authority: { invalidated: new AbortController().signal, renew: vi.fn() }, close: boundary.close });
  vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", undefined);
  vi.stubEnv("ONDRA_COMPUTER_CAPTURE_DIR", undefined);
  vi.stubEnv("ONDRA_COMPUTER_SOCKET", "/fixture/native.sock");
  vi.stubEnv("APP_WORKER_ID", "fixture-job");
  vi.stubEnv("APP_ARTIFACTS_DIR", realpathSync(mkdtempSync(join(tmpdir(), "computer-tool-"))));
});
afterEach(() => vi.unstubAllEnvs());

// The guest runtime is the OS boundary. Session/observation logic runs unchanged.
describe("computer extension", () => {
  it("freezes trusted forced-full configuration for automatic and explicit observations and images", async () => {
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", "forced-full");
    startResponses();
    const { call, ready } = load();
    await ready;
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", "compact");
    const first = data(await call({ action: "start", app: "TextEdit" }));
    boundary.execute.mockResolvedValueOnce(ok("click", { disposition: { delivery: "delivered_unverified", retry: "unsafe" } }))
      .mockResolvedValueOnce(snapshot("s2")).mockResolvedValueOnce(snapshot("s3"));
    const second = data(await call({ action: "act", input: { kind: "click", epoch: first.observation.epoch, ref: "e1" } }));
    const third = data(await call({ action: "observe", full: false }));
    expect([first.observation.kind, second.observation.kind, third.kind]).toEqual(["full", "full", "full"]);
    expect(boundary.execute).toHaveBeenCalledTimes(6);
    boundary.execute.mockResolvedValue(screenshot());
    expect((await call({ action: "look" })).content).toHaveLength(2);
    expect((await call({ action: "look", full: false })).content).toHaveLength(2);
    expect(boundary.execute).toHaveBeenCalledTimes(8);
  });

  it("does not record by default or expose capture paths in tool results", async () => {
    startResponses();
    await load().call({ action: "start", app: "TextEdit" });
    expect(readdirSync(process.env.APP_ARTIFACTS_DIR!)).toEqual([]);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "computer-private-capture-")));
    vi.stubEnv("ONDRA_COMPUTER_CAPTURE_DIR", directory);
    startResponses();
    const result = await load().call({ action: "start", app: "TextEdit" });
    expect(readdirSync(directory)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it("fails closed on invalid evaluation configuration before native connection", async () => {
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", "secret-invalid-mode");
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow(/^Invalid computer evaluation configuration$/);
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("registers a deferred sequential provider-neutral tool without starting a runtime", () => {
    const { tool } = load(false);
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(tool).toMatchObject({ name: "computer", exposure: "deferred", executionMode: "sequential" });
    expect(tool.parameters.properties.action.enum).toEqual(["start", "observe", "look", "act", "stop"]);
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("returns a coordinate frame only for a whole-screen look", async () => {
    startResponses();
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValueOnce({ version: "2.6", command: "list-displays", ok: true,
      data: [{ id: "1", is_primary: true, scale: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }] }).mockResolvedValueOnce(screenshot());
    const looked = data(await call({ action: "look", screen: true }));
    expect(looked).toMatchObject({ frame: "f1", actionable: true, width: 1, height: 1 });
    expect(boundary.execute.mock.calls.slice(3).map(([argv]) => argv)).toEqual([
      ["--session", "fixture", "list-displays"], ["--session", "fixture", "screenshot", "--screen", "0"]]);
    boundary.execute.mockResolvedValueOnce(ok("mouse-click", {})).mockResolvedValueOnce(snapshot("s2"));
    const clicked = data(await call({ action: "act", input: { kind: "click-at", epoch: "f1", x: 0, y: 0 } }));
    expect(boundary.execute.mock.calls[5][0]).toEqual(["--session", "fixture", "mouse-click", "--xy=0,0", "--button", "left", "--count", "1", "--headed"]);
    expect(clicked.observation.snapshot_id).toBe("s2");
    await expect(call({ action: "look", screen: "yes" })).rejects.toThrow("screen must be boolean");
    await expect(call({ action: "observe", screen: true })).rejects.toThrow("Invalid computer action fields");
  });

  it("registers the native authority at session start before runtime creation", async () => {
    const { ready } = load();
    await ready;
    expect(boundary.connect).toHaveBeenCalledWith("/fixture/native.sock", "fixture-session", expect.any(AbortSignal));
    expect(boundary.register).toHaveBeenCalledWith({ taskId: "fixture-job", artifactsDir: process.env.APP_ARTIFACTS_DIR,
      connectionDir: "/fixture/connection", authority: expect.objectContaining({ invalidated: expect.any(AbortSignal) }) });
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("returns image content only on look, preserves a private PNG, and omits unchanged images", async () => {
    startResponses();
    const { call } = load();
    const first = await call({ action: "start", app: "TextEdit" });
    expect(first.content.every((block: any) => block.type === "text")).toBe(true);
    boundary.execute.mockResolvedValue(screenshot());
    const looked = await call({ action: "look" });
    const output = data(looked);
    expect(output).toMatchObject({ kind: "full", actionable: false, imageIncluded: true, width: 1, height: 1 });
    expect(looked.content[1]).toEqual({ type: "image", mimeType: "image/png", data: png });
    expect(looked.content[0].text).not.toContain(png);
    expect(JSON.stringify(looked.details)).not.toContain(png);
    expect(output.path.startsWith(process.env.APP_ARTIFACTS_DIR + "/")).toBe(true);
    expect(readFileSync(output.path).toString("base64")).toBe(png);
    expect(statSync(output.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(output.path)).mode & 0o777).toBe(0o700);
    const same = await call({ action: "look" });
    expect(data(same)).toMatchObject({ kind: "unchanged", imageIncluded: false, path: output.path, sha256: output.sha256 });
    expect(same.content).toHaveLength(1);
    expect((await call({ action: "look", full: true })).content[1].type).toBe("image");
    await expect(call({ action: "act", input: { kind: "click", epoch: data(first).observation.epoch, ref: "e1" } })).rejects.toThrow("Fresh actionable");
    expect(boundary.execute.mock.calls.slice(3).every(([argv]) => JSON.stringify(argv) === JSON.stringify(["--session", "fixture", "screenshot", "--app", "TextEdit"]))).toBe(true);
  });

  it.each([{ model: { input: ["text"] } }, {}, undefined])("does not expose base64 to a text-only or unknown model", async ctx => {
    startResponses();
    const { call, tool } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValue(screenshot());
    const result = await tool.execute("look", { action: "look" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({ error: "MODEL_IMAGE_UNSUPPORTED", imageIncluded: false, actionable: false });
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(png);
    expect(readFileSync(data(result).path).toString("base64")).toBe(png);
    expect((await call({ action: "look" })).content[1].type).toBe("image");
  });

  it.each(["session_compact", "session_tree", "model_select", "agent_settled"])("resends the full image after %s", async event => {
    startResponses();
    const { call, hooks } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValue(screenshot());
    await call({ action: "look" });
    expect((await call({ action: "look" })).content).toHaveLength(1);
    await hooks.get(event)!({ aborted: true });
    expect((await call({ action: "look" })).content[1].type).toBe("image");
  });

  it("does not suppress the next image after capture failure or cancellation", async () => {
    startResponses();
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValue(screenshot());
    await call({ action: "look" });
    boundary.execute.mockResolvedValueOnce(ok("screenshot", { path: "/host/private.png" }));
    await expect(call({ action: "look" })).rejects.toThrow("Malformed screenshot");
    expect((await call({ action: "look" })).content[1].type).toBe("image");
    await expect(call({ action: "look" }, AbortSignal.abort())).rejects.toThrow("cancelled");
    expect((await call({ action: "look" })).content[1].type).toBe("image");
  });

  it("rejects a pending image on model reset instead of restoring the old image baseline", async () => {
    startResponses();
    const { call, hooks } = load();
    await call({ action: "start", app: "TextEdit" });
    let release!: (value: unknown) => void;
    let capturing!: () => void;
    const captured = new Promise<void>(resolve => { capturing = resolve; });
    boundary.execute.mockImplementationOnce(() => { capturing(); return new Promise(resolve => { release = resolve; }); });
    const pending = call({ action: "look" });
    await captured;
    await hooks.get("model_select")!({});
    release(screenshot());
    await expect(pending).rejects.toThrow("reset");
    boundary.execute.mockResolvedValueOnce(screenshot());
    expect((await call({ action: "look" })).content[1].type).toBe("image");
  });

  it("resends for a different model identity even without a model event", async () => {
    startResponses();
    const { call } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValue(screenshot());
    await call({ action: "look" });
    const result = await call({ action: "look" }, undefined, { model: { ...vision.model, id: "another" } });
    expect(result.content[1].type).toBe("image");
  });

  it("connects only the job runtime and returns fresh observations", async () => {
    startResponses();
    const { call } = load();
    const first = data(await call({ action: "start", app: "TextEdit" }));
    expect(boundary.create).toHaveBeenCalledWith({ taskId: "fixture-job", artifactsDir: process.env.APP_ARTIFACTS_DIR });
    expect(first.observation.kind).toBe("full");
    boundary.execute.mockResolvedValueOnce(snapshot("s2"));
    expect(data(await call({ action: "observe" })).kind).toBe("unchanged");
    await expect(call({ action: "start", app: "Calculator" })).rejects.toThrow("already exists");
    expect(boundary.create).toHaveBeenCalledTimes(1);
  });

  it.each(["session_compact", "session_tree", "model_select"])("requires new full observation after %s", async event => {
    startResponses();
    const { call, hooks } = load();
    const first = data(await call({ action: "start", app: "TextEdit" }));
    await hooks.get(event)!({});
    await expect(call({ action: "act", input: { kind: "click", epoch: first.observation.epoch, ref: "e1" } })).rejects.toThrow("Fresh actionable");
    boundary.execute.mockResolvedValueOnce(snapshot("s2"));
    expect(data(await call({ action: "observe" })).kind).toBe("full");
  });

  it("invalidates refs after an aborted run", async () => {
    startResponses();
    const { call, hooks } = load();
    const first = data(await call({ action: "start", app: "TextEdit" }));
    await hooks.get("agent_settled")!({ aborted: true });
    await expect(call({ action: "act", input: { kind: "click", epoch: first.observation.epoch, ref: "e1" } })).rejects.toThrow("Fresh actionable");
  });

  it.each([
    { action: "start", app: "../Finder" }, { action: "start", app: "--headed" },
    { action: "start", app: " TextEdit" }, { action: "start", app: "TextEdit", host: "127.0.0.1" },
    { action: "observe", app: "Finder" }, { action: "observe", full: "yes" },
    { action: "start", app: "TextEdit", mode: "forced-full" },
    { action: "observe", captureDir: "/private/capture" }, { action: "observe", export: "/private/export" },
    { action: "act", cmd: "launch Finder" }, { action: "stop", full: true },
    { action: "look", path: "/host/private.png" }, { action: "look", app: "Finder" }, { action: "look", full: "true" },
  ])("rejects invalid or passthrough arguments before runtime access: %j", async input => {
    await expect(load().call(input)).rejects.toThrow();
    expect(boundary.create).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it("does not connect without job identity or after prior cancellation", async () => {
    vi.stubEnv("APP_WORKER_ID", "");
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("setup required");
    await expect(call({ action: "start", app: "TextEdit" }, AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("does not replay ambiguous start, and disposes even when stop cannot reconcile it", async () => {
    boundary.execute.mockRejectedValueOnce(new Error("lost connection"));
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("lost connection");
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("already exists");
    await expect(call({ action: "stop" })).rejects.toThrow("No known session_id");
    expect(boundary.dispose).toHaveBeenCalledTimes(1);
    expect(boundary.execute).toHaveBeenCalledTimes(1);
  });

  it("does not expose bootstrap errors or retry registration from a tool", async () => {
    boundary.connect.mockRejectedValueOnce(new Error("private bootstrap secret"));
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("setup required");
    await expect(call({ action: "start", app: "TextEdit" })).rejects.not.toThrow("private bootstrap secret");
    expect(boundary.register).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
    expect(boundary.connect).toHaveBeenCalledTimes(1);
  });

  it("closes a late bootstrap result after shutdown without registering it", async () => {
    let release!: (value: unknown) => void;
    boundary.connect.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const { ready, hooks, call } = load();
    const shutdown = hooks.get("session_shutdown")!();
    expect(boundary.connect.mock.calls[0][2].aborted).toBe(true);
    release({ connectionDir: "/fixture/connection", authority: {}, close: boundary.close });
    await Promise.all([ready, shutdown]);
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.register).not.toHaveBeenCalled();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow();
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("rejects tool calls while registration is pending, including stop", async () => {
    let release!: (value: unknown) => void;
    boundary.connect.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const { ready, tool, hooks } = load();
    await expect(tool.execute("stop", { action: "stop" })).rejects.toThrow("in progress");
    await expect(tool.execute("start", { action: "start", app: "TextEdit" })).rejects.toThrow("in progress");
    expect(boundary.create).not.toHaveBeenCalled();
    release({ connectionDir: "/fixture/connection", authority: { invalidated: new AbortController().signal }, close: boundary.close });
    await ready;
    await hooks.get("session_shutdown")!();
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.unregister).toHaveBeenCalledTimes(1);
  });

  it("closes native registration even if its local binding is rejected", async () => {
    boundary.register.mockImplementationOnce(() => { throw new Error("private connection path"); });
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("setup required");
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("does not reinterpret a second session_start as an observation reset or reconnect", async () => {
    const { ready, hooks } = load();
    await ready;
    await hooks.get("session_start")!({}, { sessionManager: { getSessionId: () => "another-session" } });
    expect(boundary.connect).toHaveBeenCalledTimes(1);
    expect(boundary.register).toHaveBeenCalledTimes(1);
  });

  it("notifies native ownership immediately on ambiguous dispatch failure", async () => {
    boundary.execute.mockRejectedValueOnce(new Error("lost connection"));
    const { call } = load();
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("lost connection");
    expect(boundary.close).toHaveBeenCalledWith(true);
    expect(boundary.unregister).toHaveBeenCalledTimes(1);
  });

  it("releases an unused native claim on stop and never reclaims it", async () => {
    const { call } = load();
    await call({ action: "stop" });
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.unregister).toHaveBeenCalledTimes(1);
    await expect(call({ action: "start", app: "TextEdit" })).rejects.toThrow("setup required");
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("clears the tool runtime even when disposal rejects, without retaining native authority", async () => {
    startResponses();
    const { call, hooks } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValueOnce(ok("session", { session_id: "fixture", ended_at: 123 }));
    boundary.dispose.mockRejectedValueOnce(new Error("GUEST_QUARANTINED"));
    await expect(call({ action: "stop" })).rejects.toThrow("GUEST_QUARANTINED");
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.unregister).toHaveBeenCalledTimes(1);
    await call({ action: "stop" });
    await hooks.get("session_shutdown")!();
    expect(boundary.dispose).toHaveBeenCalledTimes(1);
  });

  it("closes idempotently without deleting guest data", async () => {
    startResponses();
    const { call, hooks } = load();
    await call({ action: "start", app: "TextEdit" });
    boundary.execute.mockResolvedValueOnce(ok("session", { session_id: "fixture", ended_at: 123 }));
    await call({ action: "stop" });
    await call({ action: "stop" });
    await hooks.get("session_shutdown")!();
    expect(boundary.dispose).toHaveBeenCalledTimes(1);
    expect(boundary.execute.mock.calls.at(-1)?.[0]).toEqual(["--session", "fixture", "session", "end", "fixture"]);
  });

  it("keeps oversized observations as non-actionable artifacts rather than clipped refs", async () => {
    startResponses("x".repeat(52 * 1024));
    const { call } = load();
    const result = await call({ action: "start", app: "TextEdit" });
    const output = data(result);
    expect(result.isError).toBe(true);
    expect(output).toMatchObject({ error: "OBSERVATION_TOO_LARGE", actionable: false });
    const saved = JSON.parse(readFileSync(output.path, "utf8"));
    expect(saved.observation.snapshot.data.tree.children[0].value.length).toBe(52 * 1024);
    await expect(call({ action: "act", input: { kind: "click", epoch: saved.observation.epoch, ref: "e1" } })).rejects.toThrow("Fresh actionable");
  });

  it("serializes overlapping calls even when invoked outside the engine scheduler", async () => {
    let release!: (value: unknown) => void;
    boundary.execute.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const { call } = load();
    const starting = call({ action: "start", app: "TextEdit" });
    await expect(call({ action: "observe" })).rejects.toThrow("in progress");
    boundary.execute.mockResolvedValueOnce(ok("launch", {})).mockResolvedValueOnce(snapshot("s1"));
    release(ok("session", { session_id: "fixture" }));
    await starting;
  });
});
