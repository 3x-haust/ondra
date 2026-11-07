// Shared drawing parts for the stat family, on top of the kit: a plot with its own
// margins measured from the tick labels (so nothing is clipped at any width),
// numeric and log axes that thin their ticks instead of overlapping, category
// axes that truncate or tilt, dots with a surface ring and a large hit area,
// a nearest-point hover layer for dense plots, and colour-scale keys.
import { scaleBand, scaleLinear, scaleLog } from "d3-scale";
import { Delaunay } from "d3-delaunay";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { textW } from "../../Charts";
import { compact, Frame, num, series, useTip, type Box } from "../kit";
import { clamp, logTicks, thin } from "./math";

/** SVG text sizes: the kit's base size and the small one for dense labels */
export const FS = 13.5;
export const SM = 12;
export const tw = (s: string, size = FS, weight = 400) => (s ? textW(s, size, weight) : 0);
/** the text cut with an ellipsis to fit `px` */
export function ell(s: string, px: number, size = FS): string {
  if (!s) return "";
  if (tw(s, size) <= px) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (tw(s.slice(0, m) + "…", size) <= px) lo = m;
    else hi = m - 1;
  }
  return lo ? s.slice(0, lo).trimEnd() + "…" : "";
}
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const arr = <T = any,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** the colour of series i, the "기타" grey from the 9th on */
export const col = series;

export type Pad = { t?: number; r?: number; b?: number; l?: number };
export interface AxisSpec {
  domain: [number, number];
  log?: boolean;
  title?: string;
  fmt?: (v: number) => string;
  /** round the domain out to nice ticks (linear only) */
  nice?: boolean;
  /** explicit tick values */
  ticks?: number[];
  grid?: boolean;
  /** no tick labels (e.g. embeddings, where the axis has no units) */
  hide?: boolean;
}
type NumScale = ((v: number) => number) & { invert: (v: number) => number };
export interface Ctx {
  w: number; h: number;
  /** plot area */
  x0: number; y0: number; iw: number; ih: number;
  X: NumScale; Y: NumScale;
}

const tickFmt = (s: AxisSpec) => s.fmt ?? ((v: number) => (Math.abs(v) >= 1e4 ? compact(v) : num(v)));
function lin(s: AxisSpec, r: [number, number], count: number) {
  let [a, b] = s.domain;
  if (!Number.isFinite(a) || !Number.isFinite(b)) [a, b] = [0, 1];
  if (a === b) [a, b] = [a - 1, b + 1];
  const sc = scaleLinear().domain([a, b]).range(r);
  if (s.nice !== false && !s.ticks) sc.nice(count);
  return sc;
}
function logS(s: AxisSpec, r: [number, number]) {
  let [a, b] = s.domain;
  if (!(a > 0)) a = 1e-3;
  if (!(b > a)) b = a * 10;
  return scaleLog().domain([a, b]).range(r);
}
function ticksOf(s: AxisSpec, sc: any, count: number): { major: number[]; minor: number[] } {
  if (s.ticks) return { major: s.ticks, minor: [] };
  if (s.log) {
    const [a, b] = sc.domain();
    return logTicks(a, b);
  }
  return { major: sc.ticks(count), minor: [] };
}
/** a tick label centred on x, unless that would run past the figure's edge */
export const edge = (x: number, w: number, W: number) => (x + w / 2 > W ? "end" : x - w / 2 < 0 ? "start" : "middle");
/** 10ⁿ for log axes when the numbers get long */
const sup = (n: number) => String(n).split("").map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[+c] ?? (c === "-" ? "⁻" : c)).join("");
export function logFmt(v: number): string {
  const e = Math.log10(v);
  if (Math.abs(e - Math.round(e)) < 1e-9 && (e >= 5 || e <= -3)) return `10${sup(Math.round(e))}`;
  return v >= 1e4 ? compact(v) : num(v);
}

