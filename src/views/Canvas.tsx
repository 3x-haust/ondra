// The canvas: all the work of a space as a map you can pan and zoom.
// Main sits on the left, its projects next, then the jobs, then each job's
// subagents, joined by lines. A card does not tell you in words what a job is
// doing; it shows it: the tool it is using right now moves, the strip under it
// is the rhythm of its last steps, the bar is its plan, the split is its diff.
// Cards can be dragged; where you put them is kept.
import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
type P = { x: number; y: number };
import { decisionFor, projectsIn, setState, spaceById, state, taskById } from "../state/store";
import type { Project, Task, ToolKind } from "../state/types";
import { goMain, live, openTask, setView } from "../state/ui";
import { tell } from "../engine/tasks";
import { throwThought } from "../engine/captain";
import { describeCommand } from "../engine/describe";
import { costDetail, costShort, jobCost } from "../ui/cost";
import { compact, now } from "../ui/bits";
import { browserStreamPort, fileSrc } from "../lib/native";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { changes, SidebarToggle } from "./Sidebar";
import { Board } from "./Board";
import { viewKey } from "../lib/shortcuts";

// ───────────── geometry

const W = { main: 168, proj: 220, job: 288, sub: 236 };
const H = { main: 84, proj: 84, job: 196, sub: 84, more: 40 };
const X = { main: 0, proj: 248, job: 560 };
const GAP = { job: 28, col: 24, sub: 12, proj: 56 };
const SUB_INDENT = 28;

type Kind = "main" | "proj" | "job" | "sub" | "more";
interface Node {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  task?: Task;
  project?: Project | { id: string; name: string; folder: string };
  /** on a "more" node: how many finished jobs it folds */
  count?: number;
}
interface Edge {
  from: string;
  to: string;
  tone: string;
}

const mode = () => "canvas" as "canvas" | "list";
/** projects whose finished jobs are unfolded on the canvas */
const [unfolded, setUnfolded] = createSignal<string[]>([]);
/** a finished job folds into "끝난 일" right away (one waiting on a merge or an answer stays out) */
const folded = (t: Task) => tone(t) === "done" && !t.pinned;
/** a finished sub-job folds under its job the same way */
const subFolded = (k: Task) => k.status === "done" && !k.pinned;

/** live = working now · ask = needs you · review = done, branch not merged · idle · done */
function tone(t: Task): string {
  const kids = state.tasks.filter((k) => k.parentId === t.id);
  if (t.status === "waiting" || t.status === "failed" || kids.some((k) => k.status === "waiting" || k.status === "failed")) return "ask";
  if (t.status === "running" || kids.some((k) => k.status === "running")) return "live";
  if (t.status === "queued" || t.status === "paused") return "idle";
  if (t.status === "done" && t.worktree?.state === "open") return "review";
  return "done";
}

function layout(space: string, open: string[], maxCols = 3): { nodes: Node[]; edges: Edge[] } {
  const roots = state.tasks.filter((t) => t.space === space && !t.parentId && !t.answer && !t.archived);
  const projects: (Project | { id: string; name: string; folder: string })[] = [...projectsIn(space as Task["space"])];
  if (roots.some((t) => !t.project || !projects.some((p) => p.id === t.project))) projects.push({ id: "_", name: "그 밖의 일", folder: spaceById(space as Task["space"]).folder });
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let y = 0;
  const projNodes: Node[] = [];
  for (const p of projects) {
    const all = roots
      .filter((t) => (p.id === "_" ? !t.project || !projects.some((q) => q.id === t.project && q.id !== "_") : t.project === p.id))
      .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
    // finished jobs fold into one "끝난 일 N개" card per project; it unfolds them under it
    const done = all.filter(folded);
    const jobs = open.includes(p.id) ? all : all.filter((t) => !folded(t));
    const top = y;
    // a grid, not one long column: up to 3 jobs side by side, a job's own
    // sub-jobs stacked under it
    const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(jobs.length))));
    for (let r = 0; r < jobs.length; r += cols) {
      const row = jobs.slice(r, r + cols);
      let rowH = 0;
      row.forEach((t, c) => {
        const x = X.job + c * (W.job + GAP.col);
        nodes.push({ id: t.id, kind: "job", x, y, w: W.job, h: H.job, task: t });
        edges.push({ from: `p:${p.id}`, to: t.id, tone: tone(t) });
        let ky = y + H.job + GAP.sub;
        const kids = state.tasks.filter((k) => k.parentId === t.id);
        const kidsDone = kids.filter(subFolded);
        for (const k of open.includes(t.id) ? kids : kids.filter((k) => !subFolded(k))) {
          nodes.push({ id: k.id, kind: "sub", x: x + SUB_INDENT, y: ky, w: W.job - SUB_INDENT, h: H.sub, task: k });
          edges.push({ from: t.id, to: k.id, tone: tone(k) });
          ky += H.sub + GAP.sub;
        }
        if (kidsDone.length) {
          nodes.push({ id: `more:${t.id}`, kind: "more", x: x + SUB_INDENT, y: ky, w: W.job - SUB_INDENT, h: H.more, project: { id: t.id, name: t.title, folder: "" }, task: t, count: kidsDone.length });
          ky += H.more + GAP.sub;
        }
        rowH = Math.max(rowH, ky - GAP.sub - y);
      });
      y += rowH + GAP.job;
    }
    if (done.length) {
      nodes.push({ id: `more:${p.id}`, kind: "more", x: X.job, y, w: W.job, h: H.more, project: p, count: done.length });
      y += H.more + GAP.job;
    }
    const shownAny = jobs.length || done.length;
    const span = shownAny ? y - GAP.job - top : H.proj;
    if (!shownAny) y += H.proj + GAP.job;
    const pn: Node = { id: `p:${p.id}`, kind: "proj", x: X.proj, y: top + (span - H.proj) / 2, w: W.proj, h: H.proj, project: p };
    projNodes.push(pn);
    nodes.push(pn);
    edges.push({ from: "main", to: pn.id, tone: jobs.some((t) => tone(t) === "ask") ? "ask" : jobs.some((t) => tone(t) === "live") ? "live" : jobs.length ? "done" : "idle" });
    y += GAP.proj - GAP.job;
  }
  const mid = projNodes.length ? (projNodes[0].y + projNodes[projNodes.length - 1].y + H.proj) / 2 : H.main / 2;
  nodes.unshift({ id: "main", kind: "main", x: X.main, y: mid - H.main / 2, w: W.main, h: H.main });
  // where the user put things wins
  const moved = state.canvas ?? {};
  for (const n of nodes) {
    const m = moved[`${space}:${n.id}`];
    if (m) (n.x = m.x), (n.y = m.y);
  }
  return { nodes, edges };
}

