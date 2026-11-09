// The quiet memory pass (Letta sleep-time agents, LangMem background extraction,
// ACE curation, gbrain's dream cycle). While nothing is running, at most every few
// hours, one small model call per space:
//   1. learns from jobs that finished without saving anything (0–2 pieces each)
//   2. finds patterns: a lesson or procedure seen in 3+ different finished jobs of
//      the space (gbrain patterns), read from what the harness saw in each job
//      (repeated failures, stalls, retries, failed commands, how long it took)
//   3. merges pieces that say the same thing; of two that contradict, retires the older
//   4. gives each piece related words (synonyms, Korean/English, the general idea)
//      so recall finds it by meaning, and what it's about (tools, services) for hubs
//   5. retires pieces that faded away (long unused; the user's rules never fade)
//   6. a procedure used again and again grows into a skill (Codex / OMP / Hermes)
// Finished jobs are read from 일 기록 up to a cursor (nanobot), so a pass that
// stops halfway picks up where it was; patterns look back over the last few jobs
// but need a new one among their evidence. Every change is checked here: unknown
// ids are ignored, a piece learned from jobs carries a quote that must really be
// in what those jobs said (gbrain quote_verify) or it is dropped, the user's own
// pieces are never merged away, reworded or retired by the model (OmO / Qwen
// pinned) — what contradicts one waits for the user (확인 필요, gbrain decide) —
// and a space only ever sees its own pieces.
import { createSignal } from "solid-js";
import { expand } from "./rpc";
import { oneShot } from "./aside";
import { readFences } from "./fences";
import { absorbNotes, findNotes } from "./absorb";
import { addMemory, forgotten, isLive, KINDS, kindLabel, kindOf, placeOf, restoreMemory, retireMemory, unionSources, userOwned } from "./memory";
import { inTauri, pathsExist, skillSave } from "../lib/native";
import { projectById, setState, spaceById, state, uid } from "../state/store";
import type { Memory, MemoryConflict, MemoryKind, SpaceId, Task } from "../state/types";
import { toast } from "../state/ui";
import { t as tr } from "../i18n";

const EVERY_MS = 6 * 60 * 60_000;
/** finished jobs of a space a pass looks across for patterns */
export const WINDOW = 30;
/** different jobs a pattern needs (gbrain dream.patterns.min_evidence) */
export const MIN_EVIDENCE = 3;
/** characters of job material one call gets (new jobs first) */
const JOBS_BUDGET = 16_000;
const KIND_IDS = new Set<MemoryKind>(KINDS.map((k) => k.id));
const [running, setRunning] = createSignal(false);
export const tidying = running;
/** a model call that never answers (no engine, a stuck agent) gives up instead of holding 정리 forever */
const WAIT_MS = inTauri ? 4 * 60_000 : 4_000;
const within = <T,>(p: Promise<T>, ms = WAIT_MS) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);

const learnable = (t: Task, seen: Set<string>, cursor: number) =>
  t.status === "done" && !t.parentId && !t.answer && (t.finishedAt ?? 0) > cursor && !seen.has(t.id) && !state.memory.some((m) => m.taskId === t.id) && (t.summary ?? "").trim().length > 40;

// ───────────── what a finished job is, for the pass

