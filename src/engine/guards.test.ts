import { describe, expect, it } from "vitest";
import type { Task } from "../state/types";
import { commandKind } from "./commandKind";
import { ghTouched, isCodeFile, reviewFound } from "./proof";
import { closePlan, lastReport, nextPlan, notTheirLanguage, onlyWaits } from "./tasks";

describe("commandKind", () => {
  it("status looks are polls", () => {
    for (const c of [
      "sleep 72; gh run view 42159843976 --json status,conclusion",
      'cd "$PWD" && gh api repos/a/b/actions/runs/1/jobs --jq .jobs',
      "asc status --app 6822234273 2>&1 | head -40",
      "curl -s https://example.com/status | jq .",
      "git status --short --branch",
      "git diff --stat",
      "pnpm --help",
      "git merge-tree -h",
      "gh pr checks 12",
    ])
      expect(commandKind(c), c).toBe("poll");
  });
  it("tests, type checks and builds are checks", () => {
    for (const c of ["pnpm -s typecheck", "pnpm test", "bun test ./tool/", "cargo test -q", "npx tsc --noEmit", "pnpm build", "pnpm run check:appshot"])
      expect(commandKind(c), c).toBe("check");
  });
  it("changing things is neither", () => {
    for (const c of ["git push origin main", "gh api repos/a/b/issues -f title=x", "curl -X POST https://x/y", "git checkout -b x", "gh pr merge 3 --merge"])
      expect(commandKind(c), c).toBe("other");
  });
});

describe("isCodeFile", () => {
  const t = { cwd: "/repo", worktree: undefined } as Pick<Task, "cwd" | "worktree">;
  it("code in the job's folder", () => {
    expect(isCodeFile("/repo/src/a.ts", t)).toBe(true);
    expect(isCodeFile("src/a.ts", t)).toBe(true);
    expect(isCodeFile("/repo/package.json", t)).toBe(true);
  });
  it("not notes, data, artifacts or other folders", () => {
    expect(isCodeFile("/repo/notes.md", t)).toBe(false);
    expect(isCodeFile("/repo/out/notes.jsonl", t)).toBe(false);
    expect(isCodeFile("/repo/report-sections.json", t)).toBe(false);
    expect(isCodeFile("/data/artifacts/t1/build-report.py", t)).toBe(false);
    expect(isCodeFile("/elsewhere/x.ts", t)).toBe(false);
  });
});

describe("ghTouched", () => {
  const job = (...cmds: string[]) => ({ entries: cmds.map((c) => ({ kind: "tool", tool: { kind: "bash", target: c } })) }) as never;
  it("a release it made and a run it viewed", () => {
    expect(ghTouched(job("gh release create v1.1.12 --notes x"), "https://github.com/a/tavi/releases/tag/v1.1.12")).toBe(true);
    expect(ghTouched(job("gh api repos/a/b/actions/runs/42179950820 --jq .status"), "https://github.com/a/b/actions/runs/42179950820")).toBe(true);
    expect(ghTouched(job("gh run view 42179950820"), "https://github.com/a/b/actions/runs/42179950820")).toBe(true);
  });
  it("not some other release or run", () => {
    expect(ghTouched(job("gh release create v1.1.11"), "https://github.com/a/tavi/releases/tag/v1.1.12")).toBe(false);
    expect(ghTouched(job("gh run view 1"), "https://github.com/a/b/actions/runs/42179950820")).toBe(false);
  });
});

describe("reviewFound", () => {
  it("reads P1 and P2 one by one", () => {
    expect(reviewFound("P1 없음, P2 2건")).toBe(true);
    expect(reviewFound("no P1, 4 P2s")).toBe(true);
    expect(reviewFound("- **P2** `a.ts:70`: 대화가 풀려요")).toBe(true);
    expect(reviewFound("P1·P2 없음")).toBe(false);
    expect(reviewFound("P1 0개, P2 0개. P3 하나")).toBe(false);
    expect(reviewFound("문제 없음")).toBe(false);
  });
});

describe("handoff and reports", () => {
  const card = (next: string) => ({ did: [], found: [], next, doneWhen: "" }) as never;
  it("a card that only waits", () => {
    expect(onlyWaits(card("사용자의 답을 기다려요"))).toBe(true);
    expect(onlyWaits(card("리뷰 결과가 오면 P1·P2를 고쳐요"))).toBe(false);
    expect(onlyWaits(card("CI 실패 로그를 보고 고친 뒤 다시 푸시"))).toBe(false);
  });
  it("the last report line, not what it was doing", () => {
    const t = { entries: [{ kind: "text", text: "## 결과\n앱샷 PR을 올렸어요.\n자세히…" }, { kind: "tool", tool: {} }] } as never;
    expect(lastReport(t)).toBe("앱샷 PR을 올렸어요.");
  });
});

describe("narration language", () => {
  const korean = { entries: [{ id: "e", at: 0, kind: "user", text: "검증 그만하고 사진 올려" }] } as never;
  it("flags English lines for a Korean user, not code or Korean", () => {
    expect(notTheirLanguage("Now upload the photos to the PR body.", korean)).toBe(true);
    expect(notTheirLanguage("이제 사진을 PR 본문에 올려요.", korean)).toBe(false);
    expect(notTheirLanguage("```bash\ngh pr view 79\n```", korean)).toBe(false);
    expect(notTheirLanguage("Now upload the photos.", { entries: [{ id: "e", at: 0, kind: "user", text: "upload the photos" }] } as never)).toBe(false);
  });
});

describe("plan", () => {
  it("keeps finished steps when a new plan comes, and closes on finish", () => {
    const old = [
      { text: "원인 확인", state: "done" as const },
      { text: "사진 찍기", state: "now" as const },
      { text: "커밋·푸시", state: "todo" as const },
    ];
    const next = nextPlan(old, ["원인 확인", "커밋·푸시", "PR에 사진 넣기"]);
    expect(next.map((s) => s.state)).toEqual(["done", "now", "todo"]);
    expect(closePlan(next).map((s) => s.state)).toEqual(["done", "done", "skip"]);
  });
});

describe("waitsOnUser", () => {
  it("sees a job handing the next step to the user", async () => {
    const { waitsOnUser } = await import("./tasks");
    expect(waitsOnUser("`fix/x`를 직접 푸시하고 PR을 병합해 주세요. 기다릴게요.")).toBe(true);
    expect(waitsOnUser("병합 완료를 알려주시면 이어갈게요.")).toBe(true);
    expect(waitsOnUser("타입 검사를 돌렸고 통과했어요.")).toBe(false);
  });
});
