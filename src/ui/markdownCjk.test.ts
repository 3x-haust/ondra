import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { cjkStrong } from "./markdownCjk";

const m = new Marked({ gfm: true, breaks: true, tokenizer: { emStrong: cjkStrong } });
const html = (s: string) => m.parse(s) as string;

describe("bold next to Korean", () => {
  it("closes after a quote with a particle straight after", () => {
    expect(html('면 **"AI를 관리하지 말고, 일을 맡기세요."**를 써요')).toContain('<strong>&quot;AI를 관리하지 말고, 일을 맡기세요.&quot;</strong>를');
  });
  it("closes before a bracket a word sits against", () => {
    expect(html("이건**(중요)**해요")).toContain("<strong>(중요)</strong>해요");
  });
  it("keeps what is inside", () => {
    expect(html("**`a` 와 *b*.**는")).toContain("<strong><code>a</code> 와 <em>b</em>.</strong>는");
  });
  it("reads the rest as before", () => {
    expect(html("plain **bold** and ***both*** and *em*")).toBe(
      new Marked({ gfm: true, breaks: true }).parse("plain **bold** and ***both*** and *em*"),
    );
    expect(html("2 ** 3 ** 4")).not.toContain("<strong>");
    expect(html("**굵게**는")).toContain("<strong>굵게</strong>는");
  });
});
