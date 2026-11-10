// Direct connections: any OpenAI-, Anthropic- or Google-compatible address (Ollama,
// LM Studio, vLLM, OpenRouter, a company gateway…) used as an account. Each one is
// its own account, so its engine folder (PI_CODING_AGENT_DIR) holds a models.json
// with it as a provider; the key and header values stay in the keychain (providers.rs).
import { accountById } from "../state/store";
import type { Account, Connection, ConnectionApi, ConnectionModel } from "../state/types";
import type { FoundModel } from "../lib/native";

/** The API kinds the engine has for a custom provider; `label` is the Korean key. */
export const APIS: { id: ConnectionApi; label: string }[] = [
  { id: "openai-completions", label: "OpenAI 호환 · Chat Completions" },
  { id: "openai-responses", label: "OpenAI · Responses" },
  { id: "anthropic-messages", label: "Anthropic 호환 · Messages" },
  { id: "google-generative-ai", label: "Google Gemini" },
];

export type Preset = {
  id: string;
  /** shown as is for products, through t() for the generic ones */
  name: string;
  baseUrl: string;
  api: ConnectionApi;
  /** a server on this Mac: no key, smaller defaults */
  local?: boolean;
  /** "required" asks for a key before saving */
  key: "none" | "optional" | "required";
  /** an example address for the empty field */
  example?: string;
};

export const PRESETS: Preset[] = [
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", local: true, key: "none" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", api: "openai-completions", local: true, key: "none" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", key: "required" },
  { id: "openai", name: "OpenAI 호환", baseUrl: "", api: "openai-completions", key: "optional", example: "https://api.example.com/v1" },
  { id: "anthropic", name: "Anthropic 호환", baseUrl: "", api: "anthropic-messages", key: "optional", example: "https://api.example.com" },
  { id: "custom", name: "직접 입력", baseUrl: "", api: "openai-completions", key: "optional", example: "http://localhost:8000/v1" },
];
export const presetOf = (id: string | undefined) => PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
/** the generic presets have Korean names that go through t() */
export const GENERIC_PRESETS = new Set(["openai", "anthropic", "custom"]);

/** The form for a preset: what it fills in. */
export function presetForm(id: string) {
  const p = presetOf(id);
  return { preset: p.id, name: GENERIC_PRESETS.has(p.id) ? "" : p.name, baseUrl: p.baseUrl, api: p.api, needsKey: p.key === "required", keyless: p.key === "none" };
}

/** sizes when the server doesn't say: local servers run small contexts */
export const defaults = (local: boolean) => (local ? { contextWindow: 32768, maxTokens: 8192 } : { contextWindow: 128000, maxTokens: 16384 });

/** A listed model as a row of the form: what the server said, defaults for the rest. */
export function modelFromFound(f: FoundModel, local: boolean): ConnectionModel {
  const d = defaults(local);
  const contextWindow = f.contextWindow ?? d.contextWindow;
  return {
    id: f.id,
    ...(f.name ? { name: f.name } : {}),
    contextWindow,
    maxTokens: Math.min(f.maxTokens ?? d.maxTokens, Math.max(1024, Math.floor(contextWindow / 2))),
    // unknown counts as able: the check (연결 확인) finds out for sure
    tools: f.tools ?? true,
    reasoning: f.reasoning ?? false,
    image: f.image ?? false,
  };
}

/** "My Gateway!" → "direct-my-gateway"; a name with no latin letters → "direct-conn". */
export function providerId(name: string, taken: string[] = []): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "conn";
  let id = `direct-${slug}`;
  for (let n = 2; taken.includes(id); n++) id = `direct-${slug}-${n}`;
  return id;
}

/** The address as the engine wants it: no trailing slash; Anthropic's SDK adds /v1 itself. */
export function normalBase(api: ConnectionApi, url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return api === "anthropic-messages" ? u.replace(/\/v1$/, "") : u;
}

// reasoning levels in order; Ondra picks low…max, the engine also knows off and minimal
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const RANK: Record<string, number> = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/**
 * The engine's thinkingLevelMap for a server that takes only some reasoning_effort values
 * ("low, high, max"): each level goes to the nearest value it takes (a tie goes up), and
 * off is unsupported unless "none"/"off" is one of them.
 */
