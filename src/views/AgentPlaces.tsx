// Settings › 에이전트 › 채널마다: work asked in one Discord channel goes to its own workspace and
// account (company work in the company's, a side project on another account), so it doesn't share
// the user's main or the agent's usual account. Channels not listed go by the settings above.
import { createResource, For, Show } from "solid-js";
import { discordChannels, discordGuilds } from "../lib/native";
import { state } from "../state/store";
import type { AgentPlace } from "../state/types";
import { setAgent } from "../engine/discord";
import { accountName } from "../ui/AccountPicker";
import { Icon } from "../ui/Icon";
import { GroupTitle, Row } from "./Settings";
import { t } from "../i18n";

type Room = { id: string; label: string };

/** the text channels of every server the bot is in, "#name · server" */
async function rooms(): Promise<Room[]> {
  const out: Room[] = [];
  for (const g of await discordGuilds().catch(() => [])) {
    for (const c of await discordChannels(g.id).catch(() => [])) if (c.kind === "text") out.push({ id: c.id, label: `#${c.name} · ${g.name}` });
  }
  return out;
}

export function AgentPlaces() {
  const [found] = createResource(() => state.settings.agent?.on, (on) => (on ? rooms() : Promise.resolve([] as Room[])), { initialValue: [] });
  const list = () => state.settings.agent?.places ?? [];
  const save = (next: AgentPlace[]) => setAgent({ places: next });
  const at = (i: number, p: Partial<AgentPlace>) => save(list().map((x, j) => (j === i ? { ...x, ...p } : x)));
  const base = () => state.settings.agent?.space ?? state.spaces[0]?.id;
  const open = () => found().filter((r) => !list().some((p) => p.channel === r.id));
  const add = () => {
    const r = open()[0];
    if (r) save([...list(), { channel: r.id, label: r.label, space: base() }]);
  };
  const labelOf = (p: AgentPlace) => found().find((r) => r.id === p.channel)?.label ?? p.label ?? p.channel;
  return (
    <>
      <GroupTitle title={t("채널마다")} />
      <div class="set-group">
        <Show
          when={list().length}
          fallback={
            <Row title={t("채널마다 워크스페이스와 계정")} desc={t("이 채널에서 시킨 일은 이 워크스페이스, 이 계정으로 해요. 없는 채널은 위 설정대로예요")}>
              <span class="set-quiet">{t("모든 채널 같음")}</span>
            </Row>
          }
        >
          <For each={list()}>
            {(p, i) => (
              <Row title={i() ? "" : t("채널마다 워크스페이스와 계정")} desc={i() ? undefined : t("이 채널에서 시킨 일은 이 워크스페이스, 이 계정으로 해요. 없는 채널은 위 설정대로예요")}>
                <div class="set-inline">
                  <select
                    class="select"
                    aria-label={t("채널")}
                    value={p.channel}
                    onChange={(e) => {
                      const r = found().find((x) => x.id === e.currentTarget.value);
                      if (r) at(i(), { channel: r.id, label: r.label });
                    }}
                  >
                    <option value={p.channel}>{labelOf(p)}</option>
                    <For each={open()}>{(r) => <option value={r.id}>{r.label}</option>}</For>
                  </select>
                  <select class="select" aria-label={t("워크스페이스")} value={p.space ?? base() ?? ""} onChange={(e) => at(i(), { space: e.currentTarget.value, account: undefined })}>
                    <For each={state.spaces}>{(s) => <option value={s.id}>{s.label}</option>}</For>
                  </select>
                  <select class="select" aria-label={t("AI 계정")} value={p.account ?? "auto"} onChange={(e) => at(i(), { account: e.currentTarget.value === "auto" ? undefined : e.currentTarget.value })}>
                    <option value="auto">{t("자동")}</option>
                    <For each={state.accounts.filter((x) => x.space === (p.space ?? base()))}>{(x) => <option value={x.id}>{accountName(x, true)}</option>}</For>
                  </select>
                  <button class="icon-btn sm" title={t("빼기")} aria-label={t("빼기")} onClick={() => save(list().filter((_, j) => j !== i()))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              </Row>
            )}
          </For>
        </Show>
        <Show when={open().length}>
          <Row title="">
            <button class="btn ghost sm" onClick={add}>
              {t("채널 추가")}
            </button>
          </Row>
        </Show>
      </div>
    </>
  );
}
