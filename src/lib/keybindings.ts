// Rebinding: which chords a command may take, who already has one, and the
// override map after a change. Pure; Settings › 단축키 writes the result to
// state.settings.keybindings. Ids come from the `shortcuts` table, so a new
// entry there is listed, matched and rebindable without anything added here.
import { binding, chordText, isShortcutId, parseChord, sameChord, shortcuts, UNBOUND, type Overrides, type Shortcut, type ShortcutId } from "./shortcuts";

const MODIFIER_CODES = /^(Meta|Control|Alt|Shift|OS|CapsLock|Fn)(Left|Right)?$/;
/** a press that is only a modifier: recording waits for the key */
export const modifierOnly = (code: string) => MODIFIER_CODES.test(code) || code === "" || code === "Unidentified";

/** the chord a key press makes (by e.code, so the keyboard layout doesn't matter) */
export const chordOf = (e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): Shortcut => {
  const s: Shortcut = { code: e.code };
  if (e.metaKey) s.meta = true;
  if (e.ctrlKey) s.ctrl = true;
  if (e.altKey) s.alt = true;
  if (e.shiftKey) s.shift = true;
  return s;
};

const c = (text: string) => parseChord(text)!;
/** macOS keeps these for itself */
const SYSTEM = [
  "cmd+KeyQ", "cmd+KeyH", "alt+cmd+KeyH", "cmd+KeyM", "alt+cmd+KeyM", "cmd+Tab", "shift+cmd+Tab", "cmd+Backquote", "shift+cmd+Backquote",
  "cmd+Space", "alt+cmd+Space", "ctrl+Space", "ctrl+alt+Space", "shift+cmd+KeyQ", "alt+shift+cmd+KeyQ", "ctrl+cmd+KeyQ", "ctrl+cmd+KeyF",
  "alt+cmd+Escape", "alt+cmd+KeyD", "shift+cmd+Digit3", "shift+cmd+Digit4", "shift+cmd+Digit5", "shift+cmd+Digit6",
  "ctrl+shift+cmd+Digit3", "ctrl+shift+cmd+Digit4", "ctrl+ArrowLeft", "ctrl+ArrowRight", "ctrl+ArrowUp", "ctrl+ArrowDown",
].map(c);
/** typing and editing text needs these */
const EDITING = [
  "cmd+KeyA", "cmd+KeyC", "cmd+KeyV", "cmd+KeyX", "cmd+KeyZ", "shift+cmd+KeyZ", "alt+shift+cmd+KeyV",
  "cmd+Backspace", "alt+Backspace", "cmd+Delete", "alt+Delete",
  ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].flatMap((k) => [`cmd+${k}`, `alt+${k}`, `shift+cmd+${k}`, `alt+shift+${k}`]),
].map(c);
/** Ondra's own keys outside the table: quick input anywhere, and ⌘W the app menu sends to the panel */
const APP = ["alt+Space"].map(c);
const MENU = ["cmd+KeyW"].map(c);
const FUNCTION_KEY = /^F([1-9]|1[0-9]|20)$/;

/** why a command can't take this chord (a Korean key for t()), or undefined if it can */
export function refusal(s: Shortcut, id?: string): string | undefined {
  if (modifierOnly(s.code)) return "키를 함께 눌러 주세요";
  // a command can always have its own default back (⌘W included)
  if (id && isShortcutId(id) && sameChord(shortcuts[id], s)) return undefined;
  if (!s.meta && !s.ctrl && !s.alt && !FUNCTION_KEY.test(s.code)) return "⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요";
  if (SYSTEM.some((x) => sameChord(x, s))) return "macOS가 쓰는 단축키예요";
  if (EDITING.some((x) => sameChord(x, s))) return "글을 고칠 때 쓰는 단축키예요";
  if (APP.some((x) => sameChord(x, s))) return "어디서든 요청에 쓰여요";
  if (MENU.some((x) => sameChord(x, s))) return "앱 메뉴가 쓰는 단축키예요";
  return undefined;
}

/** the other table command bound to this chord now */
export function conflictOf(s: Shortcut, id: string, o: Overrides): ShortcutId | undefined {
  return (Object.keys(shortcuts) as ShortcutId[]).find((other) => {
    if (other === id) return false;
    const b = binding(other, o);
    return !!b && sameChord(b, s);
  });
}

/** overrides with `id` set to `s` (null: unbound); the default is stored as no override */
export function assign(o: Overrides, id: string, s: Shortcut | null): Record<string, string> {
  const next = clean(o);
  if (!isShortcutId(id)) return next;
  if (s && sameChord(s, shortcuts[id])) delete next[id];
  else next[id] = s ? chordText(s) : UNBOUND;
  return next;
}
/** `id` takes `s`; whoever had it is left unbound ("바꾸기") */
export function moveTo(o: Overrides, id: string, s: Shortcut): Record<string, string> {
  const other = conflictOf(s, id, o);
  const next = assign(o, id, s);
  return other ? assign(next, other, null) : next;
}
export function reset(o: Overrides, id: string): Record<string, string> {
  const next = clean(o);
  delete next[id];
  return next;
}
export const changed = (o: Overrides, id: string) => isShortcutId(id) && o[id] !== undefined;

