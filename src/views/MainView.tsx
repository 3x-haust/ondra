// Main: the conversation with the one who splits your requests into jobs.
import { nowText } from "../engine/describe";
import { skillAsk } from "../ui/Aside";
import { keepBottom } from "../ui/stick";
import { AnsweredCard, answerOf, DecisionCard } from "../ui/DecisionCard";
// Every reply carries chips for the jobs it started; the jobs themselves live
// in the sidebar, grouped by what they need from you.
import { chooseAccount, createTask, NO_ACCOUNT } from "../engine/tasks";
import { createEffect, createMemo, createRoot, createSignal, onCleanup, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { accountById, accountsIn, addProject, projectById, projectsIn, repoHome, setState, spaceById, state, taskById, updateAccount } from "../state/store";
import { ProjectBadge } from "../ui/ProjectBadge";
import { switchSpace } from "../state/workspace";
import { fsFiles, pickFolder } from "../lib/native";
import { expand, tilde } from "../engine/rpc";
import type { CaptainMessage, Status, Task } from "../state/types";
import { hoverTask, jumpMsg, openPanel, openTask, panelOpen, setHoverTask, setJumpMsg, setView, toast, togglePanel, view } from "../state/ui";
import { chatKey, editMain, inChat, stopMain, throwThought, warmMain } from "../engine/captain";
import { addMemory } from "../engine/memory";
import { BtwCard, btwCommand, plusFor, skillCommands } from "../ui/Aside";
import { sendSide } from "../engine/aside";
import { allSessions, continueSession } from "../engine/importer";
import { engine } from "../engine/rpc";
import { ago, compact, midTrim, newTaskOpen, now, setNewTaskOpen, statusLabel, titleOf } from "../ui/bits";
import { BlockView } from "../ui/Blocks";
import { Composer } from "../ui/Composer";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { ModelPicker, PermissionPicker, usePop } from "../ui/ModelPicker";
import { effortFor } from "../engine/models";
import { MsgActions, UserMsg } from "../ui/MsgActions";
import { StatusLine, UsageLine } from "../ui/Usage";
import { matchesShortcut, noModifiers, shortcutHint, shortcuts } from "../lib/shortcuts";
import { BranchChip } from "./Branch";
import { refreshSuggestions, suggestionsFor, suggestLoading } from "../engine/suggest";
import { SidebarToggle } from "./Sidebar";
import { t, t as tr } from "../i18n";

/** "{task}에 전달했어요" with the task name in bold */
function withName(key: string, name: string) {
  const [a, b = ""] = t(key).split("{task}");
  return (
    <>
      {a}
      <b>{name}</b>
      {b}
    </>
  );
}

/** Folder for the next request; "" = let main decide. */

/** Put text in the main input as if typed (the user still presses send). */
function fill(text: string) {
  const el = document.getElementById("main-input") as HTMLTextAreaElement | null;
  if (!el) return;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(text.length, text.length);
}

// ───────────── pieces

function Reply(props: { m: CaptainMessage; retry: () => void; chips?: Task[]; active?: string }) {
  const routes = () => props.m.routes ?? [];
  const copyText = () => [props.m.reply, ...routes().map((r) => (r.kind === "answer" ? r.text : ""))].filter(Boolean).join("\n\n");
  return (
    <div class="reply" data-mid={props.m.id} classList={{ linked: !!props.chips?.some((t) => t.id === hoverTask() || t.id === props.active) }}>
      <Show when={props.m.up ? projectById(props.m.up) : undefined}>
        {(p) => (
          <button class="reply-from" onClick={() => setView({ name: "main", project: p().id })}>
            <Icon name="folder" size={12} />
            {t("{name}에서", { name: p().name })}
          </button>
        )}
      </Show>
      <div class="reply-body">
        <Switch>
          <Match when={props.m.pending}>
            <span class="shimmer reply-thinking">{t("생각하는 중")}</span>
          </Match>
          <Match when={props.m.error}>
            {(err) => (
              <div class="reply-error">
                <Icon name="alert" size={14} />
                <span>{err() === NO_ACCOUNT ? t(NO_ACCOUNT) : err()}</span>
                {/* no account here: trying again can't help, adding one can */}
                <Show
                  when={err() === NO_ACCOUNT || err() === t(NO_ACCOUNT)}
                  fallback={<button class="retry" onClick={props.retry}><Icon name="refresh" size={14} />{t("다시 시도")}</button>}
                >
                  <button class="retry" onClick={() => setView({ name: "settings", tab: "accounts" })}><Icon name="plus" size={14} />{t("계정 추가")}</button>
                </Show>
              </div>
            )}
          </Match>
          <Match when={true}>
            <Show when={props.m.reply}><p class="reply-line">{props.m.reply}</p></Show>
            <Show when={!props.m.reply && !routes().length}>
              <div class="reply-error">
                <Icon name="alert" size={14} />
                <span>{t("응답을 받지 못했어요")}</span>
                <button class="retry" onClick={props.retry}><Icon name="refresh" size={14} />{t("다시 시도")}</button>
              </div>
            </Show>
            <For each={routes()}>
              {(r) => (
                <Switch>
                  <Match when={r.kind === "answer" && r}>
                    {(a) => (
                      <>
                        <Show when={a().text}><Markdown class="msg-text" text={a().text} /></Show>
                        <Show when={a().blocks.length}><div class="blocks"><For each={a().blocks}>{(b) => <BlockView block={b} />}</For></div></Show>
                      </>
                    )}
                  </Match>
                  <Match when={r.kind === "append" && r}>
                    {(a) => (
                      <button class="reply-note" onClick={() => openTask(a().taskId)}>
                        <Icon name="handoff" size={14} />
                        <span>{withName("{task}에 전달했어요", taskById(a().taskId)?.title ?? t("작업"))}</span>
                      </button>
                    )}
                  </Match>
                  <Match when={r.kind === "stop" && r}>
                    {(a) => (
                      <button class="reply-note" onClick={() => openTask(a().taskId)}>
                        <Icon name="pause" size={14} />
                        <span>{withName("{task} 멈춤", taskById(a().taskId)?.title ?? t("작업"))}</span>
                      </button>
                    )}
                  </Match>
                  <Match when={r.kind === "remember" && r}>
                    {(a) => (
                      <div class="reply-note">
                        <Icon name="memory" size={14} />
                        <span>{t("메모리에 저장했어요")} · {state.memory.find((x) => x.id === a().memoryId)?.text ?? ""}</span>
                      </div>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </Match>
        </Switch>
        <Show when={props.chips?.length}>
          <div class="br-chips">
            <For each={props.chips}>
              {(t) => (
                <span onMouseEnter={() => setHoverTask(t.id)} onMouseLeave={() => setHoverTask(null)}>
                  <BranchChip t={t} active={props.active === t.id} />
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={!props.m.pending && !props.m.error && (copyText() || props.m.usage)}>
          <div class="reply-foot">
            <Show when={copyText()}><MsgActions text={copyText()} onRetry={props.retry} /></Show>
            <Show when={props.m.usage}>{(u) => <UsageLine u={u()} />}</Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** Empty chat: the input, and a few starts under it (like Codex). The header already says where you are. */
/** this space's accounts only: jobs here never run on the other space's */
const loggedIn = () => accountsIn(state.space).some((a) => a.providers.length);

/** The app can't start, or this workspace has no account: said above the input until it is fixed. */
function SetupNotice() {
  return (
    <>
      <Show when={engine.checked && !engine.ready}>
        <div class="notice bad"><Icon name="alert" size={16} /><div class="notice-body"><b>{t("앱을 시작하지 못했어요")}</b><p>{t("다시 설치해 주세요.")}</p></div></div>
      </Show>
      <Show when={engine.checked && engine.ready && !loggedIn()}>
        <div class="notice">
          <Icon name="key" size={16} />
          <div class="notice-body"><b>{t("로그인 필요")}</b></div>
          <button class="btn sm" onClick={() => setView({ name: "settings", tab: "accounts" })}>{t("로그인")}</button>
        </div>
      </Show>
    </>
  );
}

function Hero(props: { project?: string; composer: JSX.Element }) {
  return (
    <div class="page hero-page">
      <div class="hero">
        <SetupNotice />
        {props.composer}
        <Picks project={props.project} wait />
      </div>
    </div>
  );
}

/** A few starts for an empty chat: suggestions from recent work, and sessions from other apps to carry on. */
function Picks(props: { project?: string; wait?: boolean }) {
  const key = () => chatKey(state.space, props.project);
  createEffect(on(key, () => void refreshSuggestions(state.space, props.project)));
  const picks = () => suggestionsFor(key());
  const imported = () => new Set(state.tasks.map((t) => t.origin?.path).filter(Boolean));
  // only work from this chat's folder: the project's repo (and its worktrees), or the space's folder
  const root = () => {
    const f = props.project ? projectById(props.project)?.folder : spaceById(state.space).folder;
    return f ? expand(f).replace(/\/+$/, "") : "";
  };
  // folders that belong to the other space (its folder and its projects')
  const elsewhere = () =>
    [...state.spaces.filter((s) => s.id !== state.space).map((s) => s.folder), ...(state.projects ?? []).filter((p) => p.space !== state.space).map((p) => p.folder)]
      .filter((f) => f && f !== "~")
      .map((f) => expand(f).replace(/\/+$/, ""));
  const inHere = (cwd: string) => {
    const r = root();
    const c0 = expand(cwd || "").replace(/\/+$/, "");
    if (elsewhere().some((f) => c0 === f || c0.startsWith(`${f}/`))) return false;
    if (!r || r === expand("~").replace(/\/+$/, "")) return !props.project;
    const c = repoHome(expand(cwd || "")).replace(/\/+$/, "");
    return c === r || c.startsWith(`${r}/`);
  };
  const sessions = () => allSessions().filter((s) => !imported().has(s.path) && inHere(s.cwd)).slice(0, 3);
  return (
        <div class="hero-picks">
          <Show when={props.wait && suggestLoading() === key() && !picks().length}>
            <div class="hero-pick wait"><span class="spin xs" /><span>{t("최근 작업 보는 중")}</span></div>
          </Show>
          <For each={picks().slice(0, 3)}>
            {(s) => (
              <button class="hero-pick" onClick={() => fill(s.text)} title={s.why || undefined}>
                <Icon name="arrow" size={14} class="hero-pick-ic" />
                <span class="hero-pick-text">{s.text}</span>
              </button>
            )}
          </For>
          <For each={sessions()}>
            {(s) => (
              <button
                class="hero-pick"
                title={t("{app}에서 이어서 하기", { app: s.sourceName })}
                onClick={async () => {
                  try {
                    openTask(await continueSession(s, state.space, s.sourceName));
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e), "bad");
                  }
                }}
              >
                <Icon name="history" size={14} class="hero-pick-ic" />
                <span class="hero-pick-text">{s.title || t("제목 없음")}</span>
                <span class="hero-pick-meta">{s.sourceName} · {ago(s.updatedAt)}</span>
              </button>
            )}
          </For>
        </div>
  );
}

/** The model chip for the account a chat runs on: company and personal keep their own model. */
function AccountModel(props: { accountId: string; up?: boolean }) {
  return (
    <ModelPicker
      up={props.up}
      accountId={props.accountId}
      model={accountById(props.accountId)?.model ?? ""}
      thinking={effortFor(props.accountId) || ""}
      onChange={(m, t) =>
        updateAccount(props.accountId, (x) => {
          if (m) x.model = m;
          x.effort = t;
        })
      }
    />
  );
}

// ───────────── new task
/** Every 새 작업 (sidebar, ⌘N, canvas, board, a project's menu): a blank task to write, in a project picked here. Any move elsewhere ends it. */
const drafting = newTaskOpen;
const setDrafting = setNewTaskOpen;
// any move elsewhere (another view, another workspace) ends it, whether or not Main is still mounted
createRoot(() => createEffect(on([view, () => state.space], () => setDrafting(null), { defer: true })));
/** × and Esc: close it and go back to where it was opened from */
function closeNewTask() {
  const from = drafting()?.from;
  setDrafting(null);
  if (from) setView(from);
}
/** Open the new-task screen. `preset` picks its project (a project's menu, the canvas lane); without
 *  it the project in view carries over. A project from the other workspace switches to it first. */
export function startNewTask(preset?: string) {
  const v = view();
  const p = preset ? projectById(preset) : undefined;
  if (p && p.space !== state.space) switchSpace(p.space, { name: "main" });
  const project = preset ?? (v.name === "main" ? v.project : v.name === "task" ? taskById(v.id)?.project : undefined);
  // reopened over itself: keep where it first came from
  const from = drafting()?.from ?? v;
  setView({ name: "main" });
  setDrafting({ project: project && projectById(project)?.space === state.space ? project : undefined, from });
  setTimeout(() => document.getElementById("new-task-input")?.focus(), 30);
}

/** Which project a new task runs in: a chip and its menu, like the permission one. */
function ProjectPick(props: { value?: string; onChange: (id?: string) => void }) {
  const [open, setOpen] = usePop();
  const cur = () => (props.value ? projectById(props.value) : undefined);
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class="chip proj-chip" classList={{ on: open() }} onClick={() => setOpen(!open())} title={cur()?.folder ? tilde(cur()!.folder) : t("프로젝트|one")}>
        <Show when={cur()} fallback={<Icon name="folder" size={14} />}>{(c) => <ProjectBadge name={c().name} />}</Show>
        <span class="proj-chip-name">{cur()?.name ?? t("프로젝트 없음")}</span>
        <Icon name="down" size={12} class="muted" />
      </button>
      <Show when={open()}>
        <div class="pop proj-pop" role="menu">
          <div class="pop-label">{t("프로젝트")}</div>
          <For each={projectsIn(state.space)}>
            {(p) => (
              <button type="button" class="pop-item" role="menuitem" onClick={() => (props.onChange(p.id), setOpen(false))}>
                <ProjectBadge name={p.name} />
                <span class="pop-item-main">{p.name}</span>
                <span class="pop-item-sub">{midTrim(tilde(p.folder), 24)}</span>
                <span class="pop-check">{p.id === props.value && <Icon name="check" size={14} />}</span>
              </button>
            )}
          </For>
          <div class="pop-sep" />
          <button type="button" class="pop-item" role="menuitem" onClick={() => (props.onChange(undefined), setOpen(false))}>
            <Icon name="dot" size={14} class="muted" />
            <span class="pop-item-main">{t("프로젝트 없음")}</span>
            <span class="pop-check">{!props.value && <Icon name="check" size={14} />}</span>
          </button>
          <div class="pop-sep" />
          {/* the same as Main's + menu: pick a folder, it becomes a project and this task's */}
          <button
            type="button"
            class="pop-item"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              const dir = await pickFolder(t("프로젝트 폴더"));
              if (dir) props.onChange(addProject(state.space, dir));
            }}
          >
            <Icon name="plus" size={14} class="muted" />
            <span class="pop-item-main">{t("프로젝트 추가")}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

function NewTask(props: { project?: string; onProject: (id?: string) => void }) {
  const p = () => (props.project ? projectById(props.project) : undefined);
  const account = () => chooseAccount(state.space, p()?.name ?? "");
  const send = (text: string) => {
    const id = createTask({
      space: state.space,
      title: titleOf(text),
      topic: p()?.name ?? "",
      ask: text,
      cwd: p()?.folder,
      project: p()?.id,
      isolate: state.settings.isolate,
      accountId: account(),
    });
    setDrafting(null);
    openTask(id);
  };
  return (
    <div class="page hero-page new-task-page">
      <div class="hero">
        <Composer
          id="new-task-input"
          draftKey={`new:${state.space}`}
          big
          popDown
          autofocus
          placeholder={t("새 작업")}
          files={() => fsFiles(expand(p()?.folder || spaceById(state.space).folder || "~"))}
          onSend={send}
          status={<StatusLine accountId={account()} space={state.space} />}
          left={
            <>
              <ProjectPick value={props.project} onChange={props.onProject} />
              <PermissionPicker value={state.settings.permission ?? "edits"} onChange={(x) => setState("settings", "permission", x)} />
            </>
          }
          right={<AccountModel accountId={account()} />}
        />
      </div>
    </div>
  );
}

// ───────────── main
/** Main's conversation: every message, with the jobs each reply started as chips. */
export function MainView() {
  let box!: HTMLDivElement;
  const openRoot = () => {
    const v = view();
    let t = v.name === "task" ? taskById(v.id) : undefined;
    while (t?.parentId) t = taskById(t.parentId);
    return t?.id;
  };
  const project = () => {
    const v = view();
    const p = v.name === "main" ? projectById(v.project) : undefined;
    return p && p.space === state.space ? p : undefined;
  };
  // a report opened from the results view: scroll to it once it is drawn
  createEffect(() => {
    const id = jumpMsg();
    if (!id) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = box?.querySelector(`[data-mid="${id}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "start" });
        setJumpMsg(undefined);
      }),
    );
  });
  const key = () => chatKey(state.space, project()?.id);
  const msgs = () => state.captain.filter((m) => inChat(m, key()));
  // the account main runs on: the space's pick, or the routed one (same rule as new jobs)
  const account = () => chooseAccount(state.space, project()?.name ?? "");
  const started = (m: CaptainMessage) =>
    (m.routes ?? []).flatMap((r) => (r.kind === "new" ? [taskById(r.taskId)].filter((t): t is Task => !!t) : []));
  const sendMain = (text: string) => throwThought(text, state.space, { project: project()?.id });
  /** ask the message before this reply again: main goes back to that point */
  const retry = (m: CaptainMessage) => {
    const list = msgs();
    const i = list.findIndex((x) => x.id === m.id);
    const ask = list.slice(0, i).reverse().find((x) => x.from === "me");
    if (ask?.text) void editMain(ask.id, ask.text);
  };
  const asks = () =>
    state.decisions.filter((d) => {
      if (d.taskId.startsWith("main:")) return d.taskId === `main:${key()}`;
      const t = taskById(d.taskId);
      return !!t && t.space === state.space && (project() ? t.project === project()!.id : true);
    });
  /** questions of this chat's tasks already answered: one quiet line each where the card was */
  const answered = createMemo(() => {
    const out: Answered[] = [];
    for (const t of state.tasks) {
      if (t.space !== state.space || (project() && t.project !== project()!.id)) continue;
      for (const e of t.entries) {
        if (e.kind !== "user") continue;
        const a = answerOf(e.text);
        if (!a) continue;
        let x = answeredSeen.get(e.id);
        if (!x || x.a !== a.a) answeredSeen.set(e.id, (x = { id: e.id, at: e.at, taskId: t.id, ...a }));
        out.push(x);
      }
    }
    return out;
  });
  /** the conversation in order: messages, and the answered questions between them */
  const timeline = createMemo(() => {
    const list: (CaptainMessage | Answered)[] = [...msgs()];
    for (const a of answered()) {
      const i = list.findIndex((m) => m.at > a.at);
      list.splice(i < 0 ? list.length : i, 0, a);
    }
    return list;
  });
  /** a project's own chat: how its tasks stand, in the head */
  const projCounts = () => {
    const p = project();
    if (!p) return [];
    const top = state.tasks.filter((x) => x.project === p.id && x.space === state.space && !x.parentId);
    return (["waiting", "failed", "running", "queued", "paused", "done"] as Status[]).map((st) => [st, top.filter((x) => x.status === st).length] as const).filter(([, n]) => n);
  };
  const toBottom = () => queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
  createEffect(on(() => [state.space, msgs().length, msgs()[msgs().length - 1]?.pending, asks().length], toBottom));
  // warm the cache as soon as a chat is open, so even the first message is cached
  createEffect(on(key, () => void warmMain(state.space, project()?.id)));

  const composer = (big: boolean) => (
    <Composer
      id="main-input"
      draftKey={`main:${key()}`}
      big={big}
      autofocus
      files={() => fsFiles(expand(spaceById(state.space).folder || "~"))}
      commands={[
        btwCommand(() => `main:${key()}`),
        { name: "side", desc: t("옆 대화 열기"), keys: shortcutHint("side"), icon: "message", run: (a) => (openPanel("side"), a.trim() && void sendSide(state.space, a)) },
        { name: "flow", desc: t("작업 흐름 열기"), keys: shortcutHint("flow"), icon: "branch", run: () => openPanel("flow") },
        { name: "ask", desc: t("권한: {name}", { name: t("매번 묻기") }), icon: "lock", run: () => setState("settings", "permission", "ask") },
        { name: "edits", desc: t("권한: {name}", { name: t("편집 허용") }), icon: "pencil", run: () => setState("settings", "permission", "edits") },
        { name: "full", desc: t("권한: {name}", { name: t("전체 권한") }), icon: "shield", run: () => setState("settings", "permission", "full") },
        { name: "remember", desc: t("메모리에 저장"), icon: "memory", run: (a) => a.trim() && addMemory(a, "space", { space: state.space }) },
        { name: "memory", desc: t("메모리 열기"), icon: "memory", run: () => setView({ name: "memory" }) },
        { name: "settings", desc: t("설정 열기"), keys: shortcutHint("settings"), icon: "gear", run: () => setView({ name: "settings" }) },
        ...skillCommands(() => ({ space: state.space, project: project()?.id })),
      ]}
      placeholder={t("메시지 보내기|input")}
      onSend={sendMain}
      onTyping={() => void warmMain(state.space, project()?.id)}
      top={<BtwCard scope={`main:${key()}`} />}
      status={<StatusLine accountId={account()} space={state.space} agent={`captain:${key()}`} />}
      plus={plusFor({ main: true })}
      running={msgs().some((m) => m.pending)}
      onStop={() => void stopMain(key())}
      stopKind="stop"
      left={<PermissionPicker value={state.settings.permission ?? "edits"} onChange={(p) => setState("settings", "permission", p)} />}
      right={<AccountModel accountId={account()} up={!big} />}
    />
  );

  // a new task is written here until it is sent, or until anything else is opened (closeNewTask above).
  // Esc closes it in one press while nothing is written, even from its input (which would only blur);
  // an open menu, or a written draft, takes the Esc first
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drafting() || e.defaultPrevented || !noModifiers(e) || e.isComposing) return;
    if (document.querySelector(".new-task-page :is(.pop, .cpick, .plus-menu)")) return;
    const input = document.getElementById("new-task-input") as HTMLTextAreaElement | null;
    if (input?.value.trim() && document.activeElement === input) return;
    e.preventDefault();
    e.stopPropagation();
    closeNewTask();
  };
  window.addEventListener("keydown", esc, true);
  onCleanup(() => window.removeEventListener("keydown", esc, true));
  // going to Main while a new task is open (its sidebar row, ⌘0, the palette) lands on Main: the
  // view is already "main", so nothing else would close the draft
  const toMain = (e: Event) => drafting() && (e.target as Element | null)?.closest?.('[data-shortcut="main"]') && setDrafting(null);
  const mainKey = (e: KeyboardEvent) => drafting() && matchesShortcut(e, shortcuts.main) && setDrafting(null);
  window.addEventListener("click", toMain, true);
  window.addEventListener("keydown", mainKey, true);
  onCleanup(() => (window.removeEventListener("click", toMain, true), window.removeEventListener("keydown", mainKey, true)));

  return (
    <div class="view main-view">
      <Show when={drafting()}>
        {(d) => (
          <>
            <header class="head" data-tauri-drag-region>
              <SidebarToggle />
              <h1 class="head-title">{t("새 작업")}</h1>
              <span class="spacer" data-tauri-drag-region />
              <button class="icon-btn" title={`${t("닫기")} esc`} aria-label={t("닫기")} onClick={closeNewTask}>
                <Icon name="x" size={16} />
              </button>
            </header>
            <NewTask project={d().project} onProject={(id) => setDrafting({ project: id })} />
          </>
        )}
      </Show>
      <Show when={!drafting()}>
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">
          <Show when={project()} fallback={t("메인")}>
            {(p) => (
              <span class="head-proj-name" title={tilde(p().folder)}>
                <ProjectBadge name={p().name} />
                <span class="head-proj">{p().name}</span>
              </span>
            )}
          </Show>
        </h1>
        <Show when={projCounts().length}>
          <span class="head-counts">
            <For each={projCounts()}>{([st, n]) => <span class={`req-tag ${st}`}>{tr(statusLabel[st])} {n}</span>}</For>
          </span>
        </Show>
        <span class="spacer" data-tauri-drag-region />
        <button class="icon-btn" classList={{ on: panelOpen() }} data-shortcut="panel" title={t("패널 (⌘\\)")} onClick={togglePanel}>
          <Icon name="panel" size={16} />
        </button>
      </header>
      <Show
        when={msgs().length}
        fallback={
          <Show when={project()} fallback={<Hero composer={composer(true)} />}>
            {(p) => (
              <>
                {/* a project's chat with nothing said yet: a chat, with its input where it always is */}
                <div class="thread proj-empty">
                  <div class="thread-inner convo">
                    <Picks project={p().id} />
                    <For each={answered()}>{(a) => <AnsweredLine a={a} />}</For>
                    {/* what its tasks are asking is answered here too, before anything is said */}
                    <For each={asks()}>{(d) => <DecisionCard d={d} />}</For>
                  </div>
                </div>
                <div class="dock">
                  <div class="dock-inner">
                    <SetupNotice />
                    {composer(false)}
                  </div>
                </div>
              </>
            )}
          </Show>
        }
      >
        <RequestBoard
          msgs={msgs()}
          started={started}
          onJump={(id) => box?.querySelector(`[data-mid="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
        <div class="thread" ref={(el) => { box = el; onCleanup(keepBottom(el)); }}>
          <div class="thread-inner convo">
            <For each={timeline()}>
              {(m) => (
                <Show when={!("taskId" in m) && m} fallback={<AnsweredLine a={m as Answered} />}>
                  {(c) => (
                    <Show when={c().from === "me"} fallback={<Reply m={c()} retry={() => retry(c())} chips={started(c())} active={openRoot()} />}>
                      {/* main's own question answered: the same compact card a task's thread keeps */}
                      <Show when={answerOf(c().text ?? "")} fallback={<UserMsg id={c().id} text={c().text ?? ""} at={c().at} from={c().via === "main" ? t("메인에서") : undefined} onEdit={c().via === "main" ? undefined : (t) => void editMain(c().id, t)} />}>
                        {(a) => <AnsweredCard q={a().q} a={a().a} />}
                      </Show>
                    </Show>
                  )}
                </Show>
              )}
            </For>
            {/* what the jobs of this chat are asking: answered here, no need to open the job */}
            <For each={asks()}>{(d) => <DecisionCard d={d} />}</For>
          </div>
        </div>
        <div class="dock">
          <div class="dock-inner">
            <SetupNotice />
            {composer(false)}
          </div>
        </div>
      </Show>
      </Show>
    </div>
  );
}


/** A task's question answered (in Main or in the task), as Main shows it afterwards. */
type Answered = { id: string; at: number; taskId: string; q: string; a: string };
const answeredSeen = new Map<string, Answered>();

/** "4월 회고 초안 · 초안으로 저장": the task (opens it) and what was answered; the question on hover */
function AnsweredLine(props: { a: Answered }) {
  const task = () => taskById(props.a.taskId);
  return (
    <button class="answered-line" onClick={() => openTask(props.a.taskId)} title={`${props.a.q} → ${props.a.a}`}>
      <Icon name="check" size={14} />
      <span class="answered-task">{task()?.title ?? t("작업")}</span>
      <span class="answered-sep">·</span>
      <span class="answered-a">{props.a.a}</span>
    </button>
  );
}

type Req = { id: string; text: string; tasks: Task[]; state: "ask" | "live" | "done"; at: number };

/**
 * What the requests in this chat are doing, one line each, above the chat: the
 * chat scrolls, this stays. Closed it is a single line; only requests still
 * going, waiting on the user, or finished in the last few minutes are listed.
 */
// the request board stays open or closed as the user left it, in each space (across views and restarts)
const BOARD_KEY = "ondra.reqBoardOpen";
const [boards, setBoards] = createSignal<Record<string, boolean>>((() => {
  try {
    const v = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "{}");
    return typeof v === "object" && v ? v : {};
  } catch {
    return {};
  }
})());
const boardOpen = () => !!boards()[state.space];
const setBoardOpen = (v: boolean) => {
  const next = { ...boards(), [state.space]: v };
  setBoards(next);
  try {
    localStorage.setItem(BOARD_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
};

function RequestBoard(props: { msgs: CaptainMessage[]; started: (m: CaptainMessage) => Task[]; onJump: (id: string) => void }) {
  const open = boardOpen;
  const setOpen = setBoardOpen;
  let board!: HTMLDivElement;
  // it opens over the conversation: Escape or a click elsewhere closes it
  const away = (e: PointerEvent) => open() && board && !board.contains(e.target as Node) && setOpen(false);
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open() || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", esc, true);
  onCleanup(() => {
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", esc, true);
  });
  const reqs = createMemo<Req[]>(() => {
    const out: Req[] = [];
    let ask: CaptainMessage | undefined;
    // jobs a later request started belong to that request, even when they carry on this one's
    const own = new Set(props.msgs.filter((m) => m.from !== "me").flatMap((m) => props.started(m).map((t) => t.id)));
    // a job that carries on one of the request's jobs without a request of its own (a follow-up the project started) is part of it
    const carried = (t: Task, seen = new Set<string>()): Task[] => {
      if (seen.has(t.id)) return [];
      seen.add(t.id);
      return [t, ...state.tasks.filter((x) => x.follows === t.id && !own.has(x.id)).flatMap((x) => carried(x, seen))];
    };
    for (const m of props.msgs) {
      if (m.from === "me") {
        ask = m;
        continue;
      }
      const tasks = props.started(m).flatMap((t) => carried(t));
      if (!ask || !tasks.length) continue;
      const prev = out.find((r) => r.id === ask!.id);
      if (prev) prev.tasks.push(...tasks.filter((t) => !prev.tasks.includes(t)));
      else out.push({ id: ask.id, text: ((t) => t.split("\n").find((l) => l.trim() && !/^https?:\/\//.test(l.trim())) ?? t)(((a) => a.rest.trim() || a.skills.join(", "))(skillAsk(ask.text ?? ""))), tasks: [...tasks], state: "done", at: 0 });
    }
    for (const r of out) {
      // a finished job is finished: subagents it left stopped don't keep the request open
      const all = r.tasks.flatMap((t) => [t, ...(t.status === "done" ? [] : state.tasks.filter((k) => k.parentId === t.id))]);
      r.state = all.some((t) => t.status === "waiting" || t.status === "failed")
        ? "ask"
        : all.some((t) => t.status === "running" || t.status === "queued" || t.status === "paused")
          ? "live"
          : "done";
      r.at = Math.max(...r.tasks.map((t) => t.finishedAt ?? t.startedAt ?? t.createdAt));
    }
    const fresh = Date.now() - 10 * 60_000;
    return out.filter((r) => r.state !== "done" || r.at > fresh).reverse();
  });
  /** every task the list shows, once */
  const listed = () => [...new Set(reqs().flatMap((r) => r.tasks))];
  // the head counts the tasks below it, by the words the sidebar uses
  const ORDER: Status[] = ["waiting", "failed", "running", "queued", "paused", "done"];
  const counts = () => ORDER.map((st) => [st, listed().filter((t) => t.status === st).length] as const).filter(([, n]) => n);
  // what the job says it is doing now (its status line), not its title again
  // never the state word again (the row ends with it): "실패" beside 실패, "응답 필요" beside 응답 필요
  // ("대기 중" / "일시정지됨" are the state word too)
  const sameAsState = (s: string, st: Status) => {
    const x = s.trim();
    return x.toLowerCase() === tr(statusLabel[st]).toLowerCase() || x.replace(/\s*(중|됨)$/, "") === statusLabel[st] || (st === "waiting" && x === "응답 대기 중");
  };
  const doing = (t: Task) => {
    const s = (t.status === "waiting" ? nowText(t.now) : t.intent || nowText(t.now)).trim();
    return s && s !== t.title && !sameAsState(s, t.status) ? s : "";
  };
  const working = () => listed().filter((t) => t.status === "running");
  /** a request's word: what its most pressing task is */
  const stateOf = (r: Req): Status => (r.state === "done" ? "done" : (ORDER.find((st) => r.tasks.some((t) => t.status === st)) ?? "running"));
  /** main's last report on one of the request's jobs */
  const resultOf = (r: Req) => [...props.msgs].reverse().find((m) => m.after && r.tasks.some((t) => t.id === m.after))?.id;
  /** a one-task request: its to-do list (skipped steps left out) */
  const steps = (r: Req) => {
    const ps = r.tasks[0].plan.filter((p) => p.state !== "skip");
    return ps.length ? { done: ps.filter((p) => p.state === "done").length, all: ps.length } : undefined;
  };
  /** what it is on now: the question it waits on, else the to-do step under way, else its status line */
  const stepNow = (r: Req) => {
    const t = focus(r);
    if (!t) return "";
    const s = ((t.status === "waiting" ? nowText(t.now) : t.plan.find((p) => p.state === "now")?.text ?? doing(t)) ?? "").trim();
    return sameAsState(s, stateOf(r)) || sameAsState(s, t.status) ? "" : s;
  };
  /** a request's job to look at: the one that needs you, else the one working, else the last one */
  const focus = (r: Req) => {
    const all = r.tasks.flatMap((t) => [t, ...state.tasks.filter((k) => k.parentId === t.id)]);
    const pick = (ok: (t: Task) => boolean) => all.find(ok);
    return (
      pick((t) => t.status === "waiting" || t.status === "failed") ??
      pick((t) => t.status === "running") ??
      pick((t) => t.status === "queued" || t.status === "paused") ??
      r.tasks[r.tasks.length - 1]
    );
  };
  /** a task line's right side: how long it has run, or its state */
  const when = (t: Task) => (t.status === "running" && t.startedAt ? compact(now() - t.startedAt) : tr(statusLabel[t.status]));
  return (
    <Show when={reqs().length}>
      <div class="req-board" ref={board} classList={{ open: open() }}>
        <button class="req-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
          <span class="req-sum">
            <span class="req-total">{t("작업 {n}|board", { n: listed().length })}</span>
            <For each={counts()}>{([st, n]) => <span class={`req-tag ${st}`}>{tr(statusLabel[st])} {n}</span>}</For>
          </span>
          {/* what is being worked on right now, in one line (the same open or closed, so the head never changes width) */}
          <Show when={working()[0]}>{(x) => <span class="req-now">{x().title}<Show when={doing(x())}> · {doing(x())}</Show></span>}</Show>
          <Icon name="chevron" size={12} class="req-chev" />
        </button>
        <Show when={open()}>
          <ul class="req-list">
            <For each={reqs()}>
              {(r) => (
                <li>
                  <button class="req-row" onClick={() => (r.state === "done" ? props.onJump(resultOf(r) ?? r.id) : openTask(focus(r).id))} title={r.text}>
                    <i class={`req-dot ${stateOf(r)}`} />
                    <span class="req-text">{r.text}</span>
                    {/* one task: the step it is on and its to-do list; several: how many of the tasks listed below are done */}
                    <Show
                      when={r.tasks.length > 1}
                      fallback={
                        <>
                          <Show when={r.state !== "done" && stepNow(r)}>{(n) => <span class="req-step-now">{n()}</span>}</Show>
                          <Show when={r.state !== "done" && steps(r)}>
                            {(st) => (
                              <span class="req-steps" title={t("할 일 {done}/{n} 완료", { done: st().done, n: st().all })}>
                                <i class="req-bar"><b style={{ width: `${(st().done / st().all) * 100}%` }} /></i>
                                {t("할 일 {done}/{all}", { done: st().done, all: st().all })}
                              </span>
                            )}
                          </Show>
                        </>
                      }
                    >
                      <span class="req-steps" title={t("작업 {done}/{n} 완료", { done: r.tasks.filter((x) => x.status === "done").length, n: r.tasks.length })}>
                        {r.tasks.filter((x) => x.status === "done").length}/{r.tasks.length}
                      </span>
                    </Show>
                    <span class={`req-state ${stateOf(r)}`}>{tr(statusLabel[stateOf(r)])}</span>
                  </button>
                  {/* several tasks: one line each, all of them, so the count above adds up */}
                  <Show when={r.tasks.length > 1}>
                    <For each={r.tasks}>
                      {(x) => (
                        <button class="req-job" onClick={() => openTask(x.id)} title={x.title}>
                          <span class="req-job-title">{x.title}</span>
                          <Show when={x.status !== "done" && doing(x)}><span class="req-job-now">{doing(x)}</span></Show>
                          <span class={`req-job-time ${x.status}`}>{when(x)}</span>
                        </button>
                      )}
                    </For>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}
