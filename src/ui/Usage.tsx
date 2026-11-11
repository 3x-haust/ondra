// What a turn cost and how much of the plan is left, kept right in the chat.
import { openPanel } from "../state/ui";
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { AccountPicker } from "./AccountPicker";
import { creditsOf, loadEmail, refreshLimits, usageOf, windowLabel } from "../state/limits";
import { ctx, pctText, reusePct } from "../state/ctx";
import { Icon } from "./Icon";
import type { Permission, Usage } from "../state/types";
import { ctxShare, tokens, now } from "./bits";
import { state, taskById } from "../state/store";
import { ContextSheet } from "../views/Context";
import { t } from "../i18n";

/** no login yet: no limits to show (numbers kept from before would say otherwise) */
const limitsShown = (id: string) => (state.accounts.find((a) => a.id === id)?.providers.length ? usageOf(id, now()) : []);

const promptOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

const secs = (ms: number) => {
  if (ms < 60_000) return t("{s}초", { s: (ms / 1000).toFixed(1) });
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? t("{m}분 {s}초", { m, s }) : t("{m}분", { m });
};

/** One quiet line under an answer (shown on hover): speed, cache hit, time, tokens; plan windows in its tooltip. */
export function UsageLine(props: { u: Usage; lead?: string }) {
  const detail = () =>
    [
      `${t("입력 {n}", { n: tokens(promptOf(props.u)) })} (${[t("새로 {n}", { n: tokens(props.u.input) }), t("캐시 {n}", { n: tokens(props.u.cacheRead) }), ...(props.u.cacheWrite ? [t("캐시 저장 {n}", { n: tokens(props.u.cacheWrite) })] : [])].join(" · ")})`,
      t("출력 {n}", { n: tokens(props.u.output) }),
      ...(props.u.limits ?? []).map((l) => `${windowLabel(l.window)} ${l.used}%`),
    ].join(" · ");
  return (
    <div class="usage-line" title={detail()}>
      <Show when={props.lead}><span>{props.lead}</span></Show>
      <Show when={props.u.tps}><span>{t("초당 {n}토큰", { n: props.u.tps! })}</span></Show>
      <Show when={promptOf(props.u)}>
        <span class="usage-cache" title={t("캐시 적중률")}>{t("캐시 {p}%", { p: pctText((props.u.cacheRead / promptOf(props.u)) * 100) })}</span>
      </Show>
      <Show when={props.u.ms}><span>{secs(props.u.ms!)}</span></Show>
      <span>{t("입력 {n}", { n: tokens(promptOf(props.u)) })}</span>
      <span>{t("출력 {n}", { n: tokens(props.u.output) })}</span>
    </div>
  );
}

/** how full a plan window gets before the line under the input names it (%) */
const NEAR = 80;

const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return t("{m}분", { m });
  const h = Math.round(m / 60);
  return h < 48 ? t("{n}시간", { n: h }) : t("{n}일", { n: Math.round(h / 24) });
};

/** Live plan windows for an account, under the input. */
export function LimitBar(props: { accountId: string }) {
  onMount(() => void refreshLimits(props.accountId));
  const list = () => limitsShown(props.accountId);
  return (
    <Show when={list().length}>
      <div class="limit-bar">
        <For each={list()}>
          {(l) => (
            <span class="limit" classList={{ hot: l.used >= 80 && !creditsOf(props.accountId) }} title={l.resetsAt ? t("{t} 후 초기화", { t: left(l.resetsAt - Date.now()) }) : undefined}>
              <span class="limit-name">{windowLabel(l.window)}</span>
              <span class="limit-track"><i style={{ width: `${Math.min(100, l.used)}%` }} /></span>
              <span class="limit-num">{Math.round(l.used)}%</span>
              <Show when={l.resetsAt}><span class="limit-reset">{t("{t} 후", { t: left(l.resetsAt! - Date.now()) })}</span></Show>
            </span>
          )}
        </For>
        <Show when={creditsOf(props.accountId)}>
          {(c) => <span class="limit limit-credits" title={t("요금제 한도 이후 사용")}><span class="limit-name">{t("크레딧")}</span><span class="limit-num">{c()}</span></span>}
        </Show>
      </div>
    </Show>
  );
}

/**
 * The status line under an input, like a terminal agent's footer:
 * account · plan windows · context used · permission · shells · branch.
 */
