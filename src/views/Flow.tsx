// The flow: main is the trunk and every job is a short branch off it, newest on
// top, coloured by what it needs. Subagents hang off their job on a dotted twig.
// Lives in the right panel's 흐름 tab.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
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
const TRUNK = 11;
/** where every job's node sits, one step off the trunk */
const NODE = 27;
const GUTTER = NODE + 15;

interface Row {
  t: Task;
  kid: boolean;
  y: number;
  /** its height as drawn: at least `base`, taller when its text wraps */
  h: number;
  /** ROW, SHORT or KID */
  base: number;
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

  const kidsOf = (t: Task) => state.tasks.filter((k) => k.parentId === t.id).sort((a, b) => a.createdAt - b.createdAt);
  const kidsShown = (t: Task) => {
    const k = kidsOf(t);
    if (!k.length) return [];
    const forced = kidsOpen()[t.id];
    const auto = openRoot() === t.id || k.some((x) => x.status === "waiting" || x.status === "failed");
    return forced ?? auto ? k : [];
  };

  /** one line is enough: it is already in 할 일 above, or has not started */
  const brief = (t: Task) => bucket(t) === "you" || bucket(t) === "review" || t.status === "queued" || t.status === "paused" || ended(t);
  // rows show all of their text: each one's drawn height, measured, places the rows below it
  const [drawn, setDrawn] = createSignal<Record<string, number>>({});
  const sizes = new ResizeObserver((es) => {
    const next = { ...drawn() };
    let changed = false;
    for (const e of es) {
      const el = e.target as HTMLElement;
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (el.isConnected && h && next[el.dataset.k!] !== h) (next[el.dataset.k!] = h), (changed = true);
    }
    if (changed) setDrawn(next);
  });
  onCleanup(() => sizes.disconnect());
  const keyOf = (t: Task, kid: boolean) => `${kid ? "k" : "r"}:${t.id}`;
  /** the rows top to bottom; drawn once each, then only moved */
  const order = createMemo(() => {
    const out: { t: Task; kid: boolean; base: number; k: string }[] = [];
    for (const t of shown()) {
      out.push({ t, kid: false, base: brief(t) ? SHORT : ROW, k: keyOf(t, false) });
      for (const k of kidsShown(t)) out.push({ t: k, kid: true, base: KID, k: keyOf(k, true) });
    }
    return out;
  });
  const rows = createMemo(() => {
    const d = drawn();
    let y = 0;
    return order().map((o): Row => {
      const h = Math.max(o.base, d[o.k] ?? o.base);
      const r = { t: o.t, kid: o.kid, y, h, base: o.base };
      y += h;
      return r;
    });
  });
  const placed = createMemo(() => new Map(rows().map((r, i) => [order()[i].k, r])));
  const cyOf = (k: string) => ((r) => (r ? cy(r) : 0))(placed().get(k));
  const height = () => {
    const r = rows();
    return r.length ? r[r.length - 1].y + r[r.length - 1].h : 0;
  };
  /** the node sits beside the row's first line */
  const cy = (r: Row) => r.y + (r.base === ROW ? 15 : r.base / 2);

