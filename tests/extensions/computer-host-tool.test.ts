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
    vi.stubEnv("ONDRA_COMPUTER_SOCKET", undefined);
    vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", undefined);
    vi.stubEnv("ONDRA_COMPUTER_CAPTURE_DIR", undefined);
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

  it("does not use the guest native path in host mode (no socket required)", async () => {
    const { call } = load();
    // No ONDRA_COMPUTER_SOCKET set, yet start works purely via the host helper.
    const start = data(await call({ action: "start", app: "TextEdit" }));
    expect(start.pid).toBe(4242);
    await call({ action: "stop" });
  });
});
