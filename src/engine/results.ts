// Results: what a finished job came back with (its own words and result blocks,
// plus anything main added), kept on their own. The chat moves on and can be
// reset; a result stays findable here even after its job is gone. Results from
// before jobs kept their own are main's report on the job.
import { setState, state } from "../state/store";
import type { Block, CaptainMessage, ResultEntry, SpaceId, Task } from "../state/types";

const MAX = 500;

/** Where a job's latest report starts: after the last thing it was given (a card it asked and got answered is part of that work). */
export function sinceAsked(t: Task): number {
  const answered = (e: Task["entries"][number]) => e.kind === "user" && /^"[^\n]*" → /.test(e.text);
  for (let i = t.entries.length - 1; i >= 0; i--) if (t.entries[i].kind === "user" && !answered(t.entries[i])) return i + 1;
  return 0;
}

/** What a job reported since it was last given work: its words and its result blocks. */
export function jobReport(t: Task): { said: string; blocks: Block[] } {
  const since = t.entries.slice(sinceAsked(t));
  const said = since
    .filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text.replace(/```blocks[\s\S]*?```/g, "").trim())
    .filter(Boolean)
    .join("\n\n");
  const blocks = since.flatMap((e) => (e.kind === "block" ? [e.block] : []));
  return { said, blocks };
}

/** The screenshot a job's report ends with, if it left one (for a small picture beside its line). */
export function jobShot(t: Task): string | undefined {
  const { blocks } = jobReport(t);
  for (const b of [...blocks].reverse()) {
    const x = b as unknown as { type: string; path?: string; afterImage?: string; items?: { kind: string; ref: string; ok?: boolean }[] };
    if (x.type === "shot" && x.path) return x.path;
    if (x.type === "beforeAfter" && x.afterImage) return x.afterImage;
    if (x.type === "evidence") {
      const s = (x.items ?? []).find((i) => i.kind === "shot" && i.ref && i.ok !== false);
      if (s) return s.ref;
    }
  }
  return undefined;
}

const jobEntryId = (t: Task) => `res-${t.id}-${t.finishedAt ?? 0}`;

/**
 * Keep a finished job's result as the job itself reported it: its one line, its words
 * and its result blocks. Each time it finishes is its own entry (asked again, it
 * reports again). `msg`: the chat message that shows it.
 */
export function keepJobResult(t: Task, msg?: string) {
  if (t.status !== "done" || t.parentId || t.answer) return;
  const id = jobEntryId(t);
  if ((state.results ?? []).some((r) => r.id === id)) return;
  const { said, blocks } = jobReport(t);
  if (!t.summary?.trim() && !said && !blocks.length) return;
  const e: ResultEntry = { id, taskId: t.id, space: t.space, project: t.project, title: t.title, reply: t.summary?.trim() || undefined, answers: said || blocks.length ? [{ text: said, blocks }] : [], at: t.finishedAt ?? Date.now(), msg };
  setState("results", (l) => [...(l ?? []), e].slice(-MAX));
}

/** The latest result of a job, if it has one. */
export const resultOfTask = (taskId: string) => [...(state.results ?? [])].reverse().find((r) => r.taskId === taskId);

const answersOf = (m: CaptainMessage) => (m.routes ?? []).flatMap((r) => (r.kind === "answer" && (r.text.trim() || r.blocks.length) ? [{ text: r.text, blocks: r.blocks }] : []));

function entryOf(m: CaptainMessage): ResultEntry | undefined {
  const t = m.after ? state.tasks.find((x) => x.id === m.after) : undefined;
  if (!t || t.status !== "done" || t.parentId || m.pending || m.error) return undefined;
  const answers = answersOf(m);
  if (!m.reply?.trim() && !answers.length) return undefined;
  return { id: m.id, taskId: t.id, space: m.space, project: m.project, title: t.title, reply: m.reply, answers, at: m.at };
}

/**
 * Main reacted to a job's end. The job's own result is already kept: what main
 * added (a line, an answer to the user's question) joins it, and the entry then
 * points at that message. Without a job result (one that finished with nothing to
 * keep), main's words are the entry, as before.
 */
export function keepResult(id: string) {
  const m = state.captain.find((x) => x.id === id);
  const t = m?.after ? state.tasks.find((x) => x.id === m.after) : undefined;
  if (!m || !t) return;
  const own = (state.results ?? []).find((r) => r.id === jobEntryId(t));
  if (own) {
    const answers = answersOf(m);
    const line = m.reply?.trim();
    if (!answers.length && !line) return;
    setState("results", (r) => r.id === own.id, (r) => ({ ...r, msg: m.id, answers: [...r.answers, ...(line ? [{ text: line, blocks: [] }] : []), ...answers] }));
    return;
  }
  const e = entryOf(m);
  if (!e) return;
  setState("results", (l) => [...(l ?? []).filter((r) => r.id !== e.id), e].slice(-MAX));
}

/** Once: the reports already in the chats. */
export function backfillResults() {
  if (state.results) return;
  const list = state.captain.flatMap((m) => (m.after ? [entryOf(m)] : [])).filter((e): e is ResultEntry => !!e);
  setState("results", list.slice(-MAX));
}

export const resultsIn = (space: SpaceId) => (state.results ?? []).filter((r) => r.space === space).slice().reverse();

/** Plain text of a result, for search. */
export const resultText = (r: ResultEntry) =>
  [r.title, r.reply ?? "", ...r.answers.map((a) => [a.text, ...a.blocks.map((b) => JSON.stringify(b))].join(" "))].join(" ");

/** Take results out of the list; returns them so they can be put back. */
export function removeResults(ids: string[]): ResultEntry[] {
  const drop = new Set(ids);
  const gone = (state.results ?? []).filter((r) => drop.has(r.id));
  if (gone.length) setState("results", (l) => (l ?? []).filter((r) => !drop.has(r.id)));
  return gone;
}

/** Put removed results back where they were (by time). */
export function restoreResults(list: ResultEntry[]) {
  if (!list.length) return;
  const have = new Set((state.results ?? []).map((r) => r.id));
  setState("results", (l) => [...(l ?? []), ...list.filter((r) => !have.has(r.id))].sort((a, b) => a.at - b.at).slice(-MAX));
}

export function pinResult(id: string, on: boolean) {
  setState("results", (r) => r.id === id, "pinned", on || undefined);
}

/** The report as one plain line, for the list. */
export const resultPreview = (r: ResultEntry) =>
  [r.reply ?? "", ...r.answers.map((a) => a.text)]
    .map((t) => t.replace(/^\s*(?:[-•*]|\d+\.)\s+/gm, ""))
    .join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Everything in a result as text, to copy. */
export const resultCopy = (r: ResultEntry) => [r.title, r.reply ?? "", ...r.answers.map((a) => a.text)].filter((s) => s.trim()).join("\n\n");
