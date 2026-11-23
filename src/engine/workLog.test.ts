import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { resetWorkLog, stepLine, testLine, workTick } from "./workLog";
import { inOpenNote, writesLikeTeammate } from "./prompts";
import { voiceGist } from "./agentVoice";

const job = (o: Partial<Task> = {}): Task =>
  ({ id: "t1", space: "home", title: "탭 고치기", topic: "ondra", ask: "", cwd: "/p", status: "running", entries: [], shells: [], createdAt: 0, ...o }) as unknown as Task;
let n = 0;
const entry = (e: Record<string, unknown>, at = 2000): Entry => ({ id: `e${++n}`, at, ...e }) as Entry;
const add = (id: string, e: Entry) => setState("tasks", (t) => t.id === id, "entries", (es) => [...es, e]);

describe("the agent's work, in the open", () => {
  let sent: [string, string][];
  let files: [string, string][];
  let typing: string[];
  beforeEach(() => {
    setState(reconcile(freshState()));
    resetWorkLog();
    sent = [];
    files = [];
    typing = [];
    vi.spyOn(native, "discordSend").mockImplementation(async (c, text) => (sent.push([c, text]), ["m"]));
    vi.spyOn(native, "discordSendFile").mockImplementation(async (c, p) => (files.push([c, p]), ["m"]));
    vi.spyOn(native, "discordTyping").mockImplementation(async (c) => void typing.push(c));
  });

  it("its words, a skill, tests, a commit and a PR show in the channel as they happen, a few at a time", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } })]);
    await workTick(1000);
    add("t1", entry({ kind: "text", text: "이거부터 읽어볼게" }));
    add("t1", entry({ kind: "tool", tool: { name: "read", kind: "read", target: "SKILL.md", detail: "/Users/me/.ondra/skills/code-review/SKILL.md" } }));
    await workTick(4000);
    expect(sent).toEqual([["c1", "이거부터 읽어볼게\n`code-review` 스킬 꺼냄"]]);
    expect(typing).toEqual(["c1"]);

    setState("tasks", (t) => t.id === "t1", "shells", [
      { id: "s1", command: "pnpm vitest run", startedAt: 1, endedAt: 2, ok: false, tail: " FAIL  src/a.test.ts > tabs\nAssertionError: expected 2 to be 3\n Tests  3 failed | 1541 passed (1544)" },
      { id: "s2", command: "git commit -m x", startedAt: 1, endedAt: 2, ok: true, tail: "[feat/tabs 1a2b3c4] fix(tabs): keep order\n 1 file changed" },
      { id: "s3", command: "gh pr create", startedAt: 1, endedAt: 2, ok: true, tail: "https://github.com/3x-haust/ondra/pull/732\n" },
    ]);
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "test", target: "pnpm vitest run", detail: "pnpm vitest run", shellId: "s1", ok: false, endedAt: 3 } }));
    add("t1", entry({ kind: "text", text: "맞음. 이게 진짜 버그다" }));
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "bash", target: "git commit -m x", detail: "git commit -m x", shellId: "s2", ok: true, endedAt: 3 } }));
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "bash", target: "gh pr create", detail: "gh pr create", shellId: "s3", ok: true, endedAt: 3 } }));
    await workTick(7000);
    expect(sent[1][1].split("\n")).toEqual([
      "테스트 돌림 → 1541 통과 / 3 실패: `a.test.ts`",
      "  ↳ AssertionError: expected 2 to be 3",
      "맞음. 이게 진짜 버그다",
      "커밋함 `1a2b3c4` fix(tabs): keep order",
      "PR 올림 #732 https://github.com/3x-haust/ondra/pull/732",
    ]);
    // nothing twice
    await workTick(9000);
    expect(sent).toHaveLength(2);
  });

  it("a screenshot it looked at goes up as a picture, unless it chose to leave them out", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } }), job({ id: "t2", agent: { channel: "c1", shots: false } })]);
    await workTick(1000);
    const shot = { name: "read", kind: "read", target: "after.png", detail: "/tmp/after.png", image: "/tmp/after.png", ok: true, endedAt: 3 };
    add("t1", entry({ kind: "tool", tool: shot }));
    add("t2", entry({ kind: "tool", tool: shot }));
    await workTick(4000);
    expect(files).toEqual([["c1", "/tmp/after.png"]]);
  });

  it("subagents: their start and end only, not what they say along the way", async () => {
    setState("tasks", [
      job({ agent: { channel: "c1" } }),
      job({ id: "k1", parentId: "t1", title: "설계 검토", model: "openai/gpt-6-astra", agent: { channel: "c1" } }),
      job({ id: "k2", parentId: "t1", title: "코드 검토", model: "claude-opus-5-5", agent: { channel: "c1" } }),
    ]);
    await workTick(1000);
    add("t1", entry({ kind: "spawn", childIds: ["k1", "k2"] }));
    add("k1", entry({ kind: "text", text: "흠 이 파일부터" }));
    await workTick(4000);
    expect(sent).toEqual([["c1", "서브에이전트 2개 돌림 (설계 검토, gpt-6-astra · 코드 검토, claude-opus-5-5)"]]);
    add("k1", entry({ kind: "text", text: "P1 하나 P2 둘" }));
    setState("tasks", (t) => t.id === "k1", "status", "done");
    await workTick(7000);
    expect(sent[1]).toEqual(["c1", "설계 검토 끝: P1 하나 P2 둘"]);
  });

  it("no tool output in full, and secrets and private paths hidden", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } })]);
    await workTick(1000);
    setState("tasks", (t) => t.id === "t1", "shells", [{ id: "s1", command: "cat .env", startedAt: 1, endedAt: 2, ok: true, tail: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv\nlots of output" }]);
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "bash", target: "cat .env", detail: "cat .env", shellId: "s1", ok: true, endedAt: 3 } }));
    add("t1", entry({ kind: "text", text: "키가 sk-abcdefghijklmnopqrstuv 이거네, /Users/lyu/secret 에 있음" }));
    add("t1", entry({ kind: "tool", tool: { name: "ls", kind: "search", target: "x", ok: true, endedAt: 3 } }));
    await workTick(4000);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).not.toContain("abcdefghijklmnop");
    expect(sent[0][1]).not.toContain("lots of output");
    expect(sent[0][1]).not.toContain("/Users/lyu");
  });

  it("in the channel it picked; the asking channel gets no stock end line (the agent's own end line goes there)", async () => {
    setState("tasks", [job({ agent: { channel: "general", room: "orbit" } })]);
    await workTick(1000);
    add("t1", entry({ kind: "text", text: "orbit 버그 보는 중" }));
    add("t1", entry({ kind: "tool", tool: { name: "ls", kind: "search", target: "x", ok: true, endedAt: 3 } }));
    await workTick(4000);
    expect(sent).toEqual([["orbit", "orbit 버그 보는 중"]]);
    setState("tasks", (t) => t.id === "t1", "status", "done");
    await workTick(7000);
    await workTick(10000);
    expect(sent.filter(([c]) => c === "general")).toEqual([]);
  });

  it("work asked in the app never goes up, and quiet work only has its start and end lines (said by the agent)", async () => {
    setState("tasks", [job({ id: "app" }), job({ id: "q", agent: { channel: "c1", quiet: true } })]);
    await workTick(1000);
    add("app", entry({ kind: "text", text: "앱 작업" }));
    add("q", entry({ kind: "text", text: "조용히" }));
    await workTick(4000);
    expect(sent).toEqual([]);
    expect(typing).toEqual([]);
    expect(inOpenNote({ agent: { channel: "c1", quiet: true } })).toBe("");
    expect(inOpenNote({})).toBe("");
    // in the agent's own voice (its gist, not the whole of it), as the same one
    expect(inOpenNote({ agent: { channel: "c1" } })).toContain(voiceGist());
    setState("settings", "agent", { on: true, name: "몽이", voice: "넌 시니컬한 고양이야. 짧게 툭툭.\n\n예시는 길게 길게 길게" });
    const mine = inOpenNote({ agent: { channel: "c1" } });
    expect(mine).toContain("몽이");
    expect(mine).toContain("넌 시니컬한 고양이야. 짧게 툭툭.");
    expect(mine).not.toContain("예시는");
    expect(inOpenNote({ agent: { channel: "c1" }, parentId: "t1" })).toBe("");
    // what it posts on GitHub: for the agent's own work only
    expect(writesLikeTeammate({ agent: { channel: "c1", quiet: true } })).toContain("teammate");
    expect(writesLikeTeammate({})).toBe("");
  });

  it("its closing report is left to the agent's end line; pictures in its words go up as pictures", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } })]);
    await workTick(1000);
    add("t1", entry({ kind: "text", text: "고쳤으니 찍어볼게 ![](~/Library/Application Support/x/before.png)" }));
    add("t1", entry({ kind: "tool", tool: { name: "ls", kind: "search", target: "x", ok: true, endedAt: 3 } }));
    add("t1", entry({ kind: "text", text: "**원인** 매분 0초에만 그렸어요.\n\n![](/tmp/after.png)" }));
    setState("tasks", (t) => t.id === "t1", "status", "done");
    await workTick(4000);
    expect(sent).toEqual([["c1", "고쳤으니 찍어볼게"]]);
    expect(files.map(([, p]) => p)).toEqual([expect.stringMatching(/\/Library\/Application Support\/x\/before\.png$/), "/tmp/after.png"]);
  });

  it("two jobs in one channel: each batch says whose it is", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } }), job({ id: "t2", title: "메뉴 막대 초", agent: { channel: "c1" } })]);
    await workTick(1000);
    add("t2", entry({ kind: "text", text: "초 표시 보는 중" }));
    add("t2", entry({ kind: "tool", tool: { name: "ls", kind: "search", target: "x", ok: true, endedAt: 3 } }));
    await workTick(4000);
    expect(sent).toEqual([["c1", "-# 메뉴 막대 초\n초 표시 보는 중"]]);
  });

  it("what came before Ondra was watching isn't replayed", async () => {
    setState("tasks", [job({ agent: { channel: "c1" }, entries: [entry({ kind: "text", text: "옛날 말" }, 10)] })]);
    await workTick(1000);
    expect(sent).toEqual([]);
    expect(state.tasks).toHaveLength(1);
  });
});

describe("a step as a line", () => {
  it("tests from vitest, cargo and pytest", () => {
    expect(testLine(" Tests  1541 passed (1541)", true)).toBe("테스트 돌림 → 1541 통과");
    expect(testLine("test result: ok. 4 passed; 0 failed; 0 ignored", true)).toBe("테스트 돌림 → 4 통과");
    expect(testLine("==== 2 failed, 10 passed in 1.2s ====\nE   AssertionError: boom", false)).toBe("테스트 돌림 → 10 통과 / 2 실패\n  ↳ E   AssertionError: boom");
  });
  it("a build, a push; a plain command says nothing", () => {
    expect(stepLine({ name: "bash", kind: "bash", target: "", detail: "npx tsc --noEmit", ok: true, endedAt: 1 })).toBe("빌드 돌림 → 통과");
    expect(stepLine({ name: "bash", kind: "bash", target: "", detail: "git push -u origin feat/x", ok: true, endedAt: 1 })).toBe("푸시함");
    expect(stepLine({ name: "bash", kind: "bash", target: "", detail: "ls -la", ok: true, endedAt: 1 })).toBeUndefined();
  });
});
