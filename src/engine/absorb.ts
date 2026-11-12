// Whatever memory setup a folder already has, Ondra keeps it one way. Notes other
// tools leave in a space or project folder — Work-style context/ (now, rules,
// log, projects), Cline memory-bank/, Cursor / Windsurf / Cline rules, Copilot
// and Gemini instructions — are read once (and again when they change), and what
// lasts is filed as memory pieces: rules, preferences, decisions, facts,
// procedures, lessons. Status tables and dated logs are not memory; only what
// they teach is kept. The files themselves are left as they are (other tools may
// still read them). Claude Code's own memory for the folder is read the same way.
// AGENTS.md / CLAUDE.md are not absorbed: the engine reads them.
import { createSignal } from "solid-js";
import { memorySources } from "../lib/native";
import { projectsIn, setState, state } from "../state/store";
import { memorySentence } from "../i18n";
import type { MemoryKind, SpaceId } from "../state/types";
import { oneShot } from "./aside";
import { readFences } from "./fences";
import { addMemory, KINDS } from "./memory";
import { expand, tilde } from "./rpc";

const KIND_IDS = new Set<MemoryKind>(KINDS.map((k) => k.id));
const CHUNK = 18_000;

export interface Note {
  path: string;
  text: string;
  hash: string;
  space: SpaceId;
  /** project folder ("~/…") when the file sits in a project */
  project?: string;
}

const hash = (t: string) => {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return `${t.length}:${(h >>> 0).toString(36)}`;
};

const [pending, setPending] = createSignal<Note[]>([]);
const [busy, setBusy] = createSignal(false);
export const notesPending = pending;
export const absorbing = busy;

/** Note files in every space and project folder not yet brought in (or changed since). */
export async function findNotes(): Promise<Note[]> {
  const out: Note[] = [];
  const seen = new Set<string>();
  const look = async (folder: string, space: SpaceId, project?: string) => {
    if (!folder || folder === "~") return;
    for (const f of await memorySources(expand(folder)).catch(() => [])) {
      const h = hash(f.text);
      // the same note can sit in two places (e.g. two Claude Code config folders): read it once
      if (seen.has(f.path) || seen.has(h)) continue;
      seen.add(f.path);
      seen.add(h);
      if (state.absorbed?.[f.path] !== h) out.push({ path: f.path, text: f.text, hash: h, space, project });
    }
  };
  // projects first: a file inside a project folder belongs to that project
  for (const s of state.spaces) for (const p of projectsIn(s.id)) await look(p.folder, s.id, p.folder);
  for (const s of state.spaces) await look(s.folder, s.id);
  setPending(out);
  return out;
}

/** a long file in parts, cut at headings or blank lines; very long logs keep the newest part */
function parts(text: string): string[] {
  const t = text.length > CHUNK * 4 ? text.slice(-CHUNK * 4) : text;
  const out: string[] = [];
  let cur = "";
  for (const block of t.split(/\n(?=#{1,3} |\n)/)) {
    if (cur.length + block.length > CHUNK && cur) (out.push(cur), (cur = ""));
    cur += (cur ? "\n" : "") + block;
    while (cur.length > CHUNK) out.push(cur.slice(0, CHUNK)), (cur = cur.slice(CHUNK));
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const ask = (n: Note, part: string, i: number, total: number) =>
  [
    `A file another tool kept as memory/rules for an AI coding agent: ${tilde(n.path)}${total > 1 ? ` (part ${i + 1} of ${total})` : ""}.`,
    `Turn what LASTS into small memory pieces for the ${n.project ? `project ${tilde(n.project)}` : "workspace"}. One idea per piece, ${memorySentence()}, max ~200 chars; name the repo/tool in the sentence when it is specific.`,
    "Kinds: rule (must/never), preference (how the user likes things), decision (X over Y), fact (stable: what a repo is, its stack, where things live), procedure (how to do a recurring task), lesson (a pitfall and how to avoid it).",
    "Skip: status tables, today's progress, open questions, dated one-off log lines (but keep a lesson/decision a log teaches), instructions about maintaining this file itself, and anything superseded later in the text.",
    "Never copy secrets (tokens, passwords, keys, connection strings); keep only the rule around them.",
    "pin=true only for rules that must apply to every job (safety, git/commit rules, secrets, language). importance 1-5. about: 0-3 named things. keys: 3-6 related search words (Korean and English).",
    'Reply with only a fenced block (an empty list is fine):\n```pieces\n[{"text":"...","kind":"rule","pin":false,"importance":3,"about":["..."],"keys":["..."]}]\n```',
    "",
    "----- file -----",
    part,
  ].join("\n");

const strs = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && !!x.trim() && x.length <= 32).map((x) => x.trim()).slice(0, max);

/** Bring the given notes in (all pending ones by default). Returns pieces added. */
export async function absorbNotes(list?: Note[]): Promise<number> {
  if (busy()) return 0;
  const notes = list ?? (await findNotes());
  if (!notes.length) return 0;
  setBusy(true);
  let added = 0;
  try {
    for (const n of notes) {
      const chunks = parts(n.text);
      let ok = true;
      for (const [i, part] of chunks.entries()) {
        try {
          const raw = await oneShot(n.space, n.project ?? state.spaces.find((s) => s.id === n.space)?.folder ?? "~", ask(n, part, i, chunks.length));
          for (const p of (readFences(raw, "pieces").items.flat() as Record<string, unknown>[]) ?? []) {
            const text = typeof p?.text === "string" ? p.text.trim() : "";
            if (!text || text.length > 300) continue;
            const before = state.memory.length;
            addMemory(text, n.project ? "project" : "space", {
              space: n.space,
              project: n.project,
              kind: KIND_IDS.has(p.kind as MemoryKind) ? (p.kind as MemoryKind) : undefined,
              pinned: p.pin === true,
              importance: typeof p.importance === "number" ? Math.min(5, Math.max(1, Math.round(p.importance))) : undefined,
              about: strs(p.about, 3),
              keys: strs(p.keys, 6),
              from: n.path,
              // the user's own notes: automation won't rewrite them later
              by: "user",
              quiet: true,
            });
            added += state.memory.length - before;
          }
        } catch {
          ok = false;
        }
      }
      // read once: a file is only read again when it changes
      if (ok) setState("absorbed", (a) => ({ ...(a ?? {}), [n.path]: n.hash }));
    }
  } finally {
    setBusy(false);
    void findNotes();
  }
  return added;
}