/** the harness notes worth learning from: what went wrong or slow */
const SIGNAL = /^(같은 실패 반복|같은 검사 반복|검색 멈춤|기다림 멈춤|재시도 |연결이 끊겼어요|컨텍스트 압축 중|확인 필요 · |모델 변경 →)/;
const took = (ms: number) => (ms < 60_000 ? "<1m" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`);
const counted = (xs: string[], max: number) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].slice(0, max).map(([x, n]) => (n > 1 ? `${x} ×${n}` : x));
};
/** the line of a command's output that says what went wrong */
const errorLine = (tail?: string) => {
  const lines = (tail ?? "").split("\n").map((l) => l.trim()).filter(Boolean).reverse();
  return (lines.find((l) => /error|fail|cannot|can't|not found|denied|refused|EADDRINUSE|ENOENT|exit code|실패|오류/i.test(l)) ?? lines[0] ?? "").slice(0, 160);
};
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** One finished job as the pass reads it: a head line, then labelled lines (only these are quotable). */
export type JobLines = { id: string; head: string; lines: [string, string][] };

/** What a job asked and got, and what the harness saw: notes, failed commands, errors, how long. `full` = a new job (more of its result). */
export function jobMaterial(t: Task, full: boolean): JobLines {
  const notes: string[] = [];
  const errors: string[] = [];
  const failed: { cmd: string; shell?: string }[] = [];
  for (const e of t.entries ?? []) {
    if (e.kind === "note" && SIGNAL.test(e.text)) notes.push(e.text.slice(0, 80));
    else if (e.kind === "error") errors.push(e.text);
    else if (e.kind === "tool" && e.tool.ok === false && !e.tool.stopped && (e.tool.kind === "bash" || e.tool.kind === "test")) failed.push({ cmd: e.tool.target.replace(/\s+/g, " ").trim().slice(0, 100), shell: e.tool.shellId });
  }
  const tail = (id?: string) => (id ? (t.shells ?? []).find((s) => s.id === id)?.tail : undefined);
  const out = [...new Set(failed.map((f) => errorLine(tail(f.shell))).filter(Boolean))].slice(0, 2);
  const err = (t.error ?? errors[errors.length - 1] ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";
  const kids = state.tasks
    .filter((c) => c.parentId === t.id && c.status === "failed")
    .map((c) => `${c.title}${c.error ? ` — ${c.error.split("\n")[0]}` : ""}`.slice(0, 140))
    .slice(0, 2);
  const folder = projectById(t.project, t.space)?.folder ?? t.cwd ?? "";
  const ms = (t.finishedAt ?? 0) - (t.startedAt ?? t.createdAt ?? t.finishedAt ?? 0);
  const lines: [string, string][] = (
    [
      ["Asked", t.ask.replace(/\s+/g, " ").trim().slice(0, full ? 400 : 160)],
      ["Result", (t.summary ?? "").trim().slice(0, full ? 900 : 200)],
      ["Notes", counted(notes, 5).join(" · ")],
      ["Failed", counted(failed.map((f) => f.cmd), 4).join(" · ")],
      ["Output", out.join(" · ")],
      ["Error", err],
      ["Subtask failed", kids.join(" · ")],
    ] as [string, string][]
  ).filter(([, v]) => v);
  return { id: t.id, head: `## job ${t.id} · ${home(folder)} · ${t.status}${ms > 0 ? ` · took ${took(ms)}` : ""}`, lines };
}

