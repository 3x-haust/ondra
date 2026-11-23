// The quiet "✓ 작업 · 답" lines in the root main chat: questions its jobs asked that were answered.
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
 * The answers to show: only the root chat's own jobs (a job filed under a project shows in that
 * project's chat; one whose project is gone counts as the root's), not subagents or the Discord
 * agent's, and nothing from before the chat was last cleared (`after`).
 */
export function answeredIn(tasks: Task[], o: { filed: Set<string>; after: number }): Answered[] {
  const out: Answered[] = [];
  for (const t of tasks) {
    if (t.parentId || t.agent || (t.project && o.filed.has(t.project))) continue;
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
