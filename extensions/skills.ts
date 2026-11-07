// Skill metadata stays in this process; only search matches reach the model.
import { readFileSync } from "node:fs";
import { loadSkills, stripFrontmatter, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function searchSkills(skills: Skill[], query: string, limit = 5) {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!terms.length) return [];
  return skills
    .filter((s) => !s.disableModelInvocation)
    .map((skill) => {
      const name = skill.name.toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const words = new Set(description.match(/[\p{L}\p{N}]+/gu) ?? []);
      const score = terms.reduce((n, term) => n + (name === term ? 8 : name.includes(term) ? 4 : 0) + (words.has(term) ? 3 : description.includes(term) ? 1 : 0), 0);
      return { skill, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map(({ skill: s }) => ({ name: s.name, description: s.description.slice(0, 1024), path: s.filePath, baseDir: s.baseDir }));
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
