// The quiet memory pass (Letta sleep-time agents, LangMem background extraction,
// ACE curation). While nothing is running, at most every few hours, one small
// model call per space:
//   1. learns from jobs that finished without saving anything (0–2 pieces each)
//   2. merges pieces that say the same thing; of two that contradict, retires the older
//   3. gives each piece related words (synonyms, Korean/English, the general idea)
//      so recall finds it by meaning, and what it's about (tools, services) for hubs
//   4. retires pieces that faded away (long unused; the user's rules never fade)
//   5. a procedure used again and again grows into a skill (Codex / OMP / Hermes)
// Finished jobs are read from 일 기록 up to a cursor (nanobot), so a pass that
// stops halfway picks up where it was. Every change is checked here: unknown ids
// are ignored, the user's own pieces are never merged away, reworded or retired
// by the model (OmO / Qwen pinned), and a space only ever sees its own pieces.
import { createSignal } from "solid-js";
import { expand } from "./rpc";
import { oneShot } from "./aside";
import { readFences } from "./fences";
import { absorbNotes, findNotes } from "./absorb";
import { addMemory, forgotten, isLive, KINDS, kindLabel, kindOf, placeOf, retireMemory, userOwned } from "./memory";
import { pathsExist, skillSave } from "../lib/native";
import { projectById, setState, spaceById, state } from "../state/store";
import type { Memory, MemoryKind, SpaceId, Task } from "../state/types";
import { toast } from "../state/ui";

const EVERY_MS = 6 * 60 * 60_000;
const KIND_IDS = new Set<MemoryKind>(KINDS.map((k) => k.id));
const [running, setRunning] = createSignal(false);
export const tidying = running;


const learnable = (t: Task, seen: Set<string>, cursor: number) =>
  t.status === "done" && !t.parentId && !t.answer && (t.finishedAt ?? 0) > cursor && !seen.has(t.id) && !state.memory.some((m) => m.taskId === t.id) && (t.summary ?? "").trim().length > 40;

function prompt(space: SpaceId, list: Memory[], jobs: Task[]): string {
  const lines = list.map((m) => `- [${m.id}] (${kindOf(m)}${userOwned(m) ? ", user's own" : ""}${m.scope === "project" ? `, project ${m.project}` : m.scope === "global" ? ", everywhere" : ""}) ${m.text}${m.keys?.length ? `  {keys: ${m.keys.join(", ")}}` : ""}`);
  const done = jobs.map((t) => `## job ${t.id} (${projectById(t.project)?.folder ?? t.cwd})\nAsked: ${t.ask.slice(0, 400)}\nResult: ${(t.summary ?? "").slice(0, 900)}`);
  return [
    `You keep the long-term memory of a coding agent for the space "${spaceById(space)?.label ?? space}". Tidy it. Be conservative: when unsure, change nothing.`,
    "",
    "Do these:",
    "1. merge: pieces that say the same thing → keep one (prefer the user's own), drop the others, optionally a better merged text (one short Korean sentence). Never drop or reword a user's own piece.",
    "2. retire: when two pieces contradict, the older one (the newer replaces it). Never retire a user's own piece.",
    "3. keys: for EVERY piece without {keys}, 4–8 related search words a future task might use for it: synonyms, Korean and English forms, the general topic (e.g. 'iOS 빌드 실패' → 'Xcode, 시뮬레이터, build error, 캐시, 빌드 오류'). Short words only.",
    "4. about: for each piece, 0–3 named things it is about (tools, services, libraries, products, projects), in their usual spelling (e.g. 'Supabase', 'Next.js', 'GitHub').",
    "5. kind: fix a wrong kind (rule, preference, decision, fact, procedure, lesson).",
    ...(jobs.length
      ? [
          "6. learn: from the finished jobs below, 0–2 pieces each that a FUTURE job in this space would need and could not guess: a project fact, a working procedure, a pitfall that cost time, a decision. One short Korean sentence each, ending in ~요. Skip what is obvious, one-off, or already in memory. Most jobs teach nothing — that's fine.",
        ]
      : []),
    "",
    'Reply with only a fenced block (omit empty fields):\n```tidy\n{"merge":[{"keep":"id","drop":["id"],"text":"..."}],"retire":[{"id":"older","by":"newer"}],"keys":{"id":["..."]},"about":{"id":["..."]},"kind":{"id":"rule"},"learn":[{"job":"id","text":"...","kind":"lesson","project":true}]}\n```',
    "",
    "# Memory pieces",
    ...(lines.length ? lines : ["(none)"]),
    ...(done.length ? ["", "# Finished jobs", ...done] : []),
  ].join("\n");
}

type Plan = {
  merge?: { keep?: string; drop?: string[]; text?: string }[];
  retire?: { id?: string; by?: string }[];
  keys?: Record<string, string[]>;
  about?: Record<string, string[]>;
  kind?: Record<string, string>;
  learn?: { job?: string; text?: string; kind?: string; project?: boolean }[];
};

