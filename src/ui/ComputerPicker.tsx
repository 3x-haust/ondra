// Where work runs, like Codex's run location: this Mac or another one added in Settings › 연결,
// in one of its workspaces, on one of that workspace's accounts. Under the composer once another
// Mac is added, with that Mac's account and plan use the way this Mac's own show.
import { For, Show } from "solid-js";
import { mirror, type HostInfo } from "../state/mirror";
import { setState, state } from "../state/store";
import { setView } from "../state/ui";
import { windowLabel } from "../state/limits";
import { Icon } from "./Icon";
import { Logo } from "./Logos";
import { openMenuAt, type MenuEntry } from "./taskMenu";
import { t } from "../i18n";

export interface Place { host: string; space?: string; account?: string }

const hostName = (id: string) => state.settings.hosts?.find((h) => h.id === id)?.name ?? "Mac";
const infoOf = (host: string): HostInfo | undefined => mirror.hosts[host]?.info;

/** the workspace there that work from this workspace goes to: the one picked, the one of the same
 *  name, or its first */
export function hostSpace(host: string, mine: string, picked?: string): string | undefined {
  const spaces = infoOf(host)?.spaces ?? [];
  if (picked && (!spaces.length || spaces.some((s) => s.id === picked))) return picked;
  const label = state.spaces.find((s) => s.id === mine)?.label;
  return (spaces.find((s) => s.id === mine) ?? spaces.find((s) => s.label === label) ?? spaces[0])?.id;
}

/** where new work from this workspace runs: another Mac (still added), else this Mac (undefined) */
export function chosenComputer(space: string = state.space): Place | undefined {
  const c = state.settings.computers?.[space];
  if (!c || !state.settings.hosts?.some((h) => h.id === c.host)) return undefined;
  return { host: c.host, space: hostSpace(c.host, space, c.space), account: c.account };
}

export function setComputer(space: string, p: Place | undefined) {
  setState("settings", "computers", (m) => {
    const next = { ...(m ?? {}) };
    if (p) next[space] = p;
    else delete next[space];
    return next;
  });
}

const spaceLabel = (host: string, id?: string) => infoOf(host)?.spaces.find((s) => s.id === id)?.label;

/** the chip: which Mac (and workspace there); a menu to change it unless it's fixed (a project's own Mac) */
export function ComputerPicker(props: { value?: Place; fixed?: boolean; space?: string }) {
  const mine = () => props.space ?? state.space;
  const hosts = () => state.settings.hosts ?? [];
  const status = () => (props.value ? (mirror.hosts[props.value.host]?.status ?? "connecting") : "ok");
  const label = () => {
    if (!props.value) return t("이 Mac");
    const many = (infoOf(props.value.host)?.spaces.length ?? 0) > 1;
    const sp = many ? spaceLabel(props.value.host, props.value.space) : undefined;
    return sp ? `${hostName(props.value.host)} · ${sp}` : hostName(props.value.host);
  };
  const items = (): MenuEntry[] => [
    { id: "local", label: t("이 Mac"), icon: "monitor", checked: !props.value, run: () => setComputer(mine(), undefined) },
    ...hosts().flatMap((h): MenuEntry[] => {
      const off = mirror.hosts[h.id]?.status !== "ok";
      const spaces = infoOf(h.id)?.spaces ?? [];
      const name = (x: string) => (off ? `${x} · ${t("연결 안 됨")}` : x);
      if (spaces.length <= 1) return [{ id: h.id, label: name(h.name), icon: "monitor", checked: props.value?.host === h.id, run: () => setComputer(mine(), { host: h.id }) }];
      return spaces.map((s) => ({
        id: `${h.id}:${s.id}`,
        label: name(`${h.name} · ${s.label}`),
        icon: "monitor",
        checked: props.value?.host === h.id && props.value.space === s.id,
        run: () => setComputer(mine(), { host: h.id, space: s.id }),
      }));
    }),
    "sep",
    { id: "manage", label: t("연결 관리"), icon: "gear", run: () => setView({ name: "settings", tab: "remote" }) },
  ];
  return (
    <Show when={hosts().length || props.value}>
      <button
        type="button"
        class="st-acc st-comp"
        classList={{ away: status() !== "ok" }}
        disabled={props.fixed}
        title={props.fixed ? t("이 프로젝트는 {name}에 있어요", { name: label() }) : t("어느 Mac에서 할지")}
        onClick={(e) => openMenuAt("computer", items, e.currentTarget.getBoundingClientRect())}
      >
        <i class={`cn-dot is-${status()}`} aria-hidden="true" />
        <span class="st-acc-name">{label()}</span>
        <Show when={!props.fixed}><Icon name="chevron" size={12} class="st-acc-chev" /></Show>
      </button>
    </Show>
  );
}

const NEAR = 80;

/**
 * Under the composer when the work runs on another Mac: that Mac (and workspace), the account
 * there, and its plan use, read from that Mac. `account` set: a job's own account (not changed
 * here); unset: new work, its account picked from that workspace's.
 */
export function HostStatus(props: { place: Place; fixed?: boolean; account?: string; space?: string }) {
  const mine = () => props.space ?? state.space;
  const info = () => infoOf(props.place.host);
  const sp = () => props.place.space ?? hostSpace(props.place.host, mine());
  const pool = () => (info()?.accounts ?? []).filter((a) => !sp() || a.space === sp());
  const auto = () => !props.account && !props.place.account;
  const accId = () => props.account ?? (props.place.account && pool().some((a) => a.id === props.place.account) ? props.place.account : sp() ? info()?.pick[sp()!] : undefined);
  const acc = () => info()?.accounts.find((a) => a.id === accId());
  const pickAccount = (e: MouseEvent) =>
    openMenuAt(
      "host-account",
      () => [
        { id: "auto", label: t("자동"), icon: "spark", checked: auto(), run: () => setComputer(mine(), { ...props.place, account: undefined }) },
        ...pool().map((a) => ({ id: a.id, label: a.name, icon: "key", checked: !auto() && a.id === accId(), run: () => setComputer(mine(), { ...props.place, account: a.id }) })),
      ],
      (e.currentTarget as HTMLElement).getBoundingClientRect(),
    );
  const used = () => (acc()?.limits ?? []).filter((l) => l.window > 0).map((l) => (l.resetsAt && l.resetsAt <= Date.now() ? { ...l, used: 0 } : l));
  return (
    <div class="status-line">
      <ComputerPicker value={props.place} fixed={props.fixed} space={mine()} />
      <Show when={acc()}>
        {(a) => (
          <button type="button" class="st-acc" disabled={!!props.account || pool().length < 2} onClick={pickAccount} title={t("{name}의 계정", { name: hostName(props.place.host) })}>
            <For each={a().services}>{(x) => <Logo name={x === "Claude" ? "claude" : x} size={12} />}</For>
            <span class="st-acc-name">{auto() ? `${t("자동")} · ${a().name}` : a().name}</span>
            <Show when={!props.account && pool().length > 1}><Icon name="chevron" size={12} class="st-acc-chev" /></Show>
          </button>
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
