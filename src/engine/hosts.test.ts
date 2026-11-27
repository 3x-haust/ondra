import { reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshState, projectsShown, setState, state, tasksShown } from "../state/store";
import type { Task } from "../state/types";
import { mirror, remoteProjectId } from "../state/mirror";

const sent: Record<string, unknown>[] = [];
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<object>()),
  remoteCmd: async (cmd: Record<string, unknown>) => void sent.push(cmd),
  remoteStart: async () => {},
  remoteHostName: async () => "Test Mac",
}));
const { dialBack, hideHostProject, onPeer, removeHost, showHostProject, connectHosts, disconnectHost, reconnect } = await import("./hosts");

const A = "a".repeat(64);
const B = "b".repeat(64);
const peer = (state: string, reason?: string, host = A, bye = false) => onPeer({ ev: "peer", peer: host, state, ...(reason ? { reason } : {}), ...(bye ? { bye } : {}) });
const said = (data: Record<string, unknown>, host = A) => onPeer({ ev: "peer-msg", peer: host, data });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sent.length = 0;
  setState(reconcile(freshState()));
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }]);
  setState("settings", "hosts", [{ id: A, name: "Studio" }, { id: B, name: "Air" }]);
  setState("settings", "computers", { home: { host: A } });
  setState("settings", "leaving", []);
  peer("ok");
  said({ t: "projects", list: [{ id: "app", name: "app", folder: "~/app", space: "개인" }, { id: "web", name: "web", folder: "~/web", space: "개인" }] });
  said({ t: "info", info: { spaces: [{ id: "home", label: "개인" }], accounts: [], pick: {} } });
  said({ t: "patch", tasks: [{ id: "t1", head: { id: "t1", space: "home", project: "app", title: "x", status: "running" }, from: 0, entries: [] }] });
});

const theirHome = `h:${A}:home`;

describe("each device's own workspaces", () => {
  it("a workspace of the same name stays two tabs: this device's and that device's, each with its own work", () => {
    setState("projects", [{ id: "mine", space: "home", name: "mine", folder: "~/mine" }]);
    setState("tasks", [{ ...(mirror.hosts[A].tasks[0] as Task), id: "local", host: undefined, project: "mine", space: "home", entries: [] }]);
    expect(state.spaces.map((s) => [s.id, s.label, s.host])).toEqual([["home", "개인", undefined], [theirHome, "개인", A]]);
    expect(projectsShown("home").map((p) => p.id)).toEqual(["mine"]);
    expect(projectsShown(theirHome).map((p) => p.id)).toEqual([`r:${A}:app`, `r:${A}:web`]);
    expect(tasksShown("home").map((t) => t.id)).toEqual(["local"]);
    expect(tasksShown(theirHome).map((t) => t.id)).toEqual(["t1"]);
  });
  it("asks that device for the work done in its workspaces too", () => {
    expect(sent.filter((c) => c.cmd === "peer-send").pop()).toMatchObject({ data: { t: "watch", sessions: true } });
  });
  it("a job lands in the tab of its own workspace there, project or not", () => {
    said({ t: "info", info: { spaces: [{ id: "home", label: "개인" }, { id: "w", label: "회사" }], accounts: [], pick: {} } });
    said({ t: "patch", tasks: [{ id: "t2", head: { id: "t2", space: "w", title: "y", status: "done" }, from: 0, entries: [] }] });
    expect(mirror.hosts[A].tasks.find((t) => t.id === "t2")?.space).toBe(`h:${A}:w`);
    expect(state.spaces.find((s) => s.id === `h:${A}:w`)?.label).toBe("회사");
  });
  it("follows that device: a workspace renamed or gone there is renamed or gone here", () => {
    said({ t: "info", info: { spaces: [{ id: "home", label: "집" }], accounts: [], pick: {} } });
    expect(state.spaces.find((s) => s.id === theirHome)?.label).toBe("집");
    setState("space", theirHome);
    said({ t: "info", info: { spaces: [{ id: "w", label: "회사" }], accounts: [], pick: {} } });
    expect(state.spaces.some((s) => s.id === theirHome)).toBe(false);
    expect(state.space).toBe(`h:${A}:w`);
  });
  it("moves what was merged before: an old link goes to that device's tab, an old empty tab goes", () => {
    setState("settings", "hostProjects", [{ host: A, id: "app", space: "home" }]);
    setState("spaces", (l) => [...l.filter((s) => s.id !== theirHome), { id: "old", label: "스튜디오", folder: "~", rules: "", only: true }, { id: "kept", label: "메모", folder: "~", rules: "", only: true }]);
    setState("projects", [{ id: "note", space: "kept", name: "note", folder: "~/note" }]);
    setState("space", "old");
    said({ t: "info", info: { spaces: [{ id: "home", label: "개인" }, { id: "s", label: "스튜디오" }], accounts: [], pick: {} } });
    expect(state.settings.hostProjects?.find((l) => l.id === "app")?.space).toBe(theirHome);
    expect(state.spaces.some((s) => s.id === "old")).toBe(false);
    // something of this device's is in it: it stays, this device's own now
    const kept = state.spaces.find((s) => s.id === "kept");
    expect([kept?.label, kept?.only, kept?.host]).toEqual(["메모", undefined, undefined]);
    expect(state.space).toBe(`h:${A}:s`);
  });
  it("work asked in that device's workspace runs there, in its own workspace", async () => {
    const { createTask } = await import("./tasks");
    const id = createTask({ space: theirHome, title: "x", topic: "", ask: "hi", accountId: "" });
    expect(state.tasks.some((t) => t.id === id)).toBe(false);
    const asked = sent.filter((c) => c.cmd === "peer-send").pop() as { data: { seq: number } };
    expect(asked).toMatchObject({ peer: A, data: { t: "call", fn: "create", args: [{ id, hostSpace: "home" }] } });
    said({ t: "ret", seq: asked.data.seq, value: id });
  });
  it("removing that device takes its tabs along", () => {
    setState("space", theirHome);
    removeHost(A);
    expect(state.spaces.map((s) => s.id)).toEqual(["home"]);
    expect(state.space).toBe("home");
  });
});

