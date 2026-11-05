// Memory as small pieces (one rule, fact or decision each), put together from
// what works best in other agents (research: docs/research, 2026-11):
//   • Claude Code / Qwen / Letta: one file per piece with a one-line index
//   • ZeroClaw: a stable key is the identity (same key again → update, not a copy)
//   • mem0 / Honcho: the same thing again → counted (seen), not stored twice
//   • Agent Zero: paths, ports and one-off values never become memory
//   • OmO / Qwen pinned: the user's own words are never changed by automation
//   • Zep: a replaced piece is retired with a date, not deleted
//   • Cursor / Claude rules / Kiro: path rules reach a job only when it touches the file
//   • Copilot: code facts cite files; when the files are gone the piece is retired
//   • CrewAI / ZeroClaw: recall = words + meaning + importance + recency (30-day
//     half-life); the user's rules and preferences never fade
//   • A-MEM: recall follows one link to neighbours
//   • Codex / nanobot / Letta: the folder is a git repo (versions, restore) — memgit.ts
//   • nothing is always-on: a few pieces at the start, the rest via memory_search
import { similarity } from "./vectors";
import { createEffect, createRoot } from "solid-js";
import { memoryMirror } from "../lib/native";
import { expand } from "./rpc";
import { loaded, setState, state, uid } from "../state/store";
import type { Memory, MemoryKind, SpaceId } from "../state/types";
import { toast } from "../state/ui";

export const KINDS: { id: MemoryKind; label: string }[] = [
  { id: "rule", label: "규칙" },
  { id: "preference", label: "취향" },
  { id: "decision", label: "결정" },
  { id: "fact", label: "사실" },
  { id: "procedure", label: "방법" },
  { id: "lesson", label: "배운 점" },
];
export const kindLabel = (k: MemoryKind) => KINDS.find((x) => x.id === k)?.label ?? k;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.。!]+$/, "").trim();

/** words worth matching (Korean and English), particles and filler dropped */
export function tokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._/-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|요|해요|했어요|돼요|하기|하고|해서)$/u, ""))
    .filter((w) => w.length >= 2 && !/^(그리고|있어요|이에요|그냥|이거|그거|the|and|for|with|that|this)$/.test(w));
}
const overlap = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return { n, j: n / Math.max(1, a.size + b.size - n) };
};

/** One piece per line or bullet; a long line is cut at sentence ends. */
export function atoms(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const l of lines) {
    if (l.length <= 220) out.push(l);
    else out.push(...l.split(/(?<=[.!?。]|요\.|다\.)\s+/).map((s) => s.trim()).filter(Boolean));
  }
  return out.filter((s) => s.length >= 3).map((s) => (s.length > 300 ? `${s.slice(0, 299)}…` : s));
}

