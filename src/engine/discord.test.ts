import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore node types are not in this project: the test runs under node
import { resolveObjectURL } from "node:buffer";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import type { DiscordEvent, DiscordMessage } from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { AgentSettings, CaptainMessage, Decision } from "../state/types";

const said = vi.hoisted(() => ({ hook: undefined as undefined | ((id: string) => void), endNote: undefined as undefined | ((t: { id: string; parentId?: string }) => string | undefined), thrown: [] as { text: string; space: string; note?: string; project?: string }[], prompts: [] as string[], answer: "" }));
vi.mock("./captain", async () => {
  const { setState } = await import("../state/store");
  return {
  AGENT_CHAT: "@agent",
  // like captain's: the user's words and a pending reply, in the chat asked for
  throwThought: (text: string, space: string, opts: { note?: string; project?: string; discord?: { channel: string; message: string } } = {}) => {
    said.thrown.push({ text, space, note: opts.note, project: opts.project });
    const n = said.thrown.length;
    setState("captain", (l: CaptainMessage[]) => [...l, { id: `me${n}`, at: n, space, project: opts.project, from: "me", text, discord: opts.discord }, { id: `reply${n}`, at: n, space, project: opts.project, from: "captain", pending: true }]);
    return `reply${n}`;
  },
  onMainSaid: (fn: (id: string) => void) => ((said.hook = fn), () => (said.hook = undefined)),
  onJobEndNote: (fn: (t: { id: string }) => string | undefined) => ((said.endNote = fn), () => (said.endNote = undefined)),
  };
});
vi.mock("./aside", () => ({ oneShot: async (_s: string, _c: string, prompt: string) => (said.prompts.push(prompt), said.answer) }));

import { askedLine, askPrompt, calledIn, cleanText, DEFAULT_VOICE, digest, OTHERS_RULES, ownerNote, pickPrompt, sayOf, startAgent, stopAgent, talkPrompt, wantsDeleted, WATCH_WAYS } from "./discord";

/** what a user keeps in their own rules file: their line right after it spoke in a channel is for it */
const FOLLOW_UP = `function listen(message, ctx) {
  if (!ctx.owner || ctx.called) return;
  const last = ctx.recent[ctx.recent.length - 1];
  if (last && last.me && ctx.now - last.at < 5 * 60_000) return true;
}`;
/** and the rest of a server channel's talk it watches: a line, a reaction, or nothing, as it sees fit */
const WATCH_REST = `function listen(message, ctx) {
  const last = ctx.recent[ctx.recent.length - 1];
  if (ctx.owner && last?.me && ctx.now - last.at < 5 * 60_000) return true;
  if (message.guild && !ctx.called) return "watch";
}`;
const rules = { text: undefined as string | undefined };
/** a page's Worker, run here: the script it is made from, with its own self and postMessage */
class PageWorker {
  onmessage?: (e: { data: unknown }) => void;
  private ready: Promise<(data: unknown) => void>;
  constructor(url: string) {
    this.ready = resolveObjectURL(url)!.text().then((code: string) => {
      const self: { onmessage?: (e: { data: unknown }) => void } = {};
      new Function("self", "postMessage", code)(self, (data: unknown) => this.onmessage?.({ data }));
      return (data: unknown) => self.onmessage?.({ data });
    });
  }
  postMessage(data: unknown) {
    void this.ready.then((send) => send(data));
  }
  terminate() {}
}

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

  it("is a person talking, not a list of rules", () => {
    expect(DEFAULT_VOICE).toContain("옆자리 동료");
    expect(DEFAULT_VOICE).toContain("주인한테는 반말");
    expect(DEFAULT_VOICE).not.toContain("금지");
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
    expect(p).toContain("너를 부른 게 아닌 말이면");
  });

  it("watching, it may let it pass, react or chime in, and isn't told to skip what wasn't for it", () => {
    const p = talkPrompt(agent, "성윤", [msg({ author: { id: OWNER, name: "성윤", bot: false }, content: "오늘 배포 끝" })], "드디어 퇴근", BOT, "", { owner: true });
    expect(p).toContain(WATCH_WAYS);
    expect(p).toContain("성윤(주인): 오늘 배포 끝");
    expect(p).toContain("(react 이모지)");
    expect(p).not.toContain("너를 부른 게 아닌 말이면");
    expect(p).not.toContain(OTHERS_RULES);
    expect(talkPrompt(agent, "민수", [], "ㅇㅇ", BOT, "", { owner: false })).toContain(OTHERS_RULES);
  });
});

