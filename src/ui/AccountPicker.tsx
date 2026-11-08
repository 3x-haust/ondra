// The account chip under an input: which login this work runs on.
// 자동 = routed (stays where the cache is warm, moves only when a plan window is
// nearly used up). Picking one pins new work in this space to it. A job already
// running keeps its account; switching a job starts its cache fresh, so it's said.
import { createEffect, For, Show } from "solid-js";
import { accountsIn, setState, state } from "../state/store";
import { creditsOf, emails, loadEmail, refreshLimits, usageOf, windowLabel } from "../state/limits";
import { setView } from "../state/ui";
import { Logo } from "./Logos";
import { Icon } from "./Icon";
import { usePop } from "./ModelPicker";
import { t } from "../i18n";

const service = (p: string) => (/anthropic|claude/.test(p) ? "Claude" : /codex|chatgpt|openai/.test(p) ? "ChatGPT" : /gemini|google/.test(p) ? "Gemini" : /copilot/.test(p) ? "Copilot" : p);
const services = (id: string) => [...new Set((state.accounts.find((x) => x.id === id)?.providers ?? []).map(service))];
/** what an account is called: its provider (ChatGPT, Claude), unless it was given a name of its own
 *  (the default name is only the workspace's, "회사 2", which says nothing about the account) */
const nameOf = (id: string) => {
  const x = state.accounts.find((a) => a.id === id);
  if (!x) return "";
  const own = x.label && !state.spaces.some((s) => x.label === s.label || x.label.startsWith(`${s.label} `));
  return own ? x.label : services(id).join(" · ") || t(x.label);
};
/** the windows the provider really has (now usually only the weekly one): "주간 19% 사용" */
const usage = (id: string) =>
  [...usageOf(id).map((l) => t("{w} {n}% 사용", { w: windowLabel(l.window), n: Math.round(l.used) })), ...(creditsOf(id) ? [t("크레딧 {n}", { n: creditsOf(id)! })] : [])].join(" · ");

export function AccountPicker(props: {
  accountId: string;
  space: string;
  /** for a job: switch this job (only when it isn't running); without it the space's pick changes */
  onPick?: (id: string) => void;
  running?: boolean;
}) {
  const [open, setOpen] = usePop();
  const pool = () => accountsIn(props.space);
  const pick = () => state.accountPick?.[props.space] ?? "auto";
  const auto = () => !props.onPick && pick() === "auto";
  // every account in the list shows who it is and how much of its window is used
  createEffect(() => {
    if (!open()) return;
    for (const x of pool()) {
      void loadEmail(x.id).catch(() => {});
      void refreshLimits(x.id);
    }
  });
  const choose = (id: string) => {
    setOpen(false);
    if (props.onPick) return props.onPick(id === "auto" ? props.accountId : id);
    setState("accountPick", (m) => ({ ...(m ?? {}), [props.space]: id }));
  };
  const Logos = (p: { id: string }) => (
    <For each={[...new Set((state.accounts.find((x) => x.id === p.id)?.providers ?? []).map(service))]}>{(x) => <Logo name={x === "Claude" ? "claude" : x} size={12} />}</For>
  );
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button
        class="st-acc"
        classList={{ on: open() }}
        title={[nameOf(props.accountId), emails[props.accountId], auto() && pool().length > 1 ? t("자동 선택") : ""].filter(Boolean).join(" · ")}
        onClick={() => setOpen(!open())}
      >
        <Show when={auto() && pool().length > 1} fallback={<><Logos id={props.accountId} /><span class="st-acc-name">{nameOf(props.accountId)}</span></>}>
          <Icon name="key" size={14} />
          <span class="st-acc-name">{t("자동")}</span>
        </Show>
        <Icon name="chevron" size={12} class="st-acc-chev" />
      </button>
      <Show when={open()}>
        <div class="pop acc-pop up">
          <div class="pop-label">{t("계정")}</div>
          <Show when={!props.onPick}>
            <button type="button" class="pop-item" onClick={() => choose("auto")}>
              <span class="pop-item-main">{t("자동")}</span>
              <Show when={pick() === "auto"}><Icon name="check" size={14} /></Show>
            </button>
          </Show>
          <For each={pool()}>
            {(x) => (
              <button type="button" class="pop-item" disabled={props.running && x.id !== props.accountId} onClick={() => choose(x.id)}>
                <span class="pop-item-main">
                  <span class="acc-row">
                    <Logos id={x.id} />
                    <span class="acc-name">{nameOf(x.id)}</span>
                    <Show when={emails[x.id]}><span class="acc-email">{emails[x.id]}</span></Show>
                  </span>
                  <span class="pop-item-sub">{usage(x.id) || (x.providers.length ? "" : t("로그인 필요"))}</span>
                </span>
                <Show when={props.onPick ? x.id === props.accountId : pick() === x.id}><Icon name="check" size={14} /></Show>
              </button>
            )}
          </For>
          <div class="pop-sep" />
          <button type="button" class="pop-item" onClick={() => (setOpen(false), setView({ name: "settings", tab: "accounts" }))}>
            <span class="pop-item-main">{t("계정 관리")}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}
