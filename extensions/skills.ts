// Skill metadata stays in this process; only search matches reach the model.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadSkills, parseFrontmatter, stripFrontmatter, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const words = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * How well a term names a skill: its name (8 exact, 4 part), a word of its
 * description (3; also a Korean word with a particle on it, "바이너리를"), or
 * any part of the description (1).
 */
function termScore(term: string, name: string, description: string, own: Set<string>): number {
  const inName = name === term ? 8 : name.includes(term) ? 4 : 0;
  const word = own.has(term) || [...own].some((w) => w.length >= 2 && term.length - w.length <= 3 && term.startsWith(w)) ? 3 : 0;
  return inName + (word || (term.length >= 2 && description.includes(term) ? 1 : 0));
}

/** Skills ranked for a query. A term that fits many skills counts for less than one that fits a few. */
function rank(skills: Skill[], query: string) {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const pool = skills
    .filter((s) => !s.disableModelInvocation)
    .map((skill) => {
      const name = skill.name.toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const own = new Set(words(description));
      return { skill, hits: terms.map((t) => termScore(t, name, description, own)) };
    });
  const df = terms.map((_, i) => pool.filter((p) => p.hits[i] > 0).length);
  return pool
    .map(({ skill, hits }) => ({
      skill,
      score: hits.reduce((n, h, i) => n + (h ? h * Math.log(1 + pool.length / df[i]) : 0), 0),
      strong: hits.filter((h) => h >= 3).length,
      // a word only this skill has ("컴퓨터유즈", "시뮬레이터") says enough on its own
      unique: hits.some((h, i) => h >= 3 && df[i] === 1 && terms[i].length >= 3),
      named: hits.some((h) => h >= 4),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
}

const brief = (s: Skill) => ({ name: s.name, description: s.description.slice(0, 1024), path: s.filePath, baseDir: s.baseDir });

export function searchSkills(skills: Skill[], query: string, limit = 5) {
  return rank(skills, query)
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map(({ skill }) => brief(skill));
}

/** The task's own words in a job's first message (a fresh one or a new session's): its title and the ask. */
export function taskQuery(prompt: string): string | undefined {
  const lines = prompt.split("\n");
  const head = lines[0]?.match(/^# (?:Sub-)?[Tt]ask: (.*?)(?: \(session \d+\))?$/);
  if (!head) return;
  const original = lines.indexOf("# Original task");
  let i = original >= 0 ? original + 1 : lines.indexOf("") + 1;
  const ask: string[] = [];
  for (; i > 0 && i < lines.length && !lines[i].startsWith("# "); i++) ask.push(lines[i]);
  return `${head[1]}\n${ask.join("\n")}`.slice(0, 4000);
}

/** skill_search run on the task itself: the skills that clearly fit, for the job's first turn (or "" when none do). */
export function skillHint(skills: Skill[], query: string, limit = 3): string {
  const fit = rank(skills, query).filter((r) => r.named || r.unique || r.strong >= 2).slice(0, limit);
  if (!fit.length) return "";
  return [
    "# Skills for this task (skill_search on the task)",
    ...fit.map(({ skill }) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").slice(0, 200)} (${skill.filePath})`),
    "Read the SKILL.md of each one that fits before you act, and follow it. Search again when the work moves to another domain.",
  ].join("\n");
}

/**
 * The user's own words in a message, for matching skills: without the context
 * main's turn carries above "# Message", and empty for a note the app sends by
 * itself (a restart, a check before done, a review's findings, a fork that ended),
 * whose stock words ("plan", "test", "review") would offer skills the work never asked for.
 */
export function userWords(prompt: string): string {
  const message = prompt.lastIndexOf("\n# Message\n");
  if (message >= 0) return prompt.slice(message + "\n# Message\n".length);
  if (/^# .*\(not a user message\)$/m.test(prompt)) return "";
  // a routine's run: what to do is under "## 할 일" (src/engine/routines.ts runMessage)
  if (prompt.startsWith("(Ondra) 루틴")) {
    const todo = prompt.indexOf("## 할 일\n");
    return todo >= 0 ? prompt.slice(todo + "## 할 일\n".length) : "";
  }
  // another job's message: its words after the note (src/engine/jobs.ts fromJob)
  if (prompt.startsWith("(Ondra) A message from another job")) return prompt.slice(prompt.indexOf("\n\n") + 2 || prompt.length);
  // the app's own notes: "(Ondra…" (tasks.ts, captain.ts, handoff.ts), the check before done (tasks.ts),
  // review and subagent results (crosscheck.ts CROSSCHECK, PLAN_REVIEW; tasks.ts resultHead)
  if (/^(\(Ondra|끝내기 전에 빠진 게 있어요|교차 검토|계획 검토|리뷰 결과가 왔어요|서브에이전트 ")/.test(prompt)) return "";
  return prompt;
}

// ───────────── the router: offer a skill when the work enters its domain
//
// Besides the words of each user message, a skill can name what the work looks
// like in its domain, as frontmatter metadata (each value one regular expression):
//   metadata:
//     ondra-commands: '\bondra-browser\b'      a shell command it runs
//     ondra-writes: '\.github/workflows/'        a file it edits or writes
//     ondra-reads: '\.xcodeproj/'                a file it reads
//     ondra-urls: 'figma\.com/(design|file)'     a link in a message or a fetch
//     ondra-tools: 'computer,device'             a tool it calls
// The first time one matches, the tool's result says which skill fits and
// where it is. A skill already read is never offered again until the
// conversation is compacted.

export interface Triggers {
  commands?: RegExp;
  writes?: RegExp;
  reads?: RegExp;
  urls?: RegExp;
  tools?: string[];
}

const regex = (v: unknown) => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  try {
    return new RegExp(v, "i");
  } catch {
    return undefined;
  }
};

/** A skill's triggers from its frontmatter metadata (unknown or broken values are skipped). */
export function triggersOf(front: Record<string, unknown>): Triggers {
  const m = (front.metadata ?? {}) as Record<string, unknown>;
  const tools = typeof m["ondra-tools"] === "string" ? (m["ondra-tools"] as string).split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  return { commands: regex(m["ondra-commands"]), writes: regex(m["ondra-writes"]), reads: regex(m["ondra-reads"]), urls: regex(m["ondra-urls"]), tools };
}

const URL_RE = /https?:\/\/[^\s)>\]"']+/g;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Why a tool call puts the work in a skill's domain, or undefined. */
export function toolMatch(t: Triggers, tool: string, input: Record<string, unknown>): string | undefined {
  if (t.tools?.includes(tool)) return `uses ${tool}`;
  const path = str(input.path) || str(input.file_path);
  if (tool === "bash" && t.commands?.test(str(input.command))) return "runs a command of its domain";
  if ((tool === "edit" || tool === "write") && path && t.writes?.test(path)) return `edits ${path}`;
  if (tool === "read" && path && t.reads?.test(path)) return `reads ${path}`;
  const url = str(input.url) || (tool === "bash" ? ((str(input.command).match(URL_RE) ?? [])[0] ?? "") : "");
  if (url && t.urls?.test(url)) return `opens ${url}`;
  return undefined;
}

export class SkillRouter {
  /** skills whose SKILL.md this conversation has read */
  readonly loaded = new Set<string>();
  /** skills already pointed out, by words or by tool */
  private saidWords = new Set<string>();
  private saidTool = new Set<string>();
  constructor(
    readonly skills: Skill[],
    readonly triggers: Map<string, Triggers>,
  ) {}

  private usable = () => this.skills.filter((s) => !s.disableModelInvocation);

  /** a new conversation, or one compacted: what was read may be gone */
  reset() {
    this.loaded.clear();
    this.saidWords.clear();
    this.saidTool.clear();
  }

  /** The model read a file: if it is a skill, that skill is in context now. */
  noteRead(path: string) {
    const s = this.skills.find((x) => x.filePath === path || path.endsWith(`/${x.name}/SKILL.md`));
    if (s) this.loaded.add(s.name);
  }

  /** Skills that fit a user message: by a link it carries, and by its words. */
  forMessage(text: string, limit = 3): Skill[] {
    const out: Skill[] = [];
    const urls = text.match(URL_RE) ?? [];
    for (const s of this.usable()) if (urls.some((u) => this.triggers.get(s.name)?.urls?.test(u))) out.push(s);
    for (const { skill } of rank(this.usable(), text).filter((r) => r.named || r.unique || r.strong >= 2)) if (!out.includes(skill)) out.push(skill);
    const fresh = out.filter((s) => !this.loaded.has(s.name) && !this.saidWords.has(s.name)).slice(0, limit);
    for (const s of fresh) this.saidWords.add(s.name);
    return fresh;
  }

  /** The skill a tool call steps into, once per skill, if it isn't read yet. */
  forTool(tool: string, input: Record<string, unknown>): { skill: Skill; why: string } | undefined {
    if (tool === "read") this.noteRead(str(input.path) || str(input.file_path));
    for (const s of this.usable()) {
      if (this.loaded.has(s.name) || this.saidTool.has(s.name)) continue;
      const t = this.triggers.get(s.name);
      const why = t && toolMatch(t, tool, input);
      if (why) {
        this.saidTool.add(s.name);
        return { skill: s, why };
      }
    }
    return undefined;
  }
}

const line = (s: Skill) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 200)} (${s.filePath})`;

/** The hidden note for a user message's skills. */
export function messageHint(fit: Skill[], first: boolean): string {
  if (!fit.length) return "";
  return [
    first ? "# Skills for this task (skill_search on the task)" : "# Skills for this message",
    ...fit.map(line),
    "Read the SKILL.md of each one that fits before you act, and follow it. Search again when the work moves to another domain.",
  ].join("\n");
}

/** The note added to a tool's result when the work steps into a skill's domain. */
export const toolHint = (s: Skill, why: string) =>
  `\n[skill] This step ${why}, which is ${s.name}'s domain: ${s.description.replace(/\s+/g, " ").slice(0, 160)}\nRead ${s.filePath} and follow it before going on, unless you already have.`;

/** where a project keeps skills of its own, for any agent */
export const PROJECT_SKILL_DIRS = [".agents/skills", ".claude/skills", ".cursor/skills"];

/**
 * The skill folders of the project a job works in: in its folder and each folder above it up to
 * the repo root (a worktree's too), never at or above the home folder (those are the user's own,
 * for every project, and come from Settings).
 */
export function projectSkillDirs(cwd: string, home = homedir()): string[] {
  const out: string[] = [];
  const top = resolve(home);
  for (let d = resolve(cwd), i = 0; i < 12; i++) {
    if (d === top || d === "/") break;
    for (const s of PROJECT_SKILL_DIRS) if (existsSync(join(d, s))) out.push(join(d, s));
    if (existsSync(join(d, ".git"))) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  if (!process.env.ONDRA_SKILL_PATHS) return;
  const given: unknown = JSON.parse(process.env.ONDRA_SKILL_PATHS);
  if (!Array.isArray(given) || !given.every((p) => typeof p === "string")) throw new Error("Invalid ONDRA_SKILL_PATHS");
  // the project's own skills after the app's (a name the app has keeps the app's)
  const skillPaths = [...given, ...projectSkillDirs(process.cwd()).filter((d) => !given.includes(d))];
  // Keep Pi's parsing, duplicate precedence and relative-path handling without
  // giving its ResourceLoader a catalog to put into the system prompt.
  const { skills, diagnostics } = loadSkills({ cwd: process.cwd(), agentDir: process.cwd(), skillPaths, includeDefaults: false });
  for (const diagnostic of diagnostics) console.error(`[skills] ${diagnostic.path}: ${diagnostic.message}`);

  pi.registerTool({
    name: "skill_search",
    label: "Skill search",
    description: "Search available skills by task keywords or skill name (Korean or English). Returns up to 10 matching names, descriptions and file paths, never instructions. Read the selected SKILL.md with read and follow it; resolve references relative to baseDir. Try alternate keywords if no match.",
    promptSnippet: "Find skills for the task before starting work",
    promptGuidelines: ["Before starting a task, use skill_search with task keywords, then read and follow the matching SKILL.md. Search again when the task changes; do not infer that no skills apply from the absence of a catalog."],
    parameters: Type.Object({
      query: Type.String({ description: "Task keywords or an exact skill name" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum matches (default 5)" })),
    }),
    async execute(_id, { query, limit }) {
      const matches = searchSkills(skills, query, limit);
      const result = { skills: matches };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  const triggers = new Map<string, Triggers>();
  for (const s of skills) {
    try {
      triggers.set(s.name, triggersOf(parseFrontmatter(readFileSync(s.filePath, "utf8")).frontmatter));
    } catch {
      /* a skill without readable frontmatter still matches by its words */
    }
  }
  const router = new SkillRouter(skills, triggers);
  pi.on("session_start", () => router.reset());
  pi.on("session_compact", () => router.reset());

  // Every user message: a job's first (fresh or after a handoff) by the task's own
  // words, a later one by its own; skills it already has are left out.
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user" || typeof event.prompt !== "string") return;
    const task = taskQuery(event.prompt);
    // an answer to the job's own question is matched by what the user picked or typed, not the
    // question's words; a reply this short ("문제가 있어요", "못고쳐?") names no skill
    const asked = (task ?? userWords(event.prompt).replace(/^"[^"\n]*" → /, "")).slice(0, 4000);
    if (!asked.trim() || (!task && asked.trim().length < 12)) return;
    const hint = messageHint(router.forMessage(asked), !!task);
    if (hint) return { message: { customType: "ondra-skills", content: hint, display: false } };
  });

  // While working: a command, file, link or tool of a skill's domain points to that skill.
  pi.on("tool_result", (event) => {
    const hit = router.forTool(event.toolName, (event.input ?? {}) as Record<string, unknown>);
    if (!hit || event.isError) return;
    return { content: [...(event.content ?? []), { type: "text" as const, text: toolHint(hit.skill, hit.why) }] };
  });

  // Input transforms also run for steer/follow-up. Extension commands cannot
  // be queued, so keep explicit skill selection on the ordinary input path.
  pi.on("input", (event) => {
    const command = event.text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
    const skill = command && skills.find((s) => s.name === command[1]);
    if (!skill) return { action: "continue" };
    const body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
    router.loaded.add(skill.name);
    const args = command?.[2]?.trim();
    return { action: "transform", text: `Skill: ${skill.name}\nLocation: ${skill.filePath}\nResolve relative references from: ${skill.baseDir}\n\n${body}${args ? `\n\n${args}` : ""}` };
  });
}
