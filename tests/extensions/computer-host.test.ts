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
  it("shows the whole screen as numbered lines, then only what changed, then unchanged", () => {
    const obs = new HostObservation();
    const first = obs.accept(tree("a"), false);
    expect(first.kind).toBe("full");
    expect(first.text).toBe('[1] window\n  [2] textfield = "a"\n  [3] button "Go"');
    const second = obs.accept(tree("b"), false);
    expect(second).toMatchObject({ kind: "delta", base_epoch: first.epoch, text: '~ [2] textfield = "b"', changed: true });
    const third = obs.accept(tree("b"), false);
    expect(third).toMatchObject({ kind: "unchanged", changed: false });
  });
  it("says what appeared and what went, under which parent", () => {
    const obs = new HostObservation();
    const big = (extra: HostNode[]) => ({ id: "w", role: "AXWindow", children: [
      { id: "list", role: "AXList", children: [{ id: "r0", role: "AXStaticText", value: "one" }, { id: "r1", role: "AXStaticText", value: "two" }, ...extra] },
      { id: "a", role: "AXButton", title: "A" }, { id: "b", role: "AXButton", title: "B" }, { id: "c", role: "AXButton", title: "C" },
      { id: "d", role: "AXButton", title: "D" }, { id: "x", role: "AXButton", title: "Cancel" },
    ] });
    obs.accept(big([]), false);
    const grown = obs.accept({ ...big([{ id: "r2", role: "AXStaticText", value: "three" }]), children: big([{ id: "r2", role: "AXStaticText", value: "three" }]).children!.slice(0, -1) }, false);
    expect(grown.kind).toBe("delta");
    expect(grown.text).toBe('- [9] button "Cancel"\n+ [10] text "three" (in [2])');
  });
  it("keeps the model's view across hidden intermediate states and filtered looks", () => {
    const obs = new HostObservation();
    obs.accept(tree("a"), false);
    expect(obs.accept(tree("b"), { show: false }).changed).toBe(true);
    expect(obs.accept(tree("c"), { query: "go" })).toMatchObject({ kind: "query", matches: 1, text: '[1] window\n  [3] button "Go"' });
    // compared with what was last shown ("a"), not with the hidden or filtered states
    expect(obs.accept(tree("c"), false).text).toBe('~ [2] textfield = "c"');
  });
  it("hides empty containers and labels that repeat their parent", () => {
    const obs = new HostObservation();
    const out = obs.accept({ id: "w", role: "AXWindow", title: "Doc", children: [
      { id: "g", role: "AXGroup", children: [{ id: "b", role: "AXButton", title: "Save", children: [{ id: "t", role: "AXStaticText", value: "Save" }] }] },
      { id: "c", role: "AXCheckBox", title: "Bold", value: "1" },
      { id: "s", role: "AXSlider", value: "40", settable: true, actions: ["AXIncrement", "AXDecrement"] },
    ] }, true);
    expect(out.text).toBe('[1] window "Doc"\n  [3] button "Save"\n  [5] checkbox "Bold" checked\n  [6] slider = "40" settable actions=Increment,Decrement');
  });
  it("resolves numbers to elements on the current screen only", () => {
    const obs = new HostObservation();
    obs.accept(tree("a"), false);
    expect(obs.resolve(3)).toBe("w/AXButton#go");
    expect(obs.resolve("[3]")).toBe("w/AXButton#go");
    expect(() => obs.resolve(9)).toThrow("not on the current screen");
    obs.accept({ id: "w", role: "AXWindow", children: [] }, false);
    expect(() => obs.resolve(3)).toThrow("not on the current screen");
    obs.invalidate();
    expect(() => obs.resolve(1)).toThrow("observe first");
  });
  it("force-full re-sends the whole screen even when it could diff", () => {
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
      if (req.action.kind === "press-action") {
        report = req.action.ref;
        result = { ...result, via: req.action.count === 2 ? "pointer" : "ax" };
        if (req.action.ref === "e2") result = { ...result, selfActivated: true, restored: true };
        if (req.action.ref === "e3") result = { ...result, backgroundPreserved: false, userInput: true };
        if (req.action.ref === "e1") result = { ...result, backgroundPreserved: false, selfActivated: true, restored: false };
      }
      if (req.action.kind === "menu") result = { ...result, via: "menu", raisedOverUser: true, orderRestored: true };
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
    await session.start("Test");
    const moved = await session.act({ kind: "drag", from: { x: 40, y: 100 }, to: { x: 300, y: 220 } }) as Record<string, any>;
    expect(moved.action.effect).toBe("changed");
    expect(moved.dragMs).toBe(90);
    const same = await session.act({ kind: "drag", from: { ref: 3 }, to: { ref: 4 } }) as Record<string, any>;
    expect(same.action.effect).toBe("no_change");
    expect(acts(log)).toEqual([
      { kind: "drag", from: { x: 40, y: 100 }, to: { x: 300, y: 220 } },
      { kind: "drag", from: { ref: "e2" }, to: { ref: "e3" } },
    ]);
    await session.stop();
  });

  it("refuses mixed, fractional or unknown drag ends before anything is sent", async () => {
    const { path, log } = recordingHelper();
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    await session.start("Test");
    await expect(session.act({ kind: "drag", from: { ref: 3 }, to: { x: 1, y: 2 } })).rejects.toThrow("same kind");
    await expect(session.act({ kind: "drag", from: { x: 1.5, y: 2 }, to: { x: 3, y: 4 } })).rejects.toThrow("non-negative integer");
    await expect(session.act({ kind: "drag", from: { ref: 99 }, to: { ref: 4 } })).rejects.toThrow("not on the current screen");
    await expect(session.act({ kind: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).resolves.toBeDefined();
    await expect(session.act({ kind: "scroll", ref: 3, direction: "down" })).resolves.toBeDefined();
    expect(acts(log)).toEqual([
      { kind: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
      { kind: "scroll", ref: "e2", direction: "down", amount: 3 },
    ]);
    await session.stop();
  });

  it("clicks fall back to a pointer click, and an app that comes forward or the user's own input is not a failure", async () => {
    const { path, log } = recordingHelper();
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    await session.start("Test");
    const forward = await session.act({ kind: "click", ref: 3, count: 2 }) as Record<string, any>;
    expect(forward.action).toMatchObject({ via: "pointer", selfActivated: true, restored: true });
    const mine = await session.act({ kind: "click", ref: 4, button: "right" }) as Record<string, any>;
    expect(mine.action.ok).toBe(true);
    await expect(session.act({ kind: "click", ref: 2 })).rejects.toThrow("brought itself to the front");
    expect(acts(log).map(a => [a.kind, a.ref, a.count, a.button, a.fallbackClick])).toEqual([
      ["press-action", "e2", 2, "left", true],
      ["press-action", "e3", 1, "right", true],
      ["press-action", "e1", 1, "left", true],
    ]);
    await session.stop();
  });

  it("says a button is back after the prompt its press brought up, so the press may have been swallowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cuhost-swallow-"));
    const path = join(dir, "h.mjs");
    writeFileSync(path, `
const env = { frontmostApp: "a", frontmostPid: 1, frontmostWindowId: 5, mouse: { x: 1, y: 2 } };
let stage = 0, buf = "";
const kids = () => stage === 1 ? [{ id: "r", role: "AXButton", title: "Reject" }] : [{ id: "s", role: "AXButton", title: "Sign up" }, { id: "t", role: "AXStaticText", value: "form " + stage }];
const tree = () => ({ id: "w", role: "AXWindow", children: kids() });
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
    if (req.op === "act") { stage += 1; result = { tree: tree(), env, envBefore: env, backgroundPreserved: true, via: "ax" }; }
    process.stdout.write(JSON.stringify({ version: 1, id: req.id, ok: true, result }) + "\\n");
  }
});
`);
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    await session.start("Test");
    const signUp = await session.act({ kind: "click", ref: 2 }) as Record<string, any>;
    expect(signUp.action.pressAgain).toBeUndefined();
    const reject = await session.act({ kind: "click", ref: 4 }) as Record<string, any>;
    expect(reject.action.pressAgain).toBe("Sign up");
    await session.stop();
  });

  it("sends a trimmed menu path, refuses an empty or long one, and reports a window lifted over the user's", async () => {
    const { path, log } = recordingHelper();
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    await session.start("Test");
    const r = await session.act({ kind: "menu", path: [" Sheet ", "Navigate", "To Next Sheet"] }) as Record<string, any>;
    expect(r.action).toMatchObject({ via: "menu", raisedOverUser: true, orderRestored: true });
    await expect(session.act({ kind: "menu", path: [] })).rejects.toThrow("menu needs path");
    await expect(session.act({ kind: "menu", path: ["a", "b", "c", "d", "e", "f", "g"] })).rejects.toThrow("menu needs path");
    expect(acts(log)).toEqual([{ kind: "menu", path: ["Sheet", "Navigate", "To Next Sheet"] }]);
    await session.stop();
  });
});

