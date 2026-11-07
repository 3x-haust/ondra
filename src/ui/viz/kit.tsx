// Shared parts every chart is made of, so all families look and read the same:
// a frame that fits its width, axes, gridlines, a legend, a hover tip, number
// formats and the palette (tokens in styles/viz.css, validated for colour blindness).
import { createContext, createSignal, For, onCleanup, onMount, Show, useContext, type JSX } from "solid-js";

/** categorical slot i (0-based), fixed order; from the 9th on, everything is "기타" grey */
export const series = (i: number) => (i < 8 ? `var(--viz-${i + 1})` : "var(--viz-other)");
/** sequential (magnitude) step for t in 0..1, one hue light → dark */
export const seq = (t: number) => `var(--viz-seq-${Math.max(1, Math.min(7, Math.round(t * 6) + 1))})`;
/** diverging step for t in -1..1: cool ← grey → warm */
export const div = (t: number) => {
  const k = Math.max(-3, Math.min(3, Math.round(t * 3)));
  return k === 0 ? "var(--viz-div-0)" : k < 0 ? `var(--viz-div-n${-k})` : `var(--viz-div-p${k})`;
};
export const status = { good: "var(--viz-good)", warn: "var(--viz-warn)", serious: "var(--viz-serious)", bad: "var(--viz-bad)" } as const;

