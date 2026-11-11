import { describe, expect, it } from "vitest";
import { redact } from "./log";

describe("the app log", () => {
  it("never keeps keys, tokens, emails or the home folder's name", () => {
    const s = redact("key sk-proj-abcdef1234567890XYZ, ghp_ABCDEFGHIJKLMNOP1234 Bearer abc.def.ghijklmn token=hunter2secret me@example.com /Users/lyu/Work/x");
    expect(s).not.toMatch(/abcdef1234567890|ABCDEFGHIJKLMNOP|abc\.def\.ghijklmn|hunter2|example\.com|\/Users\/lyu/);
    expect(s).toContain("~/Work/x");
  });
});

