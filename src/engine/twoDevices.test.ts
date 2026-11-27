// Two devices connected both ways, each a whole copy of the app's modules (its own store, its own
// remote.ts and hosts.ts); only the network helper between them is played here. What the user does on
// one shows on the other as it would between two real computers.
import { reconcile } from "solid-js/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const A = "a".repeat(64);
const B = "b".repeat(64);

type Hear = (ev: Record<string, unknown>) => void;
interface Device {
  id: string;
  name: string;
  hear: Hear;
  /** connections into this device, by conn number: who came in */
  inbound: Map<number, string>;
  m: Awaited<ReturnType<typeof load>>;
}
const devices = new Map<string, Device>();
let conns = 0;
/** what goes over the network arrives a moment later, as JSON */
const later = (f: () => void) => setTimeout(f, 5);
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function net(me: string) {
  const dev = () => devices.get(me)!;
  return {
    inTauri: true,
    onRemote: async (fn: Hear) => ((dev().hear = fn), () => {}),
    remoteStart: async () => {},
    remoteAwake: async () => {},
    remoteDevices: async () => [],
    remoteForget: async () => [],
    remoteHostName: async () => dev().name,
    engineInfo: async () => ({ enginePath: "/e", engineVersion: "1", dataDir: "/d", home: "/h", browser: false, computer: false }),
    // main never gets an engine here: its answer is played by the test on that device
    agentSpawn: () => new Promise(() => {}),
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
    captain: await import("./captain"),
    view: await import("../state/viewState"),
    drafts: await import("../state/drafts"),
    shared: await import("../state/shared"),
    settings: await import("./appSettings"),
    tasks: await import("./tasks"),
    rpc: await import("./rpc"),
  };
}

async function device(id: string, name: string, other: string, otherName: string): Promise<Device> {
  vi.resetModules();
  vi.doMock("../lib/native", async (orig) => ({ ...(await orig<object>()), ...net(id) }));
  vi.doMock("../ui/AccountPicker", () => ({ accountName: (a: { id: string }) => a.id, service: (p: string) => p }));
  // a settings tab as this device writes it (the real one reads the settings pages' UI helpers):
  // its own routines, in the language asked for
  vi.doMock("../views/farPages", async () => {
    const { state } = await import("../state/store");
    const { inLang, t } = await import("../i18n");
    return { farPage: async (tab: string, l: "ko" | "en") => inLang(l, () => ({ groups: [{ title: `${tab} · ${t("모든 작업")}`, rows: (state.routines ?? []).map((r) => ({ title: r.title })) }] })) };
  });
  const d: Device = { id, name, hear: () => {}, inbound: new Map(), m: undefined as never };
  devices.set(id, d);
  d.m = await load();
  const { setState, freshState } = d.m.store;
  setState(reconcile(freshState()));
  setState("settings", "hosts", [{ id: other, name: otherName }]);
  return d;
}

const wait = (f: () => void) => vi.waitFor(f, { timeout: 1500, interval: 20 });
let a: Device;
let b: Device;
/** B's 개인 workspace, as A shows it */
const theirs = `h:${B}:home`;

beforeAll(async () => {
  a = await device(A, "노트북", B, "맥북프로");
  b = await device(B, "맥북프로", A, "노트북");
  b.m.store.setState("projects", [{ id: "pomo", space: "home", name: "pomo", folder: "/b/pomo" }]);
  a.m.store.setState("projects", [{ id: "mine", space: "home", name: "mine", folder: "/a/mine" }]);
  a.m.remote.initRemote();
  b.m.remote.initRemote();
  await wait(() => {
    expect(a.m.mirror.mirror.hosts[B]?.status).toBe("ok");
    expect(b.m.mirror.mirror.hosts[A]?.status).toBe("ok");
    expect(a.m.store.state.spaces.some((s) => s.id === theirs)).toBe(true);
  });
});
afterAll(() => vi.resetModules());

