export const MIN_PDF_SCALE = 0.1;
export const MAX_PDF_SCALE = 5;

export function pdfScale(current: number, factor: number) {
  if (!Number.isFinite(factor) || factor <= 0) return current;
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, current * factor));
}

/** WebKit sends cumulative gesture scales; Chromium sends ctrl-wheel deltas. */
export function bindPdfGestures(
  target: HTMLElement,
  viewport: HTMLElement,
  zoom: (factor: number, origin: [number, number]) => void,
) {
  let gestureScale: number | null = null;
  const origin = (event: Event) => {
    const e = event as MouseEvent;
    const r = viewport.getBoundingClientRect();
    return [
      Number.isFinite(e.clientX) ? Math.max(r.left, Math.min(r.right, e.clientX)) : r.left + r.width / 2,
      Number.isFinite(e.clientY) ? Math.max(r.top, Math.min(r.bottom, e.clientY)) : r.top + r.height / 2,
    ] as [number, number];
  };
  const consume = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  const wheel = (e: WheelEvent) => {
    e.stopPropagation();
    if (!e.ctrlKey) return; // Keep native two-axis scrolling and momentum.
    e.preventDefault();
    if (gestureScale !== null) return; // Some WebKit versions also emit wheel.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
    zoom(Math.exp(Math.max(-4, Math.min(4, -e.deltaY * unit / 100))), origin(e));
  };
  const start = (e: Event) => {
    consume(e);
    gestureScale = 1;
  };
  const change = (e: Event) => {
    consume(e);
    const scale = (e as Event & { scale: number }).scale;
    if (gestureScale === null || !Number.isFinite(scale) || scale <= 0) return;
    zoom(scale / gestureScale, origin(e));
    gestureScale = scale;
  };
  const end = (e: Event) => { consume(e); gestureScale = null; };
  const reset = () => { gestureScale = null; };
  target.addEventListener("wheel", wheel, { passive: false });
  target.addEventListener("gesturestart", start, { passive: false });
  target.addEventListener("gesturechange", change, { passive: false });
  target.addEventListener("gestureend", end, { passive: false });
  target.ownerDocument.defaultView?.addEventListener("blur", reset);
  return () => {
    target.removeEventListener("wheel", wheel);
    target.removeEventListener("gesturestart", start);
    target.removeEventListener("gesturechange", change);
    target.removeEventListener("gestureend", end);
    target.ownerDocument.defaultView?.removeEventListener("blur", reset);
  };
}
