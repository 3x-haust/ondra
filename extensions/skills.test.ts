import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
// the engine provides these at run time
vi.mock("@earendil-works/pi-coding-agent", () => ({ loadSkills: () => ({ skills: [], diagnostics: [] }), stripFrontmatter: (s: string) => s, parseFrontmatter: () => ({ frontmatter: {}, body: "" }) }));
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import { freshState, setState } from "../src/state/store";
import type { Task } from "../src/state/types";
import { CAPTAIN_SYSTEM, handoffPrompt, SUB_SYSTEM, TASK_SYSTEM, taskPrompt } from "../src/engine/prompts";
import { skillLine } from "../src/engine/agentTools";
import { messageHint, searchSkills, SkillRouter, skillHint, taskQuery, toolHint, triggersOf, type Triggers } from "./skills";

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
    expect(bundled.map((s) => s.name)).toEqual(expect.arrayContaining(["reverse-engineering", "computer-use", "visual-report", "deep-research", "mimikyu", "qa"]));
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
    ["이 웹앱 QA 해줘", "qa"],
    ["앱 화면 다 눌러봐", "qa"],
    ["버그 찾아줘", "qa"],
    ["출시 전에 점검해줘", "qa"],
    ["완벽하게 테스트해줘", "qa"],
    ["find bugs in the checkout flow", "qa"],
    ["dogfood the site before launch", "qa"],
    ["테스트 짜줘", "test-ci"],
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

// The bundled skills' own triggers, read from their frontmatter metadata lines.
const triggers = new Map<string, Triggers>(
  bundled.map((s) => {
    const text = readFileSync(s.filePath, "utf8");
    const front = text.split("\n---")[0].split("\n");
    const at = front.findIndex((l) => l === "metadata:");
    const metadata: Record<string, string> = {};
    for (const l of at < 0 ? [] : front.slice(at + 1)) {
      const m = l.match(/^  ([\w-]+): '(.*)'$/);
      if (!m) break;
      metadata[m[1]] = m[2];
    }
    return [s.name, triggersOf({ metadata })];
  }),
);
const router = () => new SkillRouter(bundled, triggers);

describe("skill router", () => {
  it("offers a skill when a tool steps into its domain, once", () => {
    const r = router();
    expect(r.forTool("bash", { command: "agent-browser open https://example.com" })?.skill.name).toBe("browser-use");
    expect(r.forTool("bash", { command: "agent-browser snapshot" })).toBeUndefined();
    expect(r.forTool("bash", { command: "otool -L /Applications/Foo.app/Contents/MacOS/Foo" })?.skill.name).toBe("reverse-engineering");
    expect(r.forTool("write", { path: ".github/workflows/ci.yml" })?.skill.name).toBe("test-ci");
    expect(r.forTool("computer", {})?.skill.name).toBe("computer-use");
    expect(r.forTool("device", {})?.skill.name).toBe("device-use");
  });

  it("leaves ordinary work alone", () => {
    const r = router();
    expect(r.forTool("bash", { command: "pnpm install && git status" })).toBeUndefined();
    expect(r.forTool("read", { path: "src/App.tsx" })).toBeUndefined();
    expect(r.forTool("edit", { path: "src/views/Results.tsx" })).toBeUndefined();
  });

  it("does not offer a skill the model has read", () => {
    const r = router();
    const browser = bundled.find((s) => s.name === "browser-use")!;
    r.forTool("read", { path: browser.filePath });
    expect(r.loaded.has("browser-use")).toBe(true);
    expect(r.forTool("bash", { command: "agent-browser open x" })).toBeUndefined();
    expect(r.forMessage("agent-browser로 사이트 열어서 브라우저로 확인해줘").map((s) => s.name)).not.toContain("browser-use");
  });

  it("reads every message, not only the first, and a link in it", () => {
    const r = router();
    expect(r.forMessage("README 오타 고쳐줘")).toEqual([]);
    expect(r.forMessage("이제 이 앱 바이너리를 분석해줘").map((s) => s.name)).toContain("reverse-engineering");
    expect(r.forMessage("https://www.figma.com/design/abc/Page?node-id=1-2 이대로").map((s) => s.name)[0]).toBe("mimikyu");
    // said once is enough until the conversation is compacted
    expect(r.forMessage("바이너리 하나 더 분석")).toEqual([]);
    r.reset();
    expect(r.forMessage("바이너리 하나 더 분석").map((s) => s.name)).toContain("reverse-engineering");
  });

  it("writes hints that name the skill and its file", () => {
    const re = bundled.find((s) => s.name === "reverse-engineering")!;
    expect(messageHint([re], false)).toContain(`- reverse-engineering:`);
    expect(messageHint([re], true)).toContain("# Skills for this task");
    expect(messageHint([], false)).toBe("");
    expect(toolHint(re, "runs a command of its domain")).toContain(re.filePath);
  });
});

describe("qa skill", () => {
  const qa = bundled.find((s) => s.name === "qa")!;
  const body = readFileSync(qa.filePath, "utf8");

  it("is named for QA requests in every role's skill list", () => {
    for (const prompt of [CAPTAIN_SYSTEM, TASK_SYSTEM, SUB_SYSTEM]) expect(prompt).toMatch(/QA[^\n]*→ qa/);
    expect(skillLine(qa)).toBe("앱을 직접 써 보며 버그를 찾아요");
  });

  it("drives each surface through the skill that owns it and ships its helpers", () => {
    for (const skill of ["browser-use", "device-use", "computer-use", "test-ci", "goal-loop", "visual-report"]) expect(body).toContain(`\`${skill}\``);
    expect(statSync(join(qa.baseDir, "sweep.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(qa.baseDir, "references", "checklist.md"), "utf8")).toContain("## Inputs");
  });

  it("reports only unless asked to fix, and keeps real accounts and passwords out", () => {
    expect(body).toMatch(/Report-only\*\* \(default\)/);
    expect(body).toContain("Never** use real customers' accounts");
    expect(body).toContain("Never type, paste or print a password");
  });
});
