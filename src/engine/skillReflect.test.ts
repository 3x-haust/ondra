import { describe, expect, it } from "vitest";
import { applyEdits, condenseTrace, lineDiff, mergeLessons, readReflection, reflectPrompt, skillsUsed, troubleOf, type KnownSkill } from "./skillReflect";
import type { Entry, SkillLesson, Task } from "../state/types";

let n = 0;
const user = (text: string, by?: string): Entry => ({ id: `e${n++}`, at: n, kind: "user", text, ...(by ? { by } : {}) });
const note = (text: string): Entry => ({ id: `e${n++}`, at: n, kind: "note", text });
const read = (path: string): Entry => ({ id: `e${n++}`, at: n, kind: "tool", tool: { name: "read", kind: "read", target: path.split("/").pop()!, detail: path, ok: true } });
const run = (cmd: string, ok: boolean): Entry => ({ id: `e${n++}`, at: n, kind: "tool", tool: { name: "bash", kind: "bash", target: cmd, detail: cmd, ok } });
const job = (o: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    space: "work",
    title: "로그인 화면 QA",
    ask: "로그인 화면 QA 해줘",
    cwd: "/Users/u/Work/acme",
    status: "done",
    plan: [],
    legs: [],
    entries: [],
    shells: [],
    inbox: [],
    createdAt: 0,
    startedAt: 0,
    finishedAt: 60_000,
    summary: "다 눌러 봤어요.",
    ...o,
  }) as Task;

const known: KnownSkill[] = [
  { name: "qa", path: "/skills/qa/SKILL.md", kind: "bundled" },
  { name: "deploy", path: "/data/skills/deploy/SKILL.md", kind: "mine" },
];

describe("skillsUsed", () => {
  it("finds skills whose SKILL.md the job read, or that the ask named", () => {
    expect(skillsUsed(job({ entries: [read("/skills/qa/SKILL.md"), read("/x/README.md")] }), known).map((s) => s.name)).toEqual(["qa"]);
    expect(skillsUsed(job({ ask: "`deploy` 스킬로 해 줘 (일을 맡길 때 이 스킬을 쓰라고 적어 줘): 배포해" }), known).map((s) => s.name)).toEqual(["deploy"]);
    expect(skillsUsed(job({ ask: "/skill:qa 돌려" }), known).map((s) => s.name)).toEqual(["qa"]);
  });
  it("ignores skills it can't change (not in the known list)", () => {
    expect(skillsUsed(job({ entries: [read("/Users/u/.claude/skills/other/SKILL.md")] }), known)).toEqual([]);
  });
});

describe("troubleOf", () => {
  it("is empty for a job that went fine", () => {
    expect(troubleOf(job({ entries: [user("로그인 화면 QA 해줘"), user("고마워")] }))).toEqual([]);
  });
  it("sees a failure, a correction after the ask, and the same failure over and over", () => {
    expect(troubleOf(job({ status: "failed" }))).toContain("failed");
    expect(troubleOf(job({ entries: [user("QA 해줘"), user("아니 그게 아니라 회원가입 화면이야")] }))).toContain("corrected");
    expect(troubleOf(job({ entries: [run("pnpm test", false), run("pnpm test", false), run("pnpm test", false)] }))).toContain("retried");
    expect(troubleOf(job({ entries: [note("같은 실패 반복 · pnpm test"), note("같은 실패 반복 · pnpm test")] }))).toContain("retried");
  });
  it("doesn't count the ask itself, or what another agent said", () => {
    expect(troubleOf(job({ entries: [user("다시 해줘 지난번 거 틀렸어"), user("아니 틀렸어", "main")] }))).toEqual([]);
  });
});

describe("condenseTrace", () => {
  it("has the ask, what the user said after, the failures, the result — within the budget", () => {
    const t = job({ status: "failed", error: "Error: login button not found", entries: [user("QA 해줘"), run("pnpm e2e", false), user("아니 회원가입 화면이야")] });
    const s = condenseTrace(t);
    expect(s).toContain("Asked: 로그인 화면 QA 해줘");
    expect(s).toContain("User said after: 아니 회원가입 화면이야");
    expect(s).toContain("pnpm e2e");
    expect(s).toContain("login button not found");
    expect(condenseTrace(t, 80).length).toBeLessThanOrEqual(80);
  });
});

