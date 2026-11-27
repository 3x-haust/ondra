// Settings › 에이전트: Ondra on Discord (engine/discord.ts). The bot token goes to the keychain and
// never comes back here; the rest (name, the user's Discord id, voice, channels) is in settings.
import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { discordTokenHas, discordTokenSet } from "../lib/native";
import { state } from "../state/store";
import { toast } from "../state/ui";
import { DEFAULT_VOICE, onAgentStatus, setAgent, startAgent, stopAgent, type AgentStatus } from "../engine/discord";
import { knownHub, takeHere } from "../engine/agentHub";
import { hostName } from "../engine/hosts";
import { mirror } from "../state/mirror";
import { Logo } from "../ui/Logos";
import { GroupTitle, PageHead, Row, Switch_ } from "./Settings";
import { TalkRooms, useRooms, WorkPlaces } from "./AgentPlaces";
import { t } from "../i18n";

export function AgentSettings() {
  const a = () => state.settings.agent ?? { on: false, name: "메타몽" };
  const [hasToken, { refetch }] = createResource(discordTokenHas, { initialValue: false });
  const [token, setToken] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [status, setStatus] = createSignal<AgentStatus>({ state: "off" });
  onCleanup(onAgentStatus(setStatus));
  const rooms = useRooms();

  const saveToken = async () => {
    const v = token().trim();
    if (!v) return;
    try {
      await discordTokenSet(v);
      setToken("");
      setEditing(false);
      await refetch();
      toast(t("봇 토큰을 키체인에 넣었어요"));
      if (a().on) void startAgent();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  // another device holds it: 여기서 맡기 takes it once that device let go (agentHub.ts)
  const hub = () => knownHub();
  const [taking, setTaking] = createSignal(false);
  const take = async () => {
    setTaking(true);
    try {
      await takeHere();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setTaking(false);
    }
  };
  const turn = (on: boolean) => {
    if (on) return void take();
    setAgent({ on });
    stopAgent();
  };
  const hubLine = (h: string) => {
    const name = hostName(h);
    if (mirror.hosts[h]?.status !== "ok") return t("{name}이(가) 맡고 있어요. 지금은 연결되지 않았어요", { name });
    return mirror.hosts[h]?.hub?.on ? t("{name}에서 연결돼 있어요", { name }) : t("{name}이(가) 맡고 있어요. 지금은 꺼져 있어요", { name });
  };
  const statusLine = () => {
    const h = hub();
    if (h) return hubLine(h);
    const s = status();
    if (s.state === "on") return t("{name}(으)로 연결돼 있어요", { name: s.name ?? a().name });
    if (s.state === "connecting") return t("연결하는 중이에요");
    if (s.state === "stopped") return s.why ?? t("연결이 멈췄어요");
    return hasToken() ? t("꺼져 있어요") : t("봇 토큰을 넣으면 켤 수 있어요");
  };
  const dot = () => {
    const h = hub();
    if (h) return mirror.hosts[h]?.hub?.on && mirror.hosts[h]?.status === "ok" ? "is-ok" : "";
    return ({ on: "is-ok", connecting: "is-connecting", stopped: "is-denied", off: "" })[status().state];
  };

  return (
    <>
      <PageHead tab="agent" />
      <GroupTitle title={t("디스코드")} />
      <div class="set-group prov-list">
        {/* who it is and whether it's on: one row, like an account */}
        <div class="prov-row ag-head">
          <span class="prov-logo"><Logo name="discord" size={18} mono /></span>
          <div class="prov-text">
            <span class="prov-title">{a().name}</span>
            <span class="prov-sub ag-status" classList={{ bad: status().state === "stopped" }}>
              <span class={`cn-dot ${dot()}`} aria-hidden="true" />
              {statusLine()}
            </span>
          </div>
          <span class="spacer" />
          <Show
            when={hub()}
            fallback={<Switch_ on={a().on} set={(on) => (hasToken() ? turn(on) : toast(t("먼저 봇 토큰을 넣어 주세요")))} label={t("디스코드에서 쓰기")} />}
          >
            {(h) => (
              <button
                class="btn sm"
                disabled={taking() || mirror.hosts[h()]?.status !== "ok"}
                title={mirror.hosts[h()]?.status !== "ok" ? t("{name}이(가) 연결돼 있어야 넘겨받을 수 있어요", { name: hostName(h()) }) : t("연결과 기억을 이 기기로 옮겨요")}
                onClick={() => (hasToken() ? void take() : toast(t("먼저 봇 토큰을 넣어 주세요")))}
              >
                {taking() ? t("넘겨받는 중…") : t("여기서 맡기")}
              </button>
            )}
          </Show>
        </div>
        <Row title={t("봇 토큰")} desc={t("Discord 개발자 포털 › Bot에서 복사해요. MESSAGE CONTENT INTENT를 켜 주세요")}>
          <Show
            when={!hasToken() || editing()}
            fallback={
              <div class="set-inline">
                <span class="set-quiet">{t("키체인에 있어요")}</span>
                <button class="btn ghost sm" onClick={() => setEditing(true)}>{t("바꾸기")}</button>
              </div>
            }
          >
            <form
              class="set-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void saveToken();
              }}
            >
              <input class="input" type="password" autocomplete="off" placeholder={t("토큰")} aria-label={t("봇 토큰")} value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
              <Show when={token().trim()}>
                <button class="btn sm" type="submit">{t("저장")}</button>
              </Show>
            </form>
          </Show>
        </Row>
        <Row title={t("이름")} desc={t("채널에서 이 이름을 부르면 대답해요")}>
          <input class="input" aria-label={t("이름")} value={a().name} onChange={(e) => setAgent({ name: e.currentTarget.value.trim() || "메타몽" })} />
        </Row>
        <Row title={t("내 디스코드 ID")} desc={t("이 계정의 말만 일로 받아요. 비우면 봇을 만든 계정이에요")}>
          <input class="input" inputmode="numeric" aria-label={t("내 디스코드 ID")} placeholder={t("봇을 만든 계정")} value={a().ownerId ?? ""} onChange={(e) => setAgent({ ownerId: e.currentTarget.value.replace(/\D/g, "") || undefined })} />
        </Row>
      </div>

      <Show when={hub()} fallback={<Groups />}>
        {(h) => <p class="set-quiet ag-far-note">{t("대화와 기억, 설정은 {name}에 있어요. 일은 그 공간이 있는 기기에서 해요", { name: hostName(h()) })}</p>}
      </Show>
    </>
  );

  /** what it does, for the device that holds it (another device's are seen by picking it above) */
  function Groups() {
    return (
    <>
      <WorkPlaces rooms={rooms} />

      <GroupTitle title={t("다른 사람")} />
      <div class="set-group">
        <Row title={t("다른 사람과 대화")} desc={t("다른 사람이 부르면 대화만 해요. 일은 시키지 못하고, 내 일은 들고 있지 않아요")}>
          <Switch_ on={a().others !== false} set={(on) => setAgent({ others: on })} label={t("다른 사람과 대화")} />
        </Row>
        <Show when={a().others !== false}>
          <Row title={t("대화할 채널")} desc={t("비우면 부르는 곳 어디서나")}>
            <TalkRooms rooms={rooms} />
          </Row>
        </Show>
      </div>

      <GroupTitle title={t("말투와 성격")} />
      <div class="set-group">
        <div class="set-row col" data-set={t("말투와 성격")}>
          <textarea class="textarea plain" rows={10} aria-label={t("말투와 성격")} placeholder={DEFAULT_VOICE} value={a().voice ?? ""} onChange={(e) => setAgent({ voice: e.currentTarget.value })} />
        </div>
      </div>
    </>
    );
  }
}
