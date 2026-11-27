// 에이전트: the Discord agent's own place (engine/discord.ts → its chat "<space>~@agent").
// What it was told on Discord and what it said, the work it did, what it is asking, and what it
// remembers. View only: the user talks to it on Discord. None of this is in main, the projects,
// 내 차례 or 결과물; work memory is shared. In another device's workspace tab it is that device's
// agent, as that device sends it (engine/remote.ts): seen here; answering its questions and forgetting
// a note go to that device.
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { AGENT_CHAT, chatKey, isAgentChat } from "../engine/captain";
import { onAgentStatus, type AgentStatus } from "../engine/discord";
import { forgetNote } from "../engine/agentMemory";
import { readWays } from "../engine/agentWays";
import { agentDecisions, state, tasksShown } from "../state/store";
import { hostSpaceId, linkWord, mirror, splitSpaceId } from "../state/mirror";
import { messagesIn } from "../state/shared";
import { farForgetNote, hostName } from "../engine/hosts";
import { describeWhen } from "../engine/routineTime";
import { setView } from "../state/ui";
import { setSettingsOf } from "./Settings";
import type { AgentNote, CaptainMessage } from "../state/types";
import { UserMsg } from "../ui/MsgActions";
import { Icon } from "../ui/Icon";
import { keepBottom } from "../ui/stick";
import { inSpace, scrollKept } from "../state/viewState";
import { AskDock, handed, onItsOwn, Reply, shows } from "./MainView";
import { PaneControls } from "./PaneControls";
import { RoutineRow } from "./Routines";
import { agentPart, setAgentPart, type AgentPart } from "./agentPart";
import { AgentJobs, SidebarToggle } from "./Sidebar";
import { t } from "../i18n";

type Part = AgentPart;
const [part, setPart] = [agentPart, setAgentPart];

/** the agent's chat in a space */
export const agentKey = (space = state.space) => chatKey(space, AGENT_CHAT);
/** the agent's work in a space, newest first */
export const agentJobs = (space = state.space) => tasksShown(space).filter((x) => x.agent && !x.parentId && !x.answer).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));

