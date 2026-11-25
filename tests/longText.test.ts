// Long text never wraps one letter per line (docs/DESIGN.md §9.16). These hold the base rules
// that make that true everywhere, and catch the one pattern that undoes them.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = (rel: string) => new URL(rel, import.meta.url);
const sheets = [
  ...readdirSync(dir("../src/styles/")).filter((f) => f.endsWith(".css")).map((f) => ({ name: `styles/${f}`, css: readFileSync(dir(`../src/styles/${f}`), "utf8") })),
  ...readdirSync(dir("../src/ui/")).filter((f) => f.endsWith(".css")).map((f) => ({ name: `ui/${f}`, css: readFileSync(dir(`../src/ui/${f}`), "utf8") })),
];

/** every innermost `selector { declarations }` of a sheet (inside @media and @container too) */
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].trim().split(",").map((s) => s.trim()),
    body: m[2],
  }));
const has = (body: string, prop: string, value: RegExp) =>
  body.split(";").some((d) => d.split(":")[0]?.trim() === prop && value.test(d.slice(d.indexOf(":") + 1)));

const core = sheets.find((s) => s.name === "styles/core.css")!.css;
const all = sheets.flatMap((s) => rules(s.css).map((r) => ({ ...r, sheet: s.name })));

describe("long text", () => {
  it("the base breaks Korean between words and a word only when it must", () => {
    const body = rules(core).filter((r) => r.selectors.includes("body"));
    expect(body.some((r) => has(r.body, "word-break", /keep-all/) && has(r.body, "overflow-wrap", /break-word/))).toBe(true);
  });

  it("no page-wide rule lets any box shrink to one letter", () => {
    const wide = new Set(["*", "html", "body", ":root", "#root", ".app", ".main", ".view"]);
    const bad = all.filter((r) => r.selectors.some((s) => wide.has(s)) && (has(r.body, "overflow-wrap", /anywhere/) || has(r.body, "word-break", /break-all/)));
    expect(bad.map((r) => `${r.sheet}: ${r.selectors.join(", ")}`)).toEqual([]);
  });

  it("a row of things never breaks anywhere (its labels would go one letter a line)", () => {
    // rows that hold one value only: a dot and a name, a memory field's value
    const one = new Set([".sl-road-name", ".mp dd"]);
    const bad = all.filter(
      (r) =>
        has(r.body, "display", /(^|\s)(inline-)?(flex|grid)\b/) &&
        !has(r.body, "flex-direction", /column/) &&
        has(r.body, "overflow-wrap", /anywhere/) &&
        !r.selectors.every((s) => one.has(s)),
    );
    expect(bad.map((r) => `${r.sheet}: ${r.selectors.join(", ")}`)).toEqual([]);
  });

  it("buttons, chips and segmented controls keep one line", () => {
    for (const sel of [".btn", ".chip", ".pill", ".seg button"]) {
      expect(rules(core).some((r) => r.selectors.includes(sel) && has(r.body, "white-space", /nowrap/)), sel).toBe(true);
    }
  });

  it("a page never pushes the work area wider", () => {
    expect(rules(core).some((r) => r.selectors.includes(".main > *") && has(r.body, "min-width", /^\s*0\s*$/))).toBe(true);
  });
});
