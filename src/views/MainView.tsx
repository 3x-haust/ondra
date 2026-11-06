// Main: the conversation with the one who splits your requests into jobs.
import { keepBottom } from "../ui/stick";
import { DecisionCard } from "../ui/DecisionCard";
// Every reply carries chips for the jobs it started; the jobs themselves live
// in the sidebar, grouped by what they need from you.
import { chooseAccount } from "../engine/tasks";
import { createEffect, createMemo, createSignal, onCleanup, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { accountById, accountsIn, projectById, repoHome, setState, spaceById, state, taskById, updateAccount } from "../state/store";
import { fsFiles } from "../lib/native";
import { expand } from "../engine/rpc";
import type { CaptainMessage, Task } from "../state/types";
import { hoverTask, openPanel, openTask, panelOpen, setHoverTask, setView, toast, togglePanel, view } from "../state/ui";
import { chatKey, editMain, inChat, stopMain, resetMain, throwThought, warmMain } from "../engine/captain";
import { addMemory } from "../engine/memory";
import { BtwCard, btwCommand, plusFor, skillCommands } from "../ui/Aside";
import { sendSide } from "../engine/aside";
import { allSessions, continueSession } from "../engine/importer";
import { engine } from "../engine/rpc";
import { ago, now, short } from "../ui/bits";
import { BlockView } from "../ui/Blocks";
import { Composer } from "../ui/Composer";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { ModelPicker, PermissionPicker } from "../ui/ModelPicker";
import { effortFor } from "../engine/models";
import { MsgActions, UserMsg } from "../ui/MsgActions";
import { StatusLine, UsageLine } from "../ui/Usage";
import { compactAgent } from "../engine/tasks";
import { BranchChip } from "./Branch";
import { refreshSuggestions, suggestionsFor, suggestLoading } from "../engine/suggest";
import { SidebarToggle } from "./Sidebar";

/** Folder for the next request; "" = let main decide. */
const STARTERS = [
  { text: "이 폴더가 어떻게 짜여 있는지 설명해 줘" },
  { text: "테스트 돌리고 깨진 거 고쳐 줘. 그리고 어제 바뀐 코드도 리뷰해 줘" },
  { text: "acme.dev 요금제 페이지에서 결제 버튼이 되는지 봐 줘" },
] as const;

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
    <div class="reply" classList={{ linked: !!props.chips?.some((t) => t.id === hoverTask() || t.id === props.active) }}>
      <Show when={props.m.up ? projectById(props.m.up) : undefined}>
        {(p) => (
          <button class="reply-from" onClick={() => setView({ name: "main", project: p().id })}>
            <Icon name="folder" size={12} />
            {p().name}에서
          </button>
        )}
      </Show>
      <div class="reply-body">
        <Switch>
          <Match when={props.m.pending}>
            <span class="shimmer reply-thinking">생각하는 중</span>
          </Match>
          <Match when={props.m.error}>
            <div class="reply-error">
              <Icon name="alert" size={14} />
              <span>{props.m.error}</span>
              <button class="retry" onClick={props.retry}><Icon name="refresh" size={13} />다시 보내기</button>
            </div>
          </Match>
          <Match when={true}>
            <Show when={props.m.reply}><p class="reply-line">{props.m.reply}</p></Show>
            <Show when={!props.m.reply && !routes().length}>
              <div class="reply-error">
                <Icon name="alert" size={14} />
                <span>답을 받지 못했어요</span>
                <button class="retry" onClick={props.retry}><Icon name="refresh" size={13} />다시 보내기</button>
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
                        <Icon name="handoff" size={13} />
                        <span><b>{taskById(a().taskId)?.title ?? "작업"}</b>에 전달했어요</span>
                      </button>
                    )}
                  </Match>
                  <Match when={r.kind === "stop" && r}>
                    {(a) => (
                      <button class="reply-note" onClick={() => openTask(a().taskId)}>
                        <Icon name="pause" size={13} />
                        <span><b>{taskById(a().taskId)?.title ?? "작업"}</b>을 멈췄어요</span>
                      </button>
                    )}
                  </Match>
                  <Match when={r.kind === "remember" && r}>
                    {(a) => (
                      <div class="reply-note">
                        <Icon name="memory" size={13} />
                        <span>기억했어요 · {state.memory.find((x) => x.id === a().memoryId)?.text ?? ""}</span>
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

/** Empty chat: a question, the box to answer it, and a few starts under it (like Codex). */
function Hero(props: { project?: string; composer: JSX.Element }) {
  // this space's accounts only: jobs here never run on the other space's
  const loggedIn = () => accountsIn(state.space).some((a) => a.providers.length);
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
    <div class="page hero-page">
      <div class="hero">
        <Show when={engine.checked && !engine.ready}>
          <div class="notice bad"><Icon name="alert" size={16} /><div class="notice-body"><b>엔진을 찾을 수 없어요</b><p>앱 파일이 손상됐어요. 다시 설치해 주세요.</p></div></div>
        </Show>
        <Show when={engine.checked && engine.ready && !loggedIn()}>
          <div class="notice">
            <Icon name="key" size={16} />
            <div class="notice-body"><b>로그인 필요</b></div>
            <button class="btn sm" onClick={() => setView({ name: "settings", tab: "accounts" })}>로그인</button>
          </div>
        </Show>
        <h2 class="hero-ask">{props.project ? `${projectById(props.project)?.name ?? "이 프로젝트"}에서 뭘 할까요?` : "어떤 일을 할까요?"}</h2>
        {props.composer}
        <div class="hero-picks">
          <Show when={suggestLoading() === key() && !picks().length}>
            <div class="hero-pick wait"><span class="spin xs" /><span>최근 일을 보는 중</span></div>
          </Show>
          <For each={(picks().length ? picks() : suggestLoading() === key() ? [] : STARTERS.map((s) => ({ text: s.text, why: "" }))).slice(0, 3)}>
            {(s) => (
              <button class="hero-pick" onClick={() => fill(s.text)} title={s.why || undefined}>
                <Icon name="spark" size={14} class="hero-pick-ic" />
                <span class="hero-pick-text">{s.text}</span>
              </button>
            )}
          </For>
          <For each={sessions()}>
            {(s) => (
              <button
                class="hero-pick"
                title={`${s.sourceName}에서 하던 일 이어서 하기`}
                onClick={async () => {
                  try {
                    openTask(await continueSession(s, state.space, s.sourceName));
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e), "bad");
                  }
                }}
              >
                <Icon name="history" size={14} class="hero-pick-ic" />
                <span class="hero-pick-text">{s.title || "제목 없음"}</span>
                <span class="hero-pick-meta">{s.sourceName} · {ago(s.updatedAt)}</span>
              </button>
            )}
          </For>
        </div>
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
        { name: "side", desc: "사이드챗 열기 (⌘J)", icon: "message", run: (a) => (openPanel("side"), a.trim() && void sendSide(state.space, a)) },
        { name: "compact", desc: "이 대화를 요약해서 정리", icon: "compact", run: () => void compactAgent(`captain:${key()}`) },
        { name: "flow", desc: "흐름 열기", icon: "branch", run: () => openPanel("flow") },
        { name: "ask", desc: "매번 묻도록 바꾸기", icon: "lock", run: () => setState("settings", "permission", "ask") },
        { name: "edits", desc: "편집 허용으로 바꾸기", icon: "pencil", run: () => setState("settings", "permission", "edits") },
        { name: "full", desc: "전체 권한으로 바꾸기", icon: "shield", run: () => setState("settings", "permission", "full") },
        { name: "remember", desc: "기억하기 · 뒤에 적은 내용을 앞으로 지켜요", icon: "memory", run: (a) => a.trim() && addMemory(a, "space", { space: state.space }) },
        { name: "memory", desc: "기억한 것 보기 (그래프)", icon: "memory", run: () => setView({ name: "memory" }) },
        { name: "settings", desc: "설정", icon: "gear", run: () => setView({ name: "settings" }) },
        { name: "clear", desc: "이 대화 지우고 새로 시작", icon: "refresh", run: () => void resetMain(state.space, project()?.id) },
        ...skillCommands(() => ({ space: state.space, project: project()?.id })),
      ]}
      placeholder={big ? "무엇이든 말해 주세요" : project() ? `${project()!.name}에 대해 말하기 · 일은 이 폴더에서 해요` : "메인에게 말하기 · 여러 일을 한 번에 적어도 돼요"}
      onSend={sendMain}
      onTyping={() => void warmMain(state.space, project()?.id)}
      top={<BtwCard scope={`main:${key()}`} />}
      status={<StatusLine accountId={account()} space={state.space} agent={`captain:${key()}`} />}
      plus={plusFor({ main: true })}
      running={msgs().some((m) => m.pending)}
      onStop={() => void stopMain(key())}
      left={<PermissionPicker value={state.settings.permission ?? "edits"} onChange={(p) => setState("settings", "permission", p)} />}
      right={
        <ModelPicker
          up={!big}
          accountId={account()}
          // the model belongs to the account this chat runs on: company and personal keep their own
          model={accountById(account())?.model ?? ""}
          thinking={effortFor(account()) || ""}
          onChange={(m, t) =>
            updateAccount(account(), (x) => {
              if (m) x.model = m;
              x.effort = t;
            })
          }
        />
      }
    />
  );

  return (
    <div class="view main-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <h1 class="head-title">
          <Show when={project()} fallback="메인">
            {(p) => (
              <>
                <span class="head-proj" title={p().folder}>{p().name}</span>
                <span class="head-sub">프로젝트 채팅</span>
              </>
            )}
          </Show>
        </h1>
        <span class="spacer" data-tauri-drag-region />
        <button class="icon-btn" classList={{ on: panelOpen() }} title="패널 (⌘\)" onClick={togglePanel}>
          <Icon name="panel" size={16} />
        </button>
      </header>
      <Show
        when={msgs().length}
        fallback={
          <Hero project={project()?.id} composer={composer(true)} />
        }
      >
        <RequestBoard
          msgs={msgs()}
          started={started}
          onJump={(id) => box?.querySelector(`[data-mid="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
        <div class="thread" ref={(el) => { box = el; onCleanup(keepBottom(el)); }}>
          <div class="thread-inner convo">
            <For each={msgs()}>
              {(m) => (
                <Show when={m.from === "me"} fallback={<Reply m={m} retry={() => retry(m)} chips={started(m)} active={openRoot()} />}>
                  <UserMsg id={m.id} text={m.text ?? ""} at={m.at} from={m.via === "main" ? "메인에서" : undefined} onEdit={m.via === "main" ? undefined : (t) => void editMain(m.id, t)} />
                </Show>
              )}
            </For>
            {/* what the jobs of this chat are asking: answered here, no need to open the job */}
            <For each={asks()}>{(d) => <DecisionCard d={d} />}</For>
          </div>
        </div>
        <div class="dock">
          <div class="dock-inner">{composer(false)}</div>
        </div>
      </Show>
    </div>
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
      else out.push({ id: ask.id, text: (ask.text ?? "").split("\n").find((l) => l.trim() && !/^https?:\/\//.test(l.trim())) ?? ask.text ?? "", tasks: [...tasks], state: "done", at: 0 });
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
  const count = (k: Req["state"]) => reqs().filter((r) => r.state === k).length;
  const active = (t: Task) => t.status === "running" || t.status === "waiting" || t.status === "queued";
  // what the job says it is doing now (its status line), not its title again
  const doing = (t: Task) => {
    const s = (t.status === "waiting" ? t.now : t.intent || t.now || "").trim();
    return s && s !== t.title ? s : "";
  };
  const working = () => reqs().flatMap((r) => (r.state === "done" ? [] : r.tasks.filter((t) => t.status === "running")));
  const label = { ask: "확인 필요", live: "진행 중", done: "끝남" } as const;
  const doneOf = (r: Req) => r.tasks.filter((t) => t.status === "done").length;
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
  return (
    <Show when={reqs().length}>
      <div class="req-board" classList={{ open: open() }}>
        <button class="req-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
          <span class="req-sum">
            요청 {reqs().length}
            <Show when={count("ask")}><span class="req-tag ask">확인 필요 {count("ask")}</span></Show>
            <Show when={count("live")}><span class="req-tag live">진행 중 {count("live")}</span></Show>
            <Show when={count("done")}><span class="req-tag done">끝남 {count("done")}</span></Show>
          </span>
          {/* closed: what is being worked on right now, in one line */}
          <Show when={!open() && working()[0]}>{(t) => <span class="req-now">{t().title}<Show when={doing(t())}> · {doing(t())}</Show></span>}</Show>
          <Icon name="chevron" size={12} class="req-chev" />
        </button>
        <Show when={open()}>
          <ul class="req-list">
            <For each={reqs()}>
              {(r) => (
                <li>
                  <button class="req-row" onClick={() => (r.state === "done" ? props.onJump(r.id) : openTask(focus(r).id))} title={r.text}>
                    <i class={`req-dot ${r.state}`} />
                    <span class="req-text">{r.text}</span>
                    <span class="req-steps">{doneOf(r)}/{r.tasks.length}</span>
                    <span class={`req-state ${r.state}`}>{label[r.state]}</span>
                  </button>
                  {/* the jobs working on it now: which one, what it is doing, for how long */}
                  <For each={r.state === "done" ? [] : r.tasks.filter(active)}>
                    {(t) => (
                      <button class="req-job" onClick={() => openTask(t.id)} title={t.title}>
                        <span class="req-job-title">{t.title}</span>
                        <Show when={doing(t)}><span class="req-job-now">{doing(t)}</span></Show>
                        <span class="req-job-time">{t.status === "waiting" ? "답 필요" : t.status === "running" && t.startedAt ? `${short(now() - t.startedAt)}째` : "대기"}</span>
                      </button>
                    )}
                  </For>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}
