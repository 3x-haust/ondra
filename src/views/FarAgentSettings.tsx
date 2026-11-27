// Settings › 에이전트 with a connected device picked: that device's Discord agent settings, as it
// sends them with its agent (engine/remote.ts agentSettingsNow). Seen here, changed on that device.
import { For, Show } from "solid-js";
import { mirror, type FarAgentSettings } from "../state/mirror";
import { hostName } from "../engine/hosts";
import { Logo } from "../ui/Logos";
import { Icon } from "../ui/Icon";
import { AgentSettings } from "./AgentSettings";
import { farPicked, GroupTitle, PageHead, Row, sharingDevices } from "./Settings";
import { t } from "../i18n";

/** the 에이전트 page: this device's settings, or the picked device's (an older Ondra there sends none) */
export function AgentPage() {
  return (
    <Show when={farPicked(sharingDevices())} keyed fallback={<AgentSettings />}>
      {(host) => (
        <Show when={mirror.hosts[host]?.agent?.settings} fallback={<OlderAgent host={host} />}>
          <FarAgentSettings host={host} />
        </Show>
      )}
    </Show>
  );
}

function OlderAgent(props: { host: string }) {
  return (
    <>
      <PageHead tab="agent" />
      <div class="set-group"><div class="empty-line">{t("{name}의 Ondra를 업데이트하면 볼 수 있어요", { name: hostName(props.host) })}</div></div>
    </>
  );
}

function FarAgentSettings(props: { host: string }) {
  const h = () => mirror.hosts[props.host];
  const agent = () => h()?.agent;
  const s = (): FarAgentSettings => agent()?.settings ?? { token: false, others: true, places: [], channels: [], rooms: {} };
  /** a place there: none, one of its workspaces, or a third device's ("MacBook › 회사") */
  const spaceName = (id?: string) => {
    if (!id) return t("없음");
    const named = s().spaces?.[id];
    const label = named?.label ?? h()?.info?.spaces.find((x) => x.id === id)?.label ?? id;
    return `${named?.device ?? hostName(props.host)} › ${label}`;
  };
  const accountLabel = (id?: string) => (id ? (h()?.info?.accounts.find((x) => x.id === id)?.name ?? id) : t("자동"));
  const where = (space?: string, account?: string) => [spaceName(space), accountLabel(account)].filter(Boolean).join(" · ");
  /** a channel by the name its bot knows, else the one saved with it ("#orbit · server") */
  const room = (id: string, saved?: string) => {
    const [name, server] = (saved ?? "").split(" · ");
    return { name: (s().rooms[id] ?? (name || id)).replace(/^#/, ""), server };
  };
  const statusLine = () => {
    const st = agent()?.status ?? { state: "off" as const };
    if (st.state === "on") return t("{name}(으)로 연결돼 있어요", { name: agent()?.name ?? "" });
    if (st.state === "connecting") return t("연결하는 중이에요");
    if (st.state === "stopped") return st.why ?? t("연결이 멈췄어요");
    return s().token ? t("꺼져 있어요") : t("봇 토큰을 넣으면 켤 수 있어요");
  };
  const dot = () => ({ on: "is-ok", connecting: "is-connecting", stopped: "is-denied", off: "" })[agent()?.status.state ?? "off"];

  return (
    <>
      <PageHead tab="agent" />
      <p class="set-quiet ag-far-note">{t("{name}에서 바꿀 수 있어요", { name: hostName(props.host) })}</p>
      <GroupTitle title={t("디스코드")} />
      <div class="set-group prov-list">
        <div class="prov-row ag-head">
          <span class="prov-logo"><Logo name="discord" size={18} mono /></span>
          <div class="prov-text">
            <span class="prov-title">{agent()?.name}</span>
            <span class="prov-sub ag-status" classList={{ bad: agent()?.status.state === "stopped" }}>
              <span class={`cn-dot ${dot()}`} aria-hidden="true" />
              {statusLine()}
            </span>
          </div>
          <span class="spacer" />
          <span class="set-quiet">{agent()?.on ? t("켜짐") : t("꺼짐")}</span>
        </div>
        <Row title={t("봇 토큰")}>
          <span class="set-quiet">{s().token ? t("키체인에 있어요") : t("없어요")}</span>
        </Row>
        <Row title={t("이름")}>
          <span class="set-quiet">{agent()?.name}</span>
        </Row>
        <Row title={t("내 디스코드 ID")}>
          <span class="set-quiet selectable">{s().ownerId || t("봇을 만든 계정")}</span>
        </Row>
      </div>

      <GroupTitle title={t("일하는 곳")} />
      <div class="set-group prov-list">
        <div class="prov-row">
          <span class="prov-logo"><Icon name="globe" size={16} /></span>
          <div class="prov-text">
            <span class="prov-title">{t("모든 채널")}</span>
            <span class="prov-sub">{!s().space ? t("프로젝트 이름으로 공간을 찾고, 모르면 물어봐요") : s().places.length ? t("아래 채널 말고 전부") : t("시킨 일은 여기서 해요")}</span>
          </div>
          <span class="spacer" />
          <span class="set-quiet">{where(s().space, s().account)}</span>
        </div>
        <For each={s().places}>
          {(p) => (
            <div class="prov-row">
              <span class="prov-logo ag-hash">#</span>
              <div class="prov-text">
                <span class="prov-title">{room(p.channel, p.label).name}</span>
                <Show when={room(p.channel, p.label).server}>{(server) => <span class="prov-sub">{server()}</span>}</Show>
              </div>
              <span class="spacer" />
              <span class="set-quiet">{where(p.space, p.account)}</span>
            </div>
          )}
        </For>
      </div>

      <GroupTitle title={t("다른 사람")} />
      <div class="set-group">
        <Row title={t("다른 사람과 대화")}>
          <span class="set-quiet">{s().others ? t("켜짐") : t("꺼짐")}</span>
        </Row>
        <Show when={s().others}>
          <Row title={t("대화할 채널")}>
            <div class="ag-chips">
              <Show when={s().channels.length} fallback={<span class="set-quiet">{t("부르는 곳 어디서나")}</span>}>
                <For each={s().channels}>{(id) => <span class="ag-chip">#{room(id).name}</span>}</For>
              </Show>
            </div>
          </Row>
        </Show>
      </div>

      <GroupTitle title={t("말투와 성격")} />
      <div class="set-group">
        <div class="set-row col" data-set={t("말투와 성격")}>
          <p class="ag-voice selectable" classList={{ "set-quiet": !s().voice }}>{s().voice || t("기본 말투예요")}</p>
        </div>
      </div>
    </>
  );
}