const flat = (s: string) => s.replace(/[`"'“”‘’]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
/** Is the quote really in what these jobs said (whitespace and quote marks aside)? */
export function grounded(quote: unknown, mats: JobLines[]): boolean {
  if (typeof quote !== "string") return false;
  const q = flat(quote.replace(/^\s*(asked|result|notes|failed|output|error|subtask failed)\s*:\s*/i, ""));
  if (q.length < 5 || q.length > 300) return false;
  return mats.some((m) => m.lines.some(([, v]) => flat(v).includes(q)));
}

/**
 * The jobs one call is given, newest first, within a budget: new ones first (the
 * ones it may learn from in full), then older ones of the window, short, as evidence.
 */
export function jobsShown(recent: Task[], fresh: Set<string>, learn: Set<string>) {
  const mats = new Map<string, JobLines>();
  const text = new Map<string, string>();
  let used = 0;
  for (const t of [...recent.filter((x) => fresh.has(x.id)), ...recent.filter((x) => !fresh.has(x.id))]) {
    const m = jobMaterial(t, learn.has(t.id));
    const tag = learn.has(t.id) ? " [new, learn]" : fresh.has(t.id) ? " [new]" : "";
    const s = [`${m.head}${tag}`, ...m.lines.map(([k, v]) => `${k}: ${v}`)].join("\n");
    if (used + s.length > JOBS_BUDGET && !learn.has(t.id)) continue;
    used += s.length;
    mats.set(t.id, m);
    text.set(t.id, s);
  }
  const shown = recent.filter((t) => mats.has(t.id));
  return { shown, mats, text: shown.map((t) => text.get(t.id)!) };
}

export function tidyPrompt(space: SpaceId, list: Memory[], jobs: string[], learn: boolean, patterns: boolean): string {
  const lines = list.map((m) => `- [${m.id}] (${kindOf(m)}${userOwned(m) ? ", user's own" : ""}${m.scope === "project" ? `, project ${m.project}` : m.scope === "global" ? ", everywhere" : ""}) ${m.text}${m.keys?.length ? `  {keys: ${m.keys.join(", ")}}` : ""}`);
  return [
    `You keep the long-term memory of a coding agent for the space "${spaceById(space)?.label ?? space}". Tidy it. Be conservative: when unsure, change nothing.`,
    "",
    "Do these:",
    "1. merge: pieces that say the same thing → keep one (prefer the user's own), drop the others, optionally a better merged text (one short Korean sentence). Never drop or reword a user's own piece.",
    "2. retire: when two pieces contradict, the older one (the newer replaces it). Never retire a user's own piece: when a piece that is not the user's own contradicts one that is, put the pair in conflict instead; the user decides.",
    "3. keys: for EVERY piece without {keys}, 4–8 related search words a future task might use for it: synonyms, Korean and English forms, the general topic (e.g. 'iOS 빌드 실패' → 'Xcode, 시뮬레이터, build error, 캐시, 빌드 오류'). Short words only.",
    "4. about: for each piece, 0–3 named things it is about (tools, services, libraries, products, projects), in their usual spelling (e.g. 'Supabase', 'Next.js', 'GitHub').",
    "5. kind: fix a wrong kind (rule, preference, decision, fact, procedure, lesson).",
    ...(learn
      ? [
          "6. learn: from the jobs marked [learn], 0–2 pieces each that a FUTURE job in this space would need and could not guess: a project fact, a working procedure, a pitfall that cost time, a decision. Skip what is obvious, one-off, or already in memory. Most jobs teach nothing — that's fine.",
        ]
      : []),
    ...(patterns
      ? [
          `7. patterns: a lesson or procedure that recurs across at least ${MIN_EVIDENCE} different jobs below (the same failure, the same fix, the same slow or repeated step, the same setup), with at least one job marked [new]. One piece per pattern, citing every job it shows in. Read the Notes, Failed, Output and Error lines and how long jobs took, not only the results. E.g. "이 프로젝트 dev 서버는 3217 포트를 써요 — 이미 떠 있으면 다시 띄우지 말고 curl로 확인해요", "acme는 pnpm test 전에 pnpm build가 필요해요". Skip what memory already says. Usually there is none.`,
        ]
      : []),
    ...(learn || patterns
      ? [
          "",
          `Each ${learn && patterns ? "learn or pattern" : learn ? "learn" : "pattern"} piece: one short Korean sentence ending in ~요, no temp paths, ids or localhost URLs. "quote": a short phrase (under 120 characters) copied exactly from a line of a cited job below, without its label; a piece whose quote is not there is thrown away. If it contradicts a user's own piece, set "against" to that piece's id (it is not saved; the user decides).`,
        ]
      : []),
    "",
    `Reply with only a fenced block (omit empty fields):\n\`\`\`tidy\n{${[
      '"merge":[{"keep":"id","drop":["id"],"text":"..."}]',
      '"retire":[{"id":"older","by":"newer"}]',
      '"conflict":[{"mine":"user\'s own id","new":"other id"}]',
      '"keys":{"id":["..."]}',
      '"about":{"id":["..."]}',
      '"kind":{"id":"rule"}',
      ...(learn ? ['"learn":[{"job":"id","quote":"...","text":"...","kind":"lesson","project":true}]'] : []),
      ...(patterns ? ['"patterns":[{"jobs":["id","id","id"],"quote":"...","text":"...","kind":"procedure","project":true}]'] : []),
    ].join(",")}}\n\`\`\``,
    "",
    "# Memory pieces",
    ...(lines.length ? lines : ["(none)"]),
    ...(jobs.length ? ["", `# Finished jobs, newest first${patterns ? " ([new] = not read before)" : ""}`, ...jobs] : []),
  ].join("\n");
}

type Filed = { job?: string; jobs?: string[]; quote?: string; text?: string; kind?: string; project?: boolean; against?: string };
export type Plan = {
  merge?: { keep?: string; drop?: string[]; text?: string }[];
  retire?: { id?: string; by?: string }[];
  conflict?: { mine?: string; new?: string }[];
  keys?: Record<string, string[]>;
  about?: Record<string, string[]>;
  kind?: Record<string, string>;
  learn?: Filed[];
  patterns?: Filed[];
};

