import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { discardTask } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Fix login",
  ask: "Fix the login redirect.", cwd: "/repo/.ondra/job", status: "done",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, finishedAt: 5,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  worktree: { state: "open", repo: "/repo", path: "/repo/.ondra/job", branch: "fix/login", base: "abc", sub: "" },
  ...over,
});

beforeEach(() => {
  setState(reconcile(freshState()));
  vi.spyOn(native, "spaceEnv").mockResolvedValue([]);
  vi.spyOn(native, "worktreeRemove").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("discardTask", () => {
  it("records when the changes were thrown away and keeps the finish time", async () => {
    setState("tasks", [job()]);
    const before = Date.now();
    await discardTask("job");
    const t = state.tasks[0];
    expect(t.worktree?.state).toBe("discarded");
    expect(t.discardedAt).toBeGreaterThanOrEqual(before);
    expect(t.finishedAt).toBe(5);
    expect(t.entries[t.entries.length - 1]).toMatchObject({ kind: "note", text: "변경을 버렸어요" });
  });

  it("does nothing to a task whose worktree is already gone", async () => {
    setState("tasks", [job({ worktree: { state: "merged", repo: "/repo", path: "/repo/.ondra/job", branch: "fix/login", base: "abc", sub: "" } })]);
    await discardTask("job");
    expect(state.tasks[0].discardedAt).toBeUndefined();
  });
});
