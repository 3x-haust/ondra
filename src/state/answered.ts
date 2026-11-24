// The quiet "✓ 작업 · 답" lines in the main chat: questions its jobs asked that were answered.
import { untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import type { Entry, Task } from "./types";

/** An answered question as the task stores it (`"question" → answer`), or undefined for any other message. */
export function answerOf(text: string): { q: string; a: string } | undefined {
  const m = text.match(/^"([\s\S]+?)" → ([\s\S]+)$/);
  return m ? { q: m[1].trim(), a: m[2].trim() } : undefined;
}

/** A task's question answered (in Main or in the task), as Main shows it afterwards. */
export type Answered = { id: string; at: number; taskId: string; q: string; a: string };
const seen = new Map<string, Answered>();

/** each transcript's answers, as last read: a line added is read alone, not the whole transcript again */
const read = new WeakMap<Entry[], { first?: string; n: number; list: Answered[] }>();
/** a task's answered questions, oldest first (only the lines added since the last look are read) */
function answersOf(t: Task): Answered[] {
  const es = t.entries;
  // what this depends on: lines coming and going, not each line's contents (a user line is never streamed)
  const n = es.length;
  const first = es[0]?.id;
  return untrack(() => {
    const raw = unwrap(es);
    let c = read.get(raw);
    if (!c || c.first !== first || c.n > n) read.set(raw, (c = { first, n: 0, list: [] }));
    for (let i = c.n; i < n; i++) {
      const e = raw[i];
      if (e.kind !== "user") continue;
      const a = answerOf(e.text);
      if (!a) continue;
      let x = seen.get(e.id);
      if (!x || x.a !== a.a) seen.set(e.id, (x = { id: e.id, at: e.at, taskId: t.id, ...a }));
      c.list.push(x);
    }
    c.n = n;
    return c.list;
  });
}

/**
 * The answers to show: the workspace's jobs (not the Discord agent's), and nothing from before
 * the chat was last cleared (`after`): the lines come from the jobs' own threads, so clearing
 * the chat's messages alone would leave them.
 */
export function answeredIn(tasks: readonly Task[], o: { after: number }): Answered[] {
  const out: Answered[] = [];
  for (const t of tasks) {
    if (t.agent) continue;
    for (const x of answersOf(t)) if (x.at > o.after) out.push(x);
  }
  return out;
}