// ───────────── what a job is doing, as a picture

type Act = { kind: string; icon: string; label: string; target?: string };
const ACT: Record<ToolKind | "think" | "write-text" | "wait" | "queued" | "done" | "review" | "failed" | "paused", Omit<Act, "target" | "kind">> = {
  read: { icon: "read", label: "읽는 중" },
  search: { icon: "search", label: "찾는 중" },
  edit: { icon: "pencil", label: "고치는 중" },
  write: { icon: "write", label: "만드는 중" },
  bash: { icon: "terminal", label: "실행 중" },
  test: { icon: "test", label: "테스트 중" },
  browser: { icon: "globe", label: "웹에서" },
  desktop: { icon: "monitor", label: "화면에서" },
  other: { icon: "tools", label: "도구 쓰는 중" },
  think: { icon: "brain", label: "생각 중" },
  "write-text": { icon: "message", label: "답 쓰는 중" },
  wait: { icon: "bell", label: "답이 필요해요" },
  queued: { icon: "clock", label: "순서 기다림" },
  paused: { icon: "pause", label: "쉬는 중" },
  done: { icon: "done", label: "끝났어요" },
  review: { icon: "merge", label: "확인하고 합치기" },
  failed: { icon: "alert", label: "멈췄어요" },
};

function actOf(t: Task): Act {
  const pick = (k: keyof typeof ACT, target?: string): Act => ({ kind: k, ...ACT[k], target });
  if (t.status === "waiting") return pick("wait", decisionFor(t.id)?.question);
  if (t.status === "failed") return pick("failed");
  if (t.status === "queued") return pick("queued");
  if (t.status === "paused") return pick("paused");
  if (t.status === "done") return pick(t.worktree?.state === "open" ? "review" : "done");
  const last = t.entries[t.entries.length - 1];
  if (last?.kind === "tool" && !last.tool.endedAt) return pick(last.tool.kind, last.tool.target);
  if (live[t.id]) return pick("write-text");
  // what the job itself says it's doing, as in its own view
  if (t.now) return { kind: "think", icon: ACT.think.icon, label: t.now };
  return pick("think");
}

const base = (s?: string) => (s ? s.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 40) : undefined);

/** the tool steps of a job, oldest first (the last 28) */
const steps = (t: Task) =>
  t.entries
    .flatMap((e) => (e.kind === "tool" ? [{ id: e.id, kind: e.tool.kind, ok: e.tool.ok !== false, open: !e.tool.endedAt, target: e.tool.target }] : []))
    .slice(-28);

