import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { resetWorkLog, workTick } from "./workLog";
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

  it("only its own words show, a few at a time; no stock line about a skill, a test, a commit or a PR", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } })]);
    await workTick(1000);
    add("t1", entry({ kind: "text", text: "이거부터 읽어볼게" }));
    add("t1", entry({ kind: "tool", tool: { name: "read", kind: "read", target: "SKILL.md", detail: "/Users/me/.ondra/skills/code-review/SKILL.md" } }));
    await workTick(4000);
    expect(sent).toEqual([["c1", "이거부터 읽어볼게"]]);
    expect(typing).toEqual(["c1"]);
    setState("tasks", (t) => t.id === "t1", "shells", [{ id: "s1", command: "pnpm vitest run", startedAt: 1, endedAt: 2, ok: false, tail: " Tests  3 failed | 1541 passed (1544)" }]);
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "test", target: "pnpm vitest run", detail: "pnpm vitest run", shellId: "s1", ok: false, endedAt: 3 } }));
    add("t1", entry({ kind: "spawn", childIds: ["k1"] }));
    await workTick(7000);
    expect(sent).toHaveLength(1);
    add("t1", entry({ kind: "text", text: "3개 깨짐. 탭 순서 문제네" }));
    add("t1", entry({ kind: "tool", tool: { name: "edit", kind: "edit", target: "a.ts" } }));
    await workTick(10000);
    expect(sent[1]).toEqual(["c1", "3개 깨짐. 탭 순서 문제네"]);
    await workTick(13000);
    expect(sent).toHaveLength(2);
  });

  it("a picture goes up when it puts one in its words, not every screenshot it looked at; none when it chose to leave them out", async () => {
    setState("tasks", [job({ agent: { channel: "c1" } }), job({ id: "t2", agent: { channel: "c1", shots: false } })]);
    await workTick(1000);
    const shot = { name: "read", kind: "read", target: "after.png", detail: "/tmp/after.png", image: "/tmp/after.png", ok: true, endedAt: 3 };
    add("t1", entry({ kind: "tool", tool: shot }));
    add("t2", entry({ kind: "tool", tool: shot }));
    await workTick(4000);
    expect(files).toEqual([]);
    for (const id of ["t1", "t2"]) {
      add(id, entry({ kind: "text", text: "고친 뒤 화면 ![](/tmp/after.png)" }));
      add(id, entry({ kind: "tool", tool: { name: "ls", kind: "search", target: "x" } }));
    }
    await workTick(7000);
    expect(files).toEqual([["c1", "/tmp/after.png"]]);
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

  it("working for a while with nothing said there, it is reminded to say where it is; nothing is said for it", async () => {
    const tasks = await import("./tasks");
    const whisper = vi.spyOn(tasks, "whisper").mockReturnValue(true);
    setState("tasks", [job({ agent: { channel: "c1" } })]);
    await workTick(1000);
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "bash", target: "git diff" } }, 2000));
    await workTick(60_000);
    expect(whisper).not.toHaveBeenCalled();
    await workTick(1000 + 2 * 60_000);
    expect(whisper).toHaveBeenCalledTimes(1);
    expect(whisper.mock.calls[0][1]).toContain("heard nothing from you for 2 minutes");
    // not again right away; and what it says resets the clock
    await workTick(1000 + 3 * 60_000);
    expect(whisper).toHaveBeenCalledTimes(1);
    add("t1", entry({ kind: "text", text: "diff 다 읽었어, 검색 쪽이 수상해" }, 200_000));
    add("t1", entry({ kind: "tool", tool: { name: "bash", kind: "bash", target: "swift build" } }, 200_001));
    await workTick(1000 + 4 * 60_000);
    expect(sent.at(-1)).toEqual(["c1", "diff 다 읽었어, 검색 쪽이 수상해"]);
    await workTick(1000 + 5 * 60_000);
    expect(whisper).toHaveBeenCalledTimes(1);
    expect(sent.every(([, t]) => !t.includes("Ondra"))).toBe(true);
    // the job is told to work out loud
    expect(inOpenNote({ agent: { channel: "c1" } })).toContain("silence there reads as stopped");
    whisper.mockRestore();
  });

  it("what came before Ondra was watching isn't replayed", async () => {
    setState("tasks", [job({ agent: { channel: "c1" }, entries: [entry({ kind: "text", text: "옛날 말" }, 10)] })]);
    await workTick(1000);
    expect(sent).toEqual([]);
    expect(state.tasks).toHaveLength(1);
  });
});


describe("its words, in the user's language", () => {
  it("an English mutter in Korean talk isn't for them; commands, code and names in Korean lines are", async () => {
    const { forThem, englishLine } = await import("./tongue");
    expect(englishLine("Sent once at the bottom. Releasing the session.")).toBe(true);
    expect(englishLine("pnpm test 돌리는 중")).toBe(false);
    expect(englishLine("`pnpm run build --watch now`")).toBe(false);
    expect(englishLine("ok")).toBe(false);
    // English built around a name in Korean is still English; Korean with English terms is Korean
    expect(englishLine("Next reel for 민정원.")).toBe(true);
    expect(englishLine("Good. Send to 민정원.")).toBe(true);
    expect(englishLine("Claude Code 세션 login 확인")).toBe(false);
    expect(englishLine("PR #96 재리뷰 남겼어. 머지는 안 했어")).toBe(false);
    expect(englishLine("build 돌리고 test 통과하면 merge 할게")).toBe(false);
    expect(forThem("Checking the room first.\n방 확인했어\n```\nnpm run the whole build\n```", "방 좀 봐줘")).toBe("방 확인했어\n```\nnpm run the whole build\n```");
    // whoever writes English (or nothing to tell by) gets it whole, whatever the agent's own voice
    expect(forThem("Running the tests now.", "can you run the tests?")).toBe("Running the tests now.");
    expect(forThem("Running the tests now.")).toBe("Running the tests now.");
    expect(forThem("Sure, I checked it for you.\n방 봤어", "방 봐줘\nplease check it")).toBe("Sure, I checked it for you.\n방 봤어");
    // any non-Latin script, not only Korean
    expect(forThem("I will answer in Japanese now.\nはい、できました", "テストを実行して")).toBe("はい、できました");
    expect(forThem("Let me think about this one.\nГотово", "Запусти тесты")).toBe("Готово");
  });
});
