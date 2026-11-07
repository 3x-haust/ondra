// Parts the chart family shares on top of the kit: text measuring, an x axis
// that thins or turns its labels, a crosshair for lines, tooltip rows and the
// rounded-end bars. Every chart lays itself out from the frame's width.
import { createSignal, For, Show, type JSX } from "solid-js";
import { scaleLinear, scaleLog, scaleUtc } from "d3-scale";
import { textW } from "../../Charts";
import { compact, Frame, num, series, useTip, withUnit, type Box } from "../kit";
import { clamp, ellipsize, extent, fmtTime, parseTime, thin, xKind, xLabel, type XKind } from "./math";

/** chart text size (labels) and axis text size */
export const FS = 12.5;
export const AX = 12;
export const tw = (s: string, size = FS, weight = 400) => textW(s, size, weight);
export const cut = (s: string, max: number, size = FS, weight = 400) => ellipsize(s, Math.max(0, max), (t) => tw(t, size, weight));
export const fmtV = (v: number | null | undefined, unit?: string) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : withUnit(num(v), unit));
export const fmtC = (v: number, unit?: string) => withUnit(compact(v), unit);
export const pct = (v: number, digits = 0) => `${Number.isFinite(v) ? (digits ? v.toFixed(digits) : Math.round(v)) : "–"}%`;
/** the grey a de-emphasised mark wears */
export const MUTED = "var(--viz-other)";
/** text on a categorical/status fill: white, near-black on yellow and warning */
export const inkOn = (fill: string) => {
  if (/viz-4\b|viz-warn/.test(fill)) return "ch-in dark";
  if (/div-(0|n1|p1)\b|viz-other|viz-grid/.test(fill)) return "ch-in lt";
  if (/div-(n3|p3)\b/.test(fill)) return "ch-in dk";
  const m = /seq-(\d)/.exec(fill);
  return m ? `ch-in seq${m[1]}` : "ch-in";
};
/** colour for series i, or grey when some other series carries the emphasis */
export const colorOf = (i: number, em?: boolean, anyEm?: boolean) => (anyEm && !em ? MUTED : series(i));

const NOM = { t: 0, r: 0, b: 0, l: 0 };
/**
 * A family frame: the kit frame with no fixed margins (each chart lays itself
 * out from the width) and the family's class for text size and marks.
 */
export function ChFrame(props: {
  label?: string;
  class?: string;
  height: (w: number) => number;
  legend?: { label: string; color: string; dash?: boolean }[];
  alt?: string;
  below?: JSX.Element;
  children: (w: number, h: number) => JSX.Element;
}) {
  return (
    <Frame label={props.label} class={`ch ${props.class ?? ""}`} height={(w) => Math.round(props.height(w))} margin={NOM} legend={props.legend} alt={props.alt} below={props.below}>
      {(b) => props.children(b.w, b.h)}
    </Frame>
  );
}
export const box = (x0: number, y0: number, iw: number, ih: number, w = x0 + iw, h = y0 + ih): Box => ({ x0, y0, iw: Math.max(1, iw), ih: Math.max(1, ih), w, h });

// ───────────── tooltip

export interface TipRow { color?: string; label: string; value: string; key?: "line" | "box" | "dash" }
/** a tooltip: optional title, then rows with the value strong and the name after it */
export function TipBody(props: { title?: string; rows: TipRow[]; foot?: string }) {
  return (
    <div class="ch-tip">
      <Show when={props.title}><div class="ch-tip-title">{props.title}</div></Show>
      <For each={props.rows}>
        {(r) => (
          <div class="ch-tip-row">
            <Show when={r.color}><i class={`ch-key ${r.key ?? "line"}`} style={{ "--c": r.color }} /></Show>
            <b>{r.value}</b>
            <span>{r.label}</span>
          </div>
        )}
      </For>
      <Show when={props.foot}><div class="ch-tip-foot">{props.foot}</div></Show>
    </div>
  );
}
/** hover handlers for one mark */
export function hover(tip: ReturnType<typeof useTip>, content: () => JSX.Element) {
  return { onMouseMove: (e: MouseEvent) => tip.show(e, content()), onMouseLeave: () => tip.hide() };
}

