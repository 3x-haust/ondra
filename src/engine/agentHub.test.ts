// The Discord agent on two connected devices, each a whole copy of the app's modules (as in
// twoDevices.test.ts): one holds the bot's connection, the other takes it over only once the first let
// go, and the agent's work runs on the device that has the workspace.
import { reconcile } from "solid-js/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const A = "a".repeat(64);
const B = "b".repeat(64);

type Hear = (ev: Record<string, unknown>) => void;
interface Device {
  id: string;
  name: string;
  hear: Hear;
  inbound: Map<number, string>;
  m: Awaited<ReturnType<typeof load>>;
}
const devices = new Map<string, Device>();
let conns = 0;
/** what each device did with its Discord connection, in order: "B stop", "A start" */
const discord: string[] = [];
const later = (f: () => void) => setTimeout(f, 5);
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function net(me: string) {
  const dev = () => devices.get(me)!;
  const files = new Map<string, string>();
  return {
    inTauri: true,
    onRemote: async (fn: Hear) => ((dev().hear = fn), () => {}),
    onEvent: async () => () => {},
    remoteStart: async () => {},
    remoteAwake: async () => {},
    remoteDevices: async () => [],
    remoteForget: async () => [],
    remoteHostName: async () => dev().name,
    engineInfo: async () => ({ enginePath: "/e", engineVersion: "1", dataDir: "/d", home: "/h", browser: false, computer: false }),
    agentSpawn: () => new Promise(() => {}),
    discordStart: async () => void discord.push(`${dev().name} start`),
    discordStop: async () => void discord.push(`${dev().name} stop`),
    discordTokenHas: async () => true,
    fsRead: async (p: string) => ({ text: files.get(p) ?? "", binary: false }),
    fsWrite: async (p: string, text: string) => (files.set(p, text), text.length),
    remoteCmd: async (cmd: Record<string, unknown>) => {
      const them = devices.get(String(cmd.peer ?? ""));
      if (cmd.cmd === "dial" && them && !cmd.bye) {
        const conn = ++conns;
        them.inbound.set(conn, me);
        later(() => them.hear({ ev: "open", conn, device: { id: me, name: dev().name, both: true } }));
        later(() => dev().hear({ ev: "peer", peer: them.id, state: "ok" }));
      } else if (cmd.cmd === "peer-send" && them) {
        const conn = [...them.inbound].find(([, from]) => from === me)?.[0];
        const data = wire(cmd.data);
        if (conn) later(() => them.hear({ ev: "msg", conn, data }));
      } else if (cmd.cmd === "send") {
        const to = devices.get(dev().inbound.get(Number(cmd.conn)) ?? "");
        const data = wire(cmd.data);
        if (to) later(() => to.hear({ ev: "peer-msg", peer: me, data }));
      }
    },
  };
}

async function load() {
  return {
    store: await import("../state/store"),
    mirror: await import("../state/mirror"),
    remote: await import("./remote"),
    hosts: await import("./hosts"),
    hub: await import("./agentHub"),
    jobs: await import("./agentJobs"),
    tasks: await import("./tasks"),
    ways: await import("./agentWays"),
    discord: await import("./discord"),
  };
}

async function device(id: string, name: string, other: string, otherName: string): Promise<Device> {
  vi.resetModules();
  vi.doMock("../lib/native", async (orig) => ({ ...(await orig<object>()), ...net(id) }));
  vi.doMock("../ui/AccountPicker", () => ({ accountName: (a: { id: string }) => a.id, service: (p: string) => p }));
  const d: Device = { id, name, hear: () => {}, inbound: new Map(), m: undefined as never };
  devices.set(id, d);
  d.m = await load();
  const { setState, freshState } = d.m.store;
  setState(reconcile(freshState()));
  setState("settings", "hosts", [{ id: other, name: otherName }]);
  return d;
}

const wait = (f: () => void) => vi.waitFor(f, { timeout: 2000, interval: 20 });
let a: Device;
let b: Device;
const note = (id: string, text: string, at = 1) => ({ id, kind: "lesson" as const, text, at });

beforeAll(async () => {
  a = await device(A, "회사맥", B, "개인맥");
  b = await device(B, "개인맥", A, "회사맥");
  a.m.store.setState("spaces", [{ id: "work", label: "회사", folder: "~", rules: "" }]);
  b.m.store.setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }]);
  b.m.store.setState("projects", [{ id: "pomo", space: "home", name: "pomo", folder: "/b/pomo" }]);
  // B holds the agent: its memory, ways and routine, a channel that works in A's 회사
  b.m.store.setState("settings", "agent", {
    on: true,
    name: "메타몽",
    claimAt: 100,
    v: 2,
    voice: "짧게",
    places: [{ channel: "111111", label: "#회사일 · 서버", space: `h:${A}:work` }, { channel: "222222", space: "home", account: "b-acct" }],
  });
  b.m.store.setState("agentNotes", [note("n1", "민수는 존댓말")]);
  b.m.store.setState("routines", [{ id: "r1", space: "home", title: "아침", prompt: "날씨", when: { kind: "daily", at: "09:00" }, mode: "fresh", enabled: true, quiet: true, agent: { channel: "222222" }, createdAt: 1, updatedAt: 1, runs: 0 } as never]);
  a.m.store.setState("settings", "agent", { on: false, name: "메타몽", v: 2 });
  a.m.remote.initRemote();
  b.m.remote.initRemote();
  a.hear({ ev: "ready", id: A });
  b.hear({ ev: "ready", id: B });
  await wait(() => {
    expect(a.m.mirror.mirror.hosts[B]?.status).toBe("ok");
    expect(b.m.mirror.mirror.hosts[A]?.status).toBe("ok");
    expect(a.m.store.state.spaces.some((s) => s.id === `h:${B}:home`)).toBe(true);
  });
});
afterAll(() => vi.resetModules());