/** an x scale whose end labels fit inside the figure */
function fitX(xs: AxisSpec, xf: (v: number) => string, w: number, l0: number, r0: number, hide?: boolean) {
  let l = l0, r = r0;
  const make = () => {
    const iw = Math.max(40, w - l - r);
    const count = Math.max(3, Math.floor(iw / 64));
    const sc: any = xs.log ? logS(xs, [l, l + iw]) : lin(xs, [l, l + iw], count);
    return { iw, sc, t: ticksOf(xs, sc, count) };
  };
  let m = make();
  if (!hide && m.t.major.length) {
    const first = m.t.major[0], last = m.t.major[m.t.major.length - 1];
    const needL = tw(xf(first)) / 2 + 2 - (m.sc(first) - l), needR = tw(xf(last)) / 2 + 2 - (l + m.iw - m.sc(last));
    if (needL > l || needR > r) {
      l = Math.max(l, needL);
      r = Math.max(r, needR);
      m = make();
    }
  }
  return { l, r, ...m };
}

/**
 * A chart with numeric x and y. Margins come from the measured tick labels and
 * titles; `left`/`right`/`top`/`bottom` add room for direct labels.
 */
export function Plot(props: {
  label?: string;
  legend?: { label: string; color: string; dash?: boolean }[];
  alt?: string;
  class?: string;
  height?: (w: number) => number;
  x: AxisSpec | ((w: number) => AxisSpec);
  y: AxisSpec | ((w: number) => AxisSpec);
  pad?: Pad | ((w: number) => Pad);
  below?: JSX.Element;
  /** drawn under the axes' gridlines */
  under?: (c: Ctx) => JSX.Element;
  children: (c: Ctx) => JSX.Element;
}) {
  const height = (w: number) => (props.height ? props.height(w) : clamp(Math.round(w * 0.6), 230, 380));
  return (
    <Frame label={props.label} legend={props.legend} alt={props.alt} class={`st ${props.class ?? ""}`} height={height} margin={{ t: 0, r: 0, b: 0, l: 0 }} below={props.below}>
      {(b) => <PlotBody box={b} {...props} />}
    </Frame>
  );
}
function PlotBody(props: { box: Box; x: AxisSpec | ((w: number) => AxisSpec); y: AxisSpec | ((w: number) => AxisSpec); pad?: Pad | ((w: number) => Pad); under?: (c: Ctx) => JSX.Element; children: (c: Ctx) => JSX.Element }) {
  const L = createMemo(() => {
    const { w, h } = props.box;
    const xs = typeof props.x === "function" ? props.x(w) : props.x;
    const ys = typeof props.y === "function" ? props.y(w) : props.y;
    const p = { t: 0, r: 0, b: 0, l: 0, ...(typeof props.pad === "function" ? props.pad(w) : props.pad) };
    const t = 8 + (ys.title ? 20 : 0) + p.t;
    const bm = (xs.hide ? 8 : 28) + (xs.title ? 18 : 0) + p.b;
    const ih = Math.max(40, h - t - bm);
    const yCount = Math.max(3, Math.floor(ih / 38));
    const ysc: any = ys.log ? logS(ys, [t + ih, t]) : lin(ys, [t + ih, t], yCount);
    const yt = ticksOf(ys, ysc, yCount);
    const yf = ys.log ? ys.fmt ?? logFmt : tickFmt(ys);
    const yw = ys.hide ? 0 : Math.max(0, ...yt.major.map((v) => tw(yf(v))));
    let l = Math.max(ys.hide ? 8 : 24, yw + 10) + p.l;
    const xf = xs.log ? xs.fmt ?? logFmt : tickFmt(xs);
    // the end tick labels are centred on the plot's edges: leave room for half of each
    const { l: l2, sc: xsc, t: xt, iw } = fitX(xs, xf, w, l, 12 + p.r, xs.hide);
    l = l2;
    const xw = xt.major.map((v) => tw(xf(v)));
    // a label that would reach into the y labels' column starts at its tick instead of centring on it
    const xa = xt.major.map((v, i) => (xsc(v) - xw[i] / 2 < l - 4 && !ys.hide ? "start" : xsc(v) + xw[i] / 2 > w ? "end" : "middle"));
    const centre = xt.major.map((v, i) => xsc(v) + (xa[i] === "start" ? xw[i] / 2 - 2 : xa[i] === "end" ? -xw[i] / 2 : 0));
    const keep = new Set(thin(centre, xw, 10));
    const ctx: Ctx = { w, h, x0: l, y0: t, iw, ih, X: xsc, Y: ysc };
    return { ctx, xs, ys, xt, yt, xf, yf, keep, xa };
  });
  return (
    <g>
      <Show when={props.under}>{props.under!(L().ctx)}</Show>
      <g class="viz-axis">
        {/* y */}
        <For each={L().yt.major}>
          {(v) => (
            <g transform={`translate(0,${L().ctx.Y(v)})`}>
              <Show when={L().ys.grid !== false}><line class="viz-grid" x1={L().ctx.x0} x2={L().ctx.x0 + L().ctx.iw} /></Show>
              <Show when={!L().ys.hide}><text x={L().ctx.x0 - 6} dy="0.32em" text-anchor="end">{L().yf(v)}</text></Show>
            </g>
          )}
        </For>
        <For each={L().yt.minor}>{(v) => <line class="viz-base" x1={L().ctx.x0 - 3} x2={L().ctx.x0} y1={L().ctx.Y(v)} y2={L().ctx.Y(v)} />}</For>
        {/* x */}
        <For each={L().xt.major}>
          {(v, i) => (
            <g transform={`translate(${L().ctx.X(v)},0)`}>
              <Show when={L().xs.grid}><line class="viz-grid" y1={L().ctx.y0} y2={L().ctx.y0 + L().ctx.ih} /></Show>
              <Show when={!L().xs.hide && L().keep.has(i())}><text x={L().xa[i()] === "start" ? -2 : 0} y={L().ctx.y0 + L().ctx.ih + 19} text-anchor={L().xa[i()]}>{L().xf(v)}</text></Show>
            </g>
          )}
        </For>
        <For each={L().xt.minor}>{(v) => <line class="viz-base" y1={L().ctx.y0 + L().ctx.ih} y2={L().ctx.y0 + L().ctx.ih + 3} x1={L().ctx.X(v)} x2={L().ctx.X(v)} />}</For>
        <line class="viz-base" x1={L().ctx.x0} x2={L().ctx.x0 + L().ctx.iw} y1={L().ctx.y0 + L().ctx.ih} y2={L().ctx.y0 + L().ctx.ih} />
        <line class="viz-base" x1={L().ctx.x0} x2={L().ctx.x0} y1={L().ctx.y0} y2={L().ctx.y0 + L().ctx.ih} />
        <Show when={L().xs.title}><text class="viz-axis-title" x={L().ctx.x0 + L().ctx.iw} y={L().ctx.y0 + L().ctx.ih + (L().xs.hide ? 17 : 38)} text-anchor="end">{ell(L().xs.title!, L().ctx.iw, 11)}</text></Show>
        <Show when={L().ys.title}><text class="viz-axis-title" x={0} y={16} text-anchor="start">{ell(L().ys.title!, L().ctx.w - 10, 11)}</text></Show>
      </g>
      {props.children(L().ctx)}
    </g>
  );
}

