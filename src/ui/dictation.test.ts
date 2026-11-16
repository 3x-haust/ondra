import { describe, expect, it } from "vitest";
import { clock, dictateLang, insertWords, pushLevel, readDictate, smoothLevel } from "./dictation";

describe("the dictation helper's lines", () => {
  it("reads each kind of line", () => {
    expect(readDictate({ id: 5, ready: true }, 5)).toEqual({ kind: "ready" });
    expect(readDictate({ id: 5, level: 0.4 }, 5)).toEqual({ kind: "level", level: 0.4 });
    expect(readDictate({ id: 5, partial: "안녕하" }, 5)).toEqual({ kind: "partial", text: "안녕하" });
    expect(readDictate({ id: 5, final: "안녕하세요." }, 5)).toEqual({ kind: "final", text: "안녕하세요." });
    expect(readDictate({ id: 5, final: "" }, 5)).toEqual({ kind: "final", text: "" });
    expect(readDictate({ id: 5, limit: true }, 5)).toEqual({ kind: "limit" });
    expect(readDictate({ id: 5, end: true }, 5)).toEqual({ kind: "end" });
  });
  it("names an error, and one it doesn't know as a failure", () => {
    expect(readDictate({ id: 5, error: "mic-denied" }, 5)).toEqual({ kind: "error", code: "mic-denied" });
    expect(readDictate({ id: 5, error: "failed", detail: "boom" }, 5)).toEqual({ kind: "error", code: "failed", detail: "boom" });
    expect(readDictate({ id: 5, error: "something-new" }, 5)).toEqual({ kind: "error", code: "failed" });
  });
  it("ignores another run's lines, lines with no run going, and lines it doesn't know", () => {
    expect(readDictate({ id: 4, final: "old" }, 5)).toBeNull();
    expect(readDictate({ id: 0, final: "x" }, 0)).toBeNull();
    expect(readDictate({ id: 5, level: Number.NaN }, 5)).toBeNull();
    expect(readDictate({ id: 5, hello: 1 }, 5)).toBeNull();
  });
  it("keeps the level between 0 and 1", () => {
    expect(readDictate({ id: 5, level: 3 }, 5)).toEqual({ kind: "level", level: 1 });
    expect(readDictate({ id: 5, level: -1 }, 5)).toEqual({ kind: "level", level: 0 });
  });
});

describe("the level meter", () => {
  it("rises fast and falls slowly", () => {
    const up = smoothLevel(0, 1);
    const down = smoothLevel(1, 0);
    expect(up).toBeCloseTo(0.8);
    expect(down).toBeCloseTo(0.7);
    expect(smoothLevel(0.5, 0.5)).toBe(0.5);
  });
  it("brings the newest level in on the right", () => {
    expect(pushLevel([0.1, 0.2, 0.3], 0.9)).toEqual([0.2, 0.3, 0.9]);
  });
  it("moves nothing sideways with reduced motion", () => {
    expect(pushLevel([0.1, 0.2, 0.3], 0.9, true)).toEqual([0.9, 0.9, 0.9]);
  });
});

describe("dictation bits", () => {
  it("speaks the app's language", () => {
    expect(dictateLang("ko")).toBe("ko-KR");
    expect(dictateLang("en")).toBe("en-US");
  });
  it("shows the time as m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9.7)).toBe("0:09");
    expect(clock(75)).toBe("1:15");
    expect(clock(-2)).toBe("0:00");
  });
});

describe("where dictated words go", () => {
  it("into an empty box", () => {
    expect(insertWords("", 0, 0, " 안녕하세요 ")).toEqual({ value: "안녕하세요", caret: 5 });
  });
  it("after text, with a space between", () => {
    expect(insertWords("이거", 2, 2, "고쳐줘")).toEqual({ value: "이거 고쳐줘", caret: 6 });
    expect(insertWords("이거 ", 3, 3, "고쳐줘")).toEqual({ value: "이거 고쳐줘", caret: 6 });
  });
  it("in the middle, spaced on both sides", () => {
    const r = insertWords("fix bug", 3, 3, "the login");
    expect(r.value).toBe("fix the login bug");
    expect(r.caret).toBe("fix the login".length);
  });
  it("over a selection", () => {
    expect(insertWords("fix this bug", 4, 8, "that")).toEqual({ value: "fix that bug", caret: 8 });
  });
  it("without a space before punctuation or after an opening bracket", () => {
    expect(insertWords("Hello", 5, 5, ", world")).toEqual({ value: "Hello, world", caret: 12 });
    expect(insertWords("(", 1, 1, "note")).toEqual({ value: "(note", caret: 5 });
    expect(insertWords("a.", 1, 1, "b").value).toBe("a b.");
  });
  it("changes nothing for no words", () => {
    expect(insertWords("abc", 1, 2, "  ")).toEqual({ value: "abc", caret: 2 });
  });
});
