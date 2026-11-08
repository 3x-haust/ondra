// The memory view's right side: one thing in full (a piece, a finished job, what
// is going on in a project, a file), a folder's summary, the overview, or the
// saved versions of the memory as a timeline.
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { faded, isLive, KINDS, kindLabel, kindOf, removeMemory, restoreMemory, retireMemory, setMemory, updateMemory, userOwned } from "../engine/memory";
import { memoryHistory, memoryVersion, restoreMemoryAt } from "../engine/memgit";
import { fsRead, openInEditor, revealPath } from "../lib/native";
import { setState, state } from "../state/store";
import type { JournalEntry, Memory, MemoryKind } from "../state/types";
import { openTask, previewFile, toast } from "../state/ui";
import { ago } from "../ui/bits";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { agoIn, Badges, base, citePath, learnedIn, OUTCOME, type Outcome, outcomeOf, stampOf, tilde } from "./memoryBits";
import { StateGlyph } from "./Board";
import { DiscardGlyph } from "../ui/Review";
import {
  byWeight,
  clock,
  dayKey,
  dayLabel,
  entryId,
  folderOf,
  homeChain,
  homeName,
  JOURNAL,
  kindFolderId,
  type Model,
  memsUnder,
  monthKey,
  monthLabel,
  nowId,
  topicKey,
  VERSIONS,
} from "./memoryTree";
import { t } from "../i18n";

type Version = { sha: string; at: number; msg: string };
// the memory folder is a git repo only inside the app; the headless screenshots
// put a few versions here to see the timeline (dev builds only)

export function Detail(props: { model: Model; sel: string; onSel: (id: string) => void }) {
  const mem = () => (props.sel.startsWith("m:") ? props.model.memById.get(props.sel.slice(2)) : undefined);
  const file = () => (props.sel.startsWith("f:") ? props.sel.slice(2) : undefined);
  const entry = () => (props.sel.startsWith("j:") ? props.model.entryById.get(props.sel.slice(2)) : undefined);
  const now = () => (props.sel.startsWith("n:") ? props.model.nows.get(props.sel.slice(2)) : undefined);
  const journal = () => props.sel === JOURNAL || props.sel.startsWith("j|");
  return (
    <aside class="md-side">
      <Switch fallback={<Summary model={props.model} id={props.sel} onSel={props.onSel} />}>
        <Match when={props.sel === VERSIONS}><Versions /></Match>
        <Match when={mem()}>{(m) => <Piece model={props.model} m={m()} onSel={props.onSel} />}</Match>
        <Match when={entry()}>{(e) => <Entry model={props.model} e={e()} onSel={props.onSel} />}</Match>
        <Match when={now()}>{(n) => <Now model={props.model} n={n()} onSel={props.onSel} />}</Match>
        <Match when={journal()}><JournalFolder model={props.model} id={props.sel} onSel={props.onSel} /></Match>
        <Match when={file()}>{(f) => <FileSide path={f()} model={props.model} onSel={props.onSel} />}</Match>
      </Switch>
    </aside>
  );
}

const homeOfMem = (model: Model, m: Memory) => [...model.homes.values()].find((h) => h.live.includes(m) || h.past.includes(m))?.id ?? "g";

/** where a thing is: workspace › project › folder, then its own name (전체 공통 only for what is filed there) */
function Crumbs(props: { model: Model; home?: string; trail?: { id: string; label: string }[]; last: string; onSel: (id: string) => void }) {
  const chain = () => {
    if (!props.home) return [];
    const all = homeChain(props.model, props.home);
    return (all.length > 1 ? all.filter((h) => h.kind !== "global") : all).map((h) => ({ id: h.id, label: homeName(h) }));
  };
  return (
    <nav class="md-crumbs">
      <For each={[...chain(), ...(props.trail ?? [])]}>
        {(h) => (
          <>
            <button onClick={() => props.onSel(h.id)}>{h.label}</button>
            <Icon name="chevron" size={10} />
          </>
        )}
      </For>
      <span title={props.last}>{props.last}</span>
    </nav>
  );
}

