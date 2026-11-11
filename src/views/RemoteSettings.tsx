// Settings › 연결, like Codex's Connections: other Macs this one works on (their projects
// show in the sidebar, their jobs run there), and other Macs allowed to work on this one.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { state } from "../state/store";
import { mirror, remoteProjectId, type HostStatus } from "../state/mirror";
import { addHost, addHostFolder, addHostProject, removeHost, removeHostProject } from "../engine/hosts";
import { answerPair, connectLink, remote, revokeDevice, setRemoteOn } from "../engine/remote";
import { toast } from "../state/ui";
import { ago } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { ProjectBadge } from "../ui/ProjectBadge";
import { Row, Switch_ } from "./Settings";
import { t } from "../i18n";

const STATUS: Record<HostStatus, string> = {
  ok: "연결됨",
  connecting: "연결 중",
  waiting: "그 Mac에서 허용을 기다려요",
  lost: "연결 안 됨",
  denied: "거절됨",
  off: "꺼짐",
};

function statusText(s: HostStatus | undefined, reason?: string) {
  if (s === "denied" && reason === "off") return t("그 Mac에서 연결을 꺼 뒀어요");
  if (s === "denied" && reason === "unknown") return t("그 Mac에서 이 Mac을 뺐어요");
  return t(STATUS[s ?? "connecting"]);
}

/** one Mac this one works on: its state, its projects added here, adding more */
function HostRow(props: { id: string; name: string }) {
  const h = () => mirror.hosts[props.id];
  const [picking, setPicking] = createSignal(false);
  const [folder, setFolder] = createSignal("");
  const linked = () => (state.settings.hostProjects ?? []).filter((l) => l.host === props.id);
  const unlinked = () => (h()?.projects ?? []).filter((p) => !linked().some((l) => l.id === p.id));
  const addFolder = async () => {
    const f = folder().trim();
    if (!f) return;
    await addHostFolder(props.id, f).then(() => (setFolder(""), setPicking(false))).catch(() => {});
  };
  return (
    <>
      <div class="set-row cn-host">
        <div class="set-label">
          <span class={`cn-dot is-${h()?.status ?? "connecting"}`} aria-hidden="true" />
          <Icon name="monitor" size={16} class="muted" />
          <b>{props.name}</b>
          <span class="muted">{statusText(h()?.status, h()?.reason)}</span>
        </div>
        <div class="set-value">
          <button class="btn sm" disabled={h()?.status !== "ok"} onClick={() => setPicking(!picking())} aria-expanded={picking()}>
            <Icon name="plus" size={13} />
            {t("프로젝트 추가")}
          </button>
          <button class="btn sm ghost" onClick={() => removeHost(props.id)}>{t("빼기")}</button>
        </div>
      </div>
      <Show when={picking()}>
        <div class="set-row col cn-pick">
          <Show when={unlinked().length} fallback={<span class="muted">{t("{name}의 프로젝트를 다 추가했어요", { name: props.name })}</span>}>
            <div class="cn-pick-list">
              <For each={unlinked()}>
                {(p) => (
                  <button class="cn-pick-item" onClick={() => (addHostProject(props.id, p), setPicking(false))} title={p.folder}>
                    <ProjectBadge name={p.name} />
                    <span class="cn-pick-name">{p.name}</span>
                    <span class="muted cn-folder-path">{p.folder}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <form class="cn-form" onSubmit={(e) => (e.preventDefault(), void addFolder())}>
            <input class="input" placeholder={t("{name}의 폴더 경로 (~/Projects/app)", { name: props.name })} aria-label={t("폴더 경로")} value={folder()} onInput={(e) => setFolder(e.currentTarget.value)} />
            <button class="btn sm" type="submit" disabled={!folder().trim()}>{t("추가")}</button>
          </form>
        </div>
      </Show>
      <For each={linked()}>
        {(l) => {
          const p = () => h()?.projects.find((x) => x.id === l.id);
          const jobs = () => (h()?.tasks ?? []).filter((x) => x.project === remoteProjectId(props.id, l.id) && !x.parentId).length;
          return (
            <div class="set-row cn-proj">
              <div class="set-label">
                <ProjectBadge name={p()?.name ?? l.name ?? ""} />
                <b>{p()?.name ?? l.name}</b>
                <span class="muted cn-folder-path">{p()?.folder ?? l.folder}</span>
              </div>
              <div class="set-value">
                <Show when={jobs()}><span class="muted">{t("작업 {n}개", { n: jobs() })}</span></Show>
                <button class="btn sm ghost" onClick={() => removeHostProject(props.id, l.id)}>{t("빼기")}</button>
              </div>
            </div>
          );
        }}
      </For>
    </>
  );
}

function AddHost() {
  const [open, setOpen] = createSignal(false);
  const [link, setLink] = createSignal("");
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
        <button class="set-row cn-add" onClick={() => setOpen(true)}>
          <Icon name="plus" size={15} />
          <span>{t("Mac 추가")}</span>
        </button>
      }
    >
      <div class="set-row col">
        <form class="cn-form" onSubmit={(e) => (e.preventDefault(), void add())}>
          <input class="input" ref={(el) => setTimeout(() => el.focus(), 0)} placeholder="ondra://connect/…" aria-label={t("연결 링크")} value={link()} onInput={(e) => setLink(e.currentTarget.value)} />
          <button class="btn sm primary" type="submit" disabled={!link().trim()}>{t("연결")}</button>
          <button class="btn sm ghost" type="button" onClick={() => setOpen(false)}>{t("취소")}</button>
        </form>
        <span class="muted cn-hint">{t("그 Mac의 Ondra에서 설정 › 연결 › 연결 링크 복사를 누르고, 여기에 붙여 넣어요.")}</span>
      </div>
    </Show>
  );
}

