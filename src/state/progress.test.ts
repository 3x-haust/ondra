import { describe, expect, it } from "vitest";
import { pausedAt, stepState } from "./progress";
import type { Task } from "./types";

describe("to-do rows", () => {
  const now = { text: "test", state: "now" as const };
  it("marks the current step only while the task runs", () => {
    expect(stepState(now, { status: "running" } as Task)).toBe("now");
    for (const status of ["paused", "failed", "waiting", "queued", "done"] as const) expect(stepState(now, { status } as Task)).toBe("todo");
  });
  it("leaves done and skipped steps as they are", () => {
    expect(stepState({ text: "a", state: "done" }, { status: "paused" } as Task)).toBe("done");
    expect(stepState({ text: "b", state: "skip" }, { status: "paused" } as Task)).toBe("skip");
  });
});

describe("paused time", () => {
  const base = { status: "paused", entries: [], legs: [], createdAt: 1 } as unknown as Task;
  it("reads the last pause note", () => {
    const t = { ...base, entries: [{ kind: "note", text: "일시정지", at: 50 }, { kind: "note", text: "x", at: 60 }], legs: [{ startedAt: 10, endedAt: 40 }] } as unknown as Task;
    expect(pausedAt(t)).toBe(50);
  });
  it("falls back to the last session's end, then the finish, then the last entry", () => {
    expect(pausedAt({ ...base, legs: [{ startedAt: 10, endedAt: 40 }], finishedAt: 45 } as unknown as Task)).toBe(40);
    expect(pausedAt({ ...base, legs: [{ startedAt: 10 }], finishedAt: 45 } as unknown as Task)).toBe(45);
    expect(pausedAt({ ...base, entries: [{ kind: "note", text: "x", at: 30 }] } as unknown as Task)).toBe(30);
    expect(pausedAt(base)).toBe(1);
  });
  it("has no time unless paused", () => {
    expect(pausedAt({ ...base, status: "running" } as unknown as Task)).toBeUndefined();
  });
});