// ───────────── x for values over time

export interface XS { kind: XKind; pos: (i: number) => number; ticks: { x: number; label: string }[]; label: (i: number) => string; n: number }
/**
 * Positions for x values (numbers, ISO dates or labels) across [x0, x1], with
 * tick labels thinned so none overlap.
 */
export function makeX(xs: (string | number)[], x0: number, x1: number, opt: { pad?: number } = {}): XS {
  const kind = xKind(xs);
  const n = xs.length;
  const pad = opt.pad ?? 0;
  const lab = (i: number) => xLabel(xs[i], kind);
  if (kind === "cat" || n < 2) {
    const step = n > 1 ? (x1 - x0 - 2 * pad) / (n - 1) : 0;
    const pos = (i: number) => (n > 1 ? x0 + pad + i * step : (x0 + x1) / 2);
    const labels = xs.map((x) => String(x));
    const all = labels.map((l, i) => ({ x: pos(i), label: l }));
    const keep = thin(all.map((t) => t.x), all.map((t) => tw(t.label, AX)), 10);
    return { kind, pos, ticks: keep.map((k) => all[k]), label: lab, n };
  }
  const vals = kind === "time" ? xs.map((x) => parseTime(x)!) : (xs as number[]);
  const ext = extent(vals) ?? [0, 1];
  const span = ext[1] - ext[0] || 1;
  if (kind === "time") {
    const s = scaleUtc().domain([new Date(ext[0]), new Date(ext[1])]).range([x0 + pad, x1 - pad]);
    const count = Math.max(4, Math.floor((x1 - x0) / 70));
    const raw = s.ticks(count).map((d) => ({ x: s(d), label: fmtTime(+d, span) }));
    // drop repeated labels ("3월" twice) and those that would collide
    const uniq = raw.filter((t, i) => i === 0 || t.label !== raw[i - 1].label);
    const keep = thin(uniq.map((t) => t.x), uniq.map((t) => tw(t.label, AX)), 10);
    return { kind, pos: (i) => s(new Date(vals[i])), ticks: keep.map((k) => uniq[k]).filter((t) => t.x >= x0 - 1 && t.x <= x1 + 1), label: lab, n };
  }
  const s = scaleLinear().domain(ext).range([x0 + pad, x1 - pad]);
  const raw = s.ticks(Math.max(2, Math.floor((x1 - x0) / 70))).map((v) => ({ x: s(v), label: compact(v) }));
  const keep = thin(raw.map((t) => t.x), raw.map((t) => tw(t.label, AX)), 10);
  return { kind, pos: (i) => s(vals[i]), ticks: keep.map((k) => raw[k]), label: lab, n };
}
/** labels under the plot, clamped so the first and last stay inside the frame */
export function XTicks(props: { ticks: { x: number; label: string }[]; y: number; w: number; grid?: { y0: number; y1: number } }) {
  return (
    <g class="viz-axis">
      <For each={props.ticks}>
        {(t) => {
          const half = tw(t.label, AX) / 2 + 2;
          const x = clamp(t.x, half, props.w - half);
          return (
            <>
              <Show when={props.grid}><line class="viz-grid" x1={t.x} x2={t.x} y1={props.grid!.y0} y2={props.grid!.y1} /></Show>
              <text x={x} y={props.y} text-anchor="middle">{t.label}</text>
            </>
          );
        }}
      </For>
    </g>
  );
}

// ───────────── y (values)

