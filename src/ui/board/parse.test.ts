import { describe, expect, it } from "vitest";
import { parseBoard, words } from "./parse";
import { box, polyline } from "./sketch";

describe("parseBoard", () => {
  it("reads strokes in order, each under the step before it", () => {
    const b = parseBoard(`title 커피 원리
box 300 30 200 56 "뜨거운 물" live fill
step 물을 부어요
arrow 400 86 400 150 "흘러요"
step 맛이 녹아요
circle 400 210 60 "원두" warn
text 480 210 "약 4분" quiet size=16 bold
mark 10 10 100 20
dot 5 5`);
    expect(b.title).toBe("커피 원리");
    expect(b.steps.map((s) => s.text)).toEqual(["물을 부어요", "맛이 녹아요"]);
    expect(b.marks.map((m) => [m.kind, m.step])).toEqual([["box", 0], ["arrow", 0], ["circle", 1], ["text", 1], ["mark", 1], ["dot", 1]]);
    expect(b.marks[0]).toMatchObject({ label: "뜨거운 물", tone: "live", fill: true, w: 200 });
    expect(b.marks[1]).toMatchObject({ pts: [[400, 86], [400, 150]], head: true, label: "흘러요" });
    expect(b.marks[3]).toMatchObject({ text: "약 4분", tone: "quiet", size: 16, bold: true });
    expect(b.problems).toEqual([]);
  });

  it("skips what it can't read and says why, without stopping", () => {
    const b = parseBoard(`box 1 2 "no size"
wiggle 1 2
circle 10 10 5
text 1 2 "half written`);
    expect(b.marks.map((m) => m.kind)).toEqual(["circle"]);
    expect(b.problems).toHaveLength(3);
  });

  it("reads 3D parts: sizes, place, turn and material", () => {
    const b = parseBoard(`step 받침
part "받침" box 2 0.2 2 at 0 0.1 0 wood
step 기둥
part "기둥" cylinder 0.08 3 0.05 at 0 1.6 0 rot 0 0 10 steel
part "전구" sphere 0.3 at 0 3.4 0 warn
part "틀림" cylinder at 0 0 0`);
    expect(b.parts).toEqual([
      { step: 0, label: "받침", shape: "box", dims: [2, 0.2, 2], at: [0, 0.1, 0], rot: [0, 0, 0], look: "wood" },
      { step: 1, label: "기둥", shape: "cylinder", dims: [0.08, 3, 0.05], at: [0, 1.6, 0], rot: [0, 0, 10], look: "steel" },
      { step: 1, label: "전구", shape: "sphere", dims: [0.3], at: [0, 3.4, 0], rot: [0, 0, 0], look: "warn" },
    ]);
    expect(b.problems).toHaveLength(1);
  });

  it("keeps quoted words whole, and an unclosed quote means the line isn't finished", () => {
    expect(words(`1 2 "a \\"b\\" c" accent`)).toEqual(["1", "2", '"a "b" c', "accent"]);
    expect(words(`1 2 "half`)).toBeUndefined();
  });
});

describe("sketch", () => {
  it("draws a box as one closed stroke from its top-left", () => {
    const d = box(0, 0, 100, 50);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d).toMatch(/^M8 0H92A8 8/);
    expect(d).toMatch(/Z$/);
  });
  it("makes one continuous stroke through a bent line, rounding the bend", () => {
    const d = polyline([[0, 0], [100, 0], [100, 100]]);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d).toBe("M0 0L88 0Q100 0 100 12L100 100");
  });
});

describe("steps", () => {
  it("drops the numbers the model put on its steps", () => {
    expect(parseBoard("step 1. 연결해요\nstep 2) 보내요\nstep ② 받아요\nstep 2024년에 나왔어요").steps.map((s) => s.text))
      .toEqual(["연결해요", "보내요", "받아요", "2024년에 나왔어요"]);
  });
});
