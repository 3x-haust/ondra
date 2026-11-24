import { describe, expect, it } from "vitest";
import { carryTokens, dropToken, eraseToken, fileLine, listLine, putToken, splitTokens, tokenAt, tokensIn } from "./imageTokens";

describe("image tokens", () => {
  it("go in where the caret is, spaced from the words", () => {
    expect(putToken("이거 봐", 2, 2, 1)).toEqual({ text: "이거 [Image #1] 봐", caret: 13 });
    expect(putToken("", 0, 0, 2)).toEqual({ text: "[Image #2] ", caret: 11 });
    expect(putToken("abc", 3, 3, 3).text).toBe("abc [Image #3] ");
  });
  it("come out with their space when the picture is taken off", () => {
    expect(dropToken("이거 [Image #1] 봐", 1)).toBe("이거 봐");
    expect(dropToken("[Image #2] 그리고 [Image #12]", 2)).toBe("그리고 [Image #12]");
    expect(dropToken("끝 [Image #1]", 1)).toBe("끝");
  });
  it("are found under the caret only inside them", () => {
    const s = "a [Image #3] b";
    expect(tokenAt(s, 2)).toBeNull();
    expect(tokenAt(s, 5)).toBe(3);
    expect(tokenAt(s, 12)).toBeNull();
  });
  it("split the words for chips", () => {
    expect(splitTokens("봐 [Image #1]와 [Image #2]")).toEqual(["봐 ", { n: 1 }, "와 ", { n: 2 }]);
  });
  it("number the pictures in the attached list, and read back", () => {
    expect(listLine("/a/x.png", 1)).toBe("- [Image #1] /a/x.png");
    expect(listLine("/a/y.txt")).toBe("- /a/y.txt");
    expect(fileLine(listLine("/a/x y.png", 4))).toEqual({ path: "/a/x y.png", n: 4 });
    expect(fileLine("- /a/y.txt")).toEqual({ path: "/a/y.txt" });
  });

  it("go as one piece: backspace after one (or delete before it) takes the whole token, and says which picture", () => {
    const text = "이거 [Image #1] 봐";
    expect(eraseToken(text, 13, 13, true)).toEqual({ text: "이거 봐", caret: 3, n: 1 });
    expect(eraseToken(text, 8, 8, true)).toEqual({ text: "이거 봐", caret: 3, n: 1 });
    expect(eraseToken(text, 3, 3, false)).toEqual({ text: "이거 봐", caret: 3, n: 1 });
    expect(eraseToken("[Image #2] ", 10, 10, true)).toEqual({ text: "", caret: 0, n: 2 });
    // not on a token, or a selection: typing as usual
    expect(eraseToken(text, 2, 2, true)).toBeNull();
    expect(eraseToken(text, 3, 3, true)).toBeNull();
    expect(eraseToken(text, 14, 14, false)).toBeNull();
    expect(eraseToken(text, 3, 13, true)).toBeNull();
  });
  it("say which pictures the words still name", () => {
    expect([...tokensIn("[Image #1] 그리고 [Image #12] [Image #")]).toEqual([1, 12]);
  });
});

describe("moving a picture with its token (cut, then paste)", () => {
  it("a cut picture comes back with its number where the words land", () => {
    const held = new Map([[1, "/a.png"]]);
    expect(carryTokens("[Image #1] 이거", held, new Map([["/b.png", 2]]))).toEqual({ text: "[Image #1] 이거", back: [["/a.png", 1]] });
  });
  it("its number taken by another picture meanwhile: the next free one", () => {
    const held = new Map([[1, "/a.png"]]);
    expect(carryTokens("[Image #1]", held, new Map([["/c.png", 1], ["/b.png", 2]]))).toEqual({ text: "[Image #3]", back: [["/a.png", 3]] });
  });
  it("copied (still attached): the same picture, by the number it has, nothing attached again", () => {
    expect(carryTokens("봐 [Image #2]", new Map([[2, "/a.png"]]), new Map([["/a.png", 2]]))).toEqual({ text: "봐 [Image #2]", back: [] });
  });
  it("a token it doesn't hold stays as typed", () => {
    expect(carryTokens("[Image #5]", new Map([[1, "/a.png"]]), new Map())).toEqual({ text: "[Image #5]", back: [] });
  });
});
