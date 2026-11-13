import { describe, expect, it } from "vitest";
import type { Task } from "../state/types";
import { BYE_GIVE_UP, byeWait, checkCall, JOB_CALLS, jobsFrom, linkPlan, mayReach, withoutHost, type Reach } from "./remoteRules";

const job = (id: string, extra: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "", title: id, ask: "", cwd: "/", status: "running",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...extra,
});

const DEV = "a".repeat(64);
const OTHER = "b".repeat(64);
const tasks = [
  job("inApp", { project: "app" }),
  job("kid", { parentId: "inApp" }),
  job("inSecret", { project: "secret" }),
  job("mine", { from: { device: DEV, space: "sp1" } }),
  job("mineKid", { parentId: "mine" }),
  job("theirs", { from: { device: OTHER, space: "sp1" } }),
  job("work", { project: "app", space: "work" }),
  // shown here from a third Mac: never reachable through this one
  job("far", { project: "app", host: "c".repeat(64) }),
];
const byId = (id: string) => tasks.find((x) => x.id === id);
const reach: Reach = { device: DEV, watch: new Set(["app"]) };

describe("what a Mac allowed in may reach", () => {
  it("sees the jobs of the projects it keeps and the ones it asked for, with their subagents", () => {
    for (const id of ["inApp", "kid", "mine", "mineKid", "work"]) expect(mayReach(reach, byId(id), byId), id).toBe(true);
  });
  it("not a project it doesn't keep, another Mac's job, a job of a third Mac, or nothing", () => {
    for (const id of ["inSecret", "theirs", "far", "missing"]) expect(mayReach(reach, byId(id), byId), id).toBe(false);
  });
  it("only in the workspaces it may use", () => {
    const home: Reach = { ...reach, spaces: new Set(["home"]) };
    expect(mayReach(home, byId("inApp"), byId)).toBe(true);
    expect(mayReach(home, byId("work"), byId)).toBe(false);
    expect(mayReach({ ...reach, spaces: new Set() }, byId("mine"), byId)).toBe(false);
  });
});

describe("a call from another Mac", () => {
  it("goes ahead on a job it may reach", () => {
    expect(checkCall(reach, "removeTask", ["inApp"], byId)).toEqual(["inApp"]);
    expect(checkCall(reach, "renameTask", ["kid", "new"], byId)).toEqual(["kid", "new"]);
  });
  it("is refused on any other job, every kind of call alike", () => {
    for (const fn of JOB_CALLS) for (const id of ["inSecret", "theirs", "far", "missing"]) expect(() => checkCall(reach, fn, [id], byId), `${fn} ${id}`).toThrow();
  });
  it("is refused when it isn't a job call or has no id", () => {
    expect(() => checkCall(reach, "addProject", ["/tmp"], byId)).toThrow(/unknown/);
    expect(() => checkCall(reach, "constructor", ["inApp"], byId)).toThrow(/unknown/);
    expect(() => checkCall(reach, "stopTask", [], byId)).toThrow();
    expect(() => checkCall(reach, "stopTask", [{ id: "inApp" }], byId)).toThrow();
  });
  it("a message can't pass for a job's own agent", () => {
    expect(checkCall(reach, "tell", ["inApp", "hi", { now: true, by: "t123", shown: "hey" }], byId)).toEqual(["inApp", "hi", { now: true, shown: "hey" }]);
    expect(checkCall(reach, "tell", ["inApp", "hi", { by: "main" }], byId)).toEqual(["inApp", "hi", { now: false, by: "main" }]);
    expect(checkCall(reach, "tell", ["inApp", "hi"], byId)).toEqual(["inApp", "hi", { now: false }]);
  });
});

describe("jobs a removed Mac asked for", () => {
  it("are its top jobs still in the list", () => {
    const list = [...tasks, job("old", { from: { device: DEV, space: "" }, archived: true })];
    expect(jobsFrom(list, DEV).map((x) => x.id)).toEqual(["mine"]);
    expect(jobsFrom(list, "nobody")).toEqual([]);
  });
});

describe("a Mac this one works on, removed", () => {
  it("takes its projects and a run location on it along", () => {
    const s = {
      hosts: [{ id: DEV, name: "A" }, { id: OTHER, name: "B" }],
      hostProjects: [{ host: DEV, id: "app", space: "home" as const }, { host: OTHER, id: "web", space: "home" as const }],
      computers: { home: { host: DEV, account: "x" }, work: { host: OTHER } },
    };
    const rest = withoutHost(s, DEV);
    expect(rest.hosts.map((h) => h.id)).toEqual([OTHER]);
    expect(rest.hostProjects.map((p) => p.id)).toEqual(["web"]);
    expect(rest.computers).toEqual({ work: { host: OTHER } });
    // nothing set yet: nothing to clean
    expect(withoutHost({}, DEV)).toEqual({ hosts: [], hostProjects: [], computers: {} });
  });
});

describe("which of a Mac's projects show here", () => {
  const spaceFor = (label?: string) => (label === "없음" ? undefined : "home");
  const list = [{ id: "app" }, { id: "web" }, { id: "docs" }, { id: "nowhere", space: "없음" }];
  it("adds new ones, but not hidden ones or ones with no tab", () => {
    expect(linkPlan(list, [{ id: "app" }], ["docs"], spaceFor)).toEqual({ gone: [], add: [{ id: "web" }] });
  });
  it("takes off ones gone there and ones hidden since", () => {
    expect(linkPlan(list, [{ id: "app" }, { id: "web" }, { id: "old" }], ["web"], spaceFor)).toEqual({ gone: ["web", "old"], add: [{ id: "docs" }] });
  });
  it("shows a hidden one again once it's no longer hidden", () => {
    expect(linkPlan(list, [{ id: "app" }, { id: "web" }], [], spaceFor).add).toEqual([{ id: "docs" }]);
  });
});

describe("telling a removed Mac", () => {
  it("tries again less and less often, then gives up", () => {
    expect(byeWait(0)).toBe(30_000);
    expect(byeWait(1)).toBe(60_000);
    expect(byeWait(20)).toBe(30 * 60_000);
    expect(BYE_GIVE_UP).toBeGreaterThan(byeWait(20));
  });
});