  /** the trunk reaches the last job */
  const trunkEnd = () => {
    const last = rows().filter((r) => !r.kid).pop();
    return last ? cy(last) : 0;
  };
  const paths = createMemo(() => {
    const out: { d: string; cls: string }[] = [];
    for (const r of rows()) {
      if (r.kid) continue;
      const t = r.t;
      const y = cy(r);
      const tone = t.status === "queued" ? "wait" : ended(t) ? "past" : t.status === "paused" ? "rest" : bucket(t) === "you" ? "warn" : bucket(t) === "review" ? "ready" : "live";
      const cls = `${tone} ${t.id === openRoot() ? "on" : ""} ${hoverTask() === t.id ? "hot" : ""}`;
      // off the trunk
      out.push({ d: `M${TRUNK} ${y} L${NODE - 5} ${y}`, cls });
      // subagents hang below on a thin twig
      const ks = rows().filter((k) => k.kid && k.t.parentId === t.id);
      if (ks.length) {
        const last = cy(ks[ks.length - 1]);
        out.push({ d: `M${NODE} ${y + 5} L${NODE} ${last - 5} Q${NODE} ${last}, ${NODE + 5} ${last}`, cls: `${cls} twig` });
        for (const k of ks.slice(0, -1)) {
          const ky = cy(k);
          out.push({ d: `M${NODE} ${ky - 5} Q${NODE} ${ky}, ${NODE + 5} ${ky}`, cls: `${cls} twig` });
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
    <div class="graph" classList={{ "has-jobs": !!roots().length }} style={{ "--gutter": `${GUTTER}px` }}>
      <button class="g-main" data-shortcut="main" onClick={() => goMain()} title="메인에게 말하기 (⌘0)" style={{ "--trunk": `${TRUNK}px` }}>
        <span class="g-main-node" style={{ left: `${TRUNK - 5}px` }} />
        <span class="g-name">메인</span>
        <Show when={state.captain.some((m) => m.space === state.space && m.pending)} fallback={<kbd class="g-kbd">⌘0</kbd>}>
          <span class="spin sm" />
        </Show>
      </button>
      <div class="g-body" style={{ height: `${height()}px` }}>
        <svg class="g-lines" classList={{ dim: !!hoverTask() }} width={GUTTER} height={Math.max(1, height())} aria-hidden="true">
          <line class="g-trunk" x1={TRUNK} y1={0} x2={TRUNK} y2={trunkEnd()} />
          <For each={paths()}>{(p) => <path class={p.cls} d={p.d} />}</For>
          <For each={order()}>
            {(r) => (
              <circle
                class={`g-node ${r.t.status}`}
                classList={{ unmerged: r.t.status === "done" && r.t.worktree?.state === "open", kid: r.kid, on: openId() === r.t.id }}
                cx={r.kid ? NODE + 8 : NODE}
                cy={cyOf(r.k)}
                r={r.kid ? 3 : 4.5}
              />
            )}
          </For>
        </svg>
        <For each={order()}>
          {(r) => (
            <button
              class="g-row"
              classList={{ wrapped: (placed().get(r.k)?.h ?? 0) > r.base + 4, kid: r.kid, on: openId() === r.t.id, hot: hoverTask() === r.t.id, past: ended(r.t), you: !r.kid && bucket(r.t) === "you" }}
              ref={(el) => {
                sizes.observe(el);
                onCleanup(() => sizes.unobserve(el));
              }}
              data-k={r.k}
              style={{ top: `${placed().get(r.k)?.y ?? 0}px`, "min-height": `${r.base}px`, "padding-left": `${r.kid ? GUTTER + 12 : GUTTER}px` }}
              onClick={() => openTask(r.t.id)}
              onMouseEnter={() => setHoverTask(r.kid ? r.t.parentId! : r.t.id)}
              onMouseLeave={() => setHoverTask(null)}
              title={r.t.title}
            >
              <span class="g-line1">
                <span class="g-name">{r.t.title}</span>
                <Show when={!r.kid && r.t.browser && r.t.status === "running"}><Icon name="globe" size={11} class="g-badge" /></Show>
                <Show when={!r.kid && r.base !== ROW && kidsOf(r.t).length}>
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
              <Show when={!r.kid && r.base === ROW}>
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
        <button class="g-older" style={{ "padding-left": `${TRUNK - 4}px` }} onClick={() => setOlder(!older())}>
          <span class="g-older-dot" />
          {older() ? "이전 일 접기" : `이전 ${hiddenCount()}개 보기`}
        </button>
      </Show>
      <Show when={!roots().length}>
        <p class="g-empty" style={{ "padding-left": `${GUTTER}px` }}>일 없음</p>
      </Show>
    </div>
  );
}

