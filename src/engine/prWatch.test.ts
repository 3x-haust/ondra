import { describe, expect, it } from "vitest";
import type { PrWatch } from "../state/types";
import { canWake, hasNews, parseSnap, prNews, wakeText, WAKES_PER_DAY } from "./prWatch";

const watch = (o: Partial<PrWatch> = {}): PrWatch => ({ url: "https://github.com/o/r/pull/7", task: "t1", since: Date.parse("2026-11-06T00:00:00Z"), seen: [], failed: [], conflict: false, wakes: [], last: 0, ...o });

const raw = (o: { checks?: unknown[]; comments?: unknown[]; reviews?: unknown[]; lines?: unknown[]; mergeable?: string } = {}) =>
  JSON.stringify({
    pr: { state: "OPEN", mergeable: o.mergeable ?? "MERGEABLE", headRefOid: "abc", statusCheckRollup: o.checks ?? [], comments: o.comments ?? [], reviews: o.reviews ?? [] },
    lines: o.lines ?? [],
    me: "me",
  });

const at = "2026-11-06T01:00:00Z";

describe("pr watch", () => {
  it("passes on others' comments, reviews and line comments, not its own or old ones", () => {
    const s = parseSnap(
      raw({
        comments: [
          { id: "c1", author: { login: "kim" }, body: "로그인 화면도 봐 주세요", createdAt: at },
          { id: "c2", author: { login: "me" }, body: "고쳤어요", createdAt: at },
          { id: "c3", author: { login: "kim" }, body: "old", createdAt: "2026-11-05T00:00:00Z" },
          { id: "c4", author: { login: "vercel[bot]" }, body: "Preview ready", createdAt: at },
        ],
        reviews: [
          { id: "r1", author: { login: "kim" }, body: "", state: "COMMENTED", submittedAt: at },
          { id: "r2", author: { login: "kim" }, body: "", state: "CHANGES_REQUESTED", submittedAt: at },
        ],
        lines: [{ id: 99, who: "coderabbitai[bot]", bot: true, body: "이 값은 null일 수 있어요", path: "src/a.ts", line: 42, at }],
      }),
    );
    const n = prNews(watch(), s);
    expect(n.notes.map((x) => x.id)).toEqual(["c1", "r2", "line:99"]);
    expect(prNews(watch({ seen: ["c1", "r2", "line:99"] }), s).notes).toEqual([]);
    const text = wakeText("https://github.com/o/r/pull/7", n);
    expect(text).toContain("id 99, coderabbitai[bot], src/a.ts:42");
    expect(text).toContain("repos/o/r/pulls/7/comments/<id>/replies");
  });

  it("reports failed checks once everything has run, once per head", () => {
    const running = parseSnap(raw({ checks: [{ name: "app", status: "COMPLETED", conclusion: "FAILURE" }, { name: "api", status: "IN_PROGRESS", conclusion: "" }] }));
    expect(prNews(watch(), running).failed).toEqual([]);
    const done = parseSnap(raw({ checks: [{ name: "app", status: "COMPLETED", conclusion: "FAILURE" }, { context: "lint", state: "SUCCESS" }] }));
    expect(prNews(watch(), done).failed).toEqual(["app@abc"]);
    expect(prNews(watch({ failed: ["app@abc"] }), done).failed).toEqual([]);
  });

  it("reports a conflict when it appears", () => {
    const s = parseSnap(raw({ mergeable: "CONFLICTING" }));
    expect(hasNews(prNews(watch(), s))).toBe(true);
    expect(hasNews(prNews(watch({ conflict: true }), s))).toBe(false);
  });

  it("caps wake-ups a day", () => {
    const now = Date.now();
    expect(canWake(watch({ wakes: Array(WAKES_PER_DAY).fill(now - 1000) }), now)).toBe(false);
    expect(canWake(watch({ wakes: Array(WAKES_PER_DAY).fill(now - 90_000_000) }), now)).toBe(true);
  });
});
