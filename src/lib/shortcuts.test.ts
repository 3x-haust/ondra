import { describe, expect, it, vi } from "vitest";
import { dispatchShortcut, matchesShortcut, shortcutHint, shortcutLabel, shortcuts, type Shortcut, type ShortcutCommand, type ShortcutContext } from "./shortcuts";

function key(s: Shortcut, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const e = {
    code: s.code, key: s.code, metaKey: !!s.meta, ctrlKey: !!s.ctrl, altKey: !!s.alt, shiftKey: !!s.shift,
    defaultPrevented: false, isComposing: false, keyCode: 0, repeat: false, ...extra,
    preventDefault: vi.fn(() => { e.defaultPrevented = true; }),
  };
  return e as unknown as KeyboardEvent;
}
const context: ShortcutContext = { editing: false, overlay: false, local: false };
const action = (extra: Partial<ShortcutCommand> = {}): ShortcutCommand => ({
  id: "sidebar", label: "sidebar", section: "view", icon: "panelLeft", shortcut: shortcuts.sidebar, run: vi.fn(), ...extra,
});

describe("app keyboard shortcuts", () => {
  it.each(Object.entries(shortcuts))("matches the exact %s chord", (_id, chord) => {
    expect(matchesShortcut(key(chord), chord)).toBe(true);
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      const e = key(chord);
      expect(matchesShortcut(key(chord, { [modifier]: !e[modifier] }), chord)).toBe(false);
    }
  });

  it("keeps every chord unique", () => {
    const labels = Object.values(shortcuts).map(shortcutLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("uses physical keys after switching to Korean without intercepting composition", () => {
    expect(matchesShortcut(key(shortcuts.sidebar, { key: "ㅠ" }), shortcuts.sidebar)).toBe(true);
    expect(matchesShortcut(key(shortcuts.sidebar, { key: "ㅠ", isComposing: true }), shortcuts.sidebar)).toBe(false);
  });

  it.each([
    { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true },
  ])("ignores an owned, repeated or composing key: %j", (extra) => {
    const c = action();
    const e = key(shortcuts.sidebar, extra);
    expect(dispatchShortcut(e, [c], context)).toBe(false);
    expect(c.run).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    { overlay: true }, { editing: true }, { local: true },
  ])("does not change the background or an editor: %j", (extra) => {
    const c = action();
    const e = key(shortcuts.sidebar);
    expect(dispatchShortcut(e, [c], { ...context, ...extra })).toBe(false);
    expect(c.run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("only allows explicitly opted-in commands in plain text inputs", () => {
    const c = action({ shortcut: shortcuts.search, inInput: true });
    expect(dispatchShortcut(key(shortcuts.search), [c], { ...context, editing: true })).toBe(true);
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(dispatchShortcut(key(shortcuts.search), [c], { ...context, editing: true, local: true })).toBe(false);
    expect(dispatchShortcut(key(shortcuts.search), [c], { ...context, editing: true, overlay: true })).toBe(false);
    expect(c.run).toHaveBeenCalledTimes(1);
  });

  it("leaves unavailable actions and unmatched keys untouched", () => {
    const c = action({ enabled: () => false });
    const e = key(shortcuts.sidebar);
    expect(dispatchShortcut(e, [c], context)).toBe(false);
    expect(dispatchShortcut(key(shortcuts.memory), [action()], context)).toBe(false);
    expect(c.run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("consumes a matched key once even if another listener sees it", () => {
    const c = action();
    const other = action();
    const e = key(shortcuts.sidebar);
    expect(dispatchShortcut(e, [c, other], context)).toBe(true);
    expect(dispatchShortcut(e, [c, other], context)).toBe(false);
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(other.run).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not claim OS and text editing chords", () => {
    const commands = Object.values(shortcuts).map((shortcut) => action({ shortcut }));
    for (const code of ["KeyQ", "KeyH", "KeyM", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyA", "Space", "Tab"]) {
      expect(dispatchShortcut(key({ code, meta: true }), commands, context)).toBe(false);
    }
    expect(dispatchShortcut(key({ code: "Space", ctrl: true }), commands, context)).toBe(false);
    expect(dispatchShortcut(key({ code: "KeyF", ctrl: true, meta: true }), commands, context)).toBe(false);
  });

  it("shows the same chord that opens each tool", () => {
    expect(shortcutHint("sidebar")).toBe("⌘B");
    expect(shortcutHint("flow")).toBe("⇧⌘F");
    expect(shortcutHint("commands")).toBe("⇧⌘P");
    expect(shortcutHint("previousTab")).toBe("⌃⇧⇥");
  });
});
