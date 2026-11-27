// Settings › 에이전트: where its work goes (none, or a workspace of this device or a connected one,
// for every channel or per channel and DM) and where it talks with others. Channels are picked from
// the servers the bot is in, and the user's DM with it.
import { createResource, createSignal, For, Show, type Accessor } from "solid-js";
import { discordChannels, discordGuilds } from "../lib/native";
import { state } from "../state/store";
import type { AgentPlace, SpaceId } from "../state/types";
import { ownerDmChannel, setAgent } from "../engine/discord";
import { agentHome, placeChoices, placeFor } from "../engine/agentPlaces";
import { hostName } from "../engine/hosts";
import { accountName } from "../ui/AccountPicker";
import { Icon } from "../ui/Icon";
import { GroupTitle } from "./Settings";
import { t } from "../i18n";

export type Room = { id: string; name: string; server: string; dm?: boolean };

/** the user's DM with it, then the text channels of every server the bot is in */
async function rooms(): Promise<Room[]> {
  const out: Room[] = [];
  // outside the app (or a failed call) there are none, not an error
  const dm = await ownerDmChannel().catch(() => undefined);
  if (dm) out.push({ id: dm, name: t("내 DM"), server: "", dm: true });
  for (const g of (await discordGuilds().catch(() => [])) ?? []) {
    for (const c of (await discordChannels(g.id).catch(() => [])) ?? []) if (c.kind === "text") out.push({ id: c.id, name: c.name, server: g.name });
  }
  return out;
}
export function useRooms(): Accessor<Room[]> {
  const [found] = createResource(() => state.settings.agent?.on, (on) => (on ? rooms() : Promise.resolve([] as Room[])), { initialValue: [] });
  return () => found() ?? [];
}

/** "#orbit" and its server, from what the bot sees now or what was saved with it */
function roomName(rooms: Room[], id: string, saved?: string): { name: string; server?: string; dm?: boolean } {
  const r = rooms.find((x) => x.id === id);
  if (r) return r.dm ? { name: r.name, dm: true } : { name: `#${r.name}`, server: r.server };
  const [name, server] = (saved ?? id).split(" · ");
  return name.startsWith("#") || server ? { name: name.startsWith("#") ? name : `#${name}`, server } : { name, dm: true };
}
/** how a room is listed in a picker */
const roomLabel = (r: Room) => (r.dm ? r.name : `#${r.name} · ${r.server}`);

/** this device's name in the place picker, as the Mac bar has it */
const thisName = () => state.settings.thisMac?.name || t("이 기기");

/**
 * A place (none, or a workspace of this device or a connected one, by device) and the account its
 * chat runs on: in that workspace when it is this device's, else in the one its chat lives in (a
 * place on another device runs its work on that device's accounts: none to pick here).
 */
function Where(props: { space: SpaceId | undefined; account: string | undefined; home: SpaceId; set: (p: { space?: SpaceId; account?: string }) => void }) {
  return (
    <div class="ag-where">
      <select class="select" aria-label={t("워크스페이스")} value={props.space ?? ""} onChange={(e) => props.set({ space: e.currentTarget.value || undefined, account: undefined })}>
        <option value="">{t("없음")}</option>
        <For each={placeChoices(thisName(), hostName)}>
          {(d) => (
            <optgroup label={d.name}>
              <For each={d.spaces}>{(s) => <option value={s.id}>{`${d.name} › ${s.label}`}</option>}</For>
            </optgroup>
          )}
        </For>
      </select>
      <Show when={!state.spaces.find((x) => x.id === props.space)?.host}>
      <select class="select" aria-label={t("AI 계정")} value={props.account ?? "auto"} onChange={(e) => props.set({ space: props.space, account: e.currentTarget.value === "auto" ? undefined : e.currentTarget.value })}>
        <option value="auto">{t("자동")}</option>
        <For each={state.accounts.filter((x) => x.space === props.home)}>{(x) => <option value={x.id}>{accountName(x, true)}</option>}</For>
      </select>
      </Show>
    </div>
  );
}

/** a channel picker that reads as "+ label": picking one is the add */
function AddRoom(props: { label: string; rooms: Room[]; pick: (r: Room) => void; class?: string }) {
  return (
    <Show when={props.rooms.length}>
      <label class={`prov-add ag-add ${props.class ?? ""}`}>
        <Icon name="plus" size={15} />
        <span>{props.label}</span>
        <select
          aria-label={props.label}
          value=""
          onChange={(e) => {
            const r = props.rooms.find((x) => x.id === e.currentTarget.value);
            e.currentTarget.value = "";
            if (r) props.pick(r);
          }}
        >
          <option value="" disabled>{props.label}</option>
          <For each={props.rooms}>{(r) => <option value={r.id}>{roomLabel(r)}</option>}</For>
        </select>
      </label>
    </Show>
  );
}