function ThisMac() {
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));
  const left = () => Math.max(0, (remote().pair?.until ?? 0) - now());
  const mmss = () => {
    const s = Math.ceil(left() / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const copy = async () => {
    const l = await connectLink();
    if (!l) return toast(t("아직 연결을 준비하고 있어요"), "bad");
    await navigator.clipboard.writeText(l);
    toast(t("연결 링크를 복사했어요"));
  };
  const live = (id: string) => Object.values(remote().live).some((d) => d.id === id);
  return (
    <div class="set-group">
      <Row title={t("다른 Mac에서 이 Mac 쓰기")}>
        <Switch_ on={!!state.settings.remote} set={(v) => void setRemoteOn(v)} label={t("다른 Mac에서 이 Mac 쓰기")} />
      </Row>
      <Show when={state.settings.remote}>
        <div class="set-row">
          <div class="set-label cn-stack">
            <b>{t("연결 링크")}</b>
            <span class="muted cn-hint">{left() ? t("한 번만 쓸 수 있어요 · {t} 뒤 만료", { t: mmss() }) : t("다른 Mac에서 이 링크로 이 Mac을 추가해요")}</span>
          </div>
          <div class="set-value">
            <button class="btn sm" disabled={!remote().id} onClick={() => void copy()}>
              <Icon name="copy" size={13} />
              {t("연결 링크 복사")}
            </button>
          </div>
        </div>
        <For each={remote().devices}>
          {(d) => (
            <div class="set-row cn-host">
              <div class="set-label">
                <span class={`cn-dot ${live(d.id) ? "is-ok" : "is-lost"}`} aria-hidden="true" />
                <Icon name="monitor" size={16} class="muted" />
                <b>{d.name}</b>
                <span class="muted">{live(d.id) ? t("연결됨") : t("{ago} 접속", { ago: ago(d.lastSeen) })}</span>
              </div>
              <div class="set-value">
                <button class="btn sm ghost" onClick={() => revokeDevice(d.id)}>{t("연결 끊기")}</button>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

export function RemoteSettings() {
  return (
    <>
      <h2>{t("연결")}</h2>
      <p class="lead">{t("다른 Mac의 프로젝트를 여기서 써요. 작업은 그 Mac에서 돌고, 화면은 이 앱에 그대로 보여요. 오가는 내용은 끝까지 암호화돼요.")}</p>
      <div class="set-group-title">{t("다른 Mac")}</div>
      <div class="set-group">
        <For each={state.settings.hosts ?? []}>{(h) => <HostRow id={h.id} name={h.name} />}</For>
        <AddHost />
      </div>
      <div class="set-group-title">{t("이 Mac")}</div>
      <ThisMac />
    </>
  );
}

/** a Mac asking to work on this one: asked wherever the user is, until they say yes or no */
export function PairAskDialog() {
  const ask = () => remote().asks[0];
  return (
    <Show when={ask()}>
      {(a) => (
        <div class="rc-ask" role="alertdialog" aria-label={t("연결 요청")}>
          <Icon name="monitor" size={18} />
          <div class="rc-ask-main">
            <b>{t("{name}에서 이 Mac을 쓰려고 해요", { name: a().device.name })}</b>
            <span class="muted">{t("허용하면 그 Mac에서 이 Mac의 프로젝트로 작업을 시킬 수 있어요")}</span>
          </div>
          <button class="btn sm ghost" onClick={() => answerPair(a().conn, false)}>{t("거절")}</button>
          <button class="btn sm primary" onClick={() => answerPair(a().conn, true)}>{t("허용")}</button>
        </div>
      )}
    </Show>
  );
}
