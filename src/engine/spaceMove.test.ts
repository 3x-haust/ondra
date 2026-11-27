import { reconcile, unwrap } from "solid-js/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** files as the native side would keep them (base64 pieces put together) */
const disk = new Map<string, string>();
const asked: { fn: string; args: unknown[] }[] = [];
let answer: (fn: string, args: unknown[]) => unknown = () => null;
vi.mock("./hosts", async (orig) => ({
  ...(await orig<typeof import("./hosts")>()),
  askHost: vi.fn(async (_h: string, fn: string, args: unknown[]) => (asked.push({ fn, args }), answer(fn, args))),
}));
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<typeof import("../lib/native")>()),
  // where src-tauri farfs.rs puts it (the data folder is "" in tests)
  farPut: vi.fn(async (kind: string, name: string, offset: number, data: string) => {
    const path = kind === "move" ? `/remote/moves/${name}` : name;
    const was = offset ? (disk.get(path) ?? "") : "";
    disk.set(path, was + atob(data));
    return path;
  }),
  farPiece: vi.fn(async (path: string, off: number, len: number) => {
    const all = disk.get(path) ?? "";
    return { data: btoa(all.slice(off, off + len)), size: all.length, modified: 1 };
  }),
  farStat: vi.fn(async (path: string) => (disk.has(path) ? { size: disk.get(path)!.length, modified: 1, dir: false } : null)),
  fsFiles: vi.fn(async (dir: string) => [...disk.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1))),
  spaceMovesIn: vi.fn(async (_x: string, items: unknown[]) => items.map(() => true)),
  spaceMoveClear: vi.fn(async () => {}),
  spaceTools: vi.fn(async () => null),
  spaceGitIdentity: vi.fn(async () => {}),
  spaceCliInstall: vi.fn(async () => ({ path: "", off_path: false })),
  spaceCliRemove: vi.fn(async () => {}),
  pathsExist: vi.fn(async (p: string[]) => p.map((x) => !x.includes("gone"))),
}));

const { freshState, setState, state } = await import("../state/store");
const { mirror, setMirror } = await import("../state/mirror");
const { buildBundle, bundleFolders, busyIn, dropSpace, moveImport, movePut, moveSpace, placeBundle } = await import("./spaceMove");
import type { AppState, Task } from "../state/types";

const HOST = "b".repeat(64);
const job = (id: string, space: string, extra: Partial<Task> = {}) => ({ id, space, title: id, ask: "", cwd: "/Users/a/Work/app", status: "done", priority: 2, weight: "light", accountId: "acc1", entries: [], ...extra }) as unknown as Task;

