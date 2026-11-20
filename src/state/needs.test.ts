import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "./store";
import type { Task } from "./types";
import { needsYou } from "./needs";

const job = (id: string, over: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "", title: id, ask: "", cwd: "/repo", status: "waiting",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [{ startedAt: 1 }],
  entries: [], shells: [], inbox: [], ...over,
});

describe("내 차례", () => {
  beforeEach(() => setState(reconcile(freshState())));

  it("leaves out a job the user put away, however it ended", () => {
    expect(needsYou(job("a"))).toBe(true);
    expect(needsYou(job("b", { archived: true }))).toBe(false);
    expect(needsYou(job("c", { status: "failed", archived: true }))).toBe(false);
    expect(needsYou(job("d", { status: "done", archived: true, worktree: { state: "open", repo: "/r", path: "/r/w", branch: "x", base: "b", sub: "" } }))).toBe(false);
  });

  it("with only a put-away job waiting, there is nothing in it (the count and the one-click open)", () => {
    setState("tasks", [job("old", { archived: true })]);
    expect(state.tasks.filter(needsYou)).toHaveLength(0);
    setState("tasks", [job("old", { archived: true }), job("live")]);
    expect(state.tasks.filter(needsYou).map((t) => t.id)).toEqual(["live"]);
  });
});
