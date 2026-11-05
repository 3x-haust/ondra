// One way to fold things: height eases open and shut (grid rows 0fr ↔ 1fr), the
// content fades with it. Content mounts on first open and stays, so closing
// animates too. Use this instead of <Show> for anything the user expands.
import { createEffect, createSignal, type JSX, Show } from "solid-js";

export function Fold(props: { open: boolean; children: JSX.Element; class?: string }) {
  const [seen, setSeen] = createSignal(props.open);
  createEffect(() => props.open && setSeen(true));
  return (
    <div class={`fold ${props.class ?? ""}`} classList={{ open: props.open }} aria-hidden={!props.open} inert={!props.open}>
      <div class="fold-in">
        <Show when={seen()}>{props.children}</Show>
      </div>
    </div>
  );
}
