// The canvas: all the work of a space as a map you can pan and zoom.
// Main sits on the left, its projects next, then the jobs, then each job's
// subagents, joined by lines. A card does not tell you in words what a job is
// doing; it shows it: the tool it is using right now moves, the strip under it
// is the rhythm of its last steps, the bar is its plan, the split is its diff.
// Cards can be dragged; where you put them is kept.
import { nowText } from "../engine/describe";
import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
type P = { x: number; y: number };
import { DecisionCard } from "../ui/DecisionCard";
import { decisionFor, projectsIn, setState, spaceById, state, taskById } from "../state/store";
import type { Project, Task, ToolKind } from "../state/types";
import { goMain, live, openTask, setView } from "../state/ui";
import { decide, resumeTask, tell } from "../engine/tasks";
import { describeCommand } from "../engine/describe";
import { costDetail, costShort, jobCost } from "../ui/cost";
import { ago, compact, IssueTag, now, statusLabel } from "../ui/bits";
import { browserStreamPort, fileSrc } from "../lib/native";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { changes, Glyph, SidebarToggle } from "./Sidebar";
import { discarded, planCount, stepState } from "../state/progress";
import { DiscardGlyph } from "../ui/Review";
import { Board, BoardGroup, cardMenu, Kids, NewTask, StateGlyph } from "./Board";
import { ChevronsDownUp, ChevronsUpDown, Map as MapIcon } from "lucide-solid";
import { viewKey } from "../lib/shortcuts";
import { lang, t } from "../i18n";

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
  /** of `count`, the discarded ones */
  gone?: number;
}
interface Edge {
  from: string;
  to: string;
  tone: string;
}

/** the map, or the same tasks as columns by state */
const [mode, setMode] = createSignal<"canvas" | "list">("canvas");
/** projects whose finished jobs are unfolded on the canvas */
const [unfolded, setUnfolded] = createSignal<string[]>([]);
/** a finished job folds into "끝난 일" right away (one waiting on a merge or an answer stays out) */
const folded = (t: Task) => tone(t) === "done" && !t.pinned;
/** a finished sub-job folds under its job the same way */
const subFolded = (k: Task) => k.status === "done" && !k.pinned;

/** failed · live = working now · ask = needs a reply · review = done, branch not merged · idle · done.
 *  Failed is its own state: never counted or drawn as needing a reply. */
function tone(t: Task): string {
  if (discarded(t)) return "done";
  if (t.status === "failed") return "failed";
  const kids = state.tasks.filter((k) => k.parentId === t.id);
  if (t.status === "waiting" || kids.some((k) => k.status === "waiting")) return "ask";
  if (t.status === "running" || kids.some((k) => k.status === "running")) return "live";
  if (t.status === "queued" || t.status === "paused") return "idle";
  if (t.status === "done" && t.worktree?.state === "open") return "review";
  return "done";
}

/** which comes first on the canvas (and in the first view): a reply, failed, running, review, queued, done */
const RANK: Record<string, number> = { ask: 0, failed: 1, live: 2, review: 3, idle: 4, done: 5 };
/**
 * Each task's place in that order when the canvas was opened (or tidied): lanes and cards keep
 * their place while the work moves on, instead of jumping under the pointer. New tasks rank as they are.
 */
const [ranks, setRanks] = createSignal<Record<string, number>>({});
const rankOf = (t: Task) => ranks()[t.id] ?? RANK[tone(t)];
const snapRanks = (space: string) =>
  setRanks(Object.fromEntries(state.tasks.filter((t) => t.space === space && !t.parentId).map((t) => [t.id, RANK[tone(t)]])));
/** the zoom the canvas is at, for what has to be measured at the size it's drawn */
const [zoomNow, setZoomNow] = createSignal(1);

