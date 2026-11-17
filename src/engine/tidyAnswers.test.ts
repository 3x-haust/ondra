import { afterEach, describe, expect, it, vi } from "vitest";
import { setState, state } from "../state/store";
import type { Entry, Memory, Task } from "../state/types";
import { applyPlan, CHECK_SEEN, checkAsk, growChecks, jobMaterial, jobsShown, MIN_ANSWERS, tidyPrompt, wantsCheck, type Plan } from "./tidy";
import * as tasks from "./tasks";

const H = 3_600_000;
const DAY = 24 * H;
let at = 0;
const said = (text: string): Entry => ({ id: `e${at++}`, at, kind: "user", text });
const job = (id: string, o: Partial<Task> = {}): Task =>
  ({
    id, space: "work", title: `job ${id}`, ask: `${id} 작업을 해 주세요`, cwd: "/Users/u/Work/acme", project: "acme",
    status: "done", plan: [], legs: [], entries: [], shells: [], inbox: [], createdAt: 0, startedAt: 0, finishedAt: H,
    summary: "배포 준비를 끝냈어요. 스테이징에 먼저 올리고 확인까지 했어요. 남은 건 없어요.",
    ...o,
  }) as Task;
const piece = (o: Partial<Memory>): Memory => ({ id: o.id ?? Math.random().toString(36), text: o.text ?? "x", scope: "project", project: "~/Work/acme", space: "work", source: "ondra", by: "user", kind: "rule", createdAt: 1, updatedAt: 1, uses: 0, ...o }) as Memory;

function reset(memory: Memory[] = [], list: Task[] = []) {
  setState("spaces", [{ id: "work", label: "회사", folder: "/Users/u/Work" }] as never);
  setState("projects", [{ id: "acme", name: "acme", folder: "~/Work/acme", space: "work" }] as never);
  setState("tasks", list);
  setState("memory", memory);
  setState("memoryConflicts", []);
  setState("journal", []);
}
const run = (plan: Plan, fresh: string[]) => {
  const f = new Set(fresh);
  const g = jobsShown(state.tasks, f, new Set());
  return applyPlan(plan, state.memory.filter((m) => !m.invalidAt), { space: "work", shown: g.shown, mats: g.mats, fresh: f, learn: new Set() });
};
const Q = '"배포 전에 어디에 먼저 올릴까요?" → 스테이징 먼저';

afterEach(() => vi.restoreAllMocks());

describe("answers the user gave again and again", () => {
  it("are in what the pass reads about a job, and asked about in the prompt", () => {
    const m = jobMaterial(job("a", { entries: [said(Q), said("그냥 하는 말")] }), false);
    expect(m.lines).toContainEqual(["Answered", Q]);
    expect(tidyPrompt("work", [], [], false, false, true)).toContain("8. answers");
    expect(tidyPrompt("work", [], [], false, false, false)).not.toContain("8. answers");
  });

  it(`become a decision when ${MIN_ANSWERS} jobs got the same answer, one of them new`, () => {
    reset([], [job("a", { entries: [said(Q)] }), job("b", { entries: [said(Q)] })]);
    const text = "배포 전 어디에 올릴지 물으면 사용자는 항상 '스테이징 먼저'를 골라요 — 묻지 않고 스테이징에 먼저 올려요";
    const n = run({ answers: [{ jobs: ["a", "b"], quote: "스테이징 먼저", text, project: true }] }, ["b"]);
    expect(n.learned).toBe(1);
    const m = state.memory.find((x) => x.text === text);
    expect(m).toMatchObject({ kind: "decision", scope: "project", by: "agent" });
  });

  it("need two jobs, a new one, and a quote from the user's answer (not the job's words)", () => {
    reset([], [job("a", { entries: [said(Q)] }), job("b", { entries: [said(Q)] })]);
    const text = "배포 전 확인을 물으면 스테이징 먼저";
    expect(run({ answers: [{ jobs: ["a"], quote: "스테이징 먼저", text }] }, ["a"]).dropped).toBe(1);
    expect(run({ answers: [{ jobs: ["a", "b"], quote: "스테이징 먼저", text }] }, []).dropped).toBe(1);
    // in the Result line, not an answer
    expect(run({ answers: [{ jobs: ["a", "b"], quote: "스테이징에 먼저 올리고", text }] }, ["b"]).dropped).toBe(1);
    expect(state.memory).toHaveLength(0);
  });
});

describe("a rule said again becomes a check", () => {
  const now = 100 * DAY;
  it("only a live project rule said twice lately, not handed over yet", () => {
    const ok = piece({ seen: CHECK_SEEN, updatedAt: now - DAY });
    expect(wantsCheck(ok, now)).toBe(true);
    expect(wantsCheck({ ...ok, seen: 1 }, now)).toBe(false);
    expect(wantsCheck({ ...ok, kind: "preference" }, now)).toBe(false);
    expect(wantsCheck({ ...ok, scope: "space", project: undefined }, now)).toBe(false);
    expect(wantsCheck({ ...ok, checkTask: "t1" }, now)).toBe(false);
    expect(wantsCheck({ ...ok, updatedAt: now - 30 * DAY }, now)).toBe(false);
    expect(wantsCheck({ ...ok, invalidAt: now }, now)).toBe(false);
  });

  it("starts one job in the project, once, and one at a time per project", async () => {
    const rule = "컴포넌트에서 색은 하드코딩하지 말고 디자인 토큰만 써요";
    reset([piece({ id: "r1", text: rule, seen: 2, updatedAt: now - DAY }), piece({ id: "r2", text: "px 값 금지", seen: 3, updatedAt: now - DAY })]);
    const made: Parameters<typeof tasks.createTask>[0][] = [];
    vi.spyOn(tasks, "createTask").mockImplementation((f) => {
      made.push(f);
      const id = `t${made.length}`;
      setState("tasks", (l) => [...l, job(id, { status: "running", finishedAt: undefined })]);
      return id;
    });
    expect(await growChecks(undefined, now)).toBe(1);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ space: "work", project: "acme", cwd: "~/Work/acme", ask: checkAsk(rule) });
    expect(made[0].ask).toContain('{"type":"merge","kind":"fix"}');
    expect(state.memory.find((m) => m.id === "r1")?.checkTask).toBe("t1");
    // the first is still running: the second rule waits
    expect(await growChecks(undefined, now)).toBe(0);
    // done: the next rule goes, the first is not handed over again
    setState("tasks", (t) => t.id === "t1", "status", "done");
    expect(await growChecks(undefined, now)).toBe(1);
    expect(made.map((f) => f.ask)).toEqual([checkAsk(rule), checkAsk("px 값 금지")]);
    expect(await growChecks(undefined, now)).toBe(0);
  });

  it("does nothing when turned off", async () => {
    reset([piece({ seen: 2, updatedAt: now - DAY })]);
    setState("settings", "ruleChecks", false);
    const spy = vi.spyOn(tasks, "createTask");
    expect(await growChecks(undefined, now)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    setState("settings", "ruleChecks", true);
  });
});
