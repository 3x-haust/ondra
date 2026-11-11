// Where a request runs, like Codex's run location: this Mac or another one added in
// Settings › 연결. Shown under the composer once another Mac is added.
import { Show } from "solid-js";
import { mirror } from "../state/mirror";
import { state } from "../state/store";
import { setView } from "../state/ui";
import { Icon } from "./Icon";
import { openMenuAt } from "./taskMenu";
import { t } from "../i18n";

/** the Mac new work goes to: the chosen one while it's still added, else this Mac (undefined) */
export function chosenComputer(): string | undefined {
  const id = state.settings.computer;
  return id && state.settings.hosts?.some((h) => h.id === id) ? id : undefined;
}

export function ComputerPicker(props: { value?: string; onPick?: (host: string | undefined) => void; fixed?: boolean }) {
  const hosts = () => state.settings.hosts ?? [];
  const name = () => (props.value ? (hosts().find((h) => h.id === props.value)?.name ?? "Mac") : t("이 Mac"));
  const status = () => (props.value ? (mirror.hosts[props.value]?.status ?? "connecting") : "ok");
  const open = (e: MouseEvent) =>
    openMenuAt(
      "computer",
      () => [
        { id: "local", label: t("이 Mac"), icon: "monitor", checked: !props.value, run: () => props.onPick?.(undefined) },
        ...hosts().map((h) => ({
          id: h.id,
          label: mirror.hosts[h.id]?.status === "ok" ? h.name : `${h.name} · ${t("연결 안 됨")}`,
          icon: "monitor",
          checked: props.value === h.id,
          run: () => props.onPick?.(h.id),
        })),
        "sep" as const,
        { id: "manage", label: t("연결 관리"), icon: "gear", run: () => setView({ name: "settings", tab: "remote" }) },
      ],
      (e.currentTarget as HTMLElement).getBoundingClientRect(),
    );
  return (
    <Show when={hosts().length || props.value}>
      <button
        type="button"
        class="st-acc st-comp"
        classList={{ away: status() !== "ok" }}
        disabled={props.fixed}
        title={props.fixed ? t("이 프로젝트는 {name}에 있어요", { name: name() }) : t("어느 Mac에서 할지")}
        onClick={open}
      >
        <i class={`cn-dot is-${status()}`} aria-hidden="true" />
        <span class="st-acc-name">{name()}</span>
        <Show when={!props.fixed}><Icon name="chevron" size={12} class="st-acc-chev" /></Show>
      </button>
    </Show>
  );
}