const words = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x && x.length <= len)
    .slice(0, max);

function apply(plan: Plan, list: Memory[], jobs: Task[]) {
  const mine = new Map(list.map((m) => [m.id, m]));
  const live = (id?: string) => (id ? mine.get(id) : undefined);
  const n = { merged: 0, retired: 0, learned: 0, keyed: 0 };
  const now = Date.now();
  for (const g of plan.merge ?? []) {
    const keep = live(g.keep);
    if (!keep) continue;
    for (const id of g.drop ?? []) {
      const d = live(id);
      if (!d || d.id === keep.id || userOwned(d) || d.invalidAt) continue;
      retireMemory(d.id, keep.id, "같은 기억과 합쳤어요");
      // merged away = it came up again
      setState("memory", (m) => m.id === keep.id, (m) => ({ seen: (m.seen ?? 1) + (d.seen ?? 1) }));
      n.merged++;
    }
    const text = typeof g.text === "string" ? g.text.trim() : "";
    if (text && text.length <= 300 && text !== keep.text && !userOwned(keep)) setState("memory", (m) => m.id === keep.id, { text, updatedAt: now });
  }
  for (const r of plan.retire ?? []) {
    const old = live(r.id), by = live(r.by);
    if (!old || !by || userOwned(old) || old.invalidAt || old.id === by.id || old.createdAt > by.createdAt) continue;
    retireMemory(old.id, by.id, "새 기억과 달라서 내렸어요");
    n.retired++;
  }
  for (const [id, v] of Object.entries(plan.keys ?? {})) {
    const k = words(v, 8, 24);
    if (live(id) && k.length) setState("memory", (m) => m.id === id, { keys: k }), n.keyed++;
  }
  for (const [id, v] of Object.entries(plan.about ?? {})) {
    const a = words(v, 3, 32);
    if (live(id)) setState("memory", (m) => m.id === id, { about: a.length ? a : undefined });
  }
  for (const [id, k] of Object.entries(plan.kind ?? {})) if (live(id) && KIND_IDS.has(k as MemoryKind)) setState("memory", (m) => m.id === id, { kind: k as MemoryKind });
  for (const l of plan.learn ?? []) {
    const job = jobs.find((t) => t.id === l.job);
    const text = typeof l.text === "string" ? l.text.trim() : "";
    if (!job || !text || text.length > 300) continue;
    const folder = projectById(job.project, job.space)?.folder;
    const before = state.memory.length;
    const id = addMemory(text, l.project && folder ? "project" : "space", {
      space: job.space,
      project: folder,
      source: "ondra",
      kind: KIND_IDS.has(l.kind as MemoryKind) ? (l.kind as MemoryKind) : undefined,
      importance: 3,
      taskId: job.id,
      by: "agent",
      quiet: true,
    });
    if (state.memory.length > before) n.learned++;
    // the 일 기록 entry knows what was learned from it
    if (id) setState("journal", (j) => j.taskId === job.id, (j) => ({ learned: [...new Set([...(j.learned ?? []), id])] }));
  }
  return n;
}

/**
 * One pass over every space, each on its own (a space's model only sees that
 * space's pieces). `force` = the user asked (ignores the timer); `only` = just
 * that space (the 정리 button tidies the space on screen).
 */
