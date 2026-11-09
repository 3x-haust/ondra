import { afterEach, describe, expect, it } from "vitest";
import { setState, state } from "../state/store";
import { assign, changed, chordOf, conflictOf, importGhostty, moveTo, parseGhostty, refusal, reset } from "./keybindings";
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
    for (const bad of ["", "cmd+", "hyper+KeyD", "cmd+cmd+KeyD", "cmd+d", UNBOUND]) expect(parseChord(bad)).toBeUndefined();
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
    "cmd+KeyQ", "cmd+KeyH", "alt+cmd+KeyH", "cmd+KeyM", "cmd+Tab", "cmd+Space", "ctrl+Space", "ctrl+cmd+KeyF", "shift+cmd+Digit4", "ctrl+ArrowLeft",
    "cmd+KeyC", "cmd+KeyV", "cmd+KeyX", "cmd+KeyZ", "shift+cmd+KeyZ", "cmd+KeyA", "cmd+Backspace", "alt+ArrowLeft", "shift+cmd+ArrowRight",
    "alt+Space", "cmd+KeyW",
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
    expect(refusal(chord("cmd+KeyW"), "sidebar")).toBe("앱 메뉴가 쓰는 단축키예요");
  });
});

describe("Ghostty import", () => {
  const config = [
    "# splits and tabs",
    "font-size = 13",
    "keybind = cmd+shift+]=next_tab",
    'keybind = "ctrl+alt+t=new_tab"',
    "keybind = cmd+==increase_font_size:1",
    "keybind = super+minus=decrease_font_size:1",
    "keybind = global:cmd+grave_accent=toggle_quick_terminal",
    "keybind = ctrl+a>n=new_window",
    "keybind = cmd+q=new_tab",
    "keybind = cmd+d=new_split:right",
    "keybind = cmd+shift+p=toggle_command_palette",
  ].join("\n");

  it("reads the split and tab actions Ondra has", () => {
    const found = parseGhostty(config).map(({ id, chord }) => [id, chordLabel(chord)]);
    expect(found).toEqual([
      ["nextTab", "⇧⌘]"], ["newTab", "⌃⌥T"], ["zoomIn", "⌘="], ["zoomOut", "⌘−"], ["newTab", "⌘Q"], ["splitRight", "⌘D"], ["commands", "⇧⌘P"],
    ]);
  });

  it("applies them, leaving out what macOS keeps and moving what collides", () => {
    const { next, count } = importGhostty({}, config);
    expect(count).toBe(6);
    expect(binding("nextTab", next)).toEqual(chord("shift+cmd+BracketRight"));
    // ⇧⌘] was 다음 작업's
    expect(binding("nextJob", next)).toBeUndefined();
    expect(binding("newTab", next)).toEqual(chord("ctrl+alt+KeyT"));
    expect(next.zoomIn).toBeUndefined();
  });
});