/** +8 −3, plain */
function Diff(props: { t: Task }) {
  const d = () => changes(props.t);
  return (
    <Show when={d().add || d().del}>
      <span class="cv-diff">
        <span class="add">+{d().add}</span>
        <Show when={d().del}><span class="del">−{d().del}</span></Show>
      </span>
    </Show>
  );
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const lastLines = (s: string, n: number) =>
  s
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter(Boolean)
    .slice(-n);

/** The browser a job is driving, live (a few frames a second), or its last screenshot. */
function BrowserThumb(props: { t: Task }) {
  const [frame, setFrame] = createSignal<string | null>(null);
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  const connect = async () => {
    if (!alive || props.t.status !== "running") return;
    const port = await browserStreamPort(props.t.id, props.t.space);
    if (!alive) return;
    if (!port) return void (timer = setTimeout(connect, 4000));
    ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=3`);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "frame") setFrame(`data:image/jpeg;base64,${msg.data}`);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => alive && (timer = setTimeout(connect, 4000));
  };
  onMount(connect);
  onCleanup(() => {
    alive = false;
    clearTimeout(timer);
    ws?.close();
  });
  const src = () => frame() ?? (props.t.shot ? fileSrc(props.t.shot) : null);
  return (
    <Show when={src()} fallback={<div class="cv-live-empty">브라우저 여는 중</div>}>
      {(s) => <img class="cv-shot" src={s()} alt="" draggable={false} />}
    </Show>
  );
}

/** One past or running step of a job, in plain words. */
function said(e: { tool: { kind: ToolKind; name: string; target: string; detail?: string; note?: boolean; add?: number; del?: number } }): { icon: string; label: string; target: string } {
  const x = e.tool;
  const icon = ACT[x.kind]?.icon ?? "tools";
  if (x.kind === "bash") {
    const d = describeCommand(x.detail ?? x.target);
    return { icon, label: d.label, target: d.target && !d.label.includes(d.target) ? d.target : "" };
  }
  if (x.note) return { icon: "write", label: "기록", target: x.target };
  const L: Partial<Record<ToolKind, string>> = { read: x.name === "web_fetch" ? "웹 읽기" : "읽기", edit: "수정", write: "만들기", search: x.name === "web_search" ? "웹 검색" : "찾기", test: "테스트", desktop: "화면 조작" };
  if (x.kind === "browser") return { icon, label: "브라우저", target: x.target.match(/https?:\/\/(?:www\.)?([^/\s"']+)/)?.[1] ?? x.target.split(/\s+/)[0] ?? "" };
  if (x.kind === "other") return { icon, label: ({ memory_search: "기억 찾기", subagent: "서브 일 맡기기" } as Record<string, string>)[x.name] ?? x.name, target: "" };
  return { icon, label: L[x.kind] ?? x.name, target: x.target };
}

/**
 * What a working job is on, drawn from what it already reports (no extra model
 * calls): its plan as a rail, its own sentence for now, and its last few steps
 * in plain words, the running one with its latest output line.
 */
function Activity(props: { t: Task }) {
  const t = () => props.t;
  const cur = () => t().plan.findIndex((s) => s.state === "now");
  const head = () => t().intent || t().plan[cur()]?.text || t().now;
  const sub = () => (t().intent && cur() >= 0 && t().plan[cur()].text !== t().intent ? t().plan[cur()].text : "");
  const toolIds = createMemo(() => {
    const ids: string[] = [];
    for (let i = t().entries.length - 1; i >= 0 && ids.length < 3; i--) if (t().entries[i].kind === "tool") ids.unshift(t().entries[i].id);
    return ids;
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const entry = (id: string) => t().entries.find((e) => e.id === id) as Extract<Task["entries"][number], { kind: "tool" }> | undefined;
  const tail = (id: string) => {
    const e = entry(id);
    const sh = e?.tool.shellId ? t().shells.find((s) => s.id === e.tool.shellId) : undefined;
    return sh?.tail ? (lastLines(sh.tail, 1)[0] ?? "").trim().slice(-120) : "";
  };
  return (
    <div class="cv-act">
      <Show when={t().plan.length > 1}>
        <div class="cv-act-rail" title={t().plan.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}>
          <For each={t().plan}>{(s) => <i class={s.state} />}</For>
        </div>
      </Show>
      <Show when={sub()}><span class="cv-act-step">{cur() + 1}/{t().plan.length} · {sub()}</span></Show>
      <p class="cv-act-head">{head()}</p>
      {/* newest first in the DOM: the feed stacks from the bottom and drops whole rows that don't fit */}
      <div class="cv-act-feed">
        <For each={[...toolIds()].reverse()}>
          {(id) => {
            const e = () => entry(id);
            const s = () => (e() ? said(e()!) : { icon: "tools", label: "", target: "" });
            const open = () => !!e() && !e()!.tool.endedAt;
            return (
              <div class="cv-act-row" classList={{ open: open(), bad: e()?.tool.ok === false }}>
                <Icon name={s().icon} size={11} />
                <span class="lb">{s().label}</span>
                <Show when={s().target}><span class="tg">{s().target}</span></Show>
                <Show when={open() && tail(id)}><span class="tl">{tail(id)}</span></Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/**
 * The bottom of what the job is doing right now: the browser it drives, the
 * last lines of the command it runs, or the end of what it is writing.
 */
function Live(props: { t: Task }) {
  const t = () => props.t;
  const lastTool = () => {
    for (let i = t().entries.length - 1; i >= 0; i--) {
      const e = t().entries[i];
      if (e.kind === "tool") return e.tool;
    }
    return undefined;
  };
  const shell = () => {
    const open = t().shells.filter((s) => !s.endedAt && !s.background);
    return open[open.length - 1] ?? (lastTool()?.kind === "bash" || lastTool()?.kind === "test" ? t().shells[t().shells.length - 1] : undefined);
  };
  const what = (): "browser" | "shell" | "text" | "tool" | "act" | "question" | "summary" | "none" => {
    if (t().status === "waiting" && decisionFor(t().id)) return "question";
    if (t().status === "running") {
      // the browser only while it's what the job is using now (not after it moved on to the desktop or a shell)
      if (lastTool()?.kind === "browser") return "browser";
      if (live[t().id] && !t().intent && !t().plan.length) return "text";
      if (lastTool() || t().intent || t().plan.length) return "act";
      return "none";
    }
    if (t().shot && lastTool()?.kind === "browser") return "browser";
    return t().summary || t().error || t().ask ? "summary" : "none";
  };
  return (
    <div class={`cv-live w-${what()}`}>
      <Switch fallback={<div class="cv-live-empty">{t().status === "queued" ? "순서를 기다려요" : t().status === "running" ? "시작하는 중" : ""}</div>}>
        <Match when={what() === "browser"}><BrowserThumb t={t()} /></Match>
        <Match when={what() === "shell"}>
          <pre class="cv-term"><span class="cv-cmd">$ {shell()!.command}</span>{"\n"}{lastLines(shell()!.tail, 4).join("\n")}</pre>
        </Match>
        <Match when={what() === "text"}>
          <p class="cv-text">{lastLines(live[t().id] ?? "", 3).join(" ").slice(-220)}</p>
        </Match>
        <Match when={what() === "tool"}>
          <pre class="cv-term"><span class="cv-cmd">{ACT[lastTool()!.kind]?.label ?? "도구"}</span>{"  "}{lastTool()!.target}</pre>
        </Match>
        <Match when={what() === "act"}><Activity t={t()} /></Match>
        <Match when={what() === "question"}>
          <p class="cv-text ask">{decisionFor(t().id)!.question}</p>
        </Match>
        <Match when={what() === "summary"}>
          <p class="cv-text" classList={{ muted: !t().summary && !t().error }}>{t().error || t().summary || t().ask}</p>
          <Show when={t().status === "done" && t().unverified?.length}>
            <span class="unverified-badge" title={t().unverified!.join("\n")}>확인 안 됨 {t().unverified!.length}</span>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

// ───────────── cards (Railway-like: icon and name on top, one status line at the bottom)

const STATUS: Record<string, string> = { live: "일하는 중", ask: "답이 필요해요", review: "검토 대기", idle: "대기", done: "끝남" };

function Glyph(props: { t: Task; size?: number }) {
  const a = () => actOf(props.t);
  return (
    <span class="cv-glyph" title={a().label}>
      <Icon name={a().icon} size={props.size ?? 15} />
    </span>
  );
}

function StatusRow(props: { t: Task }) {
  const tn = () => tone(props.t);
  const kids = () => state.tasks.filter((k) => k.parentId === props.t.id);
  const step = () => {
    const p = props.t.plan;
    const i = p.findIndex((x) => x.state === "now");
    return p.length ? `${(i < 0 ? p.filter((x) => x.state === "done").length : i + 1)}/${p.length}단계` : "";
  };
  const when = () => (props.t.status === "running" && props.t.startedAt ? compact(now() - props.t.startedAt) : "");
  return (
    <div class="cv-status">
      <i class={`cv-dot t-${tn()}`} />
      <span class="cv-status-text">{tn() === "live" ? actOf(props.t).label : STATUS[tn()]}</span>
      <Show when={step()}><span class="cv-meta">{step()}</span></Show>
      <Show when={kids().length}><span class="cv-meta">서브 {kids().filter((k) => k.status === "running").length || kids().length}</span></Show>
      <span class="spacer" />
      <Diff t={props.t} />
      <Show when={when()}><span class="cv-when">{when()}</span></Show>
      <Show when={props.t.status === "done" && jobCost(props.t)} keyed>
        {(c) => <Show when={costShort(c)}><span class="cv-when" title={costDetail(c)}>{costShort(c)}</span></Show>}
      </Show>
    </div>
  );
}

function JobCard(props: { n: Node }) {
  const t = () => props.n.task!;
  return (
    <>
      <div class="cv-head">
        <Glyph t={t()} />
        <span class="cv-title">{t().title}</span>
      </div>
      <Live t={t()} />
      <StatusRow t={t()} />
    </>
  );
}

function SubCard(props: { n: Node }) {
  const t = () => props.n.task!;
  return (
    <>
      <div class="cv-head">
        <Glyph t={t()} size={13} />
        <span class="cv-title">{t().title}</span>
      </div>
      <StatusRow t={t()} />
    </>
  );
}

function ProjCard(props: { n: Node; space: string }) {
  const p = () => props.n.project!;
  const jobs = () => state.tasks.filter((t) => t.space === props.space && !t.parentId && !t.answer && !t.archived && (p().id === "_" ? !t.project : t.project === p().id));
  const count = (k: string) => jobs().filter((t) => tone(t) === k).length;
  const busy = () => p().id !== "_" && state.captain.some((m) => m.space === props.space && m.project === p().id && m.pending);
  return (
    <>
      <div class="cv-head">
        <span class="cv-glyph k-proj" classList={{ busy: busy() }}>
          <Icon name={p().id === "_" ? "inbox" : "folder"} size={15} />
        </span>
        <span class="cv-title">{p().name}</span>
      </div>
      <div class="cv-status">
        <div class="cv-proj-meter" title="진행 · 답 필요 · 검토 · 대기 · 끝남">
          <For each={["live", "ask", "review", "idle", "done"]}>{(k) => <Show when={count(k)}><i class={`t-${k}`} style={{ flex: count(k) }} /></Show>}</For>
          <Show when={!jobs().length}><i class="empty" style={{ flex: 1 }} /></Show>
        </div>
        <span class="cv-when">{jobs().length ? `${jobs().length}개` : "비어 있음"}</span>
      </div>
    </>
  );
}

/** A project's finished jobs, folded into one line. */
function MoreCard(props: { n: Node }) {
  const open = () => unfolded().includes(props.n.project!.id);
  return (
    <div class="cv-more-row" classList={{ open: open() }} title={open() ? "끝난 일 접기" : "끝난 일 펼치기"}>
      <Icon name="chevron" size={12} class={`cv-more-chev${open() ? " open" : ""}`} />
      <span>{props.n.task ? (open() ? "끝난 서브 접기" : "끝난 서브") : open() ? "끝난 일 접기" : "끝난 일"}</span>
      <Show when={!open()}><b class="cv-more-n">{props.n.count}</b></Show>
    </div>
  );
}

function MainCard() {
  const busy = () => state.captain.some((m) => m.space === state.space && !m.project && m.pending);
  return (
    <>
      <div class="cv-head">
        <span class="cv-glyph k-main" classList={{ busy: busy() }}>
          <Icon name="message" size={15} />
        </span>
        <span class="cv-title">메인</span>
      </div>
      <div class="cv-status">
        <i class={`cv-dot ${busy() ? "t-live" : "t-done"}`} />
        <span class="cv-status-text">{busy() ? "나누는 중" : "듣는 중"}</span>
      </div>
    </>
  );
}

/** Opens from the right when a job is picked, like a service panel. */
function Drawer(props: { t: Task; onClose: () => void }) {
  const t = () => props.t;
  const kids = () => state.tasks.filter((k) => k.parentId === t().id);
  const recent = () => steps(t()).slice(-8).reverse();
  const ended = () => t().status === "done" || t().status === "failed";
  /** what the job ended with: its last answer and the files / pages behind it */
  const outcome = createMemo(() => {
    let text = "";
    let proof: { kind: string; ref: string }[] = [];
    for (let i = t().entries.length - 1; i >= 0; i--) {
      const e = t().entries[i];
      if (e.kind === "user") break;
      if (!text && e.kind === "text") text = e.text;
      if (!proof.length && e.kind === "block" && e.block.type === "evidence") proof = (e.block as { items?: { kind: string; ref: string }[] }).items ?? [];
    }
    return { text: text || t().result || t().summary || t().error || "", proof: proof.filter((x) => x.kind === "file" || x.kind === "shot" || x.kind === "link") };
  });
  const d = () => changes(t());
  const [msg, setMsg] = createSignal("");
  const say = () => {
    const m = msg().trim();
    if (!m) return;
    void tell(t().id, m);
    setMsg("");
  };
  return (
    <aside class="cv-drawer" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header class="cv-dr-head">
        <span class="cv-dr-title">{t().title}</span>
        <button class="icon-btn sm" title="닫기 (Esc)" onClick={props.onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div class="cv-dr-acts">
        <button class="btn sm primary" onClick={() => openTask(t().id)}>열어서 보기</button>
      </div>
      <div class="cv-dr-body">
        <Show
          when={ended() && outcome().text}
          fallback={
            <div class="cv-dr-now">
              <StatusRow t={t()} />
              <Live t={t()} />
            </div>
          }
        >
          <div class="cv-dr-now">
            <StatusRow t={t()} />
            <Markdown class="cv-dr-result" text={outcome().text} />
          </div>
          <Show when={outcome().proof.length}>
            <section>
              <h4>근거</h4>
              <ul class="cv-dr-steps">
                <For each={outcome().proof}>
                  {(x) => (
                    <li class="link" onClick={() => (x.kind === "link" ? window.open(x.ref, "_blank") : openTask(t().id))} title={x.ref}>
                      <span class={`cv-dr-ic`}><Icon name={x.kind === "link" ? "link" : x.kind === "shot" ? "monitor" : "file"} size={12} /></span>
                      <span class="cv-dr-step">{x.kind === "link" ? x.ref.replace(/^https?:\/\/(www\.)?/, "") : base(x.ref)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </Show>
        <Show when={t().plan.length}>
          <section>
            <h4>계획</h4>
            <ol class="cv-dr-plan">
              <For each={t().plan}>
                {(p) => (
                  <li class={`p-${p.state}`}>
                    <i />
                    <span>{p.text}</span>
                  </li>
                )}
              </For>
            </ol>
          </section>
        </Show>
        <Show when={!ended() && recent().length}>
          <section>
            <h4>최근 단계</h4>
            <ul class="cv-dr-steps">
              <For each={recent()}>
                {(s) => (
                  <li classList={{ bad: !s.ok, open: s.open }}>
                    <span class={`cv-dr-ic r-${s.kind}`}><Icon name={ACT[s.kind]?.icon ?? "tools"} size={12} /></span>
                    <span class="cv-dr-step">{base(s.target) || ACT[s.kind]?.label}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={kids().length}>
          <section>
            <h4>서브에이전트</h4>
            <ul class="cv-dr-steps">
              <For each={kids()}>
                {(k) => (
                  <li onClick={() => openTask(k.id)} class="link">
                    <i class={`cv-dot t-${tone(k)}`} />
                    <span class="cv-dr-step">{k.title}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={d().add || d().del}>
          <section>
            <h4>바뀐 것</h4>
            <div class="cv-dr-diff">
              <span class="add">+{d().add}</span>
              <span class="del">−{d().del}</span>
            </div>
          </section>
        </Show>
      </div>
      <Show when={tone(t()) !== "done"}>
        <form
          class="cv-dr-talk"
          onSubmit={(e) => {
            e.preventDefault();
            say();
          }}
        >
          <input
            placeholder={t().status === "running" ? "일하는 중에 끼어들어 말하기" : "이어서 시킬 것"}
            value={msg()}
            onInput={(e) => setMsg(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button type="submit" class="cv-send" disabled={!msg().trim()} aria-label="보내기">
            <Icon name="send" size={13} />
          </button>
        </form>
      </Show>
    </aside>
  );
}

// ───────────── the canvas

export function Canvas() {
  const space = () => state.space;
  /** jobs side by side only as many as the canvas can show readably */
  const [maxCols, setMaxCols] = createSignal(3);
  const graph = createMemo(() => layout(space(), unfolded(), maxCols()));
  /** projects that have finished jobs folded away (or unfolded) */
  const foldable = () => graph().nodes.filter((n) => n.kind === "more").map((n) => n.project!.id);
  const allOpen = () => foldable().length > 0 && foldable().every((id) => unfolded().includes(id));
  const byId = createMemo(() => new Map(graph().nodes.map((n) => [n.id, n])));
  // cards keyed by id: the layout is rebuilt on every update of a running job, the
  // card elements must not be (that reset live views and dropped a card mid-drag)
  const ids = createMemo(() => graph().nodes.map((n) => n.id), [], { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const [pan, setPan] = createSignal({ x: 80, y: 80 });
  const [zoom, setZoom] = createSignal(1);
  const [sel, setSel] = createSignal<string>();
  const [drag, setDrag] = createSignal<{ id: string; x: number; y: number } | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [ask, setAsk] = createSignal("");
  const [grid, setGrid] = createSignal(true);
  const [hover, setHover] = createSignal<string>();
  /** the line a card sits on: everything above it and everything under it */
  const lineage = createMemo(() => {
    const id = hover() ?? sel();
    if (!id) return null;
    const keep = new Set<string>([id]);
    const up = new Map(graph().edges.map((e) => [e.to, e.from]));
    for (let x = up.get(id); x; x = up.get(x)) keep.add(x);
    const walk = (x: string) => graph().edges.forEach((e) => e.from === x && !keep.has(e.to) && (keep.add(e.to), walk(e.to)));
    walk(id);
    return keep;
  });
  const dim = (id: string) => !!lineage() && !lineage()!.has(id);
  let vp!: HTMLDivElement;
  let addInput!: HTMLInputElement;

  const selTask = () => {
    const id = sel();
    const n = id ? byId().get(id) : undefined;
    return n?.task;
  };
  // while tidying, cards glide from where they were to their place
  const [glide, setGlide] = createSignal<Record<string, { x: number; y: number }> | null>(null);
  const pos = (n: Node) => (drag()?.id === n.id ? { x: drag()!.x, y: drag()!.y } : glide()?.[n.id] ?? { x: n.x, y: n.y });
  // cards folding into (or coming out of) a "끝난 일" card fade as they move
  const [fade, setFade] = createSignal<Record<string, number> | null>(null);
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  /** move cards from `from` to `to` (and their opacity from `op[0]` to `op[1]`), then `done` */
  const animate = (from: Record<string, P>, to: Record<string, P>, op: [Record<string, number>, Record<string, number>] | null, ms: number, done?: () => void) => {
    const start = performance.now();
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - start) / ms));
      setGlide(Object.fromEntries(Object.entries(to).map(([id, p]) => {
        const f = from[id] ?? p;
        return [id, { x: f.x + (p.x - f.x) * k, y: f.y + (p.y - f.y) * k }];
      })));
      if (op) setFade(Object.fromEntries(Object.keys({ ...op[0], ...op[1] }).map((id) => [id, (op[0][id] ?? 1) + ((op[1][id] ?? 1) - (op[0][id] ?? 1)) * k])));
      if (k < 1) return void requestAnimationFrame(step);
      batch(() => {
        done?.();
        setGlide(null);
        setFade(null);
      });
    };
    requestAnimationFrame(step);
  };
  /** the project a card belongs to (sub-jobs: their job's) */
  const projectOf = (n: Node) => {
    let t = n.task;
    while (t?.parentId) t = taskById(t.parentId);
    return t ? (t.project && graph().nodes.some((x) => x.kind === "proj" && x.project?.id === t!.project) ? t.project : "_") : undefined;
  };
  /** Fold or unfold finished jobs: they slide into (or out of) the project's "끝난 일" card. */
  const fold = (next: string[]) => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return void setUnfolded(next);
    const before = graph().nodes;
    const after = layout(space(), next, maxCols()).nodes;
    const at = (ns: Node[]) => Object.fromEntries(ns.map((n) => [n.id, pos(n)]));
    const was = at(before);
    const will = Object.fromEntries(after.map((n) => [n.id, { x: n.x, y: n.y }]));
    const card = (ns: Node[], pid?: string) => ns.find((n) => n.kind === "more" && n.project?.id === pid);
    const gone = before.filter((n) => !will[n.id]);
    const born = after.filter((n) => !was[n.id]);
    if (gone.length) {
      // folding: the cards shrink into the stack, then leave
      const to = { ...will };
      for (const n of gone) {
        const c = card(after, n.task?.parentId) ?? card(after, projectOf(n));
        to[n.id] = c ? { x: c.x, y: c.y } : was[n.id];
      }
      animate(was, to, [{}, Object.fromEntries(gone.map((n) => [n.id, 0]))], 260, () => setUnfolded(next));
    } else {
      // unfolding: the cards come out of the stack
      setUnfolded(next);
      const from = { ...was };
      for (const n of born) {
        const c = card(before, n.task?.parentId) ?? card(before, projectOf(n));
        from[n.id] = c ? pos(c) : will[n.id];
      }
      animate(from, will, [Object.fromEntries(born.map((n) => [n.id, 0])), {}], 300);
    }
  };

  /** the person moved or zoomed the view: a window resize no longer refits it */
  let touched = false;
  /** `all`: everything in view (the button, ⇧1); otherwise the full width, readable, from the top. */
  const fit = (animate = true, all = false) => {
    const ns = graph().nodes;
    if (!ns.length || !vp) return;
    touched = false;
    const r = vp.getBoundingClientRect();
    const minX = Math.min(...ns.map((n) => n.x)), maxX = Math.max(...ns.map((n) => n.x + n.w));
    const minY = Math.min(...ns.map((n) => n.y)), maxY = Math.max(...ns.map((n) => n.y + n.h));
    const zw = (r.width - 120) / (maxX - minX), zh = (r.height - 150) / (maxY - minY);
    // opened: readable first (cards' text at 12px or more), the rest a pan away; ⇧1 shows it all
    const z = all ? Math.max(0.3, Math.min(1, zw, zh)) : Math.max(0.8, Math.min(1, zw, Math.max(zh, 0.8)));
    if (animate) vp.classList.add("glide");
    setZoom(z);
    // too tall to fit: start at the top, readable
    const y = (maxY - minY) * z > r.height - 150 ? 76 - minY * z : (r.height - (maxY - minY) * z) / 2 - minY * z + 20;
    setPan({ x: Math.max(72 - minX * z, (r.width - (maxX - minX) * z) / 2 - minX * z), y });
    if (animate) setTimeout(() => vp?.classList.remove("glide"), 260);
  };
  onMount(() => requestAnimationFrame(() => fit(false)));

  const zoomAt = (factor: number, cx = vp.clientWidth / 2, cy = vp.clientHeight / 2) => {
    touched = true;
    const z0 = zoom();
    const z = Math.min(2, Math.max(0.3, z0 * factor));
    const p = pan();
    setPan({ x: cx - ((cx - p.x) * z) / z0, y: cy - ((cy - p.y) * z) / z0 });
    setZoom(z);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    touched = true;
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  };

  const onBgDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".cv-node, .cv-ctrl, .cv-add, .cv-drawer, .cv-mini, button")) return;
    setSel(undefined);
    setAdding(false);
    const start = { x: e.clientX, y: e.clientY, p: pan() };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add("grabbing");
    const move = (ev: PointerEvent) => {
      touched = true;
      setPan({ x: start.p.x + ev.clientX - start.x, y: start.p.y + ev.clientY - start.y });
    };
    const up = () => {
      vp.classList.remove("grabbing");
      vp.removeEventListener("pointermove", move);
      vp.removeEventListener("pointerup", up);
    };
    vp.addEventListener("pointermove", move);
    vp.addEventListener("pointerup", up);
  };

  const onNodeDown = (n: Node, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = window;
    const start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / zoom(), dy = (ev.clientY - start.y) / zoom();
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      setDrag({ id: n.id, x: start.nx + dx, y: start.ny + dy });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      const d = drag();
      if (moved && d) setState("canvas", (c) => ({ ...(c ?? {}), [`${space()}:${n.id}`]: { x: Math.round(d.x), y: Math.round(d.y) } }));
      setDrag(null);
      if (moved) return;
      if (n.kind === "main") goMain();
      else if (n.kind === "proj") goMain(n.project!.id === "_" ? undefined : n.project!.id);
      else if (n.kind === "more") {
        const id = n.project!.id;
        fold(unfolded().includes(id) ? unfolded().filter((x) => x !== id) : [...unfolded(), id]);
      }
      else setSel(n.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  /** Put every card back in line (drops where they were dragged to). */
  const resetLayout = () => {
    const from = Object.fromEntries(graph().nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const prefix = `${space()}:`;
    // a store merges objects, so a filtered copy would keep the old keys: drop each one
    for (const k of Object.keys(state.canvas ?? {})) if (k.startsWith(prefix)) setState("canvas", k, undefined!);
    const to = Object.fromEntries(graph().nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const moved = Object.keys(to).some((id) => from[id] && (from[id].x !== to[id].x || from[id].y !== to[id].y));
    // put back in line and show all of it, not a zoomed-in corner
    if (!moved || matchMedia("(prefers-reduced-motion: reduce)").matches) return void queueMicrotask(() => fit(true, true));
    animate(from, to, null, 320, () => queueMicrotask(() => fit(true, true)));
  };

  const onKey = (e: KeyboardEvent) => {
    const target = e.target;
    if (!(target instanceof Element) || (target !== document.body && !target.closest(".canvas-view"))) return;
    if (target.closest('button, a[href], [tabindex], [role="button"], [role="tab"]')) return;
    if (!viewKey(e) || e.metaKey || e.ctrlKey || e.altKey || mode() !== "canvas") return;
    if (e.shiftKey && e.code === "Digit1") (e.preventDefault(), fit(true, true));
    else if (!e.metaKey && (e.key === "=" || e.key === "+")) zoomAt(1.2);
    else if (!e.metaKey && e.key === "-") zoomAt(1 / 1.2);
    else if (!e.shiftKey && e.key === "Enter" && sel()) (e.preventDefault(), openTask(sel()!));
    else if (!e.shiftKey && e.key === "Escape" && (sel() || adding())) (e.preventDefault(), e.stopPropagation(), setSel(undefined), setAdding(false));
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const edgePath = (e: Edge) => {
    const a = byId().get(e.from), b = byId().get(e.to);
    if (!a || !b) return "";
    const pa = pos(a), pb = pos(b);
    // a sub-job sits under its job: drop down from the job's left edge
    if (pb.x < pa.x + a.w && pb.y >= pa.y + a.h) {
      const x = pa.x + SUB_INDENT / 2, y1 = pa.y + a.h, y2 = pb.y + b.h / 2, r = Math.min(10, (y2 - y1) / 2);
      return `M ${x} ${y1} L ${x} ${y2 - r} Q ${x} ${y2}, ${x + r} ${y2} L ${pb.x} ${y2}`;
    }
    const x1 = pa.x + a.w, y1 = pa.y + a.h / 2, x2 = pb.x, y2 = pb.y + b.h / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  const counts = () => {
    const c: Record<string, number> = {};
    for (const n of graph().nodes) if (n.kind === "job") c[tone(n.task!)] = (c[tone(n.task!)] ?? 0) + 1;
    return c;
  };

  const bounds = () => {
    const ns = graph().nodes;
    if (!ns.length) return { x: 0, y: 0, w: 1, h: 1 };
    const minX = Math.min(...ns.map((n) => pos(n).x)), maxX = Math.max(...ns.map((n) => pos(n).x + n.w));
    const minY = Math.min(...ns.map((n) => pos(n).y)), maxY = Math.max(...ns.map((n) => pos(n).y + n.h));
    return { x: minX - 60, y: minY - 60, w: maxX - minX + 120, h: maxY - minY + 120 };
  };
  const [vpSize, setVpSize] = createSignal({ w: 800, h: 600 });
  onMount(() => {
    const ro = new ResizeObserver(() => {
      setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
      setMaxCols(Math.max(1, Math.min(3, Math.floor((vp.clientWidth / 0.6 - X.job - 120) / (W.job + GAP.col)))));
    });
    ro.observe(vp);
    onCleanup(() => ro.disconnect());
  });
  // the window or a side panel changed size: keep the untouched view fitted
  let refit = 0;
  createEffect(on(vpSize, () => {
    if (touched) return;
    cancelAnimationFrame(refit);
    refit = requestAnimationFrame(() => fit(false));
  }, { defer: true }));
  /** the map only helps when there's room to spare */
  /** everything is already in view: the map would only cover a card */
  const allInView = () => {
    const ns = graph().nodes;
    if (!ns.length) return true;
    const z = zoom(), p = pan(), v = vpSize();
    return ns.every((n) => { const q = pos(n); const x = q.x * z + p.x, y = q.y * z + p.y; return x >= 0 && y >= 0 && x + n.w * z <= v.w && y + n.h * z <= v.h; });
  };
  const roomy = () => vpSize().w >= 640 && vpSize().h >= 460 && !allInView();

  const send = () => {
    const t = ask().trim();
    if (!t) return;
    throwThought(t, state.space);
    setAsk("");
    setAdding(false);
  };

  return (
    <div class="view canvas-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <span class="head-title">캔버스</span>
        <span class="board-sum">
          <Show when={counts().live}><span><i class="tone-dot td-live" />진행 {counts().live}</span></Show>
          <Show when={counts().ask}><span><i class="tone-dot td-ask" />답 필요 {counts().ask}</span></Show>
          <Show when={counts().review}><span><i class="tone-dot td-review" />검토 {counts().review}</span></Show>
          <Show when={counts().idle}><span><i class="tone-dot td-idle" />대기 {counts().idle}</span></Show>
        </span>
        <span class="spacer" data-tauri-drag-region />
        <div class="cv-progress" title="끝남 · 검토 · 진행 · 답 필요 · 대기">
          <For each={["done", "review", "live", "ask", "idle"]}>{(k) => <Show when={counts()[k]}><i class={`t-${k}`} style={{ flex: counts()[k] }} /></Show>}</For>
        </div>
      </header>

      <Show when={mode() === "canvas"} fallback={<Board embedded />}>
        <div class="cv-frame">
          <div
            class="cv-viewport"
            classList={{ "no-grid": !grid() }}
            ref={vp}
            onWheel={onWheel}
            onPointerDown={onBgDown}
            style={{ "background-position": `${pan().x}px ${pan().y}px`, "background-size": `${20 * zoom()}px ${20 * zoom()}px` }}
          >
            <div class="cv-world" style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})` }}>
              <svg class="cv-edges" width="1" height="1">
                <defs>
                  <marker id="cv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0.5 L 7 4 L 0 7.5" class="cv-arrow" />
                  </marker>
                </defs>
                <For each={graph().edges}>
                  {(e) => (
                    <g class={`cv-edge t-${e.tone}`} style={{ opacity: fade()?.[e.to] }} classList={{ hot: !!lineage() && lineage()!.has(e.to) && lineage()!.has(e.from), dim: !!lineage() && !(lineage()!.has(e.to) && lineage()!.has(e.from)) }}>
                      <path d={edgePath(e)} marker-end="url(#cv-arrow)" />
                    </g>
                  )}
                </For>
              </svg>
              <For each={ids()}>
                {(id) => (
                  <Show when={byId().get(id)}>
                  {(node) => {
                  const n = node();
                  return (
                  <div
                    class={`cv-node cv-${n.kind}${node().task ? ` t-${tone(node().task!)}` : ""}`}
                    classList={{ sel: sel() === n.id, dragging: drag()?.id === n.id, dim: dim(n.id) }}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover(undefined)}
                    style={{ left: `${pos(node()).x}px`, top: `${pos(node()).y}px`, width: `${node().w}px`, height: `${node().h}px`, opacity: fade()?.[n.id] }}
                    onPointerDown={(e) => onNodeDown(node(), e)}
                    onDblClick={() => n.task && openTask(n.id)}
                  >
                    {n.kind === "main" ? <MainCard /> : n.kind === "proj" ? <ProjCard n={node()} space={space()} /> : n.kind === "job" ? <JobCard n={node()} /> : n.kind === "more" ? <MoreCard n={node()} /> : <SubCard n={node()} />}
                  </div>
                  );
                  }}
                  </Show>
                )}
              </For>
            </div>

            {/* cards were dragged out of line: one press puts them back */}
            <Show when={Object.keys(state.canvas ?? {}).some((k) => k.startsWith(`${space()}:`))}>
              <button class="cv-retidy" onClick={resetLayout}>
                <Icon name="tidy" size={13} />
                다시 정렬
              </button>
            </Show>

            <div class="cv-add">
              <button class="cv-add-btn" classList={{ on: adding() }} onClick={() => (setAdding(!adding()), queueMicrotask(() => addInput?.focus()))}>
                <Icon name="plus" size={15} />
                <span>추가</span>
              </button>
              <Show when={adding()}>
                <form
                  class="cv-add-pop"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send();
                  }}
                >
                  <input ref={addInput} placeholder={`새 일 · ${spaceById(state.space).label} 메인이 나눠서 맡겨요`} value={ask()} onInput={(e) => setAsk(e.currentTarget.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && setAdding(false))} />
                  <button type="submit" class="cv-send" disabled={!ask().trim()} aria-label="맡기기">
                    <Icon name="send" size={13} />
                  </button>
                </form>
              </Show>
            </div>

            <div class="cv-ctrl">
              <div class="cv-ctrl-group">
                <button title={grid() ? "격자 숨기기" : "격자 보이기"} classList={{ on: grid() }} onClick={() => setGrid(!grid())}>
                  <Icon name="dots" size={15} />
                </button>
              </div>
              <div class="cv-ctrl-group">
                <button title="확대 (+)" onClick={() => zoomAt(1.2)}><Icon name="plus" size={15} /></button>
                <button title="축소 (−)" onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" size={15} /></button>
                <button title="전체 보기 (⇧1)" onClick={() => fit(true, true)}><Icon name="fit" size={14} /></button>
              </div>
              <div class="cv-ctrl-group">
                <button title="정렬" onClick={resetLayout}><Icon name="tidy" size={14} /></button>
                <Show when={foldable().length}>
                  <button title={allOpen() ? "끝난 일 모두 접기" : "끝난 일 모두 펼치기"} classList={{ on: allOpen() }} onClick={() => fold(allOpen() ? [] : foldable())}>
                    <Icon name="history" size={14} />
                  </button>
                </Show>
              </div>
            </div>

            <svg
              class="cv-mini"
              classList={{ shifted: !!selTask(), gone: !roomy() }}
              viewBox={`${bounds().x} ${bounds().y} ${bounds().w} ${bounds().h}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={(e) => {
                e.stopPropagation();
                const svg = e.currentTarget as SVGSVGElement;
                const pt = svg.createSVGPoint();
                pt.x = e.clientX;
                pt.y = e.clientY;
                const w = pt.matrixTransform(svg.getScreenCTM()!.inverse());
                touched = true;
                setPan({ x: vpSize().w / 2 - w.x * zoom(), y: vpSize().h / 2 - w.y * zoom() });
              }}
            >
              <For each={graph().nodes}>{(n) => <rect class={n.task ? `t-${tone(n.task)}` : `k-${n.kind}`} x={pos(n).x} y={pos(n).y} width={n.w} height={n.h} rx={12} />}</For>
              <rect class="cv-mini-vp" x={-pan().x / zoom()} y={-pan().y / zoom()} width={vpSize().w / zoom()} height={vpSize().h / zoom()} rx={8} />
            </svg>

            <Show when={selTask()} keyed>
              {(t) => <Drawer t={t} onClose={() => setSel(undefined)} />}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export const openCanvas = () => setView({ name: "board" });