function seed() {
  setState(reconcile(freshState()));
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }, { id: "work", label: "회사", folder: "/Users/a/Work", rules: "지침", command: "work" }]);
  setState("space", "work");
  setState("tasks", [
    job("t1", "work", { worktree: { repo: "/Users/a/Work/app", path: "/Users/a/Work/app/.wt/t1", branch: "b", base: "x", sub: "", state: "open" } }),
    job("t2", "home"),
    job("t3", "work", { host: HOST }),
  ]);
  setState("projects", [{ id: "p1", space: "work", name: "app", folder: "/Users/a/Work/app" }, { id: "p2", space: "home", name: "mine", folder: "/Users/a/mine" }]);
  setState("memory", [
    { id: "m1", text: "회사 것", scope: "project", space: "work", project: "/Users/a/Work/app", cites: ["/Users/a/Work/app/src/a.ts"], source: "ondra", createdAt: 1, uses: 0 },
    { id: "m2", text: "개인 것", scope: "space", space: "home", source: "ondra", createdAt: 1, uses: 0 },
    { id: "m3", text: "전역", scope: "global", source: "ondra", createdAt: 1, uses: 0 },
  ]);
  setState("accounts", (l) => [...l, { id: "acc1", space: "work", label: "회사", providers: ["openai-codex"], model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
  setState("skills", [
    { name: "deploy", path: "/data/skills/deploy/SKILL.md", description: "", source: "ondra", enabled: true, space: "work" },
    { name: "shared", path: "/data/skills/shared/SKILL.md", description: "", source: "ondra", enabled: true },
  ]);
  setState("captain", [{ id: "c1", space: "work", from: "me", text: "안녕", at: 1 } as never, { id: "c2", space: "home", from: "me", text: "x", at: 1 } as never]);
  setState("routines", [{ id: "r1", space: "work", title: "매일", prompt: "x", when: { kind: "every", minutes: 60 }, mode: "fresh", enabled: true, quiet: false, host: "c".repeat(64), hostSpace: "home", createdAt: 1, updatedAt: 1, runs: 0 }]);
  setState("btws", [{ id: "b1", at: 1, scope: "main:work~p1", question: "q" } as never, { id: "b2", at: 1, scope: "task:t2", question: "q" } as never]);
  setState("memoryNow", { "/Users/a/Work/app": { at: 1 } as never, "/Users/a/mine": { at: 1 } as never });
  setState("prWatch", { "https://pr/1": { url: "https://pr/1", task: "t1", since: 1, seen: [], failed: [], conflict: false } as never });
  setState("chatCleared", { work: 5, "work~p1": 6, home: 7 });
  setState("accountPick", { work: "acc1" });
  setState("settings", "computers", { work: { host: "c".repeat(64) } });
  setState("settings", "deviceSpaces", { d1: ["work", "home"] });
  setState("settings", "agent", { on: true, name: "x", space: "work", places: [{ channel: "1", space: "work" }] } as never);
}

const bundle = () => buildBundle(unwrap(state) as AppState, "work", { home: "/Users/a", dataDir: "/data", notes: { p1: "노트" } });

beforeEach(() => {
  disk.clear();
  asked.length = 0;
  answer = () => null;
  seed();
});

describe("what goes with a workspace", () => {
  it("takes only that workspace's own things", () => {
    const b = bundle();
    expect(b.tasks.map((x) => x.id)).toEqual(["t1"]);
    expect(b.memory.map((x) => x.id)).toEqual(["m1"]);
    expect(b.projects.map((x) => x.id)).toEqual(["p1"]);
    expect(b.accounts.map((x) => x.id)).toEqual(["acc1"]);
    expect(b.skills.map((x) => x.name)).toEqual(["deploy"]);
    expect(b.captain.map((x) => x.id)).toEqual(["c1"]);
    expect(b.btws.map((x) => x.id)).toEqual(["b1"]);
    expect(Object.keys(b.memoryNow)).toEqual(["/Users/a/Work/app"]);
    expect(Object.keys(b.prWatch)).toEqual(["https://pr/1"]);
    expect(b.chatCleared).toEqual({ work: 5, "work~p1": 6 });
    expect(b.accountPick).toBe("acc1");
    expect(bundleFolders(b)).toEqual([
      { kind: "sessions", name: "t1" },
      { kind: "artifacts", name: "t1" },
      { kind: "skills", name: "deploy" },
      { kind: "accounts", name: "acc1" },
      { kind: "spaces", name: "work" },
    ]);
  });

  it("a job still going on keeps it here", () => {
    setState("tasks", (x) => x.id === "t1", "status", "queued");
    expect(busyIn(state, "work").map((x) => x.id)).toEqual(["t1"]);
    expect(busyIn(state, "home")).toEqual([]);
  });
});

describe("placing it on the other Mac", () => {
  const here = (s: AppState, extra: Partial<Parameters<typeof placeBundle>[1]> = {}) => ({ state: s, home: "/Users/b", dataDir: "/dataB", space: "spNew", hosts: new Set<string>(), skillDirs: new Set<string>(), ...extra });

  it("is a new workspace, with paths under that Mac's home", () => {
    const p = placeBundle(bundle(), here(freshState()));
    expect(p.space).toEqual({ id: "spNew", label: "회사", folder: "/Users/b/Work", rules: "지침" });
    const t1 = p.tasks[0];
    expect([t1.space, t1.cwd, t1.worktree?.repo, t1.worktree?.path]).toEqual(["spNew", "/Users/b/Work/app", "/Users/b/Work/app", "/Users/b/Work/app/.wt/t1"]);
    expect(p.projects[0]).toMatchObject({ space: "spNew", folder: "/Users/b/Work/app" });
    expect(p.memory[0]).toMatchObject({ space: "spNew", project: "/Users/b/Work/app", cites: ["/Users/b/Work/app/src/a.ts"] });
    expect(Object.keys(p.memoryNow)).toEqual(["/Users/b/Work/app"]);
    expect(p.btws[0].scope).toBe("main:spNew~p1");
    expect(p.chatCleared).toEqual({ spNew: 5, "spNew~p1": 6 });
    expect(p.notes).toEqual({ p1: "노트" });
    expect(p.folders[p.folders.length - 1]).toEqual({ kind: "spaces", name: "work>spNew" });
  });

  it("a Mac it doesn't work on is dropped: the routine and new work run there itself", () => {
    const p = placeBundle(bundle(), here(freshState()));
    expect(p.routines[0]).toMatchObject({ host: undefined, hostSpace: undefined });
    expect(p.computer).toBeUndefined();
    const kept = placeBundle(bundle(), here(freshState(), { hosts: new Set(["c".repeat(64)]) }));
    expect(kept.routines[0]).toMatchObject({ host: "c".repeat(64), hostSpace: "home" });
  });

  it("never takes the place of what that Mac has: same ids are left out, a skill folder gets another name", () => {
    const there = freshState();
    there.tasks = [job("t1", "home")];
    there.memory = [{ id: "m1", text: "theirs", scope: "global", source: "ondra", createdAt: 1, uses: 0 }];
    const p = placeBundle(bundle(), here(there, { skillDirs: new Set(["deploy"]) }));
    expect(p.tasks).toEqual([]);
    expect(p.memory).toEqual([]);
    expect(p.prWatch).toEqual({});
    expect(p.skills[0].path).toBe("/dataB/skills/deploy-2/SKILL.md");
    expect(p.folders.filter((f) => f.kind === "sessions")).toEqual([]);
    expect(p.folders).toContainEqual({ kind: "skills", name: "deploy>deploy-2" });
  });
});

describe("leaving this Mac", () => {
  it("takes everything of it out and keeps the rest", () => {
    dropSpace("work", "home");
    expect(state.spaces.map((s) => s.id)).toEqual(["home"]);
    expect(state.space).toBe("home");
    expect(state.tasks.map((x) => [x.id, x.space])).toEqual([["t2", "home"], ["t3", "home"]]);
    expect(state.memory.map((x) => x.id)).toEqual(["m2", "m3"]);
    expect(state.projects?.map((x) => x.id)).toEqual(["p2"]);
    expect(state.accounts.map((x) => x.id)).toEqual([]);
    expect(state.skills.map((x) => x.name)).toEqual(["shared"]);
    expect(state.captain.map((x) => x.id)).toEqual(["c2"]);
    expect(state.routines).toEqual([]);
    expect(state.btws?.map((x) => x.id)).toEqual(["b2"]);
    expect(Object.keys(state.memoryNow ?? {})).toEqual(["/Users/a/mine"]);
    expect(state.prWatch).toEqual({});
    expect(state.chatCleared).toEqual({ home: 7 });
    expect(state.accountPick).toEqual({});
    expect(state.settings.computers).toEqual({});
    expect(state.settings.deviceSpaces).toEqual({ d1: ["home"] });
    expect(state.settings.agent?.space).toBeUndefined();
    expect(state.settings.agent?.places?.[0].space).toBeUndefined();
  });
});

describe("sending it", () => {
  it("sends the bundle and the folders, then leaves here once that Mac has it", async () => {
    setMirror("hosts", HOST, { status: "ok", projects: [], tasks: [] });
    disk.set("/sessions/t1/s.jsonl", "session");
    answer = (fn) => (fn === "space.import" ? { space: "spNew", label: "회사", missing: ["app"] } : null);
    const r = await moveSpace("work", HOST);
    expect(r).toEqual({ label: "회사", missing: ["app"] });
    const puts = asked.filter((a) => a.fn === "space.put").map((a) => a.args[1]);
    expect(puts).toEqual(["bundle/b/bundle.json", "sessions/t1/s.jsonl"]);
    expect(asked[asked.length - 1]?.fn).toBe("space.import");
    expect(state.spaces.some((s) => s.id === "work")).toBe(false);
  });

  it("keeps everything here when that Mac can't take it", async () => {
    setMirror("hosts", HOST, { status: "ok", projects: [], tasks: [] });
    answer = (fn) => {
      if (fn === "space.put") throw new Error("unknown: space.put");
      return null;
    };
    await expect(moveSpace("work", HOST)).rejects.toThrow("그 기기의 Ondra를 업데이트해야 옮길 수 있어요");
    expect(asked[asked.length - 1]?.fn).toBe("space.cancel");
    expect(state.spaces.some((s) => s.id === "work")).toBe(true);
    expect(state.tasks.some((x) => x.id === "t1")).toBe(true);
  });

  it("refuses while a job runs", async () => {
    setMirror("hosts", HOST, { status: "ok", projects: [], tasks: [] });
    setState("tasks", (x) => x.id === "t1", "status", "running");
    await expect(moveSpace("work", HOST)).rejects.toThrow("진행 중인 작업 1개가 끝나야 옮길 수 있어요");
    expect(asked).toEqual([]);
    expect(mirror.hosts[HOST].status).toBe("ok");
  });
});

describe("taking one in", () => {
  it("adds the workspace from what came in, under a new id", async () => {
    const b = bundle();
    seed();
    setState(reconcile(freshState()));
    const text = new TextEncoder().encode(JSON.stringify(b));
    let s = "";
    for (const c of text) s += String.fromCharCode(c);
    await movePut("dev", "mvabc123", "bundle/b/bundle.json", 0, btoa(s));
    const r = await moveImport("dev", "mvabc123", "Studio");
    expect(r.label).toBe("회사");
    expect(r.missing).toEqual([]);
    const sp = state.spaces.find((x) => x.id === r.space)!;
    expect(sp.label).toBe("회사");
    expect(state.tasks.map((x) => [x.id, x.space])).toEqual([["t1", r.space]]);
    expect(state.memory.find((m) => m.id === "m1")?.space).toBe(r.space);
    expect(state.accounts.find((a) => a.id === "acc1")?.space).toBe(r.space);
  });

  it("takes pieces only of the kinds a workspace has, and a transfer only from the Mac that began it", async () => {
    await expect(movePut("dev", "mvabc123", "state/x/y", 0, "")).rejects.toThrow("bad request");
    await expect(movePut("dev", "../etc", "sessions/x/y", 0, "")).rejects.toThrow("bad request");
    await movePut("dev", "mvzzz999", "sessions/t1/a", 0, "");
    await expect(movePut("other", "mvzzz999", "sessions/t1/a", 0, "")).rejects.toThrow("bad request");
  });
});
