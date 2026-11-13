// The canvas: all the work of a space as a map you can pan and zoom.
// Main sits on the left, its projects next, then the jobs, then each job's
// subagents, joined by lines. A card does not tell you in words what a job is
// doing; it shows it: the tool it is using right now moves, the strip under it
// is the rhythm of its last steps, the bar is its plan, the split is its diff.
// Cards can be dragged; where you put them is kept.
import { describeBrowser, describeCommand, nowText } from "../engine/describe";
import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
type P = { x: number; y: number };
import { DecisionCard } from "../ui/DecisionCard";
import { decisionFor, projectsIn, setState, spaceById, kidsOf, state, taskById } from "../state/store";
import type { Project, Task, ToolKind } from "../state/types";
import { goMain, live, openPanel, openTask, setView } from "../state/ui";
import { decide, resumeTask, startTask, tell } from "../engine/tasks";
import { costDetail, jobCost } from "../ui/cost";
import { ago, compact, IssueTag, long, soon, statusLabel, taskTitle, tokens } from "../ui/bits";
import { browserStreamPort, fileSrc } from "../lib/native";
import { Icon } from "../ui/Icon";
import { DotGrid } from "../ui/DotGrid";
import { Markdown } from "../ui/Markdown";
import { changes, Glyph, SidebarToggle } from "./Sidebar";
import { discarded, pausedAt, planCount, stepState, taskDiff } from "../state/progress";
import { linkMenu, openLink } from "../ui/links";
import { Board, BoardGroup, cardMenu, Kids, LinesChanged, NewTask, StateGlyph } from "./Board";
import { ChevronsDownUp, ChevronsUpDown, Map as MapIcon } from "lucide-solid";
import { viewKey } from "../lib/shortcuts";
import { lang, t } from "../i18n";
import { PaneControls } from "./PaneControls";
import { usePaneFocused } from "../state/panes";

// ───────────── geometry

const W = { main: 168, proj: 200, job: 288, sub: 236 };
const H = { main: 84, proj: 84, job: 196, sub: 72, more: 40 };
const X = { main: 0, proj: 216, job: 472 };
const GAP = { job: 28, col: 24, sub: 12, proj: 56, lanes: 48 };
/** how far over the top of the lanes the line to a second column's lane runs */
const BUS = 20;
/** a second column of lanes starts this far right of the first */
const COL = X.job + W.job + GAP.lanes - X.proj;
const SUB_INDENT = 28;

type Kind = "main" | "proj" | "job" | "sub" | "more";
export interface Node {
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
  /** sized to its words (measured at 75%): drawn as tall as they are, `h` at most */
  hug?: boolean;
}
interface Edge {
  from: string;
  to: string;
  tone: string;
  /** Main to a lane in the second column: over the top of the first, never across a card */
  over?: boolean;
}

/** the map, or the same tasks as columns by state */
const [mode, setMode] = createSignal<"canvas" | "list">("canvas");
/** projects whose finished jobs are unfolded on the canvas */
const [unfolded, setUnfolded] = createSignal<string[]>([]);
/** a finished job folds into "끝난 일" right away (one waiting on a merge or an answer stays out) */
const folded = (t: Task) => tone(t) === "done" && !t.pinned;
/** a finished sub-job folds under its job the same way */
const subFolded = (k: Task) => k.status === "done" && !k.pinned;

/** failed · live = working now · ask = needs a reply · review = done, branch not merged · paused · idle = queued · done.
 *  Failed is its own state: never counted or drawn as needing a reply. */
function tone(t: Task): string {
  if (discarded(t)) return "done";
  if (t.status === "failed") return "failed";
  const kids = kidsOf(t.id);
  if (t.status === "waiting" || kids.some((k) => k.status === "waiting")) return "ask";
  if (t.status === "running" || kids.some((k) => k.status === "running")) return "live";
  if (t.status === "paused") return "paused";
  if (t.status === "queued") return "idle";
  if (t.status === "done" && t.worktree?.state === "open") return "review";
  return "done";
}

/** which comes first on the canvas (and in the first view): a reply, failed, running, review, paused, queued, done */
const RANK: Record<string, number> = { ask: 0, failed: 1, live: 2, review: 3, paused: 4, idle: 5, done: 6 };
/**
 * Each task's place in that order when the canvas was opened (or tidied): lanes and cards keep
 * their place while the work moves on, instead of jumping under the pointer. New tasks rank as they are.
 */
const [ranks, setRanks] = createSignal<Record<string, number>>({});
const rankOf = (t: Task) => ranks()[t.id] ?? RANK[tone(t)];
const snapRanks = (space: string) => {
  for (const k in laneCol) delete laneCol[k];
  setRanks(Object.fromEntries(state.tasks.filter((t) => t.space === space && !t.parentId).map((t) => [t.id, RANK[tone(t)]])));
};
/** which of two columns each lane went to (kept like the ranks, so lanes don't swap columns as work moves on) */
const laneCol: Record<string, number> = {};
/** the zoom the canvas is at, for what has to be measured at the size it's drawn */
const [zoomNow, setZoomNow] = createSignal(1);
/**
 * The zoom a card's words are measured at: the ladder's step at or under the zoom (75% at
 * most out: under it the words keep their 75% size, see .cv-world). Cards are sized at the
 * zoom they are drawn at, so a lane's gaps stay even at every step.
 */
const sizeOf = (z: number) => stepUnder(Math.max(z, 0.75));
const sizeAt = () => sizeOf(zoomNow());
/** lanes in two columns: the view holds both at the first view's zoom */
const [twoCols, setTwoCols] = createSignal(false);

/**
 * Lanes top to bottom, a lane's cards in one column (a job's subagents stacked under it). With `two`
 * (a wide view), the lanes flow into two columns of lanes, top-aligned: each lane, in order, goes to
 * the shorter column (as they are folded, at the first view's zoom) and stays in it until the canvas is opened or tidied again. Main and each
 * project sit at the top of what they lead to, so a lane that grows only grows downward.
 */
