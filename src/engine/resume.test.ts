import { describe, expect, it } from "vitest";
import type { Entry, Task } from "../state/types";
import { handoffPrompt } from "./prompts";
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
