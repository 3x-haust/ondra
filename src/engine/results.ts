// Results: what main said when a job finished, kept on their own. The chat moves
// on and can be reset; a result stays findable here even after its job is gone.
import { setState, state } from "../state/store";
import type { CaptainMessage, ResultEntry, SpaceId } from "../state/types";

const MAX = 500;

function entryOf(m: CaptainMessage): ResultEntry | undefined {
  const t = m.after ? state.tasks.find((x) => x.id === m.after) : undefined;
  if (!t || t.status !== "done" || t.parentId || m.pending || m.error) return undefined;
  const answers = (m.routes ?? []).flatMap((r) => (r.kind === "answer" && (r.text.trim() || r.blocks.length) ? [{ text: r.text, blocks: r.blocks }] : []));
  if (!m.reply?.trim() && !answers.length) return undefined;
  return { id: m.id, taskId: t.id, space: m.space, project: m.project, title: t.title, reply: m.reply, answers, at: m.at };
}

/** Keep main's report on a finished job (a later report on the same job is kept too). */
export function keepResult(id: string) {
  const m = state.captain.find((x) => x.id === id);
  const e = m && entryOf(m);
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
