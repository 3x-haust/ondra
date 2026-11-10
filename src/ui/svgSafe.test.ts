import { describe, expect, it } from "vitest";
import { hsl, tokenColor } from "./svgSafe";

describe("a drawn picture's colours", () => {
  it("reads literal colours", () => {
    expect(hsl("#fff")).toMatchObject({ s: 0, l: 1 });
    expect(hsl("rgb(255, 0, 0)")!.h).toBe(0);
    expect(hsl("var(--ink)")).toBeNull();
  });
  it("become the app's tokens: greys by lightness, colours by hue, words always readable", () => {
    expect(tokenColor("#0d0d0d", "fill")).toBe("var(--surface)");
    expect(tokenColor("#ffffff", "fill", true)).toBe("var(--ink)");
    expect(tokenColor("#3b6fd4", "stroke")).toBe("var(--accent)");
    expect(tokenColor("#2f9e7a", "stroke")).toBe("var(--ok)");
    expect(tokenColor("#2b3445", "fill")).toBe("var(--card)");
    expect(tokenColor("none", "fill")).toBeNull();
    expect(tokenColor("var(--accent)", "fill")).toBeNull();
  });
});
