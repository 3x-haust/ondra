import { describe, expect, it } from "vitest";
import { isBeta } from "./beta";

describe("isBeta", () => {
  it("is beta before 1.0 and for a -beta tag, not after", () => {
    expect(isBeta("0.42.0")).toBe(true);
    expect(isBeta("v0.6.0-beta.1")).toBe(true);
    expect(isBeta("1.0.0")).toBe(false);
    expect(isBeta("1.2.0-beta")).toBe(true);
    expect(isBeta("")).toBe(false);
  });
});
