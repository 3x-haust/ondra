import { describe, expect, it } from "vitest";
import { asQuote } from "./quote";

describe("asQuote", () => {
  it("quotes each line and keeps blank lines inside the quote", () => {
    expect(asQuote("  한 줄  ")).toBe("> 한 줄");
    expect(asQuote("첫 줄\n\n둘째 줄\n")).toBe("> 첫 줄\n>\n> 둘째 줄");
  });
});
