// Small parts the relation family shares: measured text, a crash-proof wrapper,
// hover-tip helpers and the colour-ramp legend under maps and matrices.
import { ErrorBoundary, For, Show, type JSX } from "solid-js";
import { textW } from "../../Charts";
import { compact, num, seq, div, withUnit } from "../kit";
import { ellipsize } from "./layout/text";

/** label sizes inside relation figures (px) */
export const FS = 12;
export const FS_SM = 11;
export const tw = (s: string, size = FS, weight = 400) => textW(s, size, weight);
/** fit `s` into `max` px (ellipsis), measured with the real font */
export const fit = (s: string, max: number, size = FS, weight = 400) => ellipsize(s, max, (t) => textW(t, size, weight));

/** a value with its unit, compact for big numbers */
export const val = (v: number | undefined, unit?: string) => (v === undefined ? "–" : withUnit(Math.abs(v) >= 1e4 ? compact(v) : num(v), unit));

/** never let a bad block take the chat down: draw nothing instead */
export function Safe(props: { label?: string; children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(err) => {
        console.warn("viz: could not draw block", err);
        return <Empty label={props.label} />;
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
export function Empty(props: { label?: string }) {
  return (
    <div class="blk viz rl-empty">
      <Show when={props.label}><div class="blk-label">{props.label}</div></Show>
      <div class="rl-empty-line">표시할 데이터가 없어요</div>
    </div>
  );
}

/** text set inside a categorical fill: white, near-black on light-mode yellow (slot 4) and "other" grey */
export const onFill = (slot: number) => `rl-on${slot === 3 ? " k4" : slot >= 8 || slot < 0 ? " ko" : ""}`;
/** text set inside a sequential fill */
export const onSeq = (t: number) => (t >= 0.5 ? "rl-on-hi" : "rl-on-lo");

/** a stepped colour-ramp legend (sequential or diverging) with end labels */
export function Ramp(props: { min: number; max: number; unit?: string; diverging?: boolean; label?: string; noData?: boolean }) {
  const steps = () => (props.diverging ? [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].map((t) => div(t)) : [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1].map((t) => seq(t)));
  return (
    <div class="rl-ramp">
      <span class="rl-ramp-v">{val(props.min, props.unit)}</span>
      <span class="rl-ramp-bar">
        <For each={steps()}>{(c) => <i style={{ background: c }} />}</For>
      </span>
      <span class="rl-ramp-v">{val(props.max, props.unit)}</span>
      <Show when={props.noData}>
        <span class="rl-ramp-nd"><i />자료 없음</span>
      </Show>
    </div>
  );
}

/** the legend entries for categorical slots (the kit's legend shows only for 2+) */
export const legendOf = (names: string[], color: (i: number) => string) => names.map((label, i) => ({ label, color: color(i) }));
