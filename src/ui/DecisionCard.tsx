// A question a task is waiting on, with its answers as buttons.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { projectById, state, taskById } from "../state/store";
import type { Block, Decision, Task } from "../state/types";
import { inBrowserShare } from "../lib/native";
import { ignoredKey, noModifiers, shortcutOverlay, viewKey } from "../lib/shortcuts";
import { openBrowser, openTask, view } from "../state/ui";
import { decide } from "../engine/tasks";
import { BlockView } from "./Blocks";
import { Icon } from "./Icon";
import { dropAsked } from "./decisionText";
import { ProjectBadge } from "./ProjectBadge";
import { t as tr } from "../i18n";

/** An answered question as the task stores it (`"question" → answer`), or undefined for any other message. */
export function answerOf(text: string): { q: string; a: string } | undefined {
  const m = text.match(/^"([\s\S]+?)" → ([\s\S]+)$/);
  return m ? { q: m[1].trim(), a: m[2].trim() } : undefined;
}

/** A question already answered, kept in the thread where the card was: the question, then the answer. */
export function AnsweredCard(props: { q: string; a: string }) {
  return (
    <div class="decision-done">
      <Icon name="message" size={14} />
      <span class="decision-done-q">{props.q}</span>
      <Icon name="arrow" size={12} class="decision-done-to" />
      <span class="decision-done-a">{props.a}</span>
    </div>
  );
}

/** what was typed in each question's own-answer line, kept while the card is away (another view, Main ↔ task) */
const ownDrafts = new Map<string, string>();

/** the task's project chat is the view: its crumb would only repeat the header */
const inOwnProject = (x: { project?: string }) => {
  const v = view();
  return v.name === "main" && !!x.project && v.project === x.project;
};

/** `crumb: false`: the task's row is already in sight right above (a project's task strip), so no crumb.
 *  `dock`: Main's form, attached above the input: the question on one line, its answers as buttons under it,
 *  opened in place when there is more to read. `keys: false`: another card on screen takes the number keys. */
