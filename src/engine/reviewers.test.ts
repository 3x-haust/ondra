import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState } from "../state/store";
import type { Account, Task } from "../state/types";
import { KINDS } from "./memory";
import { crosscheckMessage, lensKids, lensText } from "./crosscheck";

const acct = (id: string, space: string, providers: string[]): Account => ({ id, space, label: id, providers, model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as never;
const job: Task = {
  id: "job", space: "home", topic: "", title: "반복 할 일", ask: "", cwd: "/r", status: "running", priority: 2, weight: "light",
  accountId: "mine", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], model: "anthropic/claude-opus-5-5",
};

describe("code review by several models together (Settings › 코드 리뷰)", () => {
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("accounts", [acct("mine", "home", ["anthropic"]), acct("codex", "home", ["openai-codex"]), acct("far", "work", ["openai-codex"])]);
  });
  const astra = { account: "codex", model: "openai-codex/gpt-6-astra", thinking: "high" };
  const opus = { account: "mine", model: "anthropic/claude-opus-5-5" };

  it("every model reads the change through both lenses, as one review", () => {
    setState("settings", "reviewers", [astra, opus]);
    const kids = lensKids(job, "Use the code-review skill. 반복 할 일");
    expect(kids.map((k) => [k.extra.lens, k.extra.model])).toEqual([
      ["design", "openai-codex/gpt-6-astra"],
      ["code", "openai-codex/gpt-6-astra"],
      ["design", "anthropic/claude-opus-5-5"],
      ["code", "anthropic/claude-opus-5-5"],
    ]);
    expect(new Set(kids.map((k) => k.extra.pair)).size).toBe(1);
    expect(kids[0].extra).toMatchObject({ accountId: "codex", thinking: "high" });
    expect(kids[0].title).toBe("설계 검토 · gpt-6-astra");
  });

  it("nothing set: the two lenses on the job's own model, as before", () => {
    const kids = lensKids(job, "x");
    expect(kids).toHaveLength(2);
    for (const k of kids) expect(k.extra.accountId ?? k.extra.model).toBeUndefined();
  });

  it("an account of another workspace: one of this workspace with that provider; none: left out", () => {
    setState("settings", "reviewers", [{ account: "far", model: "openai-codex/gpt-6-astra" }, opus]);
    expect(lensKids(job, "x")[0].extra).toMatchObject({ accountId: "codex", model: "openai-codex/gpt-6-astra" });
    setState("accounts", (l) => l.filter((a) => a.id !== "codex"));
    expect(lensKids(job, "x").map((k) => k.extra.model)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
  });

  const kid = (lens: "design" | "code", model: string, result: string, status: Task["status"] = "done"): Task => ({ ...job, id: `${lens}-${model}`, parentId: "job", review: true, lens, pair: "p", status, result, model });

  it("the result: each lens with each model's findings, where models agree, where they differ", () => {
    const group = [
      kid("design", "openai-codex/gpt-6-astra", "- P2 `a.ts:10` — 범위 빠짐"),
      kid("code", "openai-codex/gpt-6-astra", "- P1 `b.ts:5` — null 처리"),
      kid("design", "anthropic/claude-opus-5-5", "- P2 `a.ts:11` — 범위가 덜 됨"),
      kid("code", "anthropic/claude-opus-5-5", "- P3 `b.ts:6` — null"),
    ];
    const text = lensText(group);
    expect(text).toContain("# 설계 검토\n## gpt-6-astra\n- P2 `a.ts:10`");
    expect(text).toContain("## claude-opus-5-5\n- P2 `a.ts:11`");
    const msg = crosscheckMessage(group, { lines: [], split: [] });
    expect(msg).toContain("# 여러 모델이 같이 짚은 곳\n- `a.ts:10` — gpt-6-astra P2 · claude-opus-5-5 P2");
    expect(msg).toContain("# 모델끼리 갈리는 곳\n- `b.ts:5` — gpt-6-astra P1 · claude-opus-5-5 P3");
  });

  it("a model that failed is named; the others still count", () => {
    const group = [kid("design", "openai-codex/gpt-6-astra", ""), kid("code", "openai-codex/gpt-6-astra", "", "failed"), kid("design", "anthropic/claude-opus-5-5", "- P3 `a.ts:1` — x"), kid("code", "anthropic/claude-opus-5-5", "없음")];
    const msg = crosscheckMessage(group, { lines: [], split: [] });
    expect(msg).toContain("## gpt-6-astra\n(빠졌어요: 실패");
    expect(msg).not.toMatch(/코드 검토는 빠졌어요/);
  });
});

describe("용어 (the sharpen skill's glossary)", () => {
  it("is a kind of memory", () => {
    expect(KINDS).toContainEqual({ id: "term", label: "용어" });
  });
});
