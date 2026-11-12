// The account chip under an input: which login this work runs on.
// 자동 = routed (stays where the cache is warm, moves only when a plan window is
// nearly used up). Picking one pins new work in this space to it. A job already
// running keeps its account; switching a job starts its cache fresh, so it's said.
import { createEffect, createSignal, For, Show } from "solid-js";
import { accountsIn, setState, state } from "../state/store";
import type { Account } from "../state/types";
import { creditsOf, emails, loadEmail, refreshLimits, usageOf, windowLabel } from "../state/limits";
import { setView } from "../state/ui";
import { Logo } from "./Logos";
import { Icon } from "./Icon";
import { usePop } from "./ModelPicker";
import { t } from "../i18n";

export const service = (p: string) => (/anthropic|claude/.test(p) ? "Claude" : /codex|chatgpt|openai/.test(p) ? "ChatGPT" : /gemini|google/.test(p) ? "Gemini" : /copilot/.test(p) ? "Copilot" : p);
const services = (a: Account) => [...new Set(a.providers.map(service))];
const find = (a: Account | string | undefined) => (typeof a === "string" ? state.accounts.find((x) => x.id === a) : a);
/** a label the person gave it (the default one is only the workspace's name, "회사 2", which says nothing) */
const ownLabel = (a: Account) => (a.label && !state.spaces.some((s) => a.label === s.label || a.label.startsWith(`${s.label} `)) ? a.label : "");
/** What an account is called everywhere (picker, settings, overview, new task): the person's own
 *  label if they set one, otherwise provider + email ("ChatGPT · me@example.com").
 *  `short` drops the email, for a chip that has no room for it. */
export function accountName(account: Account | string | undefined, short = false): string {
  const a = find(account);
  if (!a) return "";
  const own = ownLabel(a);
  if (own) return own;
  const who = services(a).join(" · ");
  const mail = short ? "" : emails[a.id];
  if (who) return [who, mail].filter(Boolean).join(" · ");
  // no provider known yet: who it is, else the built-in login, never the workspace's name
  return emails[a.id] || (a.id === "default" ? t("기본 로그인") : t(a.label));
}
/** "12.5 credits": a number picks the English singular or plural */
const credits = (id: string) => {
  const c = creditsOf(id);
  if (!c) return [];
  const n = Number(c);
  return [Number.isFinite(n) ? t("크레딧 {n}", { n }) : `${t("크레딧")} ${c}`];
};
/** the windows the provider really has (now usually only the weekly one): "주간 19% 사용" */
const usage = (id: string) =>
  [...usageOf(id).map((l) => t("{w} {n}% 사용", { w: windowLabel(l.window), n: Math.round(l.used) })), ...credits(id)].join(" · ");

export function AccountPicker(props: {
  accountId: string;
  space: string;
  /** for a job: switch this job (only when it isn't running); without it the space's pick changes */
  onPick?: (id: string) => void;
  running?: boolean;
}) {
  const [open, setOpen] = usePop();
  // it opens toward the side with more room (up from the usage line, down on the new-task screen)
  // and never past the window's edge
  const [room, setRoom] = createSignal<{ up: boolean; max: number }>({ up: true, max: 480 });
  const toggle = (el: HTMLElement) => {
    if (!open()) {
      const r = el.getBoundingClientRect();
      const up = r.top > innerHeight - r.bottom;
      setRoom({ up, max: Math.max(160, (up ? r.top : innerHeight - r.bottom) - 16) });
    }
    setOpen(!open());
  };
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
        aria-label={accountName(props.accountId)}
        title={[auto() ? t("자동 선택") : "", accountName(props.accountId)].filter(Boolean).join(" · ")}
        onClick={(e) => toggle(e.currentTarget)}
      >
        {/* on 자동, it says so and which account the routing is on now: "자동 · ChatGPT" */}
        <Logos id={props.accountId} />
        <span class="st-acc-name">{auto() ? `${t("자동")} · ${accountName(props.accountId, true)}` : accountName(props.accountId, true)}</span>
        <Icon name="chevron" size={12} class="st-acc-chev" />
      </button>
      <Show when={open()}>
        <div class="pop acc-pop" classList={{ up: room().up }} style={{ "max-height": `${room().max}px`, "overflow-y": "auto" }}>
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
                    <span class="acc-name">{accountName(x, true)}</span>
                    <Show when={emails[x.id] && emails[x.id] !== accountName(x, true)}><span class="acc-email">{emails[x.id]}</span></Show>
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

/** another Mac's account, as that Mac sent it (Settings › 연결) */
export interface FarAccount { id: string; name: string; email?: string; services: string[]; usage: string }

/** The same picker for work on another Mac: that workspace's accounts there, picked here. */
export function FarAccountPicker(props: { accounts: FarAccount[]; current?: FarAccount; auto: boolean; onPick: (id: string | undefined) => void; onManage: () => void; title?: string }) {
  const [open, setOpen] = usePop();
  const [room, setRoom] = createSignal<{ up: boolean; max: number }>({ up: true, max: 480 });
  const toggle = (el: HTMLElement) => {
    if (!open()) {
      const r = el.getBoundingClientRect();
      const up = r.top > innerHeight - r.bottom;
      setRoom({ up, max: Math.max(160, (up ? r.top : innerHeight - r.bottom) - 16) });
    }
    setOpen(!open());
  };
  const choose = (id: string | undefined) => (setOpen(false), props.onPick(id));
  const Logos = (p: { a?: FarAccount }) => <For each={p.a?.services ?? []}>{(x) => <Logo name={x === "Claude" ? "claude" : x} size={12} />}</For>;
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button class="st-acc" classList={{ on: open() }} aria-label={props.current?.name} title={props.title} onClick={(e) => toggle(e.currentTarget)}>
        <Logos a={props.current} />
        <span class="st-acc-name">{props.auto ? `${t("자동")} · ${props.current?.name ?? ""}` : props.current?.name}</span>
        <Icon name="chevron" size={12} class="st-acc-chev" />
      </button>
      <Show when={open()}>
        <div class="pop acc-pop" classList={{ up: room().up }} style={{ "max-height": `${room().max}px`, "overflow-y": "auto" }}>
          <div class="pop-label">{t("계정")}</div>
          <button type="button" class="pop-item" onClick={() => choose(undefined)}>
            <span class="pop-item-main">{t("자동")}</span>
            <Show when={props.auto}><Icon name="check" size={14} /></Show>
          </button>
          <For each={props.accounts}>
            {(x) => (
              <button type="button" class="pop-item" onClick={() => choose(x.id)}>
                <span class="pop-item-main">
                  <span class="acc-row">
                    <Logos a={x} />
                    <span class="acc-name">{x.name}</span>
                    <Show when={x.email && x.email !== x.name}><span class="acc-email">{x.email}</span></Show>
                  </span>
                  <span class="pop-item-sub">{x.usage}</span>
                </span>
                <Show when={!props.auto && props.current?.id === x.id}><Icon name="check" size={14} /></Show>
              </button>
            )}
          </For>
          <div class="pop-sep" />
          <button type="button" class="pop-item" onClick={() => (setOpen(false), props.onManage())}>
            <span class="pop-item-main">{t("계정 관리")}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}
