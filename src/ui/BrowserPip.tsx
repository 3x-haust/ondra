// A job's browser, floating in a corner while it works (picture-in-picture):
// the live page, small, wherever you are in the app. Clicking it opens that job on its browser tab;
// × keeps it closed for that job; Settings can keep it from showing at all.
// It moves like a thing you hold: drag it anywhere, let go and it carries on in the direction
// you threw it to the nearest corner (a flick crosses the window), easing in without overshoot.
// It grows in from its corner and shrinks away when the job is done or it is closed.
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { state } from "../state/store";
import type { Task } from "../state/types";
import { openPanel, openTask, panelOpen, panelShared, panelTab, view } from "../state/ui";
import { srcOf } from "../engine/far";
import { useBrowserStream } from "./browserStream";
import { cornerOf, cornerSpot, nearestCorner, PIP_W, pipJob, projectRelease, type Corner } from "./pip";
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

const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
/** the app's own curve for things that slide or pop in: quick, then settles, no overshoot */
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

export function BrowserPip() {
  const [corner, setCorner] = createSignal<Corner>(cornerOf(stored()));
  const job = createMemo(() =>
    state.settings.browserPip === false ? undefined : pipJob(state.tasks.filter((x) => x.space === state.space), closed(), ((v) => (v.name === "task" ? v.id : undefined))(view())),
  );
  // its own browser tab is on screen already: no second copy of it
  const onScreen = () => {
    const j = job();
    const v = view();
    return !!j && v.name === "task" && v.id === j.id && panelOpen() && panelTab() === "browser" && !panelShared();
  };
  const want = createMemo(() => (onScreen() ? undefined : job()));
  // the job on screen: kept a moment after it goes, so it can shrink away instead of vanishing
  const [shown, setShown] = createSignal<Task>();
  const [leaving, setLeaving] = createSignal(false);
  let gone: number | undefined;
  createEffect(() => {
    const j = want();
    clearTimeout(gone);
    if (j) return void (setShown(j), setLeaving(false));
    if (!shown()) return;
    setLeaving(true);
    gone = window.setTimeout(() => (setShown(undefined), setLeaving(false)), calm() ? 0 : 200);
  });
  onCleanup(() => clearTimeout(gone));
  // the stream runs only while the preview is up
  const live = useBrowserStream(() => want(), { fps: 5 });
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

  // ── where it sits: one transform, so every move (a drag, a throw, a resize) is the same motion ──
  let el: HTMLDivElement | undefined;
  const size = () => ({ w: window.innerWidth, h: window.innerHeight, ph: el?.offsetHeight ?? PIP_W * 0.625 });
  const spotOf = (c: Corner) => {
    const s = size();
    return cornerSpot(c, s.w, s.h, PIP_W, s.ph);
  };
  let at = { x: 0, y: 0 };
  let anim: Animation | undefined;
  const put = (p: { x: number; y: number }, scale = 1) => {
    at = p;
    if (el) el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) scale(${scale})`;
  };
  /** glide from where it is to a corner, starting at the speed it was let go with */
  const settle = (c: Corner) => {
    const to = spotOf(c);
    const from = at;
    put(to);
    if (!el || calm()) return;
    anim?.cancel();
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    anim = el.animate(
      [{ transform: `translate3d(${from.x}px, ${from.y}px, 0) scale(1.03)` }, { transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(1)` }],
      { duration: Math.min(520, 280 + d * 0.35), easing: EASE },
    );
  };
  const onResize = () => put(spotOf(corner()));
  onMount(() => window.addEventListener("resize", onResize));
  onCleanup(() => window.removeEventListener("resize", onResize));

  // grow in from its corner when it (re)appears
  const enter = (node: HTMLDivElement) => {
    el = node;
    put(spotOf(corner()));
    if (calm()) return;
    const p = at;
    const towardEdge = { x: corner().endsWith("l") ? -10 : 10, y: corner().startsWith("t") ? -10 : 10 };
    node.animate(
      [
        { opacity: 0, transform: `translate3d(${p.x + towardEdge.x}px, ${p.y + towardEdge.y}px, 0) scale(0.92)` },
        { opacity: 1, transform: `translate3d(${p.x}px, ${p.y}px, 0) scale(1)` },
      ],
      { duration: 320, easing: EASE },
    );
  };
  createEffect(() => {
    if (!leaving() || !el || calm()) return;
    const p = at;
    el.animate(
      [{ opacity: 1, transform: `translate3d(${p.x}px, ${p.y}px, 0) scale(1)` }, { opacity: 0, transform: `translate3d(${p.x}px, ${p.y}px, 0) scale(0.92)` }],
      { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
  });

  // ── drag: it follows the pointer exactly; let go and it is thrown to a corner ──
  const [dragging, setDragging] = createSignal(false);
  let press: { x: number; y: number; ox: number; oy: number; id: number } | undefined;
  let trail: { x: number; y: number; t: number }[] = [];
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button") || !el) return;
    anim?.cancel();
    press = { x: e.clientX, y: e.clientY, ox: at.x, oy: at.y, id: e.pointerId };
    trail = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    el.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!press) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!dragging() && Math.hypot(dx, dy) <= 4) return;
    setDragging(true);
    trail = [...trail.filter((p) => e.timeStamp - p.t < 100), { x: e.clientX, y: e.clientY, t: e.timeStamp }];
    put({ x: press.ox + dx, y: press.oy + dy }, 1.03);
  };
  const up = (e: PointerEvent) => {
    if (!press) return;
    press = undefined;
    if (!dragging()) return open();
    setDragging(false);
    const first = trail[0];
    const dt = Math.max(16, e.timeStamp - first.t);
    const v = { x: (e.clientX - first.x) / dt, y: (e.clientY - first.y) / dt }; // px per ms
    const s = size();
    const end = projectRelease({ x: at.x + PIP_W / 2, y: at.y + s.ph / 2 }, v);
    const c = nearestCorner(end.x, end.y, s.w, s.h);
    setCorner(c);
    store(c);
    settle(c);
  };
  const cancel = () => {
    press = undefined;
    if (dragging()) (setDragging(false), settle(corner()));
  };

  return (
    <Show when={shown()}>
      {(j) => (
        <div
          ref={enter}
          class="pip"
          classList={{ dragging: dragging(), leaving: leaving() }}
          role="button"
          tabindex="0"
          aria-label={t("{name} 브라우저 크게 보기", { name: j().title })}
          title={t("눌러서 크게 보기")}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={cancel}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
        >
          <div class="pip-head">
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
          <div class="pip-screen">
            <Show
              when={live.frame()}
              fallback={<Show when={j().shot} fallback={<span class="pip-wait">{t("연결 중")}</span>}>{(p) => <img src={srcOf(p(), j().host)} alt="" draggable={false} />}</Show>}
            >
              {(f) => <img src={f()} alt="" draggable={false} />}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