describe("removing a Mac this one works on", () => {
  it("cleans up everything of it here and tells it to forget this Mac", async () => {
    expect(state.settings.hostProjects?.length).toBe(2);
    removeHost(A);
    expect(state.settings.hosts?.map((h) => h.id)).toEqual([B]);
    expect(state.settings.hostProjects).toEqual([]);
    expect(state.settings.computers).toEqual({});
    expect(mirror.hosts[A]).toBeUndefined();
    expect(state.settings.leaving?.map((l) => l.id)).toEqual([A]);
    await flush();
    await flush();
    expect(sent).toContainEqual(expect.objectContaining({ cmd: "dial", peer: A, bye: true }));
  });
  it("is done once that device forgot this one (or never knew it)", () => {
    removeHost(A);
    peer("bye", undefined, A, true);
    expect(state.settings.leaving).toEqual([]);
    removeHost(B);
    peer("denied", "unknown", B, true);
    expect(state.settings.leaving).toEqual([]);
  });
  it("keeps the goodbye for later when that device can't be reached", () => {
    removeHost(A);
    peer("closed", "timed out", A, true);
    expect(state.settings.leaving?.map((l) => l.id)).toEqual([A]);
    // and never dials it as a Mac to work on again
    expect(state.settings.hosts?.some((h) => h.id === A)).toBe(false);
  });
  it("an older dial's word isn't the goodbye's: still to be told, and its connection let go", () => {
    removeHost(A);
    sent.length = 0;
    peer("ok");
    expect(state.settings.leaving?.map((l) => l.id)).toEqual([A]);
    expect(sent).toContainEqual({ cmd: "hangup", peer: A });
  });
  it("an older Ondra there lets the goodbye in as a visit: done here, the user is told", () => {
    removeHost(A);
    peer("ok", undefined, A, true);
    expect(state.settings.leaving).toEqual([]);
  });
  it("adding it again drops the goodbye", async () => {
    removeHost(A);
    const { addHost } = await import("./hosts");
    await addHost(`ondra://connect/${A}?code=abc&name=Studio`);
    expect(state.settings.leaving).toEqual([]);
  });
});

