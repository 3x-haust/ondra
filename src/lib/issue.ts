// A feedback issue: the user's words, where it happened, and the log's newest lines in a fold.
import { redact } from "./log";

/** The issue: the words, where it happened, and the log's newest lines in a fold. */
export function issueBody(text: string, o: { version: string; where: string; os: string; logs?: string }, max = 60_000): string {
  const head = [redact(text.trim()), "", "---", `- Ondra ${o.version || "?"}`, `- ${o.os}`, `- ${o.where}`].join("\n");
  if (!o.logs?.trim()) return head;
  const room = Math.max(0, max - head.length - 120);
  const lines = o.logs.trim().split("\n");
  let tail = lines.join("\n");
  while (tail.length > room && lines.length) (lines.shift(), (tail = lines.join("\n")));
  return `${head}\n\n<details><summary>log (${lines.length})</summary>\n\n\`\`\`\n${tail}\n\`\`\`\n</details>\n`;
}
export const issueTitle = (text: string) => {
  const first = redact(text.trim().split("\n")[0] ?? "").trim();
  return first.length > 70 ? `${first.slice(0, 69)}…` : first || "Feedback";
};
