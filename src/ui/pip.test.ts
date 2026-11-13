import { describe, expect, it } from "vitest";
import type { Task } from "../state/types";
import { cornerOf, cornerSpot, nearestCorner, pipJob, projectRelease } from "./pip";

const job = (id: string, o: Partial<Task> & { browsedAt?: number } = {}): Task =>
  ({
    id,
    status: "running",
    browser: true,
    createdAt: 0,
    startedAt: 1,
    entries: o.browsedAt ? [{ id: `${id}-e`, kind: "tool", at: o.browsedAt, tool: { kind: "browser", name: "browser", target: "open a.com" } }] : [],
    ...o,
  }) as unknown as Task;

describe("the floating browser", () => {
  it("shows the running job that browsed last", () => {
    expect(pipJob([job("a", { browsedAt: 10 }), job("b", { browsedAt: 30 }), job("c", { browsedAt: 20 })], new Set())?.id).toBe("b");
  });
  it("leaves out jobs that aren't browsing, aren't running, or were closed", () => {
    const list = [job("a", { browser: false, browsedAt: 50 }), job("b", { status: "done", browsedAt: 40 }), job("c", { browsedAt: 30 }), job("d", { browsedAt: 20 })];
    expect(pipJob(list, new Set(["c"]))?.id).toBe("d");
    expect(pipJob(list, new Set(["c", "d"]))).toBeUndefined();
  });
  it("snaps to the nearest corner", () => {
    expect(nearestCorner(100, 100, 1000, 800)).toBe("tl");
    expect(nearestCorner(900, 100, 1000, 800)).toBe("tr");
    expect(nearestCorner(100, 700, 1000, 800)).toBe("bl");
    expect(nearestCorner(900, 700, 1000, 800)).toBe("br");
  });
  it("keeps a stored corner, else bottom right", () => {
    expect(cornerOf("tl")).toBe("tl");
    expect(cornerOf("middle")).toBe("br");
    expect(cornerOf(null)).toBe("br");
  });
  it("sits clear of the title bar, the composer and the sides", () => {
    expect(cornerSpot("tl", 1200, 800, 320, 200)).toEqual({ x: 16, y: 60 });
    expect(cornerSpot("br", 1200, 800, 320, 200)).toEqual({ x: 864, y: 496 });
    // a window too small for it keeps it on screen at the top left
    expect(cornerSpot("br", 300, 200, 320, 200)).toEqual({ x: 16, y: 60 });
  });
  it("is thrown on by how fast it was let go", () => {
    // a slow let-go in the top left stays there; a flick to the right crosses the window
    const slow = projectRelease({ x: 300, y: 200 }, { x: 0.2, y: 0 });
    expect(nearestCorner(slow.x, slow.y, 1200, 800)).toBe("tl");
    const flick = projectRelease({ x: 300, y: 200 }, { x: 2.5, y: 1.5 });
    expect(nearestCorner(flick.x, flick.y, 1200, 800)).toBe("br");
  });
});
