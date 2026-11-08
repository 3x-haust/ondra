import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { mergeTask } from "./tasks";

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
  vi.spyOn(native, "worktreeMerge").mockResolvedValue("main");
  vi.spyOn(native, "worktreeRemove").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("mergeTask", () => {
  it("records when it merged and notes it in today's wording", async () => {
    setState("tasks", [job()]);
    const before = Date.now();
    expect(await mergeTask("job")).toBe(true);
    const t = state.tasks[0];
    expect(t.worktree?.state).toBe("merged");
    expect(t.mergedAt).toBeGreaterThanOrEqual(before);
    // a task that already finished keeps its finish time
    expect(t.finishedAt).toBe(5);
    expect(t.entries[t.entries.length - 1]).toMatchObject({ kind: "note", text: "main에 병합 · 워크트리 정리" });
  });

  it("finishes a task still running, with 병합 as its fallback summary", async () => {
    setState("tasks", [job({ status: "paused", finishedAt: undefined })]);
    expect(await mergeTask("job")).toBe(true);
    const t = state.tasks[0];
    expect(t.status).toBe("done");
    expect(t.finishedAt).toBe(t.mergedAt);
    expect(t.summary).toBe("main에 병합");
  });

  it("leaves mergedAt unset when the merge fails", async () => {
    vi.mocked(native.worktreeMerge).mockRejectedValue(new Error("CONFLICT (content)"));
    setState("tasks", [job()]);
    expect(await mergeTask("job")).toBe(false);
    expect(state.tasks[0].mergedAt).toBeUndefined();
    expect(state.tasks[0].worktree?.state).toBe("open");
  });
});
