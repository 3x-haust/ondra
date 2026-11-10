// Project notes: one working document per project — where it stands, what is left, what was decided and
// why, where things are. A job in the project reads it when it starts and rewrites it when it moved the
// project on, so the next job starts from where the last one left off instead of finding it all again.
// Memory keeps lasting facts, a line each; the notes keep the state, which changes with every job.
import { createSignal } from "solid-js";
import { engine } from "./rpc";
import { ensureDir, fsRead, fsWrite, inTauri } from "../lib/native";

export const notesPath = (projectId: string) => `${engine.info.dataDir}/notes/${projectId}.md`;

/** bumped on every write: views showing the notes read them again */
const [version, setVersion] = createSignal(0);
export const notesVersion = version;

export async function readNotes(projectId: string): Promise<string> {
  if (!inTauri) return "";
  try {
    const r = await fsRead(notesPath(projectId));
    return r.binary ? "" : (r.text ?? "").trim();
  } catch {
    return "";
  }
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20) : []);

export type NotesBlock = { state?: unknown; todo?: unknown; decisions?: unknown; where?: unknown };

/** The notes as Markdown, from a job's {"type":"notes"} block; undefined when it says nothing. */
export function notesMarkdown(project: string, by: string, b: NotesBlock, at = new Date()): string | undefined {
  const state = String(b.state ?? "").trim();
  const todo = list(b.todo);
  const decisions = list(b.decisions);
  const where = list(b.where);
  if (!state && !todo.length && !decisions.length && !where.length) return undefined;
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const out = [`# ${project}`, "", `${day} · ${by}`];
  if (state) out.push("", "## 지금", state);
  if (todo.length) out.push("", "## 남은 일", ...todo.map((x) => `- ${x}`));
  if (decisions.length) out.push("", "## 정한 것", ...decisions.map((x) => `- ${x}`));
  if (where.length) out.push("", "## 위치", ...where.map((x) => `- ${x}`));
  return `${out.join("\n")}\n`;
}

export async function writeNotes(projectId: string, text: string): Promise<boolean> {
  if (!inTauri) return false;
  try {
    await ensureDir(`${engine.info.dataDir}/notes`);
    await fsWrite(notesPath(projectId), text);
    setVersion((v) => v + 1);
    return true;
  } catch {
    return false;
  }
}

/** What a job in the project is given: the notes as they are, and how to leave them for the next one. */
export function notesPrompt(project: string, text: string): string {
  return [
    `# Project notes: ${project}`,
    text ? text.slice(0, 8000) : "(none yet: this is the first job to leave them)",
    "",
    "These are the project's working notes, left by the jobs before you. Start from them instead of finding it all again; what you see in the code outranks them.",
    'When your work moved the project on (built, fixed, decided or found something the next job needs), send the notes rewritten whole, in the user\'s language, before your final answer: {"type":"notes","state":"where the project stands now, 1–3 sentences","todo":["what is left, most important first"],"decisions":["what was decided, and why"],"where":["path or URL — what it is"]}.',
    "Keep only what the next job needs (under 40 lines in all): drop items that are done or no longer true, no history of this session. A question answered or a look around that changed nothing: no notes block.",
  ].join("\n");
}