/** What one call was given about the space's finished jobs. */
export type Seen = { space: SpaceId; shown: Task[]; mats: Map<string, JobLines>; fresh: Set<string>; learn: Set<string> };

const words = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x && x.length <= len)
    .slice(0, max);

/** keep pending ones, and the last answers so the same thing isn't asked again */
const keepConflicts = (l: MemoryConflict[]) => [...l.filter((c) => !c.done), ...l.filter((c) => c.done).slice(-40)];
/** 확인 필요: put one in front of the user (the quiet pass and 교차 검토 both ask this way) */
export const queueConflict = (space: SpaceId, c: Omit<MemoryConflict, "id" | "at" | "space">, at = Date.now()) =>
  setState("memoryConflicts", (l) => keepConflicts([...(l ?? []), { id: uid("c"), at, space, ...c }]));
/** the same new text was already asked about for this piece (and not taken) */
export const askedBefore = (mine: string, text: string) => (state.memoryConflicts ?? []).some((c) => c.mine === mine && !!c.text && flat(c.text) === flat(text) && c.done !== "new");

/** Check the model's plan and apply what holds up. */
export function applyPlan(plan: Plan, list: Memory[], seen: Seen) {
  const mine = new Map(list.map((m) => [m.id, m]));
  const live = (id?: string) => (id && typeof id === "string" ? mine.get(id) : undefined);
  const n = { merged: 0, retired: 0, learned: 0, keyed: 0, held: 0, dropped: 0 };
  const now = Date.now();
  const conflicts = () => state.memoryConflicts ?? [];
  const ask = (c: Omit<MemoryConflict, "id" | "at" | "space">) => {
    queueConflict(seen.space, c, now);
    n.held++;
  };
  /** a piece already kept says otherwise than the user's own: out of use until the user picks */
  const hold = (user: Memory, other: Memory) => {
    if (!userOwned(user) || userOwned(other) || other.invalidAt || user.invalidAt) return;
    if (conflicts().some((c) => c.mine === user.id && c.theirs === other.id)) return;
    retireMemory(other.id, undefined, "내 메모리와 달라서 확인 중이에요");
    ask({ mine: user.id, theirs: other.id });
  };
  for (const g of plan.merge ?? []) {
    const keep = live(g.keep);
    if (!keep) continue;
    for (const id of g.drop ?? []) {
      const d = live(id);
      if (!d || d.id === keep.id || userOwned(d) || d.invalidAt) continue;
      retireMemory(d.id, keep.id, "같은 기억과 합쳤어요");
      // merged away = it came up again; where both came from stays with the one kept
      setState("memory", (m) => m.id === keep.id, (m) => {
        const sources = unionSources(m, d);
        return { seen: (m.seen ?? 1) + (d.seen ?? 1), ...(sources.length ? { sources } : {}) };
      });
      n.merged++;
    }
    const text = typeof g.text === "string" ? g.text.trim() : "";
    if (text && text.length <= 300 && text !== keep.text && !userOwned(keep)) setState("memory", (m) => m.id === keep.id, { text, updatedAt: now });
  }
  for (const r of plan.retire ?? []) {
    const old = live(r.id), by = live(r.by);
    if (!old || !by || old.invalidAt || old.id === by.id) continue;
    // a learned piece against the user's own: the user decides, nothing is retired for them
    if (userOwned(old)) {
      hold(old, by);
      continue;
    }
    if (old.createdAt > by.createdAt) continue;
    retireMemory(old.id, by.id, "새 기억과 달라서 내렸어요");
    n.retired++;
  }
  for (const c of plan.conflict ?? []) {
    const user = live(c.mine), other = live(c.new);
    if (user && other && user.id !== other.id) hold(user, other);
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

  /** a piece from these jobs (newest first): grounded, then saved, or asked about when it goes against the user's own */
  const file = (p: Filed, jobs: Task[]) => {
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!text || text.length > 300) return;
    if (!grounded(p.quote, jobs.map((j) => seen.mats.get(j.id)!))) {
      n.dropped++;
      return;
    }
    const folders = new Set(jobs.map((j) => projectById(j.project, j.space)?.folder));
    const folder = folders.size === 1 ? [...folders][0] : undefined;
    const scope = p.project && folder ? "project" : "space";
    const kind = KIND_IDS.has(p.kind as MemoryKind) ? (p.kind as MemoryKind) : undefined;
    const sources = jobs.map((j) => j.id);
    const against = live(p.against);
    if (against && userOwned(against) && !against.invalidAt) {
      if (!askedBefore(against.id, text)) ask({ mine: against.id, text, kind, scope, project: scope === "project" ? folder : undefined, sources });
      return;
    }
    const before = state.memory.length;
    const id = addMemory(text, scope, {
      space: seen.space,
      project: folder,
      source: "ondra",
      kind,
      importance: 3,
      taskId: jobs[0].id,
      sources,
      by: "agent",
      quiet: true,
      replaces: against && !against.invalidAt ? against.id : undefined,
    });
    if (state.memory.length > before) n.learned++;
    if (against && id && state.memory.find((m) => m.id === against.id)?.invalidAt) n.retired++;
    // the 일 기록 entries know what was learned from them
    if (id) for (const j of jobs) setState("journal", (e) => e.taskId === j.id, (e) => ({ learned: [...new Set([...(e.learned ?? []), id])] }));
  };
  const byId = new Map(seen.shown.map((t) => [t.id, t]));
  for (const l of plan.learn ?? []) {
    const job = typeof l.job === "string" ? byId.get(l.job) : undefined;
    if (job && seen.learn.has(job.id)) file(l, [job]);
  }
  for (const p of plan.patterns ?? []) {
    const ids = [...new Set([...(Array.isArray(p.jobs) ? p.jobs : []), ...(p.job ? [p.job] : [])])].filter((id): id is string => typeof id === "string" && byId.has(id));
    // seen in 3+ different jobs, one of them new (old evidence alone was read before)
    if (ids.length < MIN_EVIDENCE || !ids.some((id) => seen.fresh.has(id))) {
      n.dropped++;
      continue;
    }
    file(p, ids.map((id) => byId.get(id)!).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)));
  }
  return n;
}

