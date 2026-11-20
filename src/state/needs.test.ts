import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { agentDecisions, allDecisions, freshState, listed, setState, state, trimChats } from "./store";
import type { CaptainMessage, Task } from "./types";
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

describe("the Discord agent's work", () => {
  beforeEach(() => setState(reconcile(freshState())));

  it("is in none of the user's lists: not listed, not 내 차례, its questions only in the agent tab", () => {
    const mine = job("mine");
    const its = job("its", { agent: { channel: "c1" } });
    const sub = job("sub", { parentId: "its" });
    setState("tasks", [mine, its, sub]);
    setState("decisions", [
      { id: "d1", taskId: "mine", at: 1, kind: "ask", question: "?", context: [], options: [] },
      { id: "d2", taskId: "its", at: 1, kind: "ask", question: "?", context: [], options: [] },
      { id: "d3", taskId: "sub", at: 1, kind: "ask", question: "?", context: [], options: [] },
    ]);
    expect(listed(mine)).toBe(true);
    expect(listed(its)).toBe(false);
    expect(needsYou(its)).toBe(false);
    expect(allDecisions().map((d) => d.id)).toEqual(["d1"]);
    expect(agentDecisions().map((d) => d.id)).toEqual(["d2", "d3"]);
  });

  it("a busy chat keeps its last messages without pushing another chat's out", () => {
    const m = (id: string, project?: string): CaptainMessage => ({ id, at: 1, space: "home", project, from: "me", text: id });
    const list = [m("main-old"), ...Array.from({ length: 5 }, (_, i) => m(`a${i}`, "@agent"))];
    const kept = trimChats(list, 3);
    expect(kept.map((x) => x.id)).toEqual(["main-old", "a2", "a3", "a4"]);
    expect(trimChats(kept, 3)).toBe(kept);
  });
});
