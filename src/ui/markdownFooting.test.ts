import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { footing } from "./markdownFooting";

const md = new Marked({ extensions: [footing] });

describe("a claim's footing as a chip", () => {
  it("draws each label as its kind, leaving the sentence as written", () => {
    const html = md.parse("가설: 덮어쓰는 것 같아요 (추측). 원인은 `app.js:3`이에요 (확인함), 코드상 다른 곳은 없어요 (추론)") as string;
    expect(html).toContain('<span class="md-footing md-footing-guess">추측</span>');
    expect(html).toContain('<span class="md-footing md-footing-seen">확인함</span>');
    expect(html).toContain('<span class="md-footing md-footing-read">추론</span>');
    expect(html).toContain("덮어쓰는 것 같아요");
  });

  it("leaves other parentheses alone", () => {
    expect(md.parse("테스트 (12개) 통과") as string).not.toContain("md-footing");
  });
});