describe("that device removed this one", () => {
  it("revoked: it goes from here, no zombie left", () => {
    peer("denied", "revoked");
    expect(state.settings.hosts?.map((h) => h.id)).toEqual([B]);
    expect(state.settings.hostProjects).toEqual([]);
    expect(state.settings.computers).toEqual({});
    expect(mirror.hosts[A]).toBeUndefined();
    // nothing to tell it: it already forgot
    expect(state.settings.leaving).toEqual([]);
  });
  it("unknown or refused: the same", () => {
    peer("denied", "unknown");
    peer("denied", "refused", B);
    expect(state.settings.hosts).toEqual([]);
  });
  it("connections off there: kept, tried again later", () => {
    peer("denied", "off");
    expect(state.settings.hosts?.map((h) => h.id)).toEqual([A, B]);
    expect(mirror.hosts[A].status).toBe("denied");
  });
});

describe("disconnecting for now", () => {
  it("keeps the Mac and its projects, and doesn't dial it until reconnected", async () => {
    disconnectHost(A);
    expect(state.settings.hosts?.find((h) => h.id === A)?.off).toBe(true);
    expect(state.settings.hostProjects?.length).toBe(2);
    expect(mirror.hosts[A].status).toBe("off");
    sent.length = 0;
    await connectHosts();
    await flush();
    expect(sent.filter((c) => c.cmd === "dial" && c.peer === A)).toEqual([]);
    reconnect(A);
    expect(state.settings.hosts?.find((h) => h.id === A)?.off).toBeUndefined();
  });
  it("cut off there for now: not dialed again on its own", () => {
    peer("closed", "dropped");
    expect(mirror.hosts[A].status).toBe("lost");
    expect(mirror.hosts[A].reason).toBe("dropped");
  });
});

describe("a device that came in here (both ways)", () => {
  const dials = () => sent.filter((c) => c.cmd === "dial" && c.peer === A);
  it("connected already: left as it is", async () => {
    sent.length = 0;
    dialBack(A, "Studio");
    await flush();
    expect(dials()).toEqual([]);
  });
  it("lost here: dialed again now, without waiting for the next try", async () => {
    peer("closed", "timed out");
    sent.length = 0;
    dialBack(A, "Studio");
    await flush();
    await flush();
    expect(dials()).toHaveLength(1);
  });
  it("disconnected here for now: stays disconnected", async () => {
    disconnectHost(A);
    sent.length = 0;
    dialBack(A, "Studio");
    await flush();
    expect(dials()).toEqual([]);
  });
});

describe("hiding one of its projects", () => {
  it("takes it and its jobs off the list, and keeps it off when the list comes again", () => {
    hideHostProject(A, "app");
    expect(state.settings.hostProjects?.map((p) => p.id)).toEqual(["web"]);
    expect(mirror.hosts[A].tasks).toEqual([]);
    said({ t: "projects", list: [{ id: "app", name: "app", folder: "~/app", space: "개인" }, { id: "web", name: "web", folder: "~/web", space: "개인" }] });
    expect(state.settings.hostProjects?.map((p) => p.id)).toEqual(["web"]);
    // a job of it sent again (one this Mac asked for) stays off too
    said({ t: "patch", tasks: [{ id: "t1", head: { id: "t1", space: "home", project: "app", title: "x", status: "running" }, from: 0, entries: [] }] });
    expect(mirror.hosts[A].tasks).toEqual([]);
    // no longer kept: not asked for
    expect(sent.filter((c) => c.cmd === "peer-send").pop()).toMatchObject({ data: { t: "watch", projects: ["web"] } });
  });
  it("shows it again", () => {
    hideHostProject(A, "app");
    showHostProject(A, "app");
    expect(state.settings.hostProjects?.map((p) => p.id).sort()).toEqual(["app", "web"]);
    expect(state.settings.hosts?.find((h) => h.id === A)?.hidden).toEqual([]);
    expect(remoteProjectId(A, "app")).toBe(`r:${A}:app`);
  });
});
