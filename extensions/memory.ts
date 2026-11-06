// Ondra's memory as tools, so a job can look things up the moment it needs them
// (not only what was recalled when it started) and keep what it learns:
//   memory_search  → past rules, facts, procedures, lessons for this job (words + meaning)
//   memory_save    → keep one piece for future jobs
//   memory_forget  → retire a piece that turned out wrong
//   (no tool)      → when a read/edit/write touches a file, the path rules for it
//                    (pieces saved with "paths") are added under that tool's result
// They reach the app through its local door (ONDRA_BRIDGE + token); the job only
// sees its own space/project memory. Without the app (plain pi) they aren't registered.
import { Type } from "typebox";

const URL_ = process.env.ONDRA_BRIDGE;
const TOKEN = process.env.ONDRA_BRIDGE_TOKEN;
const WORKER = process.env.APP_WORKER_ID;

async function call(op: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const r = await fetch(URL_!, {
    method: "POST",
    headers: { "content-type": "application/json", "x-token": TOKEN! },
    body: JSON.stringify({ op, worker: WORKER, args }),
    signal,
  });
  return r.json();
}
const out = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }], details: v });

const KIND = Type.Union([Type.Literal("rule"), Type.Literal("preference"), Type.Literal("decision"), Type.Literal("fact"), Type.Literal("procedure"), Type.Literal("lesson")]);

export default function (pi: any) {
  if (!URL_ || !TOKEN) return;
  // per session: what was searched and shown, so repeats are answered at once
  const asked = new Set<string>();
  const shown = new Set<string>();
  let empties = 0;

  pi.registerTool({
    name: "memory_search",
    label: "Memory search",
    description:
      "Search the user's long-term memory for this job: rules, preferences, decisions, facts, procedures and lessons from earlier work. Finds by meaning as well as words (Korean and English). Use it before guessing a convention, an account, a command, where something lives, or why something was done; and when the user refers to something from before.",
    promptSnippet: "Look up the user's long-term memory (rules, facts, procedures, lessons)",
    parameters: Type.Object({
      query: Type.String({ description: "what you need to know, in a few words or a question" }),
      limit: Type.Optional(Type.Number({ description: "max results (default 8)" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      // the same search again gives the same answer: say so instead of spending a turn
      const q = String(p.query ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (asked.has(q)) return out("You already ran this search in this session; its results haven't changed. Use them, or decide from the code, docs or the web.");
      asked.add(q);
      const r = await call("memory_search", p, signal);
      if (r?.error) return out(`memory_search failed: ${r.error}`);
      if (!r?.results?.length) {
        empties++;
        return out(
          r?.total
            ? `Nothing in memory matches (searched ${r.total} pieces).${empties >= 2 ? " Memory has nothing on this; stop searching it and decide from the code, docs or the web." : ""}`
            : "Memory is empty for this job's space. Don't search it again in this job.",
        );
      }
      const fresh = r.results.filter((m: any) => !shown.has(m.id));
      for (const m of r.results) shown.add(m.id);
      if (!fresh.length) return out(`Only pieces you already saw (${r.results.map((m: any) => m.id).join(", ")}). Memory has nothing more on this.`);
      const tag = (m: any) => [m.kind, m.where, m.seen ? `${m.seen}x` : "", m.by === "user" ? "user's own" : "", m.paths ? `paths ${m.paths.join(" ")}` : "", m.date].filter(Boolean).join(", ");
      const again = r.results.length - fresh.length;
      const lines = fresh.map((m: any) => `[${m.id}${m.key ? ` ${m.key}` : ""}] (${tag(m)}) ${m.text}${m.cites ? `\n    cites: ${m.cites.join(", ")}` : ""}`);
      const jobs = (r.past_jobs ?? []).map((j: any) => `- ${j.date} ${j.job} (${j.outcome}): ${j.text.replace(/\s+/g, " ")}`);
      return out([...lines, ...(again ? [`(${again} more you already saw)`] : []), ...(jobs.length ? ["", "Past jobs that may help:", ...jobs] : [])].join("\n"));
    },
  });

  pi.registerTool({
    name: "memory_save",
    label: "Memory save",
    description:
      "Keep one lasting piece for future jobs: something the user stated as a preference/rule, or something you learned that a future job couldn't guess (a project convention, where things live, a working procedure, a pitfall and its fix, a decision and why). One fact per call, one or two sentences in the user's language. Skip what the code or docs already say and one-off details. It is checked against what's kept (duplicates just get stronger).",
    promptSnippet: "Keep a lasting fact / rule / lesson for future jobs",
    parameters: Type.Object({
      text: Type.String(),
      key: Type.Optional(Type.String({ description: "short english slug naming this fact (e.g. deploy-uses-pnpm); saving the same key later updates it" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "globs relative to the project (e.g. src-tauri/**) when it only matters for those files; shown to jobs that touch them" })),
      cites: Type.Optional(Type.Array(Type.String(), { description: "code files this fact is about (must exist); it is retired when they are gone" })),
      kind: Type.Optional(KIND),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("space")], { description: "project (default): this folder; space: all work in this space. Spaces are separate: nothing you save reaches the other space" })),
      importance: Type.Optional(Type.Number({ description: "1-5; 5 when the user said it must always hold" })),
      replaces: Type.Optional(Type.String({ description: "id of a memory this corrects (it is retired)" })),
      about: Type.Optional(Type.Array(Type.String(), { description: "0-3 named things it's about (tools, services, projects)" })),
      keys: Type.Optional(Type.Array(Type.String(), { description: "a few search words: synonyms, Korean/English forms" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call("memory_save", p, signal);
      return out(r?.error ? `not saved: ${r.error}` : `saved ${r.saved}${r.note ? ` (${r.note})` : ""}`);
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory forget",
    exposure: "deferred",
    description: "Retire a memory that turned out to be wrong or outdated (it moves to past memories with your reason). Prefer memory_save with replaces when you know the correct version.",
    parameters: Type.Object({ id: Type.String(), why: Type.String() }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call("memory_forget", p, signal);
      return out(r?.error ? `not retired: ${r.error}` : `retired ${r.retired}`);
    },
  });

  // path rules: a file touched → the rules saved for it, once per job, under the result
  pi.on("tool_result", async (e: any) => {
    if (e.isError || !["read", "edit", "write"].includes(e.toolName)) return;
    const path = String(e.input?.path ?? e.input?.file_path ?? "");
    if (!path) return;
    try {
      const r = await call("memory_paths", { path });
      if (!r?.rules?.length) return;
      const note = ["", `[memory: rules for ${path}]`, ...r.rules.map((m: any) => `- ${m.text}`)].join("\n");
      return { content: [...(e.content ?? []), { type: "text", text: note }] };
    } catch {
      return;
    }
  });
}
