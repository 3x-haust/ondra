import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
// the engine provides these at run time
vi.mock("@earendil-works/pi-coding-agent", () => ({ loadSkills: () => ({ skills: [], diagnostics: [] }), stripFrontmatter: (s: string) => s }));
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import { freshState, setState } from "../src/state/store";
import type { Task } from "../src/state/types";
import { handoffPrompt, taskPrompt } from "../src/engine/prompts";
import { searchSkills, skillHint, taskQuery } from "./skills";

// The bundled skills as the engine reads them: name and (folded) description from the frontmatter.
const root = resolve("skills");
const bundled = readdirSync(root).flatMap((dir) => {
  const filePath = join(root, dir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const front = text.split("\n---")[0].split("\n").slice(1);
  const name = front.find((l) => l.startsWith("name:"))!.slice(5).trim();
  const at = front.findIndex((l) => l.startsWith("description:"));
  const inline = front[at].slice(12).trim();
  const folded = front.slice(at + 1).filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith("  "))).map((l) => l.trim());
  const description = (/^>-?$/.test(inline) ? folded : [inline]).join(" ");
  return [{ name, description, filePath, baseDir: join(root, dir), disableModelInvocation: false }];
}) as unknown as Parameters<typeof searchSkills>[0];

const top = (query: string) => searchSkills(bundled, query, 3).map((s) => s.name);

describe("skill matching", () => {
  it("reads every bundled skill", () => {
    expect(bundled.map((s) => s.name)).toEqual(expect.arrayContaining(["reverse-engineering", "computer-use", "visual-report", "deep-research", "mimikyu"]));
  });

  it("maps a question about how another tool works to reverse engineering", () => {
    expect(top("Codex 컴퓨터유즈가 어떻게 동작하는지 분석")[0]).toBe("reverse-engineering");
    expect(skillHint(bundled, "Codex 컴퓨터유즈가 어떻게 동작하는지 분석")).toContain("- reverse-engineering:");
  });

  it.each([
    ["이 앱 바이너리를 분석해줘", "reverse-engineering"],
    ["경쟁사 리서치해서 정리해줘", "deep-research"],
    ["피그마 그대로 만들어줘", "mimikyu"],
    ["매출 차트 보고서 만들어줘", "visual-report"],
    ["메모 앱에서 버튼 눌러줘 컴퓨터유즈로", "computer-use"],
  ])("%s → %s", (query, skill) => {
    expect(top(query)[0]).toBe(skill);
    expect(skillHint(bundled, query)).toContain(`- ${skill}:`);
  });

  it("lists nothing when no skill clearly fits", () => {
    expect(skillHint(bundled, "README 오타 고쳐줘")).toBe("");
  });
});

describe("taskQuery", () => {
  const t: Task = {
    id: "t1", space: "home", topic: "ondra", title: "Codex 분석", ask: "Codex 컴퓨터유즈가 어떻게 동작하는지 분석",
    cwd: "/repo", status: "queued", priority: 2, weight: "light", accountId: "default", createdAt: 1,
    now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  };
  beforeEach(() => setState(reconcile(freshState())));

  it("takes the title and the ask from a job's first message", () => {
    const q = taskQuery(taskPrompt(t))!;
    expect(q).toContain("Codex 분석");
    expect(q).toContain(t.ask);
    expect(q).not.toContain("Folder:");
  });

  it("takes the original task from a new session's first message", () => {
    const q = taskQuery(handoffPrompt({ ...t, legs: [{ startedAt: 1, endedAt: 2, handoff: { did: ["읽었어요"], next: "정리", evidence: [] } }, { startedAt: 2 }] }))!;
    expect(q).toContain(t.ask);
    expect(q).not.toContain("읽었어요");
  });

  it("ignores messages that aren't a job's first", () => {
    expect(taskQuery("(Ondra가 다시 시작됐어요. 하던 일을 이어서 하세요.)")).toBeUndefined();
    expect(taskQuery("다시 확인해줘")).toBeUndefined();
  });
});
