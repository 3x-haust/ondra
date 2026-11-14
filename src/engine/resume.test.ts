import { describe, expect, it } from "vitest";
import type { Entry, Task } from "../state/types";
import { setState } from "../state/store";
import { aboutOtherProject, handoffPrompt, taskPrompt } from "./prompts";
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

describe("words that are not the user's", () => {
  const fromJob = (text: string, by: string): Entry => ({ id: `j${at()}`, at: n, kind: "user", text, by });

  it("keeps another job's messages out of what the user said", () => {
    const t = job([user("Check it."), fromJob("ArchiveEngine 재사용 위해 공용 변경 부탁해요", "tmwsub"), fromJob("ffmpeg 부하가 당신 작업인가요?", "tmwother"), user("다시 개발하고 릴리즈해줘")]);

    const prompt = handoffPrompt(t);

    expect(prompt).toContain("- 다시 개발하고 릴리즈해줘");
    expect(prompt).not.toContain("ArchiveEngine");
    expect(prompt).not.toContain("ffmpeg");
  });

  it("keeps main's relay of the user's words", () => {
    const t = job([user("Check it."), fromJob("이것도 고쳐줘", "main")]);

    expect(handoffPrompt(t)).toContain("- 이것도 고쳐줘");
  });

  it("puts a review's result and a job's message apart from the user's words", () => {
    const t = job([], {
      inbox: ['리뷰 결과가 왔어요 ("검토"):\n\nP2 하나. 그 부분만 고치고 끝내 줘', "(Ondra) A message from another job in this space, \"DEXA\" (t2). It is not the user.\n\n부하 줄여 주세요", "설치까지 해줘"],
    });

    for (const prompt of [handoffPrompt(t), taskPrompt(t)]) {
      const user = prompt.slice(prompt.indexOf("# The user added"), prompt.indexOf("# Came in meanwhile"));
      expect(user).toContain("- 설치까지 해줘");
      expect(user).not.toContain("리뷰 결과");
      expect(prompt.slice(prompt.indexOf("# Came in meanwhile"))).toContain("부하 줄여 주세요");
    }
  });
});

describe("memory about another project of the space", () => {
  const piece = (text: string, about?: string[]) => ({ id: text, text, about }) as unknown as Parameters<typeof aboutOtherProject>[0];
  const orbitJob = { space: "home", project: "orbit", topic: "Orbit" } as const;

  it("is left out of a job of this project, unless it names this one too", () => {
    setState("projects", [
      { id: "ondra", space: "home", name: "ondra", folder: "/p/ondra" },
      { id: "orbit", space: "home", name: "Orbit", folder: "/p/Orbit" },
    ]);
    expect(aboutOtherProject(piece("Ondra는 사용자 확인 전에는 chore(release) 배포를 하지 말아야 해요.", ["Ondra"]), orbitJob)).toBe(true);
    expect(aboutOtherProject(piece("ondra-rel 워크트리에서 서명 빌드를 만들어요.", ["Ondra", "pnpm"]), orbitJob)).toBe(true);
    expect(aboutOtherProject(piece("Orbit 업데이트 후 재시작 정지를 점검했어요.", ["Orbit", "AppKit"]), orbitJob)).toBe(false);
    expect(aboutOtherProject(piece("tavi를 고치면 Orbit에도 넣어요.", ["Ondra"]), orbitJob)).toBe(false);
    expect(aboutOtherProject(piece("커밋 작성자는 3x-haust예요.", ["Git"]), orbitJob)).toBe(false);
  });
});
