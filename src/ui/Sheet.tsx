// A centred dialog over a dimmed backdrop: esc or a click outside closes it.
import { onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./Icon";
import { ignoredKey, noModifiers } from "../lib/shortcuts";

export function Sheet(props: { title: string; onClose: () => void; children: any; foot?: any; class?: string }) {
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !ignoredKey(e) && noModifiers(e)) {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));
  return (
    <Portal>
      <div class="backdrop cx-backdrop" onClick={props.onClose}>
        <div class={`sheet ${props.class ?? "sk-sheet"}`} role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
          <div class="sheet-head">
            {props.title}
            <span class="spacer" />
            <button class="icon-btn" title="닫기 (esc)" onClick={props.onClose}><Icon name="x" size={15} /></button>
          </div>
          <div class="sheet-body sk-body">{props.children}</div>
          <Show when={props.foot}><div class="sheet-foot">{props.foot}</div></Show>
        </div>
      </div>
    </Portal>
  );
}
