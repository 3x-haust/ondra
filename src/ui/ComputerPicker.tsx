// Where work runs (the run location): a workspace is one device's (this one's, or one added in
// Settings › 연결, picked in the Mac bar), so its new work runs on that device. That device's account,
// plan use and models show the way this device's own do.
import { For, Show } from "solid-js";
import { hostStatusText, mirror, splitSpaceId, type HostInfo } from "../state/mirror";
import { ago } from "./bits";
import { setState, state } from "../state/store";
import { windowLabel } from "../state/limits";
import { setView } from "../state/ui";
import { Logo } from "./Logos";
import { ModelPicker, type RemoteModels } from "./ModelPicker";
import { FarAccountPicker, type FarAccount } from "./AccountPicker";
import { t } from "../i18n";

export interface Place { host: string; space?: string; account?: string; model?: string; thinking?: string }
type HostAccount = HostInfo["accounts"][number];

/** "연결됨" / "10분 전부터 연결 안 됨" … for one Mac */
export const hostState = (id: string) => hostStatusText(mirror.hosts[id], state.settings.hosts?.find((h) => h.id === id)?.seen, t, ago);
const hostName = (id: string) => state.settings.hosts?.find((h) => h.id === id)?.name ?? t("기기");
const infoOf = (host: string): HostInfo | undefined => mirror.hosts[host]?.info;

/** that device's own id for its workspace shown here */
export function hostSpace(host: string, mine: string): string | undefined {
  const s = splitSpaceId(mine);
  return s?.host === host ? s.id : undefined;
}

/** where new work from this workspace runs: its device when it is another one's, else this device (undefined) */
export function chosenComputer(mine: string = state.space): Place | undefined {
  const host = state.spaces.find((s) => s.id === mine)?.host;
  if (!host) return undefined;
  const c = state.settings.computers?.[mine];
  const same = c?.host === host;
  return { host, space: hostSpace(host, mine), account: same ? c.account : undefined, model: same ? c.model : undefined, thinking: same ? c.thinking : undefined };
}

export function setComputer(mine: string, p: Omit<Place, "space"> | undefined) {
  // replaced whole (a store merges objects): this Mac clears it, another account drops the model
  if (!state.settings.computers) setState("settings", "computers", {});
  setState("settings", "computers", mine, undefined!);
  if (p) setState("settings", "computers", mine, { host: p.host, account: p.account, model: p.model, thinking: p.thinking });
}

/** the account there new work runs on: the one picked, else what that workspace would pick */
export function hostAccount(p: Place, mine: string, own?: string): HostAccount | undefined {
  const info = infoOf(p.host);
  if (!info) return undefined;
  if (own) return info.accounts.find((a) => a.id === own);
  const sp = p.space ?? hostSpace(p.host, mine);
  const pool = info.accounts.filter((a) => !sp || a.space === sp);
  return pool.find((a) => a.id === p.account) ?? pool.find((a) => a.id === (sp ? info.pick[sp] : undefined)) ?? pool[0];
}

/** that account's models, for the model picker */
export const remoteModels = (a: HostAccount | undefined): RemoteModels | undefined =>
  a ? { models: a.models ?? [], auto: a.model, name: a.name, levels: a.levels, names: a.names } : undefined;

/** what this computer is called until it is given a name: "this Mac" only on a Mac */
export const thisComputer = () => (/Macintosh/.test(navigator.userAgent) ? t("이 Mac") : t("이 기기"));

/** the model chip for new work on another Mac: that account's models there */
export function HostModel(props: { place: Place; space?: string; up?: boolean; rest?: string }) {
  const mine = () => props.space ?? state.space;
  const acc = () => hostAccount(props.place, mine());
  return (
    <Show when={acc()}>
      {(a) => (
        <ModelPicker
          up={props.up}
          accountId={a().id}
          remote={remoteModels(a())}
          model={props.place.model ?? ""}
          thinking={props.place.thinking || a().effort || props.rest || ""}
          onChange={(m, th) => setComputer(mine(), { ...props.place, model: m, thinking: th })}
        />
      )}
    </Show>
  );
}

const NEAR = 80;

/**
 * Under the composer when the work runs on another Mac: that Mac, the account there, and its plan
 * use, read from that Mac. `account` set: a job's own account (not changed here); unset: new work,
 * its account picked from that workspace's.
 */
export function HostStatus(props: { place: Place; account?: string; space?: string }) {
  const mine = () => props.space ?? state.space;
  const info = () => infoOf(props.place.host);
  const sp = () => props.place.space ?? hostSpace(props.place.host, mine());
  const pool = () => (info()?.accounts ?? []).filter((a) => !sp() || a.space === sp());
  const auto = () => !props.account && !props.place.account;
  const acc = () => hostAccount(props.place, mine(), props.account);
  // as this Mac's own picker says it: "주간 59% 사용 · 크레딧 12.5"
  const usageText = (a: HostAccount) => {
    const now = Date.now();
    const wins = a.limits.filter((l) => l.window > 0).map((l) => t("{w} {n}% 사용", { w: windowLabel(l.window), n: Math.round(l.resetsAt && l.resetsAt <= now ? 0 : l.used) }));
    const n = Number(a.credits);
    const cr = a.credits ? [Number.isFinite(n) ? t("크레딧 {n}", { n }) : `${t("크레딧")} ${a.credits}`] : [];
    return [...wins, ...cr].join(" · ");
  };
  const far = (a: HostAccount): FarAccount => ({ id: a.id, name: a.name, email: a.email, services: a.services, usage: usageText(a) });
  const used = () => (acc()?.limits ?? []).filter((l) => l.window > 0).map((l) => (l.resetsAt && l.resetsAt <= Date.now() ? { ...l, used: 0 } : l));
  return (
    <div class="status-line">
      <Show when={acc()}>
        {(a) => (
          <Show
            when={!props.account}
            fallback={
              <span class="st-acc" title={t("{name}의 계정", { name: hostName(props.place.host) })}>
                <For each={a().services}>{(x) => <Logo name={x === "Claude" ? "claude" : x} size={12} />}</For>
                <span class="st-acc-name">{a().name}</span>
              </span>
            }
          >
            {/* another account has its own models: the model picked goes back to that account's */}
            <FarAccountPicker
              accounts={pool().map(far)}
              current={far(a())}
              auto={auto()}
              title={t("{name}의 계정", { name: hostName(props.place.host) })}
              onPick={(id) => setComputer(mine(), id ? { host: props.place.host, account: id } : { host: props.place.host })}
              onManage={() => setView({ name: "settings", tab: "remote" })}
            />
          </Show>
        )}
      </Show>
      <For each={used()}>
        {(l) => (
          <span class="st-lim" classList={{ hot: l.used >= NEAR }} data-used={l.used}>
            {l.used >= 100 ? t("{w} 한도 다 씀", { w: windowLabel(l.window) }) : t("{w} 한도 {n}%", { w: windowLabel(l.window), n: Math.round(l.used) })}
          </span>
        )}
      </For>
      <Show when={acc()?.credits && (!used().length || used().some((l) => l.used >= 100))}>
        <span class="st-lim st-credits">{t("크레딧 {n}|left", { n: acc()!.credits! })}</span>
      </Show>
    </div>
  );
}
