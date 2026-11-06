import { createSignal, For, onCleanup, onMount } from "solid-js";
import { editableTarget, localKeysTarget, shortcutLabel, shortcutOverlay, type ShortcutCommand } from "../lib/shortcuts";
import { watchShortcutHold } from "../lib/shortcutHold";
import "./shortcutHints.css";

interface Hint { id: string; label: string; x: number; y: number }

export function ShortcutHints(props: { commands: () => ShortcutCommand[]; enabled: () => boolean }) {
  const [hints, setHints] = createSignal<Hint[]>([]);
  const [visible, setVisible] = createSignal(false);
  let layer!: HTMLDivElement;
  let anchors: { el: HTMLElement; rect: DOMRect }[] = [];
  const allowed = () => props.enabled() && !document.hidden && !shortcutOverlay()
    && !editableTarget(document.activeElement) && !localKeysTarget(document.activeElement);
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
      next.push({ id: command.id, label: shortcutLabel(command.shortcut), x, y: r.bottom });
    }
    setHints(next);
    // Measure rendered badges so they stay inside the window and never overlap each other.
    const placed: DOMRect[] = [];
    for (const badge of layer.querySelectorAll<HTMLElement>(".shortcut-hint")) {
      const r = badge.getBoundingClientRect();
      const left = Math.max(0, Math.min(r.left, innerWidth - r.width));
      let top = Math.max(0, Math.min(r.top, innerHeight - r.height));
      for (const other of placed) {
        if (left < other.right && left + r.width > other.left && top < other.bottom && top + r.height > other.top) top = other.bottom;
      }
      if (top + r.height > innerHeight) { badge.style.visibility = "hidden"; continue; }
      badge.style.left = `${left}px`;
      badge.style.top = `${top}px`;
      badge.style.transform = "none";
      placed.push(new DOMRect(left, top, r.width, r.height));
    }
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
    <For each={hints()}>{(hint) => <kbd class="shortcut-hint" data-hint={hint.id} style={{ left: `${hint.x}px`, top: `${hint.y}px` }}>{hint.label}</kbd>}</For>
  </div>;
}
