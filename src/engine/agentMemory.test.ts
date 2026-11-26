import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "../state/store";
import { applyDigest, digestPrompt, forgetNote, memoryLines } from "./agentMemory";

const agent = { on: true, name: "메타몽" };

describe("the agent's own memory", () => {
  beforeEach(() => setState(reconcile(freshState())));

  it("is kept apart from the work memory", () => {
    applyDigest('[{"kind":"lesson","text":"정정한 건 바로 정정이라고 말하기"}]', { channel: "c1", dm: false, people: {} });
    expect(state.agentNotes).toHaveLength(1);
    expect(state.memory).toHaveLength(0);
  });

  it("writes a card only for someone who was in the talk, and rewrites it instead of adding another", () => {
    const ctx = { channel: "c1", room: "#잡담", dm: false, people: { "11": "지나가던사람" } };
    expect(applyDigest('[{"kind":"person","who":"11","text":"백엔드 개발자, 반말로 장난침"},{"kind":"person","who":"99","text":"지어낸 사람"}]', ctx)).toBe(1);
    applyDigest('[{"kind":"person","who":"11","text":"백엔드 개발자, 반말 OK, Rust 좋아함"}]', ctx);
    const cards = state.agentNotes!.filter((n) => n.kind === "person");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ who: "11", name: "지나가던사람", channel: "c1", room: "#잡담", text: "백엔드 개발자, 반말 OK, Rust 좋아함" });
  });

  it("what someone said in one channel is used only in that channel; lessons everywhere", () => {
    applyDigest('[{"kind":"person","who":"11","text":"이직 고민 중"},{"kind":"place","text":"취업 고민 나누는 방"},{"kind":"lesson","text":"정정은 짧게"}]', { channel: "a", dm: false, people: { "11": "민수" } });
    applyDigest('[{"kind":"person","who":"11","text":"게임 좋아함"}]', { channel: "b", dm: false, people: { "11": "민수" } });
    // two cards for the same person, one per channel
    expect(state.agentNotes!.filter((n) => n.kind === "person")).toHaveLength(2);
    const inA = memoryLines({ speaker: "11", channel: "a", dm: false });
    const inB = memoryLines({ speaker: "11", channel: "b", dm: false });
    expect(inA).toContain("이직");
    expect(inA).toContain("취업 고민 나누는 방");
    expect(inA).not.toContain("게임");
    expect(inB).toContain("게임");
    expect(inB).not.toContain("이직");
    expect(inB).not.toContain("취업");
    // only around, not speaking: the same
    expect(memoryLines({ speaker: "22", people: ["11"], channel: "b", dm: false })).not.toContain("이직");
    for (const l of [inA, inB]) expect(l).toContain("교훈: 정정은 짧게");
    // the pass over channel b's talk doesn't see what is known from a
    const p = digestPrompt(agent, [{ who: "11", name: "민수", text: "ㅎㅇ" }], { channel: "b", dm: false });
    expect(p).toContain("게임");
    expect(p).not.toContain("이직");
  });

  it("what someone said in a DM is used only in that DM, and a DM has no place card", () => {
    applyDigest('[{"kind":"person","who":"11","text":"서버에서 본 모습"}]', { channel: "c1", dm: false, people: { "11": "민수" } });
    applyDigest('[{"kind":"person","who":"11","text":"DM에서 이직 고민 얘기함"},{"kind":"place","text":"DM엔 이곳이 없어"}]', { channel: "dm11", dm: true, people: { "11": "민수" } });
    expect(state.agentNotes!.some((n) => n.kind === "place")).toBe(false);
    expect(memoryLines({ speaker: "11", channel: "dm11", dm: true })).toContain("이직");
    expect(memoryLines({ speaker: "11", channel: "c1", dm: false })).not.toContain("이직");
    expect(memoryLines({ speaker: "22", channel: "dm22", dm: true })).not.toContain("이직");
  });

  it("cards kept before channels were told apart: a DM card goes on in that DM, the rest is used nowhere", () => {
    setState("agentNotes", [
      { id: "p", kind: "person", who: "11", name: "민수", text: "어디서 했는지 모를 얘기", at: 1 },
      { id: "d", kind: "person", who: "11", name: "민수", dm: true, text: "DM에서 한 얘기", at: 1 },
      { id: "g", kind: "place", place: "g1", text: "서버 분위기", at: 1 },
    ]);
    expect(memoryLines({ speaker: "11", channel: "c1", dm: false })).toBe("");
    expect(memoryLines({ speaker: "11", channel: "dm11", dm: true })).toContain("DM에서 한 얘기");
    // the next pass in that DM binds the card to it
    applyDigest('[{"kind":"person","who":"11","text":"DM에서 한 얘기, 고양이 키움"}]', { channel: "dm11", dm: true, people: { "11": "민수" } });
    expect(state.agentNotes!.find((n) => n.id === "d")).toMatchObject({ channel: "dm11", text: "DM에서 한 얘기, 고양이 키움" });
    // a new card in a channel doesn't take in the one of unknown origin
    applyDigest('[{"kind":"person","who":"11","text":"새 카드"}]', { channel: "c1", dm: false, people: { "11": "민수" } });
    expect(state.agentNotes!.find((n) => n.id === "p")!.text).toBe("어디서 했는지 모를 얘기");
    expect(memoryLines({ speaker: "11", channel: "c1", dm: false })).toBe("- 민수: 새 카드");
  });

  it("keeps a place card per channel and lessons once each, and forgets on request", () => {
    const ctx = { channel: "c1", dm: false, people: {} };
    applyDigest('[{"kind":"place","text":"OmO 팬 서버, 밈 많음"},{"kind":"lesson","text":"버전 얘기 금지"},{"kind":"lesson","text":"버전 얘기 금지"}]', ctx);
    expect(memoryLines({ channel: "c1", dm: false })).toContain("이곳: OmO 팬 서버");
    expect(memoryLines({ channel: "c2", dm: false })).not.toContain("OmO");
    expect(state.agentNotes!.filter((n) => n.kind === "lesson")).toHaveLength(1);
    forgetNote(state.agentNotes![0].id);
    expect(state.agentNotes).toHaveLength(1);
  });

  it("an answer that isn't a JSON list changes nothing", () => {
    expect(applyDigest("남길 게 없어요", { channel: "c1", dm: false, people: {} })).toBe(0);
    expect(applyDigest("[{broken", { channel: "c1", dm: false, people: {} })).toBe(0);
    expect(state.agentNotes ?? []).toHaveLength(0);
  });

  it("the pass is told to leave the user's work out, and sees who said what by id", () => {
    const p = digestPrompt(agent, [{ who: "11", name: "민수", text: "다음 버전 언제 나와요?" }, { who: "1", name: "주인", text: "0.64에 디스코드 기능 넣을 거야", owner: true }, { who: "bot", name: "메타몽", text: "그건 못 알려줘요", me: true }], { channel: "c1", dm: false });
    expect(p).toContain("주인의 일: 프로젝트, 코드, 계획, 아직 안 나온 것");
    expect(p).toContain("민수[11]");
    expect(p).toContain("(주인)");
    expect(p).toContain("메타몽(너)");
  });
});