export interface YS { s: (v: number) => number; ticks: number[]; fmt: (v: number) => string; width: number; log: boolean }
/** a value scale from lo..hi onto [y1 (bottom), y0 (top)], with tick labels and their width */
export function makeY(dom: [number, number], y0: number, y1: number, opt: { log?: boolean; unit?: string; fmt?: (v: number) => string; count?: number } = {}): YS {
  const count = opt.count ?? clamp(Math.floor((y1 - y0) / 44), 2, 7);
  const fmt = opt.fmt ?? ((v: number) => (opt.unit === "%" ? `${compact(v)}%` : compact(v)));
  if (opt.log && dom[0] > 0) {
    const s = scaleLog().domain(dom).range([y1, y0]).nice();
    let ticks = s.ticks(count).filter((t) => /^[125]/.test(String(t / 10 ** Math.floor(Math.log10(t)))));
    if (ticks.length > count + 1) ticks = ticks.filter((t) => /^1/.test(String(t / 10 ** Math.floor(Math.log10(t)))));
    return { s: (v) => s(v), ticks, fmt, width: Math.max(0, ...ticks.map((t) => tw(fmt(t), AX))), log: true };
  }
  const s = scaleLinear().domain(dom).range([y1, y0]).nice(count);
  const ticks = s.ticks(count);
  return { s: (v) => s(v), ticks, fmt, width: Math.max(0, ...ticks.map((t) => tw(fmt(t), AX))), log: false };
}
/** horizontal gridlines and their labels at the left (or right) of the plot */
export function YGrid(props: { y: YS; x0: number; x1: number; side?: "left" | "right" | "none"; zero?: boolean }) {
  return (
    <g class="viz-axis">
      <For each={props.y.ticks}>
        {(t) => (
          <>
            <line class={t === 0 && props.zero !== false ? "viz-base" : "viz-grid"} x1={props.x0} x2={props.x1} y1={Math.round(props.y.s(t)) + 0.5} y2={Math.round(props.y.s(t)) + 0.5} />
            <Show when={props.side !== "none"}>
              <text x={props.side === "right" ? props.x1 + 6 : props.x0 - 6} y={props.y.s(t)} dy="0.32em" text-anchor={props.side === "right" ? "start" : "end"}>{props.y.fmt(t)}</text>
            </Show>
          </>
        )}
      </For>
    </g>
  );
}

// ───────────── crosshair

export interface CrossPoint { x: number; y: number; color: string }
/**
 * Hover layer for line and area charts: a hairline snaps to the nearest x, dots
 * mark every series there and one tooltip lists them all.
 */
export function Crosshair(props: { b: Box; n: number; pos: (i: number) => number; points: (i: number) => CrossPoint[]; tip: (i: number) => JSX.Element }) {
  const tip = useTip();
  const [at, setAt] = createSignal<number | null>(null);
  const move = (e: MouseEvent) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let best = 0, d = Infinity;
    for (let i = 0; i < props.n; i++) {
      const dd = Math.abs(props.pos(i) - mx);
      if (dd < d) (d = dd), (best = i);
    }
    setAt(best);
    tip.show(e, props.tip(best));
  };
  return (
    <g class="ch-cross">
      <Show when={at() !== null}>
        <line class="ch-cross-line" x1={props.pos(at()!)} x2={props.pos(at()!)} y1={props.b.y0} y2={props.b.y0 + props.b.ih} />
        <For each={props.points(at()!)}>{(p) => <circle class="ch-dot" cx={p.x} cy={p.y} r={4} fill={p.color} />}</For>
      </Show>
      <rect x={props.b.x0 - 8} y={props.b.y0} width={props.b.iw + 16} height={props.b.ih} fill="transparent" onMouseMove={move} onMouseLeave={() => (setAt(null), tip.hide())} />
    </g>
  );
}

// ───────────── category axis for bars

export interface BandLabels { rotate: boolean; labels: string[]; height: number; keep: Set<number> }
/**
 * Labels for a band of categories `step` px apart: flat when they fit, else
 * turned 40° and cut, thinned only as a last resort. `height` is the room below.
 */
