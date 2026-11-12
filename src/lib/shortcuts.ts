export interface Shortcut {
  /** the physical key (e.code); "" for modifiers held on their own (hints) */
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const cmd = (code: string, shift = false): Shortcut => ({ code, meta: true, shift });
const ctrl = (code: string, shift = false): Shortcut => ({ code, ctrl: true, shift });

/** One source for matching keys and showing their hints. */
export const shortcuts = {
  search: cmd("KeyK"),
  commands: cmd("KeyP", true),
  main: cmd("Digit0"),
  new: cmd("KeyN"),
  settings: cmd("Comma"),
  sidebar: cmd("KeyB"),
  board: cmd("KeyB", true),
  memory: cmd("KeyM", true),
  results: cmd("KeyE", true),
  // ⇧⌘D is split down (below): the devices take S for simulator
  devices: cmd("KeyS", true),
  back: cmd("BracketLeft"),
  forward: cmd("BracketRight"),
  previousJob: cmd("BracketLeft", true),
  nextJob: cmd("BracketRight", true),
  waiting: cmd("Period"),
  panel: cmd("Backslash"),
  flow: cmd("KeyF", true),
  side: cmd("KeyJ"),
  artifacts: cmd("KeyO", true),
  changes: ctrl("KeyG", true),
  // the changes in the full-size editor (⌃⇧G is the panel's tab, as VS Code's source control)
  changesEditor: { code: "KeyG", meta: true, alt: true },
  // inside the changes editor, on VS Code's keys: F7 / ⇧F7 through the changes (on into the next or
  // previous file), ⌥F5 / ⇧⌥F5 to the next or previous changed file. Its tabs close and cycle on the
  // pane's and the panel's keys (closePane ⌘W, nextTab / previousTab ⌃Tab) while it has the focus.
  nextChange: { code: "F7" },
  previousChange: { code: "F7", shift: true },
  nextFileChange: { code: "F5", alt: true },
  previousFileChange: { code: "F5", alt: true, shift: true },
  pr: cmd("KeyR", true),
  files: cmd("KeyP"),
  terminal: ctrl("Backquote"),
  browser: cmd("KeyL", true),
  overview: cmd("KeyI", true),
  newTab: cmd("KeyT"),
  closeTab: ctrl("KeyW"),
  nextTab: ctrl("Tab"),
  previousTab: ctrl("Tab", true),
  // ⇧⌘↵ is split zoom (below); ⇧Esc focuses the message input
  focusInput: { code: "Escape", shift: true },
  zoomIn: cmd("Equal"),
  zoomOut: cmd("Minus"),
  // panes, on common macOS terminal split keys. ⌘[ ⌘] stay back/forward, so
  // previous/next pane moves to ⌥⌘[ ⌥⌘].
  splitRight: cmd("KeyD"),
  splitDown: cmd("KeyD", true),
  previousPane: { code: "BracketLeft", meta: true, alt: true },
  nextPane: { code: "BracketRight", meta: true, alt: true },
  focusPaneLeft: { code: "ArrowLeft", meta: true, alt: true },
  focusPaneRight: { code: "ArrowRight", meta: true, alt: true },
  focusPaneUp: { code: "ArrowUp", meta: true, alt: true },
  focusPaneDown: { code: "ArrowDown", meta: true, alt: true },
  zoomPane: cmd("Enter", true),
  resizePaneLeft: { code: "ArrowLeft", meta: true, ctrl: true },
  resizePaneRight: { code: "ArrowRight", meta: true, ctrl: true },
  resizePaneUp: { code: "ArrowUp", meta: true, ctrl: true },
  resizePaneDown: { code: "ArrowDown", meta: true, ctrl: true },
  equalizePanes: { code: "Equal", meta: true, ctrl: true },
  closePane: cmd("KeyW"),
  // jump to the latest unread
  attentionPane: cmd("KeyU", true),
  // ⌘1–9: the workspace in that place in the sidebar
  ws1: cmd("Digit1"), ws2: cmd("Digit2"), ws3: cmd("Digit3"), ws4: cmd("Digit4"), ws5: cmd("Digit5"),
  ws6: cmd("Digit6"), ws7: cmd("Digit7"), ws8: cmd("Digit8"), ws9: cmd("Digit9"),
  // the `?` sheet
  keys: { code: "Slash", shift: true },
  // held, not pressed: modifiers alone show every button's key (shortcutHold.ts)
  hints: { code: "", meta: true },
  // the native side's (src-tauri/src/keys.rs): quick input from any app, a global hotkey,
  // and the app menu's Quit, which quits once held. closePane is the menu's Close too.
  capture: { code: "Space", alt: true },
  quit: cmd("KeyQ"),
} satisfies Record<string, Shortcut>;
export type ShortcutId = keyof typeof shortcuts;
/** kept down rather than pressed: shown as "⌘ 길게" */
export const HELD: readonly string[] = ["hints", "quit"];
/** bound to modifiers alone */
export const modifierHold = (id: string) => id === "hints";
/** the ids Rust applies (keys.rs): the global hotkey and the app menu's items */
export const NATIVE = ["capture", "quit", "closePane"] as const satisfies readonly ShortcutId[];

// ───────────── the user's bindings over the table
// Settings › 단축키 keeps overrides by id in state.settings.keybindings: a chord as
// text ("cmd+shift+KeyD", see chordText) or "none" for unbound. Every id in the
// table can be rebound; an id missing from the overrides keeps its default.
export const UNBOUND = "none";
export type Overrides = Readonly<Record<string, string | undefined>>;

const MODS = [["ctrl", "ctrl"], ["alt", "alt"], ["shift", "shift"], ["cmd", "meta"]] as const;
/** a chord as stored: modifiers in macOS order, then the physical key (e.code); modifiers alone for a hold */
export function chordText(s: Shortcut): string {
  return [...MODS.filter(([, k]) => s[k]).map(([name]) => name), s.code].filter(Boolean).join("+");
}
/** the stored text back to a chord; undefined if it isn't one */
export function parseChord(text: string): Shortcut | undefined {
  const parts = text.split("+");
  // "alt+cmd": modifiers held on their own
  const held = MODS.some(([name]) => name === parts[parts.length - 1]);
  const code = held ? "" : parts.pop()!;
  if (!held && !/^[A-Z][A-Za-z0-9]*$/.test(code)) return undefined;
  const s: Shortcut = { code };
  for (const p of parts) {
    const mod = MODS.find(([name]) => name === p);
    if (!mod || s[mod[1]]) return undefined;
    s[mod[1]] = true;
  }
  return s;
}
export const sameChord = (a: Shortcut, b: Shortcut) =>
  a.code === b.code && !!a.meta === !!b.meta && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;

let source: () => Overrides | undefined = () => undefined;
/** where the overrides live (the store sets this; reading it inside JSX keeps hints live) */
export function bindingSource(get: () => Overrides | undefined) {
  source = get;
}
export const overrides = (): Overrides => source() ?? {};
const table = shortcuts as Record<string, Shortcut>;
export const isShortcutId = (id: string): id is ShortcutId => Object.prototype.hasOwnProperty.call(shortcuts, id);
/** the key an id answers to now; undefined when the user unbound it */
export function binding(id: string, o: Overrides = overrides()): Shortcut | undefined {
  if (!isShortcutId(id)) return undefined;
  const text = o[id];
  if (text === UNBOUND) return undefined;
  return (text !== undefined && parseChord(text)) || table[id];
}
// A chord taken straight from the table (`shortcuts.search`) stands for its id, so
// code that matches or shows `shortcuts.x` follows the user's binding too.
const tableId = new Map<Shortcut, string>(Object.entries(table).map(([id, s]) => [s, id]));
const effective = (s: Shortcut | ShortcutId): Shortcut | undefined =>
  typeof s === "string" ? binding(s) : tableId.has(s) ? binding(tableId.get(s)!) : s;

const KEY_GLYPHS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`", BracketLeft: "[", BracketRight: "]",
  Semicolon: ";", Quote: "'", Equal: "=", Minus: "−", Tab: "⇥", Enter: "↵", NumpadEnter: "↵", Space: "Space",
  Backspace: "⌫", Delete: "⌦", Escape: "⎋", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  PageUp: "⇞", PageDown: "⇟", Home: "↖", End: "↘", IntlBackslash: "§", IntlYen: "¥", IntlRo: "\\",
  NumpadAdd: "+", NumpadSubtract: "−", NumpadMultiply: "×", NumpadDivide: "÷", NumpadDecimal: ".", NumpadEqual: "=",
};
/** one key as shown: ⌘ ⌥ ⌃ ⇧ glyphs, arrows, ↵ ⇥ and the key's own character */
export function keyGlyph(code: string): string {
  return KEY_GLYPHS[code] ?? code.replace(/^(Key|Digit|Numpad)/, "");
}
/** a chord as written, modifiers in the macOS order ⌃⌥⇧⌘ */
export function chordLabel(s: Shortcut): string {
  if (s.code === "Slash" && s.shift && !s.meta && !s.ctrl && !s.alt) return "?";
  return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.meta ? "⌘" : ""}${keyGlyph(s.code)}`;
}
/** what a chord shows now: a table chord shows the user's binding ("" when unbound) */
export function shortcutLabel(s: Shortcut | ShortcutId): string {
  const e = effective(s);
  return e ? chordLabel(e) : "";
}
export const shortcutHint = (id: ShortcutId) => shortcutLabel(id);
/** "새 탭 (⌘T)", or just the label while the command has no key */
export const withHint = (label: string, id: ShortcutId) => {
  const keys = shortcutHint(id);
  return keys ? `${label} (${keys})` : label;
};

