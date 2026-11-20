// Settings › 에이전트: Ondra on Discord (engine/discord.ts). The bot token goes to the keychain and
// never comes back here; the rest (name, the user's Discord id, voice, channels) is in settings.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { discordTokenHas, discordTokenSet } from "../lib/native";
import { state } from "../state/store";
import { toast } from "../state/ui";
import { DEFAULT_VOICE, onAgentStatus, setAgent, startAgent, stopAgent, type AgentStatus } from "../engine/discord";
import { forgetNote } from "../engine/agentMemory";
import type { AgentNote } from "../state/types";
import { Icon } from "../ui/Icon";
import { GroupTitle, PageHead, Row, Switch_ } from "./Settings";
import { t } from "../i18n";

export function AgentSettings() {
  const a = () => state.settings.agent ?? { on: false, name: "메타몽" };
  const [hasToken, { refetch }] = createResource(discordTokenHas, { initialValue: false });
  const [token, setToken] = createSignal("");
  const [status, setStatus] = createSignal<AgentStatus>({ state: "off" });
  onCleanup(onAgentStatus(setStatus));

  const saveToken = async () => {
    const v = token().trim();
    if (!v) return;
    try {
      await discordTokenSet(v);
      setToken("");
      await refetch();
      toast(t("봇 토큰을 키체인에 넣었어요"));
      if (a().on) void startAgent();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const turn = (on: boolean) => {
    setAgent({ on });
    if (on) void startAgent();
    else stopAgent();
  };
  const statusLine = () => {
    const s = status();
    if (s.state === "on") return t("{name}(으)로 연결돼 있어요", { name: s.name ?? a().name });
    if (s.state === "connecting") return t("연결하는 중이에요");
    if (s.state === "stopped") return s.why ?? t("연결이 멈췄어요");
    return t("꺼져 있어요");
  };
  const channels = () => (a().channels ?? []).join(", ");
  // people first, then places, then lessons; newest first in each
  const notes = () => {
    const order = { person: 0, place: 1, lesson: 2 } as const;
    return [...(state.agentNotes ?? [])].sort((x, y) => order[x.kind] - order[y.kind] || (y.updatedAt ?? y.at) - (x.updatedAt ?? x.at));
  };
  const noteLabel = (n: AgentNote) => (n.kind === "person" ? `${n.name ?? n.who}${n.dm ? ` · ${t("DM")}` : ""}` : n.kind === "place" ? t("이곳") : t("교훈"));

  return (
    <>
      <PageHead tab="agent" />
      <GroupTitle title={t("디스코드")} />
      <div class="set-group">
        <Row title={t("디스코드에서 쓰기")}>
          {/* where it stands is state, not a description: next to the switch, and only when there is one */}
          <Show when={status().state !== "off"}><span class="set-note" classList={{ bad: status().state === "stopped" }}>{statusLine()}</span></Show>
          <Switch_ on={a().on} set={(on) => (hasToken() ? turn(on) : toast(t("먼저 봇 토큰을 넣어 주세요")))} label={t("디스코드에서 쓰기")} />
        </Row>
        <Row title={t("봇 토큰")} desc={hasToken() ? t("키체인에 있어요. 바꾸려면 새 토큰을 넣어요") : t("Discord 개발자 포털 › Bot에서 복사해요. MESSAGE CONTENT INTENT를 켜 주세요")}>
          <form
            class="set-inline"
            onSubmit={(e) => {
              e.preventDefault();
              void saveToken();
            }}
          >
            <input class="input" type="password" autocomplete="off" placeholder={hasToken() ? "••••••••" : t("토큰")} aria-label={t("봇 토큰")} value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
            <Show when={token().trim()}>
              <button class="btn sm" type="submit">{t("저장")}</button>
            </Show>
          </form>
        </Row>
        <Row title={t("이름")} desc={t("채널에서 이 이름을 부르면 대답해요")}>
          <input class="input" aria-label={t("이름")} value={a().name} onChange={(e) => setAgent({ name: e.currentTarget.value.trim() || "메타몽" })} />
        </Row>
        <Row title={t("내 디스코드 ID")} desc={t("이 계정의 말만 일로 받아요. 비우면 봇을 만든 계정이에요")}>
          <input class="input" inputmode="numeric" aria-label={t("내 디스코드 ID")} placeholder="123456789012345678" value={a().ownerId ?? ""} onChange={(e) => setAgent({ ownerId: e.currentTarget.value.replace(/\D/g, "") || undefined })} />
        </Row>
        <Row title={t("일을 받을 워크스페이스")}>
          <select class="select" aria-label={t("일을 받을 워크스페이스")} value={a().space ?? state.spaces[0]?.id ?? ""} onChange={(e) => setAgent({ space: e.currentTarget.value })}>
            <For each={state.spaces}>{(s) => <option value={s.id}>{s.label}</option>}</For>
          </select>
        </Row>
        <Row title={t("다른 사람과 대화")} desc={t("다른 사람이 부르면 대화만 해요. 일은 시키지 못하고, 내 일은 들고 있지 않아요")}>
          <Switch_ on={a().others !== false} set={(on) => setAgent({ others: on })} label={t("다른 사람과 대화")} />
        </Row>
        <Row title={t("대화할 채널")} desc={t("채널 ID를 쉼표로. 비우면 부르는 곳 어디서나")}>
          <input class="input" aria-label={t("대화할 채널")} value={channels()} onChange={(e) => setAgent({ channels: e.currentTarget.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) })} />
        </Row>
      </div>

      <GroupTitle title={t("말투와 성격")} />
      <div class="set-group">
        <div class="set-row col" data-set={t("말투와 성격")}>
          <textarea
            class="textarea plain"
            rows={10}
            aria-label={t("말투와 성격")}
            placeholder={DEFAULT_VOICE}
            value={a().voice ?? ""}
            onChange={(e) => setAgent({ voice: e.currentTarget.value })}
          />
        </div>
      </div>

      <GroupTitle title={t("기억")} />
      <div class="set-group agent-notes">
        <For each={notes()} fallback={<div class="set-row"><span class="set-note">{t("아직 기억한 게 없어요")}</span></div>}>
          {(n) => (
            <div class="set-row agent-note" data-set={t("기억")}>
              <div class="set-label">
                <b>{noteLabel(n)}</b>
                <span class="agent-note-text selectable">{n.text}</span>
              </div>
              <button class="icon-btn xs" title={t("잊기")} aria-label={t("잊기")} onClick={() => forgetNote(n.id)}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
        </For>
      </div>
    </>
  );
}
