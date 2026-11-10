import { describe, expect, it } from "vitest";
import { setState } from "../state/store";
import type { Connection } from "../state/types";
import { canUseTools, connModelLabel, firstModel, levelMap, modelFromFound, normalBase, PRESETS, presetForm, providerEntry, providerId, toolsRefused } from "./connections";

const conn = (over: Partial<Connection> = {}): Connection => ({
  provider: "direct-ollama",
  preset: "ollama",
  baseUrl: "http://localhost:11434/v1/",
  api: "openai-completions",
  headers: [],
  hasKey: false,
  models: [
    { id: "gemma3:4b", contextWindow: 32768, maxTokens: 8192, tools: false, reasoning: false, image: true },
    { id: "qwen3:8b", contextWindow: 40960, maxTokens: 8192, tools: true, reasoning: true, image: false },
  ],
  ...over,
});

describe("presets", () => {
  it("fill the form", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["ollama", "lmstudio", "openrouter", "openai", "anthropic", "custom"]);
    expect(presetForm("ollama")).toEqual({ preset: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", needsKey: false, keyless: true });
    expect(presetForm("lmstudio").baseUrl).toBe("http://localhost:1234/v1");
    expect(presetForm("openrouter")).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", needsKey: true });
    // the generic ones leave the name and address to the person
    expect(presetForm("anthropic")).toMatchObject({ name: "", baseUrl: "", api: "anthropic-messages", needsKey: false, keyless: false });
    expect(presetForm("custom")).toMatchObject({ name: "", baseUrl: "", api: "openai-completions" });
    expect(presetForm("nope").preset).toBe("custom");
  });
});

describe("models.json entry", () => {
  it("is what the engine reads, with no key in it", () => {
    const e = providerEntry(conn(), "Ollama");
    expect(e).toEqual({
      name: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
      models: [
        { id: "gemma3:4b", reasoning: false, input: ["text", "image"], contextWindow: 32768, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { id: "qwen3:8b", reasoning: true, input: ["text"], contextWindow: 40960, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    });
    expect(JSON.stringify(e)).not.toMatch(/apiKey|headers/);
  });
  it("keeps OpenRouter to the engine's own detection and Anthropic's base without /v1", () => {
    expect(providerEntry(conn({ preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), "OR").compat).toBeUndefined();
    const a = providerEntry(conn({ preset: "anthropic", api: "anthropic-messages", baseUrl: "https://gw.example.com/v1/" }), "GW");
    expect(a.baseUrl).toBe("https://gw.example.com");
    expect(a.compat).toEqual({ supportsEagerToolInputStreaming: false, supportsLongCacheRetention: false });
    expect(normalBase("openai-completions", " http://x/v1/ ")).toBe("http://x/v1");
  });
  it("never asks for more output than the context holds", () => {
    const e = providerEntry(conn({ models: [{ id: "m", contextWindow: 4096, maxTokens: 9000, tools: true, reasoning: false, image: false }] }), "x");
    expect((e.models as { maxTokens: number }[])[0].maxTokens).toBe(4096);
  });
  it("maps reasoning levels onto the values a server takes", () => {
    expect(levelMap(["low", "high", "max"])).toEqual({ off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" });
    expect(levelMap(["none", "low", "medium", "high"])).toMatchObject({ off: "none", xhigh: "high", max: "high" });
    expect(levelMap([])).toBeUndefined();
    expect(levelMap(["weird"])).toBeUndefined();
    const e = providerEntry(conn({ models: [{ id: "r", contextWindow: 524288, maxTokens: 65536, tools: true, reasoning: true, image: false, efforts: ["low", "high", "max"] }] }), "x");
    expect((e.models as { thinkingLevelMap?: object }[])[0].thinkingLevelMap).toMatchObject({ medium: "high", max: "max", off: null });
  });
});

describe("listed models", () => {
  it("get defaults for what the server didn't say", () => {
    expect(modelFromFound({ id: "llama3.1:8b" }, true)).toEqual({ id: "llama3.1:8b", contextWindow: 32768, maxTokens: 8192, tools: true, reasoning: false, image: false });
    expect(modelFromFound({ id: "a/b", name: "B", contextWindow: 200000, maxTokens: 64000, tools: false, reasoning: true }, false)).toEqual({ id: "a/b", name: "B", contextWindow: 200000, maxTokens: 64000, tools: false, reasoning: true, image: false });
    expect(modelFromFound({ id: "tiny", contextWindow: 4096 }, false).maxTokens).toBe(2048);
  });
  it("name a provider id from the connection's name", () => {
    expect(providerId("My Gateway!")).toBe("direct-my-gateway");
    expect(providerId("회사 서버")).toBe("direct-conn");
    expect(providerId("Ollama", ["direct-ollama"])).toBe("direct-ollama-2");
  });
});

describe("tools", () => {
  it("are off only for a connection model marked so", () => {
    setState("accounts", [{ id: "acc-c", space: "home", label: "Ollama", providers: ["direct-ollama"], model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, connection: conn() }]);
    expect(canUseTools("acc-c", "direct-ollama/gemma3:4b")).toBe(false);
    expect(canUseTools("acc-c", "direct-ollama/qwen3:8b")).toBe(true);
    expect(canUseTools("acc-c", undefined)).toBe(true);
    expect(canUseTools("default", "openai-codex/gpt-5.6")).toBe(true);
    expect(connModelLabel("acc-c", "direct-ollama/qwen3:8b")).toBe("qwen3:8b");
    expect(connModelLabel("default", "openai-codex/gpt-5.6")).toBeUndefined();
    expect(firstModel(conn())).toBe("direct-ollama/qwen3:8b");
    setState("accounts", []);
  });
  it("refusals are recognised", () => {
    expect(toolsRefused("400 registry.ollama.ai/library/gemma:2b does not support tools")).toBe(true);
    expect(toolsRefused("Function calling is not enabled for this model")).toBe(true);
    expect(toolsRefused("401 invalid api key")).toBe(false);
  });
});