export function DecisionCard(props: { d: Decision; showTask?: boolean; crumb?: boolean; dock?: boolean; keys?: boolean }) {
  const t = () => taskById(props.d.taskId);
  // what to choose from: the pictures sent with the question, else what the job
  // said and showed since the user last spoke (the reasoning behind the question)
  const context = (): Block[] => {
    if (props.d.context.length) return props.d.context;
    const list = t()?.entries ?? [];
    const from = list.map((e) => e.kind).lastIndexOf("user") + 1;
    const out: Block[] = [];
    for (const e of list.slice(from)) {
      if (e.kind === "block" && !["plan", "now", "ask", "done"].includes(String((e.block as { type?: string }).type))) out.push(e.block);
      if (e.kind === "text" && e.text.trim()) out.push({ type: "text", text: e.text.trim() } as Block);
    }
    return dropAsked(out.slice(-4));
  };
  /** a job asking the user to sign in: the page it was on, to open in the browser view */
  const loginUrl = () => {
    if (!/로그인|login|sign.?in|인증/i.test(`${props.d.question} ${props.d.options.map((o) => o.label).join(" ")}`)) return undefined;
    const x = t();
    if (!x) return undefined;
    for (let i = x.entries.length - 1; i >= 0; i--) {
      const e = x.entries[i];
      if (e.kind !== "tool" || e.tool.kind !== "browser") continue;
      const m = `${e.tool.detail ?? ""} ${e.tool.target}`.match(/https?:\/\/[^\s"'<>]+/);
      if (m) return m[0];
    }
    return x.entries.some((e) => e.kind === "tool" && e.tool.kind === "browser") ? "" : undefined;
  };
  const openLogin = () => {
    const u = loginUrl();
    openBrowser(u || undefined);
  };
  const [typed, setTyped_] = createSignal(ownDrafts.get(props.d.id) ?? "");
  const setTyped = (v: string) => {
    setTyped_(v);
    if (v) ownDrafts.set(props.d.id, v);
    else ownDrafts.delete(props.d.id);
  };
  // one action answers: a click on a choice, or its number. Your own words are the one answer that
  // needs a second step (writing them); the arrows only move the highlight, Enter answers it
  const own_ = () => !props.d.ui;
  const n = () => props.d.options.length;
  const count = () => n() + (own_() ? 1 : 0);
  const [hi, setHi] = createSignal(-1);
  /** the dock's own-answer line is open (in the list it always is); a kept draft comes back open */
  const [writing, setWriting] = createSignal(!!typed());
  const [open, setOpen] = createSignal(false);
  let own: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  let sent = false;
  const send = async (answer: string) => {
    if (sent) return;
    sent = true;
    // a sign-in card: what was signed in to in the app's browser reaches the jobs' browser first
    if (loginUrl() !== undefined) await inBrowserShare(t()?.space ?? state.space, loginUrl() || undefined).catch(() => {});
    void decide(props.d.id, answer);
    ownDrafts.delete(props.d.id);
  };
  const choose = (i: number) => {
    if (i < n()) return void send(props.d.options[i].id);
    setHi(i);
    setWriting(true);
    queueMicrotask(() => own?.focus());
  };
  const sendTyped = () => {
    const v = typed().trim();
    if (v) void send(v);
  };
  /** something is being written in an input on screen: a number is part of it, never an answer */
  const composing = () => [...document.querySelectorAll<HTMLTextAreaElement>(".composer textarea")].some((x) => x.value.trim());
  // a number pressed anywhere (not while typing, nothing half-written in the input) answers with that choice
  const anywhere = (e: KeyboardEvent) => {
    if (props.keys === false || !viewKey(e) || !noModifiers(e) || !/^[1-9]$/.test(e.key) || Number(e.key) > count()) return;
    const el = document.activeElement;
    if (el && list?.contains(el)) return; // handled by `keys`
    if (composing()) return;
    e.preventDefault();
    choose(Number(e.key) - 1);
  };
  window.addEventListener("keydown", anywhere);
  onCleanup(() => window.removeEventListener("keydown", anywhere));
  const keys = (e: KeyboardEvent) => {
    if (!viewKey(e) || !noModifiers(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      const i = hi() < 0 ? (down ? 0 : count() - 1) : (hi() + (down ? 1 : -1) + count()) % count();
      setHi(i);
      if (i === n()) own?.focus();
    } else if (e.key === "Enter" && hi() >= 0) {
      e.preventDefault();
      choose(hi());
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= count()) {
      e.preventDefault();
      choose(Number(e.key) - 1);
    }
  };
  const ownKeys = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      const allowed = !ignoredKey(e) && noModifiers(e) && !shortcutOverlay();
      e.preventDefault();
      if (allowed) sendTyped();
      return;
    }
    if (ignoredKey(e) || !noModifiers(e) || shortcutOverlay()) return;
    // the dock: Esc puts the choices back (what was written stays for next time)
    if (e.key === "Escape" && props.dock) {
      e.preventDefault();
      e.stopPropagation();
      setWriting(false);
      return;
    }
    if (e.key === "ArrowUp" && list) {
      e.preventDefault();
      setHi(n() - 1);
      list.focus();
    }
  };
  /** there is more to read than the dock's one line: what the job said, notes on the choices, a long question */
  const more = () =>
    !!props.dock && (context().length > 0 || props.d.options.some((o) => o.note) || props.d.question.length > 48 || props.d.question.includes("\n"));
  let card!: HTMLDivElement;
  /** opened in a dock that scrolls: once it has folded open, its answers are in sight */
  const toggle = () => {
    setOpen(!open());
    if (open()) setTimeout(() => card?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 180);
  };
  const crumb = () => (props.showTask !== false && props.crumb !== false ? t() : undefined);
  const Crumb = (p: { x: Task }) => (
    <button class="decision-src" onClick={() => openTask(p.x.id)} title={p.x.title}>
      {/* where it runs: its project (badge and name), 기타 when it has none;
          in that project's own chat the header already says it, so only the task */}
      <Show when={!inOwnProject(p.x)}>
        <Show when={p.x.project ? projectById(p.x.project!) : undefined} fallback={<span>{tr("프로젝트 없음")}</span>}>
          {(pr) => (
            <>
              <ProjectBadge name={pr().name} />
              <span>{pr().name}</span>
            </>
          )}
        </Show>
        <span class="decision-src-sep">/</span>
      </Show>
      <span class="decision-src-title">{p.x.title}</span>
    </button>
  );
  const Login = () => (
    <Show when={loginUrl() !== undefined}>
      <button class="decision-login" onClick={openLogin}>
        <Icon name="globe" size={14} />
        <span>{tr("브라우저에서 로그인")}</span>
        <Show when={loginUrl()}>{(u) => <span class="muted">{u().replace(/^https?:\/\/(www\.)?/, "").split("?")[0]}</span>}</Show>
      </button>
    </Show>
  );
  const Rec = () => <span class="decision-rec">{tr("추천")}</span>;
  /** your own words: one line, answered with Enter or its button */
  const OwnInput = () => (
    <>
      <input
        ref={own}
        class="decision-input"
        placeholder={tr("다른 답")}
        aria-label={tr("다른 답")}
        value={typed()}
        onFocus={() => setHi(n())}
        onInput={(e) => setTyped(e.currentTarget.value)}
        onKeyDown={ownKeys}
      />
      <Show when={typed().trim()}>
        <button type="submit" class="decision-go" aria-label={tr("응답")} title={`${tr("응답")} ↵`}>
          <Icon name="send" size={12} stroke={2.25} />
        </button>
      </Show>
    </>
  );
  return (
    <div class="decision" ref={card} classList={{ stalled: props.d.kind === "stalled", dock: !!props.dock, open: open() }}>
      <Show
        when={props.dock}
        fallback={
          <>
            <div class="decision-q">
              <Icon name={props.d.kind === "stalled" ? "pause" : "message"} size={14} />
              <span>{props.d.question}</span>
            </div>
            <Login />
            <Show when={crumb()}>{(x) => <Crumb x={x()} />}</Show>
          </>
        }
      >
        {/* the dock: the question and where it comes from on one line; a click opens what there is to read */}
        <div class="decision-head" classList={{ more: more() }} onClick={(e) => more() && !(e.target as Element).closest(".decision-src") && toggle()}>
          <Icon name={props.d.kind === "stalled" ? "pause" : "message"} size={14} />
          <span class="decision-q-text">{props.d.question}</span>
          <Show when={crumb()}>{(x) => <Crumb x={x()} />}</Show>
          <Show when={more()}>
            <button class="decision-more" aria-expanded={open()} aria-label={open() ? tr("접기") : tr("펼치기")} title={open() ? tr("접기") : tr("펼치기")}>
              <Icon name="chevron" size={12} />
            </button>
          </Show>
        </div>
      </Show>
      {/* the dock: what there is to read folds open between the question and its answers, which stay put */}
      <Show when={props.dock && more()}>
        <div class="decision-fold" inert={!open()}>
          <div class="decision-fold-in">
            <Show when={context().length}>
              <div class="decision-ctx"><For each={context()}>{(b) => <BlockView block={b} />}</For></div>
            </Show>
            <Show when={props.d.options.some((o) => o.note)}>
              <div class="decision-notes">
                <For each={props.d.options.filter((o) => o.note)}>
                  {(o) => (
                    <p>
                      <b>{o.label}</b> {o.note}
                    </p>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      <Show
        when={!props.dock}
        fallback={
          <div class="decision-chips" role="group" aria-label={props.d.question}>
            <Show
              when={!writing()}
              fallback={
                <form
                  class="decision-own-line"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendTyped();
                  }}
                >
                  <OwnInput />
                  <button type="button" class="decision-back" aria-label={tr("취소")} title={`${tr("취소")} esc`} onClick={() => setWriting(false)}>
                    <Icon name="x" size={12} />
                  </button>
                </form>
              }
            >
              <Login />
              <For each={props.d.options}>
                {(o, i) => (
                  <button class="decision-chip" classList={{ primary: !!o.primary }} onClick={() => choose(i())} title={o.note || undefined}>
                    <Show when={props.keys !== false}><span class="decision-n">{i() + 1}</span></Show>
                    <span class="decision-label">{o.label}</span>
                    <Show when={o.primary}><Rec /></Show>
                  </button>
                )}
              </For>
              <Show when={own_()}>
                <button class="decision-chip own" onClick={() => choose(n())}>
                  <Show when={props.keys !== false}><span class="decision-n">{n() + 1}</span></Show>
                  <span class="decision-label">{tr("다른 답")}</span>
                </button>
              </Show>
            </Show>
          </div>
        }
      >
        {/* inside the job's own thread its words are right above: only pictures sent with the question */}
        <Show when={(props.showTask !== false || props.d.context.length) && context().length}>
          <div class="decision-ctx"><For each={context()}>{(b) => <BlockView block={b} />}</For></div>
        </Show>
        {/* like Codex: the choices as a list, and a line to answer in your own words */}
        <div class="decision-list" role="group" aria-label={props.d.question} tabIndex={0} onKeyDown={keys} onMouseLeave={() => hi() < n() && setHi(-1)} ref={list}>
          <For each={props.d.options}>
            {(o, i) => (
              <button class="decision-opt" classList={{ on: hi() === i(), primary: !!o.primary }} onClick={() => choose(i())}>
                <span class="decision-n">{i() + 1}</span>
                <span class="decision-text">
                  {/* marked beside its label, never preselected */}
                  <span class="decision-label">
                    {o.label}
                    <Show when={o.primary}><Rec /></Show>
                  </span>
                  <Show when={o.note}><span class="decision-note">{o.note}</span></Show>
                </span>
              </button>
            )}
          </For>
          <Show when={own_()}>
            <form
              class="decision-opt decision-own"
              classList={{ on: hi() === n() }}
              onClick={(e) => e.target === e.currentTarget && own?.focus()}
              onSubmit={(e) => {
                e.preventDefault();
                sendTyped();
              }}
            >
              <span class="decision-n">{n() + 1}</span>
              <OwnInput />
            </form>
          </Show>
        </div>
      </Show>
    </div>
  );
}
