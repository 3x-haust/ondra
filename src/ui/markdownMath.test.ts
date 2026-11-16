import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { inlineDollar, mathExtensions } from "./markdownMath";

const md = new Marked({ gfm: true, breaks: true, extensions: mathExtensions });
const html = (s: string) => md.parse(s, { async: false }) as string;
const texes = (s: string) => [...html(s).matchAll(/data-tex="([^"]*)"/g)].map((m) => m[1]);

describe("math in prose", () => {
  it("reads $…$ and \\(…\\) inline", () => {
    expect(texes("면적은 $\\pi r^2$ 이고 \\(a+b\\) 예요")).toEqual(["\\pi r^2", "a+b"]);
  });

  it("leaves money alone", () => {
    for (const s of ["$5 and $10", "가격은 $5이고 $3이다", "costs $5, $ 6$", "$x $"]) expect(texes(s), s).toEqual([]);
    expect(inlineDollar("$5 and $10")).toBeUndefined();
    expect(inlineDollar("$x$5")).toBeUndefined();
    expect(inlineDollar("$x$.")).toEqual({ raw: "$x$", tex: "x" });
  });

  it("reads $$…$$ and \\[…\\] blocks, even right under a line of text", () => {
    const out = html("식:\n$$\n\\sum_{i=1}^n i\n$$\n끝");
    expect(out).toContain('class="md-math md-math-block"');
    expect(out).toContain('data-tex="\\sum_{i=1}^n i"');
    expect(out).toContain("끝");
    expect(texes("\\[\nE=mc^2\n\\]")).toEqual(["E=mc^2"]);
  });

  it("keeps markdown out of a formula and code out of math", () => {
    expect(texes("$a_1 * b_2 * c$")).toEqual(["a_1 * b_2 * c"]);
    expect(texes("`$x$` 는 코드")).toEqual([]);
  });

  it("an unclosed formula (still streaming) stays text", () => {
    expect(texes("$$\n\\frac{a}{")).toEqual([]);
    expect(texes("값은 $x + ")).toEqual([]);
  });

  it("escapes the TeX it keeps for later", () => {
    expect(html('$a<b$')).toContain('data-tex="a&lt;b"');
  });
});