/** 일하는 곳: every channel (none by default), and the channels and DMs set apart */
export function WorkPlaces(props: { rooms: Accessor<Room[]> }) {
  const a = () => state.settings.agent ?? { on: false, name: "메타몽" };
  const list = () => a().places ?? [];
  const save = (next: AgentPlace[]) => setAgent({ places: next });
  const at = (i: number, p: Partial<AgentPlace>) => save(list().map((x, j) => (j === i ? { ...x, ...p } : x)));
  const open = () => props.rooms().filter((r) => !list().some((p) => p.channel === r.id));
  const allSub = () => (placeFor(a()).kind === "none" ? t("프로젝트 이름으로 공간을 찾고, 모르면 물어봐요") : list().length ? t("아래 채널 말고 전부") : t("시킨 일은 여기서 해요"));
  return (
    <>
      <GroupTitle title={t("일하는 곳")} />
      <div class="set-group prov-list">
        <div class="prov-row">
          <span class="prov-logo"><Icon name="globe" size={16} /></span>
          <div class="prov-text">
            <span class="prov-title">{t("모든 채널")}</span>
            <span class="prov-sub">{allSub()}</span>
          </div>
          <span class="spacer" />
          <Where space={a().space} account={a().account} home={agentHome(a())} set={(p) => setAgent({ space: p.space, account: p.account })} />
          <span class="ag-gap" />
        </div>
        <For each={list()}>
          {(p, i) => {
            const n = () => roomName(props.rooms(), p.channel, p.label);
            return (
              <div class="prov-row">
                <span class="prov-logo ag-hash">{n().dm ? <Icon name="at" size={15} /> : "#"}</span>
                <div class="prov-text">
                  <span class="prov-title">{n().name.replace(/^#/, "")}</span>
                  <Show when={n().server}><span class="prov-sub">{n().server}</span></Show>
                </div>
                <span class="spacer" />
                <Where space={p.space} account={p.account} home={agentHome(a(), p.channel)} set={(w) => at(i(), w)} />
                <button class="icon-btn sm prov-more" title={t("빼기")} aria-label={t("빼기")} onClick={() => save(list().filter((_, j) => j !== i()))}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            );
          }}
        </For>
        <AddRoom label={t("채널 따로 정하기")} rooms={open()} pick={(r) => save([...list(), { channel: r.id, label: r.dm ? r.name : `#${r.name} · ${r.server}` }])} />
      </div>
    </>
  );
}

/** the channels it talks with others in, as chips; none = wherever it is called */
export function TalkRooms(props: { rooms: Accessor<Room[]> }) {
  const ids = () => state.settings.agent?.channels ?? [];
  const [typing, setTyping] = createSignal("");
  const add = (id: string) => id && !ids().includes(id) && setAgent({ channels: [...ids(), id] });
  return (
    <div class="ag-chips">
      <Show when={ids().length} fallback={<span class="set-quiet">{t("부르는 곳 어디서나")}</span>}>
        <For each={ids()}>
          {(id) => (
            <span class="ag-chip">
              {roomName(props.rooms(), id).name}
              <button class="ag-chip-x" title={t("빼기")} aria-label={t("빼기")} onClick={() => setAgent({ channels: ids().filter((x) => x !== id) })}>
                <Icon name="x" size={11} />
              </button>
            </span>
          )}
        </For>
      </Show>
      <Show
        when={props.rooms().length}
        fallback={
          // the bot isn't on (no list to pick from): an id still goes in
          <input
            class="input ag-id"
            inputmode="numeric"
            placeholder={t("채널 ID")}
            aria-label={t("채널 ID")}
            value={typing()}
            onInput={(e) => setTyping(e.currentTarget.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && (add(typing()), setTyping(""))}
          />
        }
      >
        <label class="ag-chip ag-chip-add" title={t("채널 추가")}>
          <Icon name="plus" size={12} />
          <select
            aria-label={t("채널 추가")}
            value=""
            onChange={(e) => {
              add(e.currentTarget.value);
              e.currentTarget.value = "";
            }}
          >
            <option value="" disabled>{t("채널 추가")}</option>
            <For each={props.rooms().filter((r) => !r.dm && !ids().includes(r.id))}>{(r) => <option value={r.id}>{roomLabel(r)}</option>}</For>
          </select>
        </label>
      </Show>
    </div>
  );
}
