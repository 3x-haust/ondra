import { describe, expect, it } from "vitest";
import type { Task } from "./types";
import { foldLabel, PAUSED_FOR, stale } from "./fold";

const job = (over: Partial<Task> = {}): Task => ({
  id: "j", space: "home", topic: "", title: "", ask: "", cwd: "~", status: "paused", priority: 2, weight: "light",
  accountId: "default", createdAt: 0, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], ...over,
});

describe("a paused job left for days", () => {
  const now = 100 * PAUSED_FOR;
  it("folds away with the finished ones, but not a fresh or pinned one", () => {
    expect(stale(job({ startedAt: now - PAUSED_FOR - 1 }), now)).toBe(true);
    expect(stale(job({ startedAt: now - 1000 }), now)).toBe(false);
    expect(stale(job({ startedAt: now - PAUSED_FOR - 1, entries: [{ id: "n", at: now - 1000, kind: "note", text: "일시정지" }] }), now)).toBe(false);
    expect(stale(job({ startedAt: now - PAUSED_FOR - 1, pinned: true }), now)).toBe(false);
    expect(stale(job({ status: "running", startedAt: 0 }), now)).toBe(false);
  });

  it("is counted in the fold's label", () => {
    expect(foldLabel([job({ status: "done" }), job({ status: "done" }), job()])).toBe("완료 2개 · 멈춤 1개");
    expect(foldLabel([job()])).toBe("멈춤 1개");
  });
});
