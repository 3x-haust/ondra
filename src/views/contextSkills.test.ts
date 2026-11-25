import { describe, expect, it } from "vitest";
import { skillsRead } from "./contextData";

describe("the skills a conversation holds", () => {
  it("only the ones read into it: by the skill tool (through use), a read of its SKILL.md, or /skill:", () => {
    const got = skillsRead([
      { role: "user", tokens: 40, preview: "로고 만들어줘" },
      { role: "toolResult", toolName: "use", tokens: 900, preview: "Skill: logo-design Location: /skills/logo-design/SKILL.md Resolve relative references from: …" },
      { role: "toolResult", toolName: "read", tokens: 700, preview: "--- name: qa description: > QA by using the app …" },
      { role: "user", tokens: 500, preview: "Skill: recap Location: /skills/recap/SKILL.md …" },
      // a hint that names skills isn't the skill itself
      { role: "custom", tokens: 60, preview: "# Skills for this task (matched on the task) - code-review: …" },
      { role: "toolResult", toolName: "use", tokens: 80, preview: "No one skill clearly fits \"app\". Candidates …" },
    ]);
    expect([...got]).toEqual([["logo-design", 900], ["qa", 700], ["recap", 500]]);
  });
});
