import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state, taskById } from "../state/store";
import type { Task } from "../state/types";
import { applyRoutes } from "./captain";

const job = (id: string, space: Task["space"], status: Task["status"]): Task => ({
  id, space, topic: "Example", title: id, ask: `Do ${id}`, cwd: "/repo", status,
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
});

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("tasks", [job("w-run", "work", "running"), job("w-done", "work", "done"), job("h-run", "home", "running")]);
});

describe("main's routes stay in their space", () => {
  it("ignores the other space's jobs", async () => {
    const out = await applyRoutes("home", [
      { kind: "stop", taskId: "w-run" },
      { kind: "append", taskId: "w-run", message: "also this" },
      { kind: "append", taskId: "w-done", message: "more" },
    ], "x");
    expect(out).toEqual([]);
    expect(taskById("w-run")?.status).toBe("running");
    expect(state.tasks.length).toBe(3);
  });

  it("acts on its own jobs, and new work never waits on or follows the other space", async () => {
    const out = await applyRoutes("home", [
      { kind: "stop", taskId: "h-run" },
      { kind: "new", title: "next", task: "do next", after: ["w-run", "h-run"], from: "w-done" },
    ], "x");
    expect(out.map((r) => r.kind)).toEqual(["stop", "new"]);
    const made = taskById((out[1] as { taskId: string }).taskId)!;
    expect(made.space).toBe("home");
    expect(made.after).toEqual(["h-run"]);
    expect(made.follows).toBeUndefined();
  });
});
