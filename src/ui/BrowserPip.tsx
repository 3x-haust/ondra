// A job's browser, floating in a corner while it works (picture-in-picture):
// the live page, small, wherever you are in the app. Clicking it opens that job on its browser tab;
// × keeps it closed for that job; Settings can keep it from showing at all. Drag it to another corner.
import { createMemo, createSignal, Show } from "solid-js";
import { state } from "../state/store";
import { openPanel, openTask, panelOpen, panelShared, panelTab, view } from "../state/ui";
import { fileSrc } from "../lib/native";
import { useBrowserStream } from "./browserStream";
import { cornerOf, nearestCorner, pipJob, type Corner } from "./pip";
import { Icon } from "./Icon";
import { t } from "../i18n";

const KEY = "ondra.pip.corner";
const stored = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const store = (c: Corner) => {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* it starts in the default corner next time */
  }
};
/** jobs whose preview was closed here: they stay closed (for this run of the app) */
const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set());

export function BrowserPip() {
  const [corner, setCorner] = createSignal<Corner>(cornerOf(stored()));
  const [drag, setDrag] = createSignal<{ dx: number; dy: number } | null>(null);
  const job = createMemo(() =>
    state.settings.browserPip === false ? undefined : pipJob(state.tasks.filter((x) => x.space === state.space), closed()),
  );
  // its own browser tab is on screen already: no second copy of it
  const onScreen = () => {
    const j = job();
    const v = view();
    return !!j && v.name === "task" && v.id === j.id && panelOpen() && panelTab() === "browser" && !panelShared();
  };
  const shown = createMemo(() => (onScreen() ? undefined : job()));
  // the stream runs only while the preview is up
  const live = useBrowserStream(() => shown(), { fps: 5 });
  const site = () => live.url().replace(/^https?:\/\//, "").replace(/\/$/, "");

  const open = () => {
    const j = shown();
    if (!j) return;
    openTask(j.id);
    openPanel("browser");
  };
  const close = (e: MouseEvent) => {
    e.stopPropagation();
    const j = shown();
    if (j) setClosed((s) => new Set([...s, j.id]));
  };

  // drag anywhere on it to another corner; a press that doesn't move is a click
  let from: { x: number; y: number; id: number } | undefined;
  let el!: HTMLDivElement;
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    from = { x: e.clientX, y: e.clientY, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (drag() || Math.hypot(dx, dy) > 4) setDrag({ dx, dy });
  };
  const up = (e: PointerEvent) => {
    if (!from) return;
    from = undefined;
    if (!drag()) return open();
    const r = el.getBoundingClientRect();
    const c = nearestCorner(r.left + r.width / 2, r.top + r.height / 2, window.innerWidth, window.innerHeight);
    setDrag(null);
    setCorner(c);
    store(c);
    void e;
  };

  return (
    <Show when={shown()}>
      {(j) => (
        <div
          ref={el}
          class={`pip at-${corner()}`}
          classList={{ dragging: !!drag() }}
          style={drag() ? { transform: `translate(${drag()!.dx}px, ${drag()!.dy}px)` } : undefined}
          role="button"
          tabindex="0"
          aria-label={t("{name} 브라우저 크게 보기", { name: j().title })}
          title={t("눌러서 크게 보기")}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => ((from = undefined), setDrag(null))}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
        >
          <div class="pip-screen">
            <Show
              when={live.frame()}
              fallback={<Show when={j().shot} fallback={<span class="pip-wait">{t("연결 중")}</span>}>{(p) => <img src={fileSrc(p())} alt="" draggable={false} />}</Show>}
            >
              {(f) => <img src={f()} alt="" draggable={false} />}
            </Show>
          </div>
          <div class="pip-bar">
            <span class="pip-live" aria-hidden="true" />
            <span class="pip-what">
              <span class="pip-title">{j().title}</span>
              <Show when={site()}><span class="pip-site">{site()}</span></Show>
            </span>
            <button class="pip-btn" title={t("크게 보기")} aria-label={t("크게 보기")} onClick={(e) => (e.stopPropagation(), open())}>
              <Icon name="fit" size={13} />
            </button>
            <button class="pip-btn" title={t("닫기")} aria-label={t("닫기")} onClick={close}>
              <Icon name="x" size={13} />
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
