// Settings › 연결: the devices connected to this one, both ways. This Mac uses each (its projects show in
// the sidebar, their jobs run there) and each may use this Mac; one link and one 허용 connect both.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { setState, state, ownSpaces } from "../state/store";
import { mirror } from "../state/mirror";
import { addHost, hiddenProjects, reconnect, showHostProject } from "../engine/hosts";
import { answerPair, askStopJobs, connectLink, dropDevice, getReady, keepAwake, remote, setDeviceSpaces } from "../engine/remote";
import { jobsFrom } from "../engine/remoteRules";
import { hostState } from "../ui/ComputerPicker";
import { askRemoveDevice, hostConnectItem } from "../ui/macActions";
import { toast } from "../state/ui";
import { ago } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { openMenuAt, type MenuEntry, type MenuItem } from "../ui/taskMenu";
import { GroupTitle, PageHead, Row, Switch_ } from "./Settings";
import { t } from "../i18n";

const [mine] = createResource(() => import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => ""));

/** one device connected here: this Mac's connection to it, its projects added here, what it may use here */
function DeviceRow(props: { id: string }) {
  const host = () => state.settings.hosts?.find((x) => x.id === props.id);
  const dev = () => remote().devices.find((d) => d.id === props.id);
  const name = () => host()?.name ?? dev()?.name ?? "Mac";
  const h = () => mirror.hosts[props.id];
  const live = () => Object.values(remote().live).some((d) => d.id === props.id);
  // a name of the user's own for it, used everywhere (sidebar, the run chip, jobs)
  const [naming, setNaming] = createSignal(false);
  const rename = (v: string) => {
    setNaming(false);
    const next = v.trim();
    if (next && next !== name()) setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === props.id ? { ...x, name: next } : x)));
  };
  // this Mac's own connection to it; a device that only comes in here (an older Ondra there) by its own
  const dot = () => (host() ? (h()?.status ?? (host()!.off ? "off" : "connecting")) : live() ? "ok" : "lost");
  const said = () => (host() ? hostState(props.id) : live() ? t("연결됨") : t("{ago} 접속", { ago: ago(dev()!.lastSeen) }));
  const theirs = () => h()?.info?.version;
  const off = () => !!theirs() && !!mine() && theirs() !== mine();
  const linked = () => (state.settings.hostProjects ?? []).filter((l) => l.host === props.id);
  return (
    <>
      <div class="set-row cn-host">
        <div class="set-label">
          <span class={`cn-dot is-${dot()}`} aria-hidden="true" />
          <Icon name="monitor" size={16} class="muted" />
          <Show
            when={naming()}
            fallback={
              <Show when={host()} fallback={<b>{name()}</b>}>
                <button class="cn-name" title={t("이름 바꾸기")} onClick={() => setNaming(true)}>
                  <b>{name()}</b>
                </button>
              </Show>
            }
          >
            <input
              class="input cn-name-input"
              aria-label={t("이름")}
              value={name()}
              ref={(el) => setTimeout(() => (el.focus(), el.select()), 0)}
              onBlur={(e) => rename(e.currentTarget.value)}
              onKeyDown={(e) => (e.key === "Enter" ? rename(e.currentTarget.value) : e.key === "Escape" && (e.stopPropagation(), setNaming(false)))}
            />
          </Show>
          <span class="muted">{said()}</span>
          <Show when={linked().length}>
            <span class="muted cn-count">· {t("프로젝트 {n}개", { n: linked().length })}</span>
          </Show>
          <Show when={dev() && !allSpaces(props.id)}>
            <span class="muted cn-count">· {t("워크스페이스 {n}개", { n: state.settings.deviceSpaces?.[props.id]?.length ?? 0 })}</span>
          </Show>
          <Show when={off()}>
            <span class="cn-ver" title={t("두 기기의 Ondra 버전이 달라요: 이 기기 {a}, 다른 기기 {b}", { a: mine()!, b: theirs()! })}>{t("버전 다름")}</span>
          </Show>
        </div>
        <div class="set-value">
          <Show when={host() && h()?.status !== "ok" && h()?.status !== "waiting"}>
            <button class="btn sm" onClick={() => reconnect(props.id)}>
              <Icon name="refresh" size={13} />
              {t("다시 연결")}
            </button>
          </Show>
          <button
            class="icon-btn sm"
            title={t("더 보기")}
            aria-label={t("더 보기")}
            onClick={(e) => openMenuAt(`device:${props.id}`, () => deviceMenu(props.id, name(), live(), host() ? () => setNaming(true) : undefined), e.currentTarget.getBoundingClientRect())}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
      </div>
      {/* its projects hidden here (목록에서 숨기기 in the sidebar): each can come back */}
      <For each={hiddenProjects(props.id)}>
        {(p) => (
          <div class="set-row cn-proj">
            <div class="set-label">
              <Icon name="eyeOff" size={14} class="muted" />
              <span class="muted">{p.name}</span>
            </div>
            <div class="set-value">
              <button class="btn sm ghost" onClick={() => showHostProject(props.id, p.id)}>{t("다시 보이기")}</button>
            </div>
          </div>
        )}
      </For>
    </>
  );
}