export function levelMap(efforts: string[] | undefined): Record<string, string | null> | undefined {
  const allowed = [...new Set((efforts ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e in RANK))];
  if (!allowed.length) return undefined;
  const map: Record<string, string | null> = {};
  for (const level of LEVELS) {
    if (level === "off") {
      map.off = allowed.find((a) => RANK[a] === 0) ?? null;
      continue;
    }
    const on = allowed.filter((a) => RANK[a] > 0);
    if (!on.length) {
      map[level] = null;
      continue;
    }
    map[level] = on.reduce((best, a) => {
      const d = Math.abs(RANK[a] - RANK[level]);
      const bd = Math.abs(RANK[best] - RANK[level]);
      return d < bd || (d === bd && RANK[a] > RANK[best]) ? a : best;
    });
  }
  return map;
}

/** Compatibility flags that keep requests plain for servers that are only partly OpenAI- or Anthropic-like. */
function compatFor(c: Pick<Connection, "api" | "preset" | "baseUrl">): Record<string, unknown> | undefined {
  if (c.api === "openai-completions") {
    // OpenRouter is detected by the engine from its address
    if (c.preset === "openrouter" || c.baseUrl.includes("openrouter.ai")) return undefined;
    // max_tokens: the field compatible servers (vLLM, llama.cpp, Ollama, most gateways) all take
    return { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" };
  }
  if (c.api === "anthropic-messages") return { supportsEagerToolInputStreaming: false, supportsLongCacheRetention: false };
  return undefined;
}

/** The provider entry for models.json, without `apiKey` and `headers` (providers.rs sets those from the keychain). */
export function providerEntry(c: Connection, name: string): Record<string, unknown> {
  const compat = compatFor(c);
  return {
    name: name.trim() || c.provider,
    baseUrl: normalBase(c.api, c.baseUrl),
    api: c.api,
    ...(compat ? { compat } : {}),
    models: c.models.map((m) => {
      const map = m.reasoning ? levelMap(m.efforts) : undefined;
      return {
        id: m.id,
        ...(m.name && m.name !== m.id ? { name: m.name } : {}),
        reasoning: m.reasoning,
        ...(map ? { thinkingLevelMap: map } : {}),
        input: m.image ? ["text", "image"] : ["text"],
        contextWindow: Math.max(1024, Math.round(m.contextWindow)),
        // the engine also keeps input + max_tokens under the context window on each request
        maxTokens: Math.max(256, Math.min(Math.round(m.maxTokens), Math.round(m.contextWindow))),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }),
  };
}

// ───────────── using them

export const connectionOf = (accountId: string | undefined): Connection | undefined => (accountId ? accountById(accountId)?.connection : undefined);
export const isDirect = (a: Account | undefined) => !!a?.connection;

/** The connection's own row for a "provider/id" model, if it is one of its models. */
export function connModel(accountId: string | undefined, model: string | undefined): ConnectionModel | undefined {
  const c = connectionOf(accountId);
  if (!c || !model) return undefined;
  const id = model.startsWith(`${c.provider}/`) ? model.slice(c.provider.length + 1) : undefined;
  return id === undefined ? undefined : c.models.find((m) => m.id === id);
}

/** False only for a connection's model marked as having no tools: work on it runs talk-only. */
export function canUseTools(accountId: string | undefined, model: string | undefined): boolean {
  return connModel(accountId, model)?.tools !== false;
}

/** How a connection's model is named: its own name or id as typed ("llama3.1:8b"), not prettified. */
export function connModelLabel(accountId: string | undefined, model: string): string | undefined {
  const c = connectionOf(accountId);
  if (!c || !model.startsWith(`${c.provider}/`)) return undefined;
  const m = connModel(accountId, model);
  return m?.name || model.slice(c.provider.length + 1);
}

/** The first model that can use tools (else the first): what a new connection's work starts on. */
export function firstModel(c: Connection): string {
  const m = c.models.find((x) => x.tools) ?? c.models[0];
  return m ? `${c.provider}/${m.id}` : "";
}

/** An engine error that says the model has no tool calling. */
export const toolsRefused = (message: string) =>
  /does not support tools|tools? (?:use |calling )?(?:is |are )?not supported|not support(?:ed)? (?:for )?(?:tool|function)|tool_choice.*not supported|function calling is not (?:enabled|supported)/i.test(message);
