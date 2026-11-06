import { describe, expect, it } from "vitest";
import { githubBody, noteOf, parsePrView } from "./prView";

const raw = JSON.stringify({
  pr: {
    number: 79,
    title: "feat(appshot): shortcuts",
    url: "https://github.com/o/r/pull/79",
    state: "OPEN",
    isDraft: false,
    mergeable: "CONFLICTING",
    baseRefName: "main",
    headRefName: "feat/appshots",
    author: { login: "me" },
    reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "app", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1" },
      { __typename: "CheckRun", name: "api", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "vercel", state: "SUCCESS", targetUrl: "https://v" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
    comments: [{ id: "IC_1", author: { login: "kim" }, body: "화면도 봐 주세요", createdAt: "2026-11-06T01:00:00Z" }],
    reviews: [
      { id: "PRR_1", author: { login: "kim" }, body: "", state: "COMMENTED", submittedAt: "2026-11-06T02:00:00Z" },
      { id: "PRR_2", author: { login: "kim" }, body: "", state: "CHANGES_REQUESTED", submittedAt: "2026-11-06T03:00:00Z" },
    ],
    files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
    additions: 3,
    deletions: 1,
  },
  lines: [
    { id: 11, who: "kim", body: "null일 수 있어요", path: "src/a.ts", line: 4, side: "RIGHT", at: "2026-11-06T02:00:00Z" },
    { id: 12, who: "me", body: "고쳤어요", path: "src/a.ts", line: 4, side: "RIGHT", reply: 11, at: "2026-11-06T02:30:00Z" },
    { id: 13, who: "kim", body: "이름이 헷갈려요", path: "src/b.ts", line: 9, side: "RIGHT", at: "2026-11-06T02:10:00Z" },
  ],
  me: "me",
  diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,4 @@\n a\n+b\n",
  cut: false,
});

describe("pr view", () => {
  const v = parsePrView(raw);
  it("reads the header and checks", () => {
    expect([v.number, v.state, v.conflict, v.base, v.head, v.decision]).toEqual([79, "OPEN", true, "main", "feat/appshots", "CHANGES_REQUESTED"]);
    expect(v.checks.map((c) => `${c.name}:${c.state}`)).toEqual(["app:bad", "api:run", "vercel:ok", "lint:skip"]);
    expect(v.checks[0].url).toBe("https://ci/1");
  });
  it("threads replies under their comment and keeps the conversation in time order", () => {
    expect(v.threads.map((t) => [t.path, t.line, t.notes.map((n) => n.id)])).toEqual([
      ["src/a.ts", 4, [11, 12]],
      ["src/b.ts", 9, [13]],
    ]);
    // the empty COMMENTED review only carried line comments: it shows as those threads
    expect(v.items.map((x) => (x.kind === "thread" ? `thread:${x.thread.id}` : `${x.kind}:${x.id}`))).toEqual(["comment:IC_1", "thread:11", "thread:13", "review:PRR_2"]);
  });
  it("hands a thread to the job as one line comment", () => {
    const n = noteOf(v.items[1]);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ id: "line:12", kind: "line", path: "src/a.ts", line: 4 });
    expect(n[0].body).toContain("kim: null일 수 있어요");
  });
  it("turns GitHub's <img> tags into markdown pictures", () => {
    const body = '## 화면\n<!-- pr-media -->\n<img width="300" alt="after" src="https://github.com/user-attachments/assets/x" />\n<!-- /pr-media -->';
    expect(githubBody(body)).toBe("## 화면\n\n![after](https://github.com/user-attachments/assets/x)");
  });
});
