// The flow, drawn like a git graph: main is the trunk; every job branches off it
// when main hands it out, runs as its own line (jobs running at once are lines
// side by side) and joins the trunk again when merged. Subagents hang off their
// job on a dotted twig. Newest on top. Lives in the right panel's 흐름 tab.
import { createMemo, createSignal, For, Show } from "solid-js";
import { state, taskById, tasksIn } from "../state/store";
import type { Task } from "../state/types";
import { goMain, hoverTask, openTask, setHoverTask, view } from "../state/ui";
import { ago, compact, now } from "../ui/bits";
import { line, plain } from "../ui/ForkCard";
import { Icon } from "../ui/Icon";
import { bucket, changes } from "./Sidebar";

const openId = () => {
  const v = view();
  return v.name === "task" ? v.id : undefined;
};
const openRoot = () => {
  let t = openId() ? taskById(openId()!) : undefined;
  while (t?.parentId) t = taskById(t.parentId);
  return t?.id;
};
const ended = (t: Task) => t.status === "done" && t.worktree?.state !== "open";
const DAY = 86_400_000;

// ───────────── the graph
const ROW = 46;
const SHORT = 32;
const KID = 28;
const TRUNK = 13;

interface Row {
  t: Task;
  kid: boolean;
  y: number;
  h: number;
}

