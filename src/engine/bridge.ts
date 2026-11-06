// Answers the engine's tools (extensions/memory.ts) that reach back into the app:
//   memory_search  → the job's memory ranked for a query (words + meaning + one link
//                    hop), plus matching 일 기록 entries; stale code facts left out
//   memory_save    → a new piece, checked against what's kept (same → counted, same
//                    key → updated, one-off details → refused)
//   memory_forget  → retire a piece that turned out wrong (never the user's own)
//   memory_paths   → path rules for a file a job just touched (once per job)
// Calls arrive as `bridge:call` {id, call:{op, worker, args}} and are answered
// with bridge_reply. The worker id is the job's id: a job only sees its own memory.
import { bridgeReply, onEvent, pathsExist } from "../lib/native";
import { homeDir, state, taskById } from "../state/store";
import type { Memory, MemoryKind, Task } from "../state/types";
import { addMemory, isLive, KINDS, kindLabel, kindOf, markUsed, pathMatches, recall, retireMemory, userOwned } from "./memory";
import { searchJournal } from "./journal";
import { memoriesFor } from "./prompts";
import { expand } from "./rpc";
import { prepareQuery } from "./vectors";
import { pushNote } from "./tasks";

type Call = { op?: string; worker?: string; args?: Record<string, unknown> };
const KIND_IDS = new Set<string>(KINDS.map((k) => k.id));

const view = (m: Memory) => ({
  id: m.id,
  key: m.key,
  kind: kindLabel(kindOf(m)),
  text: m.text,
  where: m.scope === "project" ? `project ${m.project}` : m.scope === "global" ? "everywhere" : "this space",
  ...((m.seen ?? 1) > 1 ? { seen: m.seen } : {}),
  ...(userOwned(m) ? { by: "user" } : {}),
  ...(m.paths?.length ? { paths: m.paths } : {}),
  ...(m.cites?.length ? { cites: m.cites } : {}),
  ...(m.skill ? { skill: m.skill } : {}),
  date: new Date(m.updatedAt ?? m.createdAt).toISOString().slice(0, 10),
});

/** A job's memory; a caller that isn't a known job gets none (never the space on screen). */
function pool(t: Task | undefined): Memory[] {
  return t ? memoriesFor(t.space, homeDir(t), t.reach) : [];
}

/** pieces whose cited files are all gone are stale: retired, not handed out */
async function dropStale(list: Memory[]): Promise<Memory[]> {
  const cited = list.filter((m) => m.cites?.length);
  if (!cited.length) return list;
  const all = [...new Set(cited.flatMap((m) => m.cites!))];
  const ok = await pathsExist(all.map((p) => expand(p)));
  const exists = new Map(all.map((p, i) => [p, ok[i]]));
  const stale = new Set(cited.filter((m) => m.cites!.every((p) => !exists.get(p))).map((m) => m.id));
  for (const id of stale) retireMemory(id, undefined, "가리키던 코드가 사라졌어요");
  return list.filter((m) => !stale.has(m.id));
}

const words = (v: unknown, n: number, len = 32) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter((x) => x && x.length <= len).slice(0, n) : undefined);
const keyOf = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64) || undefined : undefined);

/** path rules already shown to each job (once per job) */
const shown = new Map<string, Set<string>>();

