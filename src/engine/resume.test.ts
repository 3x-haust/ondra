import { describe, expect, it } from "vitest";
import type { Entry, Task } from "../state/types";
import { handoffPrompt, taskPrompt } from "./prompts";
import { unread } from "./tasks";

let n = 0;
const at = () => ++n;
const user = (text: string): Entry => ({ id: `u${at()}`, at: n, kind: "user", text });
const said = (text: string): Entry => ({ id: `t${at()}`, at: n, kind: "text", text });
const note = (text: string): Entry => ({ id: `n${at()}`, at: n, kind: "note", text });
const tool = (): Entry => ({ id: `x${at()}`, at: n, kind: "tool", tool: { name: "bash", kind: "bash", target: "ls", ok: true } });
const job = (entries: Entry[], extra: Partial<Task> = {}): Task => ({
  id: "t", space: "work", topic: "acme", title: "Check the review", ask: "Check why the app was rejected. Only check.", cwd: "/repo", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 0, now: "", plan: [], legs: [{ startedAt: 1, endedAt: 2 }, { startedAt: 3 }], entries, shells: [], inbox: [],
  ...extra,
});

describe("messages a restart cut off", () => {
  it("gives back what the user said after the job's last output", () => {
    const t = job([user("check it"), tool(), said("found it"), user("now fix it and ship"), note("branch")]);

    expect(unread(t)).toEqual(["now fix it and ship"]);
  });

  it("gives back nothing once the job has answered", () => {
    const t = job([user("check it"), tool(), user("also android"), said("on it")]);

    expect(unread(t)).toEqual([]);
  });
});

describe("a finished job given more work", () => {
  it("starts the new session from what it found and reported", () => {
    const t = job([user("check it"), tool(), said("Rejected under 2.1(a): the chat sends reasoning none.\n```blocks\n{\"type\":\"done\"}\n```")], {
      summary: "Found the rejection cause",
      inbox: ["fix it"],
    });

    const prompt = handoffPrompt(t);

    expect(prompt).toContain("Summary: Found the rejection cause");
    expect(prompt).toContain("Rejected under 2.1(a): the chat sends reasoning none.");
    expect(prompt).not.toContain('"type":"done"');
    expect(prompt).toContain("- fix it");
  });
});

describe("a session that ran long", () => {
  it("hands over the card, the user's later words and the plan", () => {
    const t = job([user("Check why the app was rejected. Only check."), tool(), user("(Ondra) This session is at 120k tokens."), user("now fix it, merge and resubmit, Android too")], {
      plan: [{ text: "Read the rejection", state: "done" }, { text: "Fix the chat", state: "now" }],
      legs: [{ startedAt: 1, endedAt: 2, handoff: { did: ["read the rejection"], found: ["cause: reasoning none sent"], next: "save two memories", doneWhen: "resubmitted on both stores", evidence: [] } }, { startedAt: 3 }],
    });

    const prompt = handoffPrompt(t);

    expect(prompt).toContain("- now fix it, merge and resubmit, Android too");
    expect(prompt).not.toContain("120k tokens");
    expect(prompt).toContain("- cause: reasoning none sent");
    expect(prompt).toContain("Done when: resubmitted on both stores");
    expect(prompt).toContain("[>] Fix the chat");
    expect(prompt.match(/Only check\./g)).toHaveLength(1);
  });
});

describe("a job started from a GitHub issue", () => {
  it("is told to close the issue from its pull request", () => {
    const t = job([], { issue: { n: 214, url: "https://github.com/acme/web/issues/214", title: "Login loops" }, legs: [] });

    const prompt = taskPrompt(t);

    expect(prompt).toContain("GitHub issue: #214 https://github.com/acme/web/issues/214");
    expect(prompt).toContain("`Closes #214`");
  });

  it("says nothing about issues when it has none", () => {
    expect(taskPrompt(job([], { legs: [] }))).not.toContain("GitHub issue");
  });
});
