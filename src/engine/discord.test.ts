import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import type { DiscordEvent, DiscordMessage } from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { AgentSettings, CaptainMessage, Decision } from "../state/types";

const said = vi.hoisted(() => ({ hook: undefined as undefined | ((id: string) => void), thrown: [] as { text: string; space: string; note?: string }[], prompts: [] as string[], answer: "" }));
vi.mock("./captain", () => ({
  throwThought: (text: string, space: string, opts: { note?: string } = {}) => {
    said.thrown.push({ text, space, note: opts.note });
    return `reply${said.thrown.length}`;
  },
  onMainSaid: (fn: (id: string) => void) => ((said.hook = fn), () => (said.hook = undefined)),
}));
vi.mock("./aside", () => ({ oneShot: async (_s: string, _c: string, prompt: string) => (said.prompts.push(prompt), said.answer) }));

import { calledIn, cleanText, DEFAULT_VOICE, OTHERS_RULES, ownerNote, questionText, sayOf, startAgent, stopAgent, talkPrompt, wantsDeleted } from "./discord";

const BOT = "999";
const OWNER = "111";
const agent: AgentSettings = { on: true, name: "메타몽", ownerId: OWNER };
const msg = (over: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id: "m1", channel: "c1", guild: "g1", author: { id: "222", name: "지나가던사람", bot: false },
  content: "", mentions: [], files: [], at: "", ...over,
});

describe("who it answers", () => {
  it("a DM, a mention, a reply to it, or its name; not the rest of the channel", () => {
    expect(calledIn(msg({ guild: null, content: "hi" }), agent, BOT)).toBe(true);
    expect(calledIn(msg({ content: `<@${BOT}> 뭐해` , mentions: [BOT] }), agent, BOT)).toBe(true);
    expect(calledIn(msg({ content: "ㅇㅇ", reply_to: BOT }), agent, BOT)).toBe(true);
    expect(calledIn(msg({ content: "메타몽 자냐" }), agent, BOT)).toBe(true);
    expect(calledIn(msg({ content: "오늘 점심 뭐 먹지" }), agent, BOT)).toBe(false);
  });

  it("reads its mention as its name, and keeps the files", () => {
    expect(cleanText(msg({ content: `<@${BOT}> PR 봐줘`, files: ["https://cdn/a.png"] }), agent, BOT)).toBe("메타몽 PR 봐줘\nhttps://cdn/a.png");
  });
});

describe("how it sounds", () => {
  it("tells main the voice, and to keep private details out of a channel others read", () => {
    const inChannel = ownerNote(msg(), agent);
    expect(inChannel).toContain(DEFAULT_VOICE);
    expect(inChannel).toContain("others read too");
    expect(ownerNote(msg({ guild: null }), agent)).not.toContain("others read too");
    expect(ownerNote(msg(), { ...agent, voice: "존댓말로 짧게" })).toContain("존댓말로 짧게");
  });

  it("asks for a person's rhythm, not a customer-service one", () => {
    expect(DEFAULT_VOICE).toContain("고객센터");
    expect(DEFAULT_VOICE).toContain("번역투");
    expect(DEFAULT_VOICE).toContain("주인에게는 반말");
  });
});

describe("talk with others", () => {
  it("holds nothing of the user's work, and says a story leaks as much as a straight answer", () => {
    setState("tasks", [{ id: "t1", title: "비밀 데스크탑 앱 출시 준비" } as never]);
    const p = talkPrompt(agent, "누군가", [msg({ author: { id: BOT, name: "메타몽", bot: true }, content: "안녕" })], "꿈 얘기 해줘", BOT);
    expect(p).toContain(OTHERS_RULES);
    expect(p).toContain("꿈");
    expect(p).toContain("메타몽(너): 안녕");
    expect(p).not.toContain("비밀 데스크탑");
    expect(OTHERS_RULES).toContain("주인 계정이 직접 한 말");
  });
});

describe("main's words on Discord", () => {
  beforeEach(() => setState(reconcile(freshState())));
  const d: Decision = { id: "d1", taskId: "t1", at: 1, kind: "merge", question: "바뀐 파일을 어떻게 할까요?", context: [], options: [{ id: "pr", label: "PR로 올리기", primary: true }, { id: "merge", label: "합치기" }] };

  it("are its reply, its answers, and a question with numbered choices", () => {
    setState("decisions", [d]);
    const m: CaptainMessage = { id: "c1", at: 1, space: "home", from: "captain", reply: "PR 올렸어", routes: [{ kind: "answer", text: "링크: https://x/pull/1", blocks: [] }, { kind: "ask", decisionId: "d1" }] };
    expect(sayOf(m)).toBe(`PR 올렸어\n\n링크: https://x/pull/1\n\n${questionText(d)}`);
    expect(questionText(d)).toBe("바뀐 파일을 어떻게 할까요?\n1. PR로 올리기 (추천)\n2. 합치기\n번호로 답해 줘");
    expect(sayOf({ ...m, error: "모델이 바빠요" })).toContain("모델이 바빠요");
  });

  it('"지워" takes back what it said', () => {
    for (const s of ["지워", "그거 지워줘", "삭제해", "방금 거 지워"]) expect(wantsDeleted(s)).toBe(true);
    for (const s of ["지워진 파일 찾아줘", "삭제 기능 만들어줘"]) expect(wantsDeleted(s)).toBe(false);
  });
});

