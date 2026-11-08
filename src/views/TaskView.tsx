// One job: title and state, the transcript, whatever waits on you docked
import { holdScroll } from "../ui/stick";
// above its own input, and the side panel (changes / files / terminal / web).
import { Fold } from "../ui/Fold";
import { createEffect, createSignal, For, type JSX, on, onMount, Show, untrack } from "solid-js";
import { decisionFor, homeDir, projectById, state, taskById, updateTask } from "../state/store";
import type { Task } from "../state/types";
import { addMemory } from "../engine/memory";
import { usesReverse } from "../engine/reverse";
import { artifacts, loadArtifacts } from "../state/artifacts";
import { BtwCard, btwCommand, drawCommand, plusFor, skillCommands } from "../ui/Aside";
import { goMain, openPanel as showTool, openTask, panelOpen, panelTab, togglePanel, type PanelTab } from "../state/ui";
import { expand, isAlive } from "../engine/rpc";
import { fsFiles } from "../lib/native";
import { planCount, taskDiff, workedMs } from "../state/progress";
import { rawStats, closeWorktree, discardTask, prOf, renameTask, finishTask, mergeTask, stopTask, resumeTask, startTask, setTaskModel, setTaskPermission, steerQueued, dropQueued, editQueued, tell } from "../engine/tasks";
import { ago, compact, IssueTag, now, statusLabel } from "../ui/bits";
import { DecisionCard } from "../ui/DecisionCard";
import { Composer } from "../ui/Composer";
import { Icon } from "../ui/Icon";
import { ProjectBadge } from "../ui/ProjectBadge";
import { ModelPicker, usePop, PermissionPicker } from "../ui/ModelPicker";
import { effortFor } from "../engine/models";
import { StatusLine } from "../ui/Usage";
import { JobEnd, Transcript } from "../ui/Transcript";
import { Glyph, renaming, setRenaming, SidebarToggle } from "./Sidebar";
import { StatusIcon } from "../ui/ForkCard";
import { TaskMenuPanel } from "../ui/taskMenu";
import { t as tr } from "../i18n";

function MoreMenu(props: { id: string }) {
  const [open, setOpen] = usePop();
  return (
    <div style={{ position: "relative" }}>
      <button
        class="icon-btn"
        classList={{ on: open() }}
        title={tr("더 보기")}
        aria-label={tr("더 보기")}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open());
        }}
      >
        <Icon name="more" size={16} />
      </button>
      <Show when={open()}>
        <TaskMenuPanel id={props.id} done={() => setOpen(false)} style={{ top: "36px", right: "0" }} />
      </Show>
    </div>
  );
}

/** The whole to-do list while it works (OmO-style): done, now, next. One line until opened. */
function Todos(props: { t: Task }) {
  const [open, setOpen] = createSignal(false);
  const count = () => planCount(props.t.plan);
  const cur = () => props.t.plan[count().now] ?? props.t.plan.find((p) => p.state !== "done");
  return (
    <div class="todos" classList={{ closed: !open() }}>
      <button class="todos-head" onClick={() => { holdScroll(); setOpen(!open()); }} aria-expanded={open()}>
        <Icon name="list" size={14} />
        <b>{tr("할 일")}</b>
        <span class="num">{count().label}</span>
        <Show when={!open() && cur()}><span class="rest">{cur()!.text}</span></Show>
        <span class="spacer" />
        <Icon name="chevron" size={13} class={`todos-chev ${open() ? "on" : ""}`} />
      </button>
      <Fold open={open()}>
        <ol class="todos-list">
          <For each={props.t.plan}>
            {(p) => (
              <li class={`todo ${p.state}`}>
                <span class="todo-box">
                  <Show when={p.state === "done"} fallback={<Show when={p.state === "now"}><i /></Show>}>
                    <Icon name="check" size={10} stroke={3} />
                  </Show>
                </span>
                <span class="todo-text">{p.text}</span>
              </li>
            )}
          </For>
        </ol>
      </Fold>
    </div>
  );
}

