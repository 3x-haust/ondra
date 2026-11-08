import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { pauseTask, resumeTask, stopTask } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Ship it", ask: "Ship it.", cwd: "/x", status: "running",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [{ startedAt: 1 }],
  entries: [], shells: [], inbox: [], ...over,
});
const get = (id: string) => state.tasks.find((t) => t.id === id)!;

beforeEach(() => setState(reconcile(freshState())));

describe("resuming a task resumes the subagents its pause stopped", () => {
  it("brings back the ones the pause stopped, not the ones already paused", () => {
    setState("tasks", [
      job(),
      job({ id: "kid", parentId: "job" }),
      job({ id: "waiting", parentId: "job", status: "queued", legs: [] }),
      job({ id: "own", parentId: "job", status: "paused" }),
      job({ id: "over", parentId: "job", status: "done" }),
    ]);
    stopTask("job");
    expect(get("kid").status).toBe("paused");
    expect(get("kid").pausedBy).toBe("job");
    expect(get("waiting").pausedBy).toBe("job");
    expect(get("own").pausedBy).toBeUndefined();

    resumeTask("job");
    expect(get("job").status).toBe("queued");
    expect(get("kid").status).toBe("queued");
    expect(get("waiting").status).toBe("queued");
    expect(get("own").status).toBe("paused");
    expect(get("over").status).toBe("done");
  });

  it("goes down to their own subagents", () => {
    setState("tasks", [job(), job({ id: "kid", parentId: "job" }), job({ id: "grandkid", parentId: "kid" })]);
    pauseTask("job");
    expect(get("grandkid").pausedBy).toBe("kid");
    resumeTask("job");
    expect(get("grandkid").status).toBe("queued");
  });

  it("records when a task and the subagents its pause stopped left paused", () => {
    setState("tasks", [job(), job({ id: "kid", parentId: "job" })]);
    pauseTask("job");
    expect(get("job").resumedAt).toBeUndefined();
    const before = Date.now();
    resumeTask("job");
    expect(get("job").resumedAt).toBeGreaterThanOrEqual(before);
    expect(get("kid").resumedAt).toBeGreaterThanOrEqual(before);
  });

  it("a subagent resumed on its own stops waiting for the fork", () => {
    setState("tasks", [job(), job({ id: "kid", parentId: "job" })]);
    pauseTask("job");
    resumeTask("kid");
    expect(get("kid").status).toBe("queued");
    expect(get("kid").pausedBy).toBeUndefined();
  });
});
