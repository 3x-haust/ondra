import { describe, expect, it } from "vitest";
import { handoffAt, handoffSteer, windowFor } from "./handoff";

describe("handoffAt", () => {
  it("hands off near two thirds of the reported window", () => {
    expect(handoffAt(200_000)).toEqual([130_000, 160_000]);
    expect(handoffAt(272_000)).toEqual([176_800, 217_600]);
    expect(handoffAt(1_000_000)).toEqual([650_000, 800_000]);
  });

  it("keeps a floor for small windows and stays below the window", () => {
    const [first, second] = handoffAt(128_000);
    expect(first).toBe(100_000);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(128_000);
  });

  it("falls back to the model id when the engine reported no window", () => {
    expect(handoffAt(undefined, "anthropic/claude-opus-4-5")).toEqual(handoffAt(200_000));
    expect(handoffAt(0, "openai-codex/gpt-6-astra")).toEqual(handoffAt(272_000));
    expect(windowFor("anthropic/claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(windowFor(undefined)).toBe(200_000);
  });

  it("never hands off at the old 90k growth mark on a large window", () => {
    expect(handoffAt(272_000)[0]).toBeGreaterThan(30_000 + 90_000);
  });
});

describe("handoffSteer", () => {
  it("asks for a handoff without telling the job to stop working", () => {
    const first = handoffSteer(0, 180_000, 272_000);
    expect(first).toContain("180k of 272k");
    expect(first).toContain("Keep working");
    expect(first).not.toMatch(/Don't start anything new|finish the step you are on/);
    expect(handoffSteer(1, 220_000, 272_000)).toContain("handoff");
  });
});