function layout(space: string, open: string[], maxCols = 3): { nodes: Node[]; edges: Edge[] } {
  const roots = state.tasks.filter((t) => t.space === space && !t.parentId && !t.answer && !t.archived);
  const projects: (Project | { id: string; name: string; folder: string })[] = [...projectsIn(space as Task["space"])];
  if (roots.some((t) => !t.project || !projects.some((p) => p.id === t.project))) projects.push({ id: "_", name: "기타", folder: spaceById(space as Task["space"]).folder });
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let y = 0;
  const projNodes: Node[] = [];
  const jobsOf = (p: { id: string }) =>
    roots
      .filter((t) => (p.id === "_" ? !t.project || !projects.some((q) => q.id === t.project && q.id !== "_") : t.project === p.id))
      .sort((a, b) => rankOf(a) - rankOf(b) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  // the lane that needs the person most comes first (the sidebar's order between equals)
  const laneRank = (p: { id: string }) => Math.min(6, ...jobsOf(p).filter((t) => !folded(t)).map(rankOf));
  const lanes = projects.map((p, i) => ({ p, i, r: laneRank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
  for (const p of lanes) {
    const all = jobsOf(p);
    // finished jobs fold into one "완료 N개" card per project; unfolded, they come out under it
    const done = all.filter(folded);
    const jobs = all.filter((t) => !folded(t));
    const top = y;
    /** a grid, not one long column: up to 3 jobs side by side, a job's own sub-jobs stacked under it */
    const place = (list: Task[]) => {
      const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(list.length))));
      for (let r = 0; r < list.length; r += cols) {
        const row = list.slice(r, r + cols);
        let rowH = 0;
        row.forEach((t, c) => {
          const x = X.job + c * (W.job + GAP.col);
          const h = jobHeight(t);
          nodes.push({ id: t.id, kind: "job", x, y, w: W.job, h, task: t });
          edges.push({ from: `p:${p.id}`, to: t.id, tone: tone(t) });
          let ky = y + h + GAP.sub;
          const kids = state.tasks.filter((k) => k.parentId === t.id);
          const kidsDone = kids.filter(subFolded);
          const sub = (k: Task) => {
            nodes.push({ id: k.id, kind: "sub", x: x + SUB_INDENT, y: ky, w: W.job - SUB_INDENT, h: H.sub, task: k });
            edges.push({ from: t.id, to: k.id, tone: tone(k) });
            ky += H.sub + GAP.sub;
          };
          kids.filter((k) => !subFolded(k)).forEach(sub);
          // finished subagents: one fold, and unfolded they come out under it
          if (kidsDone.length) {
            nodes.push({ id: `more:${t.id}`, kind: "more", x: x + SUB_INDENT, y: ky, w: W.job - SUB_INDENT, h: H.more, project: { id: t.id, name: t.title, folder: "" }, task: t, count: kidsDone.length });
            ky += H.more + GAP.sub;
            if (open.includes(t.id)) kidsDone.forEach(sub);
          }
          rowH = Math.max(rowH, ky - GAP.sub - y);
        });
        y += rowH + GAP.job;
      }
    };
    place(jobs);
    if (done.length) {
      nodes.push({ id: `more:${p.id}`, kind: "more", x: X.job, y, w: W.job, h: H.more, project: p, count: done.length, gone: done.filter(discarded).length });
      y += H.more + GAP.job;
      if (open.includes(p.id)) place(done);
    }
    const shownAny = jobs.length || done.length;
    const span = shownAny ? y - GAP.job - top : H.proj;
    if (!shownAny) y += H.proj + GAP.job;
    const pn: Node = { id: `p:${p.id}`, kind: "proj", x: X.proj, y: top + (span - H.proj) / 2, w: W.proj, h: H.proj, project: p };
    projNodes.push(pn);
    nodes.push(pn);
    edges.push({ from: "main", to: pn.id, tone: jobs.some((t) => tone(t) === "ask") ? "ask" : jobs.some((t) => tone(t) === "failed") ? "failed" : jobs.some((t) => tone(t) === "live") ? "live" : jobs.length ? "done" : "idle" });
    y += GAP.proj - GAP.job;
  }
  const mid = projNodes.length ? (Math.min(...projNodes.map((n) => n.y)) + Math.max(...projNodes.map((n) => n.y)) + H.proj) / 2 : H.main / 2;
  nodes.unshift({ id: "main", kind: "main", x: X.main, y: mid - H.main / 2, w: W.main, h: H.main });
  // where the user put things wins
  const moved = state.canvas ?? {};
  for (const n of nodes) {
    const m = moved[`${space}:${n.id}`];
    if (m) (n.x = m.x), (n.y = m.y);
  }
  return { nodes, edges };
}

/** the frame around a set of cards */
const boxOf = (list: Node[]) => ({
  x0: Math.min(...list.map((n) => n.x)), x1: Math.max(...list.map((n) => n.x + n.w)),
  y0: Math.min(...list.map((n) => n.y)), y1: Math.max(...list.map((n) => n.y + n.h)),
});
/** room around the cards when the view is framed */
const INSET = { top: 24, bottom: 24, side: 32 };
/** everything is shown when it fits at this zoom or more; otherwise READ_ZOOM (readability beats fitting) */
const MIN_ZOOM = 0.75;
const READ_ZOOM = 0.75;

/**
 * How many jobs side by side: the arrangement that fits whole at the biggest zoom;
 * when none fits at MIN_ZOOM, the widest that still fits across at READ_ZOOM.
 */
function bestCols(space: string, open: string[], v: { w: number; h: number }): number {
  const aw = v.w - INSET.side * 2, ah = v.h - INSET.top - INSET.bottom;
  const tries = [1, 2, 3].map((c) => {
    const ns = layout(space, open, c).nodes;
    if (!ns.length) return { c, z: 1, w: 0 };
    const b = boxOf(ns);
    return { c, z: Math.min(1, aw / (b.x1 - b.x0), ah / (b.y1 - b.y0)), w: b.x1 - b.x0 };
  });
  const best = tries.reduce((a, b) => (b.z > a.z + 0.01 ? b : a));
  if (best.z >= MIN_ZOOM) return best.c;
  return [...tries].reverse().find((x) => x.w * READ_ZOOM <= aw)?.c ?? 1;
}

// ───────────── what a job is doing, as a picture

const ACT: Record<ToolKind | "think" | "write-text" | "wait" | "queued" | "done" | "review" | "failed" | "paused", { icon: string; label: string }> = {
  read: { icon: "read", label: "읽는 중" },
  search: { icon: "search", label: "찾는 중" },
  edit: { icon: "pencil", label: "수정 중" },
  write: { icon: "write", label: "만드는 중" },
  bash: { icon: "terminal", label: "실행 중" },
  test: { icon: "test", label: "테스트 중" },
  browser: { icon: "globe", label: "브라우저 쓰는 중" },
  desktop: { icon: "monitor", label: "앱 조작 중" },
  other: { icon: "tools", label: "도구 쓰는 중" },
  think: { icon: "brain", label: "생각 중" },
  "write-text": { icon: "message", label: "응답 작성 중" },
  wait: { icon: "bell", label: "응답 필요" },
  queued: { icon: "clock", label: "대기" },
  paused: { icon: "pause", label: "일시정지" },
  done: { icon: "done", label: "완료" },
  review: { icon: "merge", label: "검토" },
  failed: { icon: "alert", label: "실패" },
};

const base = (s?: string) => (s ? s.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 40) : undefined);

/** the tool steps of a job, oldest first (the last 28) */
const steps = (t: Task) =>
  t.entries
    .flatMap((e) => (e.kind === "tool" ? [{ id: e.id, kind: e.tool.kind, ok: e.tool.ok !== false, open: !e.tool.endedAt, target: e.tool.target }] : []))
    .slice(-28);

/** two texts that read the same (spacing and closing punctuation aside) */
const same = (a: string, b: string) => {
  const n = (s: string) => s.replace(/\s+/g, " ").replace(/[\s.。!?…]+$/, "").trim();
  return n(a) === n(b);
};

/** a body that only repeats the title, or that the title is a cut of ("…" at its end) */
const echoes = (body: string, title: string) => {
  if (same(body, title)) return true;
  const cut = title.match(/^(.*?)\s*(?:…|\.\.\.)$/)?.[1];
  const n = (s: string) => s.replace(/\s+/g, " ").trim();
  return !!cut && n(cut).length > 0 && n(body).startsWith(n(cut));
};

/** what a card shows of a job that isn't running or asking: its error, summary or ask (when it says more than the title) */
const bodyText = (job: Task) => {
  const body = job.error || job.summary || job.ask;
  return body && !echoes(body, job.title) ? body : "";
};

/** finished with checks it couldn't do (a discarded task's checks no longer matter) */
const unchecked = (job: Task) => job.status === "done" && !discarded(job) && !!job.unverified?.length;

/** a card that only says something in words (not running, no screenshot): it takes the height of its words */
const quiet = (job: Task) => job.status !== "running" && !(job.shot && lastToolOf(job)?.kind === "browser");

function lastToolOf(job: Task) {
  for (let i = job.entries.length - 1; i >= 0; i--) {
    const e = job.entries[i];
    if (e.kind === "tool") return e.tool;
  }
  return undefined;
}