/**
 * A plot of rows (one per category) against a numeric x: the category labels sit in
 * a left column as wide as they need, up to 40% of the width, cut with an ellipsis.
 */
export function RowPlot(props: {
  label?: string;
  legend?: { label: string; color: string; dash?: boolean }[];
  alt?: string;
  class?: string;
  rows: string[];
  /** the widest the label column may get, as a share of the width (default 0.4) */
  labelMax?: number;
  /** px per row */
  rowH?: number | ((w: number) => number);
  x: AxisSpec;
  pad?: Pad | ((w: number) => Pad);
  /** labels under each category name (e.g. n = 32) */
  sub?: (i: number) => string | undefined;
  below?: JSX.Element;
  children: (c: Ctx & { band: number; rowY: (i: number) => number }) => JSX.Element;
}) {
  const rh = (w: number) => (typeof props.rowH === "function" ? props.rowH(w) : props.rowH ?? 40);
  const pad = (w: number): Pad => (typeof props.pad === "function" ? props.pad(w) : props.pad ?? {});
  const height = (w: number) => 8 + (pad(w).t ?? 0) + props.rows.length * rh(w) + 28 + (props.x.title ? 18 : 0) + (pad(w).b ?? 0);
  return (
    <Frame label={props.label} legend={props.legend} alt={props.alt} class={`st ${props.class ?? ""}`} height={height} margin={{ t: 0, r: 0, b: 0, l: 0 }} below={props.below}>
      {(b) => {
        const L = createMemo(() => {
          const { w, h } = b;
          const P = pad(w);
          const t = 8 + (P.t ?? 0);
          const ih = Math.max(20, h - t - 28 - (props.x.title ? 18 : 0) - (P.b ?? 0));
          const lw = Math.min(w * (props.labelMax ?? 0.4), Math.max(0, ...props.rows.map((r, i) => Math.max(tw(r), tw(props.sub?.(i) ?? "", SM)))) + 4);
          const xs = props.x;
          const xf = xs.log ? xs.fmt ?? logFmt : tickFmt(xs);
          const { l, sc, t: xt, iw } = fitX(xs, xf, w, Math.max(12, lw + 10) + (P.l ?? 0), 14 + (P.r ?? 0));
          const keep = new Set(thin(xt.major.map((v) => sc(v)), xt.major.map((v) => tw(xf(v))), 10));
          const band = ih / Math.max(1, props.rows.length);
          const Y: any = (v: number) => t + v * band;
          Y.invert = (p: number) => (p - t) / band;
          const ctx = { w, h, x0: l, y0: t, iw, ih, X: sc, Y, band, rowY: (i: number) => t + (i + 0.5) * band };
          return { ctx, xt, xf, keep, lw };
        });
        return (
          <g>
            <g class="viz-axis">
              <For each={L().xt.major}>
                {(v, i) => (
                  <g transform={`translate(${L().ctx.X(v)},0)`}>
                    <line class="viz-grid" y1={L().ctx.y0} y2={L().ctx.y0 + L().ctx.ih} />
                    <Show when={L().keep.has(i())}><text y={L().ctx.y0 + L().ctx.ih + 19} text-anchor={edge(L().ctx.X(v), tw(L().xf(v)), L().ctx.w)}>{L().xf(v)}</text></Show>
                  </g>
                )}
              </For>
              <For each={L().xt.minor}>{(v) => <line class="viz-base" y1={L().ctx.y0 + L().ctx.ih} y2={L().ctx.y0 + L().ctx.ih + 3} x1={L().ctx.X(v)} x2={L().ctx.X(v)} />}</For>
              <line class="viz-base" x1={L().ctx.x0} x2={L().ctx.x0 + L().ctx.iw} y1={L().ctx.y0 + L().ctx.ih} y2={L().ctx.y0 + L().ctx.ih} />
              <Show when={props.x.title}><text class="viz-axis-title" x={L().ctx.x0 + L().ctx.iw} y={L().ctx.y0 + L().ctx.ih + 38} text-anchor="end">{ell(props.x.title!, L().ctx.iw, 11)}</text></Show>
            </g>
            <g class="st-rowlabels">
              <For each={props.rows}>
                {(r, i) => {
                  const sub = () => props.sub?.(i());
                  return (
                    <text x={L().ctx.x0 - 10} y={L().ctx.rowY(i()) + (sub() ? -3 : 0)} dy="0.32em" text-anchor="end">
                      <title>{r}</title>
                      {ell(r, L().lw)}
                      <Show when={sub()}><tspan class="st-sub" x={L().ctx.x0 - 10} dy="1.25em">{ell(sub()!, L().lw, SM)}</tspan></Show>
                    </text>
                  );
                }}
              </For>
            </g>
            {props.children(L().ctx)}
          </g>
        );
      }}
    </Frame>
  );
}