export function StatusLine(props: { lead?: JSX.Element; accountId: string; space?: string; onAccount?: (id: string) => void; running?: boolean; agent?: string; permission?: Permission; shells?: number; branch?: string; onCompact?: () => void; last?: Usage }) {
  onMount(() => {
    void refreshLimits(props.accountId);
    void loadEmail(props.accountId);
  });
  // every plan window shows how much of it is used; near its cap it turns the warning colour
  const list = () => limitsShown(props.accountId);
  // credits matter once a window is used up (they're what the work runs on then), or when there is no window
  const showCredits = () => !!creditsOf(props.accountId) && (!limitsShown(props.accountId).length || list().some((l) => l.used >= 100));
  // the one source for how full the context is: the strip, its tooltip and the sheet all read it
  // a task that hasn't started has no context of its own yet (whatever a kept number says)
  const notStarted = () => {
    const tk = props.agent?.startsWith("t:") ? taskById(props.agent.slice(2)) : undefined;
    return tk?.status === "queued" && !tk.startedAt;
  };
  const c = () => (props.agent && !notStarted() ? ctx[props.agent] : undefined);
  const [ctxOpen, setCtxOpen] = createSignal(false);
  // with no account and nothing measured yet there is nothing to show: no empty strip
  const any = () => !!props.lead || !!state.accounts.some((a) => a.id === props.accountId) || !!c() || !!props.shells || !!props.branch;
  // one line, never cut: when it doesn't fit, whole items go, least needed first
  let line: HTMLDivElement | undefined;
  const fit = () => {
    const el = line;
    if (!el || !el.isConnected) return;
    el.classList.add("st-measure");
    el.querySelectorAll(".st-drop").forEach((x) => x.classList.remove("st-drop"));
    const over = () => el.scrollWidth > el.clientWidth + 1;
    const drop = (sel: string, one = false) => {
      const xs = [...el.querySelectorAll(sel)].reverse();
      for (const x of xs) {
        if (!over()) return;
        x.classList.add("st-drop");
        if (!one) xs.forEach((y) => y.classList.add("st-drop"));
      }
    };
    // a plan window goes whole ("주간 100% 사용"), never just its word; the one furthest from
    // its limit first, so the window that is (nearly) used up is the last to go
    for (const sel of [".st-br", ".st-sh", ".st-cache", ".st-credits"]) drop(sel);
    const wins = [...el.querySelectorAll<HTMLElement>(".st-lim:not(.st-credits)")].sort((a, b) => Number(a.dataset.used) - Number(b.dataset.used));
    for (const x of wins) {
      if (!over()) break;
      x.classList.add("st-drop");
    }
    el.classList.remove("st-measure");
  };
  const watch = (el: HTMLDivElement) => {
    line = el;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const mo = new MutationObserver(fit);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    queueMicrotask(fit);
    onCleanup(() => (ro.disconnect(), mo.disconnect()));
  };
  return (
    <Show when={any()}>
    <div class="status-line" ref={watch}>
      {props.lead}
      <Show when={state.accounts.find((a) => a.id === props.accountId)}>
        {(a) => <AccountPicker accountId={a().id} space={props.space ?? a().space} onPick={props.onAccount} running={props.running} />}
      </Show>
      <For each={list()}>
        {(l) => (
          <span class="st-lim" classList={{ hot: l.used >= NEAR }} data-used={l.used} title={l.resetsAt ? t("{t} 후 초기화", { t: left(l.resetsAt - Date.now()) }) : undefined}>
            {l.used >= 100 ? t("{w} 한도 다 씀", { w: windowLabel(l.window) }) : t("{w} 한도 {n}%", { w: windowLabel(l.window), n: Math.round(l.used) })}
          </span>
        )}
      </For>
      <Show when={showCredits() && creditsOf(props.accountId)}>
        {(c) => <span class="st-lim st-credits" title={t("요금제 한도 이후 사용")}>{t("크레딧 {n}|left", { n: Number.isFinite(Number(c())) ? Number(c()) : c() })}</span>}
      </Show>
      {/* nothing measured yet (a queued task, a chat before its first word): no context item */}
      <Show when={props.agent ? c() : undefined}>
        {(x) => (
          <button
            class="st-ctx"
            classList={{ hot: !!x().window && x().tokens / x().window >= 0.7 }}
            title={t("컨텍스트 {a} / {b}", { a: tokens(x().tokens), b: tokens(x().window) })}
            aria-label={t("컨텍스트 {a} / {b}", { a: tokens(x().tokens), b: tokens(x().window) })}
            onClick={() => setCtxOpen(true)}
          >
            {t("컨텍스트 {p}", { p: ctxShare(x().tokens, x().window) })}
          </button>
        )}
      </Show>
      <Show when={props.agent}>
        <Show when={ctxOpen()}>
          <ContextSheet agent={props.agent!} accountId={props.accountId} onClose={() => setCtxOpen(false)} />
        </Show>
      </Show>
      <Show when={props.agent && reusePct(props.agent) !== undefined}>
        <span class="st-cache" classList={{ low: reusePct(props.agent!)! < 90 }} title={t("캐시 적중률")}>
          {t("캐시 {p}%", { p: pctText(reusePct(props.agent!)!) })}
        </span>
      </Show>
      <Show when={props.shells}>
        <button class="st-sh" title={t("터미널 보기")} onClick={() => openPanel("terminal")}>{t("터미널 {n}", { n: props.shells! })}</button>
      </Show>
      <Show when={props.branch}><span class="st-br" title={t("브랜치")}><Icon name="branch" size={12} />{props.branch}</span></Show>
    </div>
    </Show>
  );
}

/**
 * There is no ring beside the model any more: the status line under the input
 * already says how full the context is (and opens the sheet). Renders nothing so
 * the task view's call still compiles; drop it there and this can go.
 */


