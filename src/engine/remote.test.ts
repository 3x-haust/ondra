import { reconcile } from "solid-js/store";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshState, setState, state, taskById } from "../state/store";
import type { Task } from "../state/types";
import { engine } from "./rpc";
import { onPeer } from "./hosts";
import { mirror, setMirror } from "../state/mirror";

// the helper, as engine/remote.ts hears it: events in, commands out
let hear: (ev: Record<string, unknown>) => void = () => {};
const sent: Record<string, unknown>[] = [];
const forgot: string[] = [];
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<object>()),
  inTauri: true,
  onRemote: async (fn: typeof hear) => ((hear = fn), () => {}),
  remoteCmd: async (cmd: Record<string, unknown>) => void sent.push(cmd),
  remoteStart: async () => {},
  remoteAwake: async () => {},
  remoteDevices: async () => [],
  remoteForget: async (id: string) => {
    if (id === "f".repeat(64)) throw new Error("disk full");
    return forgot.push(id), [];
  },
  remoteHostName: async () => "Test Mac",
}));
// a picker (UI): only its names are used here
vi.mock("../ui/AccountPicker", () => ({ accountName: (a: { id: string }) => a.id, service: (p: string) => p }));
const { initRemote, removeDevice, setDeviceSpaces } = await import("./remote");

const DEV = "d".repeat(64);
const job = (id: string, extra: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "", title: id, ask: "", cwd: "/", status: "done",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
let seq = 0;
/** a call from that device; its answer */
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

describe("Windows projects mirrored to a Mac", () => {
  it("discovers the project, mirrors usable page paths and reads back the relative image", async () => {
    const win = vi.spyOn(engine, "info", "get").mockReturnValue({ ...engine.info, home: String.raw`C:\Users\me` });
    try {
      const dir = String.raw`D:\Work\그림`;
      setState("projects", [{ id: "app", name: "그림", space: "work", folder: dir }]);
      setState("tasks", [job("inApp", { cwd: dir, project: "app", space: "work", entries: [
        { id: "e", at: 1, kind: "block", block: { type: "page", path: `${dir}\\index.html` } },
        { id: "f", at: 1, kind: "text", text: String.raw`![shot](C:\Shots\밖.png)` },
      ] })]);
      hear({ ev: "msg", conn: 1, data: { t: "projects" } });
      const packets = () => sent.map((c) => c.data as { t?: string; list?: unknown[]; tasks?: { id: string; head?: Partial<Task>; entries: Task["entries"] }[] } | undefined);
      const projects = packets().find((m) => m?.t === "projects" && (m.list?.[0] as { name?: string })?.name === "그림")!;
      expect(projects.list).toEqual([{ id: "app", name: "그림", space: "회사", spaceId: "work", folder: "/@drive/D/Work/그림" }]);
      setState("settings", "hosts", [{ id: DEV, name: "PC" }]);
      onPeer({ ev: "peer", peer: DEV, state: "ok" });
      onPeer({ ev: "peer-msg", peer: DEV, data: projects });
      await vi.waitFor(() => expect(packets().some((m) => m?.t === "info")).toBe(true));
      onPeer({ ev: "peer-msg", peer: DEV, data: packets().find((m) => m?.t === "info")! });
      // in that device's own 회사 tab here, not this device's
      expect(state.settings.hostProjects).toContainEqual({ host: DEV, id: "app", space: `h:${DEV}:work`, name: "그림", folder: "/@drive/D/Work/그림" });
      await vi.waitFor(() => expect(packets().some((m) => m?.t === "patch" && m.tasks?.some((j) => j.head?.cwd === "/@drive/D/Work/그림"))).toBe(true));
      for (const m of packets().filter((m) => m?.t === "patch")) onPeer({ ev: "peer-msg", peer: DEV, data: m });
      expect(mirror.hosts[DEV].tasks[0].entries).toMatchObject([{ block: { path: "/@drive/D/Work/그림/index.html" } }, { text: "![shot](/@drive/C/Shots/밖.png)" }]);
      expect(await call("far.read", ["/@drive/D/Work/그림/img/a.png"])).toHaveProperty("value.text");
      // The host keeps its actual path, not the mirror's spelling.
      expect(taskById("inApp")!.cwd).toBe(dir);
    } finally {
      win.mockRestore();
      setMirror("hosts", DEV, undefined!);
    }
  });
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
    const before = state.projects!.map((p) => p.id);
    expect((await call("addProject", ["/tmp/new"]))?.error).toBeTruthy();
    expect((await call("addProject", ["/tmp/payroll", "개인"]))?.error).toBeTruthy();
    expect((await call("addProject", ["/tmp/app", "개인"]))?.value).toBe("app");
    expect(state.projects!.map((p) => p.id)).toEqual(before);
    setDeviceSpaces(DEV, undefined);
  });
  it("keeps a new job in its allowed workspace and only inherits folders from visible jobs", async () => {
    setDeviceSpaces(DEV, ["home"]);
    try {
      const id = "workspace-job";
      await call("create", [{ id, title: "notes", ask: "notes", project: "app", follows: "inSecret", after: ["inApp", "inSecret"], reach: ["회사"] }]);
      const task = taskById(id)!;
      expect(task.cwd).toBe("/tmp/app");
      expect(task.after).toEqual(["inApp"]);
      expect(task.reach).toBeUndefined();
      expect(task.follows).toBeUndefined();
    } finally {
      setDeviceSpaces(DEV, undefined);
    }
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
    expect((await call("ghWatch", ["secret", "issue", ""]))?.error).toBeTruthy();
    expect((await call("far.files", ["/tmp/secret"]))?.error).toBeTruthy();
    setDeviceSpaces(DEV, ["home"]);
    expect((await call("far.files", ["/tmp/payroll"]))?.error).toBeTruthy();
    setDeviceSpaces(DEV, undefined);
    expect((await call("togglePin", ["inApp"]))?.error).toBeUndefined();
    expect(taskById("inApp")?.pinned).toBe(true);
  });
  it("never reach a project shown here from a third Mac", async () => {
    expect((await call("create", [{ id: "n2", title: "n", ask: "do", project: `r:${"c".repeat(64)}:app` }]))?.error).toBeTruthy();
  });
});