/**
 * Category labels under vertical bands: straight when they fit, else tilted and cut.
 * Returns the extra bottom margin it needs for the given band width.
 */
export function catLayout(cats: string[], band: number): { tilt: boolean; max: number; extra: number } {
  const widest = Math.max(0, ...cats.map((c) => tw(c)));
  if (widest <= band - 6) return { tilt: false, max: band - 6, extra: 0 };
  const max = Math.min(110, Math.max(36, widest));
  if (band >= 26 && widest <= band * 2 - 8) return { tilt: false, max: band - 6, extra: 0 };
  return { tilt: true, max, extra: Math.ceil(max * 0.6) };
}
export function CatAxis(props: { cats: string[]; x: (i: number) => number; y: number; band: number }) {
  const lay = () => catLayout(props.cats, props.band);
  return (
    <g class="viz-axis">
      <For each={props.cats}>
        {(c, i) => (
          <Show
            when={lay().tilt}
            fallback={<text x={props.x(i())} y={props.y + 17} text-anchor="middle"><title>{c}</title>{ell(c, Math.max(props.band - 6, 24))}</text>}
          >
            <text transform={`translate(${props.x(i()) + 4},${props.y + 12}) rotate(-35)`} text-anchor="end"><title>{c}</title>{ell(c, lay().max)}</text>
          </Show>
        )}
      </For>
    </g>
  );
}

