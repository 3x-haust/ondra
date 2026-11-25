import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, projectsIn, setState, state, taskById } from "../state/store";
import type { Task } from "../state/types";
import { view } from "../state/ui";
import { handle } from "./bridge";
import { ACTIONS } from "./appActions";

const job = (id: string, over: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "Ondra", title: id, ask: `Do ${id}`, cwd: "/repo", status: "done",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], ...over,
});
const app = (action: string, args: Record<string, unknown> = {}, worker = "captain:home") => handle({ op: "app", worker, args: { action, args } }) as Promise<any>;

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }, { id: "work", label: "회사", folder: "~/work", rules: "" }]);
  setState("space", "home");
  setState("projects", [{ id: "p-site", space: "home", name: "site", folder: "/repo/site" }, { id: "p-w", space: "work", name: "corp", folder: "/repo/corp" }] as never);
  setState("tasks", [job("t-mine"), job("t-run", { status: "running" }), job("w-job", { space: "work" })]);
});

describe("ondra_app: what the user could press, main and a job press too", () => {
  it("lists every action with where it is in the app", async () => {
    const r = await app("list");
    expect(r.actions.map((a: { action: string }) => a.action)).toEqual(Object.keys(ACTIONS));
    for (const a of r.actions) expect(a.where && a.does).toBeTruthy();
    expect(r.actions.map((a: { action: string }) => a.action)).toContain("remote.link");
  });

  it("a job's pin and archive, in its own workspace only", async () => {
    expect(await app("job.pin", { id: "t-mine" })).toEqual({ pinned: true });
    await vi.waitFor(() => expect(taskById("t-mine")?.pinned).toBe(true));
    expect(await app("job.archive", { id: "t-mine" })).toEqual({ archived: true });
    expect(taskById("t-mine")?.archived).toBe(true);
    // another workspace's job, from this one's main or one of its jobs
    expect((await app("job.archive", { id: "w-job" })).error).toMatch(/no job w-job/);
    expect((await app("job.stop", { id: "w-job" }, "t-run")).error).toMatch(/no job/);
    // a job doesn't stop itself this way
    expect((await app("job.stop", { id: "t-run" }, "t-run")).error).toBe("that is this job");
    expect(taskById("w-job")?.archived).toBeFalsy();
  });

  it("projects: add a folder that exists, rename, remove; never another workspace's", async () => {
    vi.spyOn(native, "pathsExist").mockImplementation(async (ps: string[]) => ps.map((p) => p === "/repo/blog"));
    expect((await app("project.add", { folder: "/repo/nope" })).error).toMatch(/no folder/);
    const r = await app("project.add", { folder: "/repo/blog" });
    expect(projectsIn("home").map((p) => p.id)).toContain(r.project);
    expect((await app("project.rename", { id: "site", name: "홈페이지" })).now).toBe("홈페이지");
    expect((await app("project.remove", { id: "corp" })).error).toMatch(/no project/);
    // the project whose chat is asking stays: the user removes it
    expect((await app("project.remove", { id: "p-site" }, "captain:home~p-site")).error).toMatch(/user removes it/);
    expect(await app("project.remove", { id: "p-site" })).toEqual({ removed: "p-site" });
  });

  it("another Mac's link needs this Mac open to others first, and a link to add one", async () => {
    expect((await app("remote.link")).error).toMatch(/ondra_settings \{"remote": true\}/);
    expect((await app("remote.add", { link: "hello" })).error).toMatch(/isn't a connect link/);
    expect((await app("remote.add")).error).toBe("remote.add takes link");
  });

  it("shows the user a screen, in the caller's workspace", async () => {
    await app("open", { to: "settings:remote" });
    expect(view()).toEqual({ name: "settings", tab: "remote" });
    await app("open", { to: "job:t-mine" });
    expect(view()).toEqual({ name: "task", id: "t-mine" });
    expect((await app("open", { to: "job:w-job" })).error).toMatch(/no job/);
  });

  it("only main or a job; never a simulated chat or a stranger", async () => {
    expect((await app("list", {}, "captain:sim1:home")).error).toMatch(/only main or a job/);
    expect((await app("list", {}, "nobody")).error).toMatch(/only main or a job/);
    expect((await app("nothing.here")).error).toMatch(/no action/);
    expect(state.tasks.length).toBe(3);
  });
});