describe("ComputerHostSession steps", () => {
  it("runs steps in order, shows the screen once, and stops at the first failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cuhost-steps-"));
    const path = join(dir, "steps.mjs"), log = join(dir, "acts.jsonl");
    writeFileSync(path, `
import { appendFileSync } from "node:fs";
const env = { frontmostApp: "a", frontmostPid: 1, frontmostWindowId: 5, mouse: { x: 1, y: 2 } };
let value = "", buf = "";
const tree = () => ({ id: "w", role: "AXWindow", children: [
  { id: "f", role: "AXTextField", value, settable: true }, { id: "go", role: "AXButton", title: "Go" } ] });
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue;
    const req = JSON.parse(line); let result = { env };
    if (req.op === "launch") result = { pid: 42, env, backgroundPreserved: true };
    if (req.op === "observe") result = { tree: tree(), env };
    if (req.op === "act") {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(req.action) + "\\n");
      if (req.action.kind === "set-value") value = req.action.value;
      result = { tree: tree(), env, backgroundPreserved: true, via: "ax" };
    }
    process.stdout.write(JSON.stringify({ version: 1, id: req.id, ok: true, result }) + "\\n");
  }
});
`);
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    await session.start("Test");
    const ok = await session.steps([{ kind: "set-value", ref: 2, value: "hi" }, { kind: "click", ref: 3 }]) as Record<string, any>;
    expect(ok.steps.map((s: any) => s.action.effect)).toEqual(["changed", "no_change"]);
    expect(ok.observation).toMatchObject({ kind: "delta", text: '~ [2] textfield = "hi"' });
    const bad = await session.steps([{ kind: "set-value", ref: 2, value: "yo" }, { kind: "click", ref: 77 }, { kind: "press", key: "return" }]) as Record<string, any>;
    expect(bad).toMatchObject({ failed: { step: 2 }, skipped: 1, observation: { text: '~ [2] textfield = "yo"' } });
    expect(readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l).kind)).toEqual(["set-value", "press-action", "set-value"]);
    await session.stop();
  });
});

