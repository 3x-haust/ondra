import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore node types are not in this project: the test runs under node
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import type { DiscordEvent, DiscordInteraction, DiscordMessage } from "../lib/native";
import { freshState, setState, state, taskById } from "../state/store";
import type { AgentSettings, CaptainMessage, Decision } from "../state/types";

const said = vi.hoisted(() => ({ hook: undefined as undefined | ((id: string) => void), endNote: undefined as undefined | ((t: { id: string; parentId?: string }) => string | undefined), thrown: [] as { text: string; space: string; note?: string; project?: string }[], prompts: [] as string[], answer: "" }));
vi.mock("./captain", async () => {
  const { setState } = await import("../state/store");
  return {
  AGENT_CHAT: "@agent",
  // like captain's: the user's words and a pending reply, in the chat asked for
  throwThought: (text: string, space: string, opts: { note?: string; project?: string; discord?: { channel: string; message: string; also?: string[] } } = {}) => {
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

import { askedLine, askPrompt, discordForm, formModal, pickButtons, BANTER, BURST, TYPING, PACE, firstFor, decided, calledIn, cleanText, DEFAULT_VOICE, digest, OTHERS_RULES, ownerNote, pickPrompt, postApprovals, unpinAnswered, openThreads, closeThreads, channelOf, sayOf, startAgent, stopAgent, talkPrompt, WATCH_WAYS } from "./discord";

/** what the user's ways file holds (agent/AGENT.md), as the agent writes it when asked */
const ways = { text: undefined as string | undefined };
const FOLLOW_UP = "- 내가 방금 말한 채널에서 5분 안에 주인이 이어서 하는 말은 나한테 하는 말로 받아";
const WATCH_REST = "- 서버에서 나를 안 부른 말은 보고만 있다가, 할 말 있을 때만 끼어들고 아니면 공감 리액션만 하거나 넘어가";

const BOT = "999";
const OWNER = "111";
const agent: AgentSettings = { on: true, name: "메타몽", ownerId: OWNER };
const pace0 = { ...PACE, think: [...PACE.think] as [number, number] };
const msg = (over: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id: "m1", channel: "c1", guild: "g1", author: { id: "222", name: "지나가던사람", bot: false },
  content: "", mentions: [], files: [], at: "", ...over,
});

describe("how fast it writes", () => {
  it("its first message waits for reading, thinking and typing it, less the time the answer already took", () => {
    const p = { ...PACE };
    Object.assign(PACE, { read: 35, think: [1000, 1000], perChar: 110, first: 9000 });
    // "뭐함" read, a second's thought, "코딩함 ㅋㅋ" typed: 70 + 1000 + 660
    expect(firstFor("뭐함", "코딩함 ㅋㅋ", 0)).toBe(1730);
    // the answer took a second already
    expect(firstFor("뭐함", "코딩함 ㅋㅋ", 1000)).toBe(730);
    // a long think of its own (main's work) already covers it
    expect(firstFor("뭐함", "코딩함 ㅋㅋ", 5000)).toBe(0);
    // never past the most
    expect(firstFor("x".repeat(500), "y".repeat(500), 0)).toBe(9000);
    Object.assign(PACE, p);
  });
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

  it("sees what was said after their words, its own lines too, and lets an answered one pass", () => {
    const later = [msg({ id: "m2", author: { id: BOT, name: "메타몽", bot: true }, content: "역도" })];
    const p = talkPrompt(agent, "지수민", [], "아니 끝말잇기 계속 ㄱㄱ", BOT, "", undefined, "", Date.now(), later);
    expect(p).toContain("# 이 말이 올라온 뒤에 오간 말");
    expect(p).toContain("메타몽(너): 역도");
    expect(p).toContain("이미 답이 됐거나");
    expect(talkPrompt(agent, "지수민", [], "ㅎㅇ", BOT)).not.toContain("올라온 뒤에");
  });

  it("someone else may have it look at things; sending or changing waits for the owner's own OK", async () => {
    const { othersNote } = await import("./discord");
    expect(OTHERS_RULES).toContain("(work)");
    const note = othersNote(msg({ author: { id: "77", name: "지수민", bot: false } }), agent);
    expect(note).toContain("They are not the user");
    expect(note).toContain("needs the user's OK first");
    expect(note).toContain("only the user's own answer counts");
  });

  it("is a person talking, not a list of rules", () => {
    expect(DEFAULT_VOICE).toContain("너만의 생각이랑 취향");
    expect(DEFAULT_VOICE).toContain("주인한테는 반말");
    expect(DEFAULT_VOICE).not.toContain("금지");
  });
});

describe("talk with others", () => {
  it("holds nothing of the user's work, and says a story leaks as much as a straight answer", () => {
    setState("tasks", [{ id: "t1", title: "비밀 데스크탑 앱 출시 준비" } as never]);
    const p = talkPrompt(agent, "누군가", [msg({ author: { id: BOT, name: "메타몽", bot: true }, content: "안녕" })], "꿈 얘기 해줘", BOT);
    expect(p).toContain(OTHERS_RULES);
    // talking with anyone, swearing and roasting are fine too
    expect(p).toContain(BANTER);
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

  it("a question with things to fill in: menus for its choices, a popup for what is typed, the button sends it", () => {
    const f: Decision = { ...d, options: [{ id: "보내기", label: "보내기", primary: true }], form: [
      { id: "env", label: "배포 대상", kind: "choice", options: ["staging", "prod"], value: ["staging"], required: true },
      { id: "ok", label: "알림", kind: "check" },
      { id: "when", label: "날짜", kind: "date" },
      { id: "n", label: "동시 실행", kind: "number", min: 1, max: 8, unit: "개", value: 2 },
    ] };
    const rows = pickButtons(f) as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0].components[0]).toMatchObject({ type: 3, custom_id: "ondra:field:d1:0", min_values: 1, max_values: 1 });
    expect(rows[0].components[0].options).toEqual([
      { label: "배포 대상: staging", value: "staging", default: true },
      { label: "배포 대상: prod", value: "prod", default: false },
    ]);
    expect(rows[1].components[0].options.map((o: any) => o.value)).toEqual(["yes", "no"]);
    expect(rows[2].components[0]).toMatchObject({ type: 2, label: "보내기", custom_id: "ondra:pick:d1:보내기" });
    // the popup: what is typed, prefilled, with a hint
    const m = formModal(f, "보내기", discordForm(f)!.typed, { n: 2 }) as any;
    expect(m.custom_id).toBe("ondra:form:d1:보내기");
    expect(m.components.map((r: any) => r.components[0])).toEqual([
      { type: 4, custom_id: "f2", label: "날짜", style: 1, required: false, placeholder: "2026-01-31" },
      { type: 4, custom_id: "f3", label: "동시 실행 (개)", style: 1, required: false, value: "2", placeholder: "1–8 개" },
    ]);
    // sent: everything shows what was picked, and can't be pressed again
    const done = pickButtons(f, "보내기") as any[];
    expect(done.every((r) => r.components.every((c: any) => c.disabled))).toBe(true);
    // the agent says it shortly, not field by field
    const p = askPrompt({ on: true, name: "메타몽" }, f);
    expect(p).toContain("메뉴와 버튼");
    expect(p).not.toContain("# 고를 수 있는 것");
  });

  it("a form too big for Discord's menus is asked in words, and the reply answers it", () => {
    const big: Decision = { ...d, options: [{ id: "보내기", label: "보내기" }], form: Array.from({ length: 6 }, (_, k) => ({ id: `t${k}`, label: `칸 ${k}`, kind: "text" as const })) };
    expect(discordForm(big)).toBeUndefined();
    expect(pickButtons(big)).toEqual([]);
    expect(askPrompt({ on: true, name: "메타몽" }, big)).toContain("답장 한 번에");
    expect(pickButtons(d).length).toBe(1);
  });

  it("the voice is a person, with no sample lines to copy, and holds none of the user's real work", () => {
    expect(DEFAULT_VOICE).not.toContain("너:");
    expect(DEFAULT_VOICE).not.toMatch(/Orbit|github\.com|#\d/);
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
    vi.spyOn(native, "discordApi").mockImplementation(async () => ({ id: "b1" }));
    vi.spyOn(native, "discordInteractionReply").mockImplementation(async () => ({ id: "r1" }));
    vi.spyOn(native, "discordDelete").mockResolvedValue();
    vi.spyOn(native, "discordOwner").mockResolvedValue("444");
    vi.spyOn(native, "discordReact").mockResolvedValue();
    vi.spyOn(native, "discordUnreact").mockResolvedValue();
    vi.spyOn(native, "discordSaveFile").mockImplementation(async (url) => `/data/attachments/discord/${url.split("/").pop()!.split("?")[0]}`);
    BURST.ms = 0;
    TYPING.ms = 0;
    // the person-like pace before its first message is tested on its own
    Object.assign(PACE, { read: 0, think: [0, 0], perChar: 0 });
    ways.text = undefined;
    vi.spyOn(native, "engineInfo").mockResolvedValue({ enginePath: null, engineVersion: null, dataDir: "/data", home: "/Users/me" });
    vi.spyOn(native, "fsRead").mockImplementation(async (path) => {
      if (path !== "/data/agent/AGENT.md" || ways.text === undefined) throw "파일이 없어요";
      return { text: ways.text, size: ways.text.length, binary: false, modified: 1 };
    });
  });
  afterEach(() => {
    stopAgent();
    vi.restoreAllMocks();
    Object.assign(PACE, pace0);
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
    expect(said.thrown[0].note).toContain("never that you sent, handed or dispatched it");
    // seen: it types there, no fixed reaction
    expect(native.discordTyping).toHaveBeenCalledWith("c1");
    expect(native.discordReact).not.toHaveBeenCalled();
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "ㅇㅋ 고치는 중", routes: [{ kind: "new", taskId: "t7" }] });
    // the job it started is the agent's, and knows where to report (captain sets this)
    setState("tasks", [{ id: "t7", title: "로그인 버그", entries: [], agent: { channel: "c1" } } as never]);
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅇㅋ 고치는 중", undefined));
    // banter is fine: it swears and roasts when asked, only hate, real threats and doxxing are out
    expect(said.thrown[0].note).toContain(BANTER);
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

  it("a job's end main said nothing about still reaches Discord: its own summary", async () => {
    await ready();
    setState("tasks", [{ id: "t10", title: "openwrt 대역 바꾸기", entries: [], status: "done", summary: "공유기 LAN을 10.77.0.0/24로 바꿨어요", agent: { channel: "c1" } } as never]);
    setState("captain", (l) => [...l, { id: "end10", at: 6, space: "home", project: "@agent", from: "captain", after: "t10", reply: "", routes: [] }]);
    said.hook?.("end10");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "공유기 LAN을 10.77.0.0/24로 바꿨어요", undefined));
  });

  it("work done in another channel: its end line is said there only; nothing stock is copied to where it was asked", async () => {
    await ready();
    setState("tasks", [{ id: "t8", title: "orbit 탭", entries: [], agent: { channel: "c1", room: "55555" } } as never]);
    const end = "orbit 탭 순서 고쳤어. 닫을 때 인덱스를 안 당겨서 꼬였던 거. PR https://github.com/3x-haust/orbit/pull/9";
    setState("captain", (l) => [...l, { id: "end8", at: 5, space: "home", project: "@agent", from: "captain", after: "t8", reply: end }]);
    said.hook?.("end8");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("55555", end, undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(native.discordSend).not.toHaveBeenCalledWith("c1", expect.anything());
  });

  it("the user's own business, or talk that moved on, in a server channel goes to their DM instead", async () => {
    await ready();
    vi.spyOn(native, "discordApi").mockImplementation(async (_m: string, path: string) => (path === "/users/@me/channels" ? { id: "dm1" } : { id: "x" }));
    // c1 is a server channel (others talk there)
    emit({ kind: "message", message: msg({ id: "o1", content: "점심 뭐 먹지" }) });
    await new Promise((r) => setTimeout(r, 20));
    setState("tasks", [{ id: "tk", title: "카톡 답장 끄기", entries: [], agent: { channel: "c1" } } as never]);
    setState("captain", (l) => [...l, { id: "endk", at: 5, space: "home", project: "@agent", from: "captain", after: "tk", reply: "(dm)\n카톡 대신 답 껐어" }]);
    said.hook?.("endk");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("dm1", "카톡 대신 답 껐어", undefined));
    expect(native.discordApi).toHaveBeenCalledWith("POST", "/users/@me/channels", { recipient_id: OWNER });
    expect(native.discordSend).not.toHaveBeenCalledWith("c1", expect.anything(), undefined);
    // the rule is in what it is told for a server channel
    const { endNote } = await import("./discord");
    expect(endNote({ id: "tk" })).toContain("(dm)");
  });

  it("a job's security approval goes to the owner's DM word for word, with its buttons; gone from the app, they close", async () => {
    await ready();
    const api = vi.spyOn(native, "discordApi").mockImplementation(async (_m: string, path: string) => (path === "/users/@me/channels" ? { id: "dm1" } : { id: "a1" }));
    setState("tasks", [{ id: "t9", title: "홈 앱으로 윈도우 켜기", entries: [], agent: { channel: "c1" } } as never]);
    const d: Decision = { id: "d9", taskId: "t9", at: 1, kind: "ask", question: "보안 동작을 허용할까요? — com.apple.Home · 내 PC, 꺼짐 · press-action", options: [{ id: "yes", label: "허용", primary: true }, { id: "no", label: "거부" }], context: [], ui: { requestId: "r1", method: "confirm" } };
    // the user's own job (not the agent's) stays in the app
    setState("decisions", [d, { ...d, id: "d0", taskId: "mine" }]);
    await postApprovals();
    const sent = api.mock.calls.filter((c) => c[0] === "POST" && c[1] === "/channels/dm1/messages");
    expect(sent).toHaveLength(1);
    const body = sent[0][2] as { content: string; components: { components: { label: string; custom_id: string }[] }[] };
    expect(body.content).toContain("홈 앱으로 윈도우 켜기\n보안 동작을 허용할까요? — com.apple.Home · 내 PC, 꺼짐 · press-action");
    // a tool's yes or no: no answer of their own
    expect(body.components[0].components.map((b) => b.label)).toEqual(["허용", "거부"]);
    expect(said.prompts.join("\n")).not.toContain("보안 동작");
    // pinned, so it is found among any number of messages
    expect(api).toHaveBeenCalledWith("PUT", "/channels/dm1/messages/pins/a1");
    expect(state.settings.agent?.pins).toEqual([{ decision: "d9", channel: "dm1", message: "a1" }]);
    // once only
    await postApprovals();
    expect(api.mock.calls.filter((c) => c[0] === "POST" && c[1] === "/channels/dm1/messages")).toHaveLength(1);
    // answered in the app (or timed out): its buttons can't be pressed
    setState("decisions", []);
    await postApprovals();
    expect(api).toHaveBeenLastCalledWith("PATCH", "/channels/dm1/messages/a1", { components: [expect.objectContaining({ components: [expect.objectContaining({ disabled: true }), expect.objectContaining({ disabled: true })] })] });
    // and its pin goes
    await unpinAnswered();
    expect(api).toHaveBeenCalledWith("DELETE", "/channels/dm1/messages/pins/a1");
    expect(state.settings.agent?.pins).toEqual([]);
  });

  it("someone written as @name is tagged, and whoever a line tags is notified", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "p1", author: { id: "783", name: "정원", user: "jeongwon0047", bot: false }, content: "ㅎㅇ" }) });
    const { tagged, allowed } = await import("./discordPeople");
    expect(tagged("@정원아 나와")).toEqual({ text: "<@783>아 나와", pings: ["783"] });
    expect(tagged("@jeongwon0047 안 나오면 계속 부름").text).toBe("<@783> 안 나오면 계속 부름");
    expect(tagged("메일은 a@정원 `@정원`").text).toBe("메일은 a@정원 `@정원`");
    expect(tagged("@everyone 다 나와").pings).toEqual([]);
    expect(allowed([])).toEqual({ parse: [] });
    expect(allowed(["783"])).toEqual({ parse: [], users: ["783"] });
    said.answer = "@정원 야 나와봐";
    emit({ kind: "message", message: msg({ id: "p2", author: { id: "333", name: "지수민", bot: false }, content: `<@${BOT}> 정원이 불러봐`, mentions: [BOT] }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "<@783> 야 나와봐", undefined, ["783"]));
  });

  it("pictures in its replies go up as pictures, not as their path", async () => {
    await ready();
    vi.spyOn(native, "discordSendFile").mockResolvedValue(["f1"]);
    setState("tasks", [{ id: "tp", title: "탭", entries: [], agent: { channel: "c1" } } as never]);
    setState("captain", (l) => [...l, { id: "endp", at: 5, space: "home", project: "@agent", from: "captain", after: "tp", reply: "고친 화면 ![](/tmp/after.png)" }]);
    said.hook?.("endp");
    await vi.waitFor(() => expect(native.discordSendFile).toHaveBeenCalledWith("c1", "/tmp/after.png"));
    expect(native.discordSend).toHaveBeenCalledWith("c1", "고친 화면", undefined);
  });

  it("lines said in a row are one request, answered once, at the last", async () => {
    BURST.ms = 60;
    await ready();
    const say = (id: string, content: string) => emit({ kind: "message", message: msg({ id, guild: null, author: { id: OWNER, name: "성윤", bot: false }, content }) });
    say("a1", "아니");
    say("a2", "주인 말 들어야지");
    say("a3", "장난하냐");
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(said.thrown).toHaveLength(1);
    expect(said.thrown[0].text).toBe("아니\n주인 말 들어야지\n장난하냐");
    // each was seen at once
    expect(native.discordReact).not.toHaveBeenCalled();
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "ㅇㅋ 알겠어" });
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅇㅋ 알겠어", undefined));
  });

  it("what they say while it answers is taken into that answer, and goes on its own only when it asks for more", async () => {
    BURST.ms = 30;
    await ready();
    const say = (id: string, content: string) => emit({ kind: "message", message: msg({ id, guild: null, author: { id: OWNER, name: "성윤", bot: false }, content }) });
    say("h1", "dlfdjsk");
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    say("h2", "일어나");
    await new Promise((r) => setTimeout(r, 80));
    // still answering the first: the rest wait
    expect(said.thrown).toHaveLength(1);
    said.answer = "ㅇ 깼어";
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "ㅇ 깼어\n\n고친 거 맞지? ㅋㅋ" });
    said.hook?.("reply1");
    // one answer to both, said in the talk, not as a reply to the first
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅇ 깼어", undefined));
    expect(said.prompts[said.prompts.length - 1]).toContain("<added>\n일어나\n</added>");
    await new Promise((r) => setTimeout(r, 50));
    expect(said.thrown).toHaveLength(1);
    // more that words alone can't do goes as its own request after
    say("h3", "멈춰봐");
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
    say("h4", "그리고 그 PR 머지해");
    await new Promise((r) => setTimeout(r, 80));
    said.answer = "ㅇㅋ 멈춤\n(more)";
    setState("captain", (m) => m.id === "reply2", { pending: false, reply: "ㅇㅋ 멈춤" });
    said.hook?.("reply2");
    await vi.waitFor(() => expect(said.thrown).toHaveLength(3));
    expect(said.thrown[2].text).toBe("그리고 그 PR 머지해");
    expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅇㅋ 멈춤", "h3");
  });

  it("an answer it wrote while another of its own went out there first is looked at again: what's left, or nothing", async () => {
    await ready();
    const snow = (ms: number) => ((BigInt(ms) - 1_420_070_400_000n) << 22n).toString();
    emit({ kind: "message", message: msg({ id: "w1", guild: null, author: { id: OWNER, name: "성윤", bot: false }, content: "이유 찾아봐" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    // meanwhile its answer to someone else went out there
    vi.mocked(native.discordHistory).mockResolvedValue([msg({ id: snow(Date.now()), guild: null, author: { id: BOT, name: "메타몽", bot: true }, content: "아까 안 된 건 펑만 쳐서임", at: new Date().toISOString() })]);
    said.answer = "(skip)";
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "펑만 치고 변신을 안 했었어" });
    said.hook?.("reply1");
    await vi.waitFor(() => expect(said.prompts.some((p) => p.includes("<about-to-say>\n펑만 치고 변신을 안 했었어") && p.includes("메타몽(너): 아까 안 된 건 펑만 쳐서임"))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(native.discordSend).not.toHaveBeenCalled();
    // only what is left goes
    emit({ kind: "message", message: msg({ id: "w2", guild: null, author: { id: OWNER, name: "성윤", bot: false }, content: "프사는" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
    said.answer = "프사도 이제 바뀜";
    setState("captain", (m) => m.id === "reply2", { pending: false, reply: "펑만 쳐서 그랬어\n\n프사도 이제 바뀜" });
    said.hook?.("reply2");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "프사도 이제 바뀜", undefined));
    expect(native.discordSend).toHaveBeenCalledTimes(1);
  });

  it("the thinking it writes before its decision is never posted", async () => {
    await ready();
    ways.text = "- 내가 방금 말한 채널에서 1분 안에 주인이 이어서 하는 말은 나한테 하는 말로 받아";
    said.answer = "The owner spoke within 1 minute after my message in this channel, so it's addressed to me. It's also a request to do something, so take.\n\n(take)";
    emit({ kind: "message", message: msg({ id: "k1", author: { id: OWNER, name: "성윤", bot: false }, content: "카톡답장 꺼줘" }) });
    // taken as the user's request, nothing said
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].text).toBe("카톡답장 꺼줘");
    said.answer = "Not for me, just chatting.\n(skip)";
    emit({ kind: "message", message: msg({ id: "k2", author: { id: "222", name: "정원", bot: false }, content: "ㅋㅋ" }) });
    await new Promise((r) => setTimeout(r, 80));
    expect(native.discordSend).not.toHaveBeenCalled();
    // thinking aloud with no word at the end, in Korean talk: only what is for them
    said.answer = "The user is just joking, a short reply fits.\nㅋㅋㅋ 뭐래";
    emit({ kind: "message", message: msg({ id: "k3", author: { id: "222", name: "정원", bot: false }, content: `<@${BOT}> 바보`, mentions: [BOT] }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledTimes(1));
    expect(vi.mocked(native.discordSend).mock.calls[0][1]).toBe("ㅋㅋㅋ 뭐래");
    expect(decided("ㅇㅇ\n잔다")).toBe("ㅇㅇ\n잔다");
    expect(decided("(skip)")).toBe("(skip)");
  });

  it("someone else's lines in a row are one thing said, answered once; what they add meanwhile is taken in", async () => {
    BURST.ms = 60;
    await ready();
    ways.text = "- 서버에서 나를 안 부른 말은 보고만 있다가 끼어들고 싶을 때만 말해";
    const say = (id: string, content: string) => emit({ kind: "message", message: msg({ id, author: { id: "333", name: "지수민", bot: false }, content: id === "q1" ? `<@${BOT}> ${content}` : content, mentions: id === "q1" ? [BOT] : [] }) });
    said.answer = "ㅋㅋㅋ 서운해하지 마";
    say("q1", "시발 왜");
    say("q2", "날 골라야지 미친놈아");
    say("q3", "존나 서운해");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledTimes(1));
    // one talk, all three lines in it
    expect(said.prompts).toHaveLength(1);
    expect(said.prompts[0]).toContain("시발 왜\n날 골라야지 미친놈아\n존나 서운해");
    await new Promise((r) => setTimeout(r, 120));
    expect(native.discordSend).toHaveBeenCalledTimes(1);
  });

  it("two replies in one channel go out one after the other, not mixed", async () => {
    const { PACE } = await import("./discord");
    const pace = { ...PACE };
    Object.assign(PACE, { base: 20, perChar: 0, most: 20 });
    await ready();
    emit({ kind: "message", message: msg({ id: "s1", guild: null, author: { id: OWNER, name: "성윤", bot: false }, content: "하나" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "가\n\n나\n\n다" });
    said.hook?.("reply1");
    setState("captain", (l) => [...l, { id: "endq", at: 9, space: "home", project: "@agent", from: "captain", after: "tq", reply: "라\n\n마" }]);
    setState("tasks", [{ id: "tq", title: "x", entries: [], agent: { channel: "c1" } } as never]);
    said.hook?.("endq");
    await vi.waitFor(() => expect(vi.mocked(native.discordSend).mock.calls.map((c) => c[1])).toEqual(["가", "나", "다", "라", "마"]), { timeout: 3000 });
    Object.assign(PACE, pace);
  });

  it("nothing said in between: a plain line; someone spoke in between: a reply to their message", async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "q1", author: { id: OWNER, name: "성윤", bot: false }, content: `<@${BOT}> 오늘 뭐함`, mentions: [BOT] }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    // someone else talks before it answers
    emit({ kind: "message", message: msg({ id: "x1", author: { id: "222", name: "정원", bot: false }, content: "ㅋㅋ" }) });
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "코딩함" });
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "코딩함", "q1"));
  });

  it("while they are still typing it waits for the rest", async () => {
    BURST.ms = 150;
    TYPING.ms = 500;
    await ready();
    const say = (id: string, content: string) => emit({ kind: "message", message: msg({ id, guild: null, author: { id: OWNER, name: "성윤", bot: false }, content }) });
    say("t1", "tq");
    await vi.waitFor(() => expect(native.discordTyping).toHaveBeenCalledWith("c1"), { interval: 5 });
    emit({ kind: "typing", channel: "c1", user: OWNER });
    // past the usual wait, still held
    await new Promise((r) => setTimeout(r, 250));
    expect(said.thrown).toHaveLength(0);
    say("t2", "ㅅㅂ");
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].text).toBe("tq\nㅅㅂ");
    // someone else typing doesn't hold it (once it has answered the first)
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "ㅇㅋ" });
    said.hook?.("reply1");
    say("t3", "ㅇㅇ");
    emit({ kind: "typing", channel: "c1", user: "222" });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
  });

  it("a picture sent with the words is saved and attached, so it is seen, not a link", async () => {
    await ready();
    const url = "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1&is=2&hm=3";
    emit({ kind: "message", message: msg({ id: "p1", guild: null, author: { id: OWNER, name: "성윤", bot: false }, content: `<@${BOT}>`, mentions: [BOT], files: [url] }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(native.discordSaveFile).toHaveBeenCalledWith(url);
    expect(said.thrown[0].text).toBe("메타몽\n\n첨부한 파일:\n- /data/attachments/discord/shot.png");
    expect(said.thrown[0].text).not.toContain("cdn.discordapp.com");
  });

  it("a picture that can't be saved stays as its link", async () => {
    vi.spyOn(native, "discordSaveFile").mockRejectedValue("404");
    await ready();
    emit({ kind: "message", message: msg({ id: "p2", guild: null, author: { id: OWNER, name: "성윤", bot: false }, content: "이거 봐", files: ["https://cdn.discordapp.com/x.png"] }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].text).toBe("이거 봐\nhttps://cdn.discordapp.com/x.png");
  });

  const owner = { id: OWNER, name: "성윤", bot: false };

  it("every request starts fresh, so the channel's last lines come with it", async () => {
    vi.spyOn(native, "discordHistory").mockResolvedValue([
      msg({ id: "h1", author: { id: BOT, name: "메타몽", bot: true }, content: "이제 연달아 보내면 묶어서 답할게", at: new Date().toISOString() }),
      msg({ id: "h2", author: owner, content: "ㅇ", at: new Date().toISOString() }),
    ]);
    await ready();
    emit({ kind: "message", message: msg({ id: "m9", author: owner, content: "메타몽 대답을 해야지" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    const note = said.thrown[0].note ?? "";
    expect(note).toContain("<recent-talk>");
    expect(note).toContain("메타몽(너): 이제 연달아 보내면 묶어서 답할게");
    expect(note).toContain("성윤(주인): ㅇ");
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const asked = async () => {
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", author: owner, content: "메타몽 Orbit 어때" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    // main answers in the agent's own chat, after the user's words (which keep where they came from)
    setState("captain", (l) => l.map((m) => (m.id === "reply1" ? { ...m, pending: false, reply: "Orbit 릴리즈할까?" } : m)));
    said.hook?.("reply1");
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "Orbit 릴리즈할까?", undefined));
    await settle();
    emit({ kind: "message", message: msg({ id: "m2", author: owner, content: "릴리즈해" }) });
  };

  it("with no ways of the user's own, their answer right after it spoke still needs a mention", async () => {
    await asked();
    await settle();
    expect(said.thrown).toHaveLength(1);
    expect(said.prompts).toHaveLength(0);
    // main hears where its ways are, to write them when asked, and that there are none yet
    expect(said.thrown[0].note).toContain("/data/agent/AGENT.md");
    expect(said.thrown[0].note).toContain("(empty: only the usual way)");
  });

  it("with a way of the user's own, their words right after it spoke are looked at, and taken as a request", async () => {
    ways.text = FOLLOW_UP;
    vi.spyOn(native, "discordHistory").mockResolvedValue([msg({ id: "m0", author: { id: BOT, name: "메타몽", bot: true }, content: "Orbit 릴리즈할까?", at: new Date().toISOString() })]);
    said.answer = "(take)";
    await asked();
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
    expect(said.thrown[1].text).toBe("릴리즈해");
    // the look had the way, and when it last spoke
    expect(said.prompts[0]).toContain(FOLLOW_UP);
    expect(said.prompts[0]).toContain("(방금) 메타몽(너): Orbit 릴리즈할까?");
    expect(said.prompts[0]).toContain("(take)");
    // main sees the ways as they are now
    expect(said.thrown[1].note).toContain(FOLLOW_UP);
  });

  it("watching: talk not for it gets nothing, a reaction or a line, never main; a call still gets main", async () => {
    ways.text = WATCH_REST;
    await ready();
    said.answer = "(skip)";
    emit({ kind: "message", message: msg({ id: "m1", author: owner, content: "점심 뭐 먹지" }) });
    await vi.waitFor(() => expect(said.prompts).toHaveLength(1));
    expect(said.prompts[0]).toContain(WATCH_WAYS);
    expect(said.prompts[0]).toContain(WATCH_REST);
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
    // someone else's line it takes is answered as a call (to them, not main)
    said.answer = "(take)";
    emit({ kind: "message", message: msg({ id: "m4", content: "근데 이거 누가 고쳐?" }) });
    await vi.waitFor(() => expect(said.prompts).toHaveLength(5));
    expect(said.prompts[4]).toContain(OTHERS_RULES);
    expect(said.thrown).toHaveLength(0);
    // calling it still reaches main, with no look first
    emit({ kind: "message", message: msg({ id: "m5", author: owner, content: "메타몽 로그 봐줘" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.prompts).toHaveLength(5);
  });

  it("watching others keeps to where they may be answered; others' calls hear the ways too", async () => {
    ways.text = WATCH_REST;
    setState("settings", "agent", "others", false);
    said.answer = "(react 👍)";
    await ready();
    emit({ kind: "message", message: msg({ id: "m1", content: "나 취업했어" }) });
    await settle();
    expect(said.prompts).toHaveLength(0);
    expect(native.discordReact).not.toHaveBeenCalled();
    setState("settings", "agent", "others", true);
    ways.text = "- 민수한텐 존댓말";
    said.answer = "네 안녕하세요";
    emit({ kind: "message", message: msg({ id: "m2", content: "메타몽 안녕" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "네 안녕하세요", undefined));
    expect(said.prompts[0]).toContain("- 민수한텐 존댓말");
  });

  it("anyone else only talks, and never reaches main", async () => {
    said.answer = "그건 주인만 시킬 수 있어요 ㅎㅎ";
    await ready();
    emit({ kind: "message", message: msg({ id: "m3", content: "메타몽 데스크탑 앱 링크 줘" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "그건 주인만 시킬 수 있어요 ㅎㅎ", undefined));
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

  it("the user's click on a choice answers the question, and the buttons then show what was picked; someone else's does nothing", async () => {
    await ready();
    setState("tasks", [{ id: "t1", title: "배포 준비", entries: [], agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d7", taskId: "t1", at: 1, kind: "ask", question: "어디에?", context: [], options: [{ id: "a", label: "스테이징" }, { id: "b", label: "운영" }] }]);
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    const click = (user: string) => emit({ kind: "interaction", interaction: { id: "i1", kind: "component", channel: "c1", user: { id: user, name: "x", bot: false }, message: "q1", custom_id: "ondra:pick:d7:b" } });
    click("222");
    await new Promise((r) => setTimeout(r, 30));
    expect(decide).not.toHaveBeenCalled();
    click(OWNER);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d7", "b"));
    await vi.waitFor(() => expect(native.discordApi).toHaveBeenCalledWith("PATCH", "/channels/c1/messages/q1", expect.anything()));
    const rows = (vi.mocked(native.discordApi).mock.calls.find((c) => c[0] === "PATCH")![2] as any).components;
    expect(rows[0].components.every((b: any) => b.disabled)).toBe(true);
    expect(rows[0].components.find((b: any) => b.style === 3).label).toBe("운영");
    expect(said.thrown).toHaveLength(0);
  });

  it("a form on Discord: picks in its menus are kept, the popup's words join them, and a needed one left empty holds it", async () => {
    await ready();
    const modals = vi.spyOn(native, "discordModalSet").mockResolvedValue(undefined);
    setState("tasks", [{ id: "t1", title: "배포 준비", entries: [], agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d8", taskId: "t1", at: 1, kind: "ask", question: "배포 전에 알려 주세요", context: [], options: [{ id: "보내기", label: "보내기" }], form: [
      { id: "env", label: "배포 대상", kind: "choice", options: ["staging", "prod"], required: true },
      { id: "memo", label: "메모", kind: "text", required: true },
      { id: "n", label: "동시 실행", kind: "number", unit: "개" },
    ] }]);
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    const on = (x: object) => emit({ kind: "interaction", interaction: { id: "i9", channel: "c1", user: { id: OWNER, name: "x", bot: false }, message: "q9", ...x } as never });
    // posted with its menus, and its button armed with the popup
    await vi.waitFor(() => expect(modals).toHaveBeenCalledWith("ondra:pick:d8:보내기", expect.objectContaining({ custom_id: "ondra:form:d8:보내기" })), { timeout: 5000 });
    on({ kind: "component", custom_id: "ondra:field:d8:0", values: ["prod"] });
    await vi.waitFor(() => expect(native.discordApi).toHaveBeenCalledWith("PATCH", "/channels/c1/messages/q9", expect.anything()));
    // the popup sent with the needed memo empty: held, and said only to them
    on({ kind: "modal", custom_id: "ondra:form:d8:보내기", fields: { f1: " ", f2: "4" } });
    await vi.waitFor(() => expect(native.discordInteractionReply).toHaveBeenCalledWith("i9", expect.objectContaining({ content: "'메모'을(를) 채워 주세요", flags: 64 }), true));
    expect(decide).not.toHaveBeenCalled();
    on({ kind: "modal", custom_id: "ondra:form:d8:보내기", fields: { f1: "오늘 저녁", f2: "4" } });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d8", "보내기", { env: "prod", memo: "오늘 저녁", n: 4 }));
  });

  it("직접 답하기 opens a popup; what they write there is the answer, as under a question in the app", async () => {
    await ready();
    const modals = vi.spyOn(native, "discordModalSet").mockResolvedValue();
    setState("tasks", [{ id: "t1", title: "배포 준비", entries: [], agent: { channel: "c1" } } as never]);
    setState("decisions", [{ id: "d7", taskId: "t1", at: 1, kind: "ask", question: "어디에 먼저 올릴까요?", context: [], options: [{ id: "a", label: "스테이징" }] }]);
    await vi.waitFor(() => expect(modals).toHaveBeenCalledWith("ondra:own:d7", expect.objectContaining({ custom_id: "ondra:ownsent:d7" })), { timeout: 5000 });
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    const on = (x: Partial<DiscordInteraction>, who = OWNER) => emit({ kind: "interaction", interaction: { id: "i7", kind: "modal", channel: "c1", guild: "g1", user: { id: who, name: "x", bot: false }, message: "q7", ...x } as DiscordInteraction });
    // only the owner's answer counts
    on({ custom_id: "ondra:ownsent:d7", fields: { a: "아무 데도" } }, "999");
    await new Promise((r) => setTimeout(r, 50));
    expect(decide).not.toHaveBeenCalled();
    on({ custom_id: "ondra:ownsent:d7", fields: { a: "  스테이징 말고 개발 서버에  " } });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d7", "스테이징 말고 개발 서버에"));
    await vi.waitFor(() => expect(native.discordApi).toHaveBeenCalledWith("PATCH", "/channels/c1/messages/q7", expect.anything()));
    // a popup from before a restart is armed again when pressed
    setState("decisions", [{ id: "d8", taskId: "t1", at: 1, kind: "ask", question: "또?", context: [], options: [{ id: "a", label: "응" }], posted: "c1" }]);
    on({ kind: "component", custom_id: "ondra:own:d8" });
    await vi.waitFor(() => expect(modals).toHaveBeenCalledWith("ondra:own:d8", expect.anything()));
  }, 10_000);

  it("a click on a button it made comes to it as the user's words; a slash command is answered in its own place", async () => {
    await ready();
    emit({ kind: "interaction", interaction: { id: "i2", kind: "component", channel: "c1", guild: "g1", user: { id: OWNER, name: "성윤", bot: false }, message: "m8", custom_id: "deploy-now" } });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(said.thrown[0].text).toContain("deploy-now");
    emit({ kind: "interaction", interaction: { id: "i3", kind: "command", channel: "c1", guild: "g1", user: { id: OWNER, name: "성윤", bot: false }, command: "status", options: [{ name: "detail", value: true }] } });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2));
    expect(said.thrown[1].text).toContain("/status detail:true");
    setState("captain", (m) => m.id === "reply2", { pending: false, reply: "다 돌고 있어" });
    said.hook?.("reply2");
    await vi.waitFor(() => expect(native.discordInteractionReply).toHaveBeenCalledWith("i3", expect.objectContaining({ content: "다 돌고 있어" })));
  });

  it("a job's question is posted in its own thread with its choices as buttons, and a number answers it", async () => {
    said.answer = "";
    await ready();
    vi.spyOn(native, "discordApi").mockImplementation(async (_m: string, path: string) => (path.endsWith("/threads") ? { id: "th1" } : { id: "b1" }));
    emit({ kind: "message", message: msg({ id: "m1", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 배포 준비해" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    setState("captain", (m) => m.id === "reply1", { pending: false, reply: "시작했어", routes: [{ kind: "new", taskId: "t1" }] });
    setState("tasks", [{ id: "t1", title: "배포 준비", status: "running", entries: [], agent: { channel: "c1" } } as never]);
    said.hook?.("reply1");
    // its own thread, named after it, in the channel it was asked in
    await vi.waitFor(() => expect(native.discordApi).toHaveBeenCalledWith("POST", "/channels/c1/threads", expect.objectContaining({ name: "배포 준비" })), { timeout: 5000 });
    await vi.waitFor(() => expect(taskById("t1")?.agent).toMatchObject({ thread: "th1", threadIn: "c1" }));
    expect(channelOf("t1")).toBe("th1");
    setState("decisions", [{ id: "d5", taskId: "t1", at: 1, kind: "ask", question: "어디에 먼저 올릴까요?", context: [], options: [{ id: "a", label: "스테이징" }, { id: "b", label: "운영" }] }]);
    await vi.waitFor(() => expect(native.discordApi).toHaveBeenCalledWith("POST", "/channels/th1/messages", expect.objectContaining({ content: "❓ 배포 준비\n어디에 먼저 올릴까요?" })), { timeout: 5000 });
    const body = vi.mocked(native.discordApi).mock.calls.find((c) => c[0] === "POST" && c[1] === "/channels/th1/messages")![2] as any;
    expect(body.components[0].components.map((b: any) => [b.label, b.custom_id])).toEqual([["스테이징", "ondra:pick:d5:a"], ["운영", "ondra:pick:d5:b"], ["직접 답하기", "ondra:own:d5"]]);
    await vi.waitFor(() => expect(native.discordApi).toHaveBeenCalledWith("PUT", "/channels/th1/messages/pins/b1"));
    const tasks = await import("./tasks");
    const decide = vi.spyOn(tasks, "decide").mockResolvedValue(undefined);
    emit({ kind: "message", message: msg({ id: "m2", channel: "th1", author: { id: OWNER, name: "성윤", bot: false }, content: "1" }) });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d5", "a"));
    expect(said.thrown).toHaveLength(1);
    // in words, too
    setState("decisions", [{ id: "d6", taskId: "t1", at: 2, kind: "ask", question: "어디에 먼저 올릴까요?", context: [], options: [{ id: "a", label: "스테이징" }, { id: "b", label: "운영" }] }]);
    await vi.waitFor(() => expect(vi.mocked(native.discordApi).mock.calls.filter((c) => c[0] === "POST" && c[1] === "/channels/th1/messages")).toHaveLength(2), { timeout: 5000 });
    said.answer = "b";
    emit({ kind: "message", message: msg({ id: "m3", channel: "th1", author: { id: OWNER, name: "성윤", bot: false }, content: "그냥 운영으로 바로 가자" }) });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("d6", "b"));
    expect(said.thrown).toHaveLength(1);
    // the user's other words in its thread go to main as that job's
    said.answer = "";
    emit({ kind: "message", message: msg({ id: "m4", channel: "th1", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 로그도 같이 봐줘" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(2), { timeout: 5000 });
    expect(said.thrown[1].note).toContain('the thread of your job t1 "배포 준비"');
  }, 20_000);

  it("a job's thread is put away a while after it ended; a job asked in a DM works in the DM", async () => {
    await ready();
    const api = vi.spyOn(native, "discordApi").mockImplementation(async (_m: string, path: string) => (path === "/users/@me/channels" ? { id: "dm1" } : { id: "x" }));
    const now = Date.now();
    setState("tasks", [
      { id: "t2", title: "로그 정리", status: "done", finishedAt: now - 11 * 60_000, entries: [], agent: { channel: "c1", thread: "th2", threadIn: "c1" } } as never,
      { id: "t3", title: "방금 끝남", status: "failed", finishedAt: now - 60_000, entries: [], agent: { channel: "c1", thread: "th3", threadIn: "c1" } } as never,
      { id: "t4", title: "DM 작업", status: "running", entries: [], agent: { channel: "dm1" } } as never,
    ]);
    await closeThreads(now);
    expect(api).toHaveBeenCalledWith("PATCH", "/channels/th2", { name: "✅ 로그 정리", archived: true });
    expect(api).not.toHaveBeenCalledWith("PATCH", "/channels/th3", expect.anything());
    expect(taskById("t2")?.agent?.threadClosed).toBe(true);
    await openThreads();
    expect(api).not.toHaveBeenCalledWith("POST", "/channels/dm1/threads", expect.anything());
    expect(taskById("t4")?.agent).toMatchObject({ thread: "", threadIn: "dm1" });
    expect(channelOf("t4")).toBe("dm1");
  });

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
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalledWith("c1", "ㅋㅋ 반가워요", undefined));
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

  it('the user says "지워": no keyword match deletes anything; it goes to the agent, who deletes with its discord tool', async () => {
    said.answer = "안녕하세요";
    await ready();
    emit({ kind: "message", message: msg({ id: "m3", content: "메타몽 안녕" }) });
    await vi.waitFor(() => expect(native.discordSend).toHaveBeenCalled());
    emit({ kind: "message", message: msg({ id: "m4", author: { id: OWNER, name: "성윤", bot: false }, content: "메타몽 그거 지워" }) });
    await vi.waitFor(() => expect(said.thrown).toHaveLength(1));
    expect(native.discordDelete).not.toHaveBeenCalled();
  });
});

describe("its jokes", () => {
  it("come from the moment, play along with something plainly fake instead of a flat no, and carry no sample to copy", () => {
    expect(BANTER).toContain("누가 봐도 가짜");
    expect(BANTER).toContain("진짜 값");
    expect(BANTER).not.toMatch(/예:|예를 들|"[^"]+"/);
  });
  it("no instruction it reads carries sample lines to copy", () => {
    for (const p of [DEFAULT_VOICE, OTHERS_RULES, BANTER]) expect(p).not.toMatch(/"[^"]*[가-힣][^"]*"/);
  });
});

describe("where it is right now, across workspaces", () => {
  it("this workspace's work by name; the other's only how much and how it goes; nothing when idle", async () => {
    const { myState } = await import("./discord");
    const { setState: set } = await import("../state/store");
    set("spaces", [{ id: "home", label: "개인" }, { id: "work", label: "회사" }] as never);
    set("tasks", [
      { id: "h1", space: "home", title: "탭 순서", status: "running", agent: { channel: "c1" }, createdAt: 0, legs: [{ startedAt: 0 }], entries: [], shells: [{ ok: false }] },
      { id: "w1", space: "work", title: "결제 서버 비밀 마이그레이션", status: "running", agent: { channel: "c2" }, createdAt: 0, legs: [{ startedAt: 0 }], entries: [], shells: [{ ok: false }, { ok: false }] },
      { id: "x", space: "work", title: "앱에서 시킨 일", status: "running", createdAt: 0, entries: [], shells: [] },
    ] as never);
    const home = myState("home", 40 * 60_000);
    expect(home).toContain('"탭 순서", 40 min, working: 0 steps so far, nothing said yet, hit 1 snags');
    expect(home).toContain("회사 work (say nothing of what it is): 1 going, longest 40 min, 2 snags");
    expect(home).not.toContain("결제");
    expect(home).not.toContain("앱에서 시킨 일");
    expect(myState("work", 40 * 60_000)).toContain('"결제 서버 비밀 마이그레이션"');
    set("tasks", [] as never);
    expect(myState("home")).toBe("");
  });

  it("what its job is really doing (steps, when the last was, what it last said), and one that just failed", async () => {
    const { myState } = await import("./discord");
    const { setState: set } = await import("../state/store");
    const now = 10 * 60_000;
    set("tasks", [
      { id: "a", space: "home", title: "Orbit 이슈 #97", status: "failed", error: "blocked by policy", finishedAt: now - 6 * 60_000, agent: { channel: "c1" }, createdAt: 0, entries: [], shells: [] },
      { id: "b", space: "home", title: "Orbit 이슈 #97", status: "running", agent: { channel: "c1" }, createdAt: now - 5 * 60_000, entries: [
        { id: "1", at: now - 200_000, kind: "text", text: "로그부터 볼게" },
        { id: "2", at: now - 100_000, kind: "tool", tool: { kind: "bash" } },
        { id: "3", at: now - 20_000, kind: "tool", tool: { kind: "read" } },
      ], shells: [] },
    ] as never);
    const s = myState("home", now);
    expect(s).toContain('"Orbit 이슈 #97", 5 min, working: 2 steps so far, the last 20s ago, last said (3 min ago): "로그부터 볼게"');
    expect(s).toContain('failed 6 min ago: "Orbit 이슈 #97" (blocked by policy)');
    const { TRUE_ONLY } = await import("./discord");
    expect(TRUE_ONLY).toContain("추궁당해도");
  });

  it('"#name" of a channel it knows becomes the channel link', async () => {
    const { tagged, seeChannels } = await import("./discordPeople");
    seeChannels([{ id: "1565", name: "orbit", kind: "text" }, { id: "77", name: "프로젝트", kind: "category" }]);
    expect(tagged("#orbit에서 커밋 보고 있을게").text).toBe("<#1565>에서 커밋 보고 있을게");
    expect(tagged("PR #96 봤어 #프로젝트").text).toBe("PR #96 봤어 #프로젝트");
  });

  it("knows where a message is by name: the server, the channel and its category, or a DM", async () => {
    const { placeOf, seeChannels, seeServers, forgetPeople } = await import("./discordPeople");
    forgetPeople();
    const at = { guild: "g1", channel: "c1", author: { name: "민수" } };
    // not looked up yet: the ids alone
    expect(placeOf(at)).toBe("the server (id g1), channel (id c1)");
    seeServers([{ id: "g1", name: "아루" }]);
    seeChannels([{ id: "cat", name: "프로젝트", kind: "category" }, { id: "c1", name: "orbit", kind: "text", category: "cat" }], "g1");
    expect(placeOf(at, { work: true })).toBe('the server "아루" (id g1), channel #orbit (id c1) under "프로젝트", a room where work is shown');
    expect(placeOf(at, { ko: true })).toBe('"아루" 서버(id g1)의 #orbit 채널(id c1), "프로젝트" 카테고리');
    expect(placeOf({ ...at, guild: null }, { ko: true })).toBe("민수와의 DM");
    // a way for a place: written by its name and id, kept there only
    const { waysNote } = await import("./discord");
    expect(waysNote({ path: "/x/AGENT.md", text: "" })).toContain("A line for a place holds there only");
  });
});


describe("a reply as Discord messages", () => {
  it("goes out as several messages where it has blank lines, as people send a thought in a few", async () => {
    const { messagesOf } = await import("./discord");
    // a line each, as a person presses enter
    expect(messagesOf("ㅋㅋ 그거 내 실수야\n\n교각 답은 제대로 나갔어\n로그로 확인했고\n\n끝말잇기는 교각, 각으로 와")).toEqual(["ㅋㅋ 그거 내 실수야", "교각 답은 제대로 나갔어", "로그로 확인했고", "끝말잇기는 교각, 각으로 와"]);
    // a list stays one, with its lead-in
    expect(messagesOf("고친 거:\n- 타이핑\n- 엔터\n이제 봐")).toEqual(["고친 거:\n- 타이핑\n- 엔터", "이제 봐"]);
    expect(messagesOf("한 줄")).toEqual(["한 줄"]);
  });
  it("never splits a code block, and keeps it to a few messages", async () => {
    const { messagesOf } = await import("./discord");
    expect(messagesOf("이거 봐\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n됐지")).toEqual(["이거 봐", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "됐지"]);
    const many = messagesOf(Array.from({ length: 11 }, (_, i) => `${i}`).join("\n"));
    expect(many).toHaveLength(8);
    expect(many[7]).toBe("7\n8\n9\n10");
  });
});

