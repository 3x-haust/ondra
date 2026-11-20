import { describe, expect, it } from "vitest";
import { keepStrayKeysOut, withoutStrays } from "./strayKeys";

describe("the characters macOS gives arrow keys", () => {
  it("are taken out of text, with the cursor kept in place", () => {
    expect(withoutStrays("그렇거든", 7)).toEqual({ text: "그렇거든", at: 4 });
    expect(withoutStrays("가나다", 3)).toEqual({ text: "가나다", at: 2 });
    // text without them, and the Apple logo (U+F8FF, typed with ⌥⇧K), stay as they are
    expect(withoutStrays("안녕 ", 4)).toEqual({ text: "안녕 ", at: 4 });
  });

  it("never reach a field's own handler, and typing one is refused", () => {
    const on: Record<string, (e: unknown) => void> = {};
    keepStrayKeysOut({ addEventListener: (k: string, fn: (e: unknown) => void) => (on[k] = fn) } as never);
    const ta = { tagName: "TEXTAREA", value: "그렇거든\uF703\uF703", selectionEnd: 6, at: -1, setSelectionRange(a: number) { this.at = a; } };
    on.input({ target: ta });
    expect(ta.value).toBe("그렇거든");
    expect(ta.at).toBe(4);
    let refused = false;
    on.beforeinput({ cancelable: true, data: "\uF703", preventDefault: () => (refused = true) });
    expect(refused).toBe(true);
    refused = false;
    on.beforeinput({ cancelable: true, data: "든", preventDefault: () => (refused = true) });
    expect(refused).toBe(false);
  });
});
