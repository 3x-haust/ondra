import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState } from "../state/store";
import type { Task } from "../state/types";
import { btwPrompt } from "./aside";

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
