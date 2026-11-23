import { describe, expect, it } from "vitest";
import type { Task } from "./types";
import { answeredIn } from "./answered";

const job = (id: string, over: Partial<Task> = {}): Task => ({
  id, space: "work", topic: "", title: id, ask: "", cwd: "~", status: "done", priority: 2, weight: "light",
  accountId: "default", createdAt: 0, now: "", plan: [], legs: [], shells: [], inbox: [],
  entries: [{ id: `${id}-a`, at: 100, kind: "user", text: '"PR로 올릴까요?" → PR로 올리기' }],
  ...over,
});

describe("answered questions in main", () => {
  const filed = new Set(["yomates"]);

  it("lists only the root chat's own jobs, not a project's (those show in the project's chat)", () => {
    const out = answeredIn([job("root"), job("proj", { project: "yomates" }), job("gone", { project: "removed" })], { filed, after: 0 });
    expect(out.map((a) => a.taskId)).toEqual(["root", "gone"]);
  });

  it("drops what was answered before the chat was cleared", () => {
    expect(answeredIn([job("root")], { filed, after: 100 })).toEqual([]);
    expect(answeredIn([job("root")], { filed, after: 99 })).toHaveLength(1);
  });

  it("leaves out subagents and the Discord agent's jobs", () => {
    expect(answeredIn([job("kid", { parentId: "root" }), job("bot", { agent: {} })], { filed, after: 0 })).toEqual([]);
  });
});
