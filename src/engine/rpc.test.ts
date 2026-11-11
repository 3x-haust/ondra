import { describe, expect, it } from "vitest";
import { explain, providerSays } from "./rpc";

describe("provider errors", () => {
  it("reads the provider's own message out of the status and JSON", () => {
    const raw = `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}`;
    expect(providerSays(raw)).toBe("This request would exceed your account's rate limit. Please try again later.");
    expect(explain(raw)).toBe("사용 한도 도달 · This request would exceed your account's rate limit. Please try again later.");
  });
  it("cuts a long message at a word", () => {
    const raw = `429 ${"limit reached ".repeat(20)}`;
    const said = explain(raw);
    expect(said.endsWith("…")).toBe(true);
    expect(said).not.toMatch(/\s…$/);
    expect(said).not.toContain("429");
  });
});