/** a band scale over category indices, for vertical groups */
export const bands = (n: number, x0: number, iw: number, pad = 0.3) => scaleBand<number>().domain(Array.from({ length: n }, (_, i) => i)).range([x0, x0 + iw]).paddingInner(pad).paddingOuter(pad / 2);

/** a data dot: filled, with a ring in the surface colour and a 24px hit area */
export function Dot(props: { x: number; y: number; r?: number; color: string; tip?: string; hollow?: boolean; opacity?: number; ring?: boolean }) {
  const tip = useTip();
  return (
    <g class="viz-mark" onMouseMove={(e) => props.tip && tip.show(e, props.tip)} onMouseLeave={tip.hide}>
      <circle cx={props.x} cy={props.y} r={12} fill="transparent" />
      <circle
        cx={props.x} cy={props.y} r={props.r ?? 4}
        style={{ fill: props.hollow ? "var(--viz-gap)" : props.color, stroke: props.hollow ? props.color : "var(--viz-gap)", "stroke-width": props.hollow ? 1.5 : props.ring === false ? 0 : 1.5, "fill-opacity": props.opacity ?? 1 }}
      />
    </g>
  );
}

/**
 * Hover for many marks: the pointer only has to be closest (Delaunay), not on the
 * dot. The hit point gets a ring; its tip shows its text.
 */
export function Nearest(props: { pts: { x: number; y: number; tip: string; color?: string; r?: number }[]; box: { x0: number; y0: number; iw: number; ih: number }; reach?: number }) {
  const tip = useTip();
  const [hit, setHit] = createSignal<number>(-1);
  const del = createMemo(() => Delaunay.from(props.pts, (p) => p.x, (p) => p.y));
  const move = (e: MouseEvent) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (!props.pts.length) return;
    const i = del().find(mx, my);
    const p = props.pts[i];
    if (p && Math.hypot(p.x - mx, p.y - my) <= (props.reach ?? 28)) {
      setHit(i);
      tip.show(e, p.tip);
    } else {
      setHit(-1);
      tip.hide();
    }
  };
  return (
    <g>
      <rect x={props.box.x0 - 8} y={props.box.y0 - 8} width={props.box.iw + 16} height={props.box.ih + 16} fill="transparent" onMouseMove={move} onMouseLeave={() => (setHit(-1), tip.hide())} />
      <Show when={props.pts[hit()]}>
        {(p) => <circle class="st-hit" cx={p().x} cy={p().y} r={(p().r ?? 4) + 3} style={{ stroke: p().color ?? "var(--ink-2)" }} />}
      </Show>
    </g>
  );
}

