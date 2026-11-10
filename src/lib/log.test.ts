import { describe, expect, it } from "vitest";
import { redact } from "./log";
import { issueBody, issueTitle } from "./issue";

describe("the app log", () => {
  it("never keeps keys, tokens, emails or the home folder's name", () => {
    const s = redact("key sk-proj-abcdef1234567890XYZ, ghp_ABCDEFGHIJKLMNOP1234 Bearer abc.def.ghijklmn token=hunter2secret me@example.com /Users/lyu/Work/x");
    expect(s).not.toMatch(/abcdef1234567890|ABCDEFGHIJKLMNOP|abc\.def\.ghijklmn|hunter2|example\.com|\/Users\/lyu/);
    expect(s).toContain("~/Work/x");
  });
});

describe("a feedback issue", () => {
  const o = { version: "0.38.6", where: "view: main", os: "macOS 15.1" };
  it("says what happened, where, and folds the log's newest lines within the size", () => {
    const logs = Array.from({ length: 400 }, (_, i) => `2026-11-10 17:00:00 INFO  [x] line ${i}`).join("\n");
    const b = issueBody("메인이 멈췄어요", { ...o, logs }, 4000);
    expect(b.startsWith("메인이 멈췄어요\n\n---\n- Ondra 0.38.6")).toBe(true);
    expect(b.length).toBeLessThanOrEqual(4000);
    expect(b).toContain("line 399");
    expect(b).not.toContain("line 0\n");
  });
  it("titles it by its first line", () => {
    expect(issueTitle("패널이 안 열려요\n자세히는…")).toBe("패널이 안 열려요");
  });
});
