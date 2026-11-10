import { describe, expect, it } from "vitest";
import { asQuote, splitQuotes, withQuotes } from "./quote";

describe("asQuote", () => {
  it("quotes each line and keeps blank lines inside the quote", () => {
    expect(asQuote("  한 줄  ")).toBe("> 한 줄");
    expect(asQuote("첫 줄\n\n둘째 줄\n")).toBe("> 첫 줄\n>\n> 둘째 줄");
  });
});

describe("quotes", () => {
  it("sends the quotes first, then the words", () => {
    expect(withQuotes(["Steam 인증과 다운로드 경로를\n별도로 연동해야 해요."], "이건 어떻게 해?")).toBe("> Steam 인증과 다운로드 경로를\n> 별도로 연동해야 해요.\n\n이건 어떻게 해?");
  });
  it("reads them back for the bubble", () => {
    expect(splitQuotes("> 첫 줄\n> 둘째 줄\n\n> 다른 인용\n\n이건 어떻게 해?")).toEqual({ quotes: ["첫 줄\n둘째 줄", "다른 인용"], rest: "이건 어떻게 해?" });
    expect(splitQuotes("그냥 말")).toEqual({ quotes: [], rest: "그냥 말" });
  });
});
