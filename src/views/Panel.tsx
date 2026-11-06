// Right panel of a task: overview (now, plan, sessions, details), changes
// (git diff of its folder), terminal (every command it ran, live, plus a shell
// of your own in the same folder), and its browser, live.
import { Fold } from "../ui/Fold";
import { prettyModel } from "../ui/ModelPicker";
import { Markdown } from "../ui/Markdown";
import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { accountById, homeDir, state, updateTask } from "../state/store";
import type { Priority, Shell, Task } from "../state/types";
import { BrowserView } from "./Browser";
import { toast, activeTab, closePanelTab, newPanelTab, panelShared, panelTab, ptabs, setActiveTab, setPanelLeave, setPanelShared, setPanelTab, type PanelTab } from "../state/ui";
import { discardTask, gitEnv, mergeTask, prOf, setPriority, setWeight } from "../engine/tasks";
import { expand, tilde } from "../engine/rpc";
import { browserStreamPort, fileSrc, fsRead, gitCommit, gitPr, gitPush, openInTerminal, openUrl, revealPath } from "../lib/native";
import { artifacts, kindOf, loadArtifacts } from "../state/artifacts";
import { openImage } from "../ui/Lightbox";
import { long, now, priorityLabel, short, statusLabel } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { SideChat } from "../ui/Aside";
import { Flow } from "./Flow";
import { ChangesPane, FilesPane, PreviewPane } from "../ui/Review";
import { PrPane } from "../ui/PrPane";
import { ignoredKey, noModifiers, shortcutHint, viewKey } from "../lib/shortcuts";