/** numbers in a row, each with its label under it */
function Stats(props: { items: { n: number | string; label: string; go?: () => void; tone?: string }[] }) {
  return (
    <div class="mst" style={{ "--n": props.items.length, "--cols": props.items.length <= 4 ? props.items.length : 3 }}>
      <For each={props.items}>
        {(x) => (
          <button class="mst-c" classList={{ go: !!x.go }} disabled={!x.go} onClick={() => x.go?.()}>
            <b class={x.tone ?? ""}>{x.n}</b>
            <span>{x.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function H(props: { children: string; n?: number }) {
  return (
    <div class="md-h">
      {props.children}
      <Show when={props.n}><em>{props.n}</em></Show>
    </div>
  );
}

/** a short list of pieces you can jump to */
function PieceList(props: { list: Memory[]; onSel: (id: string) => void; limit?: number }) {
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? props.list : props.list.slice(0, props.limit ?? 8));
  return (
    <div class="ms-list">
      <For each={shown()}>
        {(m) => (
          <button class={`ms-piece mk-${kindOf(m)}`} classList={{ past: !!m.invalidAt, faint: isLive(m) && faded(m) }} onClick={() => props.onSel(`m:${m.id}`)} title={m.text}>
            <i />
            <span>{m.text}</span>
            <Badges m={m} cites />
          </button>
        )}
      </For>
      <Show when={!all() && props.list.length > shown().length}>
        <button class="ms-more" onClick={() => setAll(true)}>{t("{n}개 더", { n: props.list.length - shown().length })}</button>
      </Show>
    </div>
  );
}

/** finished jobs, newest first */
/** how a finished task ended, drawn with the sidebar's glyph for that state */
const OUTCOME_GLYPH: Record<Exclude<Outcome, "discarded">, "done" | "failed" | "paused" | "inreview"> = { done: "done", failed: "failed", stopped: "paused", review: "inreview" };

function EntryList(props: { list: JournalEntry[]; onSel: (id: string) => void; days?: boolean; limit?: number }) {
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? props.list : props.list.slice(0, props.limit ?? 30));
  const head = (e: JournalEntry, i: number) => props.days && (i === 0 || dayKey(shown()[i - 1].at) !== dayKey(e.at));
  return (
    <div class="ms-list">
      <For each={shown()}>
        {(e, i) => (
          <>
            <Show when={head(e, i())}><div class="ms-day">{dayLabel(e.at, true)}</div></Show>
            <button class={`ms-entry oc-${outcomeOf(e)}`} onClick={() => props.onSel(entryId(e))} title={e.ask}>
              {/* the sidebar's glyph for how it ended (review: the blue ring with a dot) */}
              <span class="ms-glyph" title={t(OUTCOME[outcomeOf(e)])}>
                {/* discarded: the done check, muted */}
                <Show when={outcomeOf(e) !== "discarded"} fallback={<DiscardGlyph />}><StateGlyph g={OUTCOME_GLYPH[outcomeOf(e) as Exclude<Outcome, "discarded">]} /></Show>
              </span>
              <span>{e.title || e.ask}</span>
              <Show when={e.learned?.length}><em class="ms-learn" title={t("배운 메모리")}>+{e.learned!.length}</em></Show>
              {/* a discarded task says so where the time would be, as in the sidebar */}
              <Show when={outcomeOf(e) === "discarded"} fallback={<em>{props.days ? clock(e.at) : ago(e.at)}</em>}>
                <em title={props.days ? clock(e.at) : ago(e.at)}>{t("버림")}</em>
              </Show>
            </button>
          </>
        )}
      </For>
      <Show when={!all() && props.list.length > shown().length}>
        <button class="ms-more" onClick={() => setAll(true)}>{t("{n}개 더", { n: props.list.length - shown().length })}</button>
      </Show>
    </div>
  );
}

function Empty(props: { children: string }) {
  return <div class="md-empty">{props.children}</div>;
}

// ───────────── overview and folders

/** A folder (or everything): how much is in it, of what kind, about what, and what's new. */
function Summary(props: { model: Model; id: string; onSel: (id: string) => void }) {
  const info = createMemo(() => {
    const id = props.id;
    const M = props.model;
    const k = /^(.+)\|k:(\w+)$/.exec(id);
    const pa = /^(.+)\|past$/.exec(id);
    const ts = /^(.+)\|t$/.exec(id);
    const topic = id.startsWith("t:") ? M.topics.get(id.slice(2)) : undefined;
    const home = M.homes.get(id);
    if (k && M.homes.has(k[1])) return { type: "kind" as const, home: k[1], kind: k[2] as MemoryKind, title: t(kindLabel(k[2] as MemoryKind)), last: t(kindLabel(k[2] as MemoryKind)) };
    if (pa && M.homes.has(pa[1])) return { type: "past" as const, home: pa[1], title: t("지난 메모리"), last: t("지난 메모리") };
    if (ts && M.homes.has(ts[1])) return { type: "topics" as const, home: ts[1], title: t("주제"), last: t("주제") };
    if (topic) return { type: "topic" as const, home: undefined, title: topic.label, last: t("주제") };
    if (home) return { type: "home" as const, home: home.parent, title: homeName(home), last: homeName(home), path: home.path };
    return { type: "all" as const, home: undefined, title: t("메모리"), last: "" };
  });
  const all = () => info().type === "all";
  const list = createMemo(() => (all() ? [...props.model.memById.values()].filter(isLive) : memsUnder(props.model, props.id)));
  const past = createMemo(() => {
    const i = info();
    if (i.type === "all") return [...props.model.memById.values()].filter((m) => !isLive(m));
    if (i.type === "home") return [...props.model.homes.values()].filter((h) => h.id === props.id || h.parent === props.id).flatMap((h) => h.past);
    return [];
  });
  const kinds = createMemo(() => {
    const live = list().filter(isLive);
    const max = Math.max(1, ...KINDS.map((k) => live.filter((m) => kindOf(m) === k.id).length));
    return KINDS.map((k) => ({ ...k, n: live.filter((m) => kindOf(m) === k.id).length, max })).filter((k) => k.n);
  });
  const topics = createMemo(() => {
    const c = new Map<string, number>();
    for (const m of list()) for (const a of m.about ?? []) if (props.model.topics.has(topicKey(a))) c.set(topicKey(a), (c.get(topicKey(a)) ?? 0) + 1);
    if (info().type === "topic") c.delete(props.id.slice(2));
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => ({ k, n, label: props.model.topics.get(k)!.label }));
  });
  const recent = createMemo(() => [...list()].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).slice(0, 5));
  const places = createMemo(() => {
    const i = info();
    if (i.type === "all") return props.model.order.map((id) => props.model.homes.get(id)!).filter((h) => h.kind !== "project" || h.live.length || h.past.length);
    if (i.type === "home") return [...props.model.homes.values()].filter((h) => h.parent === props.id);
    return [];
  });
  const kindTarget = (k: MemoryKind) => (info().type === "home" ? kindFolderId(props.id, k) : undefined);
  const fadedN = () => list().filter((m) => isLive(m) && faded(m)).length;
  const live = () => list().filter(isLive);
  /** finished jobs shown under 최근 작업 (the overview) */
  const recentJobs = () => props.model.journal.slice(0, 4);
  const nows = createMemo(() => {
    const i = info();
    const all = [...props.model.nows.values()].sort((a, b) => b.now.at - a.now.at);
    // the overview lists recent tasks once: a project's 지금 only when its task isn't among them
    if (i.type === "all") return all.filter((n) => !recentJobs().some((e) => e.taskId === n.now.taskId));
    if (i.type === "home") return all.filter((n) => n.home === props.id || props.model.homes.get(n.home)?.parent === props.id);
    return [];
  });
  return (
    <div class="md-in ms">
      <Show when={!all()}>
        <Crumbs model={props.model} home={info().home} last={info().last} onSel={props.onSel} />
      </Show>
      <header class="md-head">
        <Show when={info().type === "kind"}><i class={`md-kdot mk-${(info() as { kind: MemoryKind }).kind}`} /></Show>
        <h3 class="md-title">{info().title}</h3>
      </header>
      <Show when={info().type === "home" && (info() as { path?: string }).path}>
        <div class="md-path">{tilde((info() as { path?: string }).path!)}</div>
      </Show>
      <Show
        when={all()}
        fallback={
          <Stats
            items={[
              { n: info().type === "past" ? list().length : live().length, label: info().type === "past" ? t("지난 메모리") : t("메모리") },
              ...(info().type === "topics" ? [{ n: topics().length, label: t("주제") }] : []),
              ...(info().type !== "past" ? [{ n: live().filter((m) => m.paths?.length).length, label: t("경로 규칙") }] : []),
              ...(fadedN() ? [{ n: fadedN(), label: t("흐려짐") }] : []),
              ...(past().length ? [{ n: past().length, label: t("지난") }] : []),
            ]}
          />
        }
      >
        <Stats
          items={[
            { n: live().length, label: t("적용 중") },
            { n: past().length, label: t("지난") },
            { n: props.model.journal.length, label: t("작업 기록"), go: props.model.journal.length ? () => props.onSel(JOURNAL) : undefined },
            { n: live().filter((m) => m.paths?.length).length, label: t("경로 규칙") },
            { n: live().filter((m) => m.skill).length, label: t("스킬") },
          ].filter((x, i) => i === 0 || x.n)}
        />
      </Show>
      <Show when={nows().length}>
        <H>{t("최근")}</H>
        <div class="ms-list">
          <For each={nows()}>
            {(n) => (
              <button class="ms-now" onClick={() => props.onSel(nowId(n.folder))} title={`${tilde(n.folder)}\n${n.now.text}`}>
                <Icon name="clock" size={14} />
                <span>
                  <b>{props.model.homes.get(n.home) ? homeName(props.model.homes.get(n.home)!) : base(n.folder)}</b>
                  {n.now.title}
                </span>
                <em>{ago(n.now.at)}</em>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={kinds().length > 1 || (kinds().length && info().type !== "kind")}>
        <H>{t("종류")}</H>
        <div class="ms-rows">
          <For each={kinds()}>
            {(k) => (
              <button class={`ms-row ms-kind mk-${k.id}`} disabled={!kindTarget(k.id)} onClick={() => kindTarget(k.id) && props.onSel(kindTarget(k.id)!)}>
                <i />
                <span>{t(k.label)}</span>
                <span class="ms-bar"><b style={{ width: `${Math.round((k.n / k.max) * 100)}%` }} /></span>
                <em>{k.n}</em>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={places().length}>
        <H>{all() ? t("위치") : t("프로젝트")}</H>
        <div class="ms-rows">
          <For each={places()}>
            {(h) => (
              <button class="ms-row" classList={{ sub: h.kind === "project" && all() }} onClick={() => props.onSel(h.id)}>
                <Icon name={h.kind === "global" ? "globe" : "folder"} size={12} />
                <span>{h.label}<Show when={h.hint}><span class="mt-hint"> · {h.hint}</span></Show></span>
                <em>{memsUnder(props.model, h.id).length}</em>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={topics().length && info().type !== "topics"}>
        <H>{info().type === "topic" ? t("관련 주제") : t("주요 주제")}</H>
        <div class="ms-tags">
          <For each={topics()}>{(t) => <button onClick={() => props.onSel(`t:${t.k}`)}>{t.label}<em>{t.n}</em></button>}</For>
        </div>
      </Show>
      <Show when={info().type === "topics"}>
        <div class="ms-tags">
          <For each={[...props.model.topics.values()].map((t) => ({ t, n: t.mems.filter((m) => list().includes(m)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n)}>
            {(x) => <button onClick={() => props.onSel(`t:${x.t.key}`)}>{x.t.label}<em>{x.n}</em></button>}
          </For>
        </div>
      </Show>
      <Show
        when={info().type === "topic" || info().type === "past" || info().type === "kind"}
        fallback={
          <Show when={recent().length}>
            <H>{t("최근 메모리")}</H>
            <PieceList list={recent()} onSel={props.onSel} limit={5} />
          </Show>
        }
      >
        <H n={list().length}>{t("메모리")}</H>
        <PieceList list={[...list()].sort(byWeight)} onSel={props.onSel} limit={30} />
      </Show>
      <Show when={all() && props.model.journal.length}>
        <H>{t("최근 작업")}</H>
        <EntryList list={recentJobs()} onSel={props.onSel} limit={4} />
      </Show>
      <Show when={all()}>
        <TidyLine />
      </Show>
      <Show when={!all() && !list().length && !past().length && !nows().length}>
        <Empty>{t("없음")}</Empty>
      </Show>
    </div>
  );
}

/** when the quiet pass last ran, what it did, and up to which finished job it has learned */
function TidyLine() {
  const tidy = () => state.memoryTidy;
  const parts = () => {
    const x = tidy();
    if (!x) return [];
    return [
      x.learned && t("학습 {n}", { n: x.learned }),
      x.merged && t("병합 {n}", { n: x.merged }),
      x.retired && t("내림 {n}", { n: x.retired }),
      x.keyed && t("관련어 {n}", { n: x.keyed }),
      x.skills && t("스킬 {n}", { n: x.skills }),
    ].filter((p): p is string => !!p);
  };
  return (
    <Show when={tidy()?.at || parts().length}>
    <div class="md-tidy">
      <H>{t("정리")}</H>
      <Show when={tidy()}>
        {(x) => (
          <dl class="mp">
            <Show when={x().at}>
              <dt>{t("마지막")}</dt>
              <dd title={stampOf(x().at)}>{ago(x().at)}</dd>
            </Show>
            <Show when={x().cursor}>
              <dt>{t("학습 범위")}</dt>
              <dd>{t("{when}까지", { when: stampOf(x().cursor!) })}</dd>
            </Show>
            <Show when={parts().length}>
              <dt>{t("변경")}</dt>
              <dd class="md-dots">
                <For each={parts()}>{(p) => <span>{p}</span>}</For>
              </dd>
            </Show>
          </dl>
        )}
      </Show>
    </div>
    </Show>
  );
}

// ───────────── task log

function JournalFolder(props: { model: Model; id: string; onSel: (id: string) => void }) {
  const k = () => (props.id === JOURNAL ? "" : props.id.slice(2));
  const list = createMemo(() => props.model.journal.filter((e) => !k() || (k().length === 7 ? monthKey(e.at) : dayKey(e.at)) === k()));
  const title = () => {
    const e = list()[0];
    if (!k() || !e) return t("작업 기록");
    return k().length === 7 ? monthLabel(e.at) : dayLabel(e.at, true);
  };
  const trail = () => {
    const e = list()[0];
    if (!k() || !e) return [];
    return k().length === 7 ? [] : [{ id: `j|${monthKey(e.at)}`, label: monthLabel(e.at) }];
  };
  const n = (o: ReturnType<typeof outcomeOf>) => list().filter((e) => outcomeOf(e) === o).length;
  return (
    <div class="md-in ms">
      <Show when={k()}>
        <Crumbs model={props.model} trail={[{ id: JOURNAL, label: t("작업 기록") }, ...trail()]} last={title()} onSel={props.onSel} />
      </Show>
      <h3 class="md-title">{title()}</h3>
      <Stats
        items={[
          { n: list().length, label: t("작업") },
          { n: n("done"), label: t("완료"), tone: "ok" },
          ...(n("review") ? [{ n: n("review"), label: t("검토"), tone: "accent" }] : []),
          { n: n("failed"), label: t("실패"), tone: n("failed") ? "bad" : "" },
          { n: list().reduce((x, e) => x + (e.learned?.length ?? 0), 0), label: t("배운 것") },
        ]}
      />
      <Show when={list().length} fallback={<Empty>{t("없음")}</Empty>}>
        <EntryList list={list()} onSel={props.onSel} days={k().length !== 10} limit={60} />
      </Show>
    </div>
  );
}

function Entry(props: { model: Model; e: JournalEntry; onSel: (id: string) => void }) {
  const e = () => props.e;
  const learned = () => (e().learned ?? []).map((id) => props.model.memById.get(id)).filter((m): m is Memory => !!m);
  const task = () => state.tasks.find((t) => t.id === e().taskId);
  const space = () => state.spaces.find((s) => s.id === e().space)?.label;
  return (
    <div class="md-in">
      <Crumbs
        model={props.model}
        trail={[
          { id: JOURNAL, label: t("작업 기록") },
          { id: `j|${monthKey(e().at)}`, label: monthLabel(e().at) },
          { id: `j|${dayKey(e().at)}`, label: dayLabel(e().at) },
        ]}
        last={e().title || e().ask}
        onSel={props.onSel}
      />
      <h3 class="md-title">{e().title || e().ask}</h3>
      <div class="md-line">
        <span class={`md-oc oc-${outcomeOf(e())}`}><i />{t(OUTCOME[outcomeOf(e())])}</span>
        <span title={stampOf(e().at)}>{clock(e().at)}</span>
        <Show when={space()}><span>{t(space()!)}</span></Show>
        <Show when={e().project}><span class="mono" title={tilde(e().project!)}>{base(e().project!)}</span></Show>
      </div>
      <Show when={e().ask.trim()}>
        <H>{t("요청")}</H>
        <blockquote class="md-ask">{e().ask}</blockquote>
      </Show>
      <Show when={e().text.trim()}>
        <H>{t("결과")}</H>
        <div class="md-result"><Markdown text={e().text} /></div>
      </Show>
      <H n={learned().length}>{t("배운 메모리")}</H>
      <Show when={learned().length} fallback={<Empty>{t("없음")}</Empty>}>
        <div class="md-chips">
          <For each={learned()}>
            {(m) => (
              <button class={`md-chip mk-${kindOf(m)}`} classList={{ past: !!m.invalidAt }} onClick={() => props.onSel(`m:${m.id}`)} title={m.text}>
                <i />
                <span>{m.text}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="md-acts">
        <button class="btn sm" disabled={!task()} onClick={() => openTask(e().taskId)} title={task() ? undefined : t("삭제된 작업")}>
          <Icon name="arrow" size={14} />{t("작업 열기")}
        </button>
      </div>
    </div>
  );
}

function Now(props: { model: Model; n: { folder: string; home: string; now: { text: string; at: number; taskId: string; title: string } }; onSel: (id: string) => void }) {
  const n = () => props.n;
  const task = () => state.tasks.find((t) => t.id === n().now.taskId);
  const lines = () => n().now.text.split("\n").filter((l) => l.trim());
  return (
    <div class="md-in">
      <Crumbs model={props.model} home={n().home} last={t("지금")} onSel={props.onSel} />
      <header class="md-head">
        <Icon name="clock" size={16} class="md-head-ic" />
        <h3 class="md-title">{t("지금")}</h3>
      </header>
      <div class="md-line">
        <span title={stampOf(n().now.at)}>{ago(n().now.at)}</span>
        <span class="mono" title={tilde(n().folder)}>{base(n().folder)}</span>
      </div>
      <div class="md-now">
        <For each={lines()}>{(l, i) => <p classList={{ lead: i() === 0 }}>{l}</p>}</For>
      </div>
      <div class="md-acts">
        <button class="btn sm" disabled={!task()} onClick={() => openTask(n().now.taskId)}>
          <Icon name="arrow" size={14} />{t("작업 열기")}
        </button>
      </div>
    </div>
  );
}

// ───────────── one piece

function Importance(props: { m: Memory }) {
  const v = () => props.m.importance ?? 3;
  return (
    <div class="mi" role="radiogroup" aria-label={t("중요도")}>
      <For each={[1, 2, 3, 4, 5]}>
        {(i) => (
          <button class="mi-b" classList={{ on: i <= v() }} style={{ "--i": i }} role="radio" aria-checked={i === v()} title={t("중요도 {n}", { n: i })} onClick={() => setMemory(props.m.id, { importance: i })} />
        )}
      </For>
      <em>{v()}</em>
    </div>
  );
}

const patch = (id: string, p: Partial<Memory>) => setState("memory", (x) => x.id === id, { ...p, updatedAt: Date.now() });

function Globs(props: { m: Memory }) {
  const [v, setV] = createSignal("");
  const list = () => props.m.paths ?? [];
  const set = (paths: string[]) => patch(props.m.id, { paths: paths.length ? paths : undefined });
  const add = () => {
    const parts = v().split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length) set([...new Set([...list(), ...parts])]);
    setV("");
  };
  return (
    <div class="mp-globs">
      <For each={list()}>
        {(g) => (
          <span class="mp-glob">
            <span>{g}</span>
            <button title={t("빼기")} aria-label={t("빼기")} onClick={() => set(list().filter((x) => x !== g))}><Icon name="x" size={10} /></button>
          </span>
        )}
      </For>
      <input
        class="mp-glob-add"
        placeholder={list().length ? "+" : t("+ 경로")}
        value={v()}
        size={Math.max((list().length ? 1 : t("+ 경로").length) + 3, v().length + 1)}
        onInput={(e) => setV(e.currentTarget.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault(), add();
          else if (e.key === "Escape") setV(""), e.currentTarget.blur();
          else if (e.key === "Backspace" && !v() && list().length) set(list().slice(0, -1));
        }}
      />
    </div>
  );
}

function Owner(props: { m: Memory }) {
  const user = () => userOwned(props.m);
  return (
    <div class="seg-mini">
      <button classList={{ on: user() }} onClick={() => patch(props.m.id, { by: "user" })}><Icon name="lock" size={12} />{t("사용자")}</button>
      <button classList={{ on: !user() }} onClick={() => patch(props.m.id, { by: "agent" })}>{t("에이전트")}</button>
    </div>
  );
}

/** what this piece replaced and what replaced it, oldest first */
function chainOf(model: Model, m: Memory): Memory[] {
  const out: Memory[] = [m];
  const seen = new Set([m.id]);
  const older = (x: Memory) => [...model.memById.values()].filter((o) => o.supersededBy === x.id && !seen.has(o.id));
  for (let q = [m]; q.length; ) {
    const next: Memory[] = [];
    for (const x of q) for (const o of older(x)) seen.add(o.id), out.unshift(o), next.push(o);
    q = next;
  }
  for (let x = m; x.supersededBy && !seen.has(x.supersededBy); ) {
    const n = model.memById.get(x.supersededBy);
    if (!n) break;
    seen.add(n.id);
    out.push(n);
    x = n;
  }
  return out;
}

/** One piece, editable, and what it's tied to. */
function Piece(props: { model: Model; m: Memory; onSel: (id: string) => void }) {
  const m = () => props.m;
  const home = () => homeOfMem(props.model, m());
  const folder = () => ({ id: folderOf(home(), m()), label: m().invalidAt ? t("지난 메모리") : t(kindLabel(kindOf(m()))) });
  const linked = () => (m().links ?? []).map((l) => props.model.memById.get(l)).filter((x): x is Memory => !!x);
  const chain = createMemo(() => chainOf(props.model, m()));
  const homeLabel = () => (props.model.homes.get(home()) ? homeName(props.model.homes.get(home())!) : t("워크스페이스|one"));
  const entry = () => learnedIn(m());
  const task = () => (m().taskId ? state.tasks.find((t) => t.id === m().taskId) : undefined);
  /** "2번 사용 · 같은 내용 1번 더 저장 · 마지막 사용 3분 전", the parts that apply (seen counts the first save too) */
  const use = () =>
    [
      m().uses ? t("{n}번 사용", { n: m().uses }) : t("사용 안 함"),
      (m().seen ?? 1) > 1 ? t("같은 내용 {n}번 더 저장", { n: m().seen! - 1 }) : "",
      m().lastUsed ? t("마지막 사용 {when}", { when: agoIn(m().lastUsed!) }) : "",
    ].filter(Boolean);
  return (
    <div class="md-in">
      <Crumbs model={props.model} home={home()} trail={[folder()]} last={m().text} onSel={props.onSel} />
      <Show when={m().invalidAt}>
        <div class="md-past">
          <b>{t("지난 메모리")}</b>
          <span title={stampOf(m().invalidAt!)}>{ago(m().invalidAt!)}</span>
          <Show when={m().why}><span>{t(m().why!)}</span></Show>
        </div>
      </Show>
      <textarea class="md-text" value={m().text} rows={Math.min(10, Math.ceil(m().text.length / 34) + 1)} onChange={(e) => updateMemory(m().id, e.currentTarget.value)} />
      <div class="md-kinds">
        <For each={KINDS}>{(k) => <button class={`chip mk-${k.id}`} classList={{ on: kindOf(m()) === k.id }} onClick={() => setMemory(m().id, { kind: k.id })}><i />{t(k.label)}</button>}</For>
      </div>
      <p class="md-use">
        <For each={use()}>{(x) => <span>{x}</span>}</For>
      </p>
      <dl class="mp">
        <dt>{t("중요도")}</dt>
        <dd><Importance m={m()} /></dd>
        <dt>{t("작성자")}</dt>
        <dd><Owner m={m()} /></dd>
        <dt>{t("경로")}</dt>
        <dd><Globs m={m()} /></dd>
        <dt>{t("적용 범위")}</dt>
        <dd title={m().project ? tilde(m().project!) : undefined}>{m().scope === "global" ? t("전체 공통") : homeLabel()}</dd>
        <Show when={m().from}>
          <dt>{t("출처")}</dt>
          <dd><button class="md-file" onClick={() => previewFile(m().from!)} title={m().from}>{base(m().from!)}</button></dd>
        </Show>
        <Show when={m().key}>
          <dt>{t("이름")}</dt>
          <dd class="mono md-key">{m().key}</dd>
        </Show>
        <Show when={m().skill}>
          <dt>{t("스킬")}</dt>
          <dd><span class="md-skill"><Icon name="skill" size={14} />{m().skill}</span></dd>
        </Show>
        <Show when={m().about?.length}>
          <dt>{t("주제")}</dt>
          <dd class="ms-tags">
            <For each={m().about}>
              {(a) => (
                <Show when={props.model.topics.has(topicKey(a))} fallback={<span>{a}</span>}>
                  <button onClick={() => props.onSel(`t:${topicKey(a)}`)}>{a}</button>
                </Show>
              )}
            </For>
          </dd>
        </Show>
        <Show when={m().keys?.length}>
          <dt>{t("검색어")}</dt>
          <dd class="md-keys">{m().keys!.join(" · ")}</dd>
        </Show>
        <dt>{t("생성")}</dt>
        <dd title={stampOf(m().createdAt)}>
          {ago(m().createdAt)}
          <Show when={m().updatedAt && m().updatedAt! - m().createdAt > 60_000}><span class="md-sub"> · {t("수정 {when}", { when: agoIn(m().updatedAt!) })}</span></Show>
        </dd>
      </dl>
      <Show when={m().cites?.length}>
        <H n={m().cites!.length}>{t("코드")}</H>
        <div class="ms-list">
          <For each={m().cites}>
            {(c) => (
              <button class="ms-file" onClick={() => previewFile(citePath(m(), c))} title={citePath(m(), c)}>
                <Icon name="file" size={12} />
                <span>{c}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={entry() || task()}>
        <H>{t("배운 작업")}</H>
        <Show
          when={entry()}
          fallback={
            <button class={`ms-entry`} onClick={() => openTask(m().taskId!)}>
              <Icon name="arrow" size={12} />
              <span>{task()!.title}</span>
            </button>
          }
        >
          {(e) => (
            <button class={`ms-entry oc-${outcomeOf(e())}`} onClick={() => props.onSel(entryId(e()))} title={e().ask}>
              <i />
              <span>{e().title || e().ask}</span>
              <em>{dayLabel(e().at, true)}</em>
            </button>
          )}
        </Show>
      </Show>
      <Show when={chain().length > 1}>
        <H>{t("변경 이력")}</H>
        <ol class="tl tl-mini">
          <For each={chain()}>
            {(x) => (
              <li class={`tl-i mk-${kindOf(x)}`} classList={{ me: x.id === m().id, past: !!x.invalidAt }}>
                <i class="tl-dot" />
                <button class="tl-body" disabled={x.id === m().id} onClick={() => props.onSel(`m:${x.id}`)} title={x.text}>
                  <span class="tl-text">{x.text}</span>
                  <em>{x.invalidAt ? `${ago(x.createdAt)} – ${ago(x.invalidAt)}` : ago(x.createdAt)}</em>
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={linked().length}>
        <H n={linked().length}>{t("연결된 메모리")}</H>
        <PieceList list={linked()} onSel={props.onSel} />
      </Show>
      <div class="md-acts">
        <Show when={m().invalidAt} fallback={<button class="btn sm ghost" onClick={() => retireMemory(m().id)}><Icon name="archive" size={14} />{t("보관")}</button>}>
          <button class="btn sm ghost" onClick={() => restoreMemory(m().id)}><Icon name="refresh" size={14} />{t("복원")}</button>
        </Show>
        <button
          class="btn sm ghost danger"
          onClick={() => {
            const f = folder().id;
            removeMemory(m().id);
            props.onSel(f);
          }}
        >
          <Icon name="trash" size={14} />{t("삭제")}
        </button>
      </div>
    </div>
  );
}

// ───────────── files

function FileSide(props: { path: string; model: Model; onSel: (id: string) => void }) {
  const [text] = createResource(() => props.path, (p) => fsRead(p).then((r) => r.text ?? "").catch(() => ""));
  const home = () => [...props.model.homes.values()].find((h) => h.files.includes(props.path))?.id;
  return (
    <div class="md-in">
      <Crumbs model={props.model} home={home()} last={base(props.path)} onSel={props.onSel} />
      <div class="md-file-head">
        <b title={props.path}>{tilde(props.path)}</b>
        <span class="spacer" />
        <button class="icon-btn sm" title={t("패널에서 보기")} aria-label={t("패널에서 보기")} onClick={() => previewFile(props.path)}><Icon name="panel" size={14} /></button>
        <button class="icon-btn sm" title={t("편집기에서 열기")} aria-label={t("편집기에서 열기")} onClick={() => openInEditor(props.path)}><Icon name="external" size={14} /></button>
        <button class="icon-btn sm" title={t("Finder에서 보기")} aria-label={t("Finder에서 보기")} onClick={() => revealPath(props.path)}><Icon name="folder" size={14} /></button>
      </div>
      <div class="md-doc"><Markdown text={(text() ?? "").slice(0, 20000)} /></div>
    </div>
  );
}

// ───────────── versions

/** "기억 +2 · 바뀜 1 · 내림 1" → its parts, each with a tone */
function msgParts(msg: string): { text: string; tone: string }[] {
  const back = /^되돌림\s*·\s*(\w+)/.exec(msg);
  if (back) return [{ text: t("되돌림"), tone: "back" }, { text: back[1].slice(0, 7), tone: "sha" }];
  const count = /^기억\s+(\d+)개$/.exec(msg);
  if (count) return [{ text: t("메모리 {n}개", { n: Number(count[1]) }), tone: "" }];
  const s = msg.replace(/^기억\s+/, "");
  return s.split(" · ").map((p) => ({
    text: p.replace(/^(바뀜|내림|지움|정리)/, (w) => t(w)),
    tone: p.startsWith("+") ? "add" : p.startsWith("바뀜") ? "edit" : p.startsWith("내림") || p.startsWith("지움") ? "drop" : "",
  }));
}

function Versions() {
  const [hist] = createResource(memoryVersion, () => memoryHistory(80).catch(() => [] as Version[]));
  const list = () => hist() ?? [];
  const [ask, setAsk] = createSignal<string>();
  const [busy, setBusy] = createSignal<string>();
  const head = (v: Version, i: number) => i === 0 || dayKey(list()[i - 1].at) !== dayKey(v.at);
  const back = async (sha: string) => {
    setBusy(sha);
    try {
      const n = await restoreMemoryAt(sha);
      if (n) toast(t("메모리 {n}개로 되돌렸어요", { n }));
    } finally {
      setBusy();
      setAsk();
    }
  };
  return (
    <div class="md-in">
      <header class="md-head">
        <h3 class="md-title">{t("버전")}</h3>
        <Show when={list().length}><em class="md-count">{list().length}</em></Show>
      </header>
      <Show when={list().length} fallback={<Empty>{hist.loading ? "" : t("버전 없음")}</Empty>}>
        <ol class="tl">
          <For each={list()}>
            {(v, i) => (
              <>
                <Show when={head(v, i())}><li class="tl-day">{dayLabel(v.at, true)}</li></Show>
                <li class="tl-i" classList={{ first: i() === 0, open: ask() === v.sha }}>
                  <i class="tl-dot" classList={{ back: v.msg.includes("되돌림") }} />
                  <div class="tl-row">
                    <span class="tl-msg">
                      <For each={msgParts(v.msg)}>{(p) => <span class={`tl-p ${p.tone}`}>{p.text}</span>}</For>
                    </span>
                    <span class="tl-time" title={stampOf(v.at)}>{clock(v.at)}</span>
                    <button class="tl-go" classList={{ on: ask() === v.sha }} disabled={i() === 0} onClick={() => setAsk(ask() === v.sha ? undefined : v.sha)}>{t("이 버전으로")}</button>
                  </div>
                  <span class="tl-sha">{v.sha.slice(0, 7)}</span>
                  <Fold open={ask() === v.sha}>
                    <div class="tl-ask">
                      <button class="btn sm primary" disabled={!!busy()} onClick={() => void back(v.sha)}>{busy() === v.sha ? t("되돌리는 중") : t("되돌리기")}</button>
                      <button class="btn sm ghost" onClick={() => setAsk()}>{t("취소")}</button>
                    </div>
                  </Fold>
                </li>
              </>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}