export const ignoredKey = (e: KeyboardEvent) => e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat;
export const noModifiers = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
/** a table chord or id matches the user's binding for it */
export function matchesShortcut(e: KeyboardEvent, chord: Shortcut | ShortcutId): boolean {
  const s = effective(chord);
  return !!s && !!s.code && !ignoredKey(e) && e.code === s.code && e.metaKey === !!s.meta && e.ctrlKey === !!s.ctrl && e.shiftKey === !!s.shift && e.altKey === !!s.alt;
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const OWN_KEYS = '.xterm, .dev-frame, [contenteditable]:not([contenteditable="false"]), [data-shortcuts="local"]';
const OVERLAY = '[role="dialog"], [aria-modal="true"], .backdrop, .lightbox, .vv, .pop, [role="menu"], .menu, .cpick';
export function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(EDITABLE);
}
export function localKeysTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(OWN_KEYS);
}
export function shortcutOverlay(): boolean {
  return !!document.querySelector(OVERLAY);
}

export interface ShortcutCommand {
  id: string;
  label: string;
  section: string;
  icon: string;
  shortcut?: Shortcut;
  inInput?: boolean;
  enabled?: () => boolean;
  run: () => void;
}
export interface ShortcutContext { overlay: boolean; editing: boolean; local: boolean }
export function shortcutContext(e: KeyboardEvent): ShortcutContext {
  return {
    overlay: shortcutOverlay(),
    editing: editableTarget(e.target) || editableTarget(document.activeElement),
    local: localKeysTarget(e.target) || localKeysTarget(document.activeElement),
  };
}
export function dispatchShortcut(e: KeyboardEvent, commands: ShortcutCommand[], context: ShortcutContext): boolean {
  if (ignoredKey(e) || context.overlay || context.local) return false;
  const command = commands.find((c) => c.shortcut && matchesShortcut(e, c.shortcut));
  if (!command || (context.editing && !command.inInput) || command.enabled?.() === false) return false;
  e.preventDefault();
  command.run();
  return true;
}

/** Local view keys must not leak through an editor or an overlay. */
export function viewKey(e: KeyboardEvent): boolean {
  const c = shortcutContext(e);
  return !ignoredKey(e) && !c.overlay && !c.editing && !c.local;
}
