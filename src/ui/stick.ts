/**
 * A chat that was at the bottom stays at the bottom when its box gets shorter
 * (the input grows, its tray opens) or its content grows: the messages move up
 * instead of sliding under the input.
 */

let holding = false;
/** what was clicked: only the chat holding it stays put (another pane's chat keeps following) */
let holdAt: Element | null = null;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
/** For the next moment, a chat that changes size stays where it is: a fold opened inside the thread, read where it was clicked. */
export function holdScroll(ms = 600, at: Element | null = null) {
  holding = true;
  holdAt = at;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => ((holding = false), (holdAt = null)), ms);
}

/**
 * Follow the newest content the way Codex does: the chat stays pinned to the
 * bottom while things arrive, and the moment the user scrolls up (wheel, touch,
 * keys, dragging the scrollbar) it lets go and stays where they put it. It
 * follows again only once they are back at the very bottom (or press "맨 아래로").
 * `onStick` hears when following turns on or off.
 */
/** Tell a chat kept by keepBottom that the user just sent: it goes to the bottom and follows again. */
export const toBottomSent = (el: HTMLElement | undefined) => el?.dispatchEvent(new Event("sent"));

export function keepBottom(el: HTMLElement, onStick?: (stuck: boolean) => void): () => void {
  let stuck = true;
  let ours = false; // the scroll we just made ourselves
  let last = 0;
  /** right after the user sends, the chat is held at the bottom whatever moves (the job restarting
   *  re-lays the thread, folds open, the composer shrinks): nothing may carry it up */
  let pinUntil = 0;
  const pinned = () => Date.now() < pinUntil;
  const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
  const set = (v: boolean) => {
    if (v === stuck) return;
    stuck = v;
    onStick?.(v);
  };
  const follow = () => {
    // a tray opening under it pushes the chat up, closing lets it back down;
    // a fold opened inside the thread stays where it was clicked
    if (!pinned() && (!stuck || (holding && (!holdAt || el.contains(holdAt))))) return;
    ours = true;
    el.scrollTop = el.scrollHeight;
    last = gap();
  };
  const onScroll = () => {
    const d = gap();
    if (pinned() && d > 4) {
      ours = true;
      el.scrollTop = el.scrollHeight;
      last = gap();
      return;
    }
    if (ours) ours = false;
    else if (d <= 4) set(true);
    else if (d > last + 1) set(false); // moved up (scrollbar, find, focus …)
    last = d;
  };
  // intent beats the race with streaming content: let go before the scroll lands
  const onWheel = (e: WheelEvent) => e.deltaY < 0 && ((pinUntil = 0), set(false));
  let touchY = 0;
  const onTouchStart = (e: TouchEvent) => (touchY = e.touches[0]?.clientY ?? 0);
  const onTouchMove = (e: TouchEvent) => (e.touches[0]?.clientY ?? 0) > touchY && ((pinUntil = 0), set(false));
  const onKey = (e: KeyboardEvent) => {
    if (["PageUp", "Home", "ArrowUp"].includes(e.key) && !(e.target as HTMLElement).closest?.("input, textarea, [contenteditable]")) (pinUntil = 0), set(false);
  };
  // the user sent something: back to the bottom and following, wherever they were
  const onSent = () => {
    pinUntil = Date.now() + 2500;
    set(true);
    ours = true;
    el.scrollTop = el.scrollHeight;
    last = gap();
  };
  el.addEventListener("sent", onSent);
  const ro = new ResizeObserver(follow);
  ro.observe(el);
  // the content growing too (an image or a question card arriving after the
  // first paint), not only the box
  const watch = () => {
    for (const c of el.children) ro.observe(c);
  };
  watch();
  const mo = new MutationObserver(() => (watch(), follow()));
  mo.observe(el, { childList: true, subtree: true, characterData: true });
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("keydown", onKey);
  return () => {
    mo.disconnect();
    ro.disconnect();
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("sent", onSent);
  };
}
