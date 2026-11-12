import { describe, expect, it } from "vitest";
import { isPastedText, longPaste } from "./paste";

describe("long pastes", () => {
  it("go in as a file when long or many lines, stay text when short", () => {
    expect(longPaste("짧은 글")).toBe(false);
    expect(longPaste("가".repeat(1500))).toBe(true);
    expect(longPaste(Array(25).fill("line").join("\n"))).toBe(true);
    expect(longPaste(Array(10).fill("line").join("\n"))).toBe(false);
  });
  it("are known by the file save_paste writes", () => {
    expect(isPastedText("/Users/x/Library/Application Support/ondra/attachments/paste-1731400000000.txt")).toBe(true);
    expect(isPastedText("/Users/x/Library/Application Support/ondra/attachments/paste-1731400000000.png")).toBe(false);
    expect(isPastedText("/tmp/notes.txt")).toBe(false);
  });
});
