// Results: what finished jobs came back with, as main reported them. A list on
// the left (pinned first, then newest by day), the report on the right.
// Pick several with ⌘/⇧-click; ⌫ removes them (with undo), ↑↓ move.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { pinResult, removeResults, restoreResults, resultCopy, resultPreview, resultsIn, resultText } from "../engine/results";
import { ignoredKey } from "../lib/shortcuts";
import { projectById, state, taskById } from "../state/store";
import type { ResultEntry } from "../state/types";
import { openTask, setJumpMsg, setView, toast, view } from "../state/ui";
import { BlockView } from "../ui/Blocks";
import { discarded, withDiff } from "../state/progress";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { ProjectBadge } from "../ui/ProjectBadge";
import { anyPop, closePops } from "../ui/ModelPicker";
import { SidebarToggle } from "./Sidebar";
import { lang, t } from "../i18n";

const locale = () => (lang() === "en" ? "en-US" : "ko-KR");
/** days back from today: 0 today, 1 yesterday */
const daysAgo = (at: number) => {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((start(new Date()) - start(new Date(at))) / 86_400_000);
};
const dayOf = (at: number) => {
  const days = daysAgo(at);
  return days === 0 ? t("오늘") : days === 1 ? t("어제") : new Date(at).toLocaleDateString(locale(), { month: "short", day: "numeric" });
};
const timeOf = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
const whenOf = (at: number) => (daysAgo(at) === 0 ? timeOf(at) : dayOf(at));