/** Said while it worked: these go in, in order, when the work is done. Like
 *  Codex: one quiet line each, actions on hover (send now, edit, remove). */
function Queued(props: { t: Task }) {
  // a queued message is changed where it is: it keeps its place in line
  const [editing, setEditing] = createSignal<{ id: string; text: string } | null>(null);
  const save = () => {
    const e = editing();
    if (!e) return;
    setEditing(null);
    if (props.t.queue?.some((q) => q.id === e.id)) editQueued(props.t.id, e.id, e.text);
  };
  // it went in while being changed: the change goes to the composer instead of being lost
  createEffect(() => {
    const e = untrack(editing);
    if (e && !props.t.queue?.some((q) => q.id === e.id)) (setEditing(null), setDraft(e.text));
  });
  return (
    <div class="queued">
      <For each={props.t.queue}>
        {(q) => (
          <Show
            when={editing()?.id === q.id}
            fallback={
              <div class="queued-row">
                <Icon name="handoff" size={13} />
                <span class="queued-text" title={q.text} onDblClick={() => setEditing({ id: q.id, text: q.text })}>{q.text}</span>
                <div class="queued-acts">
                  <button class="queued-steer" onClick={() => steerQueued(props.t.id, q.id)}>
                    <Icon name="send" size={12} />
                    {tr("지금 보내기")}
                  </button>
                  <button class="icon-btn sm" title={tr("수정")} onClick={() => setEditing({ id: q.id, text: q.text })}><Icon name="pencil" size={13} /></button>
                  <button class="icon-btn sm" title={tr("삭제")} onClick={() => dropQueued(props.t.id, q.id)}><Icon name="trash" size={13} /></button>
                </div>
              </div>
            }
          >
            <div class="queued-row editing">
              <Icon name="pencil" size={13} />
              <textarea
                class="queued-edit"
                rows={1}
                value={editing()!.text}
                ref={(el) =>
                  queueMicrotask(() => {
                    el.focus();
                    el.setSelectionRange(el.value.length, el.value.length);
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  })
                }
                onInput={(e) => {
                  const el = e.currentTarget;
                  setEditing({ id: q.id, text: el.value });
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.isComposing) return;
                  if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), save());
                  else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setEditing(null));
                }}
                onBlur={save}
              />
              <div class="queued-acts on">
                <button class="icon-btn sm" title={`${tr("저장")} (⏎)`} onMouseDown={(e) => e.preventDefault()} onClick={save}><Icon name="check" size={13} /></button>
                <button class="icon-btn sm" title={`${tr("취소")} (esc)`} onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(null)}><Icon name="x" size={13} /></button>
              </div>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
