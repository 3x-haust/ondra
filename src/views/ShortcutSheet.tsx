// `?` shows every shortcut, built from the same table the keys run on (after gitsu),
// so it can't go out of date. The names are the ones Settings › 단축키 shows.
import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { appCommands } from "../state/commands";
import { shortcutLabel, type ShortcutCommand } from "../lib/shortcuts";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";

const [open, setOpen] = createSignal(false);
export { open as sheetOpen, setOpen as setSheetOpen };

/** keys that aren't commands, as [Korean name, keys]: show both with t() (Settings › 단축키 lists the same) */
export const SHORTCUT_EXTRAS: [string, string][] = [
  ["단축키 힌트", "⌘ 길게"],
  ["어디서든 요청", "⌥ Space"],
  ["단축키 목록", "?"],
  ["종료", "⌘Q 길게"],
];

export function ShortcutSheet() {
  const groups = createMemo(() => {
    const out = new Map<string, ShortcutCommand[]>();
    for (const c of appCommands()) if (c.shortcut) out.set(c.section, [...(out.get(c.section) ?? []), c]);
    // settings close the list, as in the sidebar
    const last = (s: string) => Number(s === t("설정"));
    return [...out].sort((a, b) => last(a[0]) - last(b[0]));
  });
  const close = () => setOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const general = () => t("일반");
  return (
    <div class="backdrop" onClick={close}>
      <div class="keysheet" role="dialog" aria-modal="true" aria-label={t("단축키")} onClick={(e) => e.stopPropagation()}>
        <div class="keysheet-head">
          <h3>{t("단축키")}</h3>
          <button class="icon-btn" title={`${t("닫기")} (esc)`} aria-label={t("닫기")} onClick={close}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class="keysheet-cols">
          <section>
            <h4>{general()}</h4>
            <For each={SHORTCUT_EXTRAS}>
              {([label, keys]) => (
                <div class="keysheet-row">
                  <span>{t(label)}</span>
                  <kbd>{t(keys)}</kbd>
                </div>
              )}
            </For>
            {/* commands filed under 일반 join the keys above */}
            <For each={groups().find(([s]) => s === general())?.[1] ?? []}>
              {(c) => (
                <div class="keysheet-row">
                  <span>{c.label}</span>
                  <kbd>{shortcutLabel(c.shortcut!)}</kbd>
                </div>
              )}
            </For>
          </section>
          <For each={groups().filter(([s]) => s !== general())}>
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
