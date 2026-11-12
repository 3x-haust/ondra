import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { decide, mergeTask, sweepLanded } from "./tasks";

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

describe("the merge question", () => {
  const changes = { isRepo: true, files: [{ path: "src/a.ts", add: 3, del: 1 }] } as never;
  beforeEach(() => {
    vi.spyOn(native, "gitChanges").mockResolvedValue(changes);
    vi.spyOn(native, "worktreeLanded").mockResolvedValue(null as never);
  });

  it("is asked of a finished job that still holds changes, with merge, PR and discard", async () => {
    setState("tasks", [job({ finishedAt: Date.now() })]);
    await sweepLanded();
    const d = state.decisions.find((x) => x.taskId === "job");
    expect(d?.kind).toBe("merge");
    expect(d?.options.map((o) => o.id)).toEqual(["merge", "pr", "discard"]);
    // asked once, not again on the next sweep
    await sweepLanded();
    expect(state.decisions.filter((x) => x.taskId === "job")).toHaveLength(1);
  });

  it("is not asked when the work went into a pull request", async () => {
    setState("tasks", [job({ finishedAt: Date.now(), entries: [{ id: "e", at: 1, kind: "text", text: "https://github.com/a/b/pull/7" } as never] })]);
    vi.spyOn(native, "ghPrState").mockResolvedValue("" as never);
    await sweepLanded();
    expect(state.decisions).toHaveLength(0);
  });

  it("merges or throws the work away on the answer", async () => {
    setState("tasks", [job({ finishedAt: Date.now() })]);
    await sweepLanded();
    await decide(state.decisions[0].id, "merge");
    expect(state.tasks[0].worktree?.state).toBe("merged");

    setState("tasks", [job({ finishedAt: Date.now() })]);
    setState("decisions", []);
    await sweepLanded();
    await decide(state.decisions[0].id, "discard");
    expect(state.tasks[0].worktree?.state).toBe("discarded");
  });
});
