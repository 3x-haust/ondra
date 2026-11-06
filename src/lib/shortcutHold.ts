import { ignoredKey } from "./shortcuts";

/** Observe keys without consuming them; a chord cancels the hint until the next press. */
export function watchShortcutHold(target: EventTarget, allowed: () => boolean, show: () => void, hide: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    hide();
  };
  const reset = () => { held = false; cancel(); };
  const down = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "Meta" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || ignoredKey(e)) {
      cancel();
      return;
    }
    if (held) return;
    held = true;
    if (!allowed()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (allowed()) show();
    }, 500);
  };
  const up = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Meta" || !e.metaKey) reset();
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
