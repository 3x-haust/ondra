import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import type { DiscordEvent, DiscordMessage } from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { AgentSettings } from "../state/types";

const model = vi.hoisted(() => ({
  thrown: [] as { text: string; space: string; opts: { project?: string; note?: string; discord?: unknown } }[],
  events: [] as { space: string; project: string; text: string; onError?: () => void }[],
  prompts: [] as string[], answer: "", answers: [] as string[],
}));
vi.mock("./captain", () => ({
  throwThought: (text: string, space: string, opts: any) => model.thrown.push({ text, space, opts }),
  notifyChat: (space: string, project: string, text: string, onError?: () => void) => model.events.push({ space, project, text, onError }),
}));
vi.mock("./aside", () => ({ oneShot: async (_s: string, _c: string, prompt: string) => (model.prompts.push(prompt), model.answers.shift() ?? model.answer) }));

import { agentNote, agentStatus, BANTER, calledIn, cleanText, DEFAULT_VOICE, digest, notifyQuestions, OTHERS_RULES, ownerNote, recentTalk, startAgent, stopAgent, talkPrompt, WATCH_WAYS } from "./discord";

const BOT = "999";
const OWNER = "111";
const agent: AgentSettings = { on: true, name: "메타몽", ownerId: OWNER };
const owner = { id: OWNER, name: "성윤", bot: false };
const msg = (over: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id: "m1", channel: "c1", guild: "g1", author: { id: "222", name: "민수", bot: false },
  content: "", mentions: [], files: [], at: "", ...over,
});
const FOLLOW_UP = "- 내가 방금 말한 채널에서 5분 안에 주인이 이어서 하는 말은 나한테 하는 말로 받아";
let ways = "";
let emit: (ev: DiscordEvent) => void;
const ready = async () => {
  await startAgent();
  emit({ kind: "ready", id: BOT, name: "메타몽" });
};

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("settings", "agent", structuredClone(agent));
  model.thrown = [];
  model.events = [];
  model.prompts = [];
  model.answer = "";
  model.answers = [];
  ways = "";
  vi.spyOn(native, "onEvent").mockImplementation(async (_name, fn) => ((emit = fn as never), () => {}));
  vi.spyOn(native, "discordStart").mockResolvedValue();
  vi.spyOn(native, "discordStop").mockResolvedValue();
  vi.spyOn(native, "discordTyping").mockResolvedValue();
  vi.spyOn(native, "discordHistory").mockResolvedValue([]);
  vi.spyOn(native, "discordSend").mockResolvedValue(["s1"]);
  vi.spyOn(native, "discordSendFile").mockResolvedValue(["f1"]);
  vi.spyOn(native, "discordDelete").mockResolvedValue();
  vi.spyOn(native, "discordOwner").mockResolvedValue("444");
  vi.spyOn(native, "discordReact").mockResolvedValue();
  vi.spyOn(native, "discordUnreact").mockResolvedValue();
  vi.spyOn(native, "discordSaveFile").mockImplementation(async (url) => `/data/attachments/discord/${url.split("/").pop()!.split("?")[0]}`);
  vi.spyOn(native, "engineInfo").mockResolvedValue({ enginePath: null, engineVersion: null, dataDir: "/data", home: "/Users/me" });
  vi.spyOn(native, "fsRead").mockImplementation(async () => ({ text: ways, size: ways.length, binary: false, modified: 1 }));
});
afterEach(() => {
  stopAgent();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Discord transport and addressing", () => {
  it("connects, resumes and stops without choosing a chat action", async () => {
    await ready();
    expect(native.discordStart).toHaveBeenCalledOnce();
    expect(agentStatus()).toEqual({ state: "on", name: "메타몽" });
    emit({ kind: "reconnecting", in: 1000 });
    expect(agentStatus().state).toBe("connecting");
    emit({ kind: "resumed" });
    expect(agentStatus().state).toBe("on");
    stopAgent();
    expect(agentStatus().state).toBe("off");
    expect(native.discordSend).not.toHaveBeenCalled();
  });

  it("a DM, mention, reply or name is addressed to the agent", () => {
    for (const m of [msg({ guild: null }), msg({ mentions: [BOT] }), msg({ reply_to: BOT }), msg({ content: "메타몽 자냐" })]) expect(calledIn(m, agent, BOT)).toBe(true);
    expect(calledIn(msg({ content: "오늘 점심 뭐 먹지" }), agent, BOT)).toBe(false);
    expect(cleanText(msg({ content: `<@${BOT}> PR 봐줘`, files: ["https://cdn/a.png"] }), agent, BOT)).toBe("메타몽 PR 봐줘\nhttps://cdn/a.png");
  });

  it("sends owner input to the private agent chat without a reaction, reply or typing", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "m9", author: owner, content: "메타몽 로그인 버그 고쳐줘" }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(1));
    expect(model.thrown[0]).toMatchObject({ text: "메타몽 로그인 버그 고쳐줘", opts: { project: "@agent", discord: { channel: "c1", message: "m9" } } });
    expect(model.thrown[0].opts.note).toContain("server g1, channel c1");
    expect(native.discordReact).not.toHaveBeenCalled();
    expect(native.discordTyping).not.toHaveBeenCalled();
    expect(native.discordSend).not.toHaveBeenCalled();
  });

  it("passes deletion and choice words to the model, not a regex command", async () => {
    await ready();
    for (const content of ["메타몽 그거 지워", "메타몽 2"]) emit({ kind: "message", message: msg({ author: owner, content, reply_to: BOT, reply_msg: "s1" }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(2));
    expect(model.thrown.map((x) => x.text)).toEqual(["메타몽 그거 지워", "메타몽 2"]);
    expect(model.thrown[0].opts.note).toContain("replies to message s1");
    expect(native.discordDelete).not.toHaveBeenCalled();
  });

  it("does not join messages or hold them based on typing events", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "a1", guild: null, author: owner, content: "아니" }) });
    emit({ kind: "typing", channel: "c1", user: OWNER });
    emit({ kind: "message", message: msg({ id: "a2", guild: null, author: owner, content: "주인 말 들어야지" }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(2));
    expect(model.thrown.map((x) => x.text)).toEqual(["아니", "주인 말 들어야지"]);
  });

  it("retains attachment downloads and leaves failed downloads as links", async () => {
    await ready();
    const url = "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1";
    emit({ kind: "message", message: msg({ author: owner, content: "메타몽 이거 봐", files: [url] }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(1));
    expect(model.thrown[0].text).toBe("메타몽 이거 봐\n\n첨부한 파일:\n- /data/attachments/discord/shot.png");
    vi.mocked(native.discordSaveFile).mockRejectedValue("404");
    emit({ kind: "message", message: msg({ author: owner, content: "메타몽 다시", files: [url] }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(2));
    expect(model.thrown[1].text).toContain(url);
  });

  it("includes history ids and reply facts so the model can choose its action", async () => {
    vi.mocked(native.discordHistory).mockResolvedValue([msg({ id: "h1", author: { id: BOT, name: "몽", bot: true }, content: "PR 올렸어", at: new Date().toISOString() })]);
    await ready();
    emit({ kind: "message", message: msg({ author: owner, content: "메타몽 왜", reply_msg: "h1", reply_to: BOT }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(1));
    expect(model.thrown[0].opts.note).toContain("[h1] (방금) 메타몽(너): PR 올렸어");
    expect(model.thrown[0].opts.note).toContain("replies to message h1");
    expect(recentTalk(agent, [], BOT)).toBe("");
  });

  it("discovers the owner without exposing another user's work", async () => {
    setState("settings", "agent", "ownerId", undefined);
    await ready();
    await vi.waitFor(() => expect(state.settings.agent?.ownerId).toBe("444"));
  });
});

describe("instructions, not automatic outgoing messages", () => {
  it("reads current ways and voice on every kind of agent turn", async () => {
    ways = FOLLOW_UP;
    const first = await agentNote();
    expect(first).toContain(FOLLOW_UP);
    expect(first).toContain(DEFAULT_VOICE);
    expect(first).toContain("NOT posted automatically");
    expect(first).toContain("/data/agent/AGENT.md");
    expect(first).toContain("not a relay");
    ways = "- 이 채널에서는 리액션만 해";
    setState("settings", "agent", "voice", "짧게 반말로");
    const next = await agentNote();
    expect(next).toContain(ways);
    expect(next).not.toContain(FOLLOW_UP);
    expect(next).toContain("짧게 반말로");
    expect(next).not.toContain(DEFAULT_VOICE);
    expect(ownerNote(msg(), agent)).toContain("others read too");
    expect(ownerNote(msg({ guild: null }), agent)).not.toContain("others read too");
  });

  it("does not copy replies, work logs, screenshots or completion reports", async () => {
    vi.useFakeTimers();
    await ready();
    setState("tasks", [{ id: "t1", space: "home", title: "탭", status: "running", agent: { channel: "c1", room: "c2" }, entries: [
      { id: "e1", at: Date.now(), kind: "text", text: "고치고 있어" },
      { id: "e2", at: Date.now(), kind: "tool", tool: { name: "read", kind: "read", image: "/tmp/shot.png" } },
    ], shells: [] } as never]);
    setState("captain", [{ id: "reply", space: "home", project: "@agent", from: "captain", at: 1, after: "t1", reply: "다 고쳤어 https://github.com/example/repo/pull/1" }]);
    await vi.advanceTimersByTimeAsync(4000);
    setState("tasks", (t) => t.id === "t1", "status", "done");
    await vi.advanceTimersByTimeAsync(4000);
    expect(native.discordSend).not.toHaveBeenCalled();
    expect(native.discordSendFile).not.toHaveBeenCalled();
    expect(native.discordTyping).not.toHaveBeenCalled();
  });

  it("delivers job question facts to the model once, without posting a question", async () => {
    setState("tasks", [{ id: "t1", space: "home", title: "배포", agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d1", taskId: "t1", at: 1, kind: "ask", question: "어디에?", options: [{ id: "a", label: "운영" }], context: [] }]);
    await notifyQuestions();
    await notifyQuestions();
    expect(model.events).toHaveLength(1);
    expect(model.events[0]).toMatchObject({ space: "home", project: "@agent" });
    expect(model.events[0].text).toContain("Question d1: 어디에?");
    expect(model.events[0].text).toContain("a: 운영");
    expect(native.discordSend).not.toHaveBeenCalled();
    expect(state.decisions[0].posted).toBe("c1");
  });

  it("forwards unaddressed owner answers with posted question facts without interpreting choices", async () => {
    setState("tasks", [{ id: "t1", space: "home", title: "배포", agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d1", taskId: "t1", at: 1, kind: "ask", posted: "c1", question: "어디에?", options: [{ id: "a", label: "운영" }], context: [] }]);
    await ready();
    emit({ kind: "message", message: msg({ author: owner, content: "첫 번째 말고 다른 데는?" }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(1));
    expect(model.thrown[0].text).toBe("첫 번째 말고 다른 데는?");
    expect(model.thrown[0].opts.note).toContain("Question d1: 어디에?");
    expect(model.thrown[0].opts.note).toContain("a: 운영");
    expect(state.decisions).toHaveLength(1);
    expect(native.discordSend).not.toHaveBeenCalled();
  });

  it("allows failed question delivery to be notified again", async () => {
    setState("tasks", [{ id: "t1", space: "home", title: "배포", agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d1", taskId: "t1", at: 1, kind: "ask", question: "어디에?", options: [], context: [] }]);
    await notifyQuestions();
    expect(model.events[0].onError).toBeTypeOf("function");
    model.events[0].onError!();
    expect(state.decisions[0].posted).toBeUndefined();
    await notifyQuestions();
    expect(model.events).toHaveLength(2);
    expect(state.decisions[0].posted).toBe("c1");
    expect(native.discordSend).not.toHaveBeenCalled();
  });

  it("supplies owner identity and public social memory on event turns, never DM cards or work memory", async () => {
    setState("agentNotes", [
      { id: "p", kind: "person", who: "222", name: "민수", text: "백엔드 친구", at: 1 },
      { id: "dm", kind: "person", who: OWNER, dm: true, text: "비공개 약속", at: 1 },
      { id: "g", kind: "place", place: "g1", text: "개발자 모임", at: 1 },
      { id: "l", kind: "lesson", text: "답하기 전에 읽기", at: 1 },
    ]);
    setState("tasks", [{ id: "secret", title: "비밀 출시 준비" } as never]);
    const note = await agentNote();
    expect(note).toContain(`Owner Discord id: ${OWNER}`);
    for (const fact of ["백엔드 친구", "g1", "개발자 모임", "답하기 전에 읽기"]) expect(note).toContain(fact);
    for (const secret of ["비공개 약속", "비밀 출시 준비"]) expect(note).not.toContain(secret);
    expect(note).toContain('"kind":"decide"');
    expect(note).not.toContain("usual append route");
    expect(note).toContain("latest channel history before speaking");
    setState("agentNotes", (n) => n.id === "l", "text", "새로운 교훈");
    expect(await agentNote()).toContain("새로운 교훈");
  });

  it("does not turn app questions or disabled-agent events into Discord work", async () => {
    setState("tasks", [{ id: "app", space: "home" } as never]);
    setState("decisions", [{ id: "d1", taskId: "app", at: 1, kind: "ask", question: "어디에?", options: [], context: [] }]);
    await notifyQuestions();
    setState("tasks", [{ id: "app", space: "home", agent: { channel: "c1" } } as never]);
    setState("settings", "agent", "on", false);
    await notifyQuestions();
    expect(model.events).toEqual([]);
    expect(native.discordSend).not.toHaveBeenCalled();
  });
});

describe("talk-only access and separate social memory", () => {
  it("keeps other people's model free of work context and tools", async () => {
    setState("tasks", [{ id: "secret", title: "비밀 출시 준비" } as never]);
    model.answer = JSON.stringify({ action: "send", text: "그건 주인만 시킬 수 있어" });
    await ready();
    emit({ kind: "message", message: msg({ content: "메타몽 출시 링크 줘" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "그건 주인만 시킬 수 있어", undefined));
    expect(model.thrown).toEqual([]);
    expect(model.prompts[0]).toContain(OTHERS_RULES);
    expect(model.prompts[0]).toContain(BANTER);
    expect(model.prompts[0]).not.toContain("비밀 출시 준비");
    expect(OTHERS_RULES).toContain("주인 계정이 직접 한 말");
  });

  it("lets the model skip, react or take an unaddressed message using the user's ways", async () => {
    ways = FOLLOW_UP;
    await ready();
    model.answer = JSON.stringify({ action: "skip" });
    emit({ kind: "message", message: msg({ author: owner, content: "점심 뭐 먹지" }) });
    await vi.waitFor(() => expect(model.prompts).toHaveLength(1));
    expect(model.prompts[0]).toContain(WATCH_WAYS);
    expect(model.prompts[0]).toContain(FOLLOW_UP);
    expect(native.discordSend).not.toHaveBeenCalled();
    model.answer = JSON.stringify({ action: "react", message: "m2", emoji: "😂" });
    emit({ kind: "message", message: msg({ id: "m2", content: "배포 끝" }) });
    await vi.waitFor(() => expect(native.discordReact).toHaveBeenCalledWith("c1", "m2", "😂"));
    model.answer = JSON.stringify({ action: "take" });
    emit({ kind: "message", message: msg({ author: owner, content: "릴리즈해" }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(1));
    expect(model.thrown[0].text).toBe("릴리즈해");
    expect(talkPrompt(agent, "민수", [], "hi", BOT, "", { owner: false })).toContain(OTHERS_RULES);
  });

  it.each(["take", "(take)"])("does not route an unstructured take output to owner work: %s", async (answer) => {
    vi.useFakeTimers();
    ways = FOLLOW_UP;
    model.answer = answer;
    await ready();
    emit({ kind: "message", message: msg({ author: owner, content: "릴리즈해" }) });
    await vi.advanceTimersByTimeAsync(10);
    expect(model.prompts).toHaveLength(1);
    expect(model.thrown).toEqual([]);
    expect(native.discordSend).not.toHaveBeenCalled();
    expect(native.discordReact).not.toHaveBeenCalled();
  });

  it("lets a directly addressed person choose a reaction without access to work tools", async () => {
    model.answer = JSON.stringify({ action: "react", message: "m1", emoji: "🎉" });
    await ready();
    emit({ kind: "message", message: msg({ content: "메타몽 축하해 줘" }) });
    await vi.waitFor(() => expect(native.discordReact).toHaveBeenCalledWith("c1", "m1", "🎉"));
    expect(native.discordSend).not.toHaveBeenCalled();
    expect(model.thrown).toEqual([]);
    expect(model.prompts[0]).toContain("m1");
    expect(native.discordHistory).toHaveBeenCalledWith("c1", undefined, 15);
  });

  it("lets the model read this channel's history and choose a reply target", async () => {
    model.answers = [JSON.stringify({ action: "history", before: "m1", limit: 10 }), JSON.stringify({ action: "send", text: "그 얘기는 이거야", reply_to: "h1" })];
    vi.mocked(native.discordHistory).mockResolvedValueOnce([msg({ id: "m2", content: "추가 설명" })]).mockResolvedValueOnce([msg({ id: "h1", content: "이전 질문" })]);
    await ready();
    emit({ kind: "message", message: msg({ content: "메타몽 아까 얘기 답해줘" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "그 얘기는 이거야", "h1"));
    expect(native.discordHistory).toHaveBeenNthCalledWith(1, "c1", undefined, 15);
    expect(native.discordHistory).toHaveBeenNthCalledWith(2, "c1", "m1", 10);
    expect(model.prompts[0]).toContain("추가 설명");
    expect(model.prompts[1]).toContain("이전 질문");
    expect(model.prompts[1]).toContain("추가 설명");
    expect(model.thrown).toEqual([]);
  });

  it.each([
    "그냥 답변 문자열", '{"action":"delete_message","message":"m1"}',
    '{"action":"send","channel":"private","text":"누출"}',
    '{"action":"history","channel":"private"}',
    '{"action":"history","limit":100}',
    '{"action":"send","text":"답변","reply_to":3}',
  ])("does not execute or post invalid or out-of-scope output: %s", async (answer) => {
    vi.useFakeTimers();
    model.answer = answer;
    await ready();
    emit({ kind: "message", message: msg({ content: "메타몽 hi" }) });
    await vi.advanceTimersByTimeAsync(10);
    expect(model.prompts).toHaveLength(1);
    expect(native.discordSend).not.toHaveBeenCalled();
    expect(native.discordReact).not.toHaveBeenCalled();
    expect(native.discordDelete).not.toHaveBeenCalled();
    expect(native.discordHistory).toHaveBeenCalledTimes(1);
    expect(model.thrown).toEqual([]);
  });

  it("ignores bots and unapproved channels, while an owner call remains available", async () => {
    vi.useFakeTimers();
    setState("settings", "agent", "channels", ["allowed"]);
    ways = FOLLOW_UP;
    await ready();
    emit({ kind: "message", message: msg({ content: "메타몽 hi", author: { id: "5", name: "봇", bot: true } }) });
    emit({ kind: "message", message: msg({ content: "메타몽 hi" }) });
    await vi.advanceTimersByTimeAsync(10);
    expect(model.prompts).toEqual([]);
    expect(model.thrown).toEqual([]);
    emit({ kind: "message", message: msg({ author: owner, content: "메타몽 hi" }) });
    await vi.advanceTimersByTimeAsync(10);
    expect(model.thrown).toHaveLength(1);
  });

  it("does not watch unaddressed messages without personal ways", async () => {
    vi.useFakeTimers();
    await ready();
    emit({ kind: "message", message: msg({ author: owner, content: "ㅇㅇ" }) });
    await vi.advanceTimersByTimeAsync(10);
    expect(model.prompts).toEqual([]);
    expect(model.thrown).toEqual([]);
  });

  it("remembers actual sent messages from the gateway separately from work memory", async () => {
    await ready();
    model.answer = JSON.stringify({ action: "send", text: "ㅋㅋ 반가워요" });
    emit({ kind: "message", message: msg({ content: "메타몽 안녕 나 백엔드 하는 민수야" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalled());
    emit({ kind: "message", message: msg({ id: "s1", author: { id: BOT, name: "몽", bot: true }, content: "ㅋㅋ 반가워요" }) });
    model.answer = '[{"kind":"person","who":"222","text":"백엔드 개발자 민수"}]';
    await digest("c1");
    expect(state.agentNotes?.[0]).toMatchObject({ who: "222", text: "백엔드 개발자 민수" });
    expect(state.memory).toEqual([]);
    model.answer = JSON.stringify({ action: "send", text: "오 민수님" });
    emit({ kind: "message", message: msg({ content: "메타몽 나 기억해?" }) });
    await vi.waitFor(() => expect(model.prompts).toHaveLength(3));
    expect(model.prompts[2]).toContain("백엔드 개발자 민수");
    emit({ kind: "message", message: msg({ author: owner, content: "메타몽 민수한테 인사해", mentions: ["222"] }) });
    await vi.waitFor(() => expect(model.thrown).toHaveLength(1));
    expect(model.thrown[0].opts.note).toContain("백엔드 개발자 민수");
  });
});