/** The task's own branch: where it is, and merge / throw away. */
export function BranchCard(props: { t: Task }) {
  return <Show when={props.t.worktree}>{(wt) => <BranchCardIn t={props.t} w={wt()} />}</Show>;
}
function BranchCardIn(props: { t: Task; w: NonNullable<Task["worktree"]> }) {
  const w = () => props.w;
  const [sure, setSure] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  return (
    <div class="branch-card" classList={{ closed: w().state !== "open" }}>
      <div class="branch-line">
        <span class="branch-title">{w().state !== "open" ? "이 일의 변경" : props.t.status === "running" || props.t.status === "queued" ? "일이 끝나면 합칠 수 있어요" : "확인하고 합치면 원래 폴더에 들어가요"}</span>
        <span class="spacer" />
        <Show when={w().state === "merged"}><span class="branch-state ok"><Icon name="merge" size={12} />{w().into?.startsWith("PR ") ? `${w().into} 합쳐짐` : `${w().into}에 합침`}</span></Show>
        <Show when={w().state === "discarded"}><span class="branch-state">버림</span></Show>
      </div>
      <Show when={w().state === "open" && props.t.status !== "running" && props.t.status !== "queued"}>
        <div class="branch-actions">
          <ShipMenu t={props.t} />
          <span class="spacer" />
          <Show
            when={sure()}
            fallback={<button class="btn sm" onClick={() => setSure(true)}>버리기</button>}
          >
            <button class="btn sm danger" onClick={() => void discardTask(props.t.id)}>정말 버리기</button>
          </Show>
          <Show
            when={prOf(props.t)}
            fallback={
              <button
                class="btn sm primary"
                disabled={busy()}
                onClick={async () => {
                  setBusy(true);
                  await mergeTask(props.t.id);
                  setBusy(false);
                }}
              >
                <Icon name="merge" size={13} />
                {busy() ? "합치는 중…" : "원래 폴더에 합치기"}
              </button>
            }
          >
            {(pr) => <button class="btn sm primary" onClick={() => setPanelTab("pr")}>PR #{pr().n}</button>}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Commit / push / open a PR from the job's branch (like the git menu of Codex or Conductor). */
function ShipMenu(props: { t: Task }) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const cwd = () => expand(props.t.cwd);
  const run = async (label: string, f: () => Promise<string | void>, done: (r: string) => string) => {
    setOpen(false);
    setBusy(label);
    try {
      const r = await f();
      toast(done(String(r ?? "")));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(null);
    }
  };
  const close = () => setOpen(false);
  window.addEventListener("click", close);
  onCleanup(() => window.removeEventListener("click", close));
  return (
    <div class="ship" onClick={(e) => e.stopPropagation()}>
      <button class="btn sm" disabled={!!busy()} onClick={() => setOpen(!open())}>
        <Icon name="branch" size={13} />
        {busy() ?? "Git"}
        <Icon name="down" size={12} />
      </button>
      <Show when={open()}>
        <div class="menu ship-menu">
          <button onClick={() => void run("커밋하는 중…", async () => gitCommit(cwd(), props.t.title, await gitEnv(props.t)), (h) => `커밋했어요 · ${h}`)}>
            <Icon name="commit" size={14} class="muted" /><span class="row-title">커밋</span><span class="row-hint">지금 바뀐 것 전부</span>
          </button>
          <button onClick={() => void run("올리는 중…", async () => gitPush(cwd(), await gitEnv(props.t)), (b) => `${b} 브랜치를 올렸어요`)}>
            <Icon name="push" size={14} class="muted" /><span class="row-title">푸시</span><span class="row-hint">origin</span>
          </button>
          <button
            onClick={() =>
              void run(
                "PR 만드는 중…",
                async () => {
                  const url = await gitPr(cwd(), props.t.title, `${props.t.ask}\n\n— Ondra`, await gitEnv(props.t));
                  if (url.startsWith("http")) void openUrl(url);
                  return url;
                },
                (u) => (u ? `PR을 열었어요 · ${u}` : "PR을 열었어요"),
              )
            }
          >
            <Icon name="pr" size={14} class="muted" /><span class="row-title">PR 만들기</span><span class="row-hint">gh</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

function Overview(props: { t: Task }) {
  const t = () => props.t;
  return (
    <div class="pane">
      <div class="now-box">
        <div class="pane-title">{t().status === "done" ? "결과" : "지금"}</div>
        <div class="now-text">{t().status === "done" ? t().summary || t().now : t().status === "running" ? t().now : statusLabel[t().status]}</div>
      </div>
      <Show when={t().plan.length}>
        <div>
          <div class="pane-title">계획</div>
          <div class="plan">
            <For each={t().plan}>
              {(s) => (
                <div class={`plan-step ${s.state}`}>
                  <span class="mark"><Show when={s.state === "done"}><Icon name="check" size={9} stroke={3.5} /></Show></span>
                  <span>{s.text}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={t().legs.length > 1}>
        <div>
          <div class="pane-title">세션 {t().legs.length}개</div>
          <div class="legs">
            <For each={t().legs}>
              {(l, i) => (
                <div class="leg" classList={{ live: !l.endedAt && t().status === "running" }}>
                  <span class="leg-n">{i() + 1}</span>
                  <span class="leg-text">{l.handoff ? l.handoff.did[l.handoff.did.length - 1] ?? l.handoff.next : i() === t().legs.length - 1 ? t().now : "—"}</span>
                  <span class="leg-time">{short((l.endedAt ?? now()) - l.startedAt)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div>
        <dl class="kv">
          <dt>폴더</dt>
          <dd>
            <button class="path link" onClick={() => revealPath(expand(homeDir(t())))} title={homeDir(t())}>{tilde(expand(homeDir(t())))}</button>
          </dd>
          <Show when={t().status !== "done"}>
          <dt>우선순위</dt>
          <dd>
            <div class="seg">
              <For each={[0, 1, 2, 3] as Priority[]}>
                {(p) => <button classList={{ on: t().priority === p }} onClick={() => setPriority(t().id, p)}>{priorityLabel[p]}</button>}
              </For>
            </div>
          </dd>
          <dt>종류</dt>
          <dd>
            <div class="seg">
              <button classList={{ on: t().weight === "light" }} onClick={() => setWeight(t().id, "light")}>일반</button>
              <button classList={{ on: t().weight === "heavy" }} onClick={() => setWeight(t().id, "heavy")}>무거운 일</button>
            </div>
          </dd>
          </Show>
          <dt>계정</dt>
          <dd>
            <select class="select" value={t().accountId} onChange={(e) => updateTask(t().id, (x) => (x.accountId = e.currentTarget.value))}>
              <For each={state.accounts.filter((a) => a.space === t().space || a.id === t().accountId)}>{(a) => <option value={a.id}>{a.label}</option>}</For>
            </select>
            <span class="muted nowrap">{prettyModel(t().model || accountById(t().accountId)?.model || "") || "자동"}</span>
          </dd>
          <dt>{t().status === "done" ? "걸린 시간" : "진행"}</dt>
          <dd class="muted">{t().startedAt ? long((t().finishedAt ?? now()) - t().startedAt!) : "아직 시작 전"}</dd>
          <Show when={t().origin}>
            <dt>가져옴</dt>
            <dd class="muted"><span class="path">{tilde(t().origin!.path)}</span></dd>
          </Show>
        </dl>
      </div>
    </div>
  );
}

function ShellCard(props: { s: Shell; open: boolean; toggle: () => void }) {
  let pre: HTMLPreElement | undefined;
  createEffect(on(() => props.s.tail, () => queueMicrotask(() => pre && (pre.scrollTop = pre.scrollHeight))));
  return (
    <div class="shell" classList={{ bad: props.s.ok === false }}>
      <button class="shell-head" onClick={props.toggle}>
        <span class="shell-state">
          <Show when={props.s.endedAt} fallback={<span class="spin" />}>
            <Icon name={props.s.ok === false ? "x" : "check"} size={12} stroke={2.5} />
          </Show>
        </span>
        <span class="shell-cmd" title={props.s.command}>{props.s.command}</span>
        <Show when={props.s.background}><span class="shell-tag">백그라운드</span></Show>
        <span class="shell-time">{short((props.s.endedAt ?? now()) - props.s.startedAt)}</span>
      </button>
      <Fold open={props.open}>
        <pre class="shell-out" ref={pre}>{props.s.tail.trim() || (props.s.endedAt ? "출력 없음" : "출력 대기 중…")}</pre>
      </Fold>
    </div>
  );
}

/** What the job's commands are doing now: the running ones with their live output; finished ones folded. */
function TerminalPane(props: { t: Task }) {
  const [toggled, setToggled] = createSignal<Record<string, boolean>>({});
  const [past, setPast] = createSignal(false);
  const running = () => [...props.t.shells].reverse().filter((s) => !s.endedAt);
  const ended = () => [...props.t.shells].reverse().filter((s) => s.endedAt);
  const isOpen = (s: Shell) => toggled()[s.id] ?? !s.endedAt;
  const card = (s: Shell) => <ShellCard s={s} open={isOpen(s)} toggle={() => setToggled((o) => ({ ...o, [s.id]: !isOpen(s) }))} />;
  return (
    <div class="term-pane">
      <div class="term-sub">
        <span class="term-count">{running().length ? `실행 중 ${running().length}` : "실행 중인 셸 없음"}</span>
        <button class="btn sm ghost" onClick={() => void gitEnv(props.t).then((env) => openInTerminal(expand(props.t.cwd), env))} title={props.t.cwd}>
          <Icon name="shell" size={13} />
          터미널에서 열기
        </button>
      </div>
      <div class="shells">
        <For each={running()}>{card}</For>
        <Show when={ended().length}>
          <button class="sb-older shells-past" classList={{ open: past() }} onClick={() => setPast(!past())}>
            <Icon name="chevron" size={11} class="sb-older-chev" />
            {past() ? "끝난 명령 접기" : `끝난 명령 ${ended().length}개`}
          </button>
          <Show when={past()}>
            <For each={ended()}>{card}</For>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function BrowserPane(props: { t: Task }) {
  const [frame, setFrame] = createSignal<string | null>(null);
  const [size, setSize] = createSignal({ w: 1280, h: 800 });
  const [url, setUrl] = createSignal("");
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  const connect = async () => {
    if (!alive) return;
    const port = await browserStreamPort(props.t.id, props.t.space);
    if (!alive) return;
    if (!port) {
      timer = setTimeout(connect, 2500);
      return;
    }
    ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=10`);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "frame") {
          setFrame(`data:image/jpeg;base64,${msg.data}`);
          if (msg.metadata?.deviceWidth) setSize({ w: msg.metadata.deviceWidth, h: msg.metadata.deviceHeight });
        } else if (msg.type === "url" && msg.url) setUrl(msg.url);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (alive) timer = setTimeout(connect, 2500);
    };
  };
  onMount(connect);
  onCleanup(() => {
    alive = false;
    clearTimeout(timer);
    ws?.close();
  });

  const browsing = () => props.t.entries.flatMap((e) => (e.kind === "tool" && e.tool.kind === "browser" ? [{ ...e.tool, at: e.at }] : []));
  const lastPage = () => {
    const hit = [...browsing()].reverse().find((b) => /[\w-]+\.[a-z]{2,}(\/\S*)?/.test(b.target));
    return hit?.target.match(/[\w.-]+\.[a-z]{2,}(\/\S*)?/)?.[0];
  };
  const click = (e: MouseEvent) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * size().w);
    const y = Math.round(((e.clientY - r.top) / r.height) * size().h);
    for (const eventType of ["mousePressed", "mouseReleased"]) ws.send(JSON.stringify({ type: "input_mouse", eventType, x, y, button: "left", clickCount: 1 }));
  };

  const shown = () => url() || (lastPage() ? `https://${lastPage()}` : "");
  return (
    <div class="bpane">
      <div class="bbar">
        <span class="bdot" classList={{ live: !!frame() || (!!props.t.browser && props.t.status === "running") }} title={!!frame() || (!!props.t.browser && props.t.status === "running") ? "실시간으로 보는 중" : "멈춤"} />
        <div class="burl" title={shown()}>
          <Icon name="globe" size={13} />
          <span>{shown().replace(/^https?:\/\//, "") || "아직 연 페이지가 없어요"}</span>
        </div>
        <button class="icon-btn sm" title="주소 복사" disabled={!shown()} onClick={() => void navigator.clipboard.writeText(shown())}>
          <Icon name="copy" size={14} />
        </button>
        <button class="icon-btn sm" title="내 브라우저에서 열기" disabled={!shown()} onClick={() => void openUrl(shown())}>
          <Icon name="external" size={14} />
        </button>
        <button class="icon-btn sm" title="공유 브라우저에서 로그인·탐색" onClick={() => setPanelShared(true)}>
          <Icon name="key" size={14} />
        </button>
      </div>
      <div class="bview">
        <Show
          when={frame()}
          fallback={
            <Show when={props.t.shot} fallback={<div class="bempty">{!props.t.browser ? "이 일이 브라우저를 쓰면 여기에 실시간으로 보여요" : props.t.status === "running" ? "브라우저에 연결하는 중…" : "브라우저를 닫았어요"}</div>}>
              {(p) => <img src={fileSrc(p())} alt="마지막 스크린샷" />}
            </Show>
          }
        >
          {(f) => <img class="click" src={f()} alt="" onClick={click} draggable={false} title="눌러서 직접 조작할 수 있어요" />}
        </Show>
      </div>
    </div>
  );
}

/**
 * What the job made to be looked at: all of it as a grid first (like a folder);
 * one opens big, ← → moves through them (like Preview), Esc goes back.
 */
function ArtifactsPane(props: { t: Task }) {
  const list = () => artifacts[props.t.id] ?? [];
  const [pick, setPick] = createSignal<string>();
  const idx = () => list().findIndex((a) => a.path === pick());
  const cur = () => (idx() >= 0 ? list()[idx()] : undefined);
  const step = (d: number) => {
    const n = list().length;
    if (n && idx() >= 0) setPick(list()[(idx() + d + n) % n].path);
  };
  const [text, setText] = createSignal<string | null>(null);
  void loadArtifacts(props.t.id);
  const timer = setInterval(() => props.t.status === "running" && void loadArtifacts(props.t.id), 3000);
  onCleanup(() => clearInterval(timer));
  createEffect(() => {
    const a = cur();
    setText(null);
    if (a && kindOf(a.name) === "text") void fsRead(a.path).then((r) => setText(r.text ?? ""));
  });
  const onKey = (e: KeyboardEvent) => {
    if (!cur() || !viewKey(e) || !noModifiers(e)) return;
    if (e.key === "ArrowRight") (e.preventDefault(), step(1));
    else if (e.key === "ArrowLeft") (e.preventDefault(), step(-1));
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setPick(undefined));
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const icon = (name: string) => (kindOf(name) === "page" ? "globe" : kindOf(name) === "video" ? "video" : "file");
  return (
    <div class="apane">
      <Show when={list().length} fallback={<div class="pane-empty">없음</div>}>
        <Show
          when={cur()}
          keyed
          fallback={
            <>
              <div class="abar">
                <span class="acount">{list().length}개</span>
                <button class="icon-btn sm" title="Finder에서 보기" onClick={() => void revealPath(list()[0].path.replace(/\/[^/]*$/, ""))}>
                  <Icon name="open" size={14} />
                </button>
              </div>
              <div class="agrid">
                <For each={list()}>
                  {(a) => (
                    <button
                      class="acell"
                      // a picture opens full size at once; other files open in the panel
                      onClick={() => (kindOf(a.name) === "image" ? openImage(a.path, list().filter((x) => kindOf(x.name) === "image").map((x) => x.path)) : setPick(a.path))}
                      title={a.name}
                    >
                      <span class="athumb">
                        <Switch fallback={<Icon name={icon(a.name)} size={20} />}>
                          <Match when={kindOf(a.name) === "image"}><img src={fileSrc(a.path)} alt="" loading="lazy" /></Match>
                          <Match when={kindOf(a.name) === "video"}><video src={`${fileSrc(a.path)}#t=0.1`} preload="metadata" muted /></Match>
                        </Switch>
                      </span>
                      <span class="aname">{a.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </>
          }
        >
          {(a) => (
            <>
              <div class="abar">
                <button class="icon-btn sm" title="모두 보기 (Esc)" onClick={() => setPick(undefined)}><Icon name="back" size={14} /></button>
                <span class="aname-cur" title={a.name}>{a.name}</span>
                <span class="acount">{idx() + 1}/{list().length}</span>
                <Show when={list().length > 1}>
                  <button class="icon-btn sm" title="이전 (←)" onClick={() => step(-1)}><Icon name="back" size={14} /></button>
                  <button class="icon-btn sm" title="다음 (→)" onClick={() => step(1)}><Icon name="arrow" size={14} /></button>
                </Show>
                <button class="icon-btn sm" title="Finder에서 보기" onClick={() => void revealPath(a.path)}><Icon name="open" size={14} /></button>
              </div>
              <div class="aview">
                <Switch fallback={<div class="pane-empty">미리 볼 수 없음</div>}>
                  <Match when={kindOf(a.name) === "page"}>
                    <Show when={/\.pdf$/i.test(a.path)} fallback={<iframe class="aframe" src={`${fileSrc(a.path)}?v=${a.modified}`} sandbox="allow-scripts allow-popups allow-forms" title={a.name} />}>
                      <iframe class="aframe" src={`${fileSrc(a.path)}?v=${a.modified}`} title={a.name} />
                    </Show>
                  </Match>
                  <Match when={kindOf(a.name) === "image"}>
                    <div class="aimg"><img src={fileSrc(a.path)} alt="" onClick={() => openImage(a.path, list().filter((x) => kindOf(x.name) === "image").map((x) => x.path))} /></div>
                  </Match>
                  <Match when={kindOf(a.name) === "video"}>
                    <div class="aimg"><video src={fileSrc(a.path)} controls /></div>
                  </Match>
                  <Match when={kindOf(a.name) === "text"}>
                    <div class="atext">
                      <Show when={/\.md$/i.test(a.name)} fallback={<pre>{text() ?? ""}</pre>}>
                        <Markdown class="msg-text" text={text() ?? ""} />
                      </Show>
                    </div>
                  </Match>
                </Switch>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

const TOOLS: { kind: PanelTab; label: string; icon: string; keys?: string; job?: boolean }[] = [
  { kind: "flow", label: "흐름", icon: "branch", keys: shortcutHint("flow") },
  { kind: "side", label: "사이드챗", icon: "message", keys: shortcutHint("side") },
  { kind: "artifacts", label: "결과물", icon: "spark", keys: shortcutHint("artifacts"), job: true },
  { kind: "changes", label: "변경 사항", icon: "diff", keys: shortcutHint("changes"), job: true },
  { kind: "pr", label: "PR", icon: "pr", keys: shortcutHint("pr"), job: true },
  { kind: "terminal", label: "셸", icon: "shell", keys: shortcutHint("terminal"), job: true },
  { kind: "files", label: "파일", icon: "file", keys: shortcutHint("files"), job: true },
  { kind: "browser", label: "브라우저", icon: "globe", keys: shortcutHint("browser") },
  { kind: "overview", label: "정보", icon: "list", keys: shortcutHint("overview"), job: true },
  { kind: "preview", label: "미리보기", icon: "file" },
];
const toolOf = (k: PanelTab) => TOOLS.find((x) => x.kind === k) ?? { kind: "new" as PanelTab, label: "새 탭", icon: "plus" };

/** The empty tab: the tools you can open here. */
function NewTab(props: { t?: Task }) {
  return (
    <div class="nt">
      <div class="nt-head">도구</div>
      <For each={TOOLS}>
        {(x) => (
          <button class="nt-row" disabled={x.job && !props.t} onClick={() => setPanelTab(x.kind)}>
            <Icon name={x.icon} size={16} />
            <span class="nt-label">{x.label}</span>
            <Show when={ptabs().some((p) => p.kind === x.kind)}><span class="nt-open">열림</span></Show>
            <Show when={x.job && !props.t} fallback={<Show when={x.keys}><kbd class="nt-keys">{x.keys}</kbd></Show>}>
              <span class="nt-hint">일을 고르면 쓸 수 있어요</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}

/** when the last panel went away: a re-mount right after a close shouldn't slide again */
let panelGoneAt = 0;
const DRAWER = "cubic-bezier(.32,.72,0,1)";
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Panel(props: { t?: Task; onClose: () => void }) {
  let el!: HTMLElement;
  const entering = Date.now() - panelGoneAt > 160;
  // slide in and out by pushing the center aside (negative margin), not over it
  onMount(() => {
    if (entering && !reduced()) {
      const w = el.offsetWidth;
      el.animate([{ marginRight: `${-w}px`, opacity: 0.4 }, { marginRight: "0px", opacity: 1 }], { duration: 340, easing: DRAWER });
    }
    setPanelLeave(() => {
      if (reduced()) return Promise.resolve();
      const w = el.offsetWidth;
      return el.animate([{ marginRight: "0px", opacity: 1 }, { marginRight: `${-w}px`, opacity: 0.4 }], { duration: 240, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished;
    });
  });
  onCleanup(() => {
    panelGoneAt = Date.now();
    setPanelLeave(null);
  });
  const running = () => props.t?.shells.filter((s) => !s.endedAt).length ?? 0;
  const tab = panelTab;
  // the active tab's pill slides between tabs
  let bar!: HTMLDivElement;
  const [ind, setInd] = createSignal({ x: 0, w: 0, on: false });
  const measure = () => {
    const on = bar?.querySelector<HTMLElement>(".ptab.on");
    if (on) setInd({ x: on.offsetLeft, w: on.offsetWidth, on: true });
    else setInd((v) => ({ ...v, on: false }));
  };
  createEffect(
    on([activeTab, () => ptabs().map((t) => t.kind).join()], () =>
      requestAnimationFrame(() => {
        measure();
        bar?.querySelector<HTMLElement>(".ptab.on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
      }),
    ),
  );
  // drag the left edge to resize; remembered per machine
  const KEY = "ondra.jobW";
  try {
    const w = Number(localStorage.getItem(KEY));
    if (w >= 380 && w <= 980) document.documentElement.style.setProperty("--job-w", `${w}px`);
  } catch {
    /* storage can be blocked */
  }
  const drag = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
    const max = Math.min(980, window.innerWidth - 600);
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(380, Math.min(max, startW + startX - ev.clientX));
      document.documentElement.style.setProperty("--job-w", `${w}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem(KEY, String(Math.round(w)));
      } catch {
        /* ignore */
      }
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const needsJob = () => !props.t && tab() !== "flow" && tab() !== "new" && tab() !== "side" && tab() !== "browser";
  /** the browser tab shows the job's own tab while it browses, else the shared browser */
  const shared = () => tab() === "browser" && (!props.t?.browser || panelShared());
  return (
    <aside class="panel" ref={el} classList={{ "flow-only": !props.t && tab() === "flow" }}>
      <div class="panel-resize" onPointerDown={drag} title="끌어서 너비 바꾸기" />
      <div class="panel-bar" data-tauri-drag-region>
        <div class="ptabs" ref={bar} classList={{ compact: ptabs().length >= 5 }}>
          <span class="tab-ind" classList={{ on: ind().on }} style={{ transform: `translateX(${ind().x}px)`, width: `${ind().w}px` }} />
          <For each={ptabs()}>
            {(x) => {
              const tool = () => toolOf(x.kind);
              return (
                <div
                  class="ptab"
                  classList={{ on: activeTab() === x.id }}
                  role="tab"
                  tabindex="0"
                  aria-selected={activeTab() === x.id}
                  title={`${tool().label}${tool().keys ? ` (${tool().keys})` : ""} · 이전/다음 탭 ${shortcutHint("previousTab")} / ${shortcutHint("nextTab")}`}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || ignoredKey(e) || !noModifiers(e) || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    setActiveTab(x.id);
                  }}
                  onClick={() => setActiveTab(x.id)}
                  onAuxClick={(e) => e.button === 1 && closePanelTab(x.id)}
                >
                  <Icon name={tool().icon} size={13} />
                  <span class="ptab-label">{tool().label}</span>
                  <Show when={x.kind === "terminal" && running()}><span class="badge">{running()}</span></Show>
                  <Show when={x.kind === "browser" && props.t?.browser && props.t?.status === "running"}><span class="screen-live" /></Show>
                  <button
                    class="ptab-x"
                    title={`탭 닫기${activeTab() === x.id ? ` (${shortcutHint("closeTab")})` : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closePanelTab(x.id);
                    }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
        <button class="icon-btn sm ptab-add" title={`새 탭 (${shortcutHint("newTab")})`} onClick={newPanelTab}>
          <Icon name="plus" size={14} />
        </button>
        <span class="spacer" data-tauri-drag-region />
      </div>
      <div class="panel-body">
        <Switch>
          <Match when={tab() === "new"}><NewTab t={props.t} /></Match>
          <Match when={tab() === "flow"}><div class="flow-pane"><Flow /></div></Match>
          <Match when={tab() === "side"}><SideChat /></Match>
          <Match when={tab() === "preview"}><PreviewPane /></Match>
          <Match when={shared()}>
            <div class="pbrowser">
              <Show when={props.t?.browser}>
                <button class="pbrowser-back" onClick={() => setPanelShared(false)}>
                  <Icon name="back" size={12} />이 일의 화면
                </button>
              </Show>
              <BrowserView embedded />
            </div>
          </Match>
          <Match when={needsJob()}><div class="pane-empty" /></Match>
          <Match when={props.t}>
            {(t) => (
              <Switch>
                <Match when={tab() === "overview"}><Overview t={t()} /></Match>
                <Match when={tab() === "changes"}><ChangesPane t={t()} top={t().worktree ? <BranchCard t={t()} /> : undefined} /></Match>
                <Match when={tab() === "pr"}>
                  <Show when={prOf(t())?.url} keyed fallback={<div class="pane-empty">이 일에는 PR이 없어요</div>}>
                    {(_url) => <PrPane t={t()} />}
                  </Show>
                </Match>
                <Match when={tab() === "files"}><FilesPane t={t()} /></Match>
                <Match when={tab() === "terminal"}><TerminalPane t={t()} /></Match>
                <Match when={tab() === "browser"}><BrowserPane t={t()} /></Match>
                <Match when={tab() === "artifacts"}><ArtifactsPane t={t()} /></Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
