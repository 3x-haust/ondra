import { reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshState, setState, state } from "../state/store";
import { mirror, remoteProjectId } from "../state/mirror";

const sent: Record<string, unknown>[] = [];
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<object>()),
  remoteCmd: async (cmd: Record<string, unknown>) => void sent.push(cmd),
  remoteStart: async () => {},
  remoteHostName: async () => "Test Mac",
}));
const { hideHostProject, onPeer, removeHost, showHostProject, connectHosts, disconnectHost, reconnect } = await import("./hosts");

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
  said({ t: "patch", tasks: [{ id: "t1", head: { id: "t1", space: "home", project: "app", title: "x", status: "running" }, from: 0, entries: [] }] });
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
  it("is done once that Mac forgot this one (or never knew it)", () => {
    removeHost(A);
    peer("bye", undefined, A, true);
    expect(state.settings.leaving).toEqual([]);
    removeHost(B);
    peer("denied", "unknown", B, true);
    expect(state.settings.leaving).toEqual([]);
  });
  it("keeps the goodbye for later when that Mac can't be reached", () => {
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

describe("that Mac removed this one", () => {
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