/**
 * A vertical crosshair that snaps to the nearest x among `xs` (pixel positions) and
 * lists what `read(i)` gives for it.
 */
export function Crosshair(props: { xs: number[]; box: { x0: number; y0: number; iw: number; ih: number }; read: (i: number) => string; dots?: (i: number) => { y: number; color: string }[] }) {
  const tip = useTip();
  const [at, setAt] = createSignal(-1);
  const move = (e: MouseEvent) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const mx = e.clientX - svg.getBoundingClientRect().left;
    let best = -1, bd = Infinity;
    props.xs.forEach((x, i) => {
      const d = Math.abs(x - mx);
      if (d < bd) (bd = d), (best = i);
    });
    setAt(best);
    if (best >= 0) tip.show(e, props.read(best));
  };
  return (
    <g>
      <Show when={at() >= 0}>
        <line class="st-cross" x1={props.xs[at()]} x2={props.xs[at()]} y1={props.box.y0} y2={props.box.y0 + props.box.ih} />
        <For each={props.dots?.(at()) ?? []}>{(d) => <circle cx={props.xs[at()]} cy={d.y} r={4} style={{ fill: d.color, stroke: "var(--viz-gap)", "stroke-width": 2 }} />}</For>
      </Show>
      <rect x={props.box.x0} y={props.box.y0} width={props.box.iw} height={props.box.ih} fill="transparent" onMouseMove={move} onMouseLeave={() => (setAt(-1), tip.hide())} />
    </g>
  );
}

/** a rect mark with its own tip */
export function Cell(props: { x: number; y: number; w: number; h: number; fill: string; tip?: string; rx?: number; opacity?: number }) {
  const tip = useTip();
  return (
    <rect
      class="viz-mark" x={props.x} y={props.y} width={Math.max(0, props.w)} height={Math.max(0, props.h)} rx={props.rx ?? 0}
      style={{ fill: props.fill, "fill-opacity": props.opacity ?? 1 }}
      onMouseMove={(e) => props.tip && tip.show(e, props.tip)} onMouseLeave={tip.hide}
    />
  );
}
/** any mark group with a tip */
export function Tip(props: { tip: string; children: JSX.Element }) {
  const tip = useTip();
  return <g class="viz-mark" onMouseMove={(e) => tip.show(e, props.tip)} onMouseLeave={tip.hide}>{props.children}</g>;
}

/** a key for a continuous colour scale, under the chart */
export function ScaleKey(props: { stops: string[]; lo: string; hi: string; mid?: string; title?: string; after?: string }) {
  return (
    <div class="st-key">
      <Show when={props.title}><span class="st-key-title">{props.title}</span></Show>
      <span class="st-key-v">{props.lo}</span>
      <span class="st-key-bar" style={{ background: `linear-gradient(90deg, ${props.stops.join(", ")})` }} />
      <span class="st-key-v">{props.hi}</span>
      <Show when={props.after}><span class="st-key-after">{props.after}</span></Show>
    </div>
  );
}
export const SEQ_STOPS = [1, 2, 3, 4, 5, 6, 7].map((i) => `var(--viz-seq-${i})`);
export const DIV_STOPS = ["n3", "n2", "n1", "0", "p1", "p2", "p3"].map((k) => `var(--viz-div-${k})`);