/** a device removed here that hasn't heard it yet: it will when it can be reached */
function LeavingRow(props: { name: string }) {
  return (
    <div class="set-row cn-host">
      <div class="set-label">
        <span class="cn-dot is-off" aria-hidden="true" />
        <Icon name="monitor" size={16} class="muted" />
        <span class="muted">{props.name}</span>
        <span class="muted">{t("연결되면 다른 기기에서도 이 기기를 제거해요")}</span>
      </div>
    </div>
  );
}

/** 기기 추가: this Mac's link for the other device, or the other device's link pasted here. Either way, once
 *  the other side allows it, both use each other. */
function AddDevice() {
  const [open, setOpen] = createSignal(false);
  const [link, setLink] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));
  const left = () => Math.max(0, (remote().pair?.until ?? 0) - now());
  const mmss = () => {
    const s = Math.ceil(left() / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const show = () => (getReady(), setOpen(true));
  const copy = async () => {
    const l = await connectLink();
    if (!l) return toast(t("아직 연결을 준비하고 있어요"), "bad");
    await navigator.clipboard.writeText(l);
    toast(t("연결 링크를 복사했어요"));
  };
  const add = async () => {
    if (await addHost(link())) {
      setLink("");
      setOpen(false);
    } else toast(t("연결 링크가 아니에요"), "bad");
  };
  return (
    <Show
      when={open()}
      fallback={
        <button class="set-row cn-add" onClick={show}>
          <Icon name="plus" size={15} />
          <span>{t("기기 추가")}</span>
        </button>
      }
    >
      <div class="set-row">
        <div class="set-label cn-stack">
          <b>{t("이 기기의 연결 링크")}</b>
          <span class="muted cn-hint">{left() ? t("한 번만 쓸 수 있어요 · {t} 뒤 만료", { t: mmss() }) : t("연결할 기기의 기기 추가에 붙여 넣어요")}</span>
        </div>
        <div class="set-value">
          <button class="btn sm" disabled={!remote().id} onClick={() => void copy()}>
            <Icon name="copy" size={13} />
            {remote().id ? t("연결 링크 복사") : t("준비하는 중…")}
          </button>
        </div>
      </div>
      <div class="set-row col">
        <form class="cn-form" onSubmit={(e) => (e.preventDefault(), void add())}>
          <input class="input" ref={(el) => setTimeout(() => el.focus(), 0)} placeholder="ondra://connect/…" aria-label={t("다른 기기의 연결 링크")} value={link()} onInput={(e) => setLink(e.currentTarget.value)} />
          <button class="btn sm primary" type="submit" disabled={!link().trim()}>{t("연결")}</button>
          <button class="btn sm ghost" type="button" onClick={() => setOpen(false)}>{t("취소")}</button>
        </form>
        <span class="muted cn-hint">{t("한쪽에서 복사한 연결 링크를 다른 쪽에 붙여 넣어요. 링크를 만든 기기에서 허용하면 두 기기 모두 서로를 쓸 수 있어요.")}</span>
      </div>
    </Show>
  );
}

/** may that device use every workspace here (none picked out) */
const allSpaces = (id: string) => !state.settings.deviceSpaces?.[id];

/** one device: its name (one this Mac uses), 연결 끊기 or 다시 연결, the workspaces it may use here, its jobs here, 제거 */
function deviceMenu(id: string, name: string, live: boolean, rename?: () => void): MenuEntry[] {
  const may = state.settings.deviceSpaces?.[id] ?? ownSpaces().map((s) => s.id);
  const toggle = (space: string) => {
    const next = may.includes(space) ? may.filter((x) => x !== space) : [...may, space];
    // every one of them again: back to "all" (a workspace made later is included too)
    setDeviceSpaces(id, ownSpaces().every((s) => next.includes(s.id)) ? undefined : next);
  };
  const n = jobsFrom(state.tasks, id).length;
  const allowed = remote().devices.some((d) => d.id === id);
  const groups: MenuItem[][] = [
    rename ? [{ id: "rename", label: t("이름 바꾸기"), icon: "pencil", run: rename }, hostConnectItem(id)] : live ? [{ id: "disconnect", label: t("연결 끊기"), icon: "unplug", run: () => dropDevice(id) }] : [],
    allowed && ownSpaces().length > 1 ? ownSpaces().map((s) => ({ id: `space:${s.id}`, label: s.label, icon: "folder", checked: may.includes(s.id), run: () => toggle(s.id) })) : [],
    n ? [{ id: "jobs", label: t("그 기기에서 시킨 작업 {n}개 정리", { n }), icon: "archive", run: () => askStopJobs(id, name) }] : [],
    [{ id: "remove", label: t("제거"), icon: "trash", danger: true, run: () => askRemoveDevice(id) }],
  ];
  return groups.filter((g) => g.length).flatMap((g, i): MenuEntry[] => (i ? ["sep", ...g] : g));
}

/** every device connected, both ways: the ones this Mac uses first, then ones only let in (an older Ondra there) */
const deviceIds = () => {
  const ids = (state.settings.hosts ?? []).map((h) => h.id);
  return [...ids, ...remote().devices.map((d) => d.id).filter((id) => !ids.includes(id))];
};

export function RemoteSettings() {
  return (
    <>
      <PageHead tab="remote" />
      <GroupTitle title={t("기기|list")} />
      <div class="set-group">
        <For each={deviceIds()}>{(id) => <DeviceRow id={id} />}</For>
        <For each={state.settings.leaving ?? []}>{(l) => <LeavingRow name={l.name} />}</For>
        <AddDevice />
      </div>
      <Show when={/Macintosh|Windows|Linux/.test(navigator.userAgent)}>
        <GroupTitle title={t("이 기기")} />
        <div class="set-group">
          <Row title={t("잠자기 방지")} desc={/Windows/.test(navigator.userAgent) ? t("다른 기기와 연결돼 있는 동안 이 PC가 잠들지 않아요") : /Macintosh/.test(navigator.userAgent) ? t("전원에 연결돼 있는 동안 이 Mac이 잠들지 않아요") : t("Ondra가 켜져 있는 동안 이 기기가 잠들지 않아요")}>
            <Switch_ on={!!state.settings.remoteAwake} set={(v) => (setState("settings", "remoteAwake", v), keepAwake())} label={t("잠자기 방지")} />
          </Row>
        </div>
      </Show>
    </>
  );
}

/** a device asking to connect: asked wherever the user is, until they say yes or no */
export function PairAskDialog() {
  const ask = () => remote().asks[0];
  return (
    <Show when={ask()}>
      {(a) => (
        <div class="rc-ask" role="alertdialog" aria-label={t("연결 요청")}>
          <Icon name="monitor" size={18} />
          <div class="rc-ask-main">
            <b>{t("{name}에서 연결하려고 해요", { name: a().device.name })}</b>
            <span class="muted">{t("허용하면 두 기기 모두 서로의 프로젝트를 보고 작업을 시작할 수 있어요")}</span>
          </div>
          <button class="btn sm ghost" onClick={() => answerPair(a().conn, false)}>{t("거절")}</button>
          <button class="btn sm primary" onClick={() => answerPair(a().conn, true)}>{t("허용")}</button>
        </div>
      )}
    </Show>
  );
}