export async function tidyMemory(force = false, only?: SpaceId) {
  if (running() || !state.settings.learn) return;
  const last = state.memoryTidy;
  if (!force && last && Date.now() - last.at < EVERY_MS) return;
  const seen = new Set(last?.tasks ?? []);
  const cursor = last?.cursor ?? 0;
  let reached = cursor;
  setRunning(true);
  const total = { merged: 0, retired: 0, learned: 0, keyed: 0, skills: 0 };
  const touched: string[] = [];
  try {
    // 0. notes other tools keep in the folders become pieces too (one structure)
    const notes = only ? (await findNotes()).filter((n) => n.space === only) : undefined;
    if (!notes || notes.length) await absorbNotes(notes).catch(() => 0);
    const mine = (m: Memory) => !only || placeOf(m) === only;
    // 4. the forgetting curve, no model needed
    for (const m of state.memory.filter((x) => isLive(x) && mine(x) && forgotten(x))) {
      retireMemory(m.id, undefined, "오래 안 써서 흐려졌어요");
      total.retired++;
    }
    // code facts whose files are all gone are stale (Copilot checks citations)
    const cited = state.memory.filter((x) => isLive(x) && mine(x) && x.cites?.length);
    if (cited.length) {
      const all = [...new Set(cited.flatMap((x) => x.cites!))];
      const ok = await pathsExist(all.map((p) => expand(p)));
      const exists = new Map(all.map((p, i) => [p, ok[i]]));
      for (const m of cited)
        if (m.cites!.every((p) => !exists.get(p))) {
          retireMemory(m.id, undefined, "가리키던 코드가 사라졌어요");
          total.retired++;
        }
    }
    for (const sp of state.spaces.filter((s) => !only || s.id === only)) {
      // this space's own pieces; global ones (the user's, for every space) and pieces no space owns are left alone
      const list = state.memory.filter((m) => isLive(m) && m.scope !== "global" && placeOf(m) === sp.id).slice(-160);
      const jobs = state.tasks
        .filter((t) => t.space === sp.id && learnable(t, seen, cursor))
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(0, 6);
      const needs = jobs.length || list.some((m) => !m.keys?.length) || (force && list.length > 1);
      if (!needs) continue;
      try {
        const raw = await oneShot(sp.id, sp.folder, prompt(sp.id, list, jobs));
        const plan = (readFences(raw, "tidy").items[0] ?? {}) as Plan;
        const n = apply(plan, list, jobs);
        for (const k of Object.keys(n) as (keyof typeof n)[]) total[k] += n[k];
        touched.push(...jobs.map((t) => t.id));
        for (const t of jobs) reached = Math.max(reached, t.finishedAt ?? 0);
      } catch {
        /* this space waits for the next pass */
      }
    }
    total.skills = await growSkills(only);
    // one space tidied: the others keep their turn (the timer and the cursor of jobs not yet learned from)
    setState("memoryTidy", { at: only ? (last?.at ?? 0) : Date.now(), ...total, tasks: [...seen, ...touched].slice(-300), cursor: only ? cursor : reached });
    if (force) {
      const parts = [total.skills && `스킬 ${total.skills}`, total.learned && `새로 배움 ${total.learned}`, total.merged && `합침 ${total.merged}`, total.retired && `지난 기억으로 ${total.retired}`, total.keyed && `관련어 ${total.keyed}`].filter(Boolean);
      toast(parts.length ? `기억을 정리했어요 · ${parts.join(" · ")}` : "정리할 게 없었어요");
    }
  } finally {
    setRunning(false);
  }
}

/**
 * A procedure that keeps being used (3+ times, counting repeats) and is a real
 * how-to (several steps, or several procedures linked to it) becomes a skill
 * every job can load: SKILL.md made from it and its linked procedures. A
 * one-line rule or fact stays a memory: as a skill it only repeats the memory
 * and fills the + menu.
 */
export function canGrow(m: Memory, linked: Memory[]): boolean {
  const name = (m.key ?? "").replace(/[^a-z0-9-]/g, "");
  return name.length >= 3 && (m.text.length >= 300 || linked.length >= 2);
}

async function growSkills(only?: SpaceId): Promise<number> {
  let made = 0;
  const taken = new Set(state.skills.map((s) => s.name));
  for (const m of state.memory.filter((x) => isLive(x) && x.scope !== "global" && (!only || placeOf(x) === only) && kindOf(x) === "procedure" && !x.skill && x.uses + (x.seen ?? 1) - 1 >= 3)) {
    const name = (m.key ?? "").replace(/[^a-z0-9-]/g, "").slice(0, 48);
    if (taken.has(name)) continue;
    const space = placeOf(m);
    // a skill is grown from one space's procedures and only that space's jobs get it
    const linked = (m.links ?? []).map((id) => state.memory.find((x) => x.id === id)).filter((x): x is Memory => !!x && isLive(x) && kindOf(x) === "procedure" && placeOf(x) === space);
    if (!canGrow(m, linked)) continue;
    const desc = m.text.split(/(?<=[.!?。]|요\.?)\s/)[0].replace(/\s+/g, " ").slice(0, 160);
    const text = [
      "---",
      `name: ${name}`,
      `description: ${desc}`,
      "---",
      "",
      `# ${desc}`,
      "",
      m.text,
      ...(linked.length ? ["", "## 함께 쓰는 것", ...linked.map((x) => `- ${x.text}`)] : []),
      ...(m.paths?.length ? ["", `파일: ${m.paths.join(", ")}`] : []),
      "",
    ].join("\n");
    try {
      const dir = await skillSave(name, text, false);
      setState("skills", (l) => [...l, { name, path: dir, description: desc, source: "ondra" as const, enabled: true, menu: false, ...(space ? { space } : {}) }]);
      setState("memory", (x) => x.id === m.id, { skill: name });
      taken.add(name);
      made++;
    } catch {
      /* next pass */
    }
  }
  return made;
}

/** Every 10 minutes: run the pass when nothing is working (and it's due). */
export function startTidy() {
  const tick = () => {
    const busy = state.tasks.some((t) => t.status === "running") || state.captain.some((m) => m.pending);
    if (!busy && !document.hidden) void tidyMemory();
  };
  setTimeout(tick, 3 * 60_000);
  setInterval(tick, 10 * 60_000);
}

export const tidyLine = () => {
  const t = state.memoryTidy;
  if (!t) return "";
  const parts = [t.learned && `배움 ${t.learned}`, t.merged && `합침 ${t.merged}`, t.retired && `내림 ${t.retired}`].filter(Boolean);
  return parts.join(" · ");
};

export { kindLabel };
