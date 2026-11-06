// A job's pull request inside the app: state and branches, checks, the review
// conversation (comments, reviews, line threads) and the changed files with
// their diffs, line comments under their lines. Read-only, apart from handing
// a comment to the job.
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { Task } from "../state/types";
import { gitEnv, passPrNote, prOf } from "../engine/tasks";
import { noteOf, parsePrView, githubBody, type PrCheck, type PrItem, type PrThread, type PrView } from "../engine/prView";
import { ghPrView, openUrl } from "../lib/native";
import { toast } from "../state/ui";
import { ago } from "./bits";
import { Icon } from "./Icon";
import { Fold } from "./Fold";
import { Markdown } from "./Markdown";
import { DiffCard, parsePatch, type Line } from "./Review";

const STATE: Record<PrView["state"], [string, string]> = { OPEN: ["열림", "ok"], MERGED: ["머지됨", "merged"], CLOSED: ["닫힘", ""] };
const REVIEW: Record<string, string> = { APPROVED: "승인", CHANGES_REQUESTED: "수정 요청", COMMENTED: "코멘트", DISMISSED: "취소됨" };

export function PrPane(props: { t: Task }) {
  const url = () => prOf(props.t)?.url;
  const [err, setErr] = createSignal("");
  let fetchedAt = 0;
  const [view, { refetch }] = createResource(url, async (u) => {
    setErr("");
    fetchedAt = Date.now();
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
    if (Date.now() - fetchedAt > 30_000) void refetch();
  };
  onMount(() => window.addEventListener("focus", onFocus));
  onCleanup(() => window.removeEventListener("focus", onFocus));

  return (
    <div class="review prv">
      <Switch>
        <Match when={view()}>{(v) => <PrBody v={v()} t={props.t} refresh={() => void refetch()} busy={view.loading} />}</Match>
        <Match when={err()}>
          <div class="prv-err">
            <span>PR을 불러오지 못했어요</span>
            <code>{err().split("\n").pop()}</code>
            <button class="link-btn" onClick={() => void refetch()}>다시</button>
          </div>
        </Match>
        <Match when={view.loading}><div class="pane-empty"><span class="spin" /></div></Match>
      </Switch>
    </div>
  );
}

function PrBody(props: { v: PrView; t: Task; refresh: () => void; busy: boolean }) {
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
    return { bad: c.filter((x) => x.state === "bad").length, run: c.filter((x) => x.state === "run").length, ok: c.filter((x) => x.state === "ok").length };
  };
  return (
    <>
      <header class="prv-head">
        <div class="prv-title">
          <span>{v().title}</span>
          <span class="prv-num">#{v().number}</span>
        </div>
        <div class="prv-meta">
          <span class={`pill ${v().draft && v().state === "OPEN" ? "" : STATE[v().state][1]}`}>{v().draft && v().state === "OPEN" ? "초안" : STATE[v().state][0]}</span>
          <Show when={v().conflict && v().state === "OPEN"}><span class="pill bad">충돌</span></Show>
          <Show when={v().decision === "CHANGES_REQUESTED"}><span class="pill warn">수정 요청</span></Show>
          <Show when={v().decision === "APPROVED"}><span class="pill ok">승인</span></Show>
          <code class="prv-branches" title={`${v().base} ← ${v().head}`}>{v().base} ← {v().head}</code>
          <span class="spacer" />
          <button class="icon-btn sm" title="새로고침" disabled={props.busy} onClick={props.refresh}><Icon name="refresh" size={13} /></button>
          <button class="btn sm" onClick={() => void openUrl(v().url)}><Icon name="external" size={12} />열기</button>
        </div>
      </header>

      <Show when={v().checks.length}>
        <section class="prv-sec">
          <div class="prv-label">
            검사
            <span class="prv-sum">
              <Show when={checks().bad}><span class="bad">실패 {checks().bad}</span></Show>
              <Show when={checks().run}><span>진행 중 {checks().run}</span></Show>
              <Show when={checks().ok}><span class="ok">통과 {checks().ok}</span></Show>
            </span>
          </div>
          <div class="prv-checks">
            <For each={shownChecks()}>{(c) => <CheckRow c={c} />}</For>
            <Show when={foldOk()}>
              <button class="prv-check prv-more" onClick={() => setAllChecks(!allChecks())}>
                <span class="prv-mark"><Icon name="chevron" size={13} class={allChecks() ? "open" : ""} /></span>
                <span class="prv-check-name">나머지 {okChecks().length}개</span>
              </button>
              <Fold open={allChecks()}>
                <For each={okChecks()}>{(c) => <CheckRow c={c} />}</For>
              </Fold>
            </Show>
          </div>
        </section>
      </Show>

      <section class="prv-sec">
        <div class="prv-label">대화<span class="prv-sum">{v().items.length || ""}</span></div>
        <Show when={v().items.length} fallback={<div class="prv-none">아직 코멘트가 없어요</div>}>
          <div class="prv-items">
            <For each={v().items}>{(x) => <Item x={x} t={props.t} url={v().url} me={v().me} jump={jump} />}</For>
          </div>
        </Show>
      </section>

      <section class="prv-sec">
        <div class="prv-label">
          바뀐 파일 {v().files.length}개
          <span class="prv-sum"><span class="add">+{v().add}</span><span class="del">−{v().del}</span></span>
        </div>
        <Show when={v().cut}><div class="prv-none">변경이 너무 커서 앞부분만 보여요</div></Show>
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
                badge={<Show when={byFile().get(f.path)?.length}>{(n) => <span class="prv-badge" title="코드 코멘트"><Icon name="message" size={12} />{n()}</span>}</Show>}
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
    <button class="prv-check" classList={{ [c().state]: true }} disabled={!c().url} onClick={() => c().url && void openUrl(c().url!)}>
      <span class="prv-mark">
        <Switch fallback={<span class="prv-dot" />}>
          <Match when={c().state === "ok"}><Icon name="check" size={13} /></Match>
          <Match when={c().state === "bad"}><Icon name="x" size={13} /></Match>
          <Match when={c().state === "skip"}><Icon name="minus" size={13} /></Match>
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
          toast("이 일에 넘겼어요");
        }
      }}
    >
      {sent() ? "넘김" : "이 일에 넘기기"}
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
                <span class={`prv-verdict ${(x() as { state: string }).state}`}>{REVIEW[(x() as { state: string }).state] ?? "리뷰"}</span>
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
