// Select text in a reply and a small 인용 button appears beside it: it puts the
// selection, as a quote, into the composer of the same view.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { composers } from "./Composer";
import { Icon } from "./Icon";
import { t } from "../i18n";

const REPLY = ".msg-text, .reply-line, .reply-body";
const MAX = 4000;

/** The composer beside a node: the one sharing its nearest view or panel. */
export function composerFor(node: Node) {
  const el = node instanceof Element ? node : node.parentElement;
  for (let box = el?.closest(".jp-chat, .panel, .view") ?? null; box; box = box.parentElement?.closest(".jp-chat, .panel, .view") ?? null)
    for (const c of composers) if (box.contains(c.root)) return c;
  return undefined;
}

export function QuoteBar() {
  const [at, setAt] = createSignal<{ x: number; y: number; text: string; to: (t: string) => void } | null>(null);
  const read = () => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    if (!sel || sel.isCollapsed || !text.trim() || sel.rangeCount === 0) return setAt(null);
    const range = sel.getRangeAt(0);
    const start = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest(REPLY);
    const end = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest(REPLY);
    if (!start || !end || start.closest(".msg-user, .composer") || text.length > MAX) return setAt(null);
    const to = composerFor(start);
    if (!to) return setAt(null);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    setAt({ x: Math.min(window.innerWidth - 80, Math.max(8, last.right - 30)), y: Math.max(8, last.top - 36), text, to: to.quote });
  };
  const up = () => queueMicrotask(read);
  const change = () => {
    if (window.getSelection()?.isCollapsed) setAt(null);
  };
  const esc = (e: KeyboardEvent) => e.key === "Escape" && at() && (e.stopPropagation(), setAt(null));
  const hide = () => setAt(null);
  onMount(() => {
    document.addEventListener("mouseup", up);
    document.addEventListener("keyup", up);
    document.addEventListener("selectionchange", change);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  });
  onCleanup(() => {
    document.removeEventListener("mouseup", up);
    document.removeEventListener("keyup", up);
    document.removeEventListener("selectionchange", change);
    window.removeEventListener("keydown", esc, true);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("resize", hide);
  });
  return (
    <Show when={at()}>
      {(a) => (
        <button
          class="quote-bar"
          style={{ left: `${a().x}px`, top: `${a().y}px` }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            a().to(a().text);
            window.getSelection()?.removeAllRanges();
            setAt(null);
          }}
        >
          <Icon name="message" size={14} />
          {t("인용")}
        </button>
      )}
    </Show>
  );
}
