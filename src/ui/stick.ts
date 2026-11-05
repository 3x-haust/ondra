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

export function keepBottom(el: HTMLElement): () => void {
  let atBottom = true;
  const near = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const onScroll = () => (atBottom = near());
  const ro = new ResizeObserver(() => {
    // opening the to-do list leaves the chat where it is
    if (atBottom && !holding) el.scrollTop = el.scrollHeight;
  });
  el.addEventListener("scroll", onScroll, { passive: true });
  ro.observe(el);
  return () => {
    ro.disconnect();
    el.removeEventListener("scroll", onScroll);
  };
}
