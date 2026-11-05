/**
 * A chat that was at the bottom stays at the bottom when its box gets shorter
 * (the input grows, its tray opens) or its content grows: the messages move up
 * instead of sliding under the input.
 */
let holding = false;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
export const isHolding = () => holding;
/** For the next moment, a chat that changes size stays where it is. */
export function holdScroll(ms = 600) {
  holding = true;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => (holding = false), ms);
}

/**
 * Follow the newest content the way Codex does: the chat stays pinned to the
 * bottom while things arrive, and the moment the user scrolls up (wheel, touch,
 * keys, dragging the scrollbar) it lets go and stays where they put it. It
 * follows again only once they are back at the very bottom (or press "맨 아래로").
 * `onStick` hears when following turns on or off.
 */
export function keepBottom(el: HTMLElement, onStick?: (stuck: boolean) => void): () => void {
  let stuck = true;
  let ours = false; // the scroll we just made ourselves
  let last = 0;
  const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
  const set = (v: boolean) => {
    if (v === stuck) return;
    stuck = v;
    onStick?.(v);
  };
  const follow = () => {
    // opening the to-do list leaves the chat where it is
    if (!stuck || holding) return;
    ours = true;
    el.scrollTop = el.scrollHeight;
    last = gap();
  };
  const onScroll = () => {
    const d = gap();
    if (ours) ours = false;
    else if (d <= 4) set(true);
    else if (d > last + 1) set(false); // moved up (scrollbar, find, focus …)
    last = d;
  };
  // intent beats the race with streaming content: let go before the scroll lands
  const onWheel = (e: WheelEvent) => e.deltaY < 0 && set(false);
  let touchY = 0;
  const onTouchStart = (e: TouchEvent) => (touchY = e.touches[0]?.clientY ?? 0);
  const onTouchMove = (e: TouchEvent) => (e.touches[0]?.clientY ?? 0) > touchY && set(false);
  const onKey = (e: KeyboardEvent) => {
    if (["PageUp", "Home", "ArrowUp"].includes(e.key) && !(e.target as HTMLElement).closest?.("input, textarea, [contenteditable]")) set(false);
  };
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
  };
}
