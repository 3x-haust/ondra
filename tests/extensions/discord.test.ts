import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine provides typebox at runtime; retain the declared fields for inspection.
vi.mock("typebox", () => ({ Type: {
  Object: (properties: unknown) => ({ properties }),
  Optional: (schema: unknown) => schema,
  String: (options: unknown) => ({ type: "string", ...options as object }),
  Integer: (options: unknown) => ({ type: "integer", ...options as object }),
  Boolean: () => ({ type: "boolean" }),
  Array: (items: unknown) => ({ type: "array", items }),
} }));

async function load(worker: string | undefined, main = "0") {
  vi.stubEnv("APP_WORKER_ID", worker);
  vi.stubEnv("ONDRA_MAIN", main);
  vi.resetModules();
  const { default: discord } = await import("../../extensions/discord");
  const registerTool = vi.fn();
  discord({ registerTool });
  return registerTool.mock.calls[0]?.[0];
}

describe("Discord extension", () => {
  beforeEach(() => {
    vi.stubEnv("ONDRA_BRIDGE", "http://bridge.invalid");
    vi.stubEnv("ONDRA_BRIDGE_TOKEN", "fixture-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([["captain:home~@agent", "1"], ["agent-job", "0"], ["plain-job", "0"]])("registers for %s and leaves authorization to the bridge", async (worker, main) => {
    const tool = await load(worker, main);
    expect(tool?.name).toBe("discord");
  });

  it.each([undefined, "captain:home", "captain:home~ondra"])("does not register for a missing worker or ordinary captain: %s", async (worker) => {
    expect(await load(worker, "1")).toBeUndefined();
  });

  it.each(["ONDRA_BRIDGE", "ONDRA_BRIDGE_TOKEN"])("does not register without %s", async (name) => {
    vi.stubEnv(name, undefined);
    expect(await load("agent-job")).toBeUndefined();
  });

  it("exposes primitive arguments without exposing credentials or session data", async () => {
    vi.stubEnv("PI_SESSION_ID", "private-session");
    const tool = await load("agent-job");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "action", "before", "category", "channel", "channels", "emoji", "kind", "limit", "message", "name", "path", "private", "reply_to", "server", "text", "topic",
    ].sort());
    for (const action of ["servers", "channels", "create", "delete", "send", "history", "react", "unreact", "delete_message", "send_file", "typing"]) {
      expect(tool.description).toContain(action);
    }
    expect(JSON.stringify(tool)).not.toContain("fixture-token");
    expect(JSON.stringify(tool)).not.toContain("private-session");
  });

  it("forwards the model's exact arguments once with cancellation and returns only the bridge result", async () => {
    const response = { sent: ["m2"] };
    const fetch = vi.fn().mockResolvedValue({ json: async () => response });
    vi.stubGlobal("fetch", fetch);
    const tool = await load("agent-job");
    const args = { action: "send", channel: "c1", text: "고쳤어요", reply_to: "m1" };
    const signal = new AbortController().signal;
    expect(await tool.execute("call", args, signal)).toEqual({ content: [{ type: "text", text: JSON.stringify(response, null, 1) }], details: response });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://bridge.invalid", {
      method: "POST",
      headers: { "content-type": "application/json", "x-token": "fixture-token" },
      body: JSON.stringify({ op: "discord", worker: "agent-job", args }),
      signal,
    });
  });

  it("reports the bridge's rejection for an ordinary job without executing another action", async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ error: "not an agent task" }) });
    vi.stubGlobal("fetch", fetch);
    const tool = await load("plain-job");
    const result = await tool.execute("call", { action: "typing", channel: "c1" });
    expect(result.content).toEqual([{ type: "text", text: "discord failed: not an agent task" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
