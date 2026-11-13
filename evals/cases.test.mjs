// The case files follow the rules in main-cases.mjs and job-cases.mjs, and the run counting
// in tally.mjs adds up.
import { describe, expect, it } from "vitest";
import { META, caseProblems as mainCaseProblems, loadCases as loadMainCases } from "./main-cases.mjs";
import { jobCaseProblems, loadJobCases } from "./job-cases.mjs";
import { EXPECT_KEYS, check } from "./main-sim-check.mjs";
import { lint } from "./main-sim-lint.mjs";
import { compare, fisher, headline, tally } from "./tally.mjs";

describe("case files", () => {
  it("main cases: nothing main sees says it is a test, every expect key is known, every case checks something", () => {
    const bad = loadMainCases().flatMap((c) => mainCaseProblems(c).map((p) => `${c.name}: ${p}`));
    expect(bad).toEqual([]);
  });

  it("job cases: the same", () => {
    const bad = loadJobCases().flatMap((c) => jobCaseProblems(c).map((p) => `${c.name}: ${p}`));
    expect(bad).toEqual([]);
  });

  it("catches what would make a case pass without checking", () => {
    const base = { space: "home", messages: ["로고 만들어줘"] };
    expect(mainCaseProblems({ ...base, expect: [{ newJobs: 1 }] })).toContain('unknown expect key "newJobs"');
    expect(mainCaseProblems({ ...base, expect: { new: 1 } })).toContain("expect must be a list, one per message");
    expect(mainCaseProblems({ ...base, expect: [{ new: 1 }, { new: 0 }] })).toContain("2 expectations for 1 messages");
    expect(mainCaseProblems({ ...base, expect: [{}] })).toContain("nothing expected (only the shared lint would run)");
    expect(mainCaseProblems({ ...base, expect: [{ new: 1 }] })).toEqual([]);
  });

  it("catches meta words main would see, but not in the note or expectations", () => {
    const c = { space: "home", messages: ["로고 만들어줘"], expect: [{ new: 1 }] };
    expect(mainCaseProblems({ ...c, projects: [{ name: "평가 1", folder: "/x" }] })).toEqual(['main would see "평가"']);
    expect(mainCaseProblems({ ...c, tasks: [{ id: "t", title: "eval run", status: "running" }] })).toEqual(['main would see "eval"']);
    expect(mainCaseProblems({ ...c, note: "an eval of one job; the judge reads it" })).toEqual([]);
    expect(jobCaseProblems({ ask: "이 rubric 대로 채점해줘" })).toEqual(['the job would see "rubric"']);
  });

  it("knows exactly the expect keys check() reads", () => {
    const read = [...new Set([...check.toString().matchAll(/\bx\.(\w+)/g)].map((m) => m[1]))];
    expect([...EXPECT_KEYS].sort()).toEqual(read.sort());
  });

  it("leaves organic words alone", () => {
    for (const s of ["빌드와 테스트는 통과했어요", "아이폰 시뮬레이터 켜서", "pnpm test", "모의투자 데이터"]) expect(s).not.toMatch(META);
  });

  it("lint knows the ids simulated jobs get", () => {
    const step = { text: "그것도 해줘", routes: [{ kind: "append", taskId: "job-1", message: "이것도" }] };
    expect(lint(step, { space: "home", tasks: [] })).toEqual([]);
    expect(lint({ ...step, routes: [{ ...step.routes[0], taskId: "t-x" }] }, { space: "home", tasks: [] })).toEqual(["lint: append to unknown job t-x"]);
  });
});

describe("tally", () => {
  const main = (name, ok, error) => ({ name, ok, ...(error ? { error: "bridge" } : {}), problems: [] });
  const job = (name, pass, runner) => ({ name, pass, failedChecks: runner ? ["runner"] : pass ? [] : ["done"] });

  it("counts harness errors apart from failures, for both runners", () => {
    const t = tally([main("a", true), main("a", false, true), job("b", false, true), job("b", false), { name: "c", ok: false, problems: [["error: 429"]] }]);
    expect(t.cases.map((c) => [c.name, c.passed, c.runs, c.errors])).toEqual([["a", 1, 2, 1], ["b", 0, 2, 1], ["c", 0, 1, 1]]);
    expect(t.flaky).toEqual([]);
  });

  it("marks a case that both passed and failed as flaky", () => {
    const t = tally([main("a", true), main("a", false), main("a", true), main("b", true), main("b", true)]);
    expect(t.flaky).toEqual(["a"]);
    expect(headline(t)).toBe("4/5 passed (2 cases, runs per case vary) · flaky: a");
  });

  it("says when one run per case can't show flakiness", () => {
    expect(headline(tally([main("a", true), main("b", false)]))).toBe("1/2 passed (2 cases, 1 run per case) · one run per case: flakiness unknown");
  });
});

describe("compare", () => {
  const runs = (spec) => Object.entries(spec).flatMap(([name, [k, n]]) => Array.from({ length: n }, (_, i) => ({ name, ok: i < k, problems: [] })));

  it("Fisher's exact test matches known values", () => {
    expect(fisher(3, 3, 0, 3)).toBeCloseTo(0.1, 6);
    expect(fisher(1, 2, 1, 2)).toBeCloseTo(1, 6);
    expect(fisher(10, 10, 0, 10)).toBeCloseTo(2 / 184756, 9);
  });

  it("calls a small move no measurable difference", () => {
    const v = compare(runs({ a: [2, 3], b: [3, 3] }), runs({ a: [3, 3], b: [3, 3] }));
    expect(v.verdict).toBe("no measurable difference");
    expect(v.changed.map((r) => r.name)).toEqual(["a"]);
  });

  it("calls a large move better or worse", () => {
    const before = runs({ a: [0, 3], b: [0, 3], c: [0, 3], d: [1, 3] });
    const after = runs({ a: [3, 3], b: [3, 3], c: [3, 3], d: [3, 3] });
    expect(compare(before, after).verdict).toBe("better");
    expect(compare(after, before).verdict).toBe("worse");
  });

  it("leaves out cases that changed in between, and calls it inconclusive when nothing is left", () => {
    const v = compare(runs({ a: [0, 3] }), runs({ a: [3, 3] }), { beforeMeta: { cases: { a: "x" } }, afterMeta: { cases: { a: "y" } } });
    expect(v.excluded).toEqual(["a (case changed)"]);
    expect(v.verdict).toBe("inconclusive");
  });

  it("calls runs on different models inconclusive", () => {
    const v = compare(runs({ a: [3, 3] }), runs({ a: [3, 3] }), { beforeMeta: { model: "m1" }, afterMeta: { model: "m2" } });
    expect(v.verdict).toBe("inconclusive");
  });
});
