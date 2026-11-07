import { describe, expect, it } from "vitest";
import { newer } from "../src/engine/releaseNotes";

describe("newer", () => {
  it("compares versions by number", () => {
    expect(newer("0.4.10", "0.4.9")).toBe(true);
    expect(newer("0.5.0", "0.4.12")).toBe(true);
    expect(newer("0.4.3", "0.4.3")).toBe(false);
    expect(newer("0.4.2", "0.4.3")).toBe(false);
  });
});
