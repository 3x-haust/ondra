import { describe, expect, it } from "vitest";
import { offTools, WORKER_TOOLS, workerTools } from "./tasks";
import { enabledTools } from "./agentTools";

/** the value after --tools */
const list = (args: string[]) => args[args.indexOf("--tools") + 1];

describe("a job's tool allowlist", () => {
  it("is exactly the defaults when nothing extra is on", () => {
    expect(workerTools(undefined)).toEqual(WORKER_TOOLS);
    expect(workerTools([])).toEqual(WORKER_TOOLS);
    expect(workerTools(["", "  "])).toEqual(WORKER_TOOLS);
    expect(list(WORKER_TOOLS)).toBe("+tool_search");
  });

  it("adds the tools turned on in settings, keeping the engine's defaults", () => {
    const args = workerTools(["grep", "find", "mcp__docs__search"]);
    expect(args.slice(0, 3)).toEqual(["--extension", "builtin:tool-search", "--tools"]);
    // only "+name" entries: read, bash, edit and write stay on and none can be removed
    expect(list(args)).toBe("+tool_search,+grep,+find,+mcp__docs__search");
    expect(list(args).split(",").every((x) => x.startsWith("+"))).toBe(true);
  });

  it("takes exact names only, once each", () => {
    expect(list(workerTools(["grep", "grep", " ls ", "tool_search"]))).toBe("+tool_search,+grep,+ls");
    // a pattern, a comma or a "-name" would change what the engine allows
    expect(workerTools(["mcp__*", "a,b", "-read", "+bash"])).toEqual(WORKER_TOOLS);
  });
});

describe("MCP tools switched off", () => {
  it("are left out of a job with the engine's denylist", () => {
    expect(offTools(undefined)).toEqual([]);
    expect(offTools(["grep", "-mcp__docs__search", "-mcp__gh__list", "-mcp__docs__search"])).toEqual(["--exclude-tools", "mcp__docs__search,mcp__gh__list"]);
  });
  it("only MCP tools: the engine's own and Ondra's can't be switched off", () => {
    expect(offTools(["-read", "-bash", "-memory", "-mcp__*", "-mcp__a,b"])).toEqual([]);
    // a switched-off entry never turns a tool on
    expect(workerTools(["-mcp__docs__search"])).toEqual(WORKER_TOOLS);
  });
  it("aren't counted as enabled", () => {
    const c = { tools: [{ name: "read", active: true }, { name: "mcp__docs__search", active: true }, { name: "grep", active: false }] };
    expect(enabledTools(c, []).map((x) => x.name)).toEqual(["read", "mcp__docs__search"]);
    expect(enabledTools(c, ["-mcp__docs__search", "grep", "-read"]).map((x) => x.name)).toEqual(["read", "grep"]);
  });
});
