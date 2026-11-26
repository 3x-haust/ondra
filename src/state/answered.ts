// A question answered, as a thread stores it.

/** An answered question as the task stores it (`"question" → answer`), or undefined for any other message. */
export function answerOf(text: string): { q: string; a: string } | undefined {
  const m = text.match(/^"([\s\S]+?)" → ([\s\S]+)$/);
  return m ? { q: m[1].trim(), a: m[2].trim() } : undefined;
}
