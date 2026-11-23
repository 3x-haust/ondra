import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState } from "../state/store";
import type { Account, Task } from "../state/types";
import { KINDS } from "./memory";
import { lensKids, lensText } from "./crosscheck";

const acct = (id: string, space: string, providers: string[]): Account => ({ id, space, label: id, providers, model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as never;
const job: Task = {
  id: "job", space: "home", topic: "", title: "반복 할 일", ask: "", cwd: "/r", status: "running", priority: 2, weight: "light",
  accountId: "mine", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], model: "anthropic/claude-opus-5-5",
};

describe("code review by other models (Settings › 코드 리뷰)", () => {
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("accounts", [acct("mine", "home", ["anthropic"]), acct("codex", "home", ["openai-codex"]), acct("far", "work", ["openai-codex"])]);
  });

  it("each lens runs on the model set for it", () => {
    setState("settings", "reviewers", { design: { account: "codex", model: "openai-codex/gpt-6-astra", thinking: "high" }, code: { account: "mine", model: "anthropic/claude-opus-5-5" } });
    const [design, code] = lensKids(job, "Use the code-review skill. 반복 할 일");
    expect(design.extra).toMatchObject({ lens: "design", accountId: "codex", model: "openai-codex/gpt-6-astra", thinking: "high" });
    expect(code.extra).toMatchObject({ lens: "code", accountId: "mine", model: "anthropic/claude-opus-5-5" });
  });

  it("nothing set: both lenses on the job's own model, as before", () => {
    const kids = lensKids(job, "x");
    for (const k of kids) expect(k.extra.accountId ?? k.extra.model).toBeUndefined();
  });

  it("an account of another workspace: one of this workspace with that provider, else the job's own", () => {
    setState("settings", "reviewers", { design: { account: "far", model: "openai-codex/gpt-6-astra" } });
    expect(lensKids(job, "x")[0].extra).toMatchObject({ accountId: "codex", model: "openai-codex/gpt-6-astra" });
    setState("accounts", (l) => l.filter((a) => a.id !== "codex"));
    expect(lensKids(job, "x")[0].extra.accountId).toBeUndefined();
  });

  it("each lens's section says which model read it", () => {
    const kid = (lens: string, model: string): Task => ({ ...job, id: lens, parentId: "job", review: true, lens, pair: "p", status: "done", result: "- P2 `a.ts:1` — x", model });
    const text = lensText([kid("design", "openai-codex/gpt-6-astra"), kid("code", "anthropic/claude-opus-5-5")]);
    expect(text).toContain("# 설계 검토 · gpt-6-astra");
    expect(text).toContain("# 코드 검토 · claude-opus-5-5");
  });
});

describe("용어 (the sharpen skill's glossary)", () => {
  it("is a kind of memory", () => {
    expect(KINDS).toContainEqual({ id: "term", label: "용어" });
  });
});
