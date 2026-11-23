import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import computer from "../../extensions/computer";

// The OS boundary only: protocol replies stand in for live AX windows. These
// tests prove the tool's approval contract, not macOS secure-field support.
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cu-secure-")));
  const bin = join(dir, "helper.mjs"), log = join(dir, "requests.jsonl"), changed = join(dir, "changed");
  writeFileSync(log, "");
  writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
let secure = false, selected = false, held, filled = false;
const tree = () => ({id: "w", role: "AXWindow", children: [
  {id: "f", role: "AXTextField", subrole: "AXSecureTextField", secure: true},
  {id: "b", role: "AXButton", title: filled ? "Continue" : "Allow", actions: ["AXPress"]}
]});
for await (const line of createInterface({input: process.stdin})) {
  const req = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  let result = {}, error;
  switch (req.op) {
    case "launch": secure = req.app === "Secure"; result = {pid: 42, backgroundPreserved: true}; break;
    case "observe": result = {tree: tree()}; break;
    case "targets": result = {targets: [{ref: "window-1", pid: 43, app: "Agent", title: "Permission", role: "AXSheet"}]}; break;
    case "target": selected = true; secure = true; result = {pid: 43, tree: tree(), sensitive: true}; break;
    case "resume": selected = false; result = {resumed: true}; break;
    case "prepare":
      if (req.action.kind === "fill-secret" && req.action.ref !== "f") error = "NOT_SECURE_FIELD";
      else if (req.action.kind === "fill-secret" && !process.env.ONDRA_SECRET_NAMES.split(",").includes(req.action.secret)) error = "SECRET_UNAVAILABLE";
      else if (secure || req.action.kind === "fill-secret") {
        held = req.action;
        result = {required: true, approval: "once", summary: "Agent · Permission · " + req.action.kind + (req.action.secret ? " · " + req.action.secret : "")};
      } else result = {required: false};
      break;
    case "commit-approval":
      if (!held || existsSync(${JSON.stringify(changed)})) error = "APPROVAL_TARGET_CHANGED";
      else { filled = held.kind === "fill-secret"; result = {tree: tree(), via: filled ? "secure-ax" : "ax", sensitive: true, backgroundPreserved: true}; held = undefined; }
      break;
    case "cancel-approval": held = undefined; break;
    case "act": secure = true; result = {tree: tree(), backgroundPreserved: true}; break;
    case "look": error = "SECURE_CAPTURE_REFUSED"; break;
  }
  console.log(JSON.stringify(error ? {version: 1, id: req.id, ok: false, error: {code: error, message: "nothing returned"}} : {version: 1, id: req.id, ok: true, result}));
}
`);
  chmodSync(bin, 0o755);
  // A separate, empty artifact directory makes a refused look's lack of files observable.
  const art = realpathSync(mkdtempSync(join(tmpdir(), "cu-secure-art-")));
  vi.stubEnv("ONDRA_COMPUTER_HOST", "1");
  vi.stubEnv("ONDRA_COMPUTER_HOST_BIN", bin);
  vi.stubEnv("APP_WORKER_ID", "captain:home~@agent:123");
  vi.stubEnv("APP_ARTIFACTS_DIR", art);
  vi.stubEnv("ONDRA_SECRET_NAMES", "LOGIN_SECRET");
  vi.stubEnv("LOGIN_SECRET", "q!");
  vi.stubEnv("ONDRA_COMPUTER_EVALUATION_MODE", undefined);
  let tool: any;
  const hooks = new Map<string, (...args: any[]) => any>();
  computer({ registerTool: (t: any) => tool = t, on: (name: string, fn: any) => hooks.set(name, fn) });
  hooks.get("session_start")!();
  const call = (input: unknown, confirm?: (...args: any[]) => Promise<boolean>, signal?: AbortSignal) =>
    tool.execute("call", input, signal, undefined, confirm ? { hasUI: true, ui: { confirm } } : { hasUI: false });
  const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x));
  return { call, requests, log, changed, art, close: () => hooks.get("session_shutdown")!() };
}

const fill = { action: "act", input: { kind: "fill-secret", ref: 2, secret: "LOGIN_SECRET" } };
let current: ReturnType<typeof fixture>;
beforeEach(() => { current = fixture(); });
afterEach(async () => { await current.close(); vi.unstubAllEnvs(); });

describe("computer secure input", () => {
  it("confirms a saved name, sends only that name, and distinguishes delivery from login", async () => {
    await current.call({action: "start", app: "Secure"});
    const confirm = vi.fn(async () => true);
    const result = await current.call(fill, confirm);
    expect(confirm).toHaveBeenCalledWith("보안 동작을 허용할까요?", "Agent · Permission · fill-secret · LOGIN_SECRET", {signal: undefined, timeout: 120_000});
    expect(result.content[0].text).toContain("password replacement accepted");
    expect(result.content[0].text).toContain("Login or approval is not yet verified");
    expect(current.requests().find(r => r.op === "prepare").action).toEqual({kind: "fill-secret", ref: "f", secret: "LOGIN_SECRET"});
    expect(current.requests().find(r => r.op === "commit-approval")).toEqual({id: "4", op: "commit-approval", approval: "once"});
    expect(JSON.stringify([result, confirm.mock.calls, current.requests()])).not.toContain("q!");
  });

  it.each(["no-ui", "denied", "cancelled"])("does not execute an unapproved replacement (%s)", async mode => {
    await current.call({action: "start", app: "Secure"});
    const controller = new AbortController();
    const confirm = mode === "no-ui" ? undefined : async () => {
      if (mode === "cancelled") controller.abort();
      return mode === "cancelled";
    };
    await expect(current.call(fill, confirm, controller.signal)).rejects.toThrow(mode === "no-ui" ? "APPROVAL_UNAVAILABLE" : mode === "denied" ? "APPROVAL_DENIED" : "cancelled");
    expect(current.requests().filter(r => ["act", "commit-approval"].includes(r.op))).toEqual([]);
    expect(current.requests().at(-1).op).toBe("cancel-approval");
  });

  it("refuses raw text, missing secrets and non-password refs", async () => {
    await current.call({action: "start", app: "Secure"});
    const confirm = vi.fn(async () => true);
    await expect(current.call({action: "act", input: {...fill.input, text: "raw"}}, confirm)).rejects.toThrow("never text or value");
    await expect(current.call({action: "act", input: {...fill.input, secret: "MISSING"}}, confirm)).rejects.toThrow("SECRET_UNAVAILABLE");
    await expect(current.call({action: "act", input: {...fill.input, ref: 3}}, confirm)).rejects.toThrow("NOT_SECURE_FIELD");
    expect(confirm).not.toHaveBeenCalled();
    expect(current.requests().some(r => r.op === "commit-approval")).toBe(false);
  });

  it("asks again for each batch step and stops on refusal, including a prompt opened in app mode", async () => {
    await current.call({action: "start", app: "Ordinary"});
    const confirm = vi.fn(async () => false);
    const result = await current.call({action: "act", steps: [{kind: "click", ref: 3}, {kind: "click", ref: 3}, fill.input]}, confirm);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("2. click failed: APPROVAL_DENIED");
    expect(result.content[0].text).toContain("the 1 after it were not run");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(current.requests().filter(r => r.op === "act")).toHaveLength(1);
    expect(current.requests().filter(r => r.op === "commit-approval")).toHaveLength(0);
  });

  it("does not retry a changed target using ordinary act", async () => {
    await current.call({action: "start", app: "Secure"});
    await expect(current.call(fill, async () => { writeFileSync(current.changed, "changed"); return true; })).rejects.toThrow("APPROVAL_TARGET_CHANGED");
    expect(current.requests().filter(r => r.op === "commit-approval")).toHaveLength(1);
    expect(current.requests().filter(r => r.op === "act")).toHaveLength(0);
  });

  it("keeps the requesting app alive across approval selection and return", async () => {
    await current.call({action: "start", app: "Ordinary"});
    const listing = await current.call({action: "targets", app: "Agent"});
    expect(JSON.parse(listing.content[0].text).targets[0].ref).toBe("window-1");
    await current.call({action: "target", ref: "window-1"});
    await current.call(fill, async () => true);
    await current.call({action: "resume"});
    expect(current.requests().filter(r => r.op === "release")).toEqual([]);
    expect(current.requests().at(-1)).toMatchObject({op: "observe", pid: 42});
    expect(current.requests().find(r => r.op === "prepare").pid).toBe(43);
    await current.call({action: "stop"});
    expect(current.requests().filter(r => r.op === "release").map(r => r.pid)).toEqual([42]);
  });

  it("never stores or returns a refused sensitive capture", async () => {
    await current.call({action: "start", app: "Secure"});
    await expect(current.call({action: "look"})).rejects.toThrow("SECURE_CAPTURE_REFUSED");
    expect(readdirSync(current.art)).toEqual([]);
  });
});
