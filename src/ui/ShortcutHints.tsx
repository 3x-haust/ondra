import { createSignal, For, onCleanup, onMount } from "solid-js";
import { editableTarget, localKeysTarget, shortcutLabel, shortcutOverlay, type ShortcutCommand } from "../lib/shortcuts";
import { watchShortcutHold } from "../lib/shortcutHold";
import "./shortcutHints.css";

interface Hint { id: string; label: string; rect: DOMRect; row?: DOMRect }

export function ShortcutHints(props: { commands: () => ShortcutCommand[]; enabled: () => boolean }) {
  const [hints, setHints] = createSignal<Hint[]>([]);
  const [visible, setVisible] = createSignal(false);
  let layer!: HTMLDivElement;
  let anchors: { el: HTMLElement; rect: DOMRect }[] = [];
  // an empty composer is where focus rests: hints still show there
  const emptyComposer = (el: Element | null) => el instanceof HTMLTextAreaElement && !el.value && !!el.closest(".composer");
  const allowed = () => props.enabled() && !document.hidden && !shortcutOverlay()
    && (!editableTarget(document.activeElement) || emptyComposer(document.activeElement)) && !localKeysTarget(document.activeElement);
  const hide = () => setVisible(false);
  const show = () => {
    const commands = new Map(props.commands().map((c) => [c.id, c]));
    const next: Hint[] = [];
    anchors = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-shortcut]")) {
      const command = commands.get(el.dataset.shortcut!);
      if (!command?.shortcut || command.enabled?.() === false || el.closest('[inert], :disabled, [aria-disabled="true"]')) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (!r.width || !r.height || x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || !el.contains(top)) continue;
      anchors.push({ el, rect: r });
      // a small button in a sidebar heading: its badge lines up with the rows' badges
      const row = el.closest<HTMLElement>(".sb-head")?.getBoundingClientRect();
      next.push({ id: command.id, label: shortcutLabel(command.shortcut), rect: r, row });
    }
    setHints(next);
    // Each badge sits inside its own control: centered on a small button, at the right
    // end of a row, in the top-right corner of a large box. Never outside, never stacked.
    const placed: DOMRect[] = [];
    const badges = layer.querySelectorAll<HTMLElement>(".shortcut-hint");
    next.forEach((hint, i) => {
      const badge = badges[i];
      if (!badge) return;
      const w = badge.offsetWidth;
      const h = badge.offsetHeight;
      const r = hint.rect;
      const small = r.width <= Math.max(64, w + 12) && r.height <= 48;
      let left = hint.row && w > r.width ? hint.row.right - w - 8 : small ? r.left + (r.width - w) / 2 : r.right - w - 8;
      let top = r.height > 48 ? r.top + 8 : r.top + (r.height - h) / 2;
      left = Math.round(Math.max(4, Math.min(left, innerWidth - w - 4)));
      top = Math.round(Math.max(4, Math.min(top, innerHeight - h - 4)));
      const box = new DOMRect(left, top, w, h);
      if (placed.some((o) => box.left < o.right - 1 && box.right - 1 > o.left && box.top < o.bottom && box.bottom > o.top)) {
        badge.style.visibility = "hidden";
        return;
      }
      badge.style.left = `${left}px`;
      badge.style.top = `${top}px`;
      badge.style.visibility = "visible";
      placed.push(box);
    });
    setVisible(true);
  };
  onMount(() => {
    const stop = watchShortcutHold(window, allowed, show, hide);
    // A menu, navigation, or disabled control must not leave stale hints behind.
    const observer = new MutationObserver((changes) => {
      if (!visible() || changes.every((c) => layer.contains(c.target))) return;
      if (!allowed() || anchors.some(({ el, rect }) => {
        const r = el.getBoundingClientRect();
        return !el.isConnected || !!el.closest('[inert], :disabled, [aria-disabled="true"]')
          || r.x !== rect.x || r.y !== rect.y || r.width !== rect.width || r.height !== rect.height;
      })) hide();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    onCleanup(() => { stop(); observer.disconnect(); });
  });
  return <div ref={layer} class="shortcut-hints" classList={{ visible: visible() }} aria-hidden="true">
    <For each={hints()}>{(hint) => <kbd class="shortcut-hint" data-hint={hint.id}>{hint.label}</kbd>}</For>
  </div>;
}