export function layout(space: string, open: string[], k = untrack(sizeAt), two = untrack(twoCols)): { nodes: Node[]; edges: Edge[] } {
  const roots = state.tasks.filter((t) => t.space === space && !t.parentId && !t.answer && !t.archived);
  const projects: (Project | { id: string; name: string; folder: string })[] = [...projectsIn(space as Task["space"])];
  if (roots.some((t) => !t.project || !projects.some((p) => p.id === t.project))) projects.push({ id: "_", name: "프로젝트 없음", folder: spaceById(space as Task["space"]).folder });
  const jobsOf = (p: { id: string }) =>
    roots
      .filter((t) => (p.id === "_" ? !t.project || !projects.some((q) => q.id === t.project && q.id !== "_") : t.project === p.id))
      .sort((a, b) => rankOf(a) - rankOf(b) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  // the lane that needs the person most comes first (the sidebar's order between equals)
  const laneRank = (p: { id: string }) => Math.min(7, ...jobsOf(p).filter((t) => !folded(t)).map(rankOf));
  const lanes = projects.map((p, i) => ({ p, i, r: laneRank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
  /** one lane from y = 0: its cards, its lines, and how far down the next lane starts */
  const lane = (p: (typeof projects)[number], open: string[], k: number) => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    let y = 0;
    const all = jobsOf(p);
    // finished jobs fold into one "완료 N개" card per project; unfolded, they come out under it
    const done = all.filter(folded);
    const jobs = all.filter((t) => !folded(t));
    /** one column: each job, then its own sub-jobs under it */
    const place = (list: Task[]) => {
      for (const t of list) {
        const h = jobHeight(t, k);
        nodes.push({ id: t.id, kind: "job", x: X.job, y, w: W.job, h, task: t, hug: quiet(t) });
        edges.push({ from: `p:${p.id}`, to: t.id, tone: tone(t) });
        let ky = y + h + GAP.sub;
        const kids = kidsOf(t.id);
        const kidsDone = kids.filter(subFolded);
        const sub = (k: Task) => {
          nodes.push({ id: k.id, kind: "sub", x: X.job + SUB_INDENT, y: ky, w: W.job - SUB_INDENT, h: H.sub, task: k });
          edges.push({ from: t.id, to: k.id, tone: tone(k) });
          ky += H.sub + GAP.sub;
        };
        kids.filter((k) => !subFolded(k)).forEach(sub);
        // finished subagents: one fold, and unfolded they come out under it
        if (kidsDone.length) {
          nodes.push({ id: `more:${t.id}`, kind: "more", x: X.job + SUB_INDENT, y: ky, w: W.job - SUB_INDENT, h: H.more, project: { id: t.id, name: t.title, folder: "" }, task: t, count: kidsDone.length });
          ky += H.more + GAP.sub;
          if (open.includes(t.id)) kidsDone.forEach(sub);
        }
        y = ky - GAP.sub + GAP.job;
      }
    };
    place(jobs);
    if (done.length) {
      nodes.push({ id: `more:${p.id}`, kind: "more", x: X.job, y, w: W.job, h: H.more, project: p, count: done.length, gone: done.filter(discarded).length });
      y += H.more + GAP.job;
      if (open.includes(p.id)) place(done);
    }
    nodes.push({ id: `p:${p.id}`, kind: "proj", x: X.proj, y: 0, w: W.proj, h: H.proj, project: p });
    edges.push({ from: "main", to: `p:${p.id}`, tone: jobs.some((t) => tone(t) === "ask") ? "ask" : jobs.some((t) => tone(t) === "failed") ? "failed" : jobs.some((t) => tone(t) === "live") ? "live" : jobs.length ? "done" : "idle" });
    // a lane is never shorter than its project card (a short card beside it would pull the next lane in)
    return { nodes, edges, next: Math.max(y, H.proj + GAP.job) + GAP.proj - GAP.job };
  };
  const nodes: Node[] = [{ id: "main", kind: "main", x: X.main, y: 0, w: W.main, h: H.main }];
  const edges: Edge[] = [];
  const tops = two ? [0, 0] : [0];
  /** where each column has got to, with every lane folded (what decides the column) */
  const weight = two ? [0, 0] : [0];
  for (const p of lanes) {
    const c = two ? (laneCol[p.id] ?? (weight[1] < weight[0] ? 1 : 0)) : 0;
    // kept once the cards are measured on screen (before that their heights are a guess)
    if (two && typeof document !== "undefined" && document.querySelector(".canvas-view")) laneCol[p.id] = c;
    const l = lane(p, open, k);
    weight[c] += two ? lane(p, [], READ_ZOOM).next : 0;
    for (const n of l.nodes) nodes.push({ ...n, x: n.x + c * COL, y: n.y + tops[c] });
    for (const e of l.edges) edges.push(c && e.from === "main" ? { ...e, over: true } : e);
    tops[c] += l.next;
  }
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
/**
 * The camera's air (screen px) between a card it puts in view and the edge: ROOM at the top and left,
 * FAR at the bottom and right, where the view fades out over FADE (the left edge over ROOM). Beside the
 * sheet the fade is longer (SHEET_FADE: what's left of a card going under it can't be read), and so is
 * the air. Where there isn't room for all of it, the air gives way first (see `airFor`).
 */
const ROOM = 16;
const FADE = 20;
const SHEET_FADE = 32;
const FAR = FADE + 8;
/** the air before and after something `slack` px narrower than the view, with a fade `fade` long at its far
 *  end: ROOM and 8 past the fade, giving way down to 0 and the fade */
const airFor = (slack: number, fade = FADE) => {
  const lead = Math.min(ROOM, Math.max(0, slack - fade));
  return { lead, tail: Math.min(fade + 8, slack - lead) };
};
/** the sheet's width in a view `w` wide (see .cv-drawer): narrower in a narrow view, so a card fits beside it */
const sheetW = (w: number) => Math.min(400, Math.max(320, w - 300), w - 80);
/** the first view's zoom (it never goes under it) */
const READ_ZOOM = 0.75;
/** fit-all never goes under this */
const FLOOR_ZOOM = 0.5;
/** the first view's priority: needs a reply, failed, running, review, paused */
const FIRST = ["ask", "failed", "live", "review", "paused"];
/** the zoom steps − and + (and ⌘− ⌘+) move along */
const LADDER = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];
/** the ladder's step at or under `z` (the zoom itself under the first step) */
const stepUnder = (z: number) => [...LADDER].reverse().find((s) => s <= z + 0.001) ?? z;

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
  review: { icon: "merge", label: "병합 필요" },
  failed: { icon: "alert", label: "실패" },
};

const base = (s?: string) => (s ? s.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 40) : undefined);

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
const unchecked = (job: Task) => job.status === "done" && !discarded(job) && job.worktree?.state !== "merged" && !!job.unverified?.length;

/** a failed card says why in one muted line, in place of any preview */
const failedLine = (job: Task) => job.status === "failed" && !discarded(job) && !!bodyText(job);

/** a card that only says something in words (not running, no screenshot): it takes the height of its words */
const quiet = (job: Task) => job.status !== "running" && (failedLine(job) || !(job.shot && lastToolOf(job)?.kind === "browser"));

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
 * Measured at the zoom step `k` it is drawn at (see `sizeOf`); between steps a card's words
 * are a little smaller than at the step under it, so the card still holds them.
 */
function measure(title: string, live: string, max: number, k: number): number {
  measured();
  const key = `${lang()}\u0000${k}\u0000${title}\u0000${live}`;
  const had = heights.get(key);
  if (had) return had;
  if (typeof document === "undefined" || !document.querySelector(".canvas-view")) return H.job;
  if (!probe) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.className = "cv-world";
  }
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;--cv-z:${k}`;
  // inside the view, so the card picks up the same rules it will on the canvas
  document.querySelector(".canvas-view")!.appendChild(probe);
  probe.innerHTML = `<div class="cv-node cv-job" style="position:static;width:${W.job}px;height:auto"><div class="cv-head"><span class="cv-stg"><span class="sb-glyph st-icon sm"></span></span><span class="cv-title">${esc(title)}</span></div>${live}<div class="cv-status"><span class="cv-status-text">x</span></div></div>`;
  const h = Math.min(max, Math.ceil((probe.firstElementChild as HTMLElement).getBoundingClientRect().height));
  probe.remove();
  if (h > 0) heights.set(key, h);
  return h > 0 ? h : H.job;
}

/** a job card's height: the full card for work that moves, the height of its words for the rest */
function jobHeight(job: Task, k: number): number {
  if (!quiet(job)) return H.job;
  const ask = askOf(job);
  if (ask) {
    const opts = ask.opts.map((o) => `<button class="cv-ask-opt"><span class="cv-ask-label">${esc(o.label)}</span>${o.rec ? `<span class="cv-ask-rec">${esc(t("추천"))}</span>` : ""}</button>`).join("");
    return measure(job.title, `<div class="cv-live w-question"><div class="cv-ask"><p class="cv-text ask">${esc(ask.q)}</p>${opts ? `<div class="cv-ask-opts">${opts}</div>` : ""}</div></div>`, H.job + 40, k);
  }
  const body = bodyText(job);
  return measure(job.title, `<div class="cv-live w-${body ? "summary" : "none"}">${body ? `<p class="cv-text${failedLine(job) ? " muted one" : ""}">${esc(body)}</p>` : '<div class="cv-live-empty"></div>'}</div>`, H.job, k);
}

/** +8 −3줄, plain (nothing for a discarded task, its changes are gone, or a merged one: they're in) */
function Diff(props: { t: Task }) {
  const d = () => (discarded(props.t) || props.t.worktree?.state === "merged" ? { add: 0, del: 0 } : changes(props.t));
  return (
    <Show when={d().add || d().del}>
      <LinesChanged class="cv-diff" add={d().add} del={d().del} />
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
function said(e: { tool: { kind: ToolKind; name: string; target: string; detail?: string; note?: boolean; endedAt?: number } }, running = true): { icon: string; label: string; target: string; cmd?: boolean } {
  const x = e.tool;
  const icon = ACT[x.kind]?.icon ?? "tools";
  /** going on only while its task runs (a paused or finished task's last step is over) */
  const past = !!x.endedAt || !running;
  const verb = (k: ToolKind) => t((VERB[k] ?? VERB.other!)[past ? 1 : 0]);
  if (x.kind === "bash") {
    const d = describeCommand(x.detail ?? x.target);
    return { icon, label: past ? d.label : d.now, target: d.target && !d.label.includes(d.target) ? d.target : "", cmd: true };
  }
  if (x.note) return { icon: "write", label: t("기록"), target: x.target };
  // the whole target (the row cuts it with an ellipsis), the address without its scheme
  if (x.kind === "browser") {
    const d = describeBrowser(x.target);
    return { icon, label: past ? d.label : d.now, target: d.target ?? "" };
  }
  if (x.kind === "other") {
    const named = ({ memory_search: "메모리 검색", subagent: "서브에이전트 실행" } as Record<string, string>)[x.name];
    return { icon, label: named ? t(named) : verb("other"), target: named ? "" : x.name };
  }
  return { icon, label: verb(x.kind), target: x.target, cmd: x.kind === "test" };
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
      {/* newest first, from the top: rows that don't fit (the oldest) drop out whole */}
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
                <Show when={s().target}><span class="tg" classList={{ cmd: !!s().cmd }} title={s().target}>{s().target}</span></Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** what a card shows of the work: the browser it drives, its steps, its question, its words, or nothing */
function liveMode(job: Task): "browser" | "shell" | "text" | "tool" | "act" | "question" | "summary" | "none" {
  const lastTool = lastToolOf(job);
  if (job.status === "waiting" && decisionFor(job.id)) return "question";
  if (job.status === "running") {
    // the browser only while it's what the job is using now (not after it moved on to the desktop or a shell)
    if (lastTool?.kind === "browser") return "browser";
    if (live[job.id] && !job.intent && !job.plan.length) return "text";
    if (lastTool || job.intent || job.plan.length) return "act";
    return "none";
  }
  if (failedLine(job)) return "summary";
  if (job.shot && lastTool?.kind === "browser") return "browser";
  // a body that only repeats the title (a queued task's ask, word for word, or the title is its cut) says nothing
  return bodyText(job) ? "summary" : "none";
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
  const what = () => liveMode(job());
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
          <p class="cv-text" classList={{ muted: (!job().summary && !job().error) || failedLine(job()), one: failedLine(job()) }} title={failedLine(job()) ? bodyText(job()) : undefined}>{bodyText(job())}</p>
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
  { tone: "review", g: "inreview", label: "병합 필요" },
  { tone: "paused", g: "paused", label: "일시정지" },
  { tone: "idle", g: "queued", label: "대기" },
] as const;

/** a project's states, most pressing first (discarded apart from done: it isn't 완료) */
const METER = ["ask", "review", "failed", "live", "paused", "idle", "done", "gone"];

const STATUS: Record<string, string> = { live: "진행 중", ask: "응답 필요", failed: "실패", review: "병합 필요", paused: "일시정지", idle: "대기", done: "완료", gone: "버림" };

/** The status glyph the sidebar draws (one look everywhere), named in its tooltip. */
function StatusGlyph(props: { t: Task }) {
  return (
    <span class="cv-stg" title={t(statusText(props.t))}>
      <Glyph t={props.t} />
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

/** a finished task's time and tokens: "19분 · 토큰 48K" */
const tookLine = (task: Task) => {
  const c = jobCost(task);
  return [c.ms ? long(c.ms) : "", c.total ? t("토큰 {n}", { n: tokens(c.total) }) : ""].filter(Boolean).join(" · ");
};

/** when its changes were thrown away (older tasks without discardedAt: when they finished) */
const discardedAt = (task: Task) => (discarded(task) ? (task.discardedAt ?? task.finishedAt) : undefined);

/** when a finished task ended: merged, discarded, or (done, failed) finished */
const endedAt = (task: Task) =>
  discarded(task) ? discardedAt(task) : task.status === "done" || task.status === "failed" ? (mergedAt(task) ?? task.finishedAt) : undefined;

/**
 * A card's (or the sheet's) state line. `label`: words in place of the state's (the sheet's running task
 * with no plan says what it's on there, not "진행 중" and then again under it).
 */
function StatusRow(props: { t: Task; sheet?: boolean; aside?: string; label?: string }) {
  const tn = () => tone(props.t);
  /** where it is in its plan, while it isn't finished: 진행 중 · 할 일 2/4 */
  const step = () => (props.t.plan.length && props.t.status !== "done" ? planCount(props.t.plan) : undefined);
  /** running: for how long; paused: since when; finished: when (on a card) or what it took (in the sheet) */
  const when = () => {
    if (props.aside) return props.aside;
    // the sidebar's clock, so the two never say different minutes
    if (props.t.status === "running" && props.t.startedAt) return compact(soon() - props.t.startedAt);
    const paused = pausedAt(props.t);
    if (paused) return ago(paused);
    const at = endedAt(props.t);
    if (!at) return "";
    return props.sheet ? tookLine(props.t) || ago(at) : ago(at);
  };
  const whenTitle = () => {
    if (!endedAt(props.t)) return undefined;
    const c = jobCost(props.t);
    // the time once, the tokens once (with their parts): "19분 · 토큰 48K (입력 …)"
    return [props.sheet ? ago(endedAt(props.t)) : c.ms ? long(c.ms) : "", costDetail(c)].filter(Boolean).join(" · ") || undefined;
  };
  /**
   * The row never wraps. When it runs out of room it drops, in order: the diff, the word "할 일"
   * (2/4 stays), the subagents' words (서브에이전트 1/2 → ⑂ 2), the subagent count; only then
   * is the state word cut. Two bare fractions never sit side by side, and numbers are never split.
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
    for (let k = 1; k <= 4 && cut(); k++) setTight(k);
  };
  createEffect(
    on([() => statusText(props.t), step, when, () => changes(props.t).add + changes(props.t).del, () => kidsOf(props.t.id).map((k) => k.status).join(), lang, zoomNow, measured], () =>
      queueMicrotask(refit),
    ),
  );
  onMount(() => requestAnimationFrame(refit));
  return (
    <div class={`cv-status s-${tn()}${props.t.status === "failed" && !discarded(props.t) ? " failed" : ""}`} ref={row}>
      <span class="cv-status-text" title={props.label}>{props.label ?? t(statusText(props.t))}</span>
      {/* on a card, the state first, then what it couldn't check (the sheet says it in a line of its own) */}
      <Show when={!props.sheet && unchecked(props.t)}>
        <span class="unverified-badge" title={props.t.unverified!.join("\n")}>{t("확인 안 됨 {n}", { n: props.t.unverified!.length })}</span>
      </Show>
      <Show when={step()}>
        {(p) => <span class="cv-step">{tight() >= 2 ? `· ${p().done}/${p().total}` : `· ${t("할 일 {done}/{all}", { done: p().done, all: p().total })}`}</span>}
      </Show>
      <Show when={tight() < 4}><Kids t={props.t} class="cv-meta" short={tight() >= 3} /></Show>
      <span class="spacer" />
      <Show when={tight() < 1}><Diff t={props.t} /></Show>
      <Show when={when()}><span class="cv-when" title={whenTitle()}>{when()}</span></Show>
    </div>
  );
}

export function JobCard(props: { n: Node }) {
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

export function ProjCard(props: { n: Node; space: string }) {
  const p = () => props.n.project!;
  const jobs = createMemo(() => state.tasks.filter((x) => x.space === props.space && !x.parentId && !x.answer && !x.archived && (p().id === "_" ? !x.project : x.project === p().id)));
  const counts = createMemo(() => {
    const n: Record<string, number> = {};
    for (const x of jobs()) {
      const k = discarded(x) ? "gone" : tone(x);
      n[k] = (n[k] ?? 0) + 1;
    }
    return n;
  });
  const count = (k: string) => counts()[k] ?? 0;
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
        {/* the most pressing state in words ("응답 필요 1"), every state and the total in the tooltip;
            with nothing going on, how many tasks it has */}
        <Show when={METER.find((k) => count(k) && k !== "done" && k !== "gone")} fallback={<span class="cv-when">{jobs().length ? t("작업 {n}개", { n: jobs().length }) : t("작업 없음")}</span>}>
          {(k) => (
            <span
              class={`cv-proj-state t-${k()}`}
              title={[...METER.filter((x) => count(x)).map((x) => `${t(STATUS[x])} ${count(x)}`), t("작업 {n}개", { n: jobs().length })].join(" · ")}
            >
              {t(STATUS[k()])} {count(k())}
            </span>
          )}
        </Show>
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

export function MainCard() {
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

/** A changed file's row: the folder quiet, the name in ink, its +n −m on the right. */
function FileRow(props: { path: string; add: number; del: number; onOpen: () => void }) {
  const cut = () => props.path.lastIndexOf("/");
  return (
    <li class="link cv-dr-file" onClick={props.onOpen} title={props.path}>
      <span class="cv-dr-ic"><Icon name="file" size={14} /></span>
      <span class="cv-dr-path">
        <Show when={cut() > 0}><span class="dir">{props.path.slice(0, cut() + 1)}</span></Show>
        <span class="name">{props.path.slice(cut() + 1)}</span>
      </span>
      <span class="cv-dr-n">
        <Show when={props.add}><span class="add">+{props.add}</span></Show>
        <Show when={props.del}><span class="del">−{props.del}</span></Show>
      </span>
    </li>
  );
}

/** Opens from the right when a job is picked, like a service panel. */
function Drawer(props: { t: Task; onClose: () => void }) {
  const job = () => props.t;
  const kids = () => kidsOf(job().id);
  /** the last steps, newest first, in the card's words (verb + target) */
  const recent = () =>
    job()
      .entries.filter((e): e is Extract<Task["entries"][number], { kind: "tool" }> => e.kind === "tool")
      .slice(-8)
      .reverse();
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
  /** the files it changed (nothing for a discarded task: its changes are gone) */
  const files = () => (discarded(job()) ? [] : taskDiff(job()).files);
  /**
   * While it works, the plan is listed below: the box above says only what the list doesn't
   * (its own sentence when that isn't the current to-do, or what it's on when it has no plan).
   */
  const nowLine = () => {
    const j = job();
    const cur = j.plan.find((p) => p.state === "now")?.text;
    if (j.intent && !(cur && same(j.intent, cur))) return j.intent;
    return !j.plan.length && j.now ? nowText(j.now) : "";
  };
  /** a running task with no plan: what it's on takes the state's place in its line ("진행 중" would say it twice) */
  const nowInRow = () => job().status === "running" && !job().plan.length && !job().intent && liveMode(job()) === "act" && !!nowLine() && !decisionFor(job().id);
  const review = () => tone(job()) === "review";
  /** the title is cut (by its two lines here, or with "…" when it was named) */
  const [cut, setCut] = createSignal(false);
  let titleEl: HTMLSpanElement | undefined;
  onMount(() => {
    if (!titleEl) return;
    const el = titleEl;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1 || /(…|\.\.\.)$/.test(job().title.trim()));
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    onCleanup(() => ro.disconnect());
  });
  createEffect(on(() => job().title, () => queueMicrotask(() => titleEl && setCut(titleEl.scrollHeight > titleEl.clientHeight + 1 || /(…|\.\.\.)$/.test(job().title.trim())))));
  /** what was asked, in full: for a task that hasn't started (or is paused) and wherever the title is cut */
  const asked = () => {
    const ask = job().ask?.trim() ?? "";
    if (!ask) return "";
    if (cut()) return ask;
    return (job().status === "paused" || job().status === "queued") && !same(ask, job().title) ? ask : "";
  };
  const queued = () => job().status === "queued";
  /** a queued task's request sits in its state box (with its place in the queue), not in a section of its own */
  const request = () => (queued() ? "" : asked());
  /** its place in the queue: next, or how many tasks are ahead of it */
  const ahead = () => {
    const q = state.tasks.filter((x) => x.status === "queued" && !x.parentId).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    const i = q.findIndex((x) => x.id === job().id);
    return i < 0 ? "" : i === 0 ? t("다음 차례") : t("앞에 작업 {n}개", { n: i });
  };
  const [msg, setMsg] = createSignal("");
  const say = () => {
    const m = msg().trim();
    if (!m) return;
    void tell(job().id, m);
    setMsg("");
  };
  return (
    <aside class="cv-drawer" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      {/* the title (two lines at most) with open / close on its first row; the task's actions on the row under it */}
      <header class="cv-dr-head">
        <div class="cv-dr-name">
          <StatusGlyph t={job()} />
          <span class="cv-dr-title" ref={titleEl} title={job().title}>{job().title}</span>
        </div>
        <div class="cv-dr-win">
          <button class="icon-btn sm cv-dr-open" title={t("작업 열기 (⏎)")} aria-label={t("작업 열기")} onClick={() => openTask(job().id)}>
            <Icon name="external" size={14} />
          </button>
          <button class="icon-btn sm" title={t("닫기 (Esc)")} aria-label={t("닫기")} onClick={props.onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <Show when={(job().status === "failed" || job().status === "paused" || job().status === "queued" || review()) && !discarded(job())}>
          <div class="cv-dr-tools">
            {/* the same actions the task view and the board give it */}
            <Show when={job().status === "failed"}>
              <button class="btn primary sm cv-dr-retry" onClick={() => void resumeTask(job().id)}>
                <Icon name="refresh" size={14} />
                {t("다시 시도")}
              </button>
            </Show>
            <Show when={job().status === "paused"}>
              <button class="btn primary sm" onClick={() => void resumeTask(job().id)}>
                <Icon name="play" size={14} />
                {t("다시 시작")}
              </button>
            </Show>
            <Show when={job().status === "queued"}>
              <button class="btn primary sm" onClick={() => void startTask(job().id)}>
                <Icon name="play" size={14} />
                {t("지금 시작")}
              </button>
            </Show>
          </div>
        </Show>
      </header>
      <div class="cv-dr-body">
        <Show
          when={ended() && outcome().text}
          fallback={
            <div class="cv-dr-now">
              <StatusRow t={job()} sheet aside={queued() ? ahead() : undefined} label={nowInRow() ? nowLine() : undefined} />
              <Show when={queued() && asked()}><p class="cv-dr-ask">{asked()}</p></Show>
              {/* a job waiting on the user is answered right here */}
              <Show
                when={decisionFor(job().id)}
                fallback={
                  <Show
                    when={job().status === "running" && liveMode(job()) === "act"}
                    // a card's words that are only the request: the 요청 section below says it in full
                    fallback={<Show when={!(asked() && liveMode(job()) === "summary" && !job().summary && !job().error)}><Live t={job()} /></Show>}
                  >
                    <Show when={nowLine() && !nowInRow()}><p class="cv-dr-line">{nowLine()}</p></Show>
                  </Show>
                }
              >
                {(dec) => <DecisionCard d={dec()} />}
              </Show>
            </div>
          }
        >
          <div class="cv-dr-now">
            <StatusRow t={job()} sheet />
            <Markdown class="cv-dr-result" text={outcome().text} />
            {/* what the card's "확인 안 됨" badge stands for */}
            <Show when={unchecked(job())}>
              <p class="cv-dr-unverified">
                <Icon name="alert" size={14} />
                <span>{t("확인 안 됨")} · {job().unverified!.join(" · ")}</span>
              </p>
            </Show>
          </div>
          <Show when={outcome().proof.length}>
            <section>
              <h4>{t("근거")}</h4>
              <ul class="cv-dr-steps">
                <For each={outcome().proof}>
                  {(x) => (
                    <li class="link" onClick={(e) => (x.kind === "link" ? void openLink(x.ref, { event: e }) : openTask(job().id))} onContextMenu={x.kind === "link" ? linkMenu(x.ref) : undefined} title={x.ref}>
                      <span class={`cv-dr-ic`}><Icon name={x.kind === "link" ? "link" : x.kind === "shot" ? "monitor" : "file"} size={14} /></span>
                      <span class="cv-dr-step">{x.kind === "link" ? x.ref.replace(/^https?:\/\/(www\.)?/, "") : base(x.ref)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </Show>
        <Show when={request()}>
          <section>
            <h4>{t("요청")}</h4>
            <p class="cv-dr-ask">{request()}</p>
          </section>
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
            <ul class="cv-dr-steps cv-dr-acts">
              <For each={recent()}>
                {(e) => {
                  const s = () => said(e, job().status === "running");
                  /** a command reads as code (as on the card); everything else in the card's sans */
                  const cmd = () => !!s().cmd;
                  return (
                    <li classList={{ bad: e.tool.ok === false, open: !e.tool.endedAt && job().status === "running" }}>
                      <span class="cv-dr-ic"><Icon name={s().icon} size={14} /></span>
                      <span class="lb">{s().label}</span>
                      <Show when={s().target}><span class="tg" classList={{ cmd: cmd() }} title={s().target}>{s().target}</span></Show>
                    </li>
                  );
                }}
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
                    <span class="cv-dr-step">{taskTitle(k)}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        {/* what it changed, file by file (a file opens in the task's changes) */}
        <Show when={files().length}>
          <section>
            <h4>{t("변경")}</h4>
            <ul class="cv-dr-steps">
              <For each={files()}>
                {(f) => <FileRow path={f.path} add={f.add} del={f.del} onOpen={() => (openTask(job().id), openPanel("changes", f.path))} />}
              </For>
            </ul>
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
  const focused = usePaneFocused();
  const space = () => state.space;
  const [vpSize, setVpSize] = createSignal({ w: 800, h: 600 });
  onMount(() => remeasure(0));
  // the order is taken when the canvas opens and when the workspace changes
  createEffect(on(space, (sp) => untrack(() => snapRanks(sp))));
  const graph = createMemo(() => layout(space(), unfolded(), sizeAt(), twoCols()));
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
    // nothing picked, or the picked card has left the canvas (merged or discarded into a fold)
    if (!id || !byId().has(id)) return null;
    const keep = new Set<string>([id]);
    const up = new Map(graph().edges.map((e) => [e.to, e.from]));
    for (let x = up.get(id); x; x = up.get(x)) keep.add(x);
    const walk = (x: string) => graph().edges.forEach((e) => e.from === x && !keep.has(e.to) && (keep.add(e.to), walk(e.to)));
    walk(id);
    return keep;
  });
  const dim = (id: string) => !!lineage() && !lineage()!.has(id);
  // the picked card was folded away (merged, discarded): nothing stays picked, nothing dimmed
  createEffect(() => {
    const id = sel();
    if (id && !byId().has(id)) setSel(undefined);
  });
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
  /** `fx`: how long the fade along its right edge is (the sheet's edge when it's open) */
  type Area = { w: number; h: number; fx: number };
  /** the part of the view no sheet covers (the sheet's width and inset: see .cv-drawer) */
  const area = (sheet: boolean, v = vpSize()): Area => ({ w: sheet ? v.w - 8 - sheetW(v.w) : v.w, h: v.h, fx: sheet ? SHEET_FADE : FADE });
  /** card `n` is whole in area `a` at zoom `z`, clear of the fades (the air may have given way) */
  const fitsIn = (n: Node, a: Area, z: number) => n.w * z <= a.w - a.fx - 8 + 0.5 && n.h * z <= a.h - FAR + 0.5;
  /** the least move of `p` that puts card `n` whole in area `a` (its top and left first when it can't be) */
  const reveal = (n: Node, z: number, p: P, a: Area): P => {
    const along = (lo: number, len: number, off: number, L: number, fade: number) => {
      const { lead, tail } = airFor(L - len * z, fade);
      const end = (lo + len) * z + off;
      if (end > L - tail) off -= end - (L - tail);
      return lo * z + off < lead ? lead - lo * z : off;
    };
    return { x: along(n.x, n.w, p.x, a.w, a.fx), y: along(n.y, n.h, p.y, a.h, FADE) };
  };
  /** the card nearest the middle of area `a` (of those `keep` lets through) */
  const nearest = (ns: Node[], z: number, p: P, a: Area, keep: (n: Node) => boolean = () => true) => {
    let best: Node | undefined, far = Infinity;
    for (const n of ns) {
      if (!keep(n)) continue;
      const l = n.x * z + p.x, t = n.y * z + p.y, r = l + n.w * z, b = t + n.h * z;
      // how far the middle is from the card, then from the card's own middle
      const d = Math.hypot(Math.max(l - a.w / 2, 0, a.w / 2 - r), Math.max(t - a.h / 2, 0, a.h / 2 - b)) * 1e4 + Math.hypot((l + r - a.w) / 2, (t + b - a.h) / 2);
      if (d < far) (far = d), (best = n);
    }
    return best;
  };
  /** the cards at zoom `z` (their words measured at that size) */
  const at = (z: number) => layout(space(), unfolded(), sizeOf(z)).nodes;
  /** the zoom at or under `z`, on the ladder, at which card `id` is whole beside the sheet */
  const roomFor = (id: string, z: number, a: Area) => {
    for (const s of [z, ...[...LADDER].reverse().filter((s) => s < z - 0.001)]) {
      const n = at(s).find((x) => x.id === id);
      if (!n || fitsIn(n, a, s)) return s;
    }
    return LADDER[0];
  };
  /** move the view to `next`, gliding (unless motion is reduced) */
  const panTo = (next: P, z = zoom()) => {
    const p = pan();
    if (Math.abs(next.x - p.x) < 0.5 && Math.abs(next.y - p.y) < 0.5 && Math.abs(z - zoom()) < 0.001) return;
    if (vp && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      vp.classList.add("glide");
      clearTimeout(glideTimer);
      glideTimer = setTimeout(() => vp?.classList.remove("glide"), 260);
    }
    batch(() => {
      setZoom(z);
      setPan(next);
    });
  };
  let glideTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(glideTimer));
  /** the picked task card, when it's on the canvas (its sheet is open) */
  const picked = () => {
    const id = sel();
    const n = id ? byId().get(id) : undefined;
    return n?.task ? n : undefined;
  };
  /**
   * Zoom to `z` about card `id` (its middle stays where it is on screen). A picked card then ends whole
   * beside the sheet, the zoom going down the ladder until it can.
   */
  const zoomAbout = (z: number, id: string | undefined, asked = true) => {
    const pk = picked(), a = area(!!pk), z0 = zoom(), p0 = pan();
    if (asked) want = z;
    if (pk) z = roomFor(pk.id, z, a);
    const ns = at(z), was = id ? byId().get(id) : undefined, n = id ? ns.find((x) => x.id === id) : undefined;
    const cx = was ? (was.x + was.w / 2) * z0 + p0.x : a.w / 2, cy = was ? (was.y + was.h / 2) * z0 + p0.y : a.h / 2;
    const wx = n ? n.x + n.w / 2 : (cx - p0.x) / z0, wy = n ? n.y + n.h / 2 : (cy - p0.y) / z0;
    let p = { x: cx - wx * z, y: cy - wy * z };
    const keep = pk && ns.find((x) => x.id === pk.id);
    if (keep) p = reveal(keep, z, p, a);
    panTo(p, z);
  };
  /**
   * Pick a task card: its sheet opens and the view moves as little as it can to show the card whole beside it.
   * The view from before the first pick is kept, to go back to when the sheet closes.
   */
  const pick = (n: Node) => {
    if (!picked() && vp) {
      const z = zoom(), p = pan(), m = nearest(graph().nodes, z, p, area(false));
      before = { z, p, id: m?.id, sx: m ? m.x * z + p.x : 0, sy: m ? m.y * z + p.y : 0 };
    }
    setSel(n.id);
    if (!vp) return;
    const a = area(true);
    if (roomFor(n.id, zoom(), a) < zoom() - 0.001) return zoomAbout(zoom(), n.id, false);
    panTo(reveal(n, zoom(), pan(), a));
  };
  /** The sheet closed: back to the view from before the pick, unless the person has moved it since. */
  const goBack = () => {
    const b = before;
    before = undefined;
    if (!b || !vp) return;
    // the card that was nearest the middle goes back where it was (the cards may have moved meanwhile)
    const n = b.id ? at(b.z).find((x) => x.id === b.id) : undefined;
    const p = n ? reveal(n, b.z, { x: b.sx - n.x * b.z, y: b.sy - n.y * b.z }, area(false)) : b.p;
    panTo(p, b.z);
  };
  /** the card a fold or unfold keeps in place (the fold that was pressed) */
  let holdOn: string | undefined;
  /** Fold or unfold finished jobs: they slide into (or out of) the project's "끝난 일" card. */
  const fold = (next: string[], by?: string) => {
    holdOn = by;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return void setUnfolded(next);
    const before = graph().nodes;
    const after = layout(space(), next).nodes;
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

  /** the view has been framed once (before that, nothing is kept) */
  let framed = false;
  /** the zoom the person (or a frame) chose: a picked card may have taken the view under it for now */
  let want = 1;
  /** the view before the sheet opened, to go back to on close (dropped once the person pans or zooms) */
  let before: { z: number; p: P; id?: string; sx: number; sy: number } | undefined;
  /** a press on the background is under way (it closed the sheet; going back waits for its end) */
  let pressing = false;
  /**
   * A frame (the first view, the % button, 다시 정렬): the largest step from 100% down to 75% (`all`:
   * 50%) that holds every card, top-aligned with the air, centred across when it fits across. When
   * none holds it all: that lowest step, from the top of the lanes (the lane that needs the person most
   * comes first), and the first card that needs the person (a reply, failed, running, review, paused)
   * whole in view. A picked card stays whole beside its sheet.
   */
  const fit = (animate = true, all = false) => {
    if (!vp || !graph().nodes.length) return;
    const r = { w: vp.clientWidth, h: vp.clientHeight };
    if (!r.w || !r.h) return;
    framed = true;
    const pk = picked();
    const a = area(!!pk, r);
    const floor = all ? FLOOR_ZOOM : READ_ZOOM;
    const steps = LADDER.filter((z) => z <= 1 && z >= floor).reverse();
    /** every card, and the line over the top of a first column */
    const box = (ns: Node[]) => {
      const b = boxOf(ns);
      return twoCols() ? { ...b, y0: b.y0 - BUS } : b;
    };
    /** the room left around everything at `z` */
    const slack = (z: number) => {
      const b = box(at(z));
      return { x: a.w - (b.x1 - b.x0) * z, y: a.h - (b.y1 - b.y0) * z };
    };
    // the largest step that holds it all with the air; else (fit-all) one that holds it all once the air gives way
    let z =
      steps.find((z) => slack(z).x >= ROOM + FAR && slack(z).y >= ROOM + FAR) ??
      (all ? steps.find((z) => slack(z).x >= 0 && slack(z).y >= 0) : undefined) ??
      floor;
    want = z;
    if (pk) z = roomFor(pk.id, z, a);
    const ns = at(z), b = box(ns), s = slack(z);
    // across: centred when it all fits (in what air there is), else from Main at the left
    const across = s.x >= 0, down = s.y >= 0;
    let p = { x: across ? s.x / 2 - b.x0 * z : ROOM - b.x0 * z, y: (down ? Math.min(ROOM, s.y / 2) : ROOM) - b.y0 * z };
    /** a card shown whole: only along what doesn't already hold everything */
    const show = (n: Node) => {
      const q = reveal(n, z, p, a);
      p = { x: across ? p.x : q.x, y: down ? p.y : q.y };
    };
    const rank = (n: Node) => (n.kind === "job" && n.task ? FIRST.indexOf(tone(n.task)) : -1);
    const first = ns.filter((n) => rank(n) >= 0).sort((m, n) => rank(m) - rank(n) || m.y - n.y)[0];
    if (first) show(first);
    const keep = pk && ns.find((n) => n.id === pk.id);
    if (keep) show(keep);
    if (animate) panTo(p, z);
    else batch(() => (setZoom(z), setPan(p)));
  };

  /** ctrl-wheel: about the pointer (a picked card stays whole beside the sheet) */
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const z0 = zoom(), p = pan(), pk = picked(), a = area(!!pk);
    let z = Math.min(2, Math.max(0.3, z0 * factor));
    want = z;
    if (pk) z = Math.min(z, (a.w - a.fx - 8) / pk.w, (a.h - FAR) / pk.h);
    const q = { x: cx - ((cx - p.x) * z) / z0, y: cy - ((cy - p.y) * z) / z0 };
    batch(() => {
      setZoom(z);
      setPan(pk ? reveal(pk, z, q, a) : q);
    });
  };

  /** one step along the ladder, about the picked card (or the card nearest the middle) */
  /** the next step in (none at the top, or when a picked card wouldn't be whole beside its sheet there) */
  const stepIn = () => {
    const z0 = zoom(), z = LADDER.find((s) => s > z0 + 0.001), pk = picked();
    return z && (!pk || roomFor(pk.id, z, area(true)) > z0 + 0.001) ? z : undefined;
  };
  const step = (dir: 1 | -1) => {
    const z0 = zoom();
    const z = dir > 0 ? stepIn() : [...LADDER].reverse().find((s) => s < z0 - 0.001);
    if (!z) return;
    before = undefined;
    const pk = picked();
    zoomAbout(z, pk?.id ?? nearest(graph().nodes, z0, pan(), area(!!pk))?.id);
  };
  /** 100% */
  const actual = () => {
    before = undefined;
    const pk = picked();
    zoomAbout(1, pk?.id ?? nearest(graph().nodes, zoom(), pan(), area(!!pk))?.id);
  };
  /** the % button: a click shows everything, a double click goes to 100% */
  let pctTimer: ReturnType<typeof setTimeout> | undefined;
  const onPct = (e: MouseEvent) => {
    clearTimeout(pctTimer);
    before = undefined;
    if (e.detail >= 2) return actual();
    pctTimer = setTimeout(() => fit(true, true), 220);
  };
  onCleanup(() => clearTimeout(pctTimer));

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    before = undefined;
    const r = vp!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  };

  /** a press on the background: it closes the sheet, and may go on into a pan */
  const onBgDown = (e: PointerEvent) => {
    if (!vp || e.button !== 0 || (e.target as HTMLElement).closest(".cv-node, .cv-ctrl, .cv-drawer, .cv-mini, button")) return;
    const el = vp;
    // the sheet closes now; the view goes back (see goBack) once the press turns out not to be a pan
    pressing = true;
    setSel(undefined);
    const start = { x: e.clientX, y: e.clientY, p: pan() };
    let moved = false;
    el.setPointerCapture(e.pointerId);
    el.classList.add("grabbing");
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      before = undefined;
      setPan({ x: start.p.x + ev.clientX - start.x, y: start.p.y + ev.clientY - start.y });
    };
    const up = () => {
      pressing = false;
      if (!moved && !picked()) goBack();
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
      // a card the person put somewhere stays where they put it: the camera doesn't chase it
      if (moved && d) dropped = true;
      if (moved && d) setState("canvas", (c) => ({ ...(c ?? {}), [`${space()}:${n.id}`]: { x: Math.round(d.x), y: Math.round(d.y) } }));
      setDrag(null);
      if (moved) return;
      if (n.kind === "main") goMain();
      // a lane is picked (새 작업 then lands in it); a double click opens its project
      else if (n.kind === "proj") setSel(sel() === n.id ? undefined : n.id);
      else if (n.kind === "more") {
        const id = n.project!.id;
        fold(unfolded().includes(id) ? unfolded().filter((x) => x !== id) : [...unfolded(), id], n.id);
      }
      else pick(n);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  /** Put every card back in line (drops where they were dragged to). */
  const resetLayout = () => {
    before = undefined;
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
    if (!viewKey(e) || !focused() || e.metaKey || e.ctrlKey || e.altKey || mode() !== "canvas") return;
    if (e.shiftKey && e.code === "Digit1") (e.preventDefault(), (before = undefined), fit(true, true));
    else if (e.shiftKey && e.code === "Digit0") (e.preventDefault(), actual());
    else if (!e.metaKey && (e.key === "=" || e.key === "+")) step(1);
    else if (!e.metaKey && e.key === "-") step(-1);
    else if (!e.shiftKey && e.key === "Enter" && sel()) (e.preventDefault(), openSel());
    else if (!e.shiftKey && e.key === "Escape" && sel()) (e.preventDefault(), e.stopPropagation(), setSel(undefined));
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  /** where a line leaves or meets a card: beside its first line (the middle of a short card) */
  const port = (n: Node) => pos(n).y + Math.min(n.h / 2, H.main / 2);
  /**
   * The line from a card to one it leads to, drawn as a bracket: out to a spine halfway
   * between the columns, down it, and in at the card. Lines to cards of one column share
   * the spine; each draws only its own stretch of it (from the card above), so the
   * stretch takes the tone of the card it leads to and nothing is drawn twice.
   * `whole`: the full route from the source (a picked card's line).
   */
  const edgePath = (e: Edge, whole = false) => {
    const a = byId().get(e.from), b = byId().get(e.to);
    if (!a || !b) return "";
    const pa = pos(a), pb = pos(b);
    /** the nearest card above `b` in the same column that `a` also leads to */
    const above = (y2: number, x: number, min: number) => {
      if (whole) return undefined;
      let best: number | undefined;
      for (const o of graph().edges) {
        if (o.from !== e.from || o.to === e.to) continue;
        const c = byId().get(o.to);
        if (!c || Math.abs(pos(c).x - x) > 1) continue;
        const cy = c.kind === "sub" || c.kind === "more" ? pos(c).y + c.h / 2 : port(c);
        if (cy < y2 - 1 && cy >= min && (best === undefined || cy > best)) best = cy;
      }
      return best;
    };
    // a sub-job sits under its job: drop down from the job's left edge
    if (pb.x < pa.x + a.w && pb.y >= pa.y + a.h) {
      const x = pa.x + SUB_INDENT / 2, y2 = pb.y + b.h / 2;
      const prev = above(y2, pb.x, pa.y + a.h);
      const y1 = prev !== undefined ? prev - 10 : pa.y + a.h;
      const r = Math.min(10, (y2 - y1) / 2);
      return `M ${x} ${y1} L ${x} ${y2 - r} Q ${x} ${y2}, ${x + r} ${y2} L ${pb.x} ${y2}`;
    }
    const x1 = pa.x + a.w, y1 = port(a), x2 = pb.x, y2 = port(b);
    // to a lane in the second column: up from Main's spine, over the top of the first column, down its gutter
    if (e.over && x2 - x1 > GAP.lanes) {
      const s0 = x1 + (X.proj - X.main - W.main) / 2, s1 = x2 - GAP.lanes / 2, r = 10;
      const top = Math.min(...graph().nodes.map((n) => pos(n).y)) - BUS;
      const down = `L ${s1} ${y2 - r} Q ${s1} ${y2}, ${s1 + r} ${y2} L ${x2} ${y2}`;
      const prev = above(y2, pb.x, -Infinity);
      if (prev !== undefined) return `M ${s1} ${prev - 10} ${down}`;
      const up = whole ? `M ${x1} ${y1} L ${s0 - r} ${y1} Q ${s0} ${y1}, ${s0} ${y1 - r}` : `M ${s0} ${y1}`;
      return `${up} L ${s0} ${top + r} Q ${s0} ${top}, ${s0 + r} ${top} L ${s1 - r} ${top} Q ${s1} ${top}, ${s1} ${top + r} ${down}`;
    }
    if (x2 - x1 < 32) {
      const dx = Math.max(40, (x2 - x1) / 2);
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }
    if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const sx = Math.round((x1 + x2) / 2), dir = Math.sign(y2 - y1);
    const from = dir > 0 ? above(y2, pb.x, y1) : undefined;
    const r = Math.min(10, Math.abs(y2 - (from ?? y1)) / 2, (x2 - x1) / 4);
    const into = `L ${sx} ${y2 - dir * r} Q ${sx} ${y2}, ${sx + r} ${y2} L ${x2} ${y2}`;
    // from the card above's corner, so the spine runs on without a break
    // (never above the source's own line: a straight line has no corner to run on from)
    if (from !== undefined) return `M ${sx} ${Math.max(from - 10, y1)} ${into}`;
    return `M ${x1} ${y1} L ${sx - r} ${y1} Q ${sx} ${y1}, ${sx} ${y1 + dir * r} ${into}`;
  };
  /** a picked card's lines are drawn last, over the shared spines */
  const hot = (e: Edge) => !!lineage() && lineage()!.has(e.to) && lineage()!.has(e.from);

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
    const size = () => setVpSize({ w: el.clientWidth, h: el.clientHeight });
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);
    // shown (opened, or back from the board): framed as on first open
    const id = requestAnimationFrame(() => fit(false));
    onCleanup(() => (ro.disconnect(), cancelAnimationFrame(id), (framed = false)));
  });
  // lanes go into two columns while the view holds both at the first view's zoom
  createEffect(() => setTwoCols(vpSize().w >= (COL + X.job + W.job) * READ_ZOOM + ROOM + FAR));
  /** what was on screen at the last change: the cards, their size step, the view's size, the picked card */
  let last: { s: string; at: Map<string, Node>; k: number; v: { w: number; h: number }; pid?: string } | undefined;
  /** a card was just dragged: the camera doesn't chase it */
  let dropped = false;
  /** where the cards are (a running card's words change often; its place and size seldom do) */
  const shape = createMemo(() => graph().nodes.map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)},${n.w},${n.h}`).join("|"));
  /**
   * Whatever moves under a still camera (a card answered, paused, finishing or growing, a fold, the
   * window or the sheet changing size) keeps what the person was looking at where it is on screen: the
   * picked card, else the card nearest the middle of the view. Nothing else is solved for; a picked
   * card still ends whole beside the sheet.
   */
  createEffect(
    on([shape, vpSize, () => picked()?.id], ([s, v, pid]) => {
      const prev = last;
      last = { s, at: new Map(untrack(() => graph().nodes).map((n) => [n.id, n])), k: untrack(sizeAt), v, pid };
      // the fold that was pressed holds until the cards have moved
      const by = holdOn;
      if (prev?.s !== s) holdOn = undefined;
      // nothing moved (the cards were laid out again, the same)
      if (!prev || !framed || (prev.s === s && prev.v === v && prev.pid === pid)) return;
      if (dropped) return void (dropped = false);
      // a zoom step or a pick placed the view itself
      if (prev.k !== last.k || (pid && pid !== prev.pid)) return;
      // the sheet closed (Esc, ✕, merged, discarded): back to the view from before the pick
      if (prev.pid && !pid && before) return void (pressing || untrack(goBack));
      const now = last.at;
      untrack(() => {
        const z = zoom(), p = pan();
        const id = pid && prev.at.has(pid) ? pid : by && prev.at.has(by) && now.has(by) ? by : nearest([...prev.at.values()], z, p, area(!!prev.pid, prev.v), (n) => now.has(n.id))?.id;
        const was = id ? prev.at.get(id) : undefined, is = id ? now.get(id) : undefined;
        if (!was || !is) return;
        let q = { x: p.x + (was.x - is.x) * z, y: p.y + (was.y - is.y) * z };
        const a = area(!!pid, v);
        if (pid) {
          // the zoom it would be at for the view's size now, whatever sizes it went through on the way
          const fit = roomFor(pid, v !== prev.v ? Math.max(z, want) : z, a);
          if (Math.abs(fit - z) > 0.001) return (setPan(q), zoomAbout(fit, pid, false));
          q = reveal(is, z, q, a);
        } else if (v !== prev.v) {
          // a resize: a card that was whole stays whole
          const a0 = area(!!prev.pid, prev.v);
          const whole = was.x * z + p.x >= -0.5 && was.y * z + p.y >= -0.5 && (was.x + was.w) * z + p.x <= a0.w + 0.5 && (was.y + was.h) * z + p.y <= a0.h + 0.5;
          if (whole && fitsIn(is, a, z)) q = reveal(is, z, q, a);
        }
        if (Math.abs(q.x - p.x) > 0.5 || Math.abs(q.y - p.y) > 0.5) setPan(q);
      });
    }),
  );
  /** the map only helps when there's room to spare */
  /** everything is already in view: the map would only cover a card */
  const allInView = () => {
    const ns = graph().nodes;
    if (!ns.length) return true;
    const z = zoom(), p = pan(), v = vpSize();
    return ns.every((n) => { const q = pos(n); const x = q.x * z + p.x, y = q.y * z + p.y; return x >= 0 && y >= 0 && x + n.w * z <= v.w && y + n.h * z <= v.h; });
  };
  const roomy = () => vpSize().w >= 640 && vpSize().h >= 460 && !allInView();
  /**
   * The edges a card runs off (left, right or the sheet's edge, bottom): only those fade. `off`: the cards
   * past the left edge or mostly past the right one, whose words would only show as a fragment ("ondr"):
   * they show as a card and its line, without words.
   */
  const fades = createMemo(() => {
    const z = zoom(), p = pan(), a = area(!!selTask());
    const f = { l: false, r: false, b: false, off: new Set<string>() };
    for (const n of graph().nodes) {
      const q = pos(n), x0 = q.x * z + p.x, y0 = q.y * z + p.y, x1 = x0 + n.w * z, y1 = y0 + n.h * z;
      if (x1 <= 0 || x0 >= a.w || y1 <= 0 || y0 >= a.h) continue;
      f.l ||= x0 < 0;
      f.r ||= x1 > a.w;
      f.b ||= y1 > a.h;
      // past the left edge, the words lose their start; past the right, only once most of it is gone
      if (x0 < -8 || Math.min(x1, a.w) - x0 < n.w * z * 0.6) f.off.add(n.id);
    }
    return f;
  }, undefined, { equals: (a, b) => !!a && a.l === b.l && a.r === b.r && a.b === b.b && [...a.off].join() === [...b.off].join() });
  /** the part of the map in view, inside the map's frame (none when the view is off the cards) */
  const miniView = () => {
    const b = bounds(), z = zoom(), p = pan(), a = area(!!picked());
    // a map pixel in world units: the frame's stroke stays inside the map
    const k = Math.max(b.w / 136, b.h / 84);
    const x0 = Math.max(b.x + k, -p.x / z), y0 = Math.max(b.y + k, -p.y / z);
    const x1 = Math.min(b.x + b.w - k, (a.w - p.x) / z), y1 = Math.min(b.y + b.h - k, (a.h - p.y) / z);
    return x1 - x0 > 1 && y1 - y0 > 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
  };
  /** the minimap is there when asked for (it would sit on cards otherwise) */
  const [mini, setMini] = createSignal(false);
  /** the legend's words go only when they don't fit the header (the glyph, count and tooltip stay) */
  const [bare, setBare] = createSignal(false);
  let legendEl: HTMLSpanElement | undefined;
  let headEl: HTMLElement | undefined;
  const fitLegend = () => {
    if (!legendEl?.isConnected) return;
    setBare(false);
    setBare(legendEl.scrollWidth > legendEl.clientWidth + 0.5);
  };
  createEffect(on([counts, lang, mode], () => queueMicrotask(fitLegend)));
  onMount(() => {
    if (!headEl) return;
    const ro = new ResizeObserver(fitLegend);
    ro.observe(headEl);
    onCleanup(() => ro.disconnect());
  });
  /** nothing in this workspace yet: a quiet empty state instead of a lone Main card */
  const empty = () => !state.tasks.some((x) => x.space === space() && !x.parentId && !x.answer && !x.archived);

  return (
    <div class="view canvas-view">
      <header class="head" data-tauri-drag-region ref={headEl}>
        <SidebarToggle />
        {/* the page's two views, by name: the toggle is the title */}
        <div class="cv-mode" role="tablist" aria-label={t("캔버스")}>
          <button role="tab" aria-selected={mode() === "canvas"} classList={{ on: mode() === "canvas" }} onClick={() => setMode("canvas")}>
            {t("캔버스")}
          </button>
          <button role="tab" aria-selected={mode() === "list"} classList={{ on: mode() === "list" }} onClick={() => setMode("list")}>
            {t("보드")}
          </button>
        </div>
        <Show when={mode() === "canvas"}>
        {/* the legend draws each state with the sidebar's glyph, so running and review read apart */}
        <span class="board-sum cv-legend" classList={{ bare: bare() }} ref={legendEl}>
          <For each={LEGEND}>
            {(l) => (
              <Show when={counts()[l.tone]}>
                <span title={`${t(l.label)} ${counts()[l.tone]}`}><StateGlyph g={l.g} /><span class="lb">{t(l.label)}</span> <b>{counts()[l.tone]}</b></span>
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
        <PaneControls />
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
          >
            <DotGrid pan={pan()} zoom={zoom()} on={grid()} />
            {/* the cards fade out along the bottom and right edges (and the sheet's), so one running off reads as more beyond */}
            <div class="cv-layer" style={{ "--cv-sheet": selTask() ? `${sheetW(vpSize().w) + 8}px` : "0px", "--cv-fl": fades().l ? `${ROOM}px` : "0px", "--cv-fr": fades().r ? `${selTask() ? SHEET_FADE : FADE}px` : "0px", "--cv-fb": fades().b ? `${FADE}px` : "0px" }}>
            <div class="cv-world" style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`, "--cv-z": String(zoom()) }}>
              <svg class="cv-edges" width="1" height="1">
                <defs>
                  <marker id="cv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0.5 L 7 4 L 0 7.5" class="cv-arrow" />
                  </marker>
                </defs>
                <For each={[...graph().edges].sort((p, q) => +hot(p) - +hot(q))}>
                  {(e) => (
                    <g class={`cv-edge t-${e.tone}${hot(e) ? " hot" : !!lineage() ? " dim" : ""}`} style={{ opacity: fade()?.[e.to] }}>
                      <path d={edgePath(e, hot(e))} marker-end="url(#cv-arrow)" />
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
                    // one class string (a class beside a classList would drop sel / dim when the tone changes)
                    class={`cv-node cv-${n.kind}${node().task ? ` t-${tone(node().task!)}` : ""}${sel() === n.id ? " sel" : ""}${drag()?.id === n.id ? " dragging" : ""}${dim(n.id) ? " dim" : ""}${fades().off.has(n.id) ? " off" : ""}`}
                    style={{ left: `${pos(node()).x}px`, top: `${pos(node()).y}px`, width: `${node().w}px`, height: node().hug ? "auto" : `${node().h}px`, "max-height": `${node().h}px`, opacity: fade()?.[n.id] }}
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
                setPan({ x: vpSize().w / 2 - w.x * zoom(), y: vpSize().h / 2 - w.y * zoom() });
              }}
            >
              <For each={graph().nodes}>{(n) => <rect class={n.task ? `t-${tone(n.task)}` : `k-${n.kind}`} x={pos(n).x} y={pos(n).y} width={n.w} height={n.h} rx={12} />}</For>
              <Show when={miniView()}>{(r) => <rect class="cv-mini-vp" x={r().x} y={r().y} width={r().w} height={r().h} rx={8} />}</Show>
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
              <button title={t("축소 (−)")} aria-label={t("축소")} disabled={zoom() <= LADDER[0] + 0.001} onClick={() => step(-1)}><Icon name="minus" size={14} /></button>
              <button class="cv-zoom" title={t("전체 보기 (⇧1) · 100% (⇧0)")} aria-label={t("전체 보기")} onClick={onPct}>{Math.round(zoom() * 100)}%</button>
              <button title={t("확대 (+)")} aria-label={t("확대")} disabled={!stepIn()} onClick={() => step(1)}><Icon name="plus" size={14} /></button>
              <i class="cv-ctrl-sep" />
              <button title={t("다시 정렬")} aria-label={t("다시 정렬")} onClick={resetLayout}><Icon name="tidy" size={14} /></button>
              {/* always in place (off when there is nothing to do), so the strip never shifts */}
              <button title={allOpen() ? t("완료된 작업 모두 접기") : t("완료된 작업 모두 펼치기")} aria-label={allOpen() ? t("완료된 작업 모두 접기") : t("완료된 작업 모두 펼치기")} classList={{ on: allOpen() }} disabled={!foldable().length} onClick={() => fold(allOpen() ? [] : foldable())}>
                {allOpen() ? <ChevronsDownUp size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" /> : <ChevronsUpDown size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" />}
              </button>
              <button title={mini() ? t("미니맵 숨기기") : t("미니맵 표시")} aria-label={mini() ? t("미니맵 숨기기") : t("미니맵 표시")} aria-pressed={mini()} classList={{ on: mini() }} disabled={!roomy() && !mini()} onClick={() => setMini(!mini())}>
                <MapIcon size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" />
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export const openCanvas = () => setView({ name: "board" });