export function AgentView() {
  // another device's workspace: that device's agent
  const host = () => splitSpaceId(state.space)?.host;
  const far = () => (host() ? mirror.hosts[host()!]?.agent : undefined);
  const a = () => (host() ? { name: far()?.name ?? "메타몽" } : (state.settings.agent ?? { on: false, name: "메타몽" }));
  const [own, setOwn] = createSignal<AgentStatus>({ state: "off" });
  onCleanup(onAgentStatus(setOwn));
  const status = (): AgentStatus => (host() ? (far()?.status ?? { state: "off" }) : own());
  const msgs = () => messagesIn(state.space).filter((m) => isAgentChat(chatKey(m.space, m.project)));
  const jobs = createMemo(() => agentJobs());
  const asks = () => agentDecisions(state.space);
  const lastRow = createMemo(() => {
    const at = new Map<string, string>();
    for (const m of msgs()) for (const r of handed(m)) at.set(r.taskId, m.id);
    return at;
  });
  const notes = () => {
    const order = { person: 0, place: 1, lesson: 2 } as const;
    return [...((host() ? far()?.notes : state.agentNotes) ?? [])].sort((x, y) => order[x.kind] - order[y.kind] || (y.updatedAt ?? y.at) - (x.updatedAt ?? x.at));
  };
  // the channel a card is used in; one kept before channels were told apart isn't used (a DM card is, in that DM)
  const noteWhere = (n: AgentNote) => (n.kind === "lesson" ? "" : n.dm ? t("DM") : n.channel ? (n.room ?? "") : t("예전 기억 · 안 씀"));
  const noteLabel = (n: AgentNote) => [n.kind === "person" ? (n.name ?? n.who) : n.kind === "place" ? t("이곳") : t("교훈"), noteWhere(n)].filter(Boolean).join(" · ");
  const statusText = () => {
    // that device isn't connected now: what it last sent shows, its agent's state isn't known
    if (host() && mirror.hosts[host()!]?.status !== "ok") return t(linkWord(mirror.hosts[host()!]));
    const s = status();
    if (s.state === "on") return t("연결됨");
    if (s.state === "connecting") return t("연결하는 중");
    if (s.state === "stopped") return t("멈춤");
    return t("꺼짐");
  };
  // its routines: made on Discord, their runs report there
  const routines = () => (host() ? (far()?.routines ?? []).filter((r) => hostSpaceId(host()!, r.space) === state.space) : (state.routines ?? []).filter((r) => r.agent && r.space === state.space && !r.draft));
  const count = (p: Part) => (p === "talk" ? asks().length : p === "work" ? jobs().filter((x) => x.status === "running" || x.status === "waiting").length : p === "routines" ? routines().filter((r) => r.enabled).length : notes().length);
  const parts: [Part, string][] = [["talk", "대화"], ["work", "작업"], ["routines", "루틴"], ["memory", "기억"]];

  return (
    <div class="view agent-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">
          {a().name}
          <Show when={host()}>{(h) => <span class="head-sub">{hostName(h())}</span>}</Show>
        </h1>
        <span class={`agent-status ${host() && mirror.hosts[host()!]?.status !== "ok" ? "off" : status().state}`} title={status().why ?? ""}>{statusText()}</span>
        <div class="seg sm" role="tablist">
          <For each={parts}>
            {([id, label]) => (
              <button role="tab" aria-selected={part() === id} classList={{ on: part() === id }} onClick={() => setPart(id)}>
                {t(label)}
                <Show when={count(id)}><span class="seg-n">{count(id)}</span></Show>
              </button>
            )}
          </For>
        </div>
        <span class="spacer" data-tauri-drag-region />
        {/* another device's agent: its settings, that device picked */}
        <Show when={!host() || far()?.settings}>
          <button class="icon-btn" title={t("에이전트 설정")} aria-label={t("에이전트 설정")} onClick={() => (setSettingsOf(host()), setView({ name: "settings", tab: "agent" }))}>
            <Icon name="gear" size={16} />
          </button>
        </Show>
        <PaneControls />
      </header>

      <Show when={part() === "talk"}>
        <Show when={msgs().length || asks().length} fallback={<p class="agent-empty">{t("디스코드에서 {name}에게 말을 걸면 여기에 남아요", { name: a().name })}</p>}>
          <div class="thread" ref={(el) => onCleanup(keepBottom(el, undefined, { key: () => inSpace(state.space, "agent/talk") }))}>
            <div class="thread-inner convo">
              <For each={msgs()}>
                {(m: CaptainMessage) => (
                  <Show
                    when={m.from === "me"}
                    fallback={
                      <Show when={!onItsOwn(m) || (!m.pending && shows(m))}>
                        <Reply m={m} retry={() => {}} lastRow={(id) => lastRow().get(id)} />
                      </Show>
                    }
                  >
                    <UserMsg id={m.id} text={m.text ?? ""} at={m.at} from={t("디스코드")} />
                  </Show>
                )}
              </For>
            </div>
          </div>
          <div class="dock">
            <div class="dock-inner">
              <AskDock list={asks()} />
            </div>
          </div>
        </Show>
      </Show>

      <Show when={part() === "work"}>
        <div class="agent-part" ref={scrollKept(() => inSpace(state.space, `agent/${part()}`))}>
          <AgentJobs space={state.space} />
        </div>
      </Show>

      <Show when={part() === "routines"}>
        <div class="agent-part" ref={scrollKept(() => inSpace(state.space, `agent/${part()}`))}>
          <Show when={routines().length} fallback={<p class="agent-empty">{t("디스코드에서 \"매일 9시에 PR 정리해서 알려줘\"처럼 말하면 루틴이 생겨요")}</p>}>
            <div class="set-group agent-routines">
              <For each={routines()}>
                {(r) => (
                  <Show when={host()} fallback={<RoutineRow r={r} />}>
                    {/* that device's: run, changed and turned on or off there */}
                    <div class="rt-row" classList={{ off: !r.enabled }}>
                      <span class="rt-main" title={r.prompt}>
                        <b>{r.title}</b>
                        <span class="rt-sub">{[describeWhen(r.when), r.enabled ? "" : t("꺼짐")].filter(Boolean).join(" · ")}</span>
                      </span>
                    </div>
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={part() === "memory"}>
        <div class="agent-part" ref={scrollKept(() => inSpace(state.space, `agent/${part()}`))}>
          <WaysCard far={host() ? (far()?.ways ?? "") : undefined} />
          <Show when={notes().length} fallback={<p class="agent-empty">{t("아직 기억한 게 없어요")}</p>}>
            <div class="agent-notes">
              <For each={notes()}>
                {(n) => (
                  <div class="agent-note">
                    <div class="agent-note-body">
                      <b>{noteLabel(n)}</b>
                      <span class="agent-note-text selectable">{n.text}</span>
                    </div>
                    {/* another device's agent forgets on that device */}
                    <button class="icon-btn xs" title={t("잊기")} aria-label={t("잊기")} onClick={() => (host() ? void farForgetNote(host()!, n.id) : forgetNote(n.id))}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** The user's own ways for it (agent/AGENT.md), as it keeps them: changed by saying so on Discord.
 *  `far`: another device's agent's, as that device sent them. */
function WaysCard(props: { far?: string }) {
  // read on open, and again now and then while open: it changes when told on Discord
  const [own, { refetch }] = createResource(readWays);
  const tick = setInterval(() => void refetch(), 10_000);
  onCleanup(() => clearInterval(tick));
  const ways = () => (props.far !== undefined ? props.far : own());
  return (
    <div class="agent-ways">
      <b>{t("내 방식")}</b>
      <Show when={ways()} fallback={<p class="agent-empty">{t("디스코드에서 \"멘션 안 해도 들어\", \"보다가 끼어들어\"처럼 말하면 여기에 적어 두고 그대로 해요")}</p>}>
        <p class="agent-ways-text selectable">{ways()}</p>
      </Show>
    </div>
  );
}
