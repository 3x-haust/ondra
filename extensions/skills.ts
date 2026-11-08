// Skill metadata stays in this process; only search matches reach the model.
import { readFileSync } from "node:fs";
import { loadSkills, stripFrontmatter, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  if (!process.env.ONDRA_SKILL_PATHS) return;
  const skillPaths: unknown = JSON.parse(process.env.ONDRA_SKILL_PATHS);
  if (!Array.isArray(skillPaths) || !skillPaths.every((p) => typeof p === "string")) throw new Error("Invalid ONDRA_SKILL_PATHS");
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

  // A job's first message (fresh or after a handoff): search the skills with the task's own words
  // and hand the model the ones that fit, so it doesn't depend on remembering to search.
  pi.on("before_agent_start", (event) => {
    const query = event.messageType === "user" && typeof event.prompt === "string" ? taskQuery(event.prompt) : undefined;
    const hint = query ? skillHint(skills, query) : "";
    if (hint) return { message: { customType: "ondra-skills", content: hint, display: false } };
  });

  // Input transforms also run for steer/follow-up. Extension commands cannot
  // be queued, so keep explicit skill selection on the ordinary input path.
  pi.on("input", (event) => {
    const command = event.text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
    const skill = command && skills.find((s) => s.name === command[1]);
    if (!skill) return { action: "continue" };
    const body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
    const args = command?.[2]?.trim();
    return { action: "transform", text: `Skill: ${skill.name}\nLocation: ${skill.filePath}\nResolve relative references from: ${skill.baseDir}\n\n${body}${args ? `\n\n${args}` : ""}` };
  });
}