describe("the main chat is one chat on both devices", () => {
  it("what was typed on B's main shows in B's workspace on A, live", async () => {
    b.m.captain.throwThought("내일 배포 준비해 줘", "home");
    await wait(() => expect(a.m.shared.chatIn(theirs).map((m) => m.text)).toContain("내일 배포 준비해 줘"));
    // B's main answers there: the words come over as it writes them, then the answer
    // (no engine here: the reply is played)
    const reply = b.m.store.state.captain[b.m.store.state.captain.length - 1];
    expect(reply.from).toBe("captain");
    b.m.store.setState("captain", (m) => m.id === reply.id, { pending: false, error: undefined, reply: "준비할게요" });
    await wait(() => expect(a.m.shared.chatIn(theirs).find((m) => m.id === reply.id)?.reply).toBe("준비할게요"));
  });

  it("what A types in B's workspace goes to B's main and shows on both at once", async () => {
    const replyId = a.m.captain.throwThought("테스트도 돌려 줘", theirs);
    // shown on A before B even hears it
    expect(a.m.shared.chatIn(theirs).some((m) => m.text === "테스트도 돌려 줘")).toBe(true);
    await wait(() => {
      const mine = b.m.store.state.captain.filter((m) => m.space === "home" && !m.project);
      expect(mine.some((m) => m.from === "me" && m.text === "테스트도 돌려 줘")).toBe(true);
      // B's main answers under the line A shows
      expect(mine[mine.length - 1].id).toBe(replyId);
    });
    // nothing of it in A's own main, and A's own workspace chat is still its own
    expect(a.m.store.state.captain.some((m) => m.text === "테스트도 돌려 줘")).toBe(false);
    expect(a.m.shared.chatIn("home").some((m) => m.text === "테스트도 돌려 줘")).toBe(false);
    // once seen, the line isn't doubled
    await wait(() => expect(a.m.shared.chatIn(theirs).filter((m) => m.text === "테스트도 돌려 줘")).toHaveLength(1));
  });

  it("a project's chat of B is the same chat on A", async () => {
    b.m.captain.throwThought("타이머 고쳐 줘", "home", { project: "pomo" });
    await wait(() => expect(a.m.shared.chatIn(theirs, `r:${B}:pomo`).map((m) => m.text)).toContain("타이머 고쳐 줘"));
    expect(a.m.shared.chatIn(theirs).map((m) => m.text)).not.toContain("타이머 고쳐 줘");
  });

  it("main's question on B shows in its chat on A and A's answer goes back to B", async () => {
    const key = "home";
    b.m.store.setState("decisions", (l) => [...l, { id: "q1", taskId: `main:${key}`, at: 1, question: "어느 브랜치?", options: [{ id: "x", label: "main" }, { id: "y", label: "dev" }], context: [], kind: "ask" }]);
    await wait(() => expect(a.m.store.allDecisions().find((d) => d.id === "q1")?.taskId).toBe(`main:${theirs}`));
    // never A's own main's
    expect(a.m.store.allDecisions().some((d) => d.taskId === "main:home")).toBe(false);
    await a.m.tasks.decide("q1", "y");
    await wait(() => expect(b.m.store.state.decisions.some((d) => d.id === "q1")).toBe(false));
    await wait(() => expect(b.m.store.state.captain.some((m) => m.from === "me" && m.text?.endsWith("→ dev"))).toBe(true));
  });

  it("stop and clear from A act on B's main", async () => {
    b.m.captain.throwThought("하나 더", "home");
    await wait(() => expect(a.m.shared.chatIn(theirs).some((m) => m.text === "하나 더")).toBe(true));
    await a.m.captain.resetMain(theirs);
    await wait(() => expect(b.m.store.state.chatCleared?.home).toBeGreaterThan(0));
  });

  it("the Discord agent's chat shows on A as that agent's, never in main", async () => {
    b.m.store.setState("captain", (l) => [...l, { id: "ag1", at: Date.now(), space: "home", project: "@agent", from: "me", text: "에이전트 채널 얘기" }]);
    b.m.captain.throwThought("에이전트 다음 말", "home");
    await wait(() => expect(a.m.shared.chatIn(theirs, "@agent").map((m) => m.text)).toContain("에이전트 채널 얘기"));
    expect(a.m.shared.chatIn(theirs).some((m) => m.text === "에이전트 채널 얘기")).toBe(false);
    await wait(() => expect(a.m.mirror.mirror.hosts[B].agent?.name).toBe("메타몽"));
  });
});

