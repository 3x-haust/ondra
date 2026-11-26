// The workspace a per-space settings page (루틴, 훅, 시크릿, 서비스) reads and writes, picked in its
// head. This device's own only: a connected device's workspaces keep their settings on that device.
import { createSignal, For, Show } from "solid-js";
import { ownSpace, ownSpaces, state } from "../state/store";
import type { SpaceId } from "../state/types";
import { t } from "../i18n";

/** the picked workspace: until the user picks one, `want` (the current one) when it is this device's,
 *  else the first; a workspace removed meanwhile falls back the same way */
export function createSpacePick(want: () => SpaceId | undefined = () => state.space) {
  const [picked, setPicked] = createSignal<SpaceId>();
  return [() => ownSpace(picked() ?? want()), setPicked] as const;
}

export function SpacePick(props: { space: SpaceId; onPick: (id: SpaceId) => void }) {
  return (
    <Show when={ownSpaces().length > 1}>
      <select class="select" aria-label={t("워크스페이스|one")} value={props.space} onChange={(e) => props.onPick(e.currentTarget.value)}>
        <For each={ownSpaces()}>{(s) => <option value={s.id}>{t(s.label)}</option>}</For>
      </select>
    </Show>
  );
}
