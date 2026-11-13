import { reconcile } from "solid-js/store";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshState, setState, state, taskById } from "../state/store";
import type { Task } from "../state/types";

// the helper, as engine/remote.ts hears it: events in, commands out
let hear: (ev: Record<string, unknown>) => void = () => {};
const sent: Record<string, unknown>[] = [];
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<object>()),
  inTauri: true,
  onRemote: async (fn: typeof hear) => ((hear = fn), () => {}),
  remoteCmd: async (cmd: Record<string, unknown>) => void sent.push(cmd),
  remoteStart: async () => {},
  remoteStop: async () => {},
  remoteAwake: async () => {},
  remoteDevices: async () => [],
  remoteHostName: async () => "Test Mac",
}));
// a picker (UI): only its names are used here
vi.mock("../ui/AccountPicker", () => ({ accountName: (a: { id: string }) => a.id, service: (p: string) => p }));
const { initRemote, setDeviceSpaces } = await import("./remote");

const DEV = "d".repeat(64);
const job = (id: string, extra: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "", title: id, ask: "", cwd: "/", status: "done",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
let seq = 0;
/** a call from that Mac; its answer */
async function call(fn: string, args: unknown[]) {
  const n = ++seq;
  hear({ ev: "msg", conn: 1, data: { t: "call", seq: n, fn, args } });
  for (let i = 0; i < 5; i++) await flush();
  const ret = sent.map((c) => c.data as Record<string, unknown> | undefined).find((d) => d?.t === "ret" && d.seq === n);
  return ret as { value?: unknown; error?: string } | undefined;
}

beforeAll(() => initRemote());
beforeEach(() => {
  sent.length = 0;
  setState(reconcile(freshState()));
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }, { id: "work", label: "회사", folder: "~", rules: "" }]);
  setState("projects", [{ id: "app", space: "home", name: "app", folder: "/tmp/app" }, { id: "secret", space: "home", name: "secret", folder: "/tmp/secret" }, { id: "payroll", space: "work", name: "payroll", folder: "/tmp/payroll" }]);
  setState("tasks", [job("inApp", { project: "app" }), job("inSecret", { project: "secret" }), job("mine", { from: { device: DEV, space: "" } }), job("inPayroll", { project: "payroll", space: "work" })]);
  hear({ ev: "close", conn: 1 });
  hear({ ev: "open", conn: 1, device: { id: DEV, name: "Air" } });
  hear({ ev: "msg", conn: 1, data: { t: "watch", projects: ["app", "payroll"] } });
});

describe("calls from a Mac allowed in", () => {
  it("act on the jobs it may reach", async () => {
    expect(await call("renameTask", ["inApp", "renamed"])).toMatchObject({ value: null });
    expect(taskById("inApp")?.title).toBe("renamed");
    expect((await call("archiveTask", ["mine"]))?.error).toBeUndefined();
    expect(taskById("mine")?.archived).toBe(true);
  });
  it("are refused on any other job, and the job is untouched", async () => {
    expect((await call("removeTask", ["inSecret"]))?.error).toBeTruthy();
    expect(taskById("inSecret")).toBeDefined();
    expect((await call("renameTask", ["nope", "x"]))?.error).toBeTruthy();
    expect((await call("eval", ["inApp"]))?.error).toMatch(/unknown/);
  });
  it("only in the workspaces it was given", async () => {
    expect((await call("renameTask", ["inPayroll", "mine now"]))?.error).toBeUndefined();
    setDeviceSpaces(DEV, ["home"]);
    expect((await call("renameTask", ["inPayroll", "again"]))?.error).toBeTruthy();
    expect(taskById("inPayroll")?.title).toBe("mine now");
    // a new job or project there is refused too; here it's fine
    expect((await call("create", [{ id: "n1", title: "n", ask: "do", project: "payroll" }]))?.error).toBeTruthy();
    expect((await call("addProject", ["/tmp/new"]))?.value).toBeTruthy();
    expect(state.projects?.find((p) => p.folder === "/tmp/new")?.space).toBe("home");
    setDeviceSpaces(DEV, undefined);
  });
  it("answer, hand over and read secrets only for what it may reach", async () => {
    setState("decisions", [
      { id: "dApp", taskId: "inApp", at: 1, question: "?", options: [{ id: "a", label: "A" }], context: [], kind: "ask" },
      { id: "dSecret", taskId: "inSecret", at: 1, question: "?", options: [{ id: "a", label: "A" }], context: [], kind: "ask" },
    ] as never);
    expect((await call("decide", ["dSecret", "a"]))?.error).toBeTruthy();
    expect(state.decisions.some((d) => d.id === "dSecret")).toBe(true);
    expect((await call("handOn", ["inApp", "inSecret"]))?.error).toBeTruthy();
    expect((await call("secretList", ["secret"]))?.error).toBeTruthy();
    expect((await call("secretSet", [{ project: "secret", name: "K", value: "v" }]))?.error).toBeTruthy();
    expect((await call("togglePin", ["inSecret"]))?.error).toBeTruthy();
    expect((await call("togglePin", ["inApp"]))?.error).toBeUndefined();
    expect(taskById("inApp")?.pinned).toBe(true);
  });
  it("never reach a project shown here from a third Mac", async () => {
    expect((await call("create", [{ id: "n2", title: "n", ask: "do", project: `r:${"c".repeat(64)}:app` }]))?.error).toBeTruthy();
  });
});
