import { describe, expect, it } from "vitest";
import { elapsedOf, paceOf } from "./limits";

const H = 3_600_000;

describe("plan window progress", () => {
  it("knows how far a window has run from its length and reset time", () => {
    const now = 1_000 * H;
    // a 5-hour window resetting in 2 hours is 60% through
    expect(elapsedOf({ window: 300, resetsAt: now + 2 * H }, now)).toBeCloseTo(0.6);
    expect(elapsedOf({ window: 300, resetsAt: now + 9 * H }, now)).toBe(0);
    expect(elapsedOf({ window: 300, resetsAt: null }, now)).toBeUndefined();
  });

  it("says ahead, on or under pace with 5 points either way", () => {
    const now = 1_000 * H;
    // a week half gone (3.5 days left)
    const half = { window: 10_080, resetsAt: now + 84 * H };
    expect(paceOf({ ...half, used: 70 }, now)).toBe("ahead");
    expect(paceOf({ ...half, used: 53 }, now)).toBe("on");
    expect(paceOf({ ...half, used: 20 }, now)).toBe("under");
    expect(paceOf({ window: 10_080, resetsAt: undefined, used: 20 }, now)).toBeUndefined();
  });
});
