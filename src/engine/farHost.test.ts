import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", async (orig) => {
  const real = await orig<typeof import("../lib/native")>();
  return {
    ...real,
    fsFiles: vi.fn(async (dir: string) => [dir]),
    fsRead: vi.fn(async (path: string) => ({ text: path, size: 1, binary: false })),
    revealPath: vi.fn(async () => {}),
    artifactsList: vi.fn(async (id: string) => [{ path: `/tmp/ondra/artifacts/${id}/a.png`, name: "a.png", size: 1, modified: 1 }]),
    ptyOpen: vi.fn(async () => {}),
    // links followed: one link inside the project points out of it
    farReal: vi.fn(async (paths: string[]) => paths.map((p) => (p === "/Users/me/work/app/link" ? "/Users/me/.ssh" : p))),
  };
});

import { fsFiles, fsRead, ptyOpen } from "../lib/native";
import { setState } from "../state/store";
import type { Project, Task } from "../state/types";
import { farCall, rootsFor, type FarPeer } from "./farHost";
import { refreshEngine } from "./rpc";

const task = (id: string, o: Partial<Task>): Task => ({ id, title: id, ask: "", status: "done", entries: [], shells: [], legs: [], space: "s1", accountId: "a", createdAt: 1, cwd: "~", ...o }) as unknown as Task;

const peer = (o: Partial<FarPeer> = {}): FarPeer => ({
  conn: 7,
  device: "dev",
  watch: new Set(["p1"]),
  // as remote.ts decides: a job of a project it added, or one it started
  sees: (t) => t.project === "p1" || t.from?.device === "dev",
  send: () => {},
  ...o,
});
const call = (fn: string, ...args: unknown[]) => farCall(peer(), fn)!(...args) as Promise<unknown>;
const NO = "그 Mac에서 열 수 없는 위치예요";

beforeAll(async () => {
  // outside the app: home /Users/me, data /tmp/ondra
  await refreshEngine();
});
beforeEach(() => {
  vi.clearAllMocks();
  setState("spaces", [{ id: "s1", label: "회사", folder: "~", rules: "" }] as never);
  setState("projects", [
    { id: "p1", space: "s1", name: "app", folder: "~/work/app" },
    { id: "p2", space: "s1", name: "secret", folder: "~/work/secret" },
  ] as Project[]);
  setState("tasks", [
    task("t1", { project: "p1", cwd: "~/work/app", worktree: { path: "/Users/me/worktrees/app/t1", repo: "/Users/me/work/app", branch: "b", base: "main", state: "open" } as Task["worktree"], shot: "/tmp/shots/t1.png", entries: [{ id: "e", at: 1, kind: "text", text: "see /var/folders/x/look.png" }] }),
    task("t2", { project: "p2", cwd: "~/work/secret" }),
    // started from that Mac, no project: its folder is the home folder, too wide to open
    task("t3", { cwd: "~", from: { device: "dev", space: "" } }),
  ]);
});

describe("what another Mac may reach here", () => {
  it("is the folders of its projects and jobs, their results, its attachments; never home", () => {
    const roots = rootsFor(peer());
    expect(roots).toEqual(expect.arrayContaining(["/Users/me/work/app", "/Users/me/worktrees/app/t1", "/tmp/ondra/artifacts/t1", "/tmp/ondra/artifacts/t3", "/tmp/ondra/attachments/remote"]));
    expect(roots).not.toContain("/Users/me");
    expect(roots).not.toContain("/Users/me/work/secret");
  });

  it("lists and reads inside them, in this Mac's own terms", async () => {
    expect(await call("far.files", "~/work/app")).toEqual(["/Users/me/work/app"]);
    expect(fsFiles).toHaveBeenCalledWith("/Users/me/work/app");
    await call("far.read", "/Users/me/worktrees/app/t1/src/a.ts");
    expect(fsRead).toHaveBeenCalledWith("/Users/me/worktrees/app/t1/src/a.ts");
  });

  it("refuses anything else: another project, home, climbing out, a link out", async () => {
    await expect(call("far.files", "~/work/secret")).rejects.toThrow(NO);
    await expect(call("far.files", "~")).rejects.toThrow(NO);
    await expect(call("far.read", "~/work/app/../secret/.env")).rejects.toThrow(NO);
    await expect(call("far.read", "/etc/passwd")).rejects.toThrow(NO);
    await expect(call("far.read", "/Users/me/work/app/link")).rejects.toThrow(NO);
    await expect(call("far.read", 42)).rejects.toThrow(NO);
    expect(fsRead).not.toHaveBeenCalled();
  });

  it("reads a single file one of its jobs named (a shot, a picture in a reply), but doesn't list around it", async () => {
    await call("far.read", "/tmp/shots/t1.png");
    await call("far.read", "/var/folders/x/look.png");
    expect(fsRead).toHaveBeenCalledTimes(2);
    await expect(call("far.files", "/tmp/shots")).rejects.toThrow(NO);
    await expect(call("far.read", "/tmp/shots/t2.png")).rejects.toThrow(NO);
  });

  it("acts on its own jobs and projects only", async () => {
    expect(await call("far.artifacts", "t1")).toHaveLength(1);
    await expect(call("far.artifacts", "t2")).rejects.toThrow("그 작업이 이 Mac에 없어요");
    await expect(call("far.memList", "p2")).rejects.toThrow("그 프로젝트가 이 Mac에 없어요");
    await expect(call("far.ptyOpen", "x", "t2", 80, 24)).rejects.toThrow("그 작업이 이 Mac에 없어요");
    expect(ptyOpen).not.toHaveBeenCalled();
  });

  it("opens a terminal in its job's folder, under a name of its own", async () => {
    await call("far.ptyOpen", "term1", "t1", 100, 30);
    expect(ptyOpen).toHaveBeenCalledWith("far-7-term1", "/Users/me/work/app", null, [], expect.anything(), 100, 30);
    await call("far.ptyClose", "term1");
  });

  it("knows only its own calls", () => {
    expect(farCall(peer(), "far.nope")).toBeUndefined();
    expect(farCall(peer(), "constructor")).toBeUndefined();
    expect(farCall(peer(), "__proto__")).toBeUndefined();
  });
});