export function ResultsView() {
  const [q, setQ] = createSignal("");
  const [proj, setProj] = createSignal<string>("");
  const [picked, setPicked] = createSignal<string[]>([]);
  const [anchor, setAnchor] = createSignal<string>();
  const [menu, setMenu] = createSignal<{ id: string; x: number; y: number } | null>(null);
  let listEl: HTMLDivElement | undefined;
  let searchEl: HTMLInputElement | undefined;

  /** a discarded task's work is gone: its result isn't listed */
  const all = createMemo(() => resultsIn(state.space).filter((r) => {
    const task = taskById(r.taskId);
    return !task || !discarded(task);
  }));
  /** the project of the task a result came from (as the sidebar files it); none: 기타 */
  const projectOf = (r: ResultEntry) => {
    const task = taskById(r.taskId);
    const id = task ? task.project : r.project;
    return projectById(id, r.space) ? id : undefined;
  };
  const where = (r: ResultEntry) => projectById(projectOf(r), r.space)?.name ?? t("기타");
  /** the places results came from, for the filter (only when there is more than one) */
  const places = createMemo(() => {
    const seen = new Map<string, string>();
    for (const r of all()) seen.set(projectOf(r) ?? "", where(r));
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => Number(!a.id) - Number(!b.id) || a.name.localeCompare(b.name));
  });
  const list = createMemo(() => {
    const n = q().trim().toLowerCase();
    const p = proj();
    const l = all().filter((r) => (!p || (projectOf(r) ?? "") === p.slice(1)) && (!n || resultText(r).toLowerCase().includes(n)));
    return [...l.filter((r) => r.pinned), ...l.filter((r) => !r.pinned)];
  });
  const sel = createMemo<ResultEntry | undefined>(() => {
    const v = view();
    const id = v.name === "results" ? v.id : undefined;
    return list().find((r) => r.id === id) ?? list()[0];
  });
  /** what an action applies to: the picked rows, or the one in view */
  const targets = () => (picked().length > 1 ? picked() : sel() ? [sel()!.id] : []);
  const many = () => picked().length > 1;
  const inChat = (r: ResultEntry) => state.captain.some((m) => m.id === r.id);
  const group = (r: ResultEntry) => (r.pinned ? t("고정됨") : dayOf(r.at));

  const go = (id: string) => {
    setView({ name: "results", id });
    setPicked([id]);
    setAnchor(id);
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const click = (e: MouseEvent, r: ResultEntry) => {
    if (e.metaKey || e.ctrlKey) {
      const base = picked().length ? picked() : sel() ? [sel()!.id] : [];
      const next = base.includes(r.id) ? base.filter((x) => x !== r.id) : [...base, r.id];
      setPicked(next);
      setAnchor(r.id);
      if (next.length === 1) setView({ name: "results", id: next[0] });
      return;
    }
    if (e.shiftKey && (anchor() ?? sel()?.id)) {
      const ids = list().map((x) => x.id);
      const a = ids.indexOf(anchor() ?? sel()!.id);
      const b = ids.indexOf(r.id);
      setPicked(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
      return;
    }
    go(r.id);
  };

  const remove = (ids: string[]) => {
    if (!ids.length) return;
    const order = list().map((r) => r.id);
    const after = order.slice(order.indexOf(ids[ids.length - 1]) + 1).find((id) => !ids.includes(id)) ?? [...order].reverse().find((id) => !ids.includes(id));
    const gone = removeResults(ids);
    setPicked([]);
    setMenu(null);
    if (after) go(after);
    toast(gone.length > 1 ? t("{n}개 삭제했어요", { n: gone.length }) : t("삭제했어요"), "info", { label: t("되돌리기"), run: () => restoreResults(gone) });
  };
  const copy = async (r: ResultEntry) => {
    try {
      await navigator.clipboard.writeText(resultCopy(r));
      toast(t("복사했어요"));
    } catch {
      /* clipboard can be blocked */
    }
  };
  const pin = (ids: string[]) => {
    const on = !ids.every((id) => all().find((r) => r.id === id)?.pinned);
    for (const id of ids) pinResult(id, on);
  };

  const keys = (e: KeyboardEvent) => {
    if (e.key === "f" && e.metaKey && !e.shiftKey) return e.preventDefault(), searchEl?.focus();
    if (ignoredKey(e) || menu()) return;
    const l = list();
    const i = l.findIndex((r) => r.id === sel()?.id);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = l[Math.max(0, Math.min(l.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (!next) return;
      if (e.shiftKey) {
        const ids = l.map((x) => x.id);
        const a = ids.indexOf(anchor() ?? sel()!.id);
        const b = ids.indexOf(next.id);
        setPicked(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
        setView({ name: "results", id: next.id });
      } else go(next.id);
    } else if ((e.key === "Backspace" || e.key === "Delete") && !e.altKey) {
      e.preventDefault();
      remove(targets());
    } else if (e.key === "a" && e.metaKey) {
      e.preventDefault();
      setPicked(l.map((r) => r.id));
    } else if (e.key === "Escape" && many()) {
      e.preventDefault();
      if (sel()) setPicked([sel()!.id]);
    } else if (e.key === "Enter" && sel() && taskById(sel()!.taskId)) {
      e.preventDefault();
      openTask(sel()!.taskId);
    }
  };

  const closeMenu = () => setMenu(null);
  window.addEventListener("click", closeMenu);
  window.addEventListener("blur", closeMenu);
  createEffect(() => anyPop() && closeMenu());
  onCleanup(() => {
    window.removeEventListener("click", closeMenu);
    window.removeEventListener("blur", closeMenu);
  });
  // a filter or search that hides picked rows drops them
  createEffect(() => {
    const ids = new Set(list().map((r) => r.id));
    if (picked().some((id) => !ids.has(id))) setPicked(picked().filter((id) => ids.has(id)));
  });

  const Tool = (p: { icon: string; label: string; on?: boolean; danger?: boolean; run: () => void }) => (
    <button class="res-tool" classList={{ on: p.on, danger: p.danger }} title={p.label} aria-label={p.label} onClick={p.run}>
      <Icon name={p.icon} size={16} />
    </button>
  );

  return (
    <div class="view res-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">{t("결과물")}</h1>
        <Show when={all().length}>
          <span class="res-count">{all().length}</span>
        </Show>
        <span class="spacer" data-tauri-drag-region />
        <Show when={places().length > 1}>
          <div class="res-seg" role="group" aria-label={t("프로젝트")}>
            <button classList={{ on: !proj() }} aria-pressed={!proj()} onClick={() => setProj("")}>{t("전체")}</button>
            <For each={places()}>{(p) => <button classList={{ on: proj() === `:${p.id}` }} aria-pressed={proj() === `:${p.id}`} onClick={() => setProj(`:${p.id}`)}>{p.name}</button>}</For>
          </div>
        </Show>
        <Show when={all().length}>
          <div class="mem-search">
            <Icon name="search" size={14} />
            <input ref={searchEl} placeholder={t("검색")} aria-label={t("검색")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === "Escape" && (setQ(""), listEl?.focus())} />
          </div>
        </Show>
      </header>
      <Show when={all().length} fallback={<div class="pane-empty res-none"><Icon name="inbox" size={20} /><span>{t("결과물 없음")}</span></div>}>
        <div class="res-body">
          <div class="res-list" ref={listEl} tabIndex={0} onKeyDown={keys}>
            <For each={list()} fallback={<div class="res-empty">{t("검색 결과 없음")}</div>}>
              {(r, i) => (
                <>
                  <Show when={i() === 0 || group(list()[i() - 1]) !== group(r)}>
                    <div class="res-day">{group(r)}</div>
                  </Show>
                  <div
                    class="res-row"
                    role="button"
                    data-id={r.id}
                    classList={{ on: many() ? picked().includes(r.id) : sel()?.id === r.id, cur: many() && sel()?.id === r.id, menu: menu()?.id === r.id }}
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                    onClick={(e) => (click(e, r), listEl?.focus())}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      closePops();
                      if (!picked().includes(r.id)) go(r.id);
                      setMenu({ id: r.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <div class="res-r1">
                      <span class="res-title">{r.title}</span>
                      <Show when={r.pinned}>
                        <Icon name="pin" size={12} class="res-pin" />
                      </Show>
                      {/* under a day's header only the time; pinned rows have no day header */}
                      <span class="res-time">{r.pinned ? whenOf(r.at) : timeOf(r.at)}</span>
                      <span class="res-acts">
                        <button class="res-act" classList={{ on: r.pinned }} title={r.pinned ? t("고정 해제") : t("고정")} aria-label={r.pinned ? t("고정 해제") : t("고정")} onClick={(e) => (e.stopPropagation(), pinResult(r.id, !r.pinned))}>
                          <Icon name="pin" size={14} />
                        </button>
                        <button class="res-act" title={t("삭제")} aria-label={t("삭제")} onClick={(e) => (e.stopPropagation(), remove([r.id]))}>
                          <Icon name="trash" size={14} />
                        </button>
                      </span>
                    </div>
                    <Show when={resultPreview(r)}>
                      <p class="res-prev">{resultPreview(r)}</p>
                    </Show>
                    <span class="res-where"><Show when={projectOf(r)}><ProjectBadge name={where(r)} /></Show>{where(r)}</span>
                  </div>
                </>
              )}
            </For>
          </div>
          <div class="res-read">
            <Show
              when={!many()}
              fallback={
                <div class="res-many">
                  <b>{t("{n}개 선택됨", { n: picked().length })}</b>
                  <div class="res-many-acts">
                    <button class="btn sm ghost" onClick={() => pin(picked())}>
                      <Icon name="pin" size={14} />
                      {picked().every((id) => all().find((r) => r.id === id)?.pinned) ? t("고정 해제") : t("고정")}
                    </button>
                    <button class="btn sm ghost danger" onClick={() => remove(picked())}>
                      <Icon name="trash" size={14} />
                      {t("삭제")}
                    </button>
                  </div>
                </div>
              }
            >
              <Show when={sel()} keyed>
                {(r) => (
                  <article class="res-doc">
                    <div class="res-top">
                      <div class="res-top-l">
                        <h2 class="res-head">{r.title}</h2>
                        <div class="res-sub">
                          {where(r)} · {dayOf(r.at)} {timeOf(r.at)}
                        </div>
                      </div>
                      <div class="res-tools">
                        <Show when={taskById(r.taskId)}>
                          <button class="btn sm res-open" title={`${t("작업 열기")} ⏎`} onClick={() => openTask(r.taskId)}>
                            {t("작업 열기")}
                          </button>
                        </Show>
                        <Tool icon="pin" label={r.pinned ? t("고정 해제") : t("고정")} on={r.pinned} run={() => pinResult(r.id, !r.pinned)} />
                        <Tool icon="copy" label={t("복사")} run={() => void copy(r)} />
                        <Show when={inChat(r)}>
                          <Tool icon="message" label={t("대화에서 보기")} run={() => (setJumpMsg(r.id), setView({ name: "main", project: r.project }))} />
                        </Show>
                        <span class="res-tools-sep" />
                        <Tool icon="trash" label={t("삭제")} danger run={() => remove([r.id])} />
                      </div>
                    </div>
                    <div class="reply-body">
                      <Show when={r.reply}>
                        <p class="reply-line">{r.reply}</p>
                      </Show>
                      <For each={r.answers}>
                        {(a) => (
                          <>
                            <Show when={a.text}>
                              <Markdown class="msg-text" text={a.text} />
                            </Show>
                            <Show when={a.blocks.length}>
                              <div class="blocks">
                                <For each={a.blocks}>{(b) => <BlockView block={withDiff(b, taskById(r.taskId))} />}</For>
                              </div>
                            </Show>
                          </>
                        )}
                      </For>
                    </div>
                  </article>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={menu()}>
        {(m) => {
          const r = () => all().find((x) => x.id === m().id);
          const ids = () => (picked().includes(m().id) && many() ? picked() : [m().id]);
          return (
            <Show when={r()}>
              <div class="menu ctx-menu" style={{ left: `${Math.min(m().x, window.innerWidth - 220)}px`, top: `${Math.min(m().y, window.innerHeight - 200)}px` }} onClick={(e) => e.stopPropagation()}>
                <Show when={ids().length === 1}>
                  <Show when={taskById(r()!.taskId)}>
                    <button onClick={() => (openTask(r()!.taskId), closeMenu())}>
                      <Icon name="arrow" size={14} class="muted" />
                      <span class="row-title">{t("작업 열기")}</span>
                    </button>
                  </Show>
                  <Show when={inChat(r()!)}>
                    <button onClick={() => (setJumpMsg(r()!.id), setView({ name: "main", project: r()!.project }), closeMenu())}>
                      <Icon name="message" size={14} class="muted" />
                      <span class="row-title">{t("대화에서 보기")}</span>
                    </button>
                  </Show>
                  <button onClick={() => (void copy(r()!), closeMenu())}>
                    <Icon name="copy" size={14} class="muted" />
                    <span class="row-title">{t("복사")}</span>
                  </button>
                </Show>
                <button onClick={() => (pin(ids()), closeMenu())}>
                  <Icon name="pin" size={14} class="muted" />
                  <span class="row-title">{ids().every((id) => all().find((x) => x.id === id)?.pinned) ? t("고정 해제") : t("고정")}</span>
                </button>
                <div class="menu-sep" />
                <button class="danger" onClick={() => remove(ids())}>
                  <Icon name="trash" size={14} class="muted" />
                  <span class="row-title">{ids().length > 1 ? t("{n}개 삭제", { n: ids().length }) : t("삭제")}</span>
                  <kbd class="menu-kbd">⌫</kbd>
                </button>
              </div>
            </Show>
          );
        }}
      </Show>
    </div>
  );
}
