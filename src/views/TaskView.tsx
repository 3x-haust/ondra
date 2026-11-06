// One job: title and state, the transcript, whatever waits on you docked
import { holdScroll } from "../ui/stick";
// above its own input, and the side panel (changes / files / terminal / web).
import { Fold } from "../ui/Fold";
import { createEffect, createResource, createSignal, For, type JSX, on, onMount, Show } from "solid-js";
import { decisionFor, homeDir, taskById, updateTask } from "../state/store";
import type { Task } from "../state/types";
import { addMemory } from "../engine/memory";
import { artifacts, loadArtifacts } from "../state/artifacts";
import { BtwCard, btwCommand, drawCommand, plusFor, skillCommands } from "../ui/Aside";
import { goMain, newTask, openPanel as showTool, toast, openTask, panelOpen, panelTab, togglePanel, type PanelTab } from "../state/ui";
import { expand, isAlive } from "../engine/rpc";
import { fsFiles, gitChanges, openInEditor, revealPath } from "../lib/native";
import { rawStats, archiveTask, closeWorktree, discardTask, prOf, duplicateTask, renameTask, togglePin, transcriptMarkdown, finishTask, mergeTask, pauseTask, removeTask, resumeTask, setTaskModel, setTaskPermission, steerQueued, dropQueued, tell } from "../engine/tasks";
import { ago, compact, Dot, now, statusLabel } from "../ui/bits";
import { DecisionCard } from "../ui/DecisionCard";
import { costDetail, jobCost } from "../ui/cost";
import { Composer } from "../ui/Composer";
import { Icon } from "../ui/Icon";
import { ModelPicker, usePop, PermissionPicker } from "../ui/ModelPicker";
import { effortFor } from "../engine/models";
import { StatusLine } from "../ui/Usage";
import { Transcript } from "../ui/Transcript";
import { renaming, setRenaming, SidebarToggle } from "./Sidebar";

function MoreMenu(props: { id: string; openPanel: (tab: PanelTab) => void }) {
  const t = () => taskById(props.id)!;
  const [open, setPop] = usePop();
  const [sure, setSure] = createSignal(false);
  const setOpen = (v: boolean) => (setPop(v), v || setSure(false));
  const close = () => setOpen(false);
  const live = () => t().status === "running" || t().status === "waiting";
  return (
    <div style={{ position: "relative" }}>
      <button
        class="icon-btn"
        classList={{ on: open() }}
        title="더 보기"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open());
        }}
      >
        <Icon name="more" size={16} />
      </button>
      <Show when={open()}>
        <div class="menu" style={{ top: "36px", right: "0" }} onClick={(e) => e.stopPropagation()}>
          <Show when={t().status === "running"}>
            <button onClick={() => (pauseTask(t().id), close())}><Icon name="pause" size={14} class="muted" /><span class="row-title">일시정지</span></button>
          </Show>
          <Show when={t().status === "paused" || t().status === "failed"}>
            <button onClick={() => (resumeTask(t().id), close())}><Icon name="play" size={14} class="muted" /><span class="row-title">다시 시작</span></button>
          </Show>
          <Show when={t().status !== "done"}>
            <button onClick={() => (finishTask(t().id), close())}><Icon name="check" size={14} class="muted" /><span class="row-title">완료로 표시</span></button>
          </Show>
          <div class="menu-sep" />
          <button onClick={() => (setRenaming(t().id), close())}><Icon name="pencil" size={14} class="muted" /><span class="row-title">이름 바꾸기</span></button>
          <button onClick={() => (togglePin(t().id), close())}><Icon name="pin" size={14} class="muted" /><span class="row-title">{t().pinned ? "고정 풀기" : "위에 고정"}</span></button>
          <button onClick={() => { const n = duplicateTask(t().id); close(); if (n) openTask(n); }}><Icon name="refresh" size={14} class="muted" /><span class="row-title">같은 요청으로 다시 시작</span></button>
          <button onClick={() => { void navigator.clipboard.writeText(transcriptMarkdown(t().id)); toast("대화를 Markdown으로 복사했어요"); close(); }}><Icon name="copy" size={14} class="muted" /><span class="row-title">마크다운으로 복사</span></button>
          <div class="menu-sep" />
          <button onClick={() => (openInEditor(expand(t().cwd)), close())}><Icon name="external" size={14} class="muted" /><span class="row-title">편집기에서 열기</span></button>
          <button onClick={() => (revealPath(expand(t().cwd)), close())}><Icon name="folder" size={14} class="muted" /><span class="row-title">Finder에서 보기</span></button>
          <button onClick={() => (props.openPanel("terminal"), close())}><Icon name="terminal" size={14} class="muted" /><span class="row-title">터미널 열기</span></button>
          <Show when={t().worktree?.state === "open" && !live()}>
            <div class="menu-sep" />
            <button onClick={() => (void mergeTask(t().id), close())}><Icon name="merge" size={14} class="muted" /><span class="row-title">원래 폴더에 합치기</span></button>
            <button onClick={() => (void discardTask(t().id), close())}><Icon name="x" size={14} class="muted" /><span class="row-title">변경 버리기</span></button>
          </Show>
          <div class="menu-sep" />
          <Show
            when={sure()}
            fallback={
              <>
              <button onClick={() => (archiveTask(t().id), goMain(), close())}><Icon name="archive" size={14} class="muted" /><span class="row-title">보관</span></button>
              <button class="danger" onClick={() => setSure(true)}><Icon name="trash" size={14} /><span class="row-title">삭제</span></button>
            </>
            }
          >
            <button
              class="danger"
              onClick={() => {
                removeTask(t().id);
                newTask();
              }}
            >
              <Icon name="trash" size={14} />
              <span class="row-title">정말 삭제</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** The whole to-do list while it works (OmO-style): done, now, next. Folds to one line. */
