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
  it("lists every job of the workspace, a project's too", () => {
    const out = answeredIn([job("root"), job("proj", { project: "yomates" })], { after: 0 });
    expect(out.map((a) => a.taskId)).toEqual(["root", "proj"]);
  });

  it("drops what was answered before the chat was cleared", () => {
    expect(answeredIn([job("root")], { after: 100 })).toEqual([]);
    expect(answeredIn([job("root")], { after: 99 })).toHaveLength(1);
  });

  it("leaves out the Discord agent's jobs", () => {
    expect(answeredIn([job("bot", { agent: {} })], { after: 0 })).toEqual([]);
  });
});
