// `?` shows every shortcut, built from the same table the keys run on (after gitsu),
// so it can't go out of date.
import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { appCommands } from "../state/commands";
import { shortcutLabel, type ShortcutCommand } from "../lib/shortcuts";

const [open, setOpen] = createSignal(false);
export { open as sheetOpen, setOpen as setSheetOpen };

const EXTRA: [string, string][] = [
  ["버튼마다 단축키 보기", "⌘ 길게"],
  ["어디서든 요청 보내기", "⌥ Space"],
  ["단축키 보기", "?"],
];

export function ShortcutSheet() {
  const groups = createMemo(() => {
    const out = new Map<string, ShortcutCommand[]>();
    for (const c of appCommands()) if (c.shortcut) out.set(c.section, [...(out.get(c.section) ?? []), c]);
    return [...out];
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <div class="backdrop" onClick={() => setOpen(false)}>
      <div class="keysheet" role="dialog" aria-modal="true" aria-label="단축키" onClick={(e) => e.stopPropagation()}>
        <h3>단축키</h3>
        <div class="keysheet-cols">
          <section>
            <For each={EXTRA}>
              {([label, keys]) => (
                <div class="keysheet-row">
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              )}
            </For>
          </section>
          <For each={groups()}>
            {([section, list]) => (
              <section>
                <h4>{section}</h4>
                <For each={list}>
                  {(c) => (
                    <div class="keysheet-row">
                      <span>{c.label}</span>
                      <kbd>{shortcutLabel(c.shortcut!)}</kbd>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
