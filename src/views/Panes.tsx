// The center as split panes (Ghostty / cmux): every pane shows its own view with its own
// history; one has the focus. Panes are laid out from the tree in src/state/layout.ts and
// drawn side by side (never re-mounted when another one opens), with dividers to drag.
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import * as L from "../state/layout";
import { equalizePanes, focusPane, layout, paneEl, setPaneRoom, setSplitNeed, setSplitRatio, type View } from "../state/ui";
import { PaneCtx, usePane } from "../state/panes";
import { drag, needs, setAlone, setZoneAt, zone, type Zone } from "./PaneControls";
import { MainView } from "./MainView";
import { Canvas } from "./Canvas";
import { MemoryView } from "./Memory";
import { ResultsView } from "./Results";
import { Devices } from "./Devices";
import { TaskView } from "./TaskView";
import { t } from "../i18n";

/** the least a pane may get: a chat column with its input, and a header that still fits */
export const MIN_W = 360;
export const MIN_H = 220;
const MAIN: View = { name: "main" };

// ───────────── what a pane shows

function Slide(props: { from: 1 | -1; first: () => boolean; children: JSX.Element }) {
  let el!: HTMLDivElement;
  onMount(() => {
    if (props.first() || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ transform: `translateX(${props.from * 24}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 280, easing: "cubic-bezier(.32,.72,0,1)" });
  });
  return <div class="slide" ref={el}>{props.children}</div>;
}

/** The pane's view; it slides over when it changes (not when the pane first paints). */
function Body() {
  const v = usePane()!.view;
  let first = true;
  onMount(() => queueMicrotask(() => (first = false)));
  const isFirst = () => first;
  const is = (name: View["name"]) => v().name === name;
  return (
    <Show when={v().name === "task" && (v() as { id: string }).id} keyed fallback={
      <Show when={is("board")} fallback={
        <Show when={is("devices")} fallback={
          <Show when={is("memory")} fallback={
            <Show when={is("results")} fallback={<Slide from={-1} first={isFirst}><MainView /></Slide>}>
              <Slide from={-1} first={isFirst}><ResultsView /></Slide>
            </Show>
          }><Slide from={-1} first={isFirst}><MemoryView /></Slide></Show>
        }><Slide from={-1} first={isFirst}><Devices /></Slide></Show>
      }><Slide from={-1} first={isFirst}><Canvas /></Slide></Show>
    }>
      {(id) => <Slide from={1} first={isFirst}><TaskView id={id} /></Slide>}
    </Show>
  );
}

// ───────────── the host

const allSplits = (n: L.Node): L.Split[] => (L.isLeaf(n) ? [] : [n, ...allSplits(n.a), ...allSplits(n.b)]);
/** what each pane's ring was last seen for, kept while the panes are away (settings) */
const seenBy = new Map<string, string | null>();
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function Panes() {
  let host!: HTMLDivElement;
  const [box, setBox] = createSignal({ w: 0, h: 0 });
  /** no movement while the window or the sidebar resizes, or a divider is dragged */
  const [still, setStill] = createSignal(true);
  const [dragging, setDragging] = createSignal<string | null>(null);
  let gut = 8;
  const room = (): L.Room => ({ w: box().w, h: box().h, gap: gut, minW: MIN_W, minH: MIN_H });
  setPaneRoom(() => (box().w ? room() : null));
  let quiet: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    gut = parseFloat(getComputedStyle(host).getPropertyValue("--gut")) || 8;
    const ro = new ResizeObserver(() => {
      setStill(true);
      setBox({ w: host.clientWidth, h: host.clientHeight });
      clearTimeout(quiet);
      quiet = setTimeout(() => setStill(false), 180);
    });
    ro.observe(host);
    onCleanup(() => (ro.disconnect(), clearTimeout(quiet), setPaneRoom(() => null)));
  });

  const ids = createMemo(() => Object.keys(layout().panes), [], { equals: sameList });
  const multi = () => ids().length > 1;
  const fit = createMemo(() => !box().w || L.fits(layout().root, room()));
  createEffect(() => setAlone(multi() && !fit()));
  // the list steps aside for the panel sooner when panes sit side by side
  createEffect(() => setSplitNeed(multi() ? L.minSize(layout().root, "row", room()) : 0));
  onCleanup(() => setSplitNeed(0));
  /** one pane fills the area: zoomed, or the window too narrow for them all */
  const solo = () => (multi() ? (layout().zoom ?? (fit() ? null : layout().focus)) : null);
  const boxes = createMemo(() => L.rects(layout().root, room()));
  const full = (): L.Rect => ({ x: 0, y: 0, w: box().w, h: box().h });
  const rectOf = (id: string) => (solo() === id || !multi() ? full() : boxes().get(id));
  const splitIds = createMemo(() => allSplits(layout().root).map((s) => s.id), [], { equals: sameList });
  const divider = (sid: string): (L.Rect & { axis: L.Axis }) | null => {
    const s = L.findSplit(layout().root, sid);
    const r = boxes().get(sid);
    const a = s && boxes().get(L.isLeaf(s.a) ? s.a.pane : s.a.id);
    if (!s || !r || !a) return null;
    return s.axis === "row" ? { x: a.x + a.w, y: r.y, w: gut, h: r.h, axis: "row" } : { x: r.x, y: a.y + a.h, w: r.w, h: gut, axis: "col" };
  };

  // focus moved by the keyboard (⌥⌘ arrows, ⌘W, the palette): the cursor goes along, into its input
  let byPointer = false;
  createEffect(on(() => layout().focus, (id) => {
    if (byPointer) return;
    requestAnimationFrame(() => {
      const el = paneEl(id);
      if (!el || el.contains(document.activeElement) || document.activeElement?.closest(".panel, .palette, [role=dialog]")) return;
      (el.querySelector<HTMLElement>("#new-task-input, #task-input:not(:disabled), #main-input:not(:disabled)") ?? el).focus({ preventScroll: true });
    });
  }, { defer: true }));

  // a dragged job: which pane and which side of it is under the pointer
  setZoneAt((x, y): Zone | null => {
    const h = host.getBoundingClientRect();
    const px = x - h.left;
    const py = y - h.top;
    if (px < 0 || py < 0 || px > h.width || py > h.height) return null;
    for (const id of ids()) {
      if (solo() && solo() !== id) continue;
      const r = rectOf(id);
      if (!r || px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) continue;
      const fx = (px - r.x) / r.w;
      const fy = (py - r.y) / r.h;
      const edges: [L.Dir, number][] = [["left", fx], ["right", 1 - fx], ["up", fy], ["down", 1 - fy]];
      const [side, d] = edges.sort((a, b) => a[1] - b[1])[0];
      return { pane: id, side: d < 0.25 ? side : "middle" };
    }
    return null;
  });
  onCleanup(() => setZoneAt(() => null));
  const zoneRect = (): L.Rect | null => {
    const z = zone();
    const r = z && rectOf(z.pane);
    if (!z || !r) return null;
    if (z.side === "left") return { ...r, w: r.w / 2 };
    if (z.side === "right") return { ...r, x: r.x + r.w / 2, w: r.w / 2 };
    if (z.side === "up") return { ...r, h: r.h / 2 };
    if (z.side === "down") return { ...r, y: r.y + r.h / 2, h: r.h / 2 };
    return r;
  };

  const startResize = (e: PointerEvent, sid: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(sid);
    document.body.classList.add("resizing");
    const move = (m: PointerEvent) => {
      const s = L.findSplit(layout().root, sid);
      const r = boxes().get(sid);
      if (!s || !r) return;
      const h = host.getBoundingClientRect();
      const at = s.axis === "row" ? m.clientX - h.left - r.x - gut / 2 : m.clientY - h.top - r.y - gut / 2;
      setSplitRatio(sid, at / ((s.axis === "row" ? r.w : r.h) - gut));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(null);
      document.body.classList.remove("resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const style = (r: L.Rect | undefined): JSX.CSSProperties =>
    r ? { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } : { inset: "0" };

  return (
    <div ref={host} class="panes" classList={{ multi: multi(), still: still() || !!dragging(), solo: !!solo() }}>
      <For each={ids()}>
        {(id) => {
          const focused = () => layout().focus === id;
          const v = createMemo(() => layout().panes[id]?.view ?? MAIN);
          // the attention ring: a job here started needing you while you looked elsewhere; seen once focused
          const want = createMemo(() => {
            const n = needs(id);
            return n ? `${(v() as { id: string }).id}:${n}` : null;
          });
          const [seen, setSeen] = createSignal<string | null>(seenBy.get(id) ?? null);
          createEffect(() => {
            const k = want();
            if (focused() || !k) (setSeen(k), seenBy.set(id, k));
          });
          const ring = () => multi() && !focused() && !!want() && want() !== seen();
          const hidden = () => !!solo() && solo() !== id;
          const corner = () => {
            const r = rectOf(id);
            return !r || (r.x < 1 && r.y < 1);
          };
          let el!: HTMLElement;
          onMount(() => {
            const down = () => {
              byPointer = true;
              focusPane(id);
              setTimeout(() => (byPointer = false), 0);
            };
            const into = () => layout().focus !== id && ((byPointer = true), focusPane(id), setTimeout(() => (byPointer = false), 0));
            el.addEventListener("pointerdown", down, true);
            el.addEventListener("focusin", into);
            onCleanup(() => (el.removeEventListener("pointerdown", down, true), el.removeEventListener("focusin", into)));
            // a pane that opens comes in quietly; the ones beside it make room
            if (untrack(multi) && !matchMedia("(prefers-reduced-motion: reduce)").matches)
              el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "cubic-bezier(.2,0,0,1)" });
          });
          return (
            <PaneCtx.Provider value={{ id, view: v, focused }}>
              <section
                ref={el}
                class="pane"
                data-pane={id}
                tabindex="-1"
                aria-label={t("창|one")}
                classList={{ focused: focused(), corner: corner(), hidden: hidden(), ring: ring(), [`ring-${want()?.split(":").pop()}`]: ring() }}
                style={style(rectOf(id))}
                inert={hidden() || undefined}
              >
                <Body />
              </section>
            </PaneCtx.Provider>
          );
        }}
      </For>
      <Show when={multi() && !solo()}>
        <For each={splitIds()}>
          {(sid) => (
            <Show when={divider(sid)}>
              {(d) => (
                <div
                  class={`pane-div by-${d().axis}`}
                  classList={{ on: dragging() === sid }}
                  role="separator"
                  aria-orientation={d().axis === "row" ? "vertical" : "horizontal"}
                  title={t("끌어서 크기 조절 · 두 번 눌러 같게")}
                  style={style(d())}
                  onPointerDown={(e) => startResize(e, sid)}
                  onDblClick={() => equalizePanes(sid)}
                />
              )}
            </Show>
          )}
        </For>
      </Show>
      <Show when={zoneRect()}>{(r) => <div class="pane-drop" style={style(r())} />}</Show>
      <Show when={drag()}>
        {(d) => (
          <Portal>
            <div class="pane-ghost" style={{ left: `${d().x + 12}px`, top: `${d().y + 10}px` }}>{d().title}</div>
          </Portal>
        )}
      </Show>
    </div>
  );
}
