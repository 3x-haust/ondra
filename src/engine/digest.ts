// What came of a finished job, written for the user by one small model call. A job's closing
// words are not always its result: a job sent back by the finishing gate ends on "네 명령을 다시
// 돌렸고 결과는 처음과 같아요" (Hologram, Nov 16), and its done line can list the steps
// ("원리 분석, 불가 확인, 방안 정리") instead of saying what was found. The digest reads
// everything the job told the user since they last asked and says the outcome first.
import type { Block, Task } from "../state/types";
import { taskById, updateTask } from "../state/store";
import { notTheUser } from "./prompts";
import { oneShot } from "./aside";
import { keepDigest } from "./results";

const MAX_IN = 12_000;

/** A card the user answered ('"질문" → 답') is part of the work, not a new ask. */
const answered = (text: string) => /^"[^\n]*" → /.test(text);

/** A block as plain words, for the ones that carry a result. */
function blockWords(b: Block): string {
  const x = b as unknown as { type: string; columns?: string[]; rows?: unknown[][]; items?: { label?: string; done?: boolean }[]; text?: string; title?: string };
  if (x.type === "table" && x.rows) return [x.columns?.join(" | ") ?? "", ...x.rows.map((r) => r.map(String).join(" | "))].join("\n");
  if (x.type === "checklist" && x.items) return x.items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.label ?? ""}`).join("\n");
  return "";
}

/** The user's last ask, and what the job told them since (its words and result tables), oldest first. */
export function digestInput(t: Task): { ask: string; words: string } | undefined {
  const e = t.entries;
  let from = -1;
  for (let i = e.length - 1; i >= 0; i--) {
    const x = e[i];
    if (x.kind === "user" && !notTheUser(x.text) && !answered(x.text)) { from = i; break; }
  }
  const ask = from >= 0 && e[from].kind === "user" ? (e[from] as { text: string }).text : t.ask;
  const parts = e.slice(from + 1).flatMap((x) => {
    if (x.kind === "text") return [x.text.replace(/```blocks[\s\S]*?```/g, "").trim()];
    if (x.kind === "block") return [blockWords(x.block)];
    return [];
  }).filter(Boolean);
  if (t.summary) parts.push(`(done: ${t.summary})`);
  const words = parts.join("\n\n");
  if (!words.trim()) return undefined;
  return { ask: ask.slice(0, 2000), words: words.length > MAX_IN ? words.slice(-MAX_IN) : words };
}

const korean = (s: string) => /[가-힣]/.test(s);

export function digestPrompt(input: { ask: string; words: string }): string {
  const ko = korean(input.ask);
  return `An agent job just finished work for the user. Below is the user's request and everything the job told them since, in order. Write what came of it for the user, in ${ko ? 'Korean, in a soft polite tone ("~요")' : "the language of the request"}.
- First line: the outcome in one sentence: the answer, the conclusion, or what now works. Not the steps taken.
- Then 1–4 short lines, each starting with "- ": what the user needs to know (the key findings, what changed, what is left or unverified).
- Leave out how the job checked, re-ran or proved things, retries, and anything it was told to fix before finishing.
- Only what the job's words say; never add facts. Plain text: no headings, no code fences, no bold.

# Request
${input.ask}

# What the job told the user
${input.words}`;
}

/** The model's answer as a line and the lines under it. */
export function parseDigest(raw: string): { line: string; text: string } | undefined {
  const lines = raw.replace(/```[\s\S]*?```/g, "").split("\n").map((l) => l.replace(/\*\*/g, "").trimEnd()).filter((l) => l.trim());
  const line = lines[0]?.replace(/^[#>\-\s]+/, "").trim();
  if (!line) return undefined;
  return { line: line.length > 200 ? `${line.slice(0, 199)}…` : line, text: lines.slice(1).join("\n").trim() };
}

const running = new Set<string>();

/** Write the digest of a job that just finished (a top-level job of this Mac). */
export async function digestJob(t: Task): Promise<void> {
  if (t.status !== "done" || t.parentId || t.answer || t.host || running.has(t.id)) return;
  const input = digestInput(t);
  if (!input) return;
  const at = t.finishedAt;
  running.add(t.id);
  try {
    const d = parseDigest(await oneShot(t.space, t.cwd || "~", digestPrompt(input)));
    const now = taskById(t.id);
    // reopened or run again meanwhile: this digest is of an earlier finish
    if (!d || !now || now.status !== "done" || now.finishedAt !== at) return;
    updateTask(t.id, (x) => void (x.digest = { ...d, at: Date.now() }));
    keepDigest(t.id, d);
  } catch {
    // no model now (offline, signed out): the job's own words stay as they are
  } finally {
    running.delete(t.id);
  }
}