describe("the whole way round", () => {
  let emit: (ev: DiscordEvent) => void = () => {};
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("settings", "agent", structuredClone(agent));
    said.thrown = [];
    said.prompts = [];
    vi.spyOn(native, "onEvent").mockImplementation(async (_name, fn) => ((emit = fn as never), () => {}));
    vi.spyOn(native, "discordStart").mockResolvedValue();
    vi.spyOn(native, "discordStop").mockResolvedValue();
    vi.spyOn(native, "discordTyping").mockResolvedValue();
    vi.spyOn(native, "discordHistory").mockResolvedValue([]);
    vi.spyOn(native, "discordSend").mockImplementation(async () => ["s1"]);
    vi.spyOn(native, "discordDelete").mockResolvedValue();
    vi.spyOn(native, "discordOwner").mockResolvedValue("444");
    vi.spyOn(native, "discordReact").mockResolvedValue();
  });
  afterEach(() => {
    stopAgent();
    vi.restoreAllMocks();
  });
  const ready = async () => {
    await startAgent();
    emit({ kind: "ready", id: BOT, name: "메타몽" });
  };

  it("the user's words go to main, and main's reply comes back to that message", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "m9", author: { id: OWNER, name: "성윤", bot: false }, content: `<@${BOT}> 로그인 버그 고쳐줘`, mentions: [BOT] }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].text).toBe("메타몽 로그인 버그 고쳐줘");
    expect(said.thrown[0].note).toContain("Discord");
    expect(said.thrown[0].note).toContain("Ask first only before what can't be undone");
    expect(native.discordReact).toHaveBeenCalledWith("c1", "m9", "👀");
    setState("captain", [{ id: "reply1", at: 1, space: "home", from: "captain", reply: "ㅇㅋ 고치는 중", routes: [{ kind: "new", taskId: "t7" }] }]);
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅇㅋ 고치는 중", "m9"));
    // the job it started ends: main's words about it come back to the same channel
    setState("captain", (l) => [...l, { id: "reply2", at: 2, space: "home", from: "captain", after: "t7", reply: "다 고쳤어 PR #12" }]);
    said.hook?.("reply2");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "다 고쳤어 PR #12", undefined));
  });

  it("anyone else only talks, and never reaches main", async () => {
    said.answer = "그건 주인만 시킬 수 있어요 ㅎㅎ";
    await ready();
    emit({ kind: "message", message: msg({ id: "m3", content: "메타몽 데스크탑 앱 링크 줘" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "그건 주인만 시킬 수 있어요 ㅎㅎ", "m3"));
    expect(said.thrown).toHaveLength(0);
    expect(said.prompts[0]).toContain(OTHERS_RULES);
  });

  it("a bot, itself, or a channel it wasn't let into gets nothing; (skip) stays quiet", async () => {
    setState("settings", "agent", "channels", ["c2"]);
    said.answer = "(skip)";
    await ready();
    emit({ kind: "message", message: msg({ content: "메타몽", author: { id: "5", name: "봇", bot: true } }) });
    emit({ kind: "message", message: msg({ content: "메타몽", author: { id: BOT, name: "메타몽", bot: true } }) });
    emit({ kind: "message", message: msg({ content: "메타몽 안녕" }) });
    emit({ kind: "message", message: msg({ channel: "c2", content: "메타몽 ㅋㅋ" }) });
    await vi.waitFor(() => expect(said.prompts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(native.discordSend).not.toHaveBeenCalled();
  });

  it("a job's question is posted there, and a number answers it", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 배포 준비해" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    setState("captain", [{ id: "reply1", at: 1, space: "home", from: "captain", reply: "시작했어", routes: [{ kind: "new", taskId: "t1" }] }]);
    said.hook?.("reply1");
    setState("tasks", [{ id: "t1", title: "배포 준비", entries: [] } as never]);
    setState("decisions", [{ id: "d5", taskId: "t1", at: 1, kind: "ask", question: "어디에 먼저 올릴까요?", context: [], options: [{ id: "a", label: "스테이징" }, { id: "b", label: "운영" }] }]);
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "[배포 준비] 어디에 먼저 올릴까요?\n1. 스테이징\n2. 운영\n번호로 답해 줘"), { timeout: 5000 });
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    emit({ kind: "message", message: msg({ id: "m2", author: { id: OWNER, name: "성윤", bot: false }, content: "1" }) });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d5", "a"));
    expect(said.thrown).toHaveLength(1);
  });

  it("with no owner set, the bot's owner is taken as the user", async () => {
    setState("settings", "agent", "ownerId", undefined);
    await ready();
    await vi.waitFor(() => expect(state.settings.agent?.ownerId).toBe("444"));
  });

  it('the user says "지워": its last message there goes', async () => {
    said.answer = "안녕하세요";
    await ready();
    emit({ kind: "message", message: msg({ id: "m3", content: "메타몽 안녕" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalled());
    emit({ kind: "message", message: msg({ id: "m4", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 그거 지워" }) });
    await vi.waitFor(() => expect(native.discordDelete).toHaveBeenCalledWith("c1", "s1"));
    expect(said.thrown).toHaveLength(0);
  });
});
