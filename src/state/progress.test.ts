import { describe, expect, it } from "vitest";
import { stepState } from "./progress";
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