/** the question a waiting card asks, with the answers it offers right on the card */
const askOf = (job: Task) => {
  const d = job.status === "waiting" ? decisionFor(job.id) : undefined;
  return d ? { q: d.question, opts: d.ui ? [] : d.options.slice(0, 3).map((o) => ({ label: o.label, rec: !!o.primary })) } : undefined;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** the height a quiet card's words take, measured with the card's own styles (kept per text and language) */
const heights = new Map<string, number>();
let probe: HTMLDivElement | undefined;
/** measured again once the canvas is on screen and once its fonts have loaded */
const [measured, remeasure] = createSignal(0, { equals: false });
if (typeof document !== "undefined" && document.fonts) {
  const again = () => (heights.clear(), remeasure(0));
  void document.fonts.ready.then(again);
  // a font used for the first time loads later than `ready`: words take another width then
  document.fonts.addEventListener("loadingdone", again);
}
/**
 * Measured at the default zoom: a card's words are drawn biggest there (see .cv-world in
 * polish-canvas.css), so a card sized at 75% holds its words at any zoom.
 */
function measure(title: string, live: string, max: number): number {
  measured();
  const key = `${lang()}\u0000${title}\u0000${live}`;
  const had = heights.get(key);
  if (had) return had;
  if (typeof document === "undefined" || !document.querySelector(".canvas-view")) return H.job;
  if (!probe) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.className = "cv-world";
    probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;--cv-z:${READ_ZOOM}`;
  }
  // inside the view, so the card picks up the same rules it will on the canvas
  document.querySelector(".canvas-view")!.appendChild(probe);
  probe.innerHTML = `<div class="cv-node cv-job" style="position:static;width:${W.job}px;height:auto"><div class="cv-head"><span class="cv-stg"><span class="sb-glyph st-icon sm"></span></span><span class="cv-title">${esc(title)}</span></div>${live}<div class="cv-status"><span class="cv-status-text">x</span></div></div>`;
  const h = Math.min(max, Math.ceil((probe.firstElementChild as HTMLElement).getBoundingClientRect().height));
  probe.remove();
  if (h > 0) heights.set(key, h);
  return h > 0 ? h : H.job;
}

/** a job card's height: the full card for work that moves, the height of its words for the rest */
function jobHeight(job: Task): number {
  if (!quiet(job)) return H.job;
  const ask = askOf(job);
  if (ask) {
    const opts = ask.opts.map((o) => `<button class="cv-ask-opt"><span class="cv-ask-label">${esc(o.label)}</span>${o.rec ? `<span class="cv-ask-rec">${esc(t("추천"))}</span>` : ""}</button>`).join("");
    return measure(job.title, `<div class="cv-live w-question"><div class="cv-ask"><p class="cv-text ask">${esc(ask.q)}</p>${opts ? `<div class="cv-ask-opts">${opts}</div>` : ""}</div></div>`, H.job + 40);
  }
  const body = bodyText(job);
  const badge = unchecked(job) ? '<span class="unverified-badge">0</span>' : "";
  return measure(job.title, `<div class="cv-live w-${body ? "summary" : "none"}">${body ? `<p class="cv-text">${esc(body)}</p>` : '<div class="cv-live-empty"></div>'}${badge}</div>`, H.job);
}

/** +8 −3, plain (nothing for a discarded task: its changes are gone) */
function Diff(props: { t: Task }) {
  const d = () => (discarded(props.t) ? { add: 0, del: 0 } : changes(props.t));
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
    <Show when={src()} fallback={<div class="cv-live-empty">{t("브라우저 여는 중")}</div>}>
      {(s) => <img class="cv-shot" src={s()} alt="" draggable={false} />}
    </Show>
  );
}

/** the verb of a step, as the transcript says it: [going on, done] */
const VERB: Partial<Record<ToolKind, [string, string]>> = {
  read: ["읽는 중", "읽음"],
  search: ["찾는 중", "찾음"],
  edit: ["수정 중", "수정함"],
  write: ["만드는 중", "만듦"],
  bash: ["실행 중", "실행함"],
  browser: ["브라우저 쓰는 중", "브라우저 씀"],
  desktop: ["앱 조작 중", "앱 조작함"],
  test: ["테스트 중", "테스트 돌림"],
  other: ["도구 쓰는 중", "도구 씀"],
};

/** One past or running step of a job, in plain words. */
function said(e: { tool: { kind: ToolKind; name: string; target: string; detail?: string; note?: boolean; endedAt?: number } }): { icon: string; label: string; target: string } {
  const x = e.tool;
  const icon = ACT[x.kind]?.icon ?? "tools";
  const verb = (k: ToolKind) => t((VERB[k] ?? VERB.other!)[x.endedAt ? 1 : 0]);
  if (x.kind === "bash") {
    const d = describeCommand(x.detail ?? x.target);
    return { icon, label: x.endedAt ? d.label : d.now, target: d.target && !d.label.includes(d.target) ? d.target : "" };
  }
  if (x.note) return { icon: "write", label: t("기록"), target: x.target };
  if (x.kind === "browser") return { icon, label: verb("browser"), target: x.target.match(/https?:\/\/(?:www\.)?([^/\s"']+)/)?.[1] ?? x.target.split(/\s+/)[0] ?? "" };
  if (x.kind === "other") {
    const named = ({ memory_search: "메모리 검색", subagent: "서브에이전트 실행" } as Record<string, string>)[x.name];
    return { icon, label: named ? t(named) : verb("other"), target: named ? "" : x.name };
  }
  return { icon, label: verb(x.kind), target: x.target };
}

/**
 * What a working job is on, drawn from what it already reports (no extra model
 * calls): its plan as a rail, its own sentence for now, and its last few steps
 * in plain words, the running one with its latest output line.
 */
function Activity(props: { t: Task }) {
  const job = () => props.t;
  const cur = () => job().plan.findIndex((s) => s.state === "now");
  const head = () => job().intent || job().plan[cur()]?.text || (job().now ? nowText(job().now) : "");
  const sub = () => (job().intent && cur() >= 0 && job().plan[cur()].text !== job().intent ? job().plan[cur()].text : "");
  const toolIds = createMemo(() => {
    const ids: string[] = [];
    for (let i = job().entries.length - 1; i >= 0 && ids.length < 3; i--) if (job().entries[i].kind === "tool") ids.unshift(job().entries[i].id);
    return ids;
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const entry = (id: string) => job().entries.find((e) => e.id === id) as Extract<Task["entries"][number], { kind: "tool" }> | undefined;
  return (
    <div class="cv-act">
      <Show when={job().plan.length > 1}>
        <div class="cv-act-rail" title={job().plan.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}>
          <For each={job().plan}>{(s) => <i class={s.state} />}</For>
        </div>
      </Show>
      <Show when={sub()}><span class="cv-act-step">{planCount(job().plan).label} · {sub()}</span></Show>
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
  const job = () => props.t;
  const lastTool = () => lastToolOf(job());
  const shell = () => {
    const open = job().shells.filter((s) => !s.endedAt && !s.background);
    return open[open.length - 1] ?? (lastTool()?.kind === "bash" || lastTool()?.kind === "test" ? job().shells[job().shells.length - 1] : undefined);
  };
  const what = (): "browser" | "shell" | "text" | "tool" | "act" | "question" | "summary" | "none" => {
    if (job().status === "waiting" && decisionFor(job().id)) return "question";
    if (job().status === "running") {
      // the browser only while it's what the job is using now (not after it moved on to the desktop or a shell)
      if (lastTool()?.kind === "browser") return "browser";
      if (live[job().id] && !job().intent && !job().plan.length) return "text";
      if (lastTool() || job().intent || job().plan.length) return "act";
      return "none";
    }
    if (job().shot && lastTool()?.kind === "browser") return "browser";
    // a body that only repeats the title (a queued task's ask, word for word, or the title is its cut) says nothing
    return bodyText(job()) ? "summary" : "none";
  };
  return (
    <div class={`cv-live w-${what()}`}>
      {/* a queued task with nothing more to say stays blank: its status line already says 대기 */}
      <Switch fallback={<div class="cv-live-empty">{job().status === "running" ? t("시작하는 중") : ""}</div>}>
        <Match when={what() === "browser"}><BrowserThumb t={job()} /></Match>
        <Match when={what() === "shell"}>
          <pre class="cv-term"><span class="cv-cmd">$ {shell()!.command}</span>{"\n"}{lastLines(shell()!.tail, 4).join("\n")}</pre>
        </Match>
        <Match when={what() === "text"}>
          <p class="cv-text">{lastLines(live[job().id] ?? "", 3).join(" ").slice(-220)}</p>
        </Match>
        <Match when={what() === "tool"}>
          <pre class="cv-term"><span class="cv-cmd">{t(ACT[lastTool()!.kind]?.label ?? "도구")}</span>{"  "}{lastTool()!.target}</pre>
        </Match>
        <Match when={what() === "act"}><Activity t={job()} /></Match>
        <Match when={what() === "question"}>
          <div class="cv-ask">
            <p class="cv-text ask">{decisionFor(job().id)!.question}</p>
            {/* the first few answers, pressable right on the card; the rest are in the drawer */}
            <Show when={!decisionFor(job().id)!.ui && decisionFor(job().id)!.options.length}>
              <div class="cv-ask-opts" onPointerDown={(e) => e.stopPropagation()}>
                <For each={decisionFor(job().id)!.options.slice(0, 3)}>
                  {(o) => (
                    // every answer looks the same (nothing reads as already picked); the suggested one is tagged
                    <button class="cv-ask-opt" title={o.note ?? o.label} onClick={(e) => (e.stopPropagation(), void decide(decisionFor(job().id)!.id, o.id))}>
                      <span class="cv-ask-label">{o.label}</span>
                      <Show when={o.primary}><span class="cv-ask-rec">{t("추천")}</span></Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Match>
        <Match when={what() === "summary"}>
          <p class="cv-text" classList={{ muted: !job().summary && !job().error }}>{bodyText(job())}</p>
          <Show when={unchecked(job())}>
            <span class="unverified-badge" title={job().unverified!.join("\n")}>{t("{n}개 확인 안 됨", { n: job().unverified!.length })}</span>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

// ───────────── cards: a status glyph and the title on top, what it is doing, one status line

/** the header's counts, in the board's order of urgency, each with its sidebar glyph */
const LEGEND = [
  { tone: "live", g: "running", label: "진행 중" },
  { tone: "ask", g: "waiting", label: "응답 필요" },
  { tone: "failed", g: "failed", label: "실패" },
  { tone: "review", g: "inreview", label: "검토" },
  { tone: "idle", g: "queued", label: "대기" },
] as const;

const STATUS: Record<string, string> = { live: "진행 중", ask: "응답 필요", failed: "실패", review: "검토", idle: "대기", done: "완료" };

/** The status glyph the sidebar draws (one look everywhere), named in its tooltip. */
function StatusGlyph(props: { t: Task }) {
  return (
    <span class="cv-stg" title={t(statusText(props.t))}>
      <Show when={discarded(props.t)} fallback={<Glyph t={props.t} />}><DiscardGlyph /></Show>
    </span>
  );
}

/** The state of a card in words (the same words as the sidebar and the board). */
function statusText(task: Task): string {
  if (discarded(task)) return "버림";
  if (task.status === "failed") return statusLabel.failed;
  if (mergedAt(task)) return "병합됨";
  const tn = tone(task);
  return tn === "idle" ? statusLabel[task.status] : STATUS[tn];
}

/** merged by Ondra: when (older tasks without mergedAt: when they finished) */
const mergedAt = (task: Task) => (task.worktree?.state === "merged" && !discarded(task) ? (task.mergedAt ?? task.finishedAt) : undefined);

function StatusRow(props: { t: Task }) {
  const tn = () => tone(props.t);
  /** where it is in its plan, while it isn't finished: 진행 중 · 할 일 2/4 */
  const step = () => (props.t.plan.length && props.t.status !== "done" ? planCount(props.t.plan) : undefined);
  const when = () => (props.t.status === "running" && props.t.startedAt ? compact(now() - props.t.startedAt) : "");
  const cost = () => (props.t.status === "done" ? jobCost(props.t) : undefined);
  /**
   * The row never wraps: when it runs out of room it first drops the word "할 일" (2/4 stays),
   * then the subagent count, and only then cuts the state word. Numbers are never split.
   */
  const [tight, setTight] = createSignal(0);
  let row: HTMLDivElement | undefined;
  const cut = () => {
    const s = row?.querySelector<HTMLElement>(".cv-status-text");
    return !!s && s.scrollWidth > s.clientWidth + 0.5;
  };
  const refit = () => {
    if (!row?.isConnected) return;
    setTight(0);
    for (let k = 1; k <= 2 && cut(); k++) setTight(k);
  };
  createEffect(
    on([() => statusText(props.t), step, when, () => changes(props.t).add + changes(props.t).del, () => state.tasks.filter((k) => k.parentId === props.t.id).length, lang, zoomNow, measured], () =>
      queueMicrotask(refit),
    ),
  );
  onMount(() => requestAnimationFrame(refit));
  return (
    <div class={`cv-status s-${tn()}`} classList={{ failed: props.t.status === "failed" && !discarded(props.t) }} ref={row}>
      <span class="cv-status-text">{t(statusText(props.t))}</span>
      <Show when={step()}>
        {(p) => <span class="cv-step">{tight() ? `· ${p().done}/${p().total}` : `· ${t("할 일 {done}/{all}", { done: p().done, all: p().total })}`}</span>}
      </Show>
      <Show when={tight() < 2}><Kids t={props.t} class="cv-meta" /></Show>
      <span class="spacer" />
      <Diff t={props.t} />
      <Show when={when()}><span class="cv-when">{when()}</span></Show>
      {/* merged: when it was merged, its cost on hover; otherwise what it took */}
      <Show when={mergedAt(props.t)} fallback={
        <Show when={cost()} keyed>
          {(c) => <Show when={costShort(c)}><span class="cv-when" title={costDetail(c)}>{costShort(c)}</span></Show>}
        </Show>
      }>
        {(at) => <span class="cv-when" title={[cost() && costShort(cost()!), cost() && costDetail(cost()!)].filter(Boolean).join(" · ") || undefined}>{ago(at())}</span>}
      </Show>
    </div>
  );
}

function JobCard(props: { n: Node }) {
  const job = () => props.n.task!;
  return (
    <>
      <div class="cv-head">
        <StatusGlyph t={job()} />
        <span class="cv-title">{job().title}</span>
        <IssueTag t={job()} />
      </div>
      <Live t={job()} />
      <StatusRow t={job()} />
    </>
  );
}

function SubCard(props: { n: Node }) {
  const job = () => props.n.task!;
  return (
    <>
      <div class="cv-head">
        <StatusGlyph t={job()} />
        <span class="cv-title">{job().title}</span>
      </div>
      <StatusRow t={job()} />
    </>
  );
}

function ProjCard(props: { n: Node; space: string }) {
  const p = () => props.n.project!;
  const jobs = () => state.tasks.filter((x) => x.space === props.space && !x.parentId && !x.answer && !x.archived && (p().id === "_" ? !x.project : x.project === p().id));
  const count = (k: string) => jobs().filter((x) => tone(x) === k).length;
  const busy = () => p().id !== "_" && state.captain.some((m) => m.space === props.space && m.project === p().id && m.pending);
  return (
    <>
      <div class="cv-head">
        <span class="cv-ic" classList={{ busy: busy() }}>
          <Icon name="folder" size={16} />
        </span>
        <span class="cv-title">{p().id === "_" ? t(p().name) : p().name}</span>
      </div>
      <div class="cv-status">
        <div class="cv-proj-meter" title={t("진행 중 · 응답 필요 · 실패 · 검토 · 대기 · 완료")}>
          <For each={["live", "ask", "failed", "review", "idle", "done"]}>{(k) => <Show when={count(k)}><i class={`t-${k}`} style={{ flex: count(k) }} /></Show>}</For>
          <Show when={!jobs().length}><i class="empty" style={{ flex: 1 }} /></Show>
        </div>
        <span class="cv-when">{jobs().length ? t("작업 {n}개", { n: jobs().length }) : t("작업 없음")}</span>
      </div>
    </>
  );
}

/** A project's finished jobs (or a job's finished subagents), folded into one line. */
function MoreCard(props: { n: Node }) {
  const open = () => unfolded().includes(props.n.project!.id);
  /** it counts every task it folds: discarded ones apart (완료 2 · 버림 1) */
  const label = () => {
    const n = props.n.count ?? 0;
    if (props.n.task) return t("서브에이전트 완료 {n}개", { n });
    const gone = props.n.gone ?? 0;
    if (!gone) return t("완료 {n}개", { n });
    return n > gone ? t("완료 {n}개 · 버림 {m}개", { n: n - gone, m: gone }) : t("버림 {n}개", { n: gone });
  };
  return (
    <div class="cv-more-row" classList={{ open: open() }} title={open() ? t("접기") : t("펼치기")}>
      <Icon name="chevron" size={12} class={`cv-more-chev${open() ? " open" : ""}`} />
      <span>{label()}</span>
    </div>
  );
}

function MainCard() {
  const busy = () => state.captain.some((m) => m.space === state.space && !m.project && m.pending);
  return (
    <>
      <div class="cv-head">
        <span class="cv-ic" classList={{ busy: busy() }}>
          <Icon name="message" size={16} />
        </span>
        <span class="cv-title">{t("메인")}</span>
      </div>
      <div class="cv-status" classList={{ "s-live": busy() }}>
        <span class="cv-status-text">{busy() ? t("진행 중") : t("쉬는 중")}</span>
      </div>
    </>
  );
}

/** Opens from the right when a job is picked, like a service panel. */
function Drawer(props: { t: Task; onClose: () => void }) {
  const job = () => props.t;
  const kids = () => state.tasks.filter((k) => k.parentId === job().id);
  const recent = () => steps(job()).slice(-8).reverse();
  const ended = () => job().status === "done" || job().status === "failed";
  /** what the job ended with: its last answer and the files / pages behind it */
  const outcome = createMemo(() => {
    let text = "";
    let proof: { kind: string; ref: string }[] = [];
    for (let i = job().entries.length - 1; i >= 0; i--) {
      const e = job().entries[i];
      if (e.kind === "user") break;
      if (!text && e.kind === "text") text = e.text;
      if (!proof.length && e.kind === "block" && e.block.type === "evidence") proof = (e.block as { items?: { kind: string; ref: string }[] }).items ?? [];
    }
    return { text: text || job().result || job().summary || job().error || "", proof: proof.filter((x) => x.kind === "file" || x.kind === "shot" || x.kind === "link") };
  });
  const d = () => (discarded(job()) ? { add: 0, del: 0 } : changes(job()));
  const [msg, setMsg] = createSignal("");
  const say = () => {
    const m = msg().trim();
    if (!m) return;
    void tell(job().id, m);
    setMsg("");
  };
  return (
    <aside class="cv-drawer" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header class="cv-dr-head">
        <StatusGlyph t={job()} />
        <span class="cv-dr-title" title={job().title}>{job().title}</span>
        <Show when={job().status === "failed" && !discarded(job())}>
          <button class="btn primary sm cv-dr-retry" onClick={() => void resumeTask(job().id)}>
            <Icon name="refresh" size={14} />
            {t("다시 시도")}
          </button>
        </Show>
        <button class="btn sm cv-dr-open" title={t("작업 열기 (⏎)")} onClick={() => openTask(job().id)}>{t("열기")}</button>
        <button class="icon-btn sm" title={t("닫기 (Esc)")} aria-label={t("닫기")} onClick={props.onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div class="cv-dr-body">
        <Show
          when={ended() && outcome().text}
          fallback={
            <div class="cv-dr-now">
              <StatusRow t={job()} />
              {/* a job waiting on the user is answered right here */}
              <Show when={decisionFor(job().id)} fallback={<Live t={job()} />}>
                {(dec) => <DecisionCard d={dec()} />}
              </Show>
            </div>
          }
        >
          <div class="cv-dr-now">
            <StatusRow t={job()} />
            <Markdown class="cv-dr-result" text={outcome().text} />
          </div>
          <Show when={outcome().proof.length}>
            <section>
              <h4>{t("근거")}</h4>
              <ul class="cv-dr-steps">
                <For each={outcome().proof}>
                  {(x) => (
                    <li class="link" onClick={() => (x.kind === "link" ? window.open(x.ref, "_blank") : openTask(job().id))} title={x.ref}>
                      <span class={`cv-dr-ic`}><Icon name={x.kind === "link" ? "link" : x.kind === "shot" ? "monitor" : "file"} size={12} /></span>
                      <span class="cv-dr-step">{x.kind === "link" ? x.ref.replace(/^https?:\/\/(www\.)?/, "") : base(x.ref)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </Show>
        <Show when={job().plan.length}>
          <section>
            <h4>{t("할 일")}</h4>
            <ol class="cv-dr-plan">
              <For each={job().plan}>
                {(p) => (
                  <li class={`p-${stepState(p, job())}`}>
                    {/* done: a quiet check; the one being worked on now (running tasks only): an accent dot */}
                    <Show when={stepState(p, job()) === "done"} fallback={<i />}>
                      <Icon name="check" size={12} class="cv-dr-check" />
                    </Show>
                    <span>{p.text}</span>
                  </li>
                )}
              </For>
            </ol>
          </section>
        </Show>
        <Show when={!ended() && recent().length}>
          <section>
            <h4>{t("최근 단계")}</h4>
            <ul class="cv-dr-steps">
              <For each={recent()}>
                {(s) => (
                  <li classList={{ bad: !s.ok, open: s.open }}>
                    <span class={`cv-dr-ic r-${s.kind}`}><Icon name={ACT[s.kind]?.icon ?? "tools"} size={12} /></span>
                    <span class="cv-dr-step">{base(s.target) || t(ACT[s.kind]?.label ?? "도구")}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={kids().length}>
          <section>
            <h4>{t("서브에이전트")}</h4>
            <ul class="cv-dr-steps">
              <For each={kids()}>
                {(k) => (
                  <li onClick={() => openTask(k.id)} class="link">
                    <StatusGlyph t={k} />
                    <span class="cv-dr-step">{k.title}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={d().add || d().del}>
          <section>
            <h4>{t("변경")}</h4>
            <div class="cv-dr-diff">
              <Show when={d().add}><span class="add">+{d().add}</span></Show>
              <Show when={d().del}><span class="del">−{d().del}</span></Show>
            </div>
          </section>
        </Show>
      </div>
      <Show when={tone(job()) !== "done"}>
        <form
          class="cv-dr-talk"
          onSubmit={(e) => {
            e.preventDefault();
            say();
          }}
        >
          <input
            placeholder={job().status === "running" ? t("작업 중에 말하기") : job().status === "queued" ? t("메시지 보내기") : t("이어서 말하기")}
            value={msg()}
            onInput={(e) => setMsg(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button type="submit" class="cv-send" disabled={!msg().trim()} aria-label={t("보내기")} title={t("보내기")}>
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
  const [vpSize, setVpSize] = createSignal({ w: 800, h: 600 });
  onMount(() => remeasure(0));
  // the order is taken when the canvas opens and when the workspace changes
  createEffect(on(space, (sp) => untrack(() => snapRanks(sp))));
  /** jobs side by side: the arrangement that shows the most at a readable size */
  const maxCols = createMemo(() => bestCols(space(), unfolded(), vpSize()));
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
  createEffect(() => setZoomNow(zoom()));
  const [sel, setSel] = createSignal<string>();
  const [drag, setDrag] = createSignal<{ id: string; x: number; y: number } | null>(null);
  const [grid, setGrid] = createSignal(true);
  /** the line a card sits on: everything above it and everything under it */
  const lineage = createMemo(() => {
    const id = sel();
    if (!id) return null;
    const keep = new Set<string>([id]);
    const up = new Map(graph().edges.map((e) => [e.to, e.from]));
    for (let x = up.get(id); x; x = up.get(x)) keep.add(x);
    const walk = (x: string) => graph().edges.forEach((e) => e.from === x && !keep.has(e.to) && (keep.add(e.to), walk(e.to)));
    walk(id);
    return keep;
  });
  const dim = (id: string) => !!lineage() && !lineage()!.has(id);
  let vp: HTMLDivElement | undefined;
  /** the viewport once it's on screen (the board mode has none) */
  const [vpEl, setVpEl] = createSignal<HTMLDivElement>();

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
  /** a new task from the header lands in the selected card's (or lane's) project */
  const selProject = () => {
    const n = sel() ? byId().get(sel()!) : undefined;
    const p = n?.kind === "proj" ? n.project!.id : n && projectOf(n);
    return p && p !== "_" ? p : undefined;
  };
  /** Pick a task card: its side sheet opens, and the card is moved into view beside it. */
  const pick = (n: Node) => {
    setSel(n.id);
    if (!vp) return;
    const z = zoom(), p = pan(), v = vpSize(), q = pos(n);
    const room = 16;
    // the sheet's width (see .cv-drawer) and its inset from the edge
    const right = v.w - Math.min(400, v.w - 80) - 8 - room;
    const x = q.x * z + p.x, y = q.y * z + p.y, w = n.w * z, h = n.h * z;
    let dx = 0, dy = 0;
    if (x + w > right) dx = right - (x + w);
    if (x + dx < room) dx = room - x;
    if (y < room) dy = room - y;
    else if (y + h > v.h - room) dy = Math.max(room - y, v.h - room - (y + h));
    if (!dx && !dy) return;
    touched = true;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      vp.classList.add("glide");
      setTimeout(() => vp?.classList.remove("glide"), 260);
    }
    setPan({ x: p.x + dx, y: p.y + dy });
  };
  /** Fold or unfold finished jobs: they slide into (or out of) the project's "끝난 일" card. */
  const fold = (next: string[]) => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const was = new Set(graph().nodes.map((n) => n.id));
      setUnfolded(next);
      return void reveal(graph().nodes.filter((n) => !was.has(n.id)));
    }
    const before = graph().nodes;
    const unfoldedBefore = unfolded();
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
      reveal(after.filter((n) => !was[n.id] || (n.kind === "more" && next.includes(n.project!.id) && !unfoldedBefore.includes(n.project!.id))));
    }
  };
  /** what just came out of a fold is brought into view, the fold itself kept on screen */
  const reveal = (ns: Node[]) => {
    if (!vp || !ns.length) return;
    const z = zoom(), p = pan(), v = vpSize(), room = 16;
    const b = boxOf(ns);
    const x0 = b.x0 * z + p.x, x1 = b.x1 * z + p.x, y0 = b.y0 * z + p.y, y1 = b.y1 * z + p.y;
    let dx = 0, dy = 0;
    if (x1 > v.w - room) dx = Math.max(v.w - room - x1, room - x0);
    else if (x0 < room) dx = room - x0;
    if (y1 > v.h - room) dy = Math.max(v.h - room - y1, room - y0);
    else if (y0 < room) dy = room - y0;
    if (!dx && !dy) return;
    touched = true;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      vp.classList.add("glide");
      setTimeout(() => vp?.classList.remove("glide"), 260);
    }
    setPan({ x: p.x + dx, y: p.y + dy });
  };

  /** the person moved or zoomed the view: a window resize no longer refits it */
  let touched = false;
  /**
   * `all`: everything in view (the button, ⇧1). Otherwise everything when it fits at
   * 75% or more; when it doesn't, 75% and what needs the person (a reply, then running
   * work) is kept in view, with no card cut at the top edge.
   */
  const fit = (animate = true, all = false) => {
    const ns = graph().nodes;
    if (!ns.length || !vp) return;
    touched = false;
    const r = vp.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const b = boxOf(ns);
    const aw = r.width - INSET.side * 2, ah = r.height - INSET.top - INSET.bottom;
    const whole = Math.min(1, aw / (b.x1 - b.x0), ah / (b.y1 - b.y0));
    const z = all ? Math.max(0.3, whole) : whole >= MIN_ZOOM ? whole : READ_ZOOM;
    if (animate) vp.classList.add("glide");
    setZoom(z);
    const x = (b.x1 - b.x0) * z <= aw ? INSET.side + (aw - (b.x1 - b.x0) * z) / 2 - b.x0 * z : INSET.side - b.x0 * z;
    let y: number;
    if ((b.y1 - b.y0) * z <= ah) y = INSET.top + (ah - (b.y1 - b.y0) * z) / 2 - b.y0 * z;
    else {
      // too tall: from the top, moved down only as far as the cards that need the person:
      // a reply, then failed, then running work, as many of those as fit together
      y = INSET.top - b.y0 * z;
      let keep: Node[] = [];
      for (const tn of ["ask", "failed", "live"]) {
        const more = ns.filter((n) => n.task && n.kind !== "more" && tone(n.task) === tn);
        if (!more.length) continue;
        const next = [...keep, ...more];
        const nb = boxOf(next);
        if (keep.length && (nb.y1 - nb.y0) * z > ah) break;
        keep = next;
      }
      const k = keep.length ? boxOf(keep) : undefined;
      if (k) {
        const over = (k.y1 * z + y) - (INSET.top + ah);
        if (over > 0) y -= Math.min(over, k.y0 * z + y - INSET.top);
      }
      // never a card cut at the top edge: the view starts at the top of a task card (not a
      // subagent or a folded pill, whose task would be out of view) that no other card
      // crosses, with the gap above it (up to the inset) and nothing of the card before
      const want = (INSET.top - y) / z;
      const parent = (n: Node) => (n.kind === "sub" ? n.task?.parentId : n.kind === "more" && n.task ? n.task.id : undefined);
      // no card crosses the line, and no subagent below it has its task above it
      const clear = (s: number) =>
        !ns.some((n) => n.y < s && n.y + n.h > s) &&
        !ns.some((n) => n.y >= s && parent(n) && (byId().get(parent(n)!)?.y ?? s) < s);
      const starts = [...new Set([b.y0, ...ns.filter((n) => n.kind === "job" || n.kind === "proj").map((n) => n.y)])].filter(clear).sort((p, q) => p - q);
      const s = starts.find((v) => v >= want && (!k || v <= k.y0)) ?? [...starts].reverse().find((v) => v <= want) ?? b.y0;
      const above = ns.filter((n) => n.y + n.h <= s).map((n) => n.y + n.h);
      const pad = above.length ? Math.max(0, Math.min(INSET.top, (s - Math.max(...above)) * z - 2)) : INSET.top;
      y = pad - s * z;
    }
    setPan({ x, y });
    if (animate) setTimeout(() => vp?.classList.remove("glide"), 260);
  };

  const zoomAt = (factor: number, cx = (vp?.clientWidth ?? 0) / 2, cy = (vp?.clientHeight ?? 0) / 2) => {
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
    const r = vp!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  };

  const onBgDown = (e: PointerEvent) => {
    if (!vp || e.button !== 0 || (e.target as HTMLElement).closest(".cv-node, .cv-ctrl, .cv-drawer, .cv-mini, button")) return;
    const el = vp;
    setSel(undefined);
    const start = { x: e.clientX, y: e.clientY, p: pan() };
    el.setPointerCapture(e.pointerId);
    el.classList.add("grabbing");
    const move = (ev: PointerEvent) => {
      touched = true;
      setPan({ x: start.p.x + ev.clientX - start.x, y: start.p.y + ev.clientY - start.y });
    };
    const up = () => {
      el.classList.remove("grabbing");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
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
      // a lane is picked (새 작업 then lands in it); a double click opens its project
      else if (n.kind === "proj") setSel(sel() === n.id ? undefined : n.id);
      else if (n.kind === "more") {
        const id = n.project!.id;
        fold(unfolded().includes(id) ? unfolded().filter((x) => x !== id) : [...unfolded(), id]);
      }
      else pick(n);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  /** Put every card back in line (drops where they were dragged to). */
  const resetLayout = () => {
    snapRanks(space());
    const from = Object.fromEntries(graph().nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const prefix = `${space()}:`;
    // a store merges objects, so a filtered copy would keep the old keys: drop each one
    for (const k of Object.keys(state.canvas ?? {})) if (k.startsWith(prefix)) setState("canvas", k, undefined!);
    const to = Object.fromEntries(graph().nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const moved = Object.keys(to).some((id) => from[id] && (from[id].x !== to[id].x || from[id].y !== to[id].y));
    // put back in line and framed as when opened: readable, what needs the person in view
    if (!moved || matchMedia("(prefers-reduced-motion: reduce)").matches) return void queueMicrotask(() => fit(true));
    animate(from, to, null, 320, () => queueMicrotask(() => fit(true)));
  };

  /** open what is picked: a task, or a lane's project */
  const openSel = () => {
    const n = sel() ? byId().get(sel()!) : undefined;
    if (n?.kind === "proj") goMain(n.project!.id === "_" ? undefined : n.project!.id);
    else if (n?.task) openTask(n.id);
  };
  const onKey = (e: KeyboardEvent) => {
    const target = e.target;
    if (!(target instanceof Element) || (target !== document.body && !target.closest(".canvas-view"))) return;
    if (target.closest('button, a[href], [tabindex], [role="button"], [role="tab"]')) return;
    if (!viewKey(e) || e.metaKey || e.ctrlKey || e.altKey || mode() !== "canvas") return;
    if (e.shiftKey && e.code === "Digit1") (e.preventDefault(), fit(true, true));
    else if (!e.metaKey && (e.key === "=" || e.key === "+")) zoomAt(1.2);
    else if (!e.metaKey && e.key === "-") zoomAt(1 / 1.2);
    else if (!e.shiftKey && e.key === "Enter" && sel()) (e.preventDefault(), openSel());
    else if (!e.shiftKey && e.key === "Escape" && sel()) (e.preventDefault(), e.stopPropagation(), setSel(undefined));
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
  // the viewport only exists in canvas mode (and with tasks): watch it while it's there
  createEffect(() => {
    const el = vpEl();
    if (!el || mode() !== "canvas") return;
    const ro = new ResizeObserver(() => setVpSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    // shown (opened, or back from the board): framed as on first open
    const id = requestAnimationFrame(() => fit(false));
    onCleanup(() => (ro.disconnect(), cancelAnimationFrame(id)));
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
  /** the minimap is there when asked for (it would sit on cards otherwise) */
  const [mini, setMini] = createSignal(false);
  /** nothing in this workspace yet: a quiet empty state instead of a lone Main card */
  const empty = () => !state.tasks.some((x) => x.space === space() && !x.parentId && !x.answer && !x.archived);

  return (
    <div class="view canvas-view">
      <header class="head" data-tauri-drag-region>
        <SidebarToggle />
        <span class="head-title">{mode() === "canvas" ? t("캔버스") : t("보드")}</span>
        <Show when={mode() === "canvas"}>
        {/* the legend draws each state with the sidebar's glyph, so running and review read apart */}
        <span class="board-sum cv-legend">
          <For each={LEGEND}>
            {(l) => (
              <Show when={counts()[l.tone]}>
                <span><StateGlyph g={l.g} />{t(l.label)} <b>{counts()[l.tone]}</b></span>
              </Show>
            )}
          </For>
        </span>
        </Show>
        <span class="spacer" data-tauri-drag-region />
        {/* cards were dragged out of line: one press puts them back */}
        <Show when={mode() === "canvas" && Object.keys(state.canvas ?? {}).some((k) => k.startsWith(`${space()}:`))}>
          <button class="btn sm ghost cv-retidy" onClick={resetLayout}>
            <Icon name="tidy" size={14} />
            {t("다시 정렬")}
          </button>
        </Show>
        <Show when={mode() === "list"}><BoardGroup /></Show>
        <NewTask project={() => (mode() === "canvas" ? selProject() : undefined)} />
        <div class="seg sm cv-mode" role="tablist">
          <button role="tab" aria-selected={mode() === "canvas"} classList={{ on: mode() === "canvas" }} title={t("캔버스")} aria-label={t("캔버스")} onClick={() => setMode("canvas")}>
            <Icon name="canvas" size={14} />
          </button>
          <button role="tab" aria-selected={mode() === "list"} classList={{ on: mode() === "list" }} title={t("보드")} aria-label={t("보드")} onClick={() => setMode("list")}>
            <Icon name="board" size={14} />
          </button>
        </div>
      </header>

      <Show when={mode() === "canvas"} fallback={<Board embedded />}>
        <div class="cv-frame">
          <Show
            when={!empty()}
            fallback={
              <div class="pane-empty cv-empty">
                <Icon name="canvas" size={20} />
                <span>{t("작업 없음")}</span>
              </div>
            }
          >
          <div
            class="cv-viewport"
            classList={{ "no-grid": !grid() }}
            ref={(el) => ((vp = el), setVpEl(el))}
            onWheel={onWheel}
            onPointerDown={onBgDown}
            style={{ "background-position": `${pan().x}px ${pan().y}px`, "background-size": `${20 * zoom()}px ${20 * zoom()}px` }}
          >
            <div class="cv-world" style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`, "--cv-z": String(zoom()) }}>
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
                    style={{ left: `${pos(node()).x}px`, top: `${pos(node()).y}px`, width: `${node().w}px`, height: `${node().h}px`, opacity: fade()?.[n.id] }}
                    onPointerDown={(e) => onNodeDown(node(), e)}
                    onDblClick={() => (n.kind === "proj" ? goMain(n.project!.id === "_" ? undefined : n.project!.id) : n.task && openTask(n.id))}
                    onContextMenu={(e) => n.task && n.kind !== "more" && cardMenu(n.id)(e)}
                  >
                    {n.kind === "main" ? <MainCard /> : n.kind === "proj" ? <ProjCard n={node()} space={space()} /> : n.kind === "job" ? <JobCard n={node()} /> : n.kind === "more" ? <MoreCard n={node()} /> : <SubCard n={node()} />}
                  </div>
                  );
                  }}
                  </Show>
                )}
              </For>
            </div>

            <svg
              class="cv-mini"
              classList={{ shifted: !!selTask(), gone: !mini() || vpSize().w < 640 || vpSize().h < 460 }}
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
          {/* the controls sit under the map, never on a card */}
          <div class="cv-ctrl" role="toolbar" aria-label={t("캔버스 도구")}>
              <button title={grid() ? t("격자 숨기기") : t("격자 표시")} aria-label={grid() ? t("격자 숨기기") : t("격자 표시")} classList={{ on: grid() }} onClick={() => setGrid(!grid())}>
                <Icon name="dots" size={14} />
              </button>
              <i class="cv-ctrl-sep" />
              <button title={t("축소 (−)")} aria-label={t("축소")} onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" size={14} /></button>
              <button class="cv-zoom" title={t("전체 보기 (⇧1)")} onClick={() => fit(true, true)}>{Math.round(zoom() * 100)}%</button>
              <button title={t("확대 (+)")} aria-label={t("확대")} onClick={() => zoomAt(1.2)}><Icon name="plus" size={14} /></button>
              <i class="cv-ctrl-sep" />
              <button title={t("다시 정렬")} aria-label={t("다시 정렬")} onClick={resetLayout}><Icon name="tidy" size={14} /></button>
              <Show when={foldable().length}>
                <button title={allOpen() ? t("완료된 작업 모두 접기") : t("완료된 작업 모두 펼치기")} aria-label={allOpen() ? t("완료된 작업 모두 접기") : t("완료된 작업 모두 펼치기")} classList={{ on: allOpen() }} onClick={() => fold(allOpen() ? [] : foldable())}>
                  {allOpen() ? <ChevronsDownUp size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" /> : <ChevronsUpDown size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" />}
                </button>
              </Show>
              <Show when={roomy() || mini()}>
                <button title={mini() ? t("미니맵 숨기기") : t("미니맵 표시")} aria-label={mini() ? t("미니맵 숨기기") : t("미니맵 표시")} aria-pressed={mini()} classList={{ on: mini() }} onClick={() => setMini(!mini())}>
                  <MapIcon size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" />
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export const openCanvas = () => setView({ name: "board" });
