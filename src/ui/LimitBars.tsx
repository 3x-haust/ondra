// An account's plan windows the way T3 Code draws usage limits: a rounded bar tinted in
// the service's colour for what is left, faint hatching for what is used, a thin line where
// even spending would be now, the share left inside on the left and when it starts over
// ("⟳ 2일 1시간") on the right.
//   LimitBars  — one bar per window under the account's name (the account picker)
//   LimitCards — a card per window, "96% 남음 ↘" beside a taller bar (Settings › 계정)
import { For, Show } from "solid-js";
import type { Limit } from "../lib/native";
import { elapsedOf, paceOf, windowLabel, type Pace } from "../state/limits";
import { Icon } from "./Icon";
import { t } from "../i18n";
import "./limitBars.css";

/** the bar's colour per service (the brand's own; ChatGPT and Copilot are ink) */
const COLOR: Record<string, string> = { Claude: "#d97757", Gemini: "#8e75b2" };

/** at or under this share left, the bar turns the warning colour (%) */
const LOW = 20;

/** the pace's icon and what it means, with the numbers it comes from ({p}% of the window gone, {u}% used) */
const PACE: Record<Pace, { icon: string; label: string }> = {
  ahead: { icon: "trendUp", label: "빨리 쓰고 있어요: 창은 {p}% 지났는데 {u}%를 썼어요" },
  on: { icon: "gauge", label: "창이 지나는 만큼 쓰고 있어요: {p}% 지났고 {u}%를 썼어요" },
  under: { icon: "trendDown", label: "여유 있게 쓰고 있어요: 창은 {p}% 지났는데 {u}%만 썼어요" },
};

/** "2일 1시간" / "1시간 40분" / "12분": two units, as T3 Code's "2d 1h" */
export function resetsIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return h ? t("{d}일 {h}시간", { d, h }) : t("{n}일", { n: d });
  if (h) return m % 60 ? t("{h}시간 {m}분", { h, m: m % 60 }) : t("{n}시간", { n: h });
  return t("{m}분", { m });
}

/** one window as both views read it */
function view(l: Limit, now: number) {
  const left = Math.round(100 - Math.max(0, Math.min(100, l.used)));
  const e = elapsedOf(l, now);
  // where even spending would be: the share of the window still to run
  const even = e === undefined ? undefined : Math.round((1 - e) * 100);
  const reset = l.resetsAt ? resetsIn(l.resetsAt - now) : "";
  const title = [
    t("{w} {n}% 남음", { w: windowLabel(l.window), n: left }),
    ...(reset ? [t("{t} 후 초기화", { t: reset })] : []),
    ...(even === undefined ? [] : [t("세로선: 고르게 썼다면 지금 {n}% 남아 있을 자리", { n: even })]),
  ].join("\n");
  const pace = paceOf(l, now);
  const paceText = pace && e !== undefined ? t(PACE[pace].label, { p: Math.round(e * 100), u: 100 - left }) : undefined;
  return { left, even, reset, title, pace, paceText, low: left <= LOW };
}

function Bar(p: { v: ReturnType<typeof view> }) {
  return (
    // the app's web view shows no native tooltip: what it means shows in our own (data-tip, limitBars.css)
    <span class="lim-bar" role="img" aria-label={p.v.title} data-tip={p.v.title}>
      <span class="lim-paint">
        <span class="lim-fill" style={{ width: `${p.v.left}%` }} />
        <span class="lim-used" style={{ width: `${100 - p.v.left}%` }} />
      </span>
      <Show when={p.v.even !== undefined}><span class="lim-tick" style={{ left: `clamp(1px, ${p.v.even}%, calc(100% - 1px))` }} /></Show>
      <span class="lim-text">
        <span class="lim-left">{p.v.left > 0 ? `${p.v.left}%` : t("다 씀")}</span>
        <Show when={p.v.reset}><span class="lim-reset"><Icon name="rotate" size={11} stroke={2} />{p.v.reset}</span></Show>
      </span>
    </span>
  );
}

const Credits = (p: { credits?: string }) => (
  <Show when={p.credits}>
    {(c) => (
      <span class="lim-credits" title={t("요금제 한도 이후 사용")}>
        {t("크레딧 {n}|left", { n: Number.isFinite(Number(c())) ? Number(c()) : c() })}
      </span>
    )}
  </Show>
);

const colorOf = (service?: string) => ({ "--lim-color": COLOR[service ?? ""] ?? "var(--ink)" });

export function LimitBars(props: { limits: Limit[]; service?: string; now?: number; credits?: string }) {
  const now = () => props.now ?? Date.now();
  return (
    <Show when={props.limits.length || props.credits}>
      <div class="lim-bars" style={colorOf(props.service)}>
        <For each={props.limits}>
          {(l) => {
            const v = () => view(l, now());
            return (
              <div class="lim-row" classList={{ low: v().low }}>
                <span class="lim-name">{windowLabel(l.window)}</span>
                <Bar v={v()} />
              </div>
            );
          }}
        </For>
        <Credits credits={props.credits} />
      </div>
    </Show>
  );
}

export function LimitCards(props: { limits: Limit[]; service?: string; now?: number; credits?: string }) {
  const now = () => props.now ?? Date.now();
  return (
    <Show when={props.limits.length || props.credits}>
      <div class="lim-cards" style={colorOf(props.service)}>
        <For each={props.limits}>
          {(l) => {
            const v = () => view(l, now());
            return (
              <div class="lim-card" classList={{ low: v().low }}>
                <div class="lim-head">
                  <span class="lim-card-name">{windowLabel(l.window)}</span>
                  {/* the whole "36% 남음 ↗" carries what the pace means, so it shows wherever the pointer rests */}
                  <span class="lim-big" classList={{ explained: !!v().paceText }} data-tip={v().paceText}>
                    <b>{v().left}%</b>
                    {/* the word sits on the number's baseline; the pace icon is centred on the word */}
                    <span class="lim-unit">
                      <span>{t("남음")}</span>
                      <Show when={v().pace}>
                        {(p) => (
                          <span class="lim-pace" classList={{ ahead: p() === "ahead" }} role="img" aria-label={v().paceText}>
                            <Icon name={PACE[p()].icon} size={14} />
                          </span>
                        )}
                      </Show>
                    </span>
                  </span>
                </div>
                <Bar v={v()} />
              </div>
            );
          }}
        </For>
        <Credits credits={props.credits} />
      </div>
    </Show>
  );
}
