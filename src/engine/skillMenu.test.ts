import { describe, expect, it } from "vitest";
import { skillDescription } from "./skillMenu";

describe("skillDescription", () => {
  it("reads one-line and folded descriptions", () => {
    expect(skillDescription("---\nname: a\ndescription: Does a thing.\n---\nbody")).toBe("Does a thing.");
    expect(skillDescription("---\nname: b\ndescription: >-\n  Deep research with sources:\n  plan the questions.\n---\n")).toBe("Deep research with sources: plan the questions.");
    expect(skillDescription("no frontmatter")).toBe("");
  });
});
