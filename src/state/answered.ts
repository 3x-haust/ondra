// The quiet "✓ 작업 · 답" lines in the main chat: questions its jobs asked that were answered.
import type { Task } from "./types";

/** An answered question as the task stores it (`"question" → answer`), or undefined for any other message. */
export function answerOf(text: string): { q: string; a: string } | undefined {
  const m = text.match(/^"([\s\S]+?)" → ([\s\S]+)$/);
  return m ? { q: m[1].trim(), a: m[2].trim() } : undefined;
}

/** A task's question answered (in Main or in the task), as Main shows it afterwards. */
export type Answered = { id: string; at: number; taskId: string; q: string; a: string };
const seen = new Map<string, Answered>();

/**
 * The answers to show: the workspace's jobs (not the Discord agent's), and nothing from before
 * the chat was last cleared (`after`): the lines come from the jobs' own threads, so clearing
 * the chat's messages alone would leave them.
 */
export function answeredIn(tasks: Task[], o: { after: number }): Answered[] {
  const out: Answered[] = [];
  for (const t of tasks) {
    if (t.agent) continue;
    for (const e of t.entries) {
      if (e.kind !== "user" || e.at <= o.after) continue;
      const a = answerOf(e.text);
      if (!a) continue;
      let x = seen.get(e.id);
      if (!x || x.a !== a.a) seen.set(e.id, (x = { id: e.id, at: e.at, taskId: t.id, ...a }));
      out.push(x);
    }
  }
  return out;
}
