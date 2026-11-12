// Where work runs (the run location): this Mac or another one added in Settings › 연결.
// The workspace is the tab at the top (another Mac's workspace of the same name), so this picks
// only the Mac; a tab only another Mac has offers only Macs. That Mac's account, plan use and
// models show the way this Mac's own do.
import { For, Show } from "solid-js";
import { hostStatusText, mirror, type HostInfo } from "../state/mirror";
import { ago } from "./bits";
import { accountsIn, setState, state } from "../state/store";
import { setView } from "../state/ui";
import { windowLabel } from "../state/limits";
import { Icon } from "./Icon";
import { Logo } from "./Logos";
import { ModelPicker, type RemoteModels } from "./ModelPicker";
import { FarAccountPicker, type FarAccount } from "./AccountPicker";
import { openMenuAt, type MenuEntry } from "./taskMenu";
import { t } from "../i18n";

export interface Place { host: string; space?: string; account?: string; model?: string; thinking?: string }
type HostAccount = HostInfo["accounts"][number];

const hostName = (id: string) => state.settings.hosts?.find((h) => h.id === id)?.name ?? "Mac";
/** "연결됨" / "10분 전부터 연결 안 됨" … for one Mac */
export const hostState = (id: string) => hostStatusText(mirror.hosts[id], state.settings.hosts?.find((h) => h.id === id)?.seen, t, ago);
const infoOf = (host: string): HostInfo | undefined => mirror.hosts[host]?.info;
const labelOf = (space: string) => state.spaces.find((s) => s.id === space)?.label;

/** that Mac's workspace for this one here: the one of the same name (unknown until it says) */
export function hostSpace(host: string, mine: string): string | undefined {
  return infoOf(host)?.spaces.find((s) => s.label === labelOf(mine))?.id;
}
/** a Mac that has this workspace (or hasn't said yet which it has) */
const hasSpace = (host: string, mine: string) => {
  const h = state.settings.hosts?.find((x) => x.id === host);
  const labels = infoOf(host)?.spaces.map((s) => s.label) ?? h?.spaces;
  return !labels || labels.includes(labelOf(mine) ?? "");
};
/** this Mac works here: a workspace of its own, or one it has since given an account */
export const localHere = (mine: string) => !state.spaces.find((s) => s.id === mine)?.only || accountsIn(mine).length > 0;
const macsHere = (mine: string) => (state.settings.hosts ?? []).filter((h) => hasSpace(h.id, mine));

/** where new work from this workspace runs: another Mac, else this Mac (undefined) */
export function chosenComputer(mine: string = state.space): Place | undefined {
  const c = state.settings.computers?.[mine];
  const host = c && macsHere(mine).some((h) => h.id === c.host) ? c.host : !localHere(mine) ? macsHere(mine)[0]?.id : undefined;
  if (!host) return undefined;
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

/** the chip: which Mac; a menu to change it unless it's fixed (a project's own Mac) */
export function ComputerPicker(props: { value?: Place; fixed?: boolean; space?: string }) {
  const mine = () => props.space ?? state.space;
  const status = () => (props.value ? (mirror.hosts[props.value.host]?.status ?? "connecting") : "ok");
  const label = () => (props.value ? hostName(props.value.host) : t("이 Mac"));
  const items = (): MenuEntry[] => [
    ...(localHere(mine()) ? [{ id: "local", label: t("이 Mac"), icon: "monitor", checked: !props.value, run: () => setComputer(mine(), undefined) }] : []),
    ...macsHere(mine()).map((h) => ({
      id: h.id,
      label: mirror.hosts[h.id]?.status === "ok" ? h.name : `${h.name} · ${hostState(h.id)}`,
      icon: "monitor",
      checked: props.value?.host === h.id,
      run: () => props.value?.host !== h.id && setComputer(mine(), { host: h.id }),
    })),
    "sep",
    { id: "manage", label: t("연결 관리"), icon: "gear", run: () => setView({ name: "settings", tab: "remote" }) },
  ];
  return (
    <Show when={macsHere(mine()).length || props.value}>
      <button
        type="button"
        class="st-acc st-comp"
        classList={{ away: status() !== "ok" }}
        disabled={props.fixed}
        title={[props.fixed ? t("이 프로젝트는 {name}에 있어요", { name: label() }) : t("어느 Mac에서 할지"), props.value ? hostState(props.value.host) : ""].filter(Boolean).join(" · ")}
        onClick={(e) => openMenuAt("computer", items, e.currentTarget.getBoundingClientRect())}
      >
        <i class={`cn-dot is-${status()}`} aria-hidden="true" />
        <span class="st-acc-name">{label()}</span>
        <Show when={!props.fixed}><Icon name="chevron" size={12} class="st-acc-chev" /></Show>
      </button>
    </Show>
  );
}

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
export function HostStatus(props: { place: Place; fixed?: boolean; account?: string; space?: string }) {
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
      <ComputerPicker value={props.place} fixed={props.fixed} space={mine()} />
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