/** 12345 → "12,345", 0.1234 → "0.123"; compact: 12345 → "1.2만", 3.4e8 → "3.4억" */
export function num(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "–";
  if (Number.isInteger(n)) return n.toLocaleString("ko-KR");
  return Number(n.toPrecision(digits)).toLocaleString("ko-KR", { maximumFractionDigits: 6 });
}
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${num(n / 1e12, 2)}조`;
  if (a >= 1e8) return `${num(n / 1e8, 2)}억`;
  if (a >= 1e4) return `${num(n / 1e4, 2)}만`;
  return num(n);
}
export const withUnit = (v: string, unit?: string) => (unit ? (unit === "%" ? `${v}%` : `${v}${/^[A-Za-z]/.test(unit) ? " " : ""}${unit}`) : v);

interface Tip { show: (e: MouseEvent, content: JSX.Element | string) => void; hide: () => void }
const TipCtx = createContext<Tip>({ show: () => {}, hide: () => {} });
/** hover tip for a mark: onMouseMove={(e) => tip.show(e, "…")} onMouseLeave={tip.hide} */
export const useTip = () => useContext(TipCtx);

export interface Box { w: number; h: number; /** plot area */ x0: number; y0: number; iw: number; ih: number }

/**
 * A chart's frame: title, an SVG as wide as the chat column, a plot area inside
 * the margins, a legend and a hover tip. `height` may depend on the width.
 */
export function Frame(props: {
  label?: string;
  class?: string;
  height: number | ((w: number) => number);
  margin?: { t?: number; r?: number; b?: number; l?: number };
  legend?: { label: string; color: string; dash?: boolean }[];
  /** aria label for the figure */
  alt?: string;
  children: (b: Box) => JSX.Element;
  /** drawn under the svg (a table, notes) */
  below?: JSX.Element;
}) {
  let host!: HTMLDivElement;
  const [w, setW] = createSignal(560);
  const [tip, setTip] = createSignal<{ x: number; y: number; c: JSX.Element | string } | null>(null);
  onMount(() => {
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(host.clientWidth))));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
  const box = (): Box => {
    const m = { t: 8, r: 12, b: 28, l: 40, ...props.margin };
    const h = typeof props.height === "function" ? props.height(w()) : props.height;
    return { w: w(), h, x0: m.l, y0: m.t, iw: Math.max(10, w() - m.l - m.r), ih: Math.max(10, h - m.t - m.b) };
  };
  const api: Tip = {
    show: (e, c) => {
      const r = host.getBoundingClientRect();
      setTip({ x: e.clientX - r.left, y: e.clientY - r.top, c });
    },
    hide: () => setTip(null),
  };
  return (
    <div class={`blk viz ${props.class ?? ""}`}>
      <Show when={props.label || props.legend?.length}>
        <div class="viz-head">
          <Show when={props.label}><div class="blk-label">{props.label}</div></Show>
          <Show when={props.legend && props.legend.length > 1}>
            <ul class="viz-legend">
              <For each={props.legend}>{(l) => <li><i classList={{ dash: !!l.dash }} style={{ "--c": l.color }} />{l.label}</li>}</For>
            </ul>
          </Show>
        </div>
      </Show>
      <div class="viz-host" ref={host} onMouseLeave={() => setTip(null)}>
        <TipCtx.Provider value={api}>
          <svg class="viz-svg" width={box().w} height={box().h} viewBox={`0 0 ${box().w} ${box().h}`} role="img" aria-label={props.alt ?? props.label ?? ""}>
            {props.children(box())}
          </svg>
        </TipCtx.Provider>
        <Show when={tip()}>
          {(t) => (
            <div class="viz-tip" style={{ left: `${Math.min(t().x + 12, box().w - 180)}px`, top: `${Math.max(0, t().y - 8)}px` }}>
              {t().c}
            </div>
          )}
        </Show>
      </div>
      {props.below}
    </div>
  );
}

type Scale = ((v: any) => number | undefined) & { ticks?: (n?: number) => any[]; bandwidth?: () => number; domain: () => any[] };

/** an axis with recessive ticks; `grid` draws hairlines across the plot */
export function Axis(props: { scale: Scale; side: "bottom" | "left" | "top" | "right"; box: Box; ticks?: number; format?: (v: any) => string; grid?: boolean; title?: string }) {
  const horiz = () => props.side === "bottom" || props.side === "top";
  const values = () => (props.scale.ticks ? props.scale.ticks(props.ticks ?? (horiz() ? Math.max(2, Math.floor(props.box.iw / 80)) : Math.max(2, Math.floor(props.box.ih / 40)))) : props.scale.domain());
  const pos = (v: any) => (props.scale(v) ?? 0) + (props.scale.bandwidth ? props.scale.bandwidth() / 2 : 0);
  const fmt = (v: any) => (props.format ? props.format(v) : typeof v === "number" ? compact(v) : String(v));
  const b = () => props.box;
  return (
    <g class="viz-axis">
      <For each={values()}>
        {(v) => (
          <Show
            when={horiz()}
            fallback={
              <g transform={`translate(0,${b().y0 + pos(v)})`}>
                <Show when={props.grid}><line class="viz-grid" x1={b().x0} x2={b().x0 + b().iw} /></Show>
                <text x={props.side === "left" ? b().x0 - 6 : b().x0 + b().iw + 6} dy="0.32em" text-anchor={props.side === "left" ? "end" : "start"}>{fmt(v)}</text>
              </g>
            }
          >
            <g transform={`translate(${b().x0 + pos(v)},0)`}>
              <Show when={props.grid}><line class="viz-grid" y1={b().y0} y2={b().y0 + b().ih} /></Show>
              <text y={props.side === "bottom" ? b().y0 + b().ih + 16 : b().y0 - 6} text-anchor="middle">{fmt(v)}</text>
            </g>
          </Show>
        )}
      </For>
      <Show when={props.side === "bottom"}><line class="viz-base" x1={b().x0} x2={b().x0 + b().iw} y1={b().y0 + b().ih} y2={b().y0 + b().ih} /></Show>
      <Show when={props.side === "left" && !props.scale.bandwidth}><line class="viz-base" x1={b().x0} x2={b().x0} y1={b().y0} y2={b().y0 + b().ih} /></Show>
      <Show when={props.title}>
        <text class="viz-axis-title" x={horiz() ? b().x0 + b().iw : b().x0 - 6} y={horiz() ? b().y0 + b().ih + 26 : b().y0 - 2} text-anchor="end">{props.title}</text>
      </Show>
    </g>
  );
}

/** text that wraps into lines of at most `max` characters (SVG has no wrapping) */
export function Lines(props: { text: string; x: number; y: number; max: number; lh?: number; anchor?: "start" | "middle" | "end"; class?: string }) {
  const lines = () => wrap(props.text, props.max);
  return (
    <text class={props.class} x={props.x} y={props.y} text-anchor={props.anchor ?? "middle"}>
      <For each={lines()}>{(l, i) => <tspan x={props.x} dy={i() ? `${props.lh ?? 1.25}em` : 0}>{l}</tspan>}</For>
    </text>
  );
}
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if ((cur + " " + word).trim().length > max && cur) (out.push(cur), (cur = word));
    else cur = (cur + " " + word).trim();
  }
  if (cur) out.push(cur);
  return out;
}
