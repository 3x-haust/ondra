// 에이전트: the Discord agent's own place (engine/discord.ts → its chat "<space>~@agent").
// What it was told on Discord and what it said, the work it did, what it is asking, and what it
// remembers. View only: the user talks to it on Discord. None of this is in main, the projects,
// 내 차례 or 결과물; work memory is shared.
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { AGENT_CHAT, chatKey, inChat } from "../engine/captain";
import { onAgentStatus, type AgentStatus } from "../engine/discord";
import { forgetNote } from "../engine/agentMemory";
import { readWays } from "../engine/agentWays";
import { agentDecisions, state } from "../state/store";
import { setView } from "../state/ui";
import type { AgentNote, CaptainMessage } from "../state/types";
import { UserMsg } from "../ui/MsgActions";
import { Icon } from "../ui/Icon";
import { keepBottom } from "../ui/stick";
import { AskDock, handed, onItsOwn, ProjectTasks, Reply, shows } from "./MainView";
import { PaneControls } from "./PaneControls";
import { RoutineRow } from "./Routines";
import { SidebarToggle } from "./Sidebar";
import { t } from "../i18n";

type Part = "talk" | "work" | "routines" | "memory";
const [part, setPart] = createSignal<Part>("talk");

/** the agent's chat in a space */
export const agentKey = (space = state.space) => chatKey(space, AGENT_CHAT);
/** the agent's work in a space, newest first */
export const agentJobs = (space = state.space) => state.tasks.filter((x) => x.agent && x.space === space && !x.parentId && !x.answer).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));

export function AgentView() {
  const a = () => state.settings.agent ?? { on: false, name: "메타몽" };
  const [status, setStatus] = createSignal<AgentStatus>({ state: "off" });
  onCleanup(onAgentStatus(setStatus));
  const msgs = () => state.captain.filter((m) => inChat(m, agentKey()));
  const jobs = createMemo(() => agentJobs());
  const asks = () => agentDecisions().filter((d) => state.tasks.find((x) => x.id === d.taskId)?.space === state.space);
  const lastRow = createMemo(() => {
    const at = new Map<string, string>();
    for (const m of msgs()) for (const r of handed(m)) at.set(r.taskId, m.id);
    return at;
  });
  const notes = () => {
    const order = { person: 0, place: 1, lesson: 2 } as const;
    return [...(state.agentNotes ?? [])].sort((x, y) => order[x.kind] - order[y.kind] || (y.updatedAt ?? y.at) - (x.updatedAt ?? x.at));
  };
  const noteLabel = (n: AgentNote) => (n.kind === "person" ? `${n.name ?? n.who}${n.dm ? ` · ${t("DM")}` : ""}` : n.kind === "place" ? t("이곳") : t("교훈"));
  const statusText = () => {
    const s = status();
    if (s.state === "on") return t("연결됨");
    if (s.state === "connecting") return t("연결하는 중");
    if (s.state === "stopped") return t("멈춤");
    return t("꺼짐");
  };
  // its routines: made on Discord, their runs report there
  const routines = () => (state.routines ?? []).filter((r) => r.agent && r.space === state.space && !r.draft);
  const count = (p: Part) => (p === "talk" ? asks().length : p === "work" ? jobs().filter((x) => x.status === "running" || x.status === "waiting").length : p === "routines" ? routines().filter((r) => r.enabled).length : notes().length);
  const parts: [Part, string][] = [["talk", "대화"], ["work", "작업"], ["routines", "루틴"], ["memory", "기억"]];

  return (
    <div class="view agent-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">{a().name}</h1>
        <span class={`agent-status ${status().state}`} title={status().why ?? ""}>{statusText()}</span>
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
        <button class="icon-btn" title={t("에이전트 설정")} aria-label={t("에이전트 설정")} onClick={() => setView({ name: "settings", tab: "agent" })}>
          <Icon name="gear" size={16} />
        </button>
        <PaneControls />
      </header>

      <Show when={part() === "talk"}>
        <Show when={msgs().length || asks().length} fallback={<p class="agent-empty">{t("디스코드에서 {name}에게 말을 걸면 여기에 남아요", { name: a().name })}</p>}>
          <div class="thread" ref={(el) => onCleanup(keepBottom(el))}>
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
        <div class="agent-part">
          <ProjectTasks list={jobs()} />
        </div>
      </Show>

      <Show when={part() === "routines"}>
        <div class="agent-part">
          <Show when={routines().length} fallback={<p class="agent-empty">{t("디스코드에서 \"매일 9시에 PR 정리해서 알려줘\"처럼 말하면 루틴이 생겨요")}</p>}>
            <div class="set-group agent-routines">
              <For each={routines()}>{(r) => <RoutineRow r={r} />}</For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={part() === "memory"}>
        <div class="agent-part">
          <WaysCard />
          <Show when={notes().length} fallback={<p class="agent-empty">{t("아직 기억한 게 없어요")}</p>}>
            <div class="agent-notes">
              <For each={notes()}>
                {(n) => (
                  <div class="agent-note">
                    <div class="agent-note-body">
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
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** The user's own ways for it (agent/AGENT.md), as it keeps them: changed by saying so on Discord. */
function WaysCard() {
  // read on open, and again now and then while open: it changes when told on Discord
  const [ways, { refetch }] = createResource(readWays);
  const tick = setInterval(() => void refetch(), 10_000);
  onCleanup(() => clearInterval(tick));
  return (
    <div class="agent-ways">
      <b>{t("내 방식")}</b>
      <Show when={ways()} fallback={<p class="agent-empty">{t("디스코드에서 \"멘션 안 해도 들어\", \"보다가 끼어들어\"처럼 말하면 여기에 적어 두고 그대로 해요")}</p>}>
        <p class="agent-ways-text selectable">{ways()}</p>
      </Show>
    </div>
  );
}