/**
 * Text on a ramp fill: white on dark steps, near-black on light ones. The ramps run
 * the other way in dark mode, so the class names the step and the CSS picks per theme.
 */
export const onSeq = (t: number) => `st-on-s${Math.max(1, Math.min(7, Math.round(t * 6) + 1))}`;
export const onDiv = (t: number) => `st-on-d${Math.abs(Math.max(-3, Math.min(3, Math.round(t * 3))))}`;

/** groups of raw values from `series: [{label, values}]`, `values` or `items` */
export function groupsOf(b: any): { label: string; values: number[]; em?: boolean }[] {
  const src = arr(b?.series).length ? arr(b.series) : arr(b?.groups).length ? arr(b.groups) : arr(b?.items).length ? arr(b.items) : null;
  if (src) return src.filter((g) => g && typeof g === "object").map((g: any, i) => ({ label: str(g.label) || `${i + 1}`, values: nums(g.values), em: !!(g.em ?? g.highlight) }));
  const v = nums(b?.values);
  return v.length ? [{ label: str(b?.name) || str(b?.label) || "", values: v }] : [];
}
export const nums = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN)).filter(Number.isFinite) : []);

/** "1.23 ± 0.04" */
export const pm = (m: number, s?: number, d?: number) => (Number.isFinite(s) ? `${fix(m, d)} ± ${fix(s!, d)}` : fix(m, d));
export function fix(v: number, d?: number): string {
  if (!Number.isFinite(v)) return "–";
  if (d !== undefined) return v.toFixed(d);
  return num(v, 3);
}
export const withU = (v: string, unit?: string) => (unit ? (unit === "%" ? `${v}%` : `${v} ${unit}`) : v);

/**
 * A plot of columns (one per category) against a numeric y. Category names sit
 * under the columns, straight when they fit, otherwise tilted and cut.
 */
export function ColPlot(props: {
  label?: string;
  legend?: { label: string; color: string; dash?: boolean }[];
  alt?: string;
  class?: string;
  cats: string[];
  y: AxisSpec;
  height?: (w: number) => number;
  pad?: { t?: number; r?: number; b?: number; l?: number };
  bandPad?: number;
  below?: JSX.Element;
  children: (c: Ctx & { band: number; colX: (i: number) => number }) => JSX.Element;
}) {
  const extraFor = (w: number) => catLayout(props.cats, ((w - 60) / Math.max(1, props.cats.length)) * (1 - (props.bandPad ?? 0.3))).extra;
  const base = (w: number) => (props.height ? props.height(w) : clamp(Math.round(w * 0.55), 230, 360));
  return (
    <Frame label={props.label} legend={props.legend} alt={props.alt} class={`st ${props.class ?? ""}`} height={(w) => base(w) + extraFor(w)} margin={{ t: 0, r: 0, b: 0, l: 0 }} below={props.below}>
      {(b) => {
        const L = createMemo(() => {
          const { w, h } = b;
          const ys = props.y;
          const t = 8 + (ys.title ? 20 : 0) + (props.pad?.t ?? 0);
          const extra = extraFor(w);
          const ih = Math.max(40, h - t - 26 - extra - (props.pad?.b ?? 0));
          const count = Math.max(2, Math.floor(ih / 42));
          const ysc: any = ys.log ? logS(ys, [t + ih, t]) : lin(ys, [t + ih, t], count);
          const yt = ticksOf(ys, ysc, count);
          const yf = ys.log ? ys.fmt ?? logFmt : tickFmt(ys);
          const l = Math.max(24, Math.max(0, ...yt.major.map((v) => tw(yf(v)))) + 10) + (props.pad?.l ?? 0);
          const iw = Math.max(40, w - l - 12 - (props.pad?.r ?? 0));
          const bs = bands(props.cats.length, l, iw, props.bandPad ?? 0.3);
          const X: any = (v: number) => v;
          X.invert = (v: number) => v;
          const ctx = { w, h, x0: l, y0: t, iw, ih, X, Y: ysc, band: bs.bandwidth(), colX: (i: number) => (bs(i) ?? 0) + bs.bandwidth() / 2 };
          return { ctx, yt, yf, ys };
        });
        return (
          <g>
            <g class="viz-axis">
              <For each={L().yt.major}>
                {(v) => (
                  <g transform={`translate(0,${L().ctx.Y(v)})`}>
                    <line class="viz-grid" x1={L().ctx.x0} x2={L().ctx.x0 + L().ctx.iw} />
                    <text x={L().ctx.x0 - 6} dy="0.32em" text-anchor="end">{L().yf(v)}</text>
                  </g>
                )}
              </For>
              <For each={L().yt.minor}>{(v) => <line class="viz-base" x1={L().ctx.x0 - 3} x2={L().ctx.x0} y1={L().ctx.Y(v)} y2={L().ctx.Y(v)} />}</For>
              <line class="viz-base" x1={L().ctx.x0} x2={L().ctx.x0 + L().ctx.iw} y1={L().ctx.y0 + L().ctx.ih} y2={L().ctx.y0 + L().ctx.ih} />
              <Show when={L().ys.title}><text class="viz-axis-title" x={0} y={16} text-anchor="start">{ell(L().ys.title!, L().ctx.w - 10, 11)}</text></Show>
            </g>
            <CatAxis cats={props.cats} x={L().ctx.colX} y={L().ctx.y0 + L().ctx.ih} band={L().ctx.band} />
            {props.children(L().ctx)}
          </g>
        );
      }}
    </Frame>
  );
}