export function bandLabels(raw: string[], step: number, maxRotLen = 110, left = Infinity): BandLabels {
  const ws = raw.map((s) => tw(s, AX));
  if (ws.every((w) => w <= step - 6)) return { rotate: false, labels: raw, height: 20, keep: new Set(raw.map((_, i) => i)) };
  // flat but cut: fine while labels keep 3 characters or more
  const flat = raw.map((s) => cut(s, step - 6, AX));
  if (step >= 44 && flat.every((s) => [...s].length >= 4 || s === raw[flat.indexOf(s)])) return { rotate: false, labels: flat, height: 20, keep: new Set(raw.map((_, i) => i)) };
  // a turned label reaches left by cos 40° of its length: the first ones must stay inside
  const labels = raw.map((s, i) => cut(s, Math.min(maxRotLen, (left + i * step) / Math.cos((40 * Math.PI) / 180) - 4), AX));
  const height = Math.min(maxRotLen, Math.max(0, ...labels.map((s) => tw(s, AX)))) * Math.sin((40 * Math.PI) / 180) + 26;
  // a turned label needs ~15px across; thin when the band is tighter
  const k = Math.max(1, Math.ceil(15 / Math.max(1, step)));
  const keep = new Set(raw.map((_, i) => i).filter((i) => i % k === 0));
  return { rotate: true, labels, height, keep };
}
export function BandTicks(props: { bl: BandLabels; pos: (i: number) => number; y: number }) {
  return (
    <g class="viz-axis">
      <For each={props.bl.labels}>
        {(l, i) => (
          <Show when={props.bl.keep.has(i())}>
            <Show when={props.bl.rotate} fallback={<text x={props.pos(i())} y={props.y + 4} text-anchor="middle">{l}</text>}>
              <text transform={`translate(${props.pos(i()) + 4},${props.y + 2}) rotate(-40)`} text-anchor="end">{l}</text>
            </Show>
          </Show>
        )}
      </For>
    </g>
  );
}

/** a value label beside or inside a mark, in ink */
export const Val = (p: { x: number; y: number; text: string; anchor?: "start" | "middle" | "end"; class?: string }) => (
  <text class={`ch-val ${p.class ?? ""}`} x={p.x} y={p.y} text-anchor={p.anchor ?? "middle"} dy="0.32em">{p.text}</text>
);

/** a small up/down triangle (no glyphs), coloured by tone */
export function Arrow(props: { dir: "up" | "down" | "flat"; size?: number }) {
  const s = () => props.size ?? 9;
  return (
    <svg class="ch-arrow" width={s()} height={s()} viewBox="0 0 10 10" aria-hidden="true">
      <Show when={props.dir !== "flat"} fallback={<rect x="1" y="4" width="8" height="2" rx="1" />}>
        <path d={props.dir === "up" ? "M5 1.2 L9.2 8.6 H0.8 Z" : "M5 8.8 L9.2 1.4 H0.8 Z"} stroke-linejoin="round" />
      </Show>
    </svg>
  );
}

/** a tiny line for tables and tiles; the last point is marked */
export function Spark(props: { values: (number | null)[]; w?: number; h?: number; color?: string; dot?: string; area?: boolean; band?: [number, number] }) {
  const w = () => props.w ?? 96;
  const h = () => props.h ?? 26;
  const pts = () => {
    const v = props.values;
    const ext = extent(v) ?? [0, 1];
    const lo = props.band ? Math.min(props.band[0], ext[0]) : ext[0];
    const hi = props.band ? Math.max(props.band[1], ext[1]) : ext[1];
    const span = hi - lo || 1;
    const n = Math.max(1, v.length - 1);
    return v.map((y, i) => (y === null ? null : ([2 + (i / n) * (w() - 6), h() - 3 - ((y - lo) / span) * (h() - 6)] as const)));
  };
  const d = () => {
    let s = "", pen = false;
    for (const p of pts()) {
      if (!p) { pen = false; continue; }
      s += `${pen ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      pen = true;
    }
    return s;
  };
  const last = () => [...pts()].reverse().find((p) => p) ?? null;
  const first = () => pts().find((p) => p) ?? null;
  return (
    <svg class="ch-spark" width={w()} height={h()} viewBox={`0 0 ${w()} ${h()}`} aria-hidden="true">
      <Show when={props.area && first() && last()}>
        <path d={`${d()} L${last()![0]} ${h()} L${first()![0]} ${h()} Z`} fill={props.color ?? "var(--viz-1)"} opacity="0.1" />
      </Show>
      <path d={d()} fill="none" stroke={props.color ?? "var(--viz-1)"} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
      <Show when={last()}><circle cx={last()![0]} cy={last()![1]} r="2.8" fill={props.dot ?? props.color ?? "var(--viz-1)"} /></Show>
    </svg>
  );
}
