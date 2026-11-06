import { describe, expect, it } from "vitest";
import { workedIn } from "./workedIn";

const job = (...cmds: string[]) => ({ entries: cmds.map((c) => ({ kind: "tool", tool: { kind: "bash", target: c, detail: c } })) }) as never;
describe("workedIn", () => {
  it("finds a worktree the job made itself and its pushed branch", () => {
    const w = workedIn(job("cd /Users/me/Work/projects/agents && git worktree add -b feat/appshots /Users/me/Work/worktrees/agents/appshots origin/main", 'cd "/Users/me/Work/worktrees/agents/appshots" && git commit -m x && git push -u origin feat/appshots'));
    expect(w).toEqual({ repo: "/Users/me/Work/worktrees/agents/appshots", branch: "feat/appshots" });
  });
  it("reads git -C and HEAD:branch pushes", () => {
    expect(workedIn(job("git -C /r/web commit -qm x", "git -C /r/web push origin HEAD:fix/a"))).toEqual({ repo: "/r/web", branch: "fix/a" });
  });
  it("nothing for jobs without git work, or with variables", () => {
    expect(workedIn(job("pnpm test"))).toEqual({ repo: undefined, branch: undefined });
    expect(workedIn(job('cd "$PWD" && git status'))).toEqual({ repo: undefined, branch: undefined });
  });
});