// ───────────── 확인 필요: the user picks

/** what waits for the user in this space (their piece still there, and the other one too) */
export const conflictsIn = (space: SpaceId) =>
  (state.memoryConflicts ?? []).filter((c) => !c.done && c.space === space && state.memory.some((m) => m.id === c.mine && isLive(m)) && (c.text || state.memory.some((m) => m.id === c.theirs)));

const settle = (id: string, done: MemoryConflict["done"]) => setState("memoryConflicts", (l) => keepConflicts((l ?? []).map((c) => (c.id === id ? { ...c, done } : c))));

/** keep the user's own piece: the learned one stays out */
export function keepMine(id: string) {
  const c = (state.memoryConflicts ?? []).find((x) => x.id === id && !x.done);
  if (!c) return;
  if (c.theirs) setState("memory", (m) => m.id === c.theirs, { why: "내 메모리와 달라서 내렸어요" });
  settle(id, "mine");
}

/** use the learned piece instead: the user's own is retired (they confirmed), replaced by it.
 *  Returns an undo: yours back as it was, the new one gone again (held, or never saved), the question open again. */
export function useNew(id: string): (() => void) | undefined {
  const c = (state.memoryConflicts ?? []).find((x) => x.id === id && !x.done);
  if (!c) return;
  const before = new Map(state.memory.map((m) => [m.id, JSON.stringify(m)]));
  const user = state.memory.find((m) => m.id === c.mine && isLive(m));
  // retired first, so the new piece isn't counted as the same thing again
  if (user) retireMemory(user.id, undefined, "새 메모리로 바꿨어요");
  let next = c.theirs;
  if (c.theirs) restoreMemory(c.theirs);
  else if (c.text)
    next =
      addMemory(c.text, c.scope ?? "space", { space: c.space, project: c.project, kind: c.kind, sources: c.sources, taskId: c.sources?.[0], source: "ondra", by: "agent", importance: 3, quiet: true }) ?? undefined;
  if (user && next) setState("memory", (m) => m.id === user.id, { supersededBy: next });
  settle(id, "new");
  // what this changed: pieces added, and pieces whose fields changed (put back whole)
  const added = new Set(state.memory.filter((m) => !before.has(m.id)).map((m) => m.id));
  const changed = new Map(
    state.memory.filter((m) => before.has(m.id) && before.get(m.id) !== JSON.stringify(m)).map((m) => [m.id, JSON.parse(before.get(m.id)!) as Memory]),
  );
  return () => {
    setState("memory", (l) => l.filter((m) => !added.has(m.id)).map((m) => changed.get(m.id) ?? m));
    // asked again, back in its place among the open ones
    setState("memoryConflicts", (l) => {
      const all = (l ?? []).map((x) => (x.id === id ? { ...x, done: undefined } : x));
      return [...all.filter((x) => !x.done).sort((a, b) => a.at - b.at), ...all.filter((x) => x.done)];
    });
  };
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
  const total = { merged: 0, retired: 0, learned: 0, keyed: 0, held: 0, skills: 0 };
  const touched: string[] = [];
  let failed = 0;
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
      // the last finished jobs here: new ones (past the cursor) are read, older ones are evidence for patterns
      const recent = state.tasks
        .filter((t) => t.space === sp.id && !t.parentId && !t.answer && t.finishedAt && (t.status === "done" || t.status === "failed"))
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(0, WINDOW);
      const fresh = recent.filter((t) => (t.finishedAt ?? 0) > cursor && !seen.has(t.id));
      const learn = new Set(fresh.filter((t) => learnable(t, seen, cursor)).slice(0, 6).map((t) => t.id));
      const patterns = fresh.length > 0 && recent.length >= MIN_EVIDENCE;
      const needs = learn.size || patterns || list.some((m) => !m.keys?.length) || (force && list.length > 1);
      if (!needs) continue;
      const freshIds = new Set(fresh.map((t) => t.id));
      const given = jobsShown(patterns ? recent : recent.filter((t) => learn.has(t.id)), freshIds, learn);
      try {
        const raw = await within(oneShot(sp.id, sp.folder, tidyPrompt(sp.id, list, given.text, learn.size > 0, patterns)));
        const plan = (readFences(raw, "tidy").items[0] ?? {}) as Plan;
        const n = applyPlan(plan, list, { space: sp.id, shown: given.shown, mats: given.mats, fresh: freshIds, learn });
        for (const k of Object.keys(total) as (keyof typeof total)[]) if (k in n) total[k] += n[k as keyof typeof n];
        touched.push(...fresh.map((t) => t.id));
        for (const t of fresh) reached = Math.max(reached, t.finishedAt ?? 0);
      } catch {
        // this space waits for the next pass
        failed++;
      }
    }
    total.skills = await growSkills(only);
    // one space tidied: the others keep their turn (the timer and the cursor of jobs not yet learned from)
    // a pass that did nothing (it failed, or one space had nothing to tidy) leaves no record behind
    const did = touched.length > 0 || Object.values(total).some(Boolean);
    if (!only || did) setState("memoryTidy", { at: only ? (last?.at ?? 0) : Date.now(), ...total, tasks: [...seen, ...touched].slice(-300), cursor: only ? cursor : reached });
    if (force && failed) toast(tr("정리하지 못했어요"), "bad", { label: tr("다시 시도"), run: () => void tidyMemory(true, only) });
    else if (force) {
      const parts = [total.skills && tr("스킬 {n}", { n: total.skills }), ...tidyParts(total)];
      toast(parts.length ? tr("메모리 정리 · {parts}", { parts: parts.filter(Boolean).join(" · ") }) : tr("정리할 메모리가 없어요"));
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

/** what a pass did, in short parts: "새 메모리 3 · 병합 1 · 내림 1 · 확인 필요 1" */
export const tidyParts = (x: { learned?: number; merged?: number; retired?: number; keyed?: number; held?: number }): string[] =>
  [
    x.learned && tr("새 메모리 {n}", { n: x.learned }),
    x.merged && tr("병합 {n}", { n: x.merged }),
    x.retired && tr("내림 {n}", { n: x.retired }),
    x.held && tr("물어봄 {n}", { n: x.held }),
    x.keyed && tr("관련어 {n}", { n: x.keyed }),
  ].filter((p): p is string => !!p);

export { kindLabel };
