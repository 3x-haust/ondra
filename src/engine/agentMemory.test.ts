import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "../state/store";
import { applyDigest, digestPrompt, forgetNote, memoryLines } from "./agentMemory";

const agent = { on: true, name: "메타몽" };

describe("the agent's own memory", () => {
  beforeEach(() => setState(reconcile(freshState())));

  it("is kept apart from the work memory", () => {
    applyDigest('[{"kind":"lesson","text":"정정한 건 바로 정정이라고 말하기"}]', { dm: false, people: {} });
    expect(state.agentNotes).toHaveLength(1);
    expect(state.memory).toHaveLength(0);
  });

  it("writes a card only for someone who was in the talk, and rewrites it instead of adding another", () => {
    const ctx = { place: "g1", dm: false, people: { "11": "지나가던사람" } };
    expect(applyDigest('[{"kind":"person","who":"11","text":"백엔드 개발자, 반말로 장난침"},{"kind":"person","who":"99","text":"지어낸 사람"}]', ctx)).toBe(1);
    applyDigest('[{"kind":"person","who":"11","text":"백엔드 개발자, 반말 OK, Rust 좋아함"}]', ctx);
    const cards = state.agentNotes!.filter((n) => n.kind === "person");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ who: "11", name: "지나가던사람", text: "백엔드 개발자, 반말 OK, Rust 좋아함" });
  });

  it("what someone said in a DM is used only in a DM with them", () => {
    applyDigest('[{"kind":"person","who":"11","text":"서버에서 본 모습"}]', { place: "g1", dm: false, people: { "11": "민수" } });
    applyDigest('[{"kind":"person","who":"11","text":"DM에서 이직 고민 얘기함"},{"kind":"place","text":"DM엔 이곳이 없어"}]', { dm: true, people: { "11": "민수" } });
    expect(state.agentNotes!.some((n) => n.kind === "place")).toBe(false);
    expect(memoryLines({ speaker: "11", dm: true })).toContain("이직");
    // in a server channel, even talking with them, and when they are only around
    expect(memoryLines({ speaker: "11", place: "g1", dm: false })).not.toContain("이직");
    expect(memoryLines({ speaker: "22", people: ["11"], dm: true })).not.toContain("이직");
    expect(memoryLines({ speaker: "11", place: "g1", dm: false })).toContain("서버에서 본 모습");
  });

  it("keeps a place card per server and lessons once each, and forgets on request", () => {
    const ctx = { place: "g1", dm: false, people: {} };
    applyDigest('[{"kind":"place","text":"OmO 팬 서버, 밈 많음"},{"kind":"lesson","text":"버전 얘기 금지"},{"kind":"lesson","text":"버전 얘기 금지"}]', ctx);
    expect(memoryLines({ place: "g1", dm: false })).toContain("이곳: OmO 팬 서버");
    expect(memoryLines({ place: "g2", dm: false })).not.toContain("OmO");
    expect(state.agentNotes!.filter((n) => n.kind === "lesson")).toHaveLength(1);
    forgetNote(state.agentNotes![0].id);
    expect(state.agentNotes).toHaveLength(1);
  });

  it("an answer that isn't a JSON list changes nothing", () => {
    expect(applyDigest("남길 게 없어요", { dm: false, people: {} })).toBe(0);
    expect(applyDigest("[{broken", { dm: false, people: {} })).toBe(0);
    expect(state.agentNotes ?? []).toHaveLength(0);
  });

  it("the pass is told to leave the user's work out, and sees who said what by id", () => {
    const p = digestPrompt(agent, [{ who: "11", name: "민수", text: "다음 버전 언제 나와요?" }, { who: "1", name: "주인", text: "0.64에 디스코드 기능 넣을 거야", owner: true }, { who: "bot", name: "메타몽", text: "그건 못 알려줘요", me: true }], { place: "g1", dm: false });
    expect(p).toContain("주인의 일: 프로젝트, 코드, 계획, 아직 안 나온 것");
    expect(p).toContain("민수[11]");
    expect(p).toContain("(주인)");
    expect(p).toContain("메타몽(너)");
  });
});
