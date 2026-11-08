import { describe, expect, it } from "vitest";
import { canStep, setView, stepView, view } from "./ui";

describe("view history", () => {
  it("goes back and forward between places, and skips moves within one", () => {
    setView({ name: "task", id: "a" });
    setView({ name: "results", id: "r1" });
    setView({ name: "results", id: "r2" });
    setView({ name: "task", id: "b" });
    expect(stepView(-1)).toBe(true);
    expect(view()).toEqual({ name: "results", id: "r2" });
    expect(stepView(-1)).toBe(true);
    expect(view()).toEqual({ name: "task", id: "a" });
    expect(canStep(1)).toBe(true);
    stepView(1);
    stepView(1);
    expect(view()).toEqual({ name: "task", id: "b" });
    expect(canStep(1)).toBe(false);
  });

  it("drops what was ahead after a new move, and skips places that are gone", () => {
    setView({ name: "task", id: "x" });
    setView({ name: "task", id: "y" });
    stepView(-1);
    setView({ name: "memory" });
    expect(canStep(1)).toBe(false);
    stepView(-1, (v) => !(v.name === "task" && v.id === "x"));
    expect(view()).not.toEqual({ name: "task", id: "x" });
  });
});