describe("screen state follows the workspace", () => {
  it("a sidebar fold made on B shows on A, and one made on A shows on B", async () => {
    const [bFold, setBFold] = b.m.view.kept(() => b.m.view.inSpace("home", "fold/p:pomo"), false);
    setBFold(true);
    const [aFold, setAFold] = a.m.view.kept(() => a.m.view.inSpace(theirs, `fold/p:r:${B}:pomo`), false);
    await wait(() => expect(aFold()).toBe(true));
    setAFold(false);
    await wait(() => expect(bFold()).toBe(false));
  });

  it("canvas card positions move on both", async () => {
    b.m.shared.setCanvasPos("home", "p:pomo", { x: 40, y: 80 });
    await wait(() => expect(a.m.shared.canvasPos(theirs, `p:r:${B}:pomo`)).toEqual({ x: 40, y: 80 }));
    a.m.shared.setCanvasPos(theirs, "main", { x: -10, y: 5 });
    await wait(() => expect(b.m.store.state.canvas?.["home:main"]).toEqual({ x: -10, y: 5 }));
  });

  it("values naming B's projects read as its projects on A (unfolded lanes, the board)", async () => {
    const [, setB] = b.m.view.kept(() => b.m.view.inSpace("home", "canvas.unfolded"), [] as string[]);
    setB(["pomo"]);
    const [aGet] = a.m.view.kept(() => a.m.view.inSpace(theirs, "canvas.unfolded"), [] as string[]);
    await wait(() => expect(aGet()).toEqual([`r:${B}:pomo`]));
    const [, setBoardB] = b.m.view.kept(() => b.m.view.inSpace("home", "reqBoard"), false);
    setBoardB(true);
    const [boardA] = a.m.view.kept(() => a.m.view.inSpace(theirs, "reqBoard"), false);
    await wait(() => expect(boardA()).toBe(true));
  });

  it("text typed but not sent in B's main shows in A's input for it, and back", async () => {
    b.m.drafts.setDraft("main:home", "아직 안 보낸 말");
    await wait(() => expect(a.m.drafts.draftOf(`main:${theirs}`)?.text).toBe("아직 안 보낸 말"));
    a.m.drafts.setDraft(`main:${theirs}`, "A에서 고친 말");
    await wait(() => expect(b.m.drafts.draftOf("main:home")?.text).toBe("A에서 고친 말"));
  });

  it("A's own workspace state stays A's", () => {
    const [, setMine] = a.m.view.kept(() => a.m.view.inSpace("home", "fold/projects"), false);
    setMine(true);
    const [bSees] = b.m.view.kept(() => b.m.view.inSpace("home", "fold/projects"), false);
    expect(bSees()).toBe(false);
  });
});