/** put text back in this view's composer */
function setDraft(text: string) {
  const el = document.querySelector<HTMLTextAreaElement>(".view .dock textarea, .dock textarea");
  if (!el) return;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

export function TaskView(props: { id: string }) {
  const t = () => taskById(props.id);
  return (
    <Show when={t()} fallback={<div class="pane-empty">{tr("삭제된 작업")}</div>}>
      {(task) => {
        const decision = () => decisionFor(task().id);
        const bg = () => task().shells.filter((s) => !s.endedAt && (s.background || task().status !== "running"));
        createEffect(on(() => task().unread, (u) => u && updateTask(task().id, (x) => (x.unread = false))));
        const ready = () => task().worktree?.state === "open" && (task().status === "done" || task().status === "paused" || task().status === "failed");
        const diff = () => taskDiff(task());
        const [merging, setMerging] = createSignal(false);
        const openPanel = (tab: PanelTab) => showTool(tab);
        // with the panel already open, show what matters for this job
        onMount(() => {
          const x = task();
          if (isAlive(`t:${x.id}`)) void rawStats(`t:${x.id}`);
          if (!panelOpen()) return;
          if (x.status === "done" && x.worktree?.state === "open" && panelTab() === "flow") showTool("changes");
          else if (x.browser && x.shot && x.status === "running" && panelTab() === "flow") showTool("browser");
        });
        void loadArtifacts(task().id);
        const strips = () => {
          const out: JSX.Element[] = [];
          if (task().status === "paused")
            out.push(
              <button class="strip" onClick={() => resumeTask(task().id)}>
                <Icon name="pause" size={14} />
                <b>{tr("일시정지")}</b>
                <span class="strip-act"><Icon name="play" size={12} />{tr("다시 시작")}</span>
              </button>,
            );
          const made = artifacts[task().id] ?? [];
          if (made.length && !(panelOpen() && panelTab() === "artifacts"))
            out.push(
              <button class="strip" onClick={() => openPanel("artifacts")}>
                <Icon name="inbox" size={14} />
                <b>{tr("결과물 {n}개", { n: made.length })}</b>
                <span class="rest">{made[0].name}</span>
                <span class="strip-act">{tr("보기")}</span>
              </button>,
            );
          if (bg().length)
            out.push(
              <button class="strip" onClick={() => openPanel("terminal")}>
                <Icon name="terminal" size={14} />
                <b>{tr("백그라운드")}</b>
                <span class="rest"><code>{bg().map((s) => s.command.replace(/\s*&\s*$/, "")).join("  ·  ")}</code></span>
                <Icon name="chevron" size={14} />
              </button>,
            );
          // its work went into a pull request: nothing to merge here, just the PR and tidying up
          const pr = prOf(task());
          if (ready() && pr)
            out.push(
              <div class="strip">
                <Icon name="branch" size={14} />
                <button class="link-btn" onClick={() => openPanel("pr")}>PR #{pr.n}</button>
                <span class="rest" />
                <button class="btn sm ghost" title={tr("변경은 PR에 남아요")} onClick={() => void closeWorktree(task().id)}>{tr("워크트리 정리")}</button>
              </div>,
            );
          // the changes tab already has merge / discard
          else if (ready() && !(panelOpen() && panelTab() === "changes"))
            out.push(
              <div class="strip">
                <Icon name="branch" size={14} />
                <b>{tr("검토")}</b>
                <span class="rest">
                  <Show when={diff().files.length} fallback={tr("변경 없음")}>
                    <button class="link-btn" onClick={() => openPanel("changes")}>
                      {tr("파일 {n}개", { n: diff().files.length })} <span class="add">+{diff().add}</span>{" "}
                      <span class="del">−{diff().del}</span>
                    </button>
                  </Show>
                </span>
                <button class="btn sm ghost" onClick={() => void discardTask(task().id)}>{tr("버리기")}</button>
                <button
                  class="btn sm primary"
                  disabled={merging()}
                  onClick={async () => {
                    setMerging(true);
                    await mergeTask(task().id);
                    setMerging(false);
                  }}
                >
                  <Icon name="merge" size={13} />
                  {merging() ? tr("병합 중") : tr("병합")}
                </button>
              </div>,
            );
          if (task().plan.length && task().status !== "done") out.push(<Todos t={task()} />);
          if (task().queue?.length) out.push(<Queued t={task()} />);
          return out.length ? out : undefined;
        };
        const head = (
          <header class="head task-head" data-tauri-drag-region>
            <SidebarToggle />
            <nav class="crumbs" data-tauri-drag-region>
              <Show when={task().parentId ? taskById(task().parentId!) : undefined}>
                {(p) => (
                  <>
                    <button class="icon-btn sm crumb-back" title={tr("상위 작업: {title}", { title: p().title })} onClick={() => openTask(p().id)}>
                      <Icon name="chevron" size={14} />
                    </button>
                  </>
                )}
              </Show>
              <Show when={!task().parentId && task().project ? projectById(task().project!, task().space) : undefined}>
                {(p) => (
                  <>
                    <button class="crumb-proj" title={tr("{name} 메인", { name: p().name })} onClick={() => goMain(p().id)}>
                      <ProjectBadge name={p().name} />
                      <span>{p().name}</span>
                    </button>
                    <span class="crumb-sep">/</span>
                  </>
                )}
              </Show>
              <Show
                when={renaming() === task().id}
                fallback={<h1 title={task().title} onDblClick={() => setRenaming(task().id)}>{task().title}</h1>}
              >
                <input
                  class="title-edit"
                  value={task().title}
                  ref={(el) => setTimeout(() => (el.focus(), el.select()), 0)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.isComposing) (renameTask(task().id, e.currentTarget.value), setRenaming(null));
                    else if (e.key === "Escape") (e.stopPropagation(), setRenaming(null));
                  }}
                  onBlur={(e) => (renameTask(task().id, e.currentTarget.value), setRenaming(null))}
                />
              </Show>
              <IssueTag t={task()} />
            </nav>
            <Show when={task().status === "done" && task().unverified?.length}>
              <span class="status-chip unverified" title={task().unverified!.join("\n")}>{tr("{n}개 확인 안 됨", { n: task().unverified!.length })}</span>
            </Show>
            <Show when={task().status === "done" && task().worktree?.state === "open"}>
              <span class="status-chip unmerged"><Glyph t={task()} />{tr("검토")}</span>
            </Show>
            <Show when={task().status === "done" && task().worktree?.state !== "open"}>
              <span class="status-chip done">
                <Icon name="check" size={12} />
                {task().worktree?.state === "merged" ? tr("병합됨") : tr("완료")}
                <span class="faint">{ago(task().finishedAt ?? task().createdAt)}</span>
              </span>
            </Show>
            <Show when={task().status !== "done"}>
              <span class={`status-chip ${task().status}`}>
                {/* the same glyph as the task's row in the sidebar (실패: the red one) */}
                <Show when={task().status === "running"} fallback={<Glyph t={task()} />}>
                  <StatusIcon t={task()} size="sm" />
                </Show>
                {tr(statusLabel[task().status])}
                <Show when={task().status === "running" && task().startedAt}>
                  <span class="faint">{compact(workedMs(task(), now()))}</span>
                </Show>
              </span>
            </Show>
            <span class="spacer" data-tauri-drag-region />
            <div class="head-actions">
              <Show when={usesReverse(task(), state.tasks)}>
                <button class="icon-btn" classList={{ on: panelOpen() && panelTab() === "reverse" }} title={tr("바이너리 분석")} onClick={() => showTool("reverse")}>
                  <Icon name="binary" size={16} />
                </button>
              </Show>
              <MoreMenu id={task().id} />
              <button class="icon-btn" classList={{ on: panelOpen() }} data-shortcut="panel" title={`${tr("패널")} (⌘\\)`} onClick={togglePanel}>
                <Icon name="panel" size={16} />
              </button>
            </div>
          </header>
        );
        const chat = (
          <>
            <Transcript
              task={task()}
              agentId={task().id}
              footer={
                <>
                  <Show when={decision()}>{(d) => <div class="thread-ask"><DecisionCard d={d()} showTask={false} /></div>}</Show>
                  <JobEnd t={task()} />
                </>
              }
            />
            <div class="dock">
              <div class="dock-inner">
                <Show when={task().status === "failed" && task().error}>
                  <div class="notice bad">
                    <Icon name="alert" size={16} />
                    <div class="notice-body"><b>{tr("작업 실패")}</b><p class="selectable">{task().error}</p></div>
                    <button class="btn sm" onClick={() => resumeTask(task().id)}>{tr("다시 시도")}</button>
                  </div>
                </Show>
                <Composer
                  id="task-input"
                  draftKey={`task:${task().id}`}
                  top={<><BtwCard scope={`task:${task().id}`} />{strips()}</>}
                  plus={plusFor({})}
                  status={<StatusLine
                  accountId={task().accountId}
                  space={task().space}
                  running={task().status === "running"}
                  onAccount={(id) => id !== task().accountId && updateTask(task().id, (t) => (t.accountId = id, t.model = ""))}
                  agent={`t:${task().id}`}
                  shells={task().shells.filter((s) => !s.endedAt).length}
                  branch={task().worktree?.state === "open" ? task().worktree!.branch : undefined}
                />}
                  files={() => fsFiles(expand(task().cwd))}
                  commands={[
                    btwCommand(() => `task:${task().id}`),
                    drawCommand(() => task().id),
                    { name: "remember", desc: homeDir(task()) ? tr("프로젝트 메모리에 저장") : tr("메모리에 저장"), icon: "memory", run: (a) => a.trim() && addMemory(a, "project", { project: homeDir(task()) }) },
                    // what the task's state allows, as in its ⋯ menu
                    ...(task().status === "running" || task().status === "waiting" ? [{ name: "pause", desc: tr("일시정지|action"), icon: "pause", run: () => stopTask(task().id) }] : []),
                    ...(task().status === "paused" || task().status === "failed" ? [{ name: "resume", desc: tr("다시 시작"), icon: "play", run: () => resumeTask(task().id) }] : []),
                    ...(task().status === "queued" ? [{ name: "start", desc: tr("지금 시작"), icon: "play", run: () => void startTask(task().id) }] : []),
                    ...(task().status !== "done" ? [{ name: "done", desc: tr("완료로 표시"), icon: "flag", run: () => finishTask(task().id) }] : []),
                    { name: "rename", desc: tr("이름 바꾸기"), icon: "pencil", run: (a) => a.trim() && updateTask(task().id, (x) => (x.title = a.trim().slice(0, 40))) },
                    { name: "changes", desc: tr("변경 사항"), icon: "diff", run: () => showTool("changes") },
                    { name: "files", desc: tr("파일"), icon: "file", run: () => showTool("files") },
                    { name: "terminal", desc: tr("터미널"), icon: "shell", run: () => showTool("terminal") },
                    { name: "browser", desc: tr("브라우저"), icon: "globe", run: () => showTool("browser") },
                    ...(ready()
                      ? [
                          { name: "merge", desc: tr("병합"), icon: "merge", run: () => void mergeTask(task().id) },
                          { name: "discard", desc: tr("버리기"), icon: "undo", run: () => void discardTask(task().id) },
                        ]
                      : []),
                    { name: "ask", desc: tr("권한: {name}", { name: tr("매번 묻기") }), icon: "lock", run: () => void setTaskPermission(task().id, "ask") },
                    { name: "edits", desc: tr("권한: {name}", { name: tr("편집 허용") }), icon: "pencil", run: () => void setTaskPermission(task().id, "edits") },
                    { name: "full", desc: tr("권한: {name}", { name: tr("전체 권한") }), icon: "shield", run: () => void setTaskPermission(task().id, "full") },
                    ...skillCommands(() => ({ task: task().id, space: task().space })),
                  ]}
                  placeholder={task().status === "running" ? tr("작업 중에 말하기") : task().status === "queued" || task().status === "waiting" ? tr("메시지 보내기|input") : tr("이어서 말하기")}
                  left={<PermissionPicker value={task().permission ?? "edits"} onChange={(p) => void setTaskPermission(task().id, p)} />}
                  onSend={(m) => tell(task().id, m)}
                  running={task().status === "running"}
                  onStop={() => stopTask(task().id)}
                  right={
                    <>
                    <ModelPicker
                      up
                      accountId={task().accountId}
                      model={task().model ?? ""}
                      thinking={task().thinking || effortFor(task().accountId) || ""}
                      onChange={(m, th) => void setTaskModel(task().id, m, th)}
                    />
                    </>
                  }
                />
              </div>
            </div>
          </>
        );
        return (
          <div class="view task-view">
            {head}
            {chat}
          </div>
        );
      }}
    </Show>
  );
}
