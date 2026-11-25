// `use`: a tool that isn't declared up front, called by name in one step. Ondra's own tools
// (web, jobs, settings, skills, memory, devices …) are deferred: their schemas cost nothing until
// needed. Rather than tool_search (one call to load, the next to call), `use {tool, args}` runs it
// at once through the engine's own pipeline (validation, hooks, permission checks, secrets), and
// its one-line catalog (name(params): what it does) is all the model carries of them. Wrong args
// bring that tool's parameters back. A space's connected services (MCP servers, Settings › 연결)
// are reached the same way but kept out of the catalog: there are many, they come and go. One line
// says how to reach them, `use {tool: "mcp__<server>"}` lists one server's tools, and the full
// name calls one (the engine waits for that server to connect first).
import { Type } from "typebox";

type Info = { name: string; description?: string; parameters?: any; exposure?: string };

/** "web_search(query, count?)": a tool's name and its parameters, the optional ones marked */
export function signature(t: Info): string {
  const props = t.parameters?.properties ?? {};
  const need = new Set<string>(t.parameters?.required ?? []);
  return `${t.name}(${Object.keys(props).map((k) => (need.has(k) ? k : `${k}?`)).join(", ")})`;
}

/** its first sentence, short */
const gist = (d = "") => {
  const one = d.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return one.length > 90 ? `${one.slice(0, 89)}…` : one;
};

const hidden = (t: Info) => t.exposure !== "deferred" && t.exposure !== "codemode";
/** the tools `use` lists: deferred ones that aren't an MCP server's, nor a loader */
export const reachable = (all: Info[]) => all.filter((t) => !hidden(t) && !t.name.startsWith("mcp__") && t.name !== "use" && t.name !== "tool_search");
/** connected services' tools (`mcp__<server>__<tool>`), reached by name but not listed */
export const services = (all: Info[]) => all.filter((t) => !hidden(t) && t.name.startsWith("mcp__"));

/** "mcp__gmail" (a server, not one of its tools): its tools, one line each */
export function serverTools(all: Info[], server: string): string | undefined {
  if (!server.startsWith("mcp__") || server.slice(5).includes("__")) return undefined;
  const own = services(all).filter((t) => t.name.startsWith(`${server}__`));
  if (!own.length) return undefined;
  return [`${server}'s tools; call one with use {tool: "<name>", args}:`, ...own.map((t) => `- ${signature(t)}: ${gist(t.description)}`).sort()].join("\n");
}

export function useDescription(tools: Info[], withServices = false): string {
  const lines = tools.map((t) => `- ${signature(t)}: ${gist(t.description)}`).sort();
  return [
    "Call one of the tools below in one step, by name, without loading it first: {tool, args}. args are that tool's parameters as an object. If they don't fit, its full description and parameters come back; call again.",
    ...(withServices
      ? ['It also reaches the connected services listed under mcp_servers (there is no tool_search here): {tool: "mcp__<server>"} lists that server\'s tools, then call one by its full name.']
      : []),
    ...lines,
  ].join("\n");
}

/** this session loads the engine's MCP extension: the space has connected services */
const hasServices = () => process.argv.includes("builtin:mcp");

export default function (pi: any) {
  // registered once every extension has added its tools: the catalog is this session's
  pi.on("session_start", () => {
    const tools = reachable(pi.getAllTools() as Info[]);
    if (!tools.length) return;
    pi.registerTool({
      name: "use",
      label: "Use",
      description: useDescription(tools, hasServices()),
      parameters: Type.Object({
        tool: Type.String({ description: "the tool's name, as listed" }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "its parameters" })),
      }),
      reachesTools: (input: Record<string, unknown>) => (typeof input.tool === "string" ? [input.tool] : []),
      async execute(_id: string, p: { tool: string; args?: Record<string, unknown> }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
        const name = String(p.tool ?? "").trim();
        const all = pi.getAllTools() as Info[];
        const listed = serverTools(all, name);
        if (listed) return { content: [{ type: "text", text: listed }], details: {} };
        const known = [...reachable(all), ...services(all)];
        const t = known.find((x) => x.name === name);
        if (!t) {
          const servers = [...new Set(services(all).map((x) => x.name.split("__").slice(0, 2).join("__")))];
          const also = servers.length ? ` Connected services: ${servers.join(", ")} (use {tool: "<server>"} lists its tools).` : "";
          throw new Error(`No tool "${name}" to use here. These are: ${reachable(all).map((x) => x.name).join(", ")}.${also}`);
        }
        if (!ctx?.executeTool) throw new Error("use can't call tools in this session.");
        const out = await ctx.executeTool(name, p.args ?? {}, { signal, onUpdate });
        if (out.isError) {
          const said = (out.result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
          // args that didn't fit: what it takes, to call again
          const fit = /^Validation failed/.test(said) ? `\n\n${name}: ${t.description ?? ""}\nParameters: ${JSON.stringify(t.parameters ?? {})}` : "";
          throw new Error(`${said || `${name} failed`}${fit}`);
        }
        return out.result;
      },
    });
  });
}
