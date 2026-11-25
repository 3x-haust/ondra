import { describe, expect, it } from "vitest";
import { hostedToolEvents } from "./hostedSearch";

const st = (phase: string, extra: Record<string, unknown> = {}) => ({ type: "message_update", assistantMessageEvent: { type: "servertool_end", serverTool: { type: "serverTool", id: "s1", name: "web_search", phase, ...extra } } });

describe("a search the provider ran itself, as a step", () => {
  it("Claude: the call starts it, its result ends it", () => {
    const open = new Set<string>();
    expect(hostedToolEvents(st("call", { input: { query: "Tauri 2 latest" } }), open)).toEqual([{ type: "tool_execution_start", toolName: "web_search", toolCallId: "srv:s1", args: { query: "Tauri 2 latest" } }]);
    expect(hostedToolEvents(st("result", { sources: [] }), open)).toEqual([{ type: "tool_execution_end", toolCallId: "srv:s1", isError: false }]);
    expect(hostedToolEvents({ type: "message_end" }, open)).toEqual([]);
  });

  it("Codex: only the call comes, and the message's end ends it", () => {
    const open = new Set<string>();
    hostedToolEvents(st("call", { input: { query: "Rust latest" } }), open);
    expect(hostedToolEvents({ type: "message_end" }, open)).toEqual([{ type: "tool_execution_end", toolCallId: "srv:s1", isError: false }]);
  });

  it("anything else is no step", () => {
    const open = new Set<string>();
    expect(hostedToolEvents({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }, open)).toEqual([]);
    expect(hostedToolEvents({ type: "message_update", assistantMessageEvent: { type: "servertool_end", serverTool: { id: "m1", name: "mcp_x", phase: "call" } } }, open)).toEqual([]);
  });
});
