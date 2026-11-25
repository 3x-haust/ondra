import { describe, expect, it, vi } from "vitest";
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import useExt, { reachable, serverTools, signature, useDescription } from "./use";

const tool = (name: string, exposure: string, props: Record<string, unknown> = {}, required: string[] = [], description = `${name} does a thing. More words.`) => ({
  name, exposure, description, parameters: { type: "object", properties: props, required },
});
const web = tool("web_search", "deferred", { query: {}, count: {} }, ["query"], "Search the web. Returns the top results.");
const all = [web, tool("read", "direct", { path: {} }, ["path"]), tool("mcp__docs__find", "deferred"), tool("tool_search", "model-only"), tool("skill", "deferred", { query: {} }, ["query"])];

describe("use: Ondra's tools called by name in one step", () => {
  it("lists the deferred tools that aren't an MCP server's, one line each", () => {
    expect(reachable(all).map((t) => t.name)).toEqual(["web_search", "skill"]);
    expect(signature(web)).toBe("web_search(query, count?)");
    const d = useDescription(reachable(all));
    expect(d).toContain("- web_search(query, count?): Search the web.");
    expect(d).toContain("- skill(query):");
    expect(d).not.toContain("mcp__docs__find");
  });

  function registered(outcome: { isError: boolean; text: string }) {
    let def: any;
    const handlers: Record<string, () => void> = {};
    useExt({ getAllTools: () => all, on: (e: string, f: () => void) => (handlers[e] = f), registerTool: (d: any) => (def = d) });
    handlers.session_start();
    const executeTool = vi.fn(async () => ({ isError: outcome.isError, result: { content: [{ type: "text", text: outcome.text }] } }));
    return { def, executeTool };
  }

  it("calls the tool it names through the engine and hands its result back", async () => {
    const { def, executeTool } = registered({ isError: false, text: "3 results" });
    const out = await def.execute("c1", { tool: "web_search", args: { query: "asdfaf" } }, undefined, undefined, { executeTool });
    expect(executeTool).toHaveBeenCalledWith("web_search", { query: "asdfaf" }, expect.anything());
    expect(out.content[0].text).toBe("3 results");
    expect(def.reachesTools({ tool: "web_search" })).toEqual(["web_search"]);
  });

  it("args that don't fit bring its parameters back; an unknown name lists what there is", async () => {
    const { def, executeTool } = registered({ isError: true, text: 'Validation failed for tool "web_search":\n  - query: required' });
    await expect(def.execute("c1", { tool: "web_search", args: {} }, undefined, undefined, { executeTool })).rejects.toThrow(/Parameters: .*"query"/);
    await expect(def.execute("c1", { tool: "nope" }, undefined, undefined, { executeTool })).rejects.toThrow(/These are: web_search, skill\. Connected services: mcp__docs/);
  });

  it("a space's connected services: one line says how, a server's name lists its tools, the full name calls one", async () => {
    expect(useDescription(reachable(all), true)).toContain('{tool: "mcp__<server>"} lists that server\'s tools');
    expect(serverTools(all, "mcp__docs")).toBe('mcp__docs\'s tools; call one with use {tool: "<name>", args}:\n- mcp__docs__find(): mcp__docs__find does a thing.');
    expect(serverTools(all, "mcp__docs__find")).toBeUndefined();
    expect(serverTools(all, "mcp__nope")).toBeUndefined();
    const { def, executeTool } = registered({ isError: false, text: "found" });
    expect((await def.execute("c1", { tool: "mcp__docs" }, undefined, undefined, { executeTool })).content[0].text).toContain("- mcp__docs__find()");
    expect(executeTool).not.toHaveBeenCalled();
    await def.execute("c1", { tool: "mcp__docs__find", args: { q: "x" } }, undefined, undefined, { executeTool });
    expect(executeTool).toHaveBeenCalledWith("mcp__docs__find", { q: "x" }, expect.anything());
    // the engine waits for that server before the call
    expect(def.reachesTools({ tool: "mcp__docs" })).toEqual(["mcp__docs"]);
  });
});