describe("another device's app settings", () => {
  it("A sees B's settings and a change made on A applies on B", async () => {
    b.m.store.setState("settings", "theme", "dark");
    await wait(() => expect(a.m.shared.farSettings(B)?.theme).toBe("dark"));
    await a.m.shared.setFarSetting(B, "theme", "light");
    await wait(() => expect(b.m.store.state.settings.theme).toBe("light"));
    await a.m.shared.setFarSetting(B, "instructions", "항상 한국어로");
    await wait(() => expect(b.m.store.state.settings.instructions).toBe("항상 한국어로"));
    expect(a.m.store.state.settings.instructions).not.toBe("항상 한국어로");
  });

  it("A sees B's agent settings as B has them, and follows when B changes them", async () => {
    b.m.store.setState("settings", "agent", { on: false, name: "도리", ownerId: "42", channels: ["c1"], places: [{ channel: "c1", label: "#orbit · 서버", space: "home" }] });
    await wait(() => expect(a.m.mirror.mirror.hosts[B].agent?.settings).toMatchObject({ token: false, ownerId: "42", others: true, channels: ["c1"], places: [{ channel: "c1", label: "#orbit · 서버", space: "home" }], spaces: { home: { label: "개인" } } }));
    // every channel: none until set
    expect(a.m.mirror.mirror.hosts[B].agent?.settings?.space).toBeUndefined();
    expect(a.m.mirror.mirror.hosts[B].agent?.name).toBe("도리");
    b.m.store.setState("settings", "agent", "others", false);
    await wait(() => expect(a.m.mirror.mirror.hosts[B].agent?.settings?.others).toBe(false));
    expect(a.m.store.state.settings.agent?.name).not.toBe("도리");
  });

  it("A asks for a tab of B's settings and gets B's own, in A's language", async () => {
    b.m.store.setState("routines", [{ id: "r1", space: "home", title: "아침 PR 정리" }] as never);
    a.m.store.setState("routines", [{ id: "r2", space: "home", title: "A의 루틴" }] as never);
    expect(await a.m.hosts.askHost(B, "settingsPage", ["routines", "en"])).toEqual({ groups: [{ title: "routines · All jobs", rows: [{ title: "아침 PR 정리" }] }] });
    b.m.store.setState("routines", [] as never);
    a.m.store.setState("routines", [] as never);
  });

  it("only what the settings page offers can be changed from afar", async () => {
    await expect(a.m.shared.setFarSetting(B, "hosts", [])).rejects.toThrow();
    await expect(a.m.shared.setFarSetting(B, "agent.on", true)).rejects.toThrow();
    expect(b.m.store.state.settings.hosts?.length).toBe(1);
  });
});

describe("a device kept to some workspaces", () => {
  it("gets none of the chats and can't speak to main", async () => {
    b.m.remote.setDeviceSpaces(A, ["home"]);
    await expect(a.m.hosts.viaHost(B, "say", [{ space: "home", text: "몰래", me: "x1", reply: "x2" }])).rejects.toThrow();
    await expect(a.m.hosts.viaHost(B, "setSetting", ["theme", "dark"])).rejects.toThrow();
    await expect(a.m.hosts.askHost(B, "settingsPage", ["routines", "ko"])).rejects.toThrow("bad request");
    expect(b.m.store.state.captain.some((m) => m.text === "몰래")).toBe(false);
    b.m.remote.setDeviceSpaces(A, undefined);
  });
});

describe("a device that doesn't share its chats (an older Ondra, or one that keeps this device to some workspaces)", () => {
  it("what is typed in its workspace's main never becomes a job there as typed: main says why", async () => {
    b.m.remote.setDeviceSpaces(A, ["home"]);
    a.m.mirror.setMirror("hosts", B, "chat", undefined);
    a.m.store.setState("settings", "hosts", (l) => (l ?? []).map((h) => ({ ...h, same: undefined })));
    await a.m.rpc.refreshEngine();
    expect(a.m.shared.farOf(theirs)).toBeUndefined();
    const jobs = b.m.store.state.tasks.length;
    const replyId = a.m.captain.throwThought("옮기기 화면 좀 바꿔 줘", theirs);
    await wait(() => expect(a.m.shared.chatIn(theirs).find((m) => m.id === replyId)?.error).toBe("맥북프로의 메인에 보낼 수 없어요 · 그 기기의 Ondra를 업데이트해 주세요"));
    expect(b.m.store.state.tasks.length).toBe(jobs);
    b.m.remote.setDeviceSpaces(A, undefined);
  });
});
