import { describe, expect, it } from "vitest";
import { menuHidden, skillDescription } from "./skillMenu";
import { skillLine } from "./agentTools";

const files = import.meta.glob<string>("../../skills/*/SKILL.md", { query: "?raw", import: "default", eager: true });
const bundled = Object.entries(files).map(([path, md]) => ({ name: path.split("/").slice(-2)[0], md }));

describe("skillDescription", () => {
  it("reads one-line and folded descriptions", () => {
    expect(skillDescription("---\nname: a\ndescription: Does a thing.\n---\nbody")).toBe("Does a thing.");
    expect(skillDescription("---\nname: b\ndescription: >-\n  Deep research with sources:\n  plan the questions.\n---\n")).toBe("Deep research with sources: plan the questions.");
    expect(skillDescription("no frontmatter")).toBe("");
  });
});

describe("the / menu", () => {
  it("leaves out the skills only the work picks up, and keeps the ones a user starts", () => {
    const hidden = bundled.filter((s) => menuHidden(s.md)).map((s) => s.name).sort();
    expect(hidden).toEqual([
      "browser-use", "code-review", "coding-playbooks", "computer-use", "device-use", "discord",
      "github", "modern-web-guidance", "office-docs", "ondra", "secrets", "test-ci", "visual-report",
    ]);
    for (const name of ["sharpen", "goal-loop", "overnight", "recap", "qa", "deep-research", "code-map"])
      expect(menuHidden(bundled.find((s) => s.name === name)!.md)).toBe(false);
  });

  it("reads the flag only from the frontmatter's metadata", () => {
    expect(menuHidden("---\nname: a\ndescription: b\nmetadata:\n  ondra-menu: hidden\n---\nbody")).toBe(true);
    expect(menuHidden("---\nname: a\ndescription: b\nmetadata:\n  ondra-menu: 'hidden'\n  ondra-tools: 'x'\n---\n")).toBe(true);
    expect(menuHidden("---\nname: a\ndescription: b\n---\n  ondra-menu: hidden\n")).toBe(false);
    expect(menuHidden("---\nname: a\ndescription: ondra-menu: hidden\n---\n")).toBe(false);
  });

  it("gives every bundled skill its own line", () => {
    for (const { name } of bundled) expect(skillLine({ name, description: "Not ours." }), name).not.toBe("Not ours.");
  });
});
