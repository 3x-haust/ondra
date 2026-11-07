import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelope, backgroundPreserved, HostObservation, HostHelperError, ComputerHostHelper, type HostNode } from "../../extensions/lib/computer-host";

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
