// The flow: main is the trunk and every job is a short branch off it, newest on
// top, coloured by what it needs. Subagents hang off their job on a dotted twig.
// Lives in the right panel's Flow tab.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { kidsOf as childrenOf, state, taskById, tasksIn } from "../state/store";
import type { Task } from "../state/types";
import { goMain, hoverTask, openTask, setHoverTask, view } from "../state/ui";
import { ago, compact, now } from "../ui/bits";
import { line, plain } from "../ui/ForkCard";
import { Icon } from "../ui/Icon";
import { bucket, changes, Glyph } from "./Sidebar";
import { discarded, endTime } from "../state/progress";
import { DiscardGlyph } from "../ui/Review";
import { t as tr } from "../i18n";
import { withHint } from "../lib/shortcuts";

const openId = () => {
  const v = view();
  return v.name === "task" ? v.id : undefined;
};
const openRoot = () => {
  let t = openId() ? taskById(openId()!) : undefined;
  while (t?.parentId) t = taskById(t.parentId);
  return t?.id;
};
const ended = (t: Task) => (t.status === "done" && t.worktree?.state !== "open") || discarded(t);
const DAY = 86_400_000;

// ───────────── the graph
const ROW = 46;
const SHORT = 32;
const KID = 28;
const TRUNK = 11;
/** where every job's node sits, one step off the trunk */
const NODE = 27;
const GUTTER = NODE + 15;
/** a subagent's glyph, at the end of its twig */
const KID_X = NODE + 11;
/** room above and below a row whose text wraps (6px each side) */
const WRAP_PAD = 12;


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
  /** finished, merged and not from today: tucked away under "earlier" */
  const old = (t: Task) => ended(t) && endTime(t) < now() - DAY && t.id !== openRoot();
  const shown = () => roots().filter((t) => older() || !old(t));
  const hiddenCount = () => roots().filter(old).length;

  const kidsOf = (t: Task) => [...childrenOf(t.id)].sort((a, b) => a.createdAt - b.createdAt);
  const kidsShown = (t: Task) => {
    const k = kidsOf(t);
    if (!k.length) return [];
    const forced = kidsOpen()[t.id];
    const auto = openRoot() === t.id || k.some((x) => x.status === "waiting" || x.status === "failed");
    return forced ?? auto ? k : [];
  };

  /** one line is enough: it is already in the to-do list above, or has not started */
  const brief = (t: Task) => bucket(t) === "you" || bucket(t) === "review" || t.status === "queued" || t.status === "paused" || ended(t);
  // rows show all of their text. Each row's text block is measured (on first render, and again
  // whenever it changes size: a new title, a narrower panel); a row whose text runs past its
  // usual height gets room above and below it, and the rows under it move down by that much.
  const [text, setText] = createSignal<Record<string, number>>({});
  const sizes = new ResizeObserver((es) => {
    const next = { ...text() };
    let changed = false;
    for (const e of es) {
      const el = e.target as HTMLElement;
      if (!el.isConnected) continue;
      const h = Math.ceil(el.getBoundingClientRect().height);
      // a hidden panel measures 0: keep the last size
      if (h && next[el.dataset.k!] !== h) (next[el.dataset.k!] = h), (changed = true);
    }
    if (changed) setText(next);
  });
  onCleanup(() => sizes.disconnect());
  /** the row's height for text this tall: its usual height, or the text plus room around it */
  const fit = (base: number, h: number | undefined) => (h !== undefined && h > base + 4 ? h + WRAP_PAD : base);
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
    const d = text();
    let y = 0;
    return order().map((o): Row => {
      const h = fit(o.base, d[o.k]);
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
      const tone = discarded(t) ? "past" : t.status === "failed" ? "bad" : t.status === "queued" ? "wait" : ended(t) ? "past" : t.status === "paused" ? "rest" : bucket(t) === "you" ? "warn" : bucket(t) === "review" ? "ready" : "live";
      const cls = `${tone} ${t.id === openRoot() ? "on" : ""} ${hoverTask() === t.id ? "hot" : ""}`;
      // off the trunk, up to the glyph's edge
      out.push({ d: `M${TRUNK} ${y} L${NODE - 7} ${y}`, cls });
      // subagents hang below on a thin twig
      const ks = rows().filter((k) => k.kid && k.t.parentId === t.id);
      if (ks.length) {
        const last = cy(ks[ks.length - 1]);
        out.push({ d: `M${NODE} ${y + 7} L${NODE} ${last - 5} Q${NODE} ${last}, ${NODE + 5} ${last}`, cls: `${cls} twig` });
        for (const k of ks.slice(0, -1)) {
          const ky = cy(k);
          out.push({ d: `M${NODE} ${ky - 5} Q${NODE} ${ky}, ${NODE + 5} ${ky}`, cls: `${cls} twig` });
        }
        // a subagent that failed: the last bit of its twig in red
        for (const k of ks.filter((k) => k.t.status === "failed")) {
          const ky = cy(k);
          out.push({ d: `M${NODE} ${ky - 5} Q${NODE} ${ky}, ${NODE + 5} ${ky}`, cls: `bad twig ${hoverTask() === t.id ? "hot" : ""}` });
        }
      }
    }
    return out;
  });

  /** the same words as the sidebar row */
  const meta = (t: Task) => {
    if (discarded(t)) return tr("버림");
    if (t.status === "failed") return tr("실패");
    if (t.status === "waiting") return tr("응답 필요");
    if (bucket(t) === "review") return tr("병합 필요");
    if (t.status === "queued") return tr("대기");
    if (t.status === "paused") return tr("일시정지");
    if (t.status === "done") return ago(endTime(t));
    return t.startedAt ? compact(now() - t.startedAt) : "";
  };
  const sub = (t: Task) => {
    if (t.status === "done") {
      if (t.worktree?.state === "open") {
        const c = changes(t);
        return c.add || c.del ? `+${c.add} −${c.del}` : tr("변경 없음");
      }
      return t.worktree?.state === "merged" ? tr("병합됨") : t.worktree?.state === "discarded" ? tr("버림") : plain(t.summary ?? "") || tr("완료");
    }
    return line(t);
  };

  return (
    <div class="graph" classList={{ "has-jobs": !!roots().length }} style={{ "--gutter": `${GUTTER}px` }}>
      <button class="g-main" data-shortcut="main" onClick={() => goMain()} title={withHint(tr("메인"), "main")} style={{ "--trunk": `${TRUNK}px` }}>
        <span class="g-main-node" style={{ left: `${TRUNK - 5}px` }} />
        <span class="g-name">{tr("메인")}</span>
        <Show when={state.captain.some((m) => m.space === state.space && m.pending)} fallback={<kbd class="g-kbd">⌘0</kbd>}>
          <span class="tk-run" />
        </Show>
      </button>
      <div class="g-body" style={{ height: `${height()}px` }}>
        <svg class="g-lines" classList={{ dim: !!hoverTask() }} width={GUTTER} height={Math.max(1, height())} aria-hidden="true">
          <line class="g-trunk" x1={TRUNK} y1={0} x2={TRUNK} y2={trunkEnd()} />
          <For each={paths()}>{(p) => <path class={p.cls} d={p.d} />}</For>
        </svg>
        {/* the same status glyphs as the sidebar */}
        <For each={order()}>
          {(r) => (
            <span class="g-at" style={{ left: `${r.kid ? KID_X : NODE}px`, top: `${cyOf(r.k)}px` }}>
              <Show when={discarded(r.t)} fallback={<Glyph t={r.t} class={`g-glyph${r.kid ? " kid" : ""}${openId() === r.t.id ? " on" : ""}`} />}>
                <DiscardGlyph class={`g-glyph${r.kid ? " kid" : ""}`} />
              </Show>
            </span>
          )}
        </For>
        <For each={order()}>
          {(r) => (
            <button
              class="g-row"
              classList={{ wrapped: (placed().get(r.k)?.h ?? 0) > r.base, kid: r.kid, on: openId() === r.t.id, hot: hoverTask() === r.t.id, past: ended(r.t), you: !r.kid && bucket(r.t) === "you" }}
              style={{ top: `${placed().get(r.k)?.y ?? 0}px`, "min-height": `${r.base}px`, "padding-left": `${r.kid ? GUTTER + 12 : GUTTER}px` }}
              onClick={() => openTask(r.t.id)}
              onMouseEnter={() => setHoverTask(r.kid ? r.t.parentId! : r.t.id)}
              onMouseLeave={() => setHoverTask(null)}
              title={r.t.title}
            >
              <span
                class="g-in"
                data-k={r.k}
                ref={(el) => {
                  sizes.observe(el);
                  onCleanup(() => sizes.unobserve(el));
                }}
              >
                <span class="g-line1">
                  <span class="g-name">{r.t.title}</span>
                  <Show when={!r.kid && r.t.browser && r.t.status === "running"}><Icon name="globe" size={11} class="g-badge" /></Show>
                  <Show when={!r.kid && r.base !== ROW && kidsOf(r.t).length}>
                    <span
                      class="g-kids"
                      role="button"
                      aria-expanded={!!kidsShown(r.t).length}
                      onClick={(e) => {
                        e.stopPropagation();
                        setKidsOpen({ ...kidsOpen(), [r.t.id]: !kidsShown(r.t).length });
                      }}
                    >
                      {tr("서브에이전트 {n}개", { n: kidsOf(r.t).length })}
                    </span>
                  </Show>
                  <span class="g-meta" classList={{ "m-review": bucket(r.t) === "review", "m-ask": r.t.status === "waiting", "m-bad": r.t.status === "failed" && !discarded(r.t) }}>{meta(r.t)}</span>
                </span>
                <Show when={!r.kid && r.base === ROW}>
                  <span class="g-line2-wrap">
                    <span class="g-line2" classList={{ bad: r.t.status === "failed" }}>{sub(r.t)}</span>
                    <Show when={kidsOf(r.t).length}>
                      <span
                        class="g-kids"
                        role="button"
                        aria-expanded={!!kidsShown(r.t).length}
                        onClick={(e) => {
                          e.stopPropagation();
                          setKidsOpen({ ...kidsOpen(), [r.t.id]: !kidsShown(r.t).length });
                        }}
                      >
                        {tr("서브에이전트 {n}개", { n: kidsOf(r.t).length })}
                      </span>
                    </Show>
                  </span>
                </Show>
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={hiddenCount()}>
        <button class="g-older" style={{ "padding-left": `${TRUNK - 4}px` }} onClick={() => setOlder(!older())}>
          <span class="g-older-dot" />
          {older() ? tr("이전 작업 접기") : tr("이전 작업 {n}개", { n: hiddenCount() })}
        </button>
      </Show>
      <Show when={!roots().length}>
        <p class="g-empty" style={{ "padding-left": `${GUTTER}px` }}>{tr("작업 없음")}</p>
      </Show>
    </div>
  );
}