function Todos(props: { t: Task }) {
  const [open, setOpen] = createSignal(true);
  const done = () => props.t.plan.filter((p) => p.state === "done").length;
  const cur = () => props.t.plan.find((p) => p.state === "now");
  return (
    <div class="todos" classList={{ closed: !open() }}>
      <button class="todos-head" onClick={() => { holdScroll(); setOpen(!open()); }} aria-expanded={open()}>
        <Icon name="list" size={14} />
        <b>할 일</b>
        <span class="num">{done()}/{props.t.plan.length}</span>
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
  return (
    <div class="queued">
      <For each={props.t.queue}>
        {(q) => (
          <div class="queued-row">
            <Icon name="handoff" size={13} />
            <span class="queued-text" title={q.text}>{q.text}</span>
            <div class="queued-acts">
              <button class="queued-steer" title="기다리지 않고 지금 보내요" onClick={() => steerQueued(props.t.id, q.id)}>
                <Icon name="send" size={12} />
                지금 보내기
              </button>
              <button class="icon-btn sm" title="고치기" onClick={() => (dropQueued(props.t.id, q.id), setDraft(q.text))}><Icon name="pencil" size={13} /></button>
              <button class="icon-btn sm" title="빼기" onClick={() => dropQueued(props.t.id, q.id)}><Icon name="trash" size={13} /></button>
            </div>
          </div>
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
    <Show when={t()} fallback={<div class="pane-empty">삭제된 작업이에요.</div>}>
      {(task) => {
        const decision = () => decisionFor(task().id);
        const bg = () => task().shells.filter((s) => !s.endedAt && (s.background || task().status !== "running"));
        createEffect(on(() => task().unread, (u) => u && updateTask(task().id, (x) => (x.unread = false))));
        const ready = () => task().worktree?.state === "open" && (task().status === "done" || task().status === "paused" || task().status === "failed");
        const [diff] = createResource(
          () => (ready() ? ([expand(task().cwd), task().worktree!.base] as const) : false),
          ([cwd, base]) => gitChanges(cwd, base),
        );
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
                <b>멈춤</b>
                <span class="strip-act"><Icon name="play" size={12} />다시 시작</span>
              </button>,
            );
          const made = artifacts[task().id] ?? [];
          if (made.length && !(panelOpen() && panelTab() === "artifacts"))
            out.push(
              <button class="strip" onClick={() => openPanel("artifacts")}>
                <Icon name="spark" size={14} />
                <b>결과물 {made.length}개</b>
                <span class="rest">{made[0].name}</span>
                <span class="strip-act">보기</span>
              </button>,
            );
          if (bg().length)
            out.push(
              <button class="strip" onClick={() => openPanel("terminal")}>
                <Icon name="terminal" size={14} />
                <b>백그라운드 {bg().length}개</b>
                <span class="rest"><code>{bg().map((s) => s.command).join("  ·  ")}</code></span>
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
                <button class="btn sm ghost" title="변경은 PR에 남아요" onClick={() => void closeWorktree(task().id)}>작업 폴더 정리</button>
              </div>,
            );
          // the changes tab already has merge / discard
          else if (ready() && !(panelOpen() && panelTab() === "changes"))
            out.push(
              <div class="strip">
                <Icon name="branch" size={14} />
                <b>검토 대기</b>
                <span class="rest">
                  <Show when={diff()} fallback="변경 확인 중…">
                    {(d) => (
                      <Show when={d().files.length} fallback="바뀐 파일이 없어요">
                      <button class="link-btn" onClick={() => openPanel("changes")}>
                        파일 {d().files.length}개 <span class="add">+{d().files.reduce((n, f) => n + f.add, 0)}</span>{" "}
                        <span class="del">−{d().files.reduce((n, f) => n + f.del, 0)}</span>
                      </button>
                      </Show>
                    )}
                  </Show>
                </span>
                <button class="btn sm ghost" onClick={() => void discardTask(task().id)}>버리기</button>
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
                  {merging() ? "합치는 중…" : "원래 폴더에 합치기"}
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
                    <button class="icon-btn sm crumb-back" title={`${p().title}(으)로 돌아가기`} onClick={() => openTask(p().id)}>
                      <Icon name="chevron" size={14} />
                    </button>
                  </>
                )}
              </Show>
              <Show
                when={renaming() === task().id}
                fallback={<h1 title={`${task().title} · 두 번 눌러 이름 바꾸기`} onDblClick={() => setRenaming(task().id)}>{task().title}</h1>}
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
            </nav>
            <Show when={task().status === "done" && task().unverified?.length}>
              <span class="unverified-badge" title={task().unverified!.join("\n")}>확인 안 됨 {task().unverified!.length}</span>
            </Show>
            <Show when={task().status === "done" && task().worktree?.state === "open"}>
              <span class="status-chip unmerged">검토 대기</span>
            </Show>
            <Show when={task().status === "done" && task().worktree?.state !== "open"}>
              <span class="status-chip done">
                <Icon name="check" size={12} />
                {task().worktree?.state === "merged" ? "합침" : "완료"}
                <span class="faint">{ago(task().finishedAt ?? task().createdAt)}</span>
              </span>
            </Show>
            <Show when={task().status !== "done"}>
              <span class={`status-chip ${task().status}`}>
                <Show when={task().status === "running"} fallback={<Dot status={task().status} />}>
                  <span class="spin xs" />
                </Show>
                {statusLabel[task().status]}
                <Show when={task().status === "running" && task().startedAt}>
                  <span class="faint">{compact(now() - task().startedAt!)}</span>
                </Show>
              </span>
            </Show>
            <span class="spacer" data-tauri-drag-region />
            <div class="head-actions">
              <MoreMenu id={task().id} openPanel={openPanel} />
              <button class="icon-btn" classList={{ on: panelOpen() }} title="패널 (⌘\)" onClick={togglePanel}>
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
                  <Show when={task().status === "done" && costDetail(jobCost(task()))}>{(s) => <div class="job-cost">끝 · {s()}</div>}</Show>
                </>
              }
            />
            <div class="dock">
              <div class="dock-inner">
                <Show when={task().status === "failed" && task().error}>
                  <div class="notice bad">
                    <Icon name="alert" size={16} />
                    <div class="notice-body"><b>작업이 멈췄어요</b><p class="selectable">{task().error}</p></div>
                    <button class="btn sm" onClick={() => resumeTask(task().id)}>다시 시도</button>
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
                    { name: "remember", desc: "이 폴더에서 기억하기 · 뒤에 적은 내용을 앞으로 지켜요", icon: "memory", run: (a) => a.trim() && addMemory(a, "project", { project: homeDir(task()) }) },
                    { name: "stop", desc: "멈추기", icon: "pause", run: () => pauseTask(task().id) },
                    { name: "resume", desc: "다시 시작", icon: "play", run: () => resumeTask(task().id) },
                    { name: "done", desc: "완료로 표시", icon: "check", run: () => finishTask(task().id) },
                    { name: "rename", desc: "이름 바꾸기 (/rename 새 이름)", icon: "pencil", run: (a) => a.trim() && updateTask(task().id, (x) => (x.title = a.trim().slice(0, 40))) },
                    { name: "changes", desc: "변경 사항 보기", icon: "diff", run: () => showTool("changes") },
                    { name: "files", desc: "파일 보기", icon: "file", run: () => showTool("files") },
                    { name: "terminal", desc: "터미널 열기", icon: "shell", run: () => showTool("terminal") },
                    { name: "browser", desc: "브라우저 보기", icon: "globe", run: () => showTool("browser") },
                    { name: "merge", desc: "원래 폴더에 합치기", icon: "merge", run: () => void mergeTask(task().id) },
                    { name: "ask", desc: "매번 묻도록 바꾸기", icon: "lock", run: () => void setTaskPermission(task().id, "ask") },
                    { name: "edits", desc: "편집 허용으로 바꾸기", icon: "pencil", run: () => void setTaskPermission(task().id, "edits") },
                    { name: "full", desc: "전체 권한으로 바꾸기", icon: "shield", run: () => void setTaskPermission(task().id, "full") },
                    ...skillCommands(() => ({ task: task().id, space: task().space })),
                  ]}
                  placeholder={decision() ? "다른 답을 직접 적어도 돼요" : task().status === "running" ? "일하는 중에 끼어들어 말하기…" : "이어서 말하기…"}
                  left={<PermissionPicker value={task().permission ?? "edits"} onChange={(p) => void setTaskPermission(task().id, p)} />}
                  onSend={(m) => tell(task().id, m)}
                  running={task().status === "running"}
                  onStop={() => pauseTask(task().id)}
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
