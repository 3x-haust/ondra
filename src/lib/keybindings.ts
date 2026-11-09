// Rebinding: which chords a command may take, who already has one, and the
// override map after a change. Pure; Settings › 단축키 writes the result to
// state.settings.keybindings. Ids come from the `shortcuts` table, so a new
// entry there is listed, matched and rebindable without anything added here.
import { binding, chordText, isShortcutId, modifierHold, parseChord, sameChord, shortcuts, UNBOUND, type Overrides, type Shortcut, type ShortcutId } from "./shortcuts";

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
/** macOS keeps these for itself (⌘Q is the table's quit, so another command takes it as a conflict) */
const SYSTEM = [
  "cmd+KeyH", "alt+cmd+KeyH", "cmd+KeyM", "alt+cmd+KeyM", "cmd+Tab", "shift+cmd+Tab", "cmd+Backquote", "shift+cmd+Backquote",
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
const FUNCTION_KEY = /^F([1-9]|1[0-9]|20)$/;

/** why a command can't take this chord (a Korean key for t()), or undefined if it can */
export function refusal(s: Shortcut, id?: string): string | undefined {
  // hints: modifiers held on their own, one of them more than ⇧ (held while typing a capital)
  if (id && modifierHold(id)) {
    if (!modifierOnly(s.code)) return "⌘, ⌃, ⌥만 길게 눌러 주세요";
    return s.meta || s.ctrl || s.alt ? undefined : "⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요";
  }
  if (modifierOnly(s.code)) return "키를 함께 눌러 주세요";
  // a command can always have its own default back (⌘W included)
  if (id && isShortcutId(id) && sameChord(shortcuts[id], s)) return undefined;
  if (!s.meta && !s.ctrl && !s.alt && !FUNCTION_KEY.test(s.code)) return "⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요";
  if (SYSTEM.some((x) => sameChord(x, s))) return "macOS가 쓰는 단축키예요";
  if (EDITING.some((x) => sameChord(x, s))) return "글을 고칠 때 쓰는 단축키예요";
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
