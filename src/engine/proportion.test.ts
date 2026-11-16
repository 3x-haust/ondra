import { describe, expect, it } from "vitest";
import { FORK_ENDED, toFork } from "./captain";
import { CAPTAIN_SYSTEM, SUB_SYSTEM, TASK_SYSTEM } from "./prompts";
import { PLAN_FIX, planKids } from "./crosscheck";
import type { Entry } from "../state/types";

const bundledSkills = import.meta.glob<string>("../../skills/*/SKILL.md", { query: "?raw", import: "default", eager: true });
const flat = (s: string) => s.replace(/\s+/g, " ");
const user = (text: string, by?: string): Entry => ({ id: text, at: 0, kind: "user", text, ...(by ? { by } : {}) });

// Seen in the DEXA, wallpaper, Orbit and mockup jobs (2026-11-12–14): checks grew past what was asked
describe("checks that fit what the user asked", () => {
  it("hands main what the user picked on a job's own card", () => {
    // "이번 불충분 결과로 종료" was picked on the job's card; main never saw it and
    // started the same verification again, writing "the user didn't ask to stop"
    const ask = "DEXA 검증을 이어가라";
    const said = toFork({
      ask,
      entries: [
        user(ask),
        user('"검증을 이어가기 위해 별도 진단부터 진행할까요?" → 이번 불충분 결과로 종료'),
        user("다른 작업 결과예요", "tmw123"),
        user("(Ondra) Your to-do list hasn't moved for a while."),
        user("main이 전한 말", "main"),
      ],
    });
    expect(said).toEqual(['"검증을 이어가기 위해 별도 진단부터 진행할까요?" → 이번 불충분 결과로 종료']);
    expect(FORK_ENDED).toMatch(/the user's own words to the fork decide/);
    expect(FORK_ENDED).toMatch(/"종료".*route nothing/);
  });

  it("main passes the user's words on, not a stricter bar of its own", () => {
    const p = flat(CAPTAIN_SYSTEM);
    expect(p).toContain("pass the user's own words and the success condition they gave");
    expect(p).toContain("Add no requirement, guarantee, isolation rule or way of checking the user didn't state");
    expect(p).toContain("never test-ci, code-review, computer-use or goal-loop as a way to check it");
  });

  it("a hypothesis to test is research, not a goal loop that only a yes can end", () => {
    expect(flat(CAPTAIN_SYSTEM)).toMatch(/A research question or an idea to test .* is research, not a loop/);
    expect(flat(TASK_SYSTEM)).toContain("goal-loop (not research: it ends with its answer)");
    const skill = flat(bundledSkills["../../skills/goal-loop/SKILL.md"]);
    expect(skill).toContain("not for research");
    expect(skill).toContain("a project's own gates or casebook");
    expect(skill).toContain("or the user saying it's enough");
  });

  it("a job ships what only the user can try and asks them, instead of holding it back", () => {
    const p = flat(TASK_SYSTEM);
    expect(p).toContain("A step only the user can do");
    expect(p).toContain("ask them to try it (exact steps)");
    expect(p).not.toContain("An obstacle means taking the next way");
    expect(p).toContain("after three ways fail on one action, ask the user to do that step");
    expect(flat(bundledSkills["../../skills/computer-use/SKILL.md"])).not.toContain("Asking the user is for permission, never for handing the work back");
  });

  it("mockups and concepts get a look, not reviews, tests or audits", () => {
    expect(flat(SUB_SYSTEM)).toContain("A mockup or draft gets a look, not tests or audits");
    expect(flat(TASK_SYSTEM)).toContain("nor a mockup or concepts");
    const web = flat(bundledSkills["../../skills/web-design/SKILL.md"]);
    expect(web).toContain("Concepts and temporary UI are for judging the look");
    expect(web).toContain("For the chosen design built into the product, not for concepts or temporary UI.");
  });

  it("reviews only risky changes, and plan readers don't add what wasn't asked", () => {
    expect(flat(TASK_SYSTEM)).toContain("not test seams or research scripts");
    expect(PLAN_FIX).toContain("사용자가 요청하지 않은 보장·상태·검사·안전장치");
    expect(planKids("req\n\nplan")[0].ask).toContain("is never P1 or P2");
  });
});
