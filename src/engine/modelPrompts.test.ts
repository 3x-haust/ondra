import { describe, expect, it } from "vitest";
import { forModel, LAYERS, layersOf } from "./modelPrompts";
import { SUB_SYSTEM, TASK_SYSTEM } from "./prompts";

const count = (s: string, part: string) => s.split(part).length - 1;

// a model id for every family Senpi / oh-my-openagent tune, as providers write them
const IDS: Record<string, string[]> = {
  "openai-codex/gpt-6-astra": ["gpt-6"],
  "openai/gpt-6.1-sol-fast": ["gpt-6"],
  "gpt-6-luna": ["gpt-6"],
  "openai/gpt-5.6-sol": ["gpt-5.5"],
  "gpt-5.5": ["gpt-5.5"],
  "gpt-5.4": ["gpt-5"],
  "gpt-5.3-codex": ["gpt-5"],
  "anthropic/claude-opus-5-5": ["mechanics", "claude", "opus-5.5"],
  "claude-opus-5": ["mechanics", "claude", "opus-5"],
  "claude-sonnet-5-5": ["mechanics", "claude", "sonnet-5.5"],
  "claude-haiku-5-5": ["mechanics", "claude", "haiku-5.5"],
  "claude-fable-5-2": ["mechanics", "claude", "fable", "fable-5.2"],
  "claude-fable-5-1": ["mechanics", "claude", "fable"],
  "claude-mythos-5": ["mechanics", "claude", "fable"],
  "claude-opus-4.8": ["mechanics", "claude", "opus-4"],
  "claude-sonnet-5": ["mechanics", "claude"],
  "zai-coding-plan/glm-5.3": ["mechanics", "glm"],
  "deepseek/deepseek-v4-pro": ["mechanics", "deepseek"],
  "deepseek-flash": ["mechanics", "deepseek"],
  "kimi-for-coding": ["mechanics", "kimi-k2"],
  "moonshotai/kimi-k2.6": ["mechanics", "kimi-k2"],
  "kimi-coding/k3.1-pro": ["mechanics", "kimi-k3"],
  "kimi-k3": ["mechanics", "kimi-k3"],
  "devin/swe-2-high": ["mechanics", "kimi-k3"],
  "xai/grok-4.7": ["mechanics", "grok"],
  "google/gemini-4-argon": ["mechanics", "gemini"],
  // the shared text as it is
  "ollama/gpt-oss:20b": [],
  "minimax-m2.7": [],
  "": [],
};

describe("model prompts", () => {
  it("picks the layers of each family from the model id", () => {
    for (const [id, layers] of Object.entries(IDS)) expect(layersOf(id), id).toEqual(layers);
    expect(layersOf(undefined)).toEqual([]);
  });

  it("swaps every sentence it names, and each names one place", () => {
    for (const [key, layer] of Object.entries(LAYERS)) {
      for (const [from] of layer.swaps ?? []) {
        expect(count(TASK_SYSTEM, from) + count(SUB_SYSTEM, from), `${key}: ${from.slice(0, 50)}`).toBeGreaterThan(0);
        expect(count(TASK_SYSTEM, from)).toBeLessThan(2);
        expect(count(SUB_SYSTEM, from)).toBeLessThan(2);
      }
    }
    for (const id of Object.keys(IDS)) {
      const both = forModel(TASK_SYSTEM, id) + forModel(SUB_SYSTEM, id);
      for (const key of layersOf(id)) {
        for (const [from, to] of LAYERS[key].swaps ?? []) {
          expect(both, `${id} ${key}`).toContain(to);
          if (!to.includes(from)) expect(both).not.toContain(from);
        }
        if (LAYERS[key].note) expect(forModel(SUB_SYSTEM, id)).toContain(LAYERS[key].note);
      }
    }
  });

  it("leaves models without a preset on the shared text", () => {
    expect(forModel(TASK_SYSTEM, "gpt-oss:20b")).toBe(TASK_SYSTEM);
    expect(forModel(SUB_SYSTEM, undefined)).toBe(SUB_SYSTEM);
  });

  it("tells GPT-6 to check less and stop, and Claude the mechanics it misses", () => {
    const gpt = forModel(TASK_SYSTEM, "gpt-6-astra").replace(/\s+/g, " ");
    expect(gpt).toContain("never a harness, runner, helper app or checker script built to verify");
    expect(gpt).toContain("a prompt, doc, mockup or visual change gets none");
    expect(gpt).toContain("no extra verification pass");
    // GPT-5.6's own preset asks for a real check: it keeps the shared verification
    expect(forModel(TASK_SYSTEM, "gpt-5.6-sol")).not.toContain("never a harness");
    const claude = forModel(TASK_SYSTEM, "claude-opus-5-5").replace(/\s+/g, " ");
    expect(claude).toContain("the exact command you ran here, copied as it was");
    expect(claude).toContain("read the SKILL.md before the first step");
    expect(claude).toContain("When the plan check or the review below applies, it is required");
    expect(claude).toContain("never end the turn with text");
    // Kimi K3 acts on its own too readily: the mechanics, not the required review
    expect(forModel(TASK_SYSTEM, "kimi-k3")).not.toContain("it is required");
  });

  it("keeps each model's prompts near the shared budget", () => {
    for (const id of Object.keys(IDS)) {
      expect(forModel(TASK_SYSTEM, id).length, id).toBeLessThan(24_650); // + plain writing (ASD-STE100), ask fields, live cards
      expect(forModel(SUB_SYSTEM, id).length, id).toBeLessThan(9_200);
    }
  });
});
