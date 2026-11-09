import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchShortcutHold } from "./shortcutHold";

const key = (type = "keydown", extra: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), {
  key: "Meta", code: "MetaLeft", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
  repeat: false, isComposing: false, keyCode: 0, ...extra,
});

describe("hold Command to reveal shortcuts", () => {
  let target: EventTarget;
  let show: ReturnType<typeof vi.fn<() => void>>;
  let hide: ReturnType<typeof vi.fn<() => void>>;
  let allowed: ReturnType<typeof vi.fn<() => boolean>>;
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    target = new EventTarget();
    show = vi.fn(); hide = vi.fn(); allowed = vi.fn(() => true);
    stop = watchShortcutHold(target, allowed, show, hide);
  });
  afterEach(() => { stop(); vi.useRealTimers(); });

  it("reveals after a deliberate hold without consuming the key", () => {
    const event = key();
    target.dispatchEvent(event);
    vi.advanceTimersByTime(499);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    target.dispatchEvent(key("keyup", { metaKey: false }));
    expect(hide).toHaveBeenCalled();
  });

  it("does not flash on a quick tap", () => {
    target.dispatchEvent(key());
    vi.advanceTimersByTime(100);
    target.dispatchEvent(key("keyup", { metaKey: false }));
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
  });

  it("cancels a chord and does not rearm until Command is released", () => {
    target.dispatchEvent(key());
    const chord = key("keydown", { key: "b", code: "KeyB" });
    target.dispatchEvent(chord);
    target.dispatchEvent(key("keyup", { key: "b" }));
    target.dispatchEvent(key());
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
    expect(chord.defaultPrevented).toBe(false);
    target.dispatchEvent(key("keyup", { metaKey: false }));
    target.dispatchEvent(key());
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }])("ignores composition, repetition and other modifiers: %j", (extra) => {
    target.dispatchEvent(key("keydown", extra));
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
  });

  it("respects a consumed key", () => {
    const event = key(); event.preventDefault();
    target.dispatchEvent(event);
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
  });

  it("checks context both on press and when the delay expires", () => {
    allowed.mockReturnValue(false);
    target.dispatchEvent(key());
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
    target.dispatchEvent(key("keyup", { metaKey: false }));
    allowed.mockReturnValue(true);
    target.dispatchEvent(key());
    allowed.mockReturnValue(false);
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
  });

  it.each(["blur", "visibilitychange", "pointerdown", "focusin", "compositionstart", "scroll", "resize"])("dismisses and cancels pending hints on %s", (event) => {
    target.dispatchEvent(key());
    target.dispatchEvent(new Event(event));
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
  });

  it("follows the hold the user bound", () => {
    stop();
    let bound: { code: string; alt?: boolean; meta?: boolean } | undefined = { code: "", alt: true, meta: true };
    stop = watchShortcutHold(target, allowed, show, hide, () => bound);
    // ⌘ alone isn't it; ⌥ joining makes it
    target.dispatchEvent(key());
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
    target.dispatchEvent(key("keydown", { key: "Alt", code: "AltLeft", altKey: true }));
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledTimes(1);
    // letting ⌥ go ends it
    target.dispatchEvent(key("keyup", { key: "Alt", code: "AltLeft", altKey: false }));
    expect(hide).toHaveBeenCalled();
    // unbound: nothing shows
    bound = undefined;
    target.dispatchEvent(key("keyup", { metaKey: false }));
    target.dispatchEvent(key());
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("cleans up timers and listeners on unmount", () => {
    target.dispatchEvent(key());
    stop();
    target.dispatchEvent(key());
    vi.advanceTimersByTime(500);
    expect(show).not.toHaveBeenCalled();
  });
});