describe("a connection goes both ways", () => {
  const PC = "e".repeat(64);
  const allowed = () => hear({ ev: "devices", list: [{ id: PC, name: "PC", addedAt: 1, lastSeen: 1 }] });
  beforeEach(() => {
    forgot.length = 0;
    hear({ ev: "devices", list: [] });
  });

  it("a device that comes in and lets this one in too is used from here as well", async () => {
    hear({ ev: "open", conn: 2, device: { id: PC, name: "PC", both: true } });
    expect(state.settings.hosts).toEqual([{ id: PC, name: "PC", back: true }]);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ cmd: "dial", peer: PC, them: "PC", trust: true })));
    hear({ ev: "close", conn: 2 });
  });
  it("an older Ondra coming in (one way only) isn't dialed", () => {
    // the one in beforeEach says nothing of both
    expect(state.settings.hosts ?? []).toEqual([]);
  });
  it("a device removed here and not told yet stays removed when it comes in", () => {
    setState("settings", "leaving", [{ id: PC, name: "PC", at: Date.now() }]);
    hear({ ev: "open", conn: 2, device: { id: PC, name: "PC", both: true } });
    expect(state.settings.hosts ?? []).toEqual([]);
    hear({ ev: "close", conn: 2 });
  });
  it("its goodbye takes it out of both lists", () => {
    setState("settings", "hosts", [{ id: PC, name: "PC" }]);
    hear({ ev: "bye", device: { id: PC, name: "PC" } });
    expect(state.settings.hosts).toEqual([]);
    expect(state.settings.leaving ?? []).toEqual([]);
  });
  it("제거 here goes both ways: not used, not let in, and it is told", async () => {
    setState("settings", "hosts", [{ id: PC, name: "PC" }]);
    allowed();
    await removeDevice(PC);
    expect(state.settings.hosts).toEqual([]);
    expect(forgot).toEqual([PC]);
    expect(state.settings.leaving?.map((l) => l.id)).toEqual([PC]);
  });
  it("제거 of a device that only came in here: it is told too", async () => {
    allowed();
    expect(await removeDevice(PC)).toBe(true);
    expect(forgot).toEqual([PC]);
    expect(state.settings.leaving?.map((l) => l.id)).toEqual([PC]);
  });
  it("제거 that can't stop it coming in changes nothing, and says so", async () => {
    const F = "f".repeat(64);
    setState("settings", "hosts", [{ id: F, name: "PC" }]);
    expect(await removeDevice(F)).toBe(false);
    expect(state.settings.hosts).toEqual([{ id: F, name: "PC" }]);
    expect(state.settings.leaving ?? []).toEqual([]);
  });
  it("cut off as removed there: not let in here either; a link that ran out is no removal", async () => {
    setState("settings", "hosts", [{ id: PC, name: "PC" }]);
    allowed();
    onPeer({ ev: "peer", peer: PC, state: "denied", reason: "revoked" });
    await vi.waitFor(() => expect(forgot).toEqual([PC]));
    forgot.length = 0;
    setState("settings", "hosts", [{ id: PC, name: "PC", pair: "abc" }]);
    onPeer({ ev: "peer", peer: PC, state: "denied", reason: "unknown" });
    await flush();
    expect(state.settings.hosts).toEqual([]);
    expect(forgot).toEqual([]);
  });
});
