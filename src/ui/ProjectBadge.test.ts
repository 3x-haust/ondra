import { describe, expect, it } from "vitest";
import { projectHue, projectLetters } from "./ProjectBadge";

describe("project badge", () => {
  it("picks letters from the name", () => {
    expect(projectLetters("ondra")).toBe("ON");
    expect(projectLetters("acme web")).toBe("AW");
    expect(projectLetters("3xhaustpi")).toBe("3X");
    expect(projectLetters("blog2")).toBe("B2");
    expect(projectLetters("블로그")).toBe("블");
    expect(projectLetters("x")).toBe("X");
  });

  it("keeps a name's tint", () => {
    expect(projectHue("ondra")).toBe(projectHue("ondra"));
    expect(new Set(["ondra", "acme", "blog", "docs", "api", "web"].map(projectHue)).size).toBeGreaterThan(2);
  });
});
