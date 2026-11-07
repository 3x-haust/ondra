// The bar engine the comparison charts share: categories along a band, bars
// (grouped slots or stacked segments) growing from one baseline, optional lines
// on the same value axis, value labels that only appear where they fit, and a
// per-category tooltip. Vertical or horizontal.
import { For, Show, type JSX } from "solid-js";
import { line } from "d3-shape";
import { useTip } from "../kit";
import { barPath, clamp, extent, valueDomain } from "./math";
import { AX, bandLabels, BandTicks, box, ChFrame, cut, FS, hover, inkOn, makeY, TipBody, tw, Val, YGrid, type TipRow } from "./common";
import { scaleLinear } from "d3-scale";

export interface Seg {
  cat: number;
  /** grouped slot (0 for stacked) */
  slot: number;
  v0: number;
  v1: number;
  color: string;
  /** label printed inside the segment when it fits */
  inside?: string;
  /** is this segment the end of its bar (gets the rounded end) */
  end?: boolean;
}
export interface BandLine { label: string; values: (number | null)[]; color: string; dash?: boolean }

export function BandPlot(props: {
  label?: string;
  class?: string;
  cats: string[];
  segs: Seg[];
  slots: number;
  orient: "v" | "h";
  legend?: { label: string; color: string; dash?: boolean }[];
  /** value labels at bar ends: one per (cat, slot) */
  ends?: { cat: number; slot: number; text: string; at: number; below?: boolean }[];
  lines?: BandLine[];
  /** a second scale on the right drawn 0–100% (pareto only) */
  right?: { values: (number | null)[]; color: string; label: string; rule?: number };
  domain?: [number, number];
  fmt?: (v: number) => string;
  unit?: string;
  /** a reference rule across the plot */
  rule?: { value: number; label: string };
  connectors?: boolean;
  tip: (cat: number) => { title?: string; rows: TipRow[]; foot?: string };
  /** bar thickness cap */
  thick?: number;
}) {
  const tip = useTip();
  const n = () => props.cats.length;
  const dom = (): [number, number] => {
    if (props.domain) return props.domain;
    const ext = extent([...props.segs.flatMap((s) => [s.v0, s.v1]), ...(props.lines ?? []).flatMap((l) => l.values), ...(props.rule ? [props.rule.value] : [])]);
    return valueDomain(ext, "always");
  };
  const endRoom = () => (props.ends?.length ? Math.max(...props.ends.map((e) => tw(e.text))) + 8 : 0);
  // ── vertical
  const vLayout = (w: number) => {
    const approxX0 = 46, approxX1 = w - (props.right ? 42 : 10);
    const step = (approxX1 - approxX0) / Math.max(1, n());
    return bandLabels(props.cats, step, 110, approxX0 + step / 2);
  };
  // ── horizontal
  const hCat = (w: number) => Math.min(Math.max(0, ...props.cats.map((c) => tw(c))), w * (w < 480 ? 0.3 : 0.26)) + 10;
  const thick = () => props.thick ?? (props.slots > 1 ? 12 : 18);
  const rowH = () => props.slots * thick() + (props.slots - 1) * 2 + 12;
  const height = (w: number) => (props.orient === "v" ? clamp(w * 0.46, 200, 280) + vLayout(w).height : n() * rowH() + 34);
  return (
    <ChFrame label={props.label} class={props.class} height={height} legend={props.legend}>
      {(w, h) => {
        const d = dom();
        if (props.orient === "v") {
          const bl = vLayout(w);
          const top = props.ends?.length ? 22 : 10;
          const bottom = bl.height + 4;
          const y = makeY(d, top, h - bottom, { fmt: props.fmt, unit: props.unit });
          const x0 = Math.ceil(y.width) + 10;
          const rightW = props.right ? tw("100%", AX) + 10 : 0;
          const x1 = w - (props.right ? rightW : 10);
          const b = box(x0, top, x1 - x0, h - top - bottom, w, h);
          const step = b.iw / Math.max(1, n());
          const gw = Math.min(props.slots * thick() * 1.6 + (props.slots - 1) * 2, step * 0.72);
          const bw = clamp((gw - (props.slots - 1) * 2) / props.slots, 2, props.thick ?? 24);
          const realGw = bw * props.slots + (props.slots - 1) * 2;
          const cx = (c: number) => b.x0 + step * (c + 0.5);
          const sx = (c: number, slot: number) => cx(c) - realGw / 2 + slot * (bw + 2);
          const ry = props.right ? scaleLinear().domain([0, 100]).range([b.y0 + b.ih, b.y0]) : null;
          return (
            <>
              <YGrid y={y} x0={b.x0} x1={b.x0 + b.iw} />
              <Show when={ry}>
                <g class="viz-axis">
                  <For each={[0, 20, 40, 60, 80, 100]}>{(t) => <text x={x1 + 6} y={ry!(t)} dy="0.32em">{t}%</text>}</For>
                </g>
              </Show>
              <BandTicks bl={bl} pos={cx} y={h - bl.height + 14} />
              <Show when={props.rule}>
                <line class="ch-target" x1={b.x0} x2={b.x0 + b.iw} y1={y.s(props.rule!.value)} y2={y.s(props.rule!.value)} />
              </Show>
              <For each={props.cats}>
                {(_, c) => (
                  <g class="viz-mark" {...hover(tip, () => <TipBody {...props.tip(c())} />)}>
                    <rect class="ch-hit" x={b.x0 + step * c()} y={b.y0} width={step} height={b.ih} />
                    <For each={props.segs.filter((s) => s.cat === c())}>
                      {(s) => {
                        const ya = y.s(s.v0), yb = y.s(s.v1);
                        const up = s.v1 >= s.v0;
                        const yTop = Math.min(ya, yb), hh = Math.abs(ya - yb);
                        const gap = s.end ? 0 : Math.min(2, hh / 2); // the 2px surface gap between stacked parts
                        const x = sx(c(), s.slot);
                        return (
                          <>
                            <path d={barPath(x, up ? yTop + gap : yTop, bw, Math.max(0, hh - gap), s.end ? (up ? "t" : "b") : "none")} fill={s.color} />
                            <Show when={s.inside && hh > 18 && tw(s.inside!) + 8 < bw}>
                              <text class={inkOn(s.color)} x={x + bw / 2} y={yTop + hh / 2} dy="0.32em" text-anchor="middle">{s.inside}</text>
                            </Show>
                          </>
                        );
                      }}
                    </For>
                  </g>
                )}
              </For>
              <Show when={props.connectors}>
                <For each={props.segs.filter((s) => s.end)}>
                  {(s, k) => {
                    const next = props.segs.filter((t) => t.end)[k() + 1];
                    return <Show when={next}><line class="ch-conn" x1={sx(s.cat, s.slot) + bw} x2={sx(next!.cat, next!.slot)} y1={Math.round(y.s(s.v1)) + 0.5} y2={Math.round(y.s(s.v1)) + 0.5} /></Show>;
                  }}
                </For>
              </Show>
              <For each={props.ends ?? []}>
                {(e) => {
                  const fits = tw(e.text) <= step - 2 || props.slots === 1 && tw(e.text) <= step + 4;
                  const yv = y.s(e.at);
                  const below = e.below ?? e.at < 0;
                  return <Show when={fits}><Val x={sx(e.cat, e.slot) + bw / 2} y={below ? yv + 10 : yv - 9} text={e.text} /></Show>;
                }}
              </For>
              <For each={props.lines ?? []}>
                {(l) => {
                  const d0 = line<number>().defined((i) => l.values[i] !== null).x((i) => cx(i)).y((i) => y.s(l.values[i]!))(l.values.map((_, i) => i)) ?? "";
                  return (
                    <>
                      <path d={d0} class="ch-line" classList={{ dash: !!l.dash }} stroke={l.color} />
                      <For each={l.values}>{(v, i) => <Show when={v !== null}><circle class="ch-dot" cx={cx(i())} cy={y.s(v!)} r={3.5} fill={l.color} /></Show>}</For>
                    </>
                  );
                }}
              </For>
              <Show when={props.right && ry}>
                {(() => {
                  const r = props.right!;
                  const d1 = line<number>().defined((i) => r.values[i] !== null).x((i) => cx(i)).y((i) => ry!(r.values[i]!))(r.values.map((_, i) => i)) ?? "";
                  return (
                    <>
                      <Show when={r.rule !== undefined}>
                        <line class="ch-target" x1={b.x0} x2={b.x0 + b.iw} y1={ry!(r.rule!)} y2={ry!(r.rule!)} />
                      </Show>
                      <path d={d1} class="ch-line" stroke={r.color} />
                      <For each={r.values}>{(v, i) => <Show when={v !== null}><circle class="ch-dot" cx={cx(i())} cy={ry!(v!)} r={3.5} fill={r.color} /></Show>}</For>
                    </>
                  );
                })()}
              </Show>
            </>
          );
        }
        // ── horizontal: categories down the left, values across
        const lw = hCat(w);
        const negRoom = props.ends?.some((e) => e.below ?? e.at < 0) ? endRoom() : 0;
        const x0 = lw + 4 + negRoom;
        const x1 = w - Math.max(10, props.ends?.some((e) => !(e.below ?? e.at < 0)) ? endRoom() : 10);
        const top = 4;
        const bottom = 26;
        const xs = scaleLinear().domain(d).range([x0, x1]);
        if (!props.domain) xs.nice(Math.max(2, Math.floor((x1 - x0) / 80)));
        const fmt = props.fmt ?? ((v: number) => String(v));
        const ticks = xs.ticks(Math.max(2, Math.floor((x1 - x0) / 80)));
        const rh = rowH();
        const ry = (c: number) => top + c * rh + 6;
        const sy = (c: number, slot: number) => ry(c) + slot * (thick() + 2);
        return (
          <>
            <g class="viz-axis">
              <For each={ticks}>
                {(t) => (
                  <>
                    <line class={t === 0 ? "viz-base" : "viz-grid"} x1={Math.round(xs(t)) + 0.5} x2={Math.round(xs(t)) + 0.5} y1={top} y2={h - bottom + 4} />
                    <text x={clamp(xs(t), tw(fmt(t), AX) / 2 + 2, w - tw(fmt(t), AX) / 2 - 2)} y={h - 8} text-anchor="middle">{fmt(t)}</text>
                  </>
                )}
              </For>
            </g>
            <Show when={props.rule}>
              <line class="ch-target" x1={xs(props.rule!.value)} x2={xs(props.rule!.value)} y1={top} y2={h - bottom + 4} />
            </Show>
            <For each={props.cats}>
              {(cat, c) => (
                <g class="viz-mark" {...hover(tip, () => <TipBody {...props.tip(c())} />)}>
                  <rect class="ch-hit" x={0} y={ry(c()) - 6} width={w} height={rh} />
                  <text class="ch-cat" x={lw} y={ry(c()) + (rh - 12) / 2} dy="0.32em" text-anchor="end">{cut(cat, lw - 10)}</text>
                  <For each={props.segs.filter((s) => s.cat === c())}>
                    {(s) => {
                      const xa = xs(s.v0), xb = xs(s.v1);
                      const right = s.v1 >= s.v0;
                      const wd = Math.abs(xb - xa);
                      const gap = s.end ? 0 : Math.min(2, wd / 2);
                      const x = Math.min(xa, xb);
                      return (
                        <>
                          <path d={barPath(x + (!s.end && !right ? gap : 0), sy(c(), s.slot), Math.max(0, wd - gap), thick(), s.end ? (right ? "r" : "l") : "none")} fill={s.color} />
                          <Show when={s.inside && tw(s.inside!) + 10 < wd && thick() >= 14}>
                            <text class={inkOn(s.color)} x={x + wd / 2} y={sy(c(), s.slot) + thick() / 2} dy="0.32em" text-anchor="middle">{s.inside}</text>
                          </Show>
                        </>
                      );
                    }}
                  </For>
                </g>
              )}
            </For>
            <Show when={props.connectors}>
              <For each={props.segs.filter((s) => s.end)}>
                {(s, k) => {
                  const next = props.segs.filter((t) => t.end)[k() + 1];
                  return <Show when={next}><line class="ch-conn" x1={Math.round(xs(s.v1)) + 0.5} x2={Math.round(xs(s.v1)) + 0.5} y1={sy(s.cat, s.slot) + thick()} y2={sy(next!.cat, next!.slot)} /></Show>;
                }}
              </For>
            </Show>
            <For each={props.ends ?? []}>
              {(e) => {
                const left = e.below ?? e.at < 0;
                return <Val x={left ? xs(e.at) - 6 : xs(e.at) + 6} y={sy(e.cat, e.slot) + thick() / 2} text={e.text} anchor={left ? "end" : "start"} />;
              }}
            </For>
          </>
        );
      }}
    </ChFrame>
  );
}

/** vertical unless labels are long or there are many bars */
export function autoOrient(dir: unknown, cats: string[], slots: number): "v" | "h" {
  if (dir === "h" || dir === "horizontal") return "h";
  if (dir === "v" || dir === "vertical") return "v";
  const longest = Math.max(0, ...cats.map((c) => tw(c, FS)));
  return cats.length * slots > 28 || longest > 76 || (cats.length > 8 && longest > 48) ? "h" : "v";
}
export type { JSX };