/** reference lines: `refs: [{x | y, label}]`, a thin dashed rule with its name at the end */
export interface Ref { x?: number; y?: number; label?: string }
export const refsOf = (v: unknown): Ref[] => arr<any>(v).filter((r) => r && (Number.isFinite(r.x) || Number.isFinite(r.y))).map((r) => ({ x: Number.isFinite(r.x) ? r.x : undefined, y: Number.isFinite(r.y) ? r.y : undefined, label: str(r.label) }));
export function RefLines(props: { refs: Ref[]; c: Ctx }) {
  const inX = (v: number) => { const p = props.c.X(v); return p >= props.c.x0 - 0.5 && p <= props.c.x0 + props.c.iw + 0.5; };
  const inY = (v: number) => { const p = props.c.Y(v); return p >= props.c.y0 - 0.5 && p <= props.c.y0 + props.c.ih + 0.5; };
  return (
    <g class="st-refs">
      <For each={props.refs}>
        {(r) => (
          <>
            <Show when={r.x !== undefined && inX(r.x)}>
              <line class="st-ref" x1={props.c.X(r.x!)} x2={props.c.X(r.x!)} y1={props.c.y0} y2={props.c.y0 + props.c.ih} />
              <Show when={r.label}>
                <text class="st-dl" x={props.c.X(r.x!) + (props.c.X(r.x!) > props.c.x0 + props.c.iw * 0.75 ? -4 : 4)} y={props.c.y0 + 10} text-anchor={props.c.X(r.x!) > props.c.x0 + props.c.iw * 0.75 ? "end" : "start"}>{ell(r.label!, props.c.iw * 0.45, SM)}</text>
              </Show>
            </Show>
            <Show when={r.y !== undefined && inY(r.y)}>
              <line class="st-ref" x1={props.c.x0} x2={props.c.x0 + props.c.iw} y1={props.c.Y(r.y!)} y2={props.c.Y(r.y!)} />
              <Show when={r.label}><text class="st-dl" x={props.c.x0 + props.c.iw - 2} y={props.c.Y(r.y!) - 5} text-anchor="end">{ell(r.label!, props.c.iw * 0.5, SM)}</text></Show>
            </Show>
          </>
        )}
      </For>
    </g>
  );
}