describe("main's words on Discord", () => {
  beforeEach(() => setState(reconcile(freshState())));
  const d: Decision = { id: "d1", taskId: "t1", at: 1, kind: "merge", question: "바뀐 파일을 어떻게 할까요?", context: [], options: [{ id: "pr", label: "PR로 올리기", primary: true }, { id: "merge", label: "합치기" }] };

  it("are its reply, its answers, and a question, as it would ask it", () => {
    setState("decisions", [d]);
    const m: CaptainMessage = { id: "c1", at: 1, space: "home", from: "captain", reply: "PR 올렸어", routes: [{ kind: "answer", text: "링크: https://x/pull/1", blocks: [] }, { kind: "ask", decisionId: "d1" }] };
    expect(sayOf(m, { d1: "남은 파일 PR로 올릴까 버릴까" })).toBe("PR 올렸어\n\n링크: https://x/pull/1\n\n남은 파일 PR로 올릴까 버릴까");
    // its reply already asked it
    expect(sayOf(m, { d1: "" })).toBe("PR 올렸어\n\n링크: https://x/pull/1");
    expect(sayOf(m)).toContain("바뀐 파일을 어떻게 할까요? (PR로 올리기 / 합치기)");
    expect(sayOf({ ...m, error: "모델이 바빠요" })).toContain("모델이 바빠요");
  });

  it("a question is said in its own voice from the app's wording, and a plain answer picks a choice", async () => {
    const p = askPrompt({ on: true, name: "메타몽" }, d, "Orbit 이슈 #49", "PR 올렸어");
    expect(p).toContain(DEFAULT_VOICE);
    expect(p).toContain("# 하던 일\nOrbit 이슈 #49");
    expect(p).toContain("- PR로 올리기 (이게 낫다고 봄)");
    expect(p).toContain("PR 올렸어");
    said.answer = "남은 거 PR로 올릴까 그냥 합칠까? 난 PR";
    expect(await askedLine(d, { on: true, name: "메타몽" })).toBe(said.answer);
    said.answer = "(skip)";
    expect(await askedLine(d, { on: true, name: "메타몽" }, undefined, "PR로 올릴까?")).toBe("");
    said.answer = "";
    expect(await askedLine(d, { on: true, name: "메타몽" }, "배포")).toBe("배포: 바뀐 파일을 어떻게 할까요? (PR로 올리기 / 합치기)");
    expect(pickPrompt(d, "그냥 합쳐")).toContain("pr: PR로 올리기 (1번)");
  });

  it("the voice is a person with an example talk, and holds none of the user's real work", () => {
    expect(DEFAULT_VOICE).toContain("이런 느낌이야");
    expect(DEFAULT_VOICE).not.toMatch(/Orbit|github\.com|#\d/);
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
    rules.text = undefined;
    vi.spyOn(native, "engineInfo").mockResolvedValue({ enginePath: null, engineVersion: null, dataDir: "/data", home: "/Users/me" });
    vi.spyOn(native, "fsRead").mockImplementation(async (path) => {
      if (path !== "/data/agent/rules.js" || rules.text === undefined) throw "파일이 없어요";
      return { text: rules.text, size: rules.text.length, binary: false, modified: 1 };
    });
    vi.stubGlobal("Worker", PageWorker);
  });
  afterEach(() => {
    stopAgent();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const ready = async () => {
    await startAgent();
    emit({ kind: "ready", id: BOT, name: "메타몽" });
  };

  it("the user's words go to its own chat (not main), and its reply comes back to that message", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "m9", author: { id: OWNER, name: "성윤", bot: false }, content: `<@${BOT}> 로그인 버그 고쳐줘`, mentions: [BOT] }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].text).toBe("메타몽 로그인 버그 고쳐줘");
    expect(said.thrown[0].project).toBe("@agent");
    expect(said.thrown[0].note).toContain("Discord");
    expect(said.thrown[0].note).toContain("Ask first only before what can't be undone");
    // it is the one doing the work, not a relay that sends it somewhere
    expect(said.thrown[0].note).toContain("You are the agent yourself, the one doing the work, not a relay");
    expect(said.thrown[0].note).toContain("잡으러 보냈어");
    expect(native.discordReact).toHaveBeenCalledWith("c1", "m9", "👀");
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "ㅇㅋ 고치는 중", routes: [{ kind: "new", taskId: "t7" }] });
    // the job it started is the agent's, and knows where to report (captain sets this)
    setState("tasks", [{ id: "t7", title: "로그인 버그", entries: [], agent: { channel: "c1" } } as never]);
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅇㅋ 고치는 중", "m9"));
    // main's own words never go to Discord
    setState("captain", (l) => [...l, { id: "main1", at: 3, space: "home", from: "captain", reply: "메인 답" }]);
    said.hook?.("main1");
    // the job it started ends: main hears to write about it as the agent, in its voice and as the one who did it
    expect(said.endNote?.({ id: "t7" })).toContain("as the one who did it");
    expect(said.endNote?.({ id: "t7" })).toContain(DEFAULT_VOICE);
    expect(said.endNote?.({ id: "t7" })).toContain("server channel others read");
    expect(said.endNote?.({ id: "other" })).toBeUndefined();
    // the job it started ends: main's words about it come back to the same channel
    setState("captain", (l) => [...l, { id: "reply2", at: 4, space: "home", project: "@agent", from: "captain", after: "t7", reply: "다 고쳤어 PR #12" }]);
    said.hook?.("reply2");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "다 고쳤어 PR #12", undefined));
    expect(native.discordSend).not.toHaveBeenCalledWith(expect.anything(), "메인 답", expect.anything());
  });

  const owner = { id: OWNER, name: "성윤", bot: false };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const asked = async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", author: owner, content: "메타몽 Orbit 어때" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    // main answers in the agent's own chat, after the user's words (which keep where they came from)
    setState("captain", (l) => l.map((m) => (m.id === "reply1" ? { ...m, pending: false, reply: "Orbit 릴리즈할까?" } : m)));
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "Orbit 릴리즈할까?", "m1"));
    await settle();
    emit({ kind: "message", message: msg({ id: "m2", author: owner, content: "릴리즈해" }) });
  };

  it("with no rules of the user's own, their answer right after it spoke still needs a mention", async () => {
    await asked();
    await settle();
    expect(said.thrown).toHaveLength(1);
    // main hears where the user's own rules for it are, to write them when asked
    expect(said.thrown[0].note).toContain("/data/agent/rules.js");
  });

  it("the user's own rules decide: their answer right after it spoke reaches it without a mention", async () => {
    rules.text = FOLLOW_UP;
    await asked();
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
    expect(said.thrown[1].text).toBe("릴리즈해");
  });

  it("with that rule, once someone else spoke or a while went by, the user's words are theirs again", async () => {
    rules.text = FOLLOW_UP;
    said.answer = "안녕하세요";
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", content: "메타몽 안녕" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalled());
    await settle();
    emit({ kind: "message", message: msg({ id: "m2", author: { id: "333", name: "민수", bot: false }, content: "ㅋㅋ" }) });
    emit({ kind: "message", message: msg({ id: "m3", author: owner, content: "점심 뭐 먹지" }) });
    emit({ kind: "message", message: msg({ id: "m4", content: "메타몽 또 안녕" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledTimes(2));
    await settle();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
    emit({ kind: "message", message: msg({ id: "m5", author: owner, content: "저녁 뭐 먹지" }) });
    await settle();
    expect(said.thrown).toHaveLength(0);
  });

  it("a rule that watches: talk not for it gets nothing, a reaction or a line, never main; a call still gets an answer", async () => {
    rules.text = WATCH_REST;
    await ready();
    said.answer = "(skip)";
    emit({ kind: "message", message: msg({ id: "m1", author: owner, content: "점심 뭐 먹지" }) });
    await vi.waitFor(() => expect(said.prompts).toHaveLength(1));
    expect(said.prompts[0]).toContain(WATCH_WAYS);
    await settle();
    said.answer = "(react 😂)";
    emit({ kind: "message", message: msg({ id: "m2", content: "어제 배포하다 키보드 부서짐 ㅋㅋ" }) });
    await vi.waitFor(() => expect(native.discordReact).toHaveBeenCalledWith("c1", "m2", "😂"));
    said.answer = "그거 나도 있었음";
    emit({ kind: "message", message: msg({ id: "m3", author: owner, content: "배포 끝나면 꼭 뭔가 터짐" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "그거 나도 있었음", undefined));
    expect(native.discordSend).toHaveBeenCalledTimes(1);
    expect(native.discordTyping).not.toHaveBeenCalled();
    expect(said.thrown).toHaveLength(0);
    // right after it spoke, the user's next line is still taken, and a call still gets main
    emit({ kind: "message", message: msg({ id: "m4", author: owner, content: "ㅇㅇ 맞아" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    emit({ kind: "message", message: msg({ id: "m5", author: owner, content: "메타몽 로그 봐줘" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
    expect(said.prompts).toHaveLength(3);
  });

  it("watching others keeps to where they may be answered", async () => {
    rules.text = WATCH_REST;
    setState("settings", "agent", "others", false);
    said.answer = "(react 👍)";
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", content: "나 취업했어" }) });
    await settle();
    expect(said.prompts).toHaveLength(0);
    expect(native.discordReact).not.toHaveBeenCalled();
  });

  it("a rule can also keep it quiet when called, and a broken one leaves the usual way", async () => {
    rules.text = `function listen(message) { if (message.content.includes("조용")) return false; }`;
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", author: owner, content: "메타몽 조용히 해봐" }) });
    await settle();
    expect(said.thrown).toHaveLength(0);
    rules.text = `function listen() { throw new Error("oops"); }`;
    emit({ kind: "message", message: msg({ id: "m2", author: owner, content: "메타몽 안녕" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
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
    said.answer = "";
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 배포 준비해" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "시작했어", routes: [{ kind: "new", taskId: "t1" }] });
    setState("tasks", [{ id: "t1", title: "배포 준비", entries: [], agent: { channel: "c1" } } as never]);
    said.hook?.("reply1");
    setState("decisions", [{ id: "d5", taskId: "t1", at: 1, kind: "ask", question: "어디에 먼저 올릴까요?", context: [], options: [{ id: "a", label: "스테이징" }, { id: "b", label: "운영" }] }]);
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "배포 준비: 어디에 먼저 올릴까요? (스테이징 / 운영)"), { timeout: 5000 });
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    emit({ kind: "message", message: msg({ id: "m2", author: { id: OWNER, name: "성윤", bot: false }, content: "1" }) });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d5", "a"));
    expect(said.thrown).toHaveLength(1);
    // in words, too
    setState("decisions", [{ id: "d6", taskId: "t1", at: 2, kind: "ask", question: "어디에 먼저 올릴까요?", context: [], options: [{ id: "a", label: "스테이징" }, { id: "b", label: "운영" }] }]);
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledTimes(3), { timeout: 5000 });
    said.answer = "b";
    emit({ kind: "message", message: msg({ id: "m3", author: { id: OWNER, name: "성윤", bot: false }, content: "그냥 운영으로 바로 가자" }) });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d6", "b"));
    expect(said.thrown).toHaveLength(1);
  }, 15_000);

  it("a question already asked on Discord isn't asked again (after a restart too)", async () => {
    said.answer = "";
    setState("tasks", [{ id: "t1", title: "배포", entries: [], agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d9", taskId: "t1", at: 1, kind: "ask", question: "먼저?", context: [], options: [{ id: "a", label: "스테이징" }], posted: "c1" }]);
    await ready();
    await new Promise((r) => setTimeout(r, 3300));
    expect(native.discordSend).not.toHaveBeenCalled();
    // and a reply in that channel still answers it
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    emit({ kind: "message", message: msg({ id: "m2", author: { id: OWNER, name: "성윤", bot: false }, content: "1" }) });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d9", "a"));
  }, 10_000);

  it("remembers a quiet channel's talk in its own memory, and reads it the next time", async () => {
    said.answer = "ㅋㅋ 반가워요";
    await ready();
    emit({ kind: "message", message: msg({ id: "m3", content: "메타몽 안녕 나 백엔드 하는 민수야" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅋㅋ 반가워요", "m3"));
    said.answer = '[{"kind":"person","who":"222","text":"백엔드 개발자 민수, 반말로 다가옴"}]';
    await digest("c1");
    expect(said.prompts[1]).toContain("지나가던사람[222]: 메타몽 안녕 나 백엔드 하는 민수야");
    expect(state.agentNotes?.[0]).toMatchObject({ who: "222", text: "백엔드 개발자 민수, 반말로 다가옴" });
    expect(state.memory).toHaveLength(0);
    said.answer = "오 민수님";
    emit({ kind: "message", message: msg({ id: "m4", content: "메타몽 나 기억해?" }) });
    await vi.waitFor(() => expect(said.prompts).toHaveLength(3));
    expect(said.prompts[2]).toContain("백엔드 개발자 민수");
    // the user's own words from there: main hears it too, and that the server is its to act on
    emit({ kind: "message", message: msg({ id: "m5", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 민수한테 인사해줘", mentions: ["222"] }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].note).toContain("백엔드 개발자 민수");
    expect(said.thrown[0].note).toContain("discord tool");
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
