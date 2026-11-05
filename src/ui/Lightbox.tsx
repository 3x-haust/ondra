// A picture, big. ← → moves between the pictures it was opened with, Esc closes.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { fileSrc, revealPath } from "../lib/native";
import { Icon } from "./Icon";

const [shown, setShown] = createSignal<{ list: string[]; i: number } | null>(null);

export function openImage(path: string, list: string[] = [path]) {
  const l = list.includes(path) ? list : [path, ...list];
  setShown({ list: l, i: l.indexOf(path) });
}

export function Lightbox() {
  const step = (d: number) => setShown((s) => s && { ...s, i: (s.i + d + s.list.length) % s.list.length });
  const onKey = (e: KeyboardEvent) => {
    if (!shown()) return;
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setShown(null));
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <Show when={shown()}>
      {(s) => {
        const path = () => s().list[s().i];
        return (
          <div class="lightbox" onClick={() => setShown(null)}>
            <img src={fileSrc(path())} alt="" onClick={(e) => e.stopPropagation()} />
            <div class="lb-bar" onClick={(e) => e.stopPropagation()}>
              <span class="lb-name">{path().split("/").pop()}</span>
              <Show when={s().list.length > 1}>
                <span class="lb-n">{s().i + 1}/{s().list.length}</span>
                <button class="icon-btn sm" title="이전 (←)" onClick={() => step(-1)}><Icon name="back" size={14} /></button>
                <button class="icon-btn sm" title="다음 (→)" onClick={() => step(1)}><Icon name="arrow" size={14} /></button>
              </Show>
              <button class="icon-btn sm" title="Finder에서 보기" onClick={() => void revealPath(path())}><Icon name="open" size={14} /></button>
              <button class="icon-btn sm" title="닫기 (Esc)" onClick={() => setShown(null)}><Icon name="x" size={14} /></button>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
