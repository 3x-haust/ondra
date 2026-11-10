import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { rangeTilde } from "./markdownTilde";

const m = new Marked({ gfm: true, breaks: true, tokenizer: { del: rangeTilde } });

describe("a tilde in answers", () => {
  it("reads one ~ as a range, not a strikethrough", () => {
    const h = m.parse("시안 2~3벌에 각각 사진 12~30장을") as string;
    expect(h).not.toContain("<del>");
    expect(h).toContain("2~3벌에 각각 사진 12~30장을");
  });
  it("still strikes through with ~~", () => {
    expect(m.parse("이건 ~~취소~~ 예요") as string).toContain("<del>취소</del>");
  });
});
