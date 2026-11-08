// Small parts the relation family shares: measured text, a crash-proof wrapper,
// hover-tip helpers and the colour-ramp legend under maps and matrices.
import { createSignal, ErrorBoundary, For, Show, type JSX } from "solid-js";
import { textW } from "../../Charts";
import { compact, num, seq, div, withUnit } from "../kit";
import { ellipsize, inkFor, INK_DARK, INK_LIGHT } from "./layout/text";
import { t } from "../../../i18n";

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
      <div class="rl-empty-line">{t("데이터 없음")}</div>
    </div>
  );
}

// the theme can flip at any time; labels inside fills re-pick their ink when it does
const [themeTick, setThemeTick] = createSignal(0);
let watching = false;
function watchTheme() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  const bump = () => setThemeTick((t) => t + 1);
  new MutationObserver(bump).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", bump);
}
const resolve = (css: CSSStyleDeclaration, c: string, depth = 0): string => {
  const m = c.trim().match(/^var\((--[\w-]+)\)$/);
  return m && depth < 4 ? resolve(css, css.getPropertyValue(m[1]), depth + 1) : c.trim();
};
/**
 * Ink for a label inside a fill (any colour or var(--token), at `opacity` over the
 * card): near-black on light fills, white on dark ones, in whichever theme is on.
 */
export function inkOn(fill: string, opacity = 1): string {
  watchTheme();
  themeTick();
  if (typeof document === "undefined") return INK_DARK;
  const css = getComputedStyle(document.documentElement);
  const f = resolve(css, fill);
  const bg = resolve(css, "var(--card)") || "#ffffff";
  return f ? inkFor(f, opacity, bg) : INK_LIGHT;
}
/** style for text inside a fill: the chosen ink, and a halo of the fill itself for edges it overhangs */
export const onFillStyle = (fill: string, opacity = 1, halo = false) => ({ fill: inkOn(fill, opacity), ...(halo ? { stroke: fill, "stroke-opacity": String(opacity) } : {}) });

/**
 * The colour legend under maps and matrices: a stepped ramp with its two ends, or,
 * for classed data, one swatch per class with the class breaks between them.
 */
export function Ramp(props: { min: number; max: number; unit?: string; diverging?: boolean; breaks?: number[]; noData?: boolean }) {
  const steps = () => (props.diverging ? [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].map((t) => div(t)) : [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1].map((t) => seq(t)));
  const classed = () => (props.breaks && props.breaks.length > 2 ? props.breaks : undefined);
  const NoData = () => (
    <Show when={props.noData}>
      <span class="rl-ramp-nd"><i />{t("자료 없음")}</span>
    </Show>
  );
  return (
    <Show
      when={classed()}
      fallback={
        <div class="rl-ramp">
          <span class="rl-ramp-v">{val(props.min, props.unit)}</span>
          <span class="rl-ramp-bar">
            <For each={steps()}>{(c) => <i style={{ background: c }} />}</For>
          </span>
          <span class="rl-ramp-v">{val(props.max, props.unit)}</span>
          <NoData />
        </div>
      }
    >
      {(br) => {
        const k = br().length - 1;
        // break labels at 2 significant digits, more only where that would make two equal
        const digits = [2, 3, 4].find((d) => new Set(br().map((v) => Number(v.toPrecision(d)))).size === br().length) ?? 6;
        const label = (v: number) => val(Number(v.toPrecision(digits)), props.unit);
        return (
          <div class="rl-ramp">
            <span class="rl-cls" style={{ width: `min(100%, ${k * 54 + 44}px)` }}>
              <span class="rl-cls-bar">
                <For each={Array.from({ length: k }, (_, i) => i)}>{(i) => <i style={{ background: seq(k > 1 ? i / (k - 1) : 1) }} />}</For>
              </span>
              <span class="rl-cls-ticks">
                <For each={br()}>
                  {(v, i) => (
                    <span class="rl-ramp-v" style={{ left: `${(i() / k) * 100}%` }}>{label(v)}</span>
                  )}
                </For>
              </span>
            </span>
            <NoData />
          </div>
        );
      }}
    </Show>
  );
}

/** the legend entries for categorical slots (the kit's legend shows only for 2+) */
export const legendOf = (names: string[], color: (i: number) => string) => names.map((label, i) => ({ label, color: color(i) }));
