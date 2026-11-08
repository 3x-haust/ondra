// The ⌥Space window: type, Enter, gone. Tab switches the space.
import { createSignal, onCleanup, onMount } from "solid-js";
import type { SpaceId } from "../state/types";
import { hideCapture, onEvent, stateLoad, submitCapture } from "../lib/native";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";

export function Capture() {
  const [text, setText] = createSignal("");
  const [spaces, setSpaces] = createSignal<{ id: SpaceId; label: string }[]>([{ id: "home", label: "개인" }]);
  const [space, setSpace] = createSignal<SpaceId>("home");
  const load = async () => {
    const raw = await stateLoad().catch(() => null);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { space?: string; spaces?: { id: string; label: string }[] };
      if (s.spaces?.length) setSpaces(s.spaces.map(({ id, label }) => ({ id, label })));
      if (s.space && s.spaces?.some((x) => x.id === s.space)) setSpace(s.space);
    } catch {}
  };
  const next = () => {
    const l = spaces();
    setSpace(l[(l.findIndex((s) => s.id === space()) + 1) % l.length].id);
  };
  const label = () => t(spaces().find((s) => s.id === space())?.label ?? "개인");
  let input!: HTMLTextAreaElement;

  const focus = () => queueMicrotask(() => input?.focus());
  let un: (() => void) | undefined;
  onCleanup(() => un?.());
  onMount(() => {
    focus();
    void load();
    onEvent("capture:opened", () => (focus(), void load())).then((u) => (un = u));
  });

  const send = async () => {
    const value = text().trim();
    if (!value) return;
    await submitCapture(value, space());
    setText("");
  };

  return (
    <div class="capture">
      <textarea
        ref={input}
        value={text()}
        placeholder={t("무엇을 할까요?")}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") hideCapture();
          else if (e.key === "Tab") {
            e.preventDefault();
            next();
          } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div class="capture-bar">
        <button class="space" onClick={next} disabled={spaces().length < 2} title={t("워크스페이스")}>
          {label()}
          <Icon name="down" size={12} />
        </button>
        <span class="keys">
          <span><kbd>⏎</kbd> {t("보내기")}</span>
          {spaces().length > 1 && <span><kbd>⇥</kbd> {t("워크스페이스")}</span>}
          <span><kbd>esc</kbd> {t("닫기")}</span>
        </span>
      </div>
    </div>
  );
}
