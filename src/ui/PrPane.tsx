// A job's pull request inside the app: state and branches, checks, the review
// conversation (comments, reviews, line threads) and the changed files with
// their diffs, line comments under their lines. Read-only, apart from handing
// a comment to the job.
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { Task } from "../state/types";
import { gitEnv, passPrNote, prOf } from "../engine/tasks";
import { noteOf, parsePrView, githubBody, type PrCheck, type PrItem, type PrThread, type PrView } from "../engine/prView";
import { ghPrView } from "../lib/native";
import { linkMenu, openLink } from "./links";
import { toast } from "../state/ui";
import { ago, now } from "./bits";
import { t as tr } from "../i18n";
import { Icon } from "./Icon";
import { Fold } from "./Fold";
import { Markdown } from "./Markdown";
import { DiffCard, parsePatch, type Line } from "./Review";

const STATE: Record<PrView["state"], [string, string]> = { OPEN: ["열림", "open"], MERGED: ["병합됨", "merged"], CLOSED: ["닫힘", "closed"] };
const REVIEW: Record<string, string> = { APPROVED: "승인", CHANGES_REQUESTED: "수정 요청", COMMENTED: "코멘트", DISMISSED: "취소됨" };
/** the review decision as a pill: [label, tone] */
const DECISION: Record<string, [string, string]> = { APPROVED: ["승인", "ok"], CHANGES_REQUESTED: ["수정 요청", "warn"], REVIEW_REQUIRED: ["리뷰 대기", ""] };

/** how long ago the PR was read: "방금", "3분 전" */
function freshness(at: number): string {
  const m = Math.floor(Math.max(0, now() - at) / 60_000);
  if (m < 1) return tr("방금");
  if (m < 60) return tr("{n}분 전", { n: m });
  return tr("{n}시간 전", { n: Math.floor(m / 60) });
}

