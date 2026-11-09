import { describe, expect, it } from "vitest";
import { FORK_ENDED, PROJECT_ENDED } from "./captain";
import { CAPTAIN_SYSTEM } from "./prompts";

// The chat shows each job main started or relayed to as a row that keeps up with it,
// so main reacting to a job's end adds only what needs the user.
describe("main when a job ends", () => {
  it("adds nothing for a job that finished as asked, instead of retelling it", () => {
    expect(FORK_ENDED).toContain('add nothing: {"reply":"","routes":[]}');
    expect(FORK_ENDED).toContain("Don't retell it");
    expect(FORK_ENDED).not.toContain("Tell the user what came out");
    expect(FORK_ENDED).not.toMatch(/the result first|screenshots or files the fork made/);
  });

  it("still says a failure, answers the user's questions, routes the next step and asks real choices", () => {
    expect(FORK_ENDED).toContain("it failed");
    expect(FORK_ENDED).toContain("answer every such question, the 왜 first");
    expect(FORK_ENDED).toContain("route it now instead of offering it");
    expect(FORK_ENDED).toContain('one "ask", your recommendation first');
    expect(FORK_ENDED).toMatch(/one short line/);
  });

  it("keeps the rules about unverified items", () => {
    expect(FORK_ENDED).toContain('"Not verified" items stay in its result, not chased');
    expect(FORK_ENDED).toContain("never for checks, evals or polish the user didn't ask for");
    expect(FORK_ENDED).toContain('"CI 결과는 기다리지 않았어요" stays that');
    expect(FORK_ENDED).toContain("Don't redo finished work");
  });

  it("does the same when a project main handed work to reports back", () => {
    expect(PROJECT_ENDED).toContain('add nothing: {"reply":"","routes":[]}');
    expect(PROJECT_ENDED).toContain("Don't retell what came out");
    expect(PROJECT_ENDED).toContain("no row in your chat");
    expect(PROJECT_ENDED).toContain("the 왜 first");
    expect(PROJECT_ENDED).toContain('"CI 결과는 기다리지 않았어요" stays that');
  });

  it("lets a job's end come back with no routes", () => {
    expect(CAPTAIN_SYSTEM).toContain("Never\nreturn zero routes for a message that isn't empty.");
    expect(CAPTAIN_SYSTEM).toMatch(/ended is not a message[\s\S]*\{"reply":"","routes":\[\]\}/);
    expect(CAPTAIN_SYSTEM).not.toContain("end your report on it");
  });
});
