export interface Shortcut {
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
  devices: cmd("KeyD", true),
  previousJob: cmd("BracketLeft", true),
  nextJob: cmd("BracketRight", true),
  waiting: cmd("Period"),
  panel: cmd("Backslash"),
  flow: cmd("KeyF", true),
  side: cmd("KeyJ"),
  artifacts: cmd("KeyO", true),
  changes: ctrl("KeyG", true),
  pr: cmd("KeyR", true),
  files: cmd("KeyP"),
  terminal: ctrl("Backquote"),
  browser: cmd("KeyL", true),
  overview: cmd("KeyI", true),
  newTab: cmd("KeyT"),
  closeTab: ctrl("KeyW"),
  nextTab: ctrl("Tab"),
  previousTab: ctrl("Tab", true),
  focusInput: cmd("Enter", true),
} satisfies Record<string, Shortcut>;
export type ShortcutId = keyof typeof shortcuts;

export function shortcutLabel(s: Shortcut): string {
  const key = ({ Comma: ",", Period: ".", Backslash: "\\", Backquote: "`", BracketLeft: "[", BracketRight: "]", Tab: "⇥", Enter: "↵" } as Record<string, string>)[s.code] ?? s.code.replace(/^(Key|Digit)/, "");
  return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.meta ? "⌘" : ""}${s.shift ? "⇧" : ""}${key}`;
}
export const shortcutHint = (id: ShortcutId) => shortcutLabel(shortcuts[id]);

export const ignoredKey = (e: KeyboardEvent) => e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat;
export const noModifiers = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  return !ignoredKey(e) && e.code === s.code && e.metaKey === !!s.meta && e.ctrlKey === !!s.ctrl && e.shiftKey === !!s.shift && e.altKey === !!s.alt;
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