describe("ComputerHostSession.stop", () => {
  it("waits for a slow release (an app that has to be killed) before stopping the helper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cuhost-release-"));
    const path = join(dir, "slow.mjs"), log = join(dir, "ops.log");
    writeFileSync(path, `
import { appendFileSync } from "node:fs";
const env = { frontmostApp: "a", frontmostPid: 1, frontmostWindowId: 5, mouse: { x: 1, y: 2 } };
let buf = "";
process.on("SIGTERM", () => { appendFileSync(${JSON.stringify(log)}, "SIGTERM\\n"); process.exit(0); });
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const answer = (result) => process.stdout.write(JSON.stringify({ version: 1, id: req.id, ok: true, result }) + "\\n");
    if (req.op === "launch") answer({ pid: 42, env, backgroundPreserved: true });
    else if (req.op === "observe") answer({ tree: { id: "w", role: "AXWindow" }, env });
    // the helper's worst case: the quit grace, then a kill
    else if (req.op === "release") setTimeout(() => { appendFileSync(${JSON.stringify(log)}, "released\\n"); answer({ released: true }); }, 2600);
  }
});
`);
    const helper = new ComputerHostHelper(process.execPath, [path]);
    helper.start();
    const session = new ComputerHostSession(helper);
    await session.start("Test");
    const t0 = Date.now();
    await session.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["released", "SIGTERM"]);
  }, 10_000);
});

describe("HostObservation.label", () => {
  it("names an element by its own title or description, else the first text inside it", () => {
    const obs = new HostObservation();
    obs.accept({ id: "w", role: "AXWindow", children: [
      { id: "b1", role: "AXButton", desc: "보내기" },
      { id: "b2", role: "AXButton", children: [{ id: "g", role: "AXGroup", children: [{ id: "t", role: "AXStaticText", value: "  지수민\n님 " }] }] },
      { id: "b3", role: "AXButton" },
    ] }, true);
    expect(obs.label("b1")).toBe("보내기");
    expect(obs.label("b2")).toBe("지수민 님");
    expect(obs.label("b3")).toBeUndefined();
    expect(obs.label("nope")).toBeUndefined();
  });
});

describe("HostObservation.screen", () => {
  it("says which screen: the window title, with the first heading when it adds something", () => {
    const obs = new HostObservation();
    expect(obs.screen()).toBeUndefined();
    obs.accept({ id: "a", role: "AXApplication", children: [{ id: "w", role: "AXWindow", title: "Instagram", children: [
      { id: "h", role: "AXHeading", children: [{ id: "t", role: "AXStaticText", value: "받은  메시지함" }] },
      { id: "h2", role: "AXHeading", title: "추천" },
    ] }] }, true);
    expect(obs.screen()).toBe("Instagram · 받은 메시지함");
    obs.accept({ id: "w", role: "AXWindow", title: "메모 — 장보기", children: [{ id: "h", role: "AXHeading", title: "장보기" }] }, true);
    expect(obs.screen()).toBe("메모 — 장보기");
  });
});
