import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState } from "../state/store";
import type { Task } from "../state/types";
import { btw, btwIndex, btwList, btwPrompt, closeBtw, showBtw } from "./aside";

const job = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "Example", title, ask: `Do ${title}`, cwd: "/repo", status: "done",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...extra,
});

beforeEach(() => setState(reconcile(freshState())));

describe("btw", () => {
  it("sees every job, sub-job and chat, not only the one on screen", () => {
    setState("tasks", [
      job("a", "Fix login", { entries: [{ id: "e1", at: 2, kind: "user", text: "also ship it" }, { id: "e2", at: 3, kind: "text", text: "Shipped 1.4.0." }] }),
      job("b", "Check review", { parentId: "a", summary: "Rejected under 2.1(a)" }),
      job("c", "Write docs"),
    ]);
    setState("captain", [{ id: "m1", at: 1, space: "home", from: "me", text: "how is the release going?" }]);

    const prompt = btwPrompt("task:c", "what shipped?", "/data/sessions");

    expect(prompt).toContain("# Job: Write docs");
    expect(prompt).toContain("## Fix login [done] · id a");
    expect(prompt).toContain("user later: also ship it");
    expect(prompt).toContain("last said: Shipped 1.4.0.");
    expect(prompt).toContain('sub-job of "Fix login"');
    expect(prompt).toContain("summary: Rejected under 2.1(a)");
    expect(prompt).toContain("user: how is the release going?");
    expect(prompt).toContain("/data/sessions");
  });
});

describe("btw places", () => {
  it("keeps main's and each job's btws apart, each with its own open card", () => {
    const q = (id: string, scope: string) => ({ id, at: 1, scope, question: id, answer: "a", pending: false });
    setState("btws", [q("m1", "main:home"), q("a1", "task:a"), q("m2", "main:home"), q("b1", "task:b"), q("a2", "task:a")]);

    expect(btwList("main:home").map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(btwList("task:a").map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(btwList("main:home~p1")).toEqual([]);

    expect(showBtw("task:a")).toBe(true);
    expect(btw("task:a")?.id).toBe("a2");
    expect(btw("main:home")).toBeNull();
    showBtw("main:home", 0);
    expect(btw("main:home")?.id).toBe("m1");
    expect(btwIndex("task:a")).toBe(1);

    closeBtw("main:home");
    expect(btw("main:home")).toBeNull();
    expect(btw("task:a")?.id).toBe("a2");
    expect(showBtw("task:c")).toBe(false);
  });
});
