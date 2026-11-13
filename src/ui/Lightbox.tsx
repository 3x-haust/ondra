// A picture, big. ← → moves between the pictures it was opened with, Esc closes.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { revealOn, srcOf, type Where } from "../engine/far";
import { ignoredKey, noModifiers } from "../lib/shortcuts";
import { Icon } from "./Icon";
import { BoardView } from "./board/view";
import { t } from "../i18n";

const [shown, setShown] = createSignal<{ list: string[]; i: number; host?: Where } | null>(null);

// a drawn picture (cleaned SVG markup from an answer), shown big on its own
const [drawn, setDrawn] = createSignal<string | null>(null);
export const openDrawing = (markup: string) => setDrawn(markup);

// a board (an answer's drawn explanation), big; a 3D part asked about goes to the composer it came from
const [board, setBoard] = createSignal<{ src: string; ask?: (text: string) => void } | null>(null);
export const openBoard = (src: string, ask?: (text: string) => void) => setBoard({ src, ask });

function BigBoard(props: { src: string; ask?: (text: string) => void }) {
  let host!: HTMLDivElement;
  onMount(() => {
    const v = new BoardView({ big: true, onAsk: props.ask && ((text) => (props.ask!(text), setBoard(null))) });
    host.appendChild(v.root);
    v.update(props.src, true);
    onCleanup(() => v.dispose());
  });
  return <div class="lb-board" ref={host} onClick={(e) => e.stopPropagation()} />;
}

/** `host`: the pictures are another Mac's (a job running there) */
export function openImage(path: string, list: string[] = [path], host?: Where) {
  const l = list.includes(path) ? list : [path, ...list];
  setShown({ list: l, i: l.indexOf(path), host });
}

export function Lightbox() {
  const step = (d: number) => setShown((s) => s && { ...s, i: (s.i + d + s.list.length) % s.list.length });
  const onKey = (e: KeyboardEvent) => {
    if (drawn() && e.key === "Escape" && !ignoredKey(e)) return void (e.preventDefault(), e.stopPropagation(), setDrawn(null));
    if (board() && e.key === "Escape" && !ignoredKey(e)) return void (e.preventDefault(), e.stopPropagation(), setBoard(null));
    if (!shown() || ignoredKey(e) || !noModifiers(e)) return;
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setShown(null));
    else if (e.key === "ArrowRight") (e.preventDefault(), e.stopPropagation(), step(1));
    else if (e.key === "ArrowLeft") (e.preventDefault(), e.stopPropagation(), step(-1));
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <>
    <Show when={drawn()}>
      {(m) => (
        <div class="lightbox" onClick={() => setDrawn(null)}>
          <div class="lb-drawing" innerHTML={m()} onClick={(e) => e.stopPropagation()} />
          <div class="lb-bar" onClick={(e) => e.stopPropagation()}>
            <button class="icon-btn sm" title={`${t("닫기")} esc`} aria-label={t("닫기")} onClick={() => setDrawn(null)}><Icon name="x" size={14} /></button>
          </div>
        </div>
      )}
    </Show>
    <Show when={board()}>
      {(b) => (
        <div class="lightbox" onClick={() => setBoard(null)}>
          <BigBoard src={b().src} ask={b().ask} />
          <div class="lb-bar" onClick={(e) => e.stopPropagation()}>
            <button class="icon-btn sm" title={`${t("닫기")} esc`} aria-label={t("닫기")} onClick={() => setBoard(null)}><Icon name="x" size={14} /></button>
          </div>
        </div>
      )}
    </Show>
    <Show when={shown()}>
      {(s) => {
        const path = () => s().list[s().i];
        return (
          <div class="lightbox" onClick={() => setShown(null)}>
            <img src={srcOf(path(), s().host)} alt="" onClick={(e) => e.stopPropagation()} />
            <div class="lb-bar" onClick={(e) => e.stopPropagation()}>
              <span class="lb-name">{path().split("/").pop()}</span>
              <Show when={s().list.length > 1}>
                <span class="lb-n">{s().i + 1}/{s().list.length}</span>
                <button class="icon-btn sm" title={`${t("이전")} ←`} aria-label={t("이전")} onClick={() => step(-1)}><Icon name="back" size={14} /></button>
                <button class="icon-btn sm" title={`${t("다음")} →`} aria-label={t("다음")} onClick={() => step(1)}><Icon name="arrow" size={14} /></button>
              </Show>
              <button class="icon-btn sm" title={s().host ? t("그 Mac의 Finder에서 보기") : t("Finder에서 보기")} aria-label={t("Finder에서 보기")} onClick={() => void revealOn(s().host, path())}><Icon name="open" size={14} /></button>
              <button class="icon-btn sm" title={`${t("닫기")} esc`} aria-label={t("닫기")} onClick={() => setShown(null)}><Icon name="x" size={14} /></button>
            </div>
          </div>
        );
      }}
    </Show>
    </>
  );
}