/** the overrides that still mean something: known ids with a readable chord */
function clean(o: Overrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, text] of Object.entries(o)) if (isShortcutId(id) && text !== undefined && (text === UNBOUND || parseChord(text))) out[id] = text;
  return out;
}

// ───────────── Ghostty
// `keybind = cmd+d=new_split:right` lines: the split and tab actions Ondra has.
// Ids named here that the table doesn't have are skipped.
const GHOSTTY_ACTIONS: Record<string, string> = {
  "new_split:right": "splitRight",
  "new_split:down": "splitDown",
  "goto_split:left": "focusPaneLeft",
  "goto_split:right": "focusPaneRight",
  "goto_split:up": "focusPaneUp",
  "goto_split:down": "focusPaneDown",
  "goto_split:previous": "previousPane",
  "goto_split:next": "nextPane",
  "toggle_split_zoom": "zoomPane",
  "resize_split:left": "resizePaneLeft",
  "resize_split:right": "resizePaneRight",
  "resize_split:up": "resizePaneUp",
  "resize_split:down": "resizePaneDown",
  "equalize_splits": "equalizePanes",
  "close_surface": "closePane",
  "new_tab": "newTab",
  "close_tab": "closeTab",
  "next_tab": "nextTab",
  "previous_tab": "previousTab",
  "increase_font_size": "zoomIn",
  "decrease_font_size": "zoomOut",
  "toggle_command_palette": "commands",
  "open_config": "settings",
};
const GHOSTTY_KEYS: Record<string, string> = {
  left_bracket: "BracketLeft", "[": "BracketLeft", right_bracket: "BracketRight", "]": "BracketRight",
  equal: "Equal", "=": "Equal", minus: "Minus", "-": "Minus", comma: "Comma", ",": "Comma", period: "Period", ".": "Period",
  slash: "Slash", "/": "Slash", backslash: "Backslash", "\\": "Backslash", semicolon: "Semicolon", ";": "Semicolon",
  apostrophe: "Quote", quote: "Quote", "'": "Quote", grave_accent: "Backquote", backquote: "Backquote", "`": "Backquote",
  enter: "Enter", return: "Enter", tab: "Tab", space: "Space", escape: "Escape", backspace: "Backspace", delete: "Delete",
  left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
  arrow_left: "ArrowLeft", arrow_right: "ArrowRight", arrow_up: "ArrowUp", arrow_down: "ArrowDown",
  page_up: "PageUp", page_down: "PageDown", home: "Home", end: "End",
  zero: "Digit0", one: "Digit1", two: "Digit2", three: "Digit3", four: "Digit4", five: "Digit5", six: "Digit6", seven: "Digit7", eight: "Digit8", nine: "Digit9",
};
const GHOSTTY_MODS: Record<string, keyof Shortcut> = {
  cmd: "meta", command: "meta", super: "meta", ctrl: "ctrl", control: "ctrl", alt: "alt", opt: "alt", option: "alt", shift: "shift",
};

function ghosttyChord(trigger: string): Shortcut | undefined {
  // a sequence (ctrl+a>n) has no counterpart here
  if (trigger.includes(">")) return undefined;
  const parts = trigger.toLowerCase().split("+");
  const key = parts.pop()?.replace(/^physical:/, "");
  if (!key) return undefined;
  const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}`
    : /^(digit_)?[0-9]$/.test(key) ? `Digit${key.slice(-1)}`
    : /^key_[a-z]$/.test(key) ? `Key${key.slice(-1).toUpperCase()}`
    : /^f([1-9]|1[0-9]|20)$/.test(key) ? key.toUpperCase()
    : GHOSTTY_KEYS[key];
  if (!code) return undefined;
  const s: Shortcut = { code };
  for (const p of parts) {
    const mod = GHOSTTY_MODS[p];
    if (!mod) return undefined;
    (s as unknown as Record<string, boolean>)[mod] = true;
  }
  return s;
}

/** the bindings a Ghostty config sets for actions Ondra has, in file order */
export function parseGhostty(text: string): { id: ShortcutId; chord: Shortcut }[] {
  const out: { id: ShortcutId; chord: Shortcut }[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*keybind\s*=\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const value = m[1].replace(/^"(.*)"$/, "$1");
    // the trigger can itself contain "=" (cmd+=): split at the last one
    const at = value.lastIndexOf("=");
    if (at <= 0) continue;
    let trigger = value.slice(0, at).trim();
    const action = value.slice(at + 1).trim();
    // global: works outside the app, and the app has one of its own (⌥Space)
    if (/(^|:)global:/.test(trigger)) continue;
    trigger = trigger.replace(/^((all|unconsumed|performable):)+/, "");
    // increase_font_size:1, resize_split:up,10: the amount is Ondra's own
    const id = GHOSTTY_ACTIONS[action] ?? GHOSTTY_ACTIONS[action.replace(/[:,][\d.]+$/, "")];
    const chord = ghosttyChord(trigger);
    if (id && isShortcutId(id) && chord) out.push({ id, chord });
  }
  return out;
}

/** Ghostty's bindings over these overrides; a refused chord is left out */
export function importGhostty(o: Overrides, text: string): { next: Record<string, string>; count: number } {
  let next = clean(o);
  let count = 0;
  for (const { id, chord } of parseGhostty(text)) {
    if (refusal(chord, id)) continue;
    next = moveTo(next, id, chord);
    count++;
  }
  return { next, count };
}