export function guessKind(t: string): MemoryKind {
  if (/(결정|기로\s?(했|정했|함|해요)|정했|골랐|decided|chose)/i.test(t)) return "decision";
  if (/(하지\s?마|하지 않|않아요|금지|절대|항상|반드시|무조건|꼭\s|해야|으?로 해요|never|always|don't|do not|must)/i.test(t)) return "rule";
  if (/(좋아|싫어|선호|원해|원함|편해|prefer|like)/i.test(t)) return "preference";
  if (/(하려면|순서|방법|먼저.+다음|단계|steps?|how to|run `|명령)/i.test(t)) return "procedure";
  if (/(실패|안 됐|안됐|조심|주의|교훈|함정|깨져|lesson|gotcha|pitfall)/i.test(t)) return "lesson";
  return "fact";
}

export const kindOf = (m: Memory): MemoryKind => m.kind ?? guessKind(m.text);
export const isLive = (m: Memory) => !m.invalidAt;

/**
 * How fresh a piece is, 0–1 (a forgetting curve): halves every
 * 30 days × importance, and every use buys two more weeks. Pinned stay at 1.
 */
export function strength(m: Memory, now = Date.now()): number {
  if (m.pinned || evergreen(m)) return 1;
  const days = (now - (m.lastUsed ?? m.updatedAt ?? m.createdAt)) / 86_400_000;
  const half = 30 * (m.importance ?? 3) + 14 * Math.min(10, m.uses);
  return Math.pow(0.5, Math.max(0, days) / half);
}
/** the user's own rules and preferences don't fade */
export const evergreen = (m: Memory) => m.by === "user" && (m.kind === "rule" || m.kind === "preference");
/** written by the user (or brought from their notes): the quiet pass never changes it */
export const userOwned = (m: Memory) => m.by === "user" || (m.by === undefined && m.source !== "ondra");
/** ranks lower and shows faint */
export const faded = (m: Memory) => strength(m) < 0.25;
/** so faded the tidy pass retires it */
export const forgotten = (m: Memory) => !m.pinned && strength(m) < 0.06;

/** the words a piece is found by: its text, plus related words and topics from the tidy pass */
const findWords = (m: Memory) => tokens([m.text, ...(m.keys ?? []), ...(m.about ?? [])].join(" "));

type AddOpts = {
  space?: SpaceId;
  project?: string;
  source?: Memory["source"];
  quiet?: boolean;
  kind?: MemoryKind;
  /** in every prompt (the user said it) vs recalled when it fits */
  pinned?: boolean;
  importance?: number;
  /** id of a memory this one corrects: that one is retired */
  replaces?: string;
  taskId?: string;
  /** brought in from this file */
  from?: string;
  keys?: string[];
  about?: string[];
  /** stable name: the same key again updates that piece */
  key?: string;
  /** file globs this applies to (shown when a job touches one) */
  paths?: string[];
  /** code files it is about */
  cites?: string[];
  /** who said it (default: the user, unless it came from a job) */
  by?: "user" | "agent";
  /** why it was refused, for the caller */
  onRefuse?: (why: string) => void;
};

/** A stable file-name key from a text (letters, digits, Korean kept). */
export const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "piece";

/**
 * Agent Zero's durability gate: one-off details (temp paths, local ports, ids,
 * "this time only") are not memory. Only checked for what agents save.
 */
const ONE_OFF = /(\/tmp\/|\/private\/var\/|\/var\/folders\/|localhost:\d+|127\.0\.0\.1:\d+|\b\d{1,3}(\.\d{1,3}){3}:\d+|\b[0-9a-f]{16,}\b|\bpid\s*\d+|이번만|이번 한 ?번|오늘만|임시로|for now|this time only|temporarily)/i;
export const oneOff = (t: string) => ONE_OFF.test(t);

/** glob → RegExp ("**" any depth, "*" one segment) */
const globRe = (g: string) =>
  new RegExp(
    `^${g
      .replace(/^\.\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*")}$`,
  );
/** Does this piece's `paths` cover a file? `file` is absolute; `root` is where the globs start. */
export function pathMatches(m: Memory, file: string, root: string): boolean {
  if (!m.paths?.length) return false;
  const rel = root && file.startsWith(`${root.replace(/\/$/, "")}/`) ? file.slice(root.replace(/\/$/, "").length + 1) : file;
  return m.paths.some((g) => {
    try {
      const re = globRe(g);
      return re.test(rel) || re.test(file) || (!g.includes("/") && re.test(file.split("/").pop() ?? ""));
    } catch {
      return false;
    }
  });
}

const sameHome = (m: Memory, scope: Memory["scope"], o: AddOpts) =>
  m.scope === scope && (scope !== "space" || m.space === o.space) && (scope !== "project" || (m.project ?? "") === (o.project ?? ""));

/**
 * Save what was said as small pieces. Each piece is checked against what is
 * already kept: the same thing → kept once (and made stronger); it corrects an
 * old piece (`replaces`) → the old one is retired. Returns the first piece's id.
 */
export function addMemory(text: string, scope: Memory["scope"], opts: AddOpts = {}): string | null {
  const by = opts.by ?? (opts.taskId ? "agent" : "user");
  // a key names one piece: keep its text whole
  const parts = opts.key ? [text.trim().slice(0, 600)].filter(Boolean) : atoms(text.trim());
  if (!parts.length) return null;
  if (by === "agent" && parts.every(oneOff)) {
    opts.onRefuse?.("one-off detail (temp path, local port, id or 'this time only') — not memory");
    return null;
  }
  const now = Date.now();
  const made: Memory[] = [];
  const ids: string[] = [];
  let replaced: Memory | undefined;
  for (const [i, t] of parts.entries()) {
    if (by === "agent" && oneOff(t)) continue;
    const live = state.memory.filter((m) => isLive(m) && sameHome(m, scope, opts));
    const tk = new Set(tokens(t));
    const same = opts.key ? live.find((m) => m.key === opts.key) : undefined;
    const dup = (same && norm(same.text) === norm(t) ? same : undefined) ?? live.find((m) => norm(m.text) === norm(t) || overlap(tk, new Set(tokens(m.text))).j >= 0.75);
    if (dup) {
      // the same thing again: counted, not stored twice (Honcho times_derived)
      setState("memory", (m) => m.id === dup.id, (m) => ({
        updatedAt: now,
        lastUsed: now,
        pinned: false,
        seen: (m.seen ?? 1) + 1,
        importance: Math.min(5, Math.max(m.importance ?? 3, opts.importance ?? (opts.pinned ? 5 : 3))),
        paths: opts.paths?.length ? [...new Set([...(m.paths ?? []), ...opts.paths])] : m.paths,
        by: (m.by === "user" || by === "user" ? "user" : "agent") as Memory["by"],
      }));
      ids.push(dup.id);
      continue;
    }
    // the same key with new words: this version replaces the old one (kept as history)
    if (same) {
      if (userOwned(same) && by === "agent") {
        opts.onRefuse?.(`"${same.key}" is the user's own memory; save a new key instead`);
        continue;
      }
      replaced = same;
    }
    // neighbours: pieces that talk about the same things (2+ shared words)
    const links = state.memory
      .filter(isLive)
      .map((m) => ({ id: m.id, o: overlap(tk, new Set(tokens(m.text))) }))
      .filter((x) => x.o.n >= 2 && x.o.j >= 0.2)
      .sort((a, b) => b.o.j - a.o.j)
      .slice(0, 3)
      .map((x) => x.id);
    const m: Memory = {
      id: uid("m"),
      text: t,
      kind: opts.kind && parts.length === 1 ? opts.kind : guessKind(t),
      scope,
      space: scope === "space" ? opts.space : undefined,
      project: scope === "project" ? opts.project : undefined,
      source: opts.source ?? "ondra",
      taskId: opts.taskId,
      from: opts.from,
      keys: opts.keys?.length ? opts.keys : undefined,
      about: opts.about?.length ? opts.about : undefined,
      key: opts.key ?? (replaced?.key || undefined),
      paths: opts.paths?.length ? opts.paths : replaced?.paths,
      cites: opts.cites?.length ? opts.cites : undefined,
      by,
      seen: 1,
      pinned: false,
      importance: opts.importance ?? (opts.pinned ? 5 : 3),
      links,
      createdAt: now + i,
      updatedAt: now + i,
      uses: 0,
    };
    made.push(m);
    ids.push(m.id);
  }
  // pieces said together belong together
  for (const m of made) m.links = [...new Set([...(m.links ?? []), ...made.filter((x) => x !== m).map((x) => x.id)])].slice(0, 6);
  if (made.length) {
    setState("memory", (list) => [
      ...list.map((x) => {
        const back = made.filter((m) => m.links?.includes(x.id)).map((m) => m.id);
        return back.length ? { ...x, links: [...new Set([...(x.links ?? []), ...back])] } : x;
      }),
      ...made,
    ]);
  }
  let old = opts.replaces ? state.memory.find((m) => m.id === opts.replaces && isLive(m)) : undefined;
  if (old && by === "agent" && userOwned(old)) {
    opts.onRefuse?.("that memory is the user's own; saved yours next to it");
    old = undefined;
  }
  old ??= replaced;
  if (old && made[0]) retireMemory(old.id, made[0].id, old === replaced ? "새 내용으로 바뀌었어요" : undefined);
  if (!opts.quiet && made.length) {
    const what = made.length > 1 ? `${made.length}개로 나눠 기억했어요` : `기억함: ${made[0].text.slice(0, 200)}`;
    toast(old ? `${what} · 예전 기억은 지난 기억으로 옮겼어요` : what, "info", { label: "취소", run: () => made.forEach((m) => removeMemory(m.id)) });
  }
  return ids[0] ?? null;
}

export function removeMemory(id: string) {
  setState("memory", (list) =>
    list
      .filter((m) => m.id !== id)
      .map((m) => (m.links?.includes(id) || m.supersededBy === id ? { ...m, links: m.links?.filter((l) => l !== id), supersededBy: m.supersededBy === id ? undefined : m.supersededBy } : m)),
  );
}

export function updateMemory(id: string, text: string) {
  const t = text.trim();
  if (!t) return;
  setState("memory", (m) => m.id === id, (m) => ({ text: t, updatedAt: Date.now(), kind: m.kind ?? guessKind(t) }));
}

export function setMemory(id: string, patch: Partial<Pick<Memory, "kind" | "pinned" | "importance">>) {
  setState("memory", (m) => m.id === id, { ...patch, updatedAt: Date.now() });
}

/** No longer true: kept as history, never sent to agents again. */
export function retireMemory(id: string, by?: string, why?: string) {
  setState("memory", (m) => m.id === id, { invalidAt: Date.now(), supersededBy: by, why, pinned: false });
}

export function restoreMemory(id: string) {
  // back in use: fresh again, so it doesn't fade straight back out
  setState("memory", (m) => m.id === id, { invalidAt: undefined, supersededBy: undefined, why: undefined, lastUsed: Date.now() });
}

/** Counted only for pieces that really went into a prompt. */
export function markUsed(ids: string[]) {
  if (!ids.length) return;
  const now = Date.now();
  setState("memory", (m) => ids.includes(m.id), (m) => ({ uses: m.uses + 1, lastUsed: now }));
}

// ───────────── reading

const under = (dir: string, folder: string) => dir === folder || dir.startsWith(`${folder}/`);
/** a worktree kept apart from its repo (…/worktrees/<repo>/<job>) counts as being in that repo */
const sameRepo = (dir: string, folder: string) => {
  const repo = /\/worktrees\/([^/]+)\//.exec(`${dir}/`)?.[1];
  return !!repo && folder.replace(/\/+$/, "").split("/").pop() === repo;
};

/** Live pieces that apply here. `expand` turns "~/…" into an absolute path. */
export function applying(space: SpaceId, dir: string, expand: (p: string) => string): Memory[] {
  return state.memory.filter(
    (m) =>
      isLive(m) &&
      (m.scope === "global" ||
        (m.scope === "space" && m.space === space) ||
        (m.scope === "project" && !!dir && !!m.project && (under(dir, expand(m.project)) || sameRepo(dir, expand(m.project))))),
  );
}

/** Nothing is always-on: every piece is recalled when it fits or searched for (memory_search). */
export const core = (_list: Memory[]): Memory[] => [];

/**
 * The rest, ranked for this piece of work (BM25-style word match + meaning from
 * local embeddings when the query was prepared + importance + recency), cut to a budget so the prompt stays small. Pieces with no word in
 * common are left out unless they are filed under this very folder.
 */
export function recall(
  list: Memory[],
  query: string,
  opts: { budget?: number; max?: number; folder?: (m: Memory) => boolean; links?: boolean; /** only pieces clearly about the query */ strict?: boolean; /** strict: what the work is about (its title, topic); a piece must share a word with it */ about?: string } = {},
): Memory[] {
  const pool = list;
  if (!pool.length) return [];
  const q = [...new Set(tokens(query))];
  const aboutWords = new Set(tokens(opts.about ?? ""));
  const docs = pool.map((m) => ({ m, w: findWords(m) }));
  const avg = docs.reduce((n, d) => n + d.w.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d.w)) df.set(w, (df.get(w) ?? 0) + 1);
  const now = Date.now();
  // meaning: cosine from the local embedding model, scored relative to the other
  // pieces (models differ in scale; what matters is standing out for this query)
  const sims = pool.map((m) => similarity(query, m));
  const got = sims.filter((x): x is number => x !== undefined);
  const mu = got.reduce((a, b) => a + b, 0) / (got.length || 1);
  const sd = Math.sqrt(got.reduce((a, b) => a + (b - mu) ** 2, 0) / (got.length || 1)) || 1;
  const scored = docs.map(({ m, w }, i) => {
    let bm = 0;
    let rare = 0; // distinct query words it shares that few pieces have
    let onTopic = !opts.about;
    for (const t of q) {
      const tf = w.filter((x) => x === t || (t.length >= 3 && (x.startsWith(t) || t.startsWith(x)))).length;
      if (!tf) continue;
      if ((df.get(t) ?? 0) <= Math.max(3, docs.length * 0.04)) rare++;
      if (aboutWords.has(t) && (df.get(t) ?? 0) <= Math.max(3, docs.length * 0.25)) onTopic = true;
      const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      bm += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (w.length / avg)));
    }
    const local = opts.folder?.(m) ?? false;
    const fresh = strength(m, now);
    const sim = sims[i];
    const sem = sim === undefined || got.length < 4 ? 0 : Math.min(3, Math.max(0, (sim - mu) / sd - 1.2) * 1.5);
    // strict: one shared common word isn't enough; the words or the meaning must match.
    // Meaning scores are relative (some piece always stands out), so they count only on topic
    const hit = opts.strict ? onTopic && (rare >= 2 || sem > 0.8) : bm > 0 || sem > 0 || local;
    // + importance, + how often it came up again, + recency (30-day half-life)
    const seen = Math.min(0.3, 0.1 * ((m.seen ?? 1) - 1));
    const score = (bm + sem + (hit ? 0.35 * ((m.importance ?? 3) / 5) + 0.25 * fresh + seen + (local ? 0.6 : 0) : 0)) * (0.45 + 0.55 * fresh);
    return { m, score: opts.strict && !hit ? 0 : score };
  });
  const out: Memory[] = [];
  let used = 0;
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  // strict: far weaker than the best match means it is about something else
  const floor = opts.strict && ranked.length ? ranked[0].score * 0.4 : 0;
  for (const { m } of ranked.filter((s) => s.score >= floor)) {
    if (out.length >= (opts.max ?? 8) || used + m.text.length > (opts.budget ?? 1800)) break;
    out.push(m);
    used += m.text.length;
  }
  // A-MEM: one step along links — a neighbour often holds the rest of the answer
  if (opts.links && out.length) {
    const inPool = new Set(pool.map((m) => m.id));
    const extra = out
      .flatMap((m) => m.links ?? [])
      .filter((id, i, a) => a.indexOf(id) === i && inPool.has(id) && !out.some((o) => o.id === id))
      .map((id) => pool.find((m) => m.id === id)!)
      .filter((m) => m && isLive(m))
      .slice(0, 2);
    for (const m of extra) if (used + m.text.length <= (opts.budget ?? 1800) * 1.25) (out.push(m), (used += m.text.length));
  }
  return out;
}

/** Mastra-style lines: ★ marks what matters most; kind, how often it came up, the date it was last true. */
export function memoryLines(list: Memory[], withIds = true): string[] {
  const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  return list.map((m) => {
    const tags = [kindLabel(kindOf(m)), (m.seen ?? 1) > 1 ? `${m.seen}번` : "", m.by === "user" ? "사용자" : "", day(m.updatedAt ?? m.createdAt)].filter(Boolean).join(" · ");
    return `- ${(m.importance ?? 3) >= 4 ? "★ " : ""}${withIds ? `[${m.id}] ` : ""}${m.text} (${tags})`;
  });
}

// ───────────── old shape → pieces, and the Obsidian folder

/** Memories saved before pieces: split, give each a kind, keep them always-on as before. */
export function migrateMemory() {
  // no always-on memory: what was pinned becomes the most important recalled piece
  if (state.memory.some((m) => m.pinned)) setState("memory", (m) => !!m.pinned, { pinned: false, importance: 5 });
  // who said it, for pieces kept before that was recorded: learned in a job → agent;
  // said by the user or brought from their notes → user
  if (state.memory.some((m) => !m.by)) setState("memory", (m) => !m.by, (m): Partial<Memory> => ({ by: m.taskId ? "agent" : "user", seen: m.seen ?? 1 }));
  if (state.memory.every((m) => m.kind)) return;
  const out: Memory[] = [];
  for (const m of state.memory) {
    if (m.kind) {
      out.push(m);
      continue;
    }
    const parts = atoms(m.text);
    const ids = parts.map((_, i) => (i === 0 ? m.id : `${m.id}_${i}`));
    parts.forEach((t, i) =>
      out.push({
        ...m,
        id: ids[i],
        text: t,
        kind: guessKind(t),
        pinned: m.source === "ondra",
        importance: 3,
        links: ids.filter((x) => x !== ids[i]),
        updatedAt: m.createdAt,
      }),
    );
    if (!parts.length) out.push({ ...m, kind: guessKind(m.text), pinned: m.source === "ondra" });
  }
  setState("memory", out);
}

// ───────────── the memory folder (markdown, opens in Obsidian too; a git repo — memgit.ts)
//   목차.md                       ← one line per piece (Claude Code / Qwen index)
//   일 기록/202611/05/<제목>.md    ← one per finished job (journal.ts)
//   회사/ondra/지금.md            ← what was last going on there
//   회사/회사.md                  ← folder note: its pieces by type (links)
//   회사/규칙/<key 또는 첫 문장>.md
//   회사/주제/<주제>.md           ← links to the pieces about it (graph hubs)
//   회사/지난 기억/<…>.md         ← replaced or retired, with a link to what replaced it
//   회사/ondra/ondra.md · 회사/ondra/규칙/… · 회사/ondra/지금.md
// The memory view's tree is built from these same paths (memoryFileNames).
const fm = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const safe = (t: string) => t.replace(/[\\/:*?"<>|#^[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim();

/** A piece's file name (without .md): its key, else the start of its text; a short id when two collide. */
export function memoryFileNames(list: Memory[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const m of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
    let n = (m.key ? safe(m.key) : safe(m.text).slice(0, 48).replace(/[ .]+$/, "")) || m.id;
    if (used.has(n)) n = `${n} (${m.id.slice(-4)})`;
    used.add(n);
    names.set(m.id, n);
  }
  return names;
}
/** A 일 기록 entry's file name (without .md). */
export const journalFileName = (title: string, id: string) => safe(title).slice(0, 48) || id;
export const safeName = (t: string) => safe(t);

function mirrorFiles(): { path: string; text: string; once?: boolean }[] {
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  const spaceLabel = (id?: string) => safe(state.spaces.find((s) => s.id === id)?.label ?? id ?? "공간");
  const folderHome = (folder: string, space?: string) => {
    const p = (state.projects ?? []).find((x) => x.folder.replace(/\/$/, "") === folder.replace(/\/$/, ""));
    const sp = p?.space ?? state.spaces.find((s) => s.folder !== "~" && folder.includes(s.folder.replace(/^~/, "")))?.id ?? space;
    return `${sp ? spaceLabel(sp) : "프로젝트"}/${safe(p?.name ?? base(folder || "기타"))}`;
  };
  const projectHome = (m: Memory) => folderHome(m.project ?? "", m.space);
  const home = (m: Memory) => (m.scope === "global" ? "모든 일" : m.scope === "space" ? spaceLabel(m.space) : projectHome(m));
  // a space's folder note is its 목차.md (in the space folder); others keep their folder's name
  const noteOf = (h: string) => (!h.includes("/") && h !== "모든 일" && state.spaces.some((sp) => spaceLabel(sp.id) === h && sp.folder && sp.folder !== "~") ? "목차" : base(h));
  const names = memoryFileNames(state.memory);
  const link = (id: string) => (names.has(id) ? `[[${names.get(id)}]]` : "");
  const files: { path: string; text: string; once?: boolean }[] = [];
  for (const m of state.memory) {
    const k = kindOf(m);
    const meta: Record<string, unknown> = {
      id: m.id,
      kind: kindLabel(k),
      scope: m.scope === "global" ? "모든 일" : m.scope === "space" ? `공간 · ${spaceLabel(m.space)}` : `프로젝트 · ${m.project}`,
      ...(m.key ? { key: m.key } : {}),
      by: m.by === "user" || (m.by === undefined && m.source !== "ondra") ? "사용자" : "일",
      importance: m.importance ?? 3,
      ...((m.seen ?? 1) > 1 ? { seen: m.seen } : {}),
      ...(m.paths?.length ? { paths: m.paths } : {}),
      ...(m.cites?.length ? { cites: m.cites.map((c) => c.replace(/^\/Users\/[^/]+/, "~")) } : {}),
      ...(m.skill ? { skill: m.skill } : {}),
      created: new Date(m.createdAt).toISOString().slice(0, 10),
      ...(m.updatedAt && m.updatedAt - m.createdAt > 60_000 ? { updated: new Date(m.updatedAt).toISOString().slice(0, 10) } : {}),
      uses: m.uses,
      ...(m.invalidAt ? { retired: new Date(m.invalidAt).toISOString().slice(0, 10) } : {}),
      tags: [kindLabel(k).replace(/\s/g, "_"), ...(m.paths?.length ? ["경로_규칙"] : []), ...(m.invalidAt ? ["지난_기억"] : [])],
    };
    const links = (m.links ?? []).map(link).filter(Boolean);
    const older = state.memory.filter((x) => x.supersededBy === m.id).map((x) => link(x.id));
    const body = [
      m.text,
      "",
      ...(m.supersededBy ? [`바뀐 기억: ${link(m.supersededBy)}`] : []),
      ...(older.length ? [`예전 기억: ${older.join(" ")}`] : []),
      ...(links.length ? [`이어진 기억: ${links.join(" ")}`] : []),
      ...(m.about?.length ? [`주제: ${m.about.map((a) => `[[${safe(a)}]]`).join(" ")}`] : []),
      ...(m.from ? [`가져온 곳: ${m.from.replace(/^\/Users\/[^/]+/, "~")}`] : []),
      ...(m.why ? [`내린 이유: ${m.why}`] : []),
      `위치: [[${noteOf(home(m))}]]`,
    ];
    files.push({
      path: `${home(m)}/${m.invalidAt ? "지난 기억" : kindLabel(k)}/${names.get(m.id)}.md`,
      text: `---\n${Object.entries(meta).map(([key, v]) => `${key}: ${Array.isArray(v) ? `[${v.join(", ")}]` : fm(v)}`).join("\n")}\n---\n\n${body.join("\n")}\n`,
    });
  }
  // a note per folder (Obsidian "folder note"): its pieces by type, and its sub-folders
  const homes = new Map<string, Memory[]>();
  for (const m of state.memory.filter(isLive)) homes.set(home(m), [...(homes.get(home(m)) ?? []), m]);
  for (const h of [...homes.keys()]) {
    const parent = h.split("/").slice(0, -1).join("/");
    if (parent && !homes.has(parent)) homes.set(parent, []);
  }
  const section = (list: Memory[]) =>
    KINDS.flatMap((k) => {
      const l = list.filter((m) => kindOf(m) === k.id);
      return l.length ? [`## ${k.label} (${l.length})`, ...l.map((m) => `- ${link(m.id)}`), ""] : [];
    });
  for (const [h, list] of homes) {
    const subs = [...homes.keys()].filter((x) => x.startsWith(`${h}/`) && !x.slice(h.length + 1).includes("/"));
    files.push({
      path: `${h}/${base(h)}.md`,
      text: [`# ${base(h)}`, "", ...(subs.length ? ["## 프로젝트", ...subs.map((x) => `- [[${base(x)}]]`), ""] : []), ...section(list), h.includes("/") ? `위로: [[목차]]` : "", ""].join("\n"),
    });
  }
  const live = state.memory.filter(isLive);
  const past = state.memory.filter((m) => !isLive(m));
  // a note per topic (a tool or service two or more pieces are about), in each folder
  // that has pieces about it: Obsidian's graph hubs
  const topics = new Map<string, Memory[]>();
  for (const m of live) for (const a of m.about ?? []) topics.set(safe(a), [...(topics.get(safe(a)) ?? []), m]);
  for (const [t, all] of topics) {
    if (all.length < 2 || !t) continue;
    for (const h of new Set(all.map(home)))
      files.push({ path: `${h}/주제/${t}.md`, text: [`# ${t}`, "", ...all.filter((m) => home(m) === h).map((m) => `- ${link(m.id)}`), "", `위로: [[${noteOf(h)}]]`, ""].join("\n") });
  }
  // 목차: one line per piece, grouped by where it applies
  const byHome = [...homes.keys()].sort((x, y) => (x === "모든 일" ? -1 : y === "모든 일" ? 1 : x.localeCompare(y)));
  files.push({
    path: "목차.md",
    text: [
      "# 목차",
      "",
      `지금 ${live.length}개 · 지난 ${past.length}개 · 일 기록 ${(state.journal ?? []).length}개`,
      "",
      ...byHome.flatMap((h) => {
        const l = homes.get(h) ?? [];
        if (!l.length) return [];
        // a space with its own folder: its pieces are there (only a pointer here)
        const sp = state.spaces.find((x) => x.folder && x.folder !== "~" && spaceLabel(x.id) === h.split("/")[0]);
        if (sp) return h.includes("/") ? [] : [`## ${h}`, `${sp.folder.replace(/^\/Users\/[^/]+/, "~").replace(/\/$/, "")}/.ondra/memory/목차.md · ${live.filter((m) => home(m).split("/")[0] === h).length}개`, ""];
        return [`## ${h}`, ...l.map((m) => `- ${link(m.id)} — ${kindLabel(kindOf(m))} · ${m.text.replace(/\s+/g, " ").slice(0, 90)}`), ""];
      }),
    ].join("\n"),
  });
  // 일 기록: one note per finished job, by month and day
  const jn = new Set<string>();
  for (const j of state.journal ?? []) {
    const d = new Date(j.at);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const dd = String(d.getDate()).padStart(2, "0");
    let n = journalFileName(j.title, j.id);
    if (jn.has(`${j.space}/${ym}/${dd}/${n}`)) n = `${n} (${j.id.slice(-4)})`;
    jn.add(`${j.space}/${ym}/${dd}/${n}`);
    const learned = (j.learned ?? []).map(link).filter(Boolean);
    files.push({
      path: `${spaceLabel(j.space)}/일 기록/${ym}/${dd}/${n}.md`,
      text: [
        "---",
        `job: ${j.taskId}`,
        `at: ${new Date(j.at).toISOString().slice(0, 16).replace("T", " ")}`,
        `outcome: ${j.outcome}`,
        ...(j.project ? [`project: ${fm(j.project.replace(/^\/Users\/[^/]+/, "~"))}`] : []),
        "---",
        "",
        `# ${j.title}`,
        "",
        j.ask,
        "",
        j.text,
        ...(learned.length ? ["", `배운 것: ${learned.join(" ")}`] : []),
        "",
      ].join("\n"),
    });
  }
  // 지금: what was last going on in each project
  for (const [folder, n] of Object.entries(state.memoryNow ?? {}))
    files.push({ path: `${folderHome(folder)}/지금.md`, text: [`# 지금 · ${base(folder)}`, "", n.text, "", `${new Date(n.at).toISOString().slice(0, 16).replace("T", " ")} · 일 ${n.taskId}`, ""].join("\n") });
  return files;
}

/**
 * Where each part goes: a space with its own folder keeps its pieces in
 * `<space folder>/.ondra/memory` (회사/규칙/x.md → 규칙/x.md, 회사/회사.md → 목차.md);
 * 모든 일, spaces without a folder, the whole 목차 and git versions stay in the app's folder.
 */
export function mirrorPlan(): { space?: string; files: { path: string; text: string; once?: boolean }[] }[] {
  const all = mirrorFiles();
  const roots = state.spaces
    .filter((sp) => sp.folder && sp.folder !== "~" && sp.folder !== "/")
    .map((sp) => ({ label: safe(sp.label), dir: expand(sp.folder).replace(/\/$/, "") }));
  const app: { path: string; text: string; once?: boolean }[] = [];
  const out = new Map<string, { path: string; text: string; once?: boolean }[]>();
  for (const f of all) {
    const r = roots.find((x) => f.path.startsWith(`${x.label}/`));
    if (!r) {
      app.push(f);
      continue;
    }
    const rest = f.path.slice(r.label.length + 1);
    const list = out.get(r.dir) ?? [];
    list.push({ ...f, path: rest === `${r.label}.md` ? "목차.md" : rest });
    out.set(r.dir, list);
  }
  return [{ files: app }, ...[...out].map(([space, files]) => ({ space, files }))];
}

createRoot(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (!loaded() || location.search.includes("fixture")) return;
    const plan = mirrorPlan();
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const p of plan) void memoryMirror(p.files, p.space).catch(() => {});
    }, 1200);
  });
});
