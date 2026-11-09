import { afterEach, describe, expect, it } from "vitest";
import { setState, state } from "../state/store";
import { assign, changed, chordOf, conflictOf, moveTo, refusal, reset } from "./keybindings";
import {
  binding, chordLabel, chordText, dispatchShortcut, matchesShortcut, parseChord, shortcutHint, shortcutLabel, shortcuts, UNBOUND,
  type Shortcut, type ShortcutCommand,
} from "./shortcuts";

function press(s: Shortcut): KeyboardEvent {
  const e = {
    code: s.code, key: s.code, metaKey: !!s.meta, ctrlKey: !!s.ctrl, altKey: !!s.alt, shiftKey: !!s.shift,
    defaultPrevented: false, isComposing: false, keyCode: 0, repeat: false, preventDefault: () => { e.defaultPrevented = true; },
  };
  return e as unknown as KeyboardEvent;
}
const chord = (text: string) => parseChord(text)!;

afterEach(() => setState("settings", { keybindings: undefined }));

describe("chord text", () => {
  it.each(Object.entries(shortcuts))("round-trips the %s default", (_id, s) => {
    expect(parseChord(chordText(s))).toEqual(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== false)));
  });
  it("writes modifiers in one order and rejects anything else", () => {
    expect(chordText({ code: "KeyD", shift: true, meta: true, ctrl: true, alt: true })).toBe("ctrl+alt+shift+cmd+KeyD");
    for (const bad of ["", "cmd+", "hyper+KeyD", "cmd+cmd+KeyD", "cmd+d", "alt+cmd+cmd", UNBOUND]) expect(parseChord(bad)).toBeUndefined();
  });
  it("keeps modifiers held on their own as a chord with no key", () => {
    expect(chordText({ code: "", alt: true, meta: true })).toBe("alt+cmd");
    expect(parseChord("alt+cmd")).toEqual({ code: "", alt: true, meta: true });
    expect(chordLabel(chord("alt+cmd"))).toBe("⌥⌘");
    // it is held, never pressed
    expect(matchesShortcut(press(chord("cmd")), chord("cmd"))).toBe(false);
  });
  it("shows the sheet's own key as ?", () => {
    expect(chordLabel(shortcuts.keys)).toBe("?");
    expect(chordLabel(chord("ctrl+shift+Slash"))).toBe("⌃⇧/");
  });
  it("shows ⌃⌥⇧⌘ in the macOS order with key glyphs", () => {
    expect(chordLabel(chord("ctrl+alt+shift+cmd+KeyD"))).toBe("⌃⌥⇧⌘D");
    expect(chordLabel(chord("cmd+ArrowLeft"))).toBe("⌘←");
    expect(chordLabel(chord("shift+cmd+Enter"))).toBe("⇧⌘↵");
    expect(chordLabel(chord("ctrl+Tab"))).toBe("⌃⇥");
    expect(chordLabel(chord("cmd+Minus"))).toBe("⌘−");
    expect(chordLabel(chord("alt+cmd+BracketLeft"))).toBe("⌥⌘[");
  });
  it("records the physical key, whatever the layout types", () => {
    expect(chordOf({ code: "KeyD", key: "ㅇ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true } as KeyboardEvent)).toEqual({ code: "KeyD", meta: true, shift: true });
  });
});

describe("effective binding", () => {
  it("is the table default until the user sets one", () => {
    expect(binding("sidebar", {})).toBe(shortcuts.sidebar);
    expect(binding("sidebar", { sidebar: "ctrl+cmd+KeyS" })).toEqual(chord("ctrl+cmd+KeyS"));
    expect(binding("sidebar", { sidebar: UNBOUND })).toBeUndefined();
    // a stored chord that can't be read keeps the default
    expect(binding("sidebar", { sidebar: "nonsense" })).toBe(shortcuts.sidebar);
    expect(binding("noSuchId", {})).toBeUndefined();
  });

  it("drives matching, hints and dispatch from the settings", () => {
    const run = { calls: 0 };
    const command = (): ShortcutCommand => ({ id: "sidebar", label: "", section: "", icon: "", shortcut: binding("sidebar"), run: () => run.calls++ });
    const ctx = { overlay: false, editing: false, local: false };
    setState("settings", { keybindings: { sidebar: "ctrl+cmd+KeyS" } });
    expect(shortcutHint("sidebar")).toBe("⌃⌘S");
    // `shortcuts.sidebar` stands for the id: code that matches the table follows the user
    expect(matchesShortcut(press(shortcuts.sidebar), shortcuts.sidebar)).toBe(false);
    expect(matchesShortcut(press(chord("ctrl+cmd+KeyS")), shortcuts.sidebar)).toBe(true);
    expect(shortcutLabel(shortcuts.sidebar)).toBe("⌃⌘S");
    expect(dispatchShortcut(press(shortcuts.sidebar), [command()], ctx)).toBe(false);
    expect(dispatchShortcut(press(chord("ctrl+cmd+KeyS")), [command()], ctx)).toBe(true);
    expect(run.calls).toBe(1);

    setState("settings", { keybindings: { sidebar: UNBOUND } });
    expect(shortcutHint("sidebar")).toBe("");
    expect(command().shortcut).toBeUndefined();
    expect(matchesShortcut(press(shortcuts.sidebar), "sidebar")).toBe(false);
  });

  it("survives a save and load of the settings", () => {
    const next = moveTo(assign({}, "sidebar", chord("ctrl+cmd+KeyS")), "panel", shortcuts.memory);
    setState("settings", { keybindings: next });
    const saved = JSON.parse(JSON.stringify(state.settings));
    setState("settings", { keybindings: undefined });
    expect(shortcutHint("sidebar")).toBe("⌘B");
    // load merges what was saved over the defaults (store.ts)
    setState("settings", { ...state.settings, ...saved });
    expect(shortcutHint("sidebar")).toBe("⌃⌘S");
    expect(shortcutHint("panel")).toBe("⇧⌘M");
    expect(shortcutHint("memory")).toBe("");
  });
});

describe("changing a binding", () => {
  it("stores only what differs from the default", () => {
    expect(assign({}, "sidebar", shortcuts.sidebar)).toEqual({});
    expect(assign({}, "sidebar", null)).toEqual({ sidebar: UNBOUND });
    expect(assign({ sidebar: UNBOUND }, "sidebar", shortcuts.sidebar)).toEqual({});
    expect(assign({}, "noSuchId", shortcuts.sidebar)).toEqual({});
    // stale ids from an older version are dropped on the next write
    expect(assign({ gone: "cmd+KeyY" }, "sidebar", null)).toEqual({ sidebar: UNBOUND });
  });

  it("finds who else has a chord, defaults and overrides alike", () => {
    expect(conflictOf(shortcuts.memory, "sidebar", {})).toBe("memory");
    expect(conflictOf(shortcuts.sidebar, "sidebar", {})).toBeUndefined();
    expect(conflictOf(chord("ctrl+cmd+KeyS"), "panel", { sidebar: "ctrl+cmd+KeyS" })).toBe("sidebar");
    // an unbound command holds nothing
    expect(conflictOf(shortcuts.memory, "sidebar", { memory: UNBOUND })).toBeUndefined();
    expect(conflictOf(chord("ctrl+alt+cmd+KeyY"), "sidebar", {})).toBeUndefined();
  });

  it("moves a chord: the one who had it is left unbound", () => {
    const next = moveTo({}, "sidebar", shortcuts.memory);
    expect(next).toEqual({ sidebar: "shift+cmd+KeyM", memory: UNBOUND });
    expect(binding("sidebar", next)).toEqual(chord("shift+cmd+KeyM"));
    expect(binding("memory", next)).toBeUndefined();
    expect(conflictOf(shortcuts.memory, "board", next)).toBe("sidebar");
  });

  it("resets one or all", () => {
    const next = moveTo({}, "sidebar", shortcuts.memory);
    expect(changed(next, "sidebar")).toBe(true);
    expect(changed(next, "board")).toBe(false);
    const one = reset(next, "sidebar");
    expect(one).toEqual({ memory: UNBOUND });
    expect(binding("sidebar", one)).toBe(shortcuts.sidebar);
    // the default it goes back to may now be shared: the list shows both and the user picks
    expect(reset(one, "memory")).toEqual({});
  });
});

describe("refused chords", () => {
  it.each([
    "cmd+KeyH", "alt+cmd+KeyH", "cmd+KeyM", "cmd+Tab", "cmd+Space", "ctrl+Space", "ctrl+cmd+KeyF", "shift+cmd+Digit4", "ctrl+ArrowLeft",
    "cmd+KeyC", "cmd+KeyV", "cmd+KeyX", "cmd+KeyZ", "shift+cmd+KeyZ", "cmd+KeyA", "cmd+Backspace", "alt+ArrowLeft", "shift+cmd+ArrowRight",
  ])("%s", (text) => {
    expect(refusal(chord(text), "sidebar")).toBeTruthy();
  });

  it("needs ⌘, ⌃ or ⌥ for a letter, digit or symbol", () => {
    for (const text of ["KeyD", "shift+KeyD", "Digit1", "Slash", "Enter", "Escape", "shift+Tab"]) expect(refusal(chord(text))).toBe("⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요");
    expect(refusal({ code: "ShiftLeft", meta: true })).toBe("키를 함께 눌러 주세요");
    expect(refusal(chord("F5"))).toBeUndefined();
  });

  it("allows the app's own chords and a command's own ⌘W", () => {
    for (const [id, s] of Object.entries(shortcuts)) expect(refusal(s, id)).toBeUndefined();
    for (const text of ["cmd+KeyD", "shift+cmd+KeyD", "alt+cmd+ArrowLeft", "ctrl+cmd+ArrowUp", "shift+cmd+Enter", "ctrl+KeyW"]) expect(refusal(chord(text))).toBeUndefined();
  });

  it("takes a hold of modifiers alone for the hints, and only there", () => {
    expect(refusal(chord("alt+cmd"), "hints")).toBeUndefined();
    expect(refusal(chord("ctrl"), "hints")).toBeUndefined();
    // ⇧ alone is held while typing a capital
    expect(refusal(chord("shift"), "hints")).toBe("⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요");
    expect(refusal(chord("cmd+KeyB"), "hints")).toBe("⌘, ⌃, ⌥만 길게 눌러 주세요");
    expect(refusal(chord("alt+cmd"), "sidebar")).toBe("키를 함께 눌러 주세요");
    // no press holds the same modifiers alone
    expect(conflictOf(chord("alt+cmd"), "hints", {})).toBeUndefined();
  });
});

describe("keys that weren't commands", () => {
  it("are table ids: the native ones collide like any other", () => {
    expect(conflictOf(chord("alt+Space"), "sidebar", {})).toBe("capture");
    expect(conflictOf(chord("cmd+KeyQ"), "sidebar", {})).toBe("quit");
    expect(conflictOf(chord("cmd+KeyW"), "sidebar", {})).toBe("closePane");
    // moved off ⌘W, the menu's Close leaves it free
    expect(conflictOf(chord("cmd+KeyW"), "sidebar", { closePane: "alt+cmd+KeyW" })).toBeUndefined();
    expect(refusal(chord("cmd+KeyQ"), "sidebar")).toBeUndefined();
    expect(refusal(chord("ctrl+alt+Space"), "capture")).toBe("macOS가 쓰는 단축키예요");
  });

  it("binds ⌘1–9 by place, each on its own", () => {
    expect(shortcutHint("ws3")).toBe("⌘3");
    const next = moveTo({}, "ws1", chord("ctrl+Digit1"));
    expect(binding("ws1", next)).toEqual(chord("ctrl+Digit1"));
    expect(binding("ws2", next)).toBe(shortcuts.ws2);
    expect(conflictOf(chord("cmd+Digit2"), "sidebar", next)).toBe("ws2");
  });

  it("lets the ? sheet move to a chord and back", () => {
    expect(refusal(shortcuts.keys, "keys")).toBeUndefined();
    expect(refusal(shortcuts.keys, "sidebar")).toBe("⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요");
    const next = assign({}, "keys", chord("cmd+Slash"));
    expect(matchesShortcut(press(chord("cmd+Slash")), "keys")).toBe(false);
    setState("settings", { keybindings: next });
    expect(matchesShortcut(press(chord("cmd+Slash")), "keys")).toBe(true);
    expect(matchesShortcut(press(shortcuts.keys), "keys")).toBe(false);
  });
});
