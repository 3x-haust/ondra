import { describe, expect, it } from "vitest";
import { answerRound, readClarity, readRound, roundDecision, roundText } from "./round";

const block = {
  type: "ask",
  questions: [
    { question: "밀린 회차는 어떻게 할까요?", recommend: "최근 회차 하나만 남겨요", why: "운동이 세 개씩 쌓이지 않게" },
    { question: "반복 종류는요?", recommend: "매일 · 매주" },
    { question: "완료는 무슨 뜻인가요?", options: [{ label: "이번 회차를 끝냄" }, { label: "반복을 그만둠" }] },
  ],
  clarity: { score: 0.62, parts: [{ label: "목표", score: 0.9 }, { label: "완료 기준", score: 0.3 }] },
};

describe("a round of questions (the sharpen skill)", () => {
  it("reads each question with one recommended answer: the first option when it came with several", () => {
    const r = readRound(block)!;
    expect(r.qs.map((q) => q.recommend)).toEqual(["최근 회차 하나만 남겨요", "매일 · 매주", "이번 회차를 끝냄"]);
    expect(r.qs[0].note).toBe("운동이 세 개씩 쌓이지 않게");
    expect(readRound({ type: "ask", question: "한 개", options: ["a"] })).toBeUndefined();
    expect(readRound({ type: "ask", questions: [{ question: "", recommend: "x" }] })).toBeUndefined();
  });

  it("asks one at a time on the usual card: the recommendation is its only choice, anything else is typed in the chat box", () => {
    const r = readRound(block)!;
    const d = roundDecision({ id: "d1", taskId: "t", at: 1, context: [] }, r.qs, [], r.clarity);
    expect(d.question).toBe("밀린 회차는 어떻게 할까요?");
    expect(d.options[0]).toMatchObject({ label: "최근 회차 하나만 남겨요", primary: true, note: "운동이 세 개씩 쌓이지 않게" });
    expect(d.options.map((o) => o.id)).toEqual(["o0"]);
    expect(d.round).toMatchObject({ n: 1, total: 3 });
    expect(d.clarity?.score).toBe(0.62);
  });

  it("the last question of a round is the same card", () => {
    const r = readRound(block)!;
    const d = roundDecision({ id: "d", taskId: "t", at: 1, context: [] }, r.qs.slice(2), [{ q: "a", a: "b" }, { q: "c", a: "d" }]);
    expect(d.options.map((o) => o.id)).toEqual(["o0"]);
    expect(d.round).toMatchObject({ n: 3, total: 3 });
  });

  it("each answer brings the next question at once; the last sends all answers together", () => {
    const r = readRound(block)!;
    let d = roundDecision({ id: "d1", taskId: "t", at: 1, context: [] }, r.qs, []);
    let step = answerRound(d, "o0");
    expect(step.next?.question).toBe("반복 종류는요?");
    d = step.next!;
    step = answerRound(d, "매일만, 매주는 나중에");
    d = step.next!;
    step = answerRound(d, "o0");
    expect(step.next).toBeUndefined();
    expect(step.answers).toEqual([
      { q: "밀린 회차는 어떻게 할까요?", a: "최근 회차 하나만 남겨요" },
      { q: "반복 종류는요?", a: "매일만, 매주는 나중에" },
      { q: "완료는 무슨 뜻인가요?", a: "이번 회차를 끝냄" },
    ]);
    expect(roundText(step.answers)).toBe('"밀린 회차는 어떻게 할까요?" → 최근 회차 하나만 남겨요\n"반복 종류는요?" → 매일만, 매주는 나중에\n"완료는 무슨 뜻인가요?" → 이번 회차를 끝냄');
  });

  it("clarity is 0–1 (a percentage is read as one), parts kept short", () => {
    expect(readClarity(62)?.score).toBe(0.62);
    expect(readClarity({ score: 140 })?.score).toBe(1);
    expect(readClarity("x")).toBeUndefined();
    expect(readClarity({ score: 0.5, parts: [{ label: "목표", score: 80 }, { label: "" }] })?.parts).toEqual([{ label: "목표", score: 0.8 }]);
  });
});

describe("answering a round", () => {
  it("a job's round: the next card at once, each answer in its thread, all of them sent after the last", async () => {
    const { reconcile } = await import("solid-js/store");
    const { freshState, setState, state } = await import("../state/store");
    const { decide } = await import("./tasks");
    setState(reconcile(freshState()));
    setState("tasks", [{ id: "j", space: "home", topic: "", title: "반복", ask: "", cwd: "/r", status: "waiting", priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [] } as never]);
    const r = readRound(block)!;
    setState("decisions", [roundDecision({ id: "d1", taskId: "j", at: 1, context: [] }, r.qs, [])]);
    await decide("d1", "o0");
    expect(state.decisions.map((d) => d.question)).toEqual(["반복 종류는요?"]);
    expect(state.tasks[0].entries.map((e) => (e as { text?: string }).text)).toEqual(['"밀린 회차는 어떻게 할까요?" → 최근 회차 하나만 남겨요']);
    // an answer typed in the chat box instead of the recommendation
    await decide(state.decisions[0].id, "매일만");
    await decide(state.decisions[0].id, "o0");
    expect(state.decisions).toHaveLength(0);
    const texts = state.tasks[0].entries.map((e) => (e as { text?: string }).text);
    expect(texts).toEqual([
      '"밀린 회차는 어떻게 할까요?" → 최근 회차 하나만 남겨요',
      '"반복 종류는요?" → 매일만',
      '"완료는 무슨 뜻인가요?" → 이번 회차를 끝냄',
    ]);
  });
});