async function handle(c: Call): Promise<unknown> {
  const t = c.worker ? taskById(c.worker) : undefined;
  const a = c.args ?? {};
  // memory belongs to a space: only a job (whose space is known) reads or writes it
  if (!t && c.op?.startsWith("memory_")) return c.op === "memory_search" ? { results: [], total: 0 } : c.op === "memory_paths" ? { rules: [] } : { error: "only a job can change memory" };
  switch (c.op) {
    case "memory_search": {
      const query = String(a.query ?? "").trim();
      if (!query) return { error: "query is empty" };
      const limit = Math.min(20, Math.max(1, Number(a.limit) || 8));
      await prepareQuery(query);
      const list = pool(t);
      const hits = await dropStale(recall(list, query, { max: limit, budget: 6000, links: true }));
      markUsed(hits.map((m) => m.id));
      const journal = (state.journal ?? []).filter((j) => j.space === t!.space && j.taskId !== t!.id);
      const jobs = searchJournal(journal, query, 3).map((j) => ({
        job: j.title,
        date: new Date(j.at).toISOString().slice(0, 10),
        outcome: j.outcome,
        text: j.text.slice(0, 500),
      }));
      return { results: hits.map(view), past_jobs: jobs.length ? jobs : undefined, total: list.length };
    }
    case "memory_save": {
      const text = String(a.text ?? "").trim();
      if (!text || text.length > 600) return { error: "text must be 1–600 characters" };
      // a job never writes for every space: "global" (an older tool list) is kept in its space
      const scope = a.scope === "global" || a.scope === "space" ? "space" : "project";
      let refused = "";
      const root = t ? expand(homeDir(t)) : "";
      const cites = words(a.cites, 6, 400)?.map((p) => (p.startsWith("/") || p.startsWith("~") || !root ? p : `${root}/${p.replace(/^\.\//, "")}`));
      if (cites?.length) {
        const ok = await pathsExist(cites.map((p) => expand(p)));
        if (!ok.some(Boolean)) return { error: "none of the cited files exist — check the code first" };
      }
      const id = addMemory(text, scope, {
        space: t!.space,
        project: scope === "project" ? homeDir(t!) : undefined,
        kind: KIND_IDS.has(String(a.kind)) ? (a.kind as MemoryKind) : undefined,
        importance: typeof a.importance === "number" ? Math.min(5, Math.max(1, Math.round(a.importance))) : undefined,
        replaces: typeof a.replaces === "string" ? a.replaces : undefined,
        key: keyOf(a.key),
        paths: words(a.paths, 8, 120),
        cites,
        about: words(a.about, 3),
        keys: words(a.keys, 8),
        taskId: t?.id,
        by: "agent",
        quiet: true,
        onRefuse: (why) => (refused = why),
      });
      if (id && t) pushNote(t.id, `기억함 · ${text.slice(0, 120)}`);
      return id ? { saved: id, ...(refused ? { note: refused } : {}) } : { error: refused || "nothing saved" };
    }
    case "memory_forget": {
      const id = String(a.id ?? "");
      const m = state.memory.find((x) => x.id === id && isLive(x));
      if (!m) return { error: "no such memory" };
      if (!pool(t).includes(m)) return { error: "not this job's memory" };
      if (userOwned(m)) return { error: "that is the user's own memory; tell the user instead" };
      retireMemory(id, undefined, String(a.why ?? "일하다 틀린 걸 알았어요").slice(0, 200));
      return { retired: id };
    }
    case "memory_paths": {
      const file = String(a.path ?? "").trim();
      if (!file || !t) return { rules: [] };
      const root = expand(homeDir(t));
      const abs = file.startsWith("/") ? file : `${root}/${file.replace(/^\.\//, "")}`;
      const seen = shown.get(t.id) ?? new Set<string>();
      shown.set(t.id, seen);
      const rules = pool(t).filter((m) => !seen.has(m.id) && pathMatches(m, abs, m.project ? expand(m.project) : root));
      for (const m of rules) seen.add(m.id);
      markUsed(rules.map((m) => m.id));
      return { rules: rules.map((m) => ({ id: m.id, text: m.text, paths: m.paths })) };
    }
  }
  return { error: `unknown op ${c.op}` };
}

let started = false;
export function startBridge() {
  if (started) return;
  started = true;
  void onEvent<{ id: number; call: Call }>("bridge:call", ({ id, call }) => {
    void handle(call)
      .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
      .then((v) => bridgeReply(id, JSON.stringify(v ?? null)));
  });
}
