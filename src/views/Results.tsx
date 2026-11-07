// Results: what finished jobs came back with, as main reported them. A list on
// the left (newest first, by day), the report on the right.
import { createMemo, createSignal, For, Show } from "solid-js";
import { resultsIn, resultText } from "../engine/results";
import { projectById, state, taskById } from "../state/store";
import type { ResultEntry } from "../state/types";
import { openTask, setJumpMsg, setView, view } from "../state/ui";
import { BlockView } from "../ui/Blocks";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { SidebarToggle } from "./Sidebar";

const dayOf = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  return days === 0 ? "오늘" : days === 1 ? "어제" : `${d.getMonth() + 1}월 ${d.getDate()}일`;
};
const timeOf = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });

export function ResultsView() {
  const [q, setQ] = createSignal("");
  const all = createMemo(() => resultsIn(state.space));
  const list = createMemo(() => {
    const n = q().trim().toLowerCase();
    return n ? all().filter((r) => resultText(r).toLowerCase().includes(n)) : all();
  });
  const sel = createMemo<ResultEntry | undefined>(() => {
    const v = view();
    const id = v.name === "results" ? v.id : undefined;
    return list().find((r) => r.id === id) ?? list()[0];
  });
  const where = (r: ResultEntry) => projectById(r.project, r.space)?.name ?? "메인";
  const inChat = (r: ResultEntry) => state.captain.some((m) => m.id === r.id);

  return (
    <div class="view res-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">결과</h1>
        <span class="spacer" data-tauri-drag-region />
        <Show when={all().length}>
          <div class="mem-search">
            <Icon name="search" size={13} />
            <input placeholder="찾기" value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
          </div>
        </Show>
      </header>
      <Show when={all().length} fallback={<div class="pane-empty">결과 없음</div>}>
      <div class="res-body">
        <div class="res-list">
          <For each={list()} fallback={<div class="res-empty">찾은 결과가 없어요</div>}>
            {(r, i) => (
              <>
                <Show when={i() === 0 || dayOf(list()[i() - 1].at) !== dayOf(r.at)}>
                  <div class="res-day">{dayOf(r.at)}</div>
                </Show>
                <button class="res-row" classList={{ on: sel()?.id === r.id }} onClick={() => setView({ name: "results", id: r.id })}>
                  <span class="res-title">{r.title}</span>
                  <span class="res-meta">{where(r)} · {timeOf(r.at)}</span>
                </button>
              </>
            )}
          </For>
        </div>
        <div class="res-read">
          <Show when={sel()} keyed>
            {(r) => (
              <article class="res-doc">
                <h2 class="res-head">{r.title}</h2>
                <div class="res-sub">
                  <span>{where(r)} · {dayOf(r.at)} {timeOf(r.at)}</span>
                  <span class="spacer" />
                  <Show when={inChat(r)}>
                    <button class="btn sm ghost" onClick={() => (setJumpMsg(r.id), setView({ name: "main", project: r.project }))}>
                      <Icon name="message" size={13} />채팅에서 보기
                    </button>
                  </Show>
                  <Show when={taskById(r.taskId)}>
                    <button class="btn sm ghost" onClick={() => openTask(r.taskId)}>
                      <Icon name="arrow" size={13} />일 열기
                    </button>
                  </Show>
                </div>
                <div class="reply-body">
                  <Show when={r.reply}><p class="reply-line">{r.reply}</p></Show>
                  <For each={r.answers}>
                    {(a) => (
                      <>
                        <Show when={a.text}><Markdown class="msg-text" text={a.text} /></Show>
                        <Show when={a.blocks.length}><div class="blocks"><For each={a.blocks}>{(b) => <BlockView block={b} />}</For></div></Show>
                      </>
                    )}
                  </For>
                </div>
              </article>
            )}
          </Show>
        </div>
      </div>
      </Show>
    </div>
  );
}
