import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelope, backgroundPreserved, HostObservation, HostHelperError, ComputerHostHelper, ComputerHostSession, type HostNode } from "../../extensions/lib/computer-host";

const env = (pid: number, win = "W", x = 1, y = 2) => ({ frontmostApp: "app", frontmostPid: pid, frontmostKeyWindow: win, mouse: { x, y } });

describe("host envelope", () => {
  it("accepts a valid ok envelope and extracts the result", () => {
    expect(envelope({ version: 1, id: "7", ok: true, result: { a: 1 } })).toEqual({ id: "7", result: { a: 1 } });
  });
  it("rejects malformed envelopes and surfaces errors as a typed code, not raw text", () => {
    expect(() => envelope({ version: 2, ok: true, result: {} })).toThrow("Malformed host envelope");
    expect(() => envelope({ version: 1, ok: true })).toThrow("Malformed host result");
    try { envelope({ version: 1, ok: false, error: { code: "NO_WINDOW", message: "secret path /x" } }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(HostHelperError); expect((e as HostHelperError).code).toBe("NO_WINDOW"); }
  });
});

describe("background invariant", () => {
  it("is preserved only when frontmost pid, key window and mouse all match", () => {
    expect(backgroundPreserved(env(1), env(1))).toBe(true);
    expect(backgroundPreserved(env(1), env(2))).toBe(false);
    expect(backgroundPreserved(env(1, "A"), env(1, "B"))).toBe(false);
    expect(backgroundPreserved(env(1, "A", 1, 2), env(1, "A", 1, 3))).toBe(false);
    expect(backgroundPreserved(undefined, env(1))).toBe(false);
  });
  it("compares the key window by id when both snapshots have one, so an animating title is not a focus change", () => {
    expect(backgroundPreserved({ ...env(1, "◐ build"), frontmostWindowId: 7 }, { ...env(1, "◑ build"), frontmostWindowId: 7 })).toBe(true);
    expect(backgroundPreserved({ ...env(1, "A"), frontmostWindowId: 7 }, { ...env(1, "A"), frontmostWindowId: 8 })).toBe(false);
  });
});

const tree = (value: string): HostNode => ({
  id: "w", role: "AXWindow", children: [
    { id: "w/AXTextField#entry", role: "AXTextField", value, settable: true },
    { id: "w/AXButton#go", role: "AXButton", title: "Go", actions: ["AXPress"] },
  ],
});

describe("HostObservation", () => {
  it("emits a full baseline, then a minimal delta, then unchanged", () => {
    const obs = new HostObservation();
    const first = obs.accept(tree("a"), false);
    expect(first.kind).toBe("full");
    const second = obs.accept(tree("b"), false);
    expect(second.kind).toBe("delta");
    if (second.kind === "delta") {
      expect(second.base_epoch).toBe(first.epoch);
      expect(second.changes).toEqual([{ op: "set", path: ["children", 0, "value"], value: "b" }]);
    }
    const third = obs.accept(tree("b"), false);
    expect(third.kind).toBe("unchanged");
  });
  it("resolves only ids present in the current epoch, and rejects stale epochs", () => {
    const obs = new HostObservation();
    const first = obs.accept(tree("a"), false);
    expect(obs.resolve(first.epoch, "w/AXButton#go")).toBe("w/AXButton#go");
    expect(() => obs.resolve(first.epoch, "missing")).toThrow("Unknown element ref");
    const second = obs.accept(tree("a"), false);
    expect(() => obs.resolve(first.epoch, "w/AXButton#go")).toThrow("Stale observation epoch");
    expect(obs.resolve(second.epoch, "w/AXButton#go")).toBe("w/AXButton#go");
  });
  it("force-full re-sends the whole tree even when it could diff", () => {
    const obs = new HostObservation();
    obs.accept(tree("a"), false);
    expect(obs.accept(tree("b"), true).kind).toBe("full");
  });
  it("rejects a malformed tree node", () => {
    const obs = new HostObservation();
    expect(() => obs.accept({ role: "AXWindow" }, false)).toThrow("Malformed host node");
  });
});

describe("ComputerHostHelper transport", () => {
  // A tiny fake helper: echoes one response per request line, matching ids.
  function fakeHelper(): string {
    const dir = mkdtempSync(join(tmpdir(), "cuhost-fake-"));
    const path = join(dir, "fake.mjs");
    writeFileSync(path, `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.op === "boom") process.stdout.write(JSON.stringify({ version: 1, id: req.id, ok: false, error: { code: "NO_WINDOW", message: "x" } }) + "\\n");
    else process.stdout.write(JSON.stringify({ version: 1, id: req.id, ok: true, result: { echoed: req.op, env: { frontmostApp: "a", frontmostPid: 1, frontmostKeyWindow: "W", mouse: { x: 1, y: 2 } } } }) + "\\n");
  }
});
`);
    return path;
  }
  it("matches responses to requests by id and serializes one in flight", async () => {
    const helper = new ComputerHostHelper(process.execPath, [fakeHelper()]);
    helper.start();
    const r = await helper.request("frontmost");
    expect(r.echoed).toBe("frontmost");
    await expect(helper.request("boom")).rejects.toBeInstanceOf(HostHelperError);
    helper.stop();
  });
});

describe("ComputerHostSession actions", () => {
  // A fake helper that records each act request and answers with a tree whose
  // report text changes only when the request asks it to (changes: true).
  function recordingHelper(): { path: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), "cuhost-rec-"));
    const path = join(dir, "rec.mjs"), log = join(dir, "acts.jsonl");
    writeFileSync(path, `
import { appendFileSync } from "node:fs";
const env = { frontmostApp: "a", frontmostPid: 1, frontmostWindowId: 5, mouse: { x: 1, y: 2 } };
let report = "idle", buf = "";
const tree = () => ({ id: "w", role: "AXWindow", children: [
  { id: "e1", role: "AXStaticText", value: report },
  { id: "e2", role: "AXGroup", desc: "pad" }, { id: "e3", role: "AXGroup", desc: "bin" } ] });
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    let result = { env };
    if (req.op === "launch") result = { pid: 42, env, backgroundPreserved: true };
    if (req.op === "observe") result = { tree: tree(), env };
    if (req.op === "act") {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(req.action) + "\\n");
      if (req.action.kind === "drag" && req.action.from.x !== 0) report = "dragged";
      result = { tree: tree(), env, envBefore: env, backgroundPreserved: true, actionMs: 3, dragMs: 90 };
    }
    process.stdout.write(JSON.stringify({ version: 1, id: req.id, ok: true, result }) + "\\n");
  }
});
`);
    return { path, log };
  }
  const acts = (log: string) => readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));

  it("translates drag to pixel ends or resolved refs, and reports whether the tree changed", async () => {
    const { path, log } = recordingHelper();
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    const started = await session.start("Test") as { observation: { epoch: string } };
    let epoch = started.observation.epoch;
    const moved = await session.act({ kind: "drag", epoch, from: { x: 40, y: 100 }, to: { x: 300, y: 220 } }) as Record<string, any>;
    expect(moved.action.effect).toBe("changed");
    expect(moved.dragMs).toBe(90);
    epoch = moved.observation.epoch;
    const same = await session.act({ kind: "drag", epoch, from: { ref: "e2" }, to: { ref: "e3" } }) as Record<string, any>;
    expect(same.action.effect).toBe("no_change");
    expect(acts(log)).toEqual([
      { kind: "drag", from: { x: 40, y: 100 }, to: { x: 300, y: 220 } },
      { kind: "drag", from: { ref: "e2" }, to: { ref: "e3" } },
    ]);
    await session.stop();
  });

  it("refuses mixed, fractional or stale drag ends before anything is sent", async () => {
    const { path, log } = recordingHelper();
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    const started = await session.start("Test") as { observation: { epoch: string } };
    const epoch = started.observation.epoch;
    await expect(session.act({ kind: "drag", epoch, from: { ref: "e2" }, to: { x: 1, y: 2 } })).rejects.toThrow("same kind");
    await expect(session.act({ kind: "drag", epoch, from: { x: 1.5, y: 2 }, to: { x: 3, y: 4 } })).rejects.toThrow("non-negative integer");
    await expect(session.act({ kind: "drag", epoch, from: { ref: "gone" }, to: { ref: "e3" } })).rejects.toThrow("Unknown element ref");
    await expect(session.act({ kind: "drag", epoch: "h0", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).resolves.toBeDefined();
    await expect(session.act({ kind: "drag", epoch, from: { ref: "e2" }, to: { ref: "e3" } })).rejects.toThrow("Stale observation epoch");
    await expect(session.act({ kind: "scroll", epoch: "h2", ref: "e2", direction: "down" })).resolves.toBeDefined();
    expect(acts(log)).toEqual([
      { kind: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
      { kind: "scroll", ref: "e2", direction: "down", amount: 3 },
    ]);
    await session.stop();
  });
});