describe("mergeLessons", () => {
  const l = (taskId: string, at: number): SkillLesson => ({ taskId, at, problem: "실패했어요" });
  it("one per job, the newest kept, oldest first, capped", () => {
    const out = mergeLessons([l("a", 1), l("b", 2)], [l("b", 5), l("c", 3)], 3);
    expect(out.map((x) => [x.taskId, x.at])).toEqual([["a", 1], ["c", 3], ["b", 5]]);
    expect(mergeLessons([l("a", 1), l("b", 2), l("c", 3)], [l("d", 4)], 2).map((x) => x.taskId)).toEqual(["c", "d"]);
  });
});

const SKILL = "---\nname: qa\ndescription: 앱을 직접 눌러 봐요\n---\n\n# QA\n\n1. 앱을 띄워요\n2. 다 눌러 봐요\n";

describe("applyEdits", () => {
  it("replaces text found exactly once, adds at the end with an empty find", () => {
    expect(applyEdits(SKILL, [{ find: "1. 앱을 띄워요", replace: "1. 앱을 띄우고 로그인해요" }])).toContain("1. 앱을 띄우고 로그인해요\n2.");
    expect(applyEdits(SKILL, [{ find: "", replace: "## 주의\n- 회원가입도 봐요" }])?.endsWith("2. 다 눌러 봐요\n\n## 주의\n- 회원가입도 봐요\n")).toBe(true);
  });
  it("is null when a find is missing or not unique (the skill changed)", () => {
    expect(applyEdits(SKILL, [{ find: "3. 없는 줄", replace: "x" }])).toBeNull();
    expect(applyEdits(SKILL, [{ find: "요", replace: "x" }])).toBeNull();
  });
});

describe("lineDiff", () => {
  it("shows only what changed with a little around it", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 10", "line ten");
    const d = lineDiff(a, b, 1);
    expect(d.filter((x) => x.kind === "del").map((x) => x.text)).toEqual(["line 10"]);
    expect(d.filter((x) => x.kind === "add").map((x) => x.text)).toEqual(["line ten"]);
    expect(d.filter((x) => x.kind === "same").map((x) => x.text)).toEqual(["line 9", "line 11"]);
    expect(d[0].kind).toBe("gap");
  });
  it("adds at the end", () => {
    expect(lineDiff("a\nb", "a\nb\nc").filter((x) => x.kind !== "same")).toEqual([{ kind: "add", text: "c" }]);
  });
});

describe("readReflection", () => {
  const fence = (o: unknown) => "생각해 보면…\n```skill-edit\n" + JSON.stringify(o) + "\n```";
  it("takes a small edit that fits the skill", () => {
    const r = readReflection(fence({ diagnosis: "로그인 없이 시작해서 막혔어요", why: "먼저 로그인해요", edits: [{ find: "1. 앱을 띄워요", replace: "1. 앱을 띄우고 로그인해요" }] }), SKILL);
    expect(r?.edits).toHaveLength(1);
    expect(r?.diagnosis).toBe("로그인 없이 시작해서 막혔어요");
  });
  it("passes a skip on", () => {
    expect(readReflection(fence({ skip: true, diagnosis: "서버가 죽어 있었어요" }), SKILL)?.skip).toBe(true);
  });
  it("drops edits that don't fit, change nothing, or rename the skill", () => {
    expect(readReflection(fence({ diagnosis: "x", edits: [{ find: "없는 줄", replace: "y" }] }), SKILL)).toBeNull();
    expect(readReflection(fence({ diagnosis: "x", edits: [{ find: "name: qa", replace: "name: qa2" }] }), SKILL)).toBeNull();
    expect(readReflection(fence({ diagnosis: "x", edits: [] }), SKILL)).toBeNull();
    expect(readReflection("no fence", SKILL)).toBeNull();
  });
});

describe("reflectPrompt", () => {
  it("asks for one combined change when a proposal is open", () => {
    const p = reflectPrompt(known[0], SKILL, [{ trouble: ["failed"], text: "## job t1" }], { lessons: [{ taskId: "t0", at: 0, problem: "실패했어요" }], diagnosis: "전에 본 문제", edits: [{ find: "a", replace: "b" }] });
    expect(p).toContain("ONE change");
    expect(p).toContain("전에 본 문제");
    expect(p).toContain("## job t1");
    expect(reflectPrompt(known[0], SKILL, [{ trouble: ["failed"], text: "## job t1" }])).not.toContain("ONE change");
  });
});