export function PrPane(props: { t: Task }) {
  const url = () => prOf(props.t)?.url;
  const [err, setErr] = createSignal("");
  const [fetchedAt, setFetchedAt] = createSignal(0);
  const [view, { refetch }] = createResource(url, async (u) => {
    setErr("");
    setFetchedAt(Date.now());
    try {
      const raw = await ghPrView(u, await gitEnv(props.t));
      return raw ? parsePrView(raw) : undefined;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  });
  // back to the window after a while: look again (never on a timer)
  const onFocus = () => {
    if (Date.now() - fetchedAt() > 30_000) void refetch();
  };
  onMount(() => window.addEventListener("focus", onFocus));
  onCleanup(() => window.removeEventListener("focus", onFocus));

  return (
    <div class="review prv">
      <Switch>
        <Match when={view()}>{(v) => <PrBody v={v()} t={props.t} refresh={() => void refetch()} busy={view.loading} at={fetchedAt()} />}</Match>
        <Match when={err()}>
          <div class="pane-empty prv-err">
            <span>{tr("PR을 불러오지 못했어요")}</span>
            <code title={err()}>{err().split("\n").pop()}</code>
            <button class="btn sm" onClick={() => void refetch()}>{tr("다시 시도")}</button>
          </div>
        </Match>
        <Match when={view.loading}><div class="pane-empty">{tr("불러오는 중…")}</div></Match>
      </Switch>
    </div>
  );
}

function PrBody(props: { v: PrView; t: Task; refresh: () => void; busy: boolean; at: number }) {
  const v = () => props.v;
  const files = createMemo(() => parsePatch(v().patch));
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const refs = new Map<string, HTMLElement>();
  const jump = (path: string) => {
    setOpen((s) => new Set(s).add(path));
    queueMicrotask(() => refs.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  // line threads by file, then by the side and line they sit on
  const byFile = createMemo(() => {
    const m = new Map<string, PrThread[]>();
    for (const th of v().threads) m.set(th.path, [...(m.get(th.path) ?? []), th]);
    return m;
  });
  const annot = (path: string) => (l: Line) => {
    const here = (byFile().get(path) ?? []).filter((th) => th.line !== undefined && (th.side === "LEFT" ? l.kind === "del" && l.old === th.line : l.kind !== "del" && l.new === th.line));
    return here.length ? <div class="prv-inline"><For each={here}>{(th) => <Thread th={th} t={props.t} url={v().url} me={v().me} />}</For></div> : undefined;
  };
  // many checks: the passing ones fold away, what failed or still runs stays in sight
  const foldOk = () => v().checks.length > 6 && okChecks().length > 0;
  const okChecks = () => v().checks.filter((c) => c.state === "ok" || c.state === "skip");
  const shownChecks = () => (foldOk() ? v().checks.filter((c) => c.state === "bad" || c.state === "run") : v().checks);
  const [allChecks, setAllChecks] = createSignal(false);
  const checks = () => {
    const c = v().checks;
    return { bad: c.filter((x) => x.state === "bad").length, run: c.filter((x) => x.state === "run").length, ok: c.filter((x) => x.state === "ok").length, all: c.filter((x) => x.state !== "skip").length };
  };
  const state = () => (v().draft && v().state === "OPEN" ? "draft" : STATE[v().state][1]);
  const decision = () => (v().state === "OPEN" ? DECISION[v().decision] : undefined);
  return (
    <>
      <header class="prv-card">
        <div class="prv-line1">
          <span class={`prv-state ${state()}`} title={v().draft && v().state === "OPEN" ? tr("초안") : tr(STATE[v().state][0])}>
            <Icon name={v().state === "MERGED" ? "merge" : "pr"} size={14} />
          </span>
          <span class="prv-num">#{v().number}</span>
          <Show when={props.t.issue}>
            {(i) => (
              <button class="prv-crumb" title={i().title} onClick={(e) => void openLink(i().url, { event: e })} onContextMenu={linkMenu(i().url)}>
                <span class="prv-crumb-sep">›</span>
                <span class="prv-num">#{i().n}</span>
                <span class="prv-crumb-title">{i().title}</span>
              </button>
            )}
          </Show>
          <span class="spacer" />
          <span class="prv-fresh">{freshness(props.at)}</span>
          <button class="icon-btn sm" title={tr("새로고침")} disabled={props.busy} onClick={props.refresh}><Icon name="refresh" size={14} /></button>
          <button class="icon-btn sm" title={tr("GitHub에서 열기")} onClick={(e) => void openLink(v().url, { event: e })} onContextMenu={linkMenu(v().url)}><Icon name="external" size={14} /></button>
        </div>
        <div class="prv-title">{v().title}</div>
        <code class="prv-branches" title={`${v().base} ← ${v().head}`}>{v().base} ← {v().head}</code>
        <div class="prv-foot">
          <Show when={checks().all}>
            <span class={`prv-checks-sum ${checks().bad ? "bad" : checks().run ? "run" : "ok"}`} title={tr("검사")}>
              <Switch>
                <Match when={checks().bad}><Icon name="x" size={14} /></Match>
                <Match when={checks().run}><span class="prv-dot" /></Match>
                <Match when={true}><Icon name="check" size={14} /></Match>
              </Switch>
              {tr("검사 {ok}/{all}", { ok: checks().ok, all: checks().all })}
            </span>
          </Show>
          <Show when={v().draft && v().state === "OPEN"}><span class="pill">{tr("초안")}</span></Show>
          <Show when={v().state !== "OPEN"}><span class={`pill ${v().state === "MERGED" ? "merged" : ""}`}>{tr(STATE[v().state][0])}</span></Show>
          <Show when={decision()}>{(d) => <span class={`pill ${d()[1]}`}>{tr(d()[0])}</span>}</Show>
          <Show when={v().conflict && v().state === "OPEN"}><span class="pill bad">{tr("충돌")}</span></Show>
          <span class="spacer" />
          <span class="prv-diff"><span class="add">+{v().add}</span><span class="del">−{v().del}</span></span>
        </div>
      </header>

      <Show when={v().checks.length}>
        <section class="prv-sec">
          <div class="prv-label">
            {tr("검사")}
            <span class="prv-sum">
              <Show when={checks().bad}><span class="bad">{tr("실패 {n}", { n: checks().bad })}</span></Show>
              <Show when={checks().run}><span>{tr("진행 중 {n}", { n: checks().run })}</span></Show>
              <Show when={checks().ok}><span class="ok">{tr("통과 {n}", { n: checks().ok })}</span></Show>
            </span>
          </div>
          <div class="prv-checks">
            <For each={shownChecks()}>{(c) => <CheckRow c={c} />}</For>
            <Show when={foldOk()}>
              <button class="prv-check prv-more" onClick={() => setAllChecks(!allChecks())}>
                <span class="prv-mark"><Icon name="chevron" size={12} class={allChecks() ? "open" : ""} /></span>
                <span class="prv-check-name">{tr("나머지 {n}개", { n: okChecks().length })}</span>
              </button>
              <Fold open={allChecks()}>
                <For each={okChecks()}>{(c) => <CheckRow c={c} />}</For>
              </Fold>
            </Show>
          </div>
        </section>
      </Show>

      <section class="prv-sec">
        <div class="prv-label">{tr("대화")}<span class="prv-sum">{v().items.length || ""}</span></div>
        <Show when={v().items.length} fallback={<div class="prv-none">{tr("코멘트 없음")}</div>}>
          <div class="prv-items">
            <For each={v().items}>{(x) => <Item x={x} t={props.t} url={v().url} me={v().me} jump={jump} />}</For>
          </div>
        </Show>
      </section>

      <section class="prv-sec">
        <div class="prv-label">
          {tr("파일 {n}개", { n: v().files.length })}
          <span class="prv-sum"><span class="add">+{v().add}</span><span class="del">−{v().del}</span></span>
        </div>
        <Show when={v().cut}><div class="prv-none">{tr("변경이 커서 앞부분만 보여요")}</div></Show>
        <div class="rv-files">
          <For each={files()}>
            {(f) => (
              <DiffCard
                f={f}
                root=""
                remote
                open={open().has(f.path)}
                toggle={() => toggle(f.path)}
                ref={(el) => refs.set(f.path, el)}
                annot={annot(f.path)}
                badge={<Show when={byFile().get(f.path)?.length}>{(n) => <span class="prv-badge" title={tr("코드 코멘트")}><Icon name="message" size={12} />{n()}</span>}</Show>}
              />
            )}
          </For>
        </div>
      </section>
    </>
  );
}

function CheckRow(props: { c: PrCheck }) {
  const c = () => props.c;
  return (
    <button class="prv-check" classList={{ [c().state]: true }} disabled={!c().url} onClick={(e) => c().url && void openLink(c().url!, { event: e })} onContextMenu={linkMenu(c().url)}>
      <span class="prv-mark">
        <Switch fallback={<span class="prv-dot" />}>
          <Match when={c().state === "ok"}><Icon name="check" size={14} /></Match>
          <Match when={c().state === "bad"}><Icon name="x" size={14} /></Match>
          <Match when={c().state === "skip"}><Icon name="minus" size={14} /></Match>
        </Switch>
      </span>
      <span class="prv-check-name">{c().name}</span>
    </button>
  );
}

function Pass(props: { t: Task; url: string; x: PrItem }) {
  const [sent, setSent] = createSignal(false);
  return (
    <button
      class="btn sm ghost prv-pass"
      disabled={sent()}
      onClick={() => {
        if (passPrNote(props.t.id, props.url, noteOf(props.x))) {
          setSent(true);
          toast(tr("작업에 넘겼어요"));
        }
      }}
    >
      {sent() ? tr("넘김") : tr("작업에 넘기기")}
    </button>
  );
}

function Item(props: { x: PrItem; t: Task; url: string; me: string; jump: (path: string) => void }) {
  return (
    <Switch>
      <Match when={props.x.kind === "thread" && props.x}>
        {(x) => (
          <div class="prv-item">
            <button class="prv-where link-btn" onClick={() => props.jump(x().thread.path)}>
              {x().thread.path}{x().thread.line ? `:${x().thread.line}` : ""}
            </button>
            <Thread th={x().thread} t={props.t} url={props.url} me={props.me} />
          </div>
        )}
      </Match>
      <Match when={props.x.kind !== "thread" && (props.x as Exclude<PrItem, { kind: "thread" }>)}>
        {(x) => (
          <div class="prv-item">
            <div class="prv-who">
              <b>{x().who}</b>
              <Show when={x().kind === "review"}>
                <span class={`prv-verdict ${(x() as { state: string }).state}`}>{tr(REVIEW[(x() as { state: string }).state] ?? "리뷰")}</span>
              </Show>
              <span class="prv-at">{ago(x().at)}</span>
              <span class="spacer" />
              <Show when={x().who !== props.me && x().body.trim()}><Pass t={props.t} url={props.url} x={x()} /></Show>
            </div>
            <Show when={x().body.trim()}><Markdown github text={githubBody(x().body)} class="prv-body" /></Show>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function Thread(props: { th: PrThread; t: Task; url: string; me: string }) {
  return (
    <div class="prv-thread">
      <For each={props.th.notes}>
        {(n, i) => (
          <div class="prv-note">
            <div class="prv-who">
              <b>{n.who}</b>
              <span class="prv-at">{ago(n.at)}</span>
              <span class="spacer" />
              <Show when={i() === props.th.notes.length - 1 && n.who !== props.me}>
                <Pass t={props.t} url={props.url} x={{ kind: "thread", thread: props.th, at: props.th.at }} />
              </Show>
            </div>
            <Markdown github text={githubBody(n.body)} class="prv-body" />
          </div>
        )}
      </For>
    </div>
  );
}
