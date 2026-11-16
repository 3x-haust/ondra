import { describe, expect, it } from "vitest";
import { familyOf, forModel, VARIANTS } from "./modelPrompts";
import { SUB_SYSTEM, TASK_SYSTEM } from "./prompts";

const count = (s: string, part: string) => s.split(part).length - 1;

describe("model-family prompts", () => {
  it("knows the family from the model id", () => {
    expect(familyOf("openai-codex/gpt-6-astra")).toBe("gpt");
    expect(familyOf("gpt-5.6-sol")).toBe("gpt");
    expect(familyOf("anthropic/claude-opus-5-5")).toBe("claude");
    expect(familyOf("claude-fable-5-2")).toBe("claude");
    // the small open model keeps the shared push to check
    expect(familyOf("ollama/gpt-oss:20b")).toBe("base");
    expect(familyOf("google/gemini-4-argon")).toBe("base");
    expect(familyOf(undefined)).toBe("base");
  });

  it("swaps every sentence it names, and each names one place", () => {
    for (const [family, pairs] of Object.entries(VARIANTS)) {
      for (const [from] of pairs) {
        const n = count(TASK_SYSTEM, from) + count(SUB_SYSTEM, from);
        expect(n, `${family}: ${from.slice(0, 50)}`).toBeGreaterThan(0);
        expect(count(TASK_SYSTEM, from), from.slice(0, 50)).toBeLessThan(2);
        expect(count(SUB_SYSTEM, from), from.slice(0, 50)).toBeLessThan(2);
      }
      const model = family === "gpt" ? "gpt-6-astra" : "claude-opus-5-5";
      const both = forModel(TASK_SYSTEM, model) + forModel(SUB_SYSTEM, model);
      for (const [from, to] of pairs) {
        expect(both).toContain(to);
        if (!to.includes(from)) expect(both).not.toContain(from);
      }
    }
  });

  it("leaves other models on the shared text", () => {
    expect(forModel(TASK_SYSTEM, "gpt-oss:20b")).toBe(TASK_SYSTEM);
    expect(forModel(SUB_SYSTEM, undefined)).toBe(SUB_SYSTEM);
  });

  it("tells GPT to check less and stop, and Claude the mechanics it misses", () => {
    const gpt = forModel(TASK_SYSTEM, "gpt-6-astra").replace(/\s+/g, " ");
    expect(gpt).toContain("never a harness, runner, helper app or checker script built to verify");
    expect(gpt).toContain("a prompt, doc, mockup or visual change gets none");
    expect(gpt).toContain("no extra verification pass");
    const claude = forModel(TASK_SYSTEM, "claude-opus-5-5").replace(/\s+/g, " ");
    expect(claude).toContain("the exact command you ran here, copied as it was");
    expect(claude).toContain("a call that is only `sleep N`");
    expect(claude).toContain("read the SKILL.md before the first step");
    expect(forModel(SUB_SYSTEM, "claude-opus-5-5")).toContain("a call that is only `sleep N`");
  });

  it("keeps each family's prompts near the shared budget", () => {
    for (const model of ["gpt-6-astra", "claude-opus-5-5"]) {
      expect(forModel(TASK_SYSTEM, model).length).toBeLessThan(23_600);
      expect(forModel(SUB_SYSTEM, model).length).toBeLessThan(8_500);
    }
  });
});
