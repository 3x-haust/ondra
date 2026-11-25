import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state, taskById } from "../state/store";
import { applyRoutes } from "./captain";
import { engine } from "./rpc";
import { instructionFolders } from "./captainPaths";

const home = String.raw`C:\Users\Ada`;
beforeEach(() => {
  setState(reconcile(freshState()));
  vi.spyOn(engine, "info", "get").mockReturnValue({ home, dataDir: "", engineVersion: null, enginePath: null });
  setState("spaces", s => s.id === "home", "folder", `${home}\\Work`);
});
afterEach(() => vi.restoreAllMocks());

async function route(r: object, original = "새 작업") {
  const [made] = await applyRoutes("home", [{ kind: "new", title: "새 작업", task: "test", ...r }], original);
  return taskById((made as {taskId: string}).taskId)!;
}
it("creates the named project from a Windows path and retains its requested subfolder", async () => {
  const folder = `${home}\\New Project`;
  vi.spyOn(native, "ensureDir").mockResolvedValue(folder);
  const task = await route({ project: { name: "새 앱", folder }, cwd: `${folder}\\src` });
  expect(native.ensureDir).toHaveBeenCalledWith(folder);
  expect(state.projects?.find(p => p.id === task.project)?.name).toBe("새 앱");
  expect(task.cwd).toBe(`${folder}\\src`);
});
it("assigns a Windows subfolder to the top project, not a similarly named sibling space or hidden folder", async () => {
  const cwd = `${home}\\Work\\repo\\src`;
  const task = await route({ cwd });
  expect(state.projects?.find(p => p.id === task.project)?.name).toBe("repo");
  expect(task.cwd).toBe(cwd);
  expect((await route({ cwd: `${home}\\Work-old\\repo` })).project).toBeUndefined();
  expect((await route({ cwd: `${home}\\Work\\.cache\\repo` })).project).toBeUndefined();
});
it("walks instruction directories, never partial names, drive-relative paths or the server above a share", () => {
  expect(instructionFolders(String.raw`C:\work\repo`)).toEqual(["C:/work/repo", "C:/work"]);
  expect(instructionFolders(String.raw`\\server\share\work\repo`)).toEqual(["//server/share/work/repo", "//server/share/work"]);
  expect(instructionFolders(String.raw`/Users/me/a\b`)).toEqual([String.raw`/Users/me/a\b`, "/Users/me", "/Users"]);
});
it("does not assign a job by a project name found only in a Windows file path", async () => {
  setState("projects", [{ id: "pebble", name: "Pebble", folder: `${home}\\Work\\Pebble`, space: "home" }]);
  expect((await route({ project: "Pebble" }, String.raw`이 C:\Captures\Pebble\shot.png 확인해줘`)).project).toBeUndefined();
});
