import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, taskById } from "../state/store";
import type { Task } from "../state/types";
import { claimBranch } from "./tasks";

const WT = { repo: "/repo", path: "/data/worktrees/web-a", branch: "feat/guest", base: "abc", sub: "", state: "open" as const };
const job = (over: Partial<Task>): Task => ({
  id: "x", space: "home", topic: "web", title: "x", ask: "x", cwd: "/repo", status: "done", priority: 2, weight: "light",
  accountId: "a", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], isolate: false, ...over,
});

beforeEach(() => setState(reconcile(freshState())));

describe("the branch lives on the newest job in its folder", () => {
  it("moves from a finished job to a sibling carrying on in its worktree", () => {
    setState("tasks", [
      job({ id: "a", title: "비로그인 먼저 쓰기" }),
      job({ id: "b", title: "게스트로 웹 띄우기", follows: "a", cwd: WT.path, worktree: WT }),
      job({ id: "c", title: "리뷰 지적 전부 수정", follows: "a", cwd: `${WT.path}/apps/web`, status: "running" }),
    ]);
    claimBranch("c");
    expect(taskById("c")!.worktree?.branch).toBe("feat/guest");
    expect(taskById("b")!.worktree).toBeUndefined();
    expect(taskById("b")!.entries.slice(-1)[0]).toMatchObject({ kind: "note", text: expect.stringContaining("리뷰 지적 전부 수정") });
  });

  it("leaves it with a job that is still working, and ignores other folders", () => {
    setState("tasks", [
      job({ id: "b", cwd: WT.path, worktree: WT, status: "running" }),
      job({ id: "c", cwd: WT.path, status: "running" }),
      job({ id: "d", cwd: "/data/worktrees/web-ab", status: "running" }),
    ]);
    claimBranch("c");
    claimBranch("d");
    expect(taskById("b")!.worktree?.state).toBe("open");
    expect(taskById("c")!.worktree).toBeUndefined();
    expect(taskById("d")!.worktree).toBeUndefined();
  });
});