export function Flow() {
  const [older, setOlder] = createSignal(false);
  const [kidsOpen, setKidsOpen] = createSignal<Record<string, boolean>>({});
  const roots = createMemo(() =>
    tasksIn(state.space)
      .filter((t) => !t.parentId && !t.answer)
      .sort((a, b) => b.createdAt - a.createdAt),
  );
  /** finished, merged and not from today: tucked away under "이전" */
  const old = (t: Task) => ended(t) && (t.finishedAt ?? t.createdAt) < now() - DAY && t.id !== openRoot();
  const shown = () => roots().filter((t) => older() || !old(t));
  const hiddenCount = () => roots().filter(old).length;

  // lanes: a job keeps its lane from the moment it starts until it is merged
  const lanes = createMemo(() => {
    const ends: number[] = [];
    const lane = new Map<string, number>();
    for (const t of [...shown()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (t.status === "queued") continue;
      const end = ended(t) ? (t.finishedAt ?? t.createdAt) : Infinity;
      let i = ends.findIndex((e) => e < t.createdAt);
      if (i < 0) i = ends.push(end) - 1;
      else ends[i] = end;
      lane.set(t.id, i);
    }
    return { lane, count: Math.max(1, ends.length) };
  });
  const gap = () => (lanes().count > 4 ? 10 : 13);
  // the newest lane sits next to the trunk, so a new branch crosses nothing
  const laneX = (id: string) => (lanes().lane.has(id) ? TRUNK + gap() * (lanes().count - lanes().lane.get(id)!) : TRUNK);
  const gutter = () => TRUNK + gap() * lanes().count + 12;

  const kidsOf = (t: Task) => state.tasks.filter((k) => k.parentId === t.id).sort((a, b) => a.createdAt - b.createdAt);
  const kidsShown = (t: Task) => {
    const k = kidsOf(t);
    if (!k.length) return [];
    const forced = kidsOpen()[t.id];
    const auto = openRoot() === t.id || k.some((x) => x.status === "waiting" || x.status === "failed");
    return forced ?? auto ? k : [];
  };

  /** one line is enough: it is already in 할 일 above, or has not started */
  const brief = (t: Task) => bucket(t) === "you" || bucket(t) === "review" || t.status === "queued" || ended(t);
  const rows = createMemo(() => {
    const out: Row[] = [];
    let y = 0;
    for (const t of shown()) {
      const h = brief(t) ? SHORT : ROW;
      out.push({ t, kid: false, y, h });
      y += h;
      for (const k of kidsShown(t)) {
        out.push({ t: k, kid: true, y, h: KID });
        y += KID;
      }
    }
    return out;
  });
  const height = () => {
    const r = rows();
    return r.length ? r[r.length - 1].y + r[r.length - 1].h : 0;
  };
  const cy = (r: Row) => r.y + (r.kid || r.h === SHORT ? r.h / 2 : 15);

  /** where a merged job joins the trunk: just above the first row older than its merge */
  const joinY = (t: Task) => {
    const f = t.finishedAt ?? t.createdAt;
    const r = rows().find((x) => !x.kid && x.t.createdAt <= f);
    return r ? Math.max(2, r.y - 4) : 2;
  };

  /** the trunk reaches the lowest fork (each job leaves it a little below its row) */
  const trunkEnd = () => {
    const tops = rows().filter((r) => !r.kid && r.t.status !== "queued").map((r) => cy(r) + 14);
    const last = rows()[rows().length - 1];
    return Math.max(last ? cy(last) : 0, ...tops);
  };
  const paths = createMemo(() => {
    const out: { d: string; cls: string }[] = [];
    for (const r of rows()) {
      if (r.kid) continue;
      const t = r.t;
      const x = laneX(t.id);
      const y = cy(r);
      if (t.status === "queued") continue;
      const tone = ended(t) ? "past" : bucket(t) === "you" ? "warn" : bucket(t) === "review" ? "ready" : "live";
      const cls = `${tone} ${t.id === openRoot() ? "on" : ""} ${hoverTask() === t.id ? "hot" : ""}`;
      // off the trunk
      out.push({ d: `M${TRUNK} ${y + 14} C${TRUNK} ${y + 4}, ${x} ${y + 10}, ${x} ${y}`, cls });
      // its own line, up to where it joins the trunk again (or to the top while it lives)
      if (ended(t)) {
        const j = joinY(t);
        out.push({ d: `M${x} ${y} L${x} ${j + 12} C${x} ${j + 4}, ${TRUNK} ${j + 8}, ${TRUNK} ${j}`, cls });
      } else out.push({ d: `M${x} ${y} L${x} 0`, cls });
      // subagents hang below on a thin twig
      const ks = rows().filter((k) => k.kid && k.t.parentId === t.id);
      if (ks.length) {
        const last = cy(ks[ks.length - 1]);
        out.push({ d: `M${x} ${y + 5} L${x} ${last - 5} Q${x} ${last}, ${x + 5} ${last}`, cls: `${cls} twig` });
        for (const k of ks.slice(0, -1)) {
          const ky = cy(k);
          out.push({ d: `M${x} ${ky - 5} Q${x} ${ky}, ${x + 5} ${ky}`, cls: `${cls} twig` });
        }
      }
    }
    return out;
  });

  const meta = (t: Task) => {
    if (t.status === "queued") return "대기";
    if (t.status === "paused") return "쉼";
    if (t.status === "done") return ago(t.finishedAt ?? t.createdAt);
    if (t.status === "waiting") return "답 필요";
    return t.startedAt ? compact(now() - t.startedAt) : "";
  };
  const sub = (t: Task) => {
    if (t.status === "done") {
      if (t.worktree?.state === "open") {
        const c = changes(t);
        return `+${c.add} −${c.del} · 확인 필요`;
      }
      return t.worktree?.state === "merged" ? "합쳤어요" : t.worktree?.state === "discarded" ? "버렸어요" : plain(t.summary ?? "") || "끝났어요";
    }
    return line(t);
  };

  return (
    <div class="graph" classList={{ "has-jobs": !!roots().length }} style={{ "--gutter": `${gutter()}px` }}>
      <button class="g-main" data-shortcut="main" onClick={() => goMain()} title="메인에게 말하기 (⌘0)" style={{ "--trunk": `${TRUNK}px` }}>
        <span class="g-main-node" style={{ left: `${TRUNK - 5}px` }} />
        <span class="g-name">메인</span>
        <Show when={state.captain.some((m) => m.space === state.space && m.pending)} fallback={<kbd class="g-kbd">⌘0</kbd>}>
          <span class="spin sm" />
        </Show>
      </button>
      <div class="g-body" style={{ height: `${height()}px` }}>
        <svg class="g-lines" classList={{ dim: !!hoverTask() }} width={gutter()} height={Math.max(1, height())} aria-hidden="true">
          <line class="g-trunk" x1={TRUNK} y1={0} x2={TRUNK} y2={trunkEnd()} />
          <For each={paths()}>{(p) => <path class={p.cls} d={p.d} pathLength={p.cls.includes("twig") ? undefined : 1} />}</For>
          <For each={rows()}>
            {(r) => (
              <circle
                class={`g-node ${r.t.status}`}
                classList={{ unmerged: r.t.status === "done" && r.t.worktree?.state === "open", kid: r.kid, on: openId() === r.t.id }}
                cx={r.kid ? laneX(r.t.parentId!) + 8 : laneX(r.t.id)}
                cy={cy(r)}
                r={r.kid ? 3 : 4.5}
              />
            )}
          </For>
        </svg>
        <For each={rows()}>
          {(r) => (
            <button
              class="g-row"
              classList={{ kid: r.kid, on: openId() === r.t.id, hot: hoverTask() === r.t.id, past: ended(r.t), you: !r.kid && bucket(r.t) === "you" }}
              style={{ top: `${r.y}px`, height: `${r.h}px`, "padding-left": `${r.kid ? gutter() + 12 : gutter()}px` }}
              onClick={() => openTask(r.t.id)}
              onMouseEnter={() => setHoverTask(r.kid ? r.t.parentId! : r.t.id)}
              onMouseLeave={() => setHoverTask(null)}
              title={r.t.title}
            >
              <span class="g-line1">
                <span class="g-name">{r.t.title}</span>
                <Show when={!r.kid && r.t.browser && r.t.status === "running"}><Icon name="globe" size={11} class="g-badge" /></Show>
                <Show when={!r.kid && r.h !== ROW && kidsOf(r.t).length}>
                  <span
                    class="g-kids"
                    role="button"
                    title={`서브에이전트 ${kidsOf(r.t).length}개`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setKidsOpen({ ...kidsOpen(), [r.t.id]: !kidsShown(r.t).length });
                    }}
                  >
                    서브 {kidsOf(r.t).length}
                  </span>
                </Show>
                <span class="g-meta">{meta(r.t)}</span>
              </span>
              <Show when={!r.kid && r.h === ROW}>
                <span class="g-line2-wrap">
                  <span class="g-line2" classList={{ bad: r.t.status === "failed" }}>{sub(r.t)}</span>
                  <Show when={kidsOf(r.t).length}>
                    <span
                      class="g-kids"
                      role="button"
                      title={`서브에이전트 ${kidsOf(r.t).length}개`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setKidsOpen({ ...kidsOpen(), [r.t.id]: !kidsShown(r.t).length });
                      }}
                    >
                      서브 {kidsOf(r.t).length}
                    </span>
                  </Show>
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={hiddenCount()}>
        <button class="g-older" style={{ "padding-left": `${TRUNK - 3}px` }} onClick={() => setOlder(!older())}>
          <span class="g-older-dot" />
          {older() ? "이전 일 접기" : `이전 ${hiddenCount()}개 보기`}
        </button>
      </Show>
      <Show when={!roots().length}>
        <p class="g-empty" style={{ "padding-left": `${gutter()}px` }}>일 없음</p>
      </Show>
    </div>
  );
}

