import { binding, ignoredKey, type Shortcut } from "./shortcuts";

const MODIFIER = /^(Meta|Control|Alt|Shift)(Left|Right)?$/;
const held = (e: KeyboardEvent) => ({ meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
type Mods = ReturnType<typeof held>;
const MODS = ["meta", "ctrl", "alt", "shift"] as const;
/** every modifier `a` has, `b` has too */
const within = (a: Mods | Shortcut, b: Mods | Shortcut) => MODS.every((m) => !a[m] || !!b[m]);

/**
 * Observe keys without consuming them: the hint shows while the modifiers bound to `hints`
 * (⌘ by default, Settings › 단축키) are held on their own. A chord cancels it until they are let go.
 */
export function watchShortcutHold(target: EventTarget, allowed: () => boolean, show: () => void, hide: () => void, chord: () => Shortcut | undefined = () => binding("hints")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    hide();
  };
  const reset = () => { armed = false; cancel(); };
  const down = (event: Event) => {
    const e = event as KeyboardEvent;
    const want = chord();
    const now = held(e);
    if (!want || !MODIFIER.test(e.code) || ignoredKey(e) || !within(now, want)) {
      cancel();
      return;
    }
    // ⌥ of ⌥⌘ so far: wait for the rest
    if (!within(want, now) || armed) return;
    armed = true;
    if (!allowed()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (allowed()) show();
    }, 500);
  };
  const up = (event: Event) => {
    const want = chord();
    if (!want || !within(want, held(event as KeyboardEvent))) reset();
  };
  const listeners: [string, EventListener][] = [
    ["keydown", down], ["keyup", up], ["blur", reset], ["visibilitychange", reset],
    ["pointerdown", cancel], ["focusin", cancel], ["compositionstart", cancel],
    ["scroll", cancel], ["resize", cancel],
  ];
  for (const [name, fn] of listeners) target.addEventListener(name, fn, { capture: true });
  return () => {
    reset();
    for (const [name, fn] of listeners) target.removeEventListener(name, fn, { capture: true });
  };
}
