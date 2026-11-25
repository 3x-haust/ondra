import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", async (orig) => {
  const real = await orig<typeof import("../lib/native")>();
  return {
    ...real,
    engineInfo: vi.fn(real.engineInfo),
    fsFiles: vi.fn(async (dir: string) => [dir]),
    fsRead: vi.fn(async (path: string) => ({ text: path, size: 1, binary: false })),
    revealPath: vi.fn(async () => {}),
    farStat: vi.fn(async () => ({ size: 1, modified: 1, dir: false })),
    artifactsList: vi.fn(async (id: string) => [{ path: `/tmp/ondra/artifacts/${id}/a.png`, name: "a.png", size: 1, modified: 1 }]),
    ptyOpen: vi.fn(async () => {}),
    // links followed: one link inside the project points out of it
    farReal: vi.fn(async (paths: string[]) => paths.map((p) => (p === "/Users/me/work/app/link" ? "/Users/me/.ssh" : p))),
  };
});

import { engineInfo, farReal, fsFiles, fsRead, ptyOpen } from "../lib/native";
import { setState } from "../state/store";
import type { Project, Task } from "../state/types";
import { farCall, rootsFor, type FarPeer } from "./farHost";
import { refreshEngine } from "./rpc";
import { rememberPickedFiles } from "./pickedFiles";

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
    expect(fsFiles).toHaveBeenCalledWith("/Users/me/work/app", true);
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

  it("serves only a file attached locally to the visible task, at its approved final location", async () => {
    const path = "/Users/me/Desktop/mockup.png";
    const text = `첨부한 파일:\n- [Image #1] ${path}`;
    setState("tasks", [task("t1", { project: "p1", entries: [{ kind: "user", id: "u", at: 1, text }] })]);
    // A user row (including the legacy attachment-list format) is not a file selection.
    await expect(call("far.read", path)).rejects.toThrow(NO);
    await rememberPickedFiles("task", "t1", [path]);
    await call("far.read", path);
    expect(fsRead).toHaveBeenCalledWith(path);
    await expect(call("far.write", path, "new")).rejects.toThrow(NO);
    vi.mocked(farReal).mockImplementationOnce(async (paths) => paths.map((p, i) => i ? p : "/Users/me/Desktop/revision.png"));
    await expect(call("far.read", path)).rejects.toThrow(NO);
    setState("tasks", 0, "project", "p2");
    await expect(call("far.read", path)).rejects.toThrow(NO);
  });

  it("keeps a main-chat selection with the job its reply routed the attachment to", async () => {
    const path = "/Users/me/Desktop/brief.pdf";
    const text = `첨부한 파일:\n- ${path}`;
    setState("tasks", [task("t1", { project: "p1", entries: [{ kind: "user", id: "u", at: 1, text }] })]);
    setState("captain", [{ id: "reply", at: 1, space: "s1", from: "captain", routes: [{ kind: "new", taskId: "t2" }] }]);
    await rememberPickedFiles("main", "reply", [path]);
    await expect(call("far.read", path)).rejects.toThrow(NO);
    setState("captain", 0, "routes", [{ kind: "new", taskId: "t1" }]);
    await call("far.read", path);
    expect(fsRead).toHaveBeenCalledWith(path);
  });

  it("checks a Windows project and its junctions by their native final paths", async () => {
    const home = String.raw`C:\Users\me`;
    vi.mocked(engineInfo).mockResolvedValueOnce({ enginePath: null, engineVersion: null, dataDir: "C:/ondra", home });
    await refreshEngine();
    try {
      vi.mocked(farReal).mockImplementationOnce(async (paths) => paths.map((p) => `\\\\?\\${p.replace(/\//g, "\\")}`));
      await call("far.read", "/@drive/C/Users/me/work/app/src/a.ts");
      expect(fsRead).toHaveBeenCalledWith("C:/Users/me/work/app/src/a.ts");
      vi.mocked(farReal).mockImplementationOnce(async (paths) => paths.map((p, i) => i ? p : String.raw`\\?\C:\outside\a.ts`));
      await expect(call("far.read", "~/work/app/link/a.ts")).rejects.toThrow(NO);
      setState("tasks", [task("t1", { project: "p1", entries: [{ kind: "text", id: "e", at: 1, text: String.raw`![shot](D:\shots\look.png)` }] })]);
      await call("far.read", "/@drive/D/shots/look.png");
      expect(fsRead).toHaveBeenCalledWith("D:/shots/look.png");
      await expect(call("far.read", "D:/shots/other.png")).rejects.toThrow(NO);
      await expect(call("far.write", "D:/shots/look.png", "x")).rejects.toThrow(NO);
      await expect(call("far.files", "D:/shots")).rejects.toThrow(NO);
      await expect(call("far.read", "/Users/me/work/app/x")).rejects.toThrow(NO);
    } finally {
      await refreshEngine();
    }
  });

  it("shares a subproject in both worktrees, not either repository top", () => {
    setState("tasks", [task("t1", { project: "p1", cwd: "/copies/mono/apps/shared", worktree: {
      path: "/copies/mono", repo: "/work/mono", sub: "apps/shared", base: "HEAD", branch: "b", state: "open",
    } })]);
    const roots = rootsFor(peer());
    expect(roots).toEqual(expect.arrayContaining(["/copies/mono/apps/shared", "/work/mono/apps/shared"]));
    expect(roots).not.toContain("/copies/mono");
    expect(roots).not.toContain("/work/mono");
  });

  it("uses the checked final location for a project file and refuses a redirected named file", async () => {
    vi.mocked(farReal).mockImplementationOnce(async (paths) => paths.map((p, i) => i ? p : "/Users/me/work/app/current.ts"));
    await call("far.read", "~/work/app/alias.ts");
    expect(fsRead).toHaveBeenCalledWith("/Users/me/work/app/current.ts");
    vi.mocked(farReal).mockImplementationOnce(async (paths) => paths.map((p, i) => i ? p : "/tmp/shots/different.png"));
    await expect(call("far.read", "/tmp/shots/t1.png")).rejects.toThrow(NO);
  });

  it("won't serve project files without a confirmed real location", async () => {
    vi.mocked(farReal).mockResolvedValueOnce([null]);
    await expect(call("far.read", "~/work/app/a")).rejects.toThrow(NO);
    vi.mocked(farReal).mockRejectedValueOnce(new Error("unavailable"));
    await expect(call("far.read", "~/work/app/a")).rejects.toThrow();
    expect(fsRead).not.toHaveBeenCalled();
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
    expect(farCall(peer(), "far.reveal")).toBeUndefined();
    expect(farCall(peer(), "far.editor")).toBeUndefined();
    expect(farCall(peer(), "constructor")).toBeUndefined();
    expect(farCall(peer(), "__proto__")).toBeUndefined();
  });
});