describe("one device holds the Discord connection", () => {
  it("the others know which one", async () => {
    await wait(() => expect(a.m.hub.hubElsewhere()).toBe(B));
    expect(a.m.hub.knownHub()).toBe(B);
    expect(a.m.store.state.settings.agent?.hub).toBe(B);
    expect(b.m.hub.knownHub()).toBeUndefined();
  });

  it("여기서 맡기: the hub lets go first, then this one connects with the agent's memory, ways, routines and places", async () => {
    discord.length = 0;
    await a.m.hub.takeHere();
    expect(discord).toEqual(["개인맥 stop", "회사맥 start"]);
    const ag = a.m.store.state.settings.agent!;
    expect(ag.on).toBe(true);
    expect(ag.hub).toBeUndefined();
    expect(ag.voice).toBe("짧게");
    // the places as this device names them: its own 회사, B's 개인 as B's tab here (B's account stays there)
    expect(ag.places).toEqual([
      { channel: "111111", label: "#회사일 · 서버", space: "work" },
      { channel: "222222", space: `h:${B}:home` },
    ]);
    expect(a.m.store.state.agentNotes?.map((n) => n.text)).toEqual(["민수는 존댓말"]);
    expect(a.m.store.state.routines?.map((r) => [r.id, r.space])).toEqual([["r1", "work"]]);
    // B let go, knows who holds it now, and its memory went
    const bg = b.m.store.state.settings.agent!;
    expect(bg.on).toBe(false);
    expect(bg.hub).toBe(A);
    await wait(() => expect(b.m.store.state.agentNotes).toEqual([]));
    expect(b.m.store.state.routines?.some((r) => r.id === "r1")).toBe(false);
    await wait(() => expect(b.m.hub.knownHub()).toBe(A));
  });

  it("can't take it while the device holding it isn't connected", async () => {
    a.m.mirror.setMirror("hosts", B, "status", "lost");
    b.m.store.setState("settings", "agent", "hub", A);
    // B's view: A holds it but isn't connected
    b.m.mirror.setMirror("hosts", A, "status", "lost");
    discord.length = 0;
    await expect(b.m.hub.takeHere()).rejects.toThrow();
    expect(discord).toEqual([]);
    expect(b.m.store.state.settings.agent?.on).toBe(false);
    b.m.mirror.setMirror("hosts", A, "status", "ok");
    a.m.mirror.setMirror("hosts", B, "status", "ok");
  });
});

describe("its work runs on the device that has the workspace", () => {
  it("a job asked from the hub in the other device's workspace is the agent's job there, and its thread is kept there", async () => {
    const id = a.m.tasks.createTask({ space: `h:${B}:home`, title: "타이머", topic: "pomo", ask: "타이머 고쳐 줘", project: `r:${B}:pomo`, agent: { channel: "222222" } });
    await wait(() => expect(b.m.store.taskById(id)?.agent?.channel).toBe("222222"));
    // hidden from B's own lists, in its agent tab
    expect(b.m.store.listed(b.m.store.taskById(id)!)).toBe(false);
    expect(b.m.store.agentListed(b.m.store.taskById(id)!)).toBe(true);
    // the hub sees it as the agent's work
    await wait(() => expect(a.m.jobs.agentTasks().some((t) => t.id === id && t.host === B)).toBe(true));
    a.m.jobs.setJobAgent(id, { thread: "333333", threadIn: "222222" });
    // at once on the hub, and stored where the job is
    expect(a.m.jobs.jobAgent(a.m.store.taskById(id))?.thread).toBe("333333");
    await wait(() => expect(b.m.store.taskById(id)?.agent?.thread).toBe("333333"));
  });

  it("its question shows on the hub, answered there it is answered on that device", async () => {
    const id = b.m.store.state.tasks.find((t) => t.agent)!.id;
    b.m.store.setState("decisions", (l) => [...l, { id: "dq", taskId: id, at: 1, question: "어느 쪽?", options: [{ id: "x", label: "왼쪽" }, { id: "y", label: "오른쪽" }], context: [], kind: "ask" }]);
    await wait(() => expect(a.m.jobs.decisionById("dq")?.question).toBe("어느 쪽?"));
    await a.m.tasks.decide("dq", "y");
    await wait(() => expect(b.m.store.state.decisions.some((d) => d.id === "dq")).toBe(false));
  });
});

describe("two devices both holding it (turned on apart)", () => {
  it("the later claim keeps it and takes the other's memory", async () => {
    b.m.store.setState("agentNotes", [note("n2", "서버 규칙")]);
    b.m.store.setState("settings", "agent", { on: true, name: "메타몽", v: 2, claimAt: Date.now() + 60_000 });
    discord.length = 0;
    await wait(() => expect(a.m.store.state.settings.agent?.on).toBe(false));
    expect(discord).toContain("회사맥 stop");
    expect(a.m.store.state.settings.agent?.hub).toBe(B);
    expect(b.m.store.state.agentNotes?.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    await wait(() => expect(a.m.store.state.agentNotes).toEqual([]));
  });
});
