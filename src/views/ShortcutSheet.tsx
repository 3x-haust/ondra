// `?` shows every shortcut, built from the same table the keys run on (after gitsu),
// so it can't go out of date, and shows the user's bindings. The names are the ones Settings › 단축키 shows.
import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { appCommands } from "../state/commands";
import { chordLabel, HELD, matchesShortcut, shortcutLabel, type Shortcut, type ShortcutCommand, type ShortcutId } from "../lib/shortcuts";
import { Icon } from "../ui/Icon";
import { setView } from "../state/ui";
import { t } from "../i18n";

const [open, setOpen] = createSignal(false);
export { open as sheetOpen, setOpen as setSheetOpen };

/** keys that aren't commands, as [id, Korean name] (Settings › 단축키 lists the same) */
export const SHORTCUT_EXTRAS: [ShortcutId, string][] = [
  ["hints", "단축키 힌트"],
  ["capture", "어디서든 요청"],
  ["quit", "종료"],
];
/** the keys an id answers to now ("⌘ 길게" for a hold; "" when unbound), or `chord`'s */
export function keyText(id: ShortcutId, chord?: Shortcut): string {
  const keys = chord ? chordLabel(chord) : shortcutLabel(id);
  return keys && HELD.includes(id) ? t("{keys} 길게", { keys }) : keys;
}

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
    if (e.key === "Escape" || matchesShortcut(e, "keys")) {
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
          <button class="btn sm ghost" onClick={() => (close(), setView({ name: "settings", tab: "shortcuts" }))}>{t("단축키 설정")}</button>
          <button class="icon-btn" title={`${t("닫기")} (esc)`} aria-label={t("닫기")} onClick={close}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class="keysheet-cols">
          <section>
            <h4>{general()}</h4>
            <For each={SHORTCUT_EXTRAS.filter(([id]) => keyText(id))}>
              {([id, label]) => (
                <div class="keysheet-row">
                  <span>{t(label)}</span>
                  <kbd>{keyText(id)}</kbd>
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
