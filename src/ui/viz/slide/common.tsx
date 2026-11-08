// Parts the slide figures share: the card, state tags, check/cross marks,
// Harvey balls, status dots and a text measure for SVG labels.
import { For, Show, type JSX } from "solid-js";
import { textW } from "../../Charts";
import { Icon } from "../../Icon";
import { status as STATUS } from "../kit";
import { t } from "../../../i18n";
import type { Measure, State, Status } from "./util";

/** canvas text width in the app font (falls back to an estimate before fonts load) */
export const measure: Measure = (s, size, weight = 500) => textW(s, size, weight);

/** the card every HTML-laid figure sits in (charts drawn in SVG use the kit's Frame) */
export function Card(props: { label?: string; class: string; children: JSX.Element; aside?: JSX.Element; legend?: { label: string; color: string }[] }) {
  return (
    <div class={`blk viz sl ${props.class}`}>
      <Show when={props.label || props.aside || (props.legend && props.legend.length > 1)}>
        <div class="viz-head">
          <Show when={props.label}><div class="blk-label">{props.label}</div></Show>
          <Show when={props.legend && props.legend.length > 1}>
            <ul class="viz-legend"><For each={props.legend}>{(l) => <li><i style={{ "--c": l.color }} />{l.label}</li>}</For></ul>
          </Show>
          {props.aside}
        </div>
      </Show>
      {props.children}
    </div>
  );
}

export const STATE_WORD: Record<State, string> = { done: "완료", now: "진행 중|state", todo: "예정", new: "새로", changed: "바뀜", gone: "없앰", off: "안 씀", risk: "위험|state", late: "지연" };
/** a state as a word in a soft chip (colour is never the only cue) */
export const Tag = (p: { state?: State }) => (
  <Show when={p.state}>
    <span class={`sl-tag t-${p.state}`}>{t(STATE_WORD[p.state!])}</span>
  </Show>
);

export const STATUS_WORD: Record<Status, string> = { good: "달성", warn: "주의", bad: "미달" };
const STATUS_ICON: Record<Status, string> = { good: "check", warn: "minus", bad: "x" };
/** a status as a filled dot with its glyph and word */
export const StatusMark = (p: { s: Status; word?: string; bare?: boolean }) => (
  <span class={`sl-status s-${p.s}`}>
    <i style={{ background: STATUS[p.s === "warn" ? "warn" : p.s] }}><Icon name={STATUS_ICON[p.s]} size={9} stroke={3.5} /></i>
    <Show when={!p.bare}>{p.word ?? t(STATUS_WORD[p.s])}</Show>
  </span>
);

/** supported / not / partly, as icons (never emoji) */
export function Mark(p: { k: "yes" | "no" | "part" }) {
  return (
    <span class={`sl-mark m-${p.k}`} aria-label={p.k === "yes" ? t("지원") : p.k === "no" ? t("미지원") : t("일부")} role="img">
      <Show when={p.k === "part"} fallback={<Icon name={p.k === "yes" ? "check" : "x"} size={12} stroke={3} />}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M6 1a5 5 0 0 1 0 10z" fill="currentColor" /></svg>
      </Show>
    </span>
  );
}

/** a Harvey ball, 0–4 quarters filled */
export function Harvey(p: { q: number; size?: number }) {
  const s = () => p.size ?? 16;
  const r = () => s() / 2 - 1.2;
  const path = () => {
    const c = s() / 2, a = (p.q / 4) * Math.PI * 2 - Math.PI / 2;
    if (p.q >= 4) return "";
    return `M${c} ${c}L${c} ${c - r()}A${r()} ${r()} 0 ${p.q > 2 ? 1 : 0} 1 ${c + r() * Math.cos(a)} ${c + r() * Math.sin(a)}Z`;
  };
  return (
    <svg class="sl-harvey" width={s()} height={s()} viewBox={`0 0 ${s()} ${s()}`} role="img" aria-label={`${p.q}/4`}>
      <circle cx={s() / 2} cy={s() / 2} r={r()} class="hb-ring" />
      <Show when={p.q >= 4} fallback={<Show when={p.q > 0}><path d={path()} class="hb-fill" /></Show>}>
        <circle cx={s() / 2} cy={s() / 2} r={r()} class="hb-fill" />
      </Show>
    </svg>
  );
}

/** two-letter initials for an avatar ("김하린" → "하린", "Jane Doe" → "JD") */
export function initials(name: string): string {
  const t = name.trim();
  if (/^[가-힯]+$/.test(t)) return t.length >= 3 ? t.slice(1, 3) : t;
  const parts = t.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : t.slice(0, 2)).toUpperCase();
}
