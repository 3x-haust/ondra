// A question a task is waiting on, with its answers as buttons.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { state, taskById } from "../state/store";
import type { Block, Decision } from "../state/types";
import { inBrowserShare } from "../lib/native";
import { ignoredKey, noModifiers, shortcutOverlay, viewKey } from "../lib/shortcuts";
import { openBrowser, openTask } from "../state/ui";
import { decide } from "../engine/tasks";
import { BlockView } from "./Blocks";
import { Icon } from "./Icon";
import { dropAsked } from "./decisionText";
import { t as tr } from "../i18n";

/** what was typed in each question's own-answer line, kept while the card is away (another view, Main ↔ task) */
const ownDrafts = new Map<string, string>();

export function DecisionCard(props: { d: Decision; showTask?: boolean }) {
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
  // nothing starts selected (the recommended choice is only marked). Clicking, ↑↓ or a number
  // only selects; Enter or the send button answers (never on hover, never by accident)
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
  // a kept answer comes back selected; otherwise nothing is
  const [sel, setSel] = createSignal(typed() && !props.d.ui ? props.d.options.length : -1);
  let own!: HTMLInputElement;
  let list!: HTMLDivElement;
  // one place to answer in your own words, in Main and in the task alike: the card's own line
  const own_ = () => !props.d.ui;
  const count = () => props.d.options.length + (own_() ? 1 : 0);
  const select = (i: number) => {
    setSel(i);
    if (i === props.d.options.length) own?.focus();
    else list.focus();
  };
  const picked = () => sel() >= 0 && sel() < props.d.options.length;
  const ready = () => picked() || !!typed().trim();
  const submit = async () => {
    if (!ready()) return;
    // a sign-in card: what was signed in to in the app's browser reaches the jobs' browser first
    if (loginUrl() !== undefined) await inBrowserShare(t()?.space ?? state.space, loginUrl() || undefined).catch(() => {});
    if (picked()) void decide(props.d.id, props.d.options[sel()].id);
    else void decide(props.d.id, typed().trim());
    ownDrafts.delete(props.d.id);
  };
  // a number pressed anywhere (not while typing) selects that choice and
  // brings the keyboard here, so Enter then answers
  const anywhere = (e: KeyboardEvent) => {
    if (!viewKey(e) || !noModifiers(e) || !/^[1-9]$/.test(e.key) || Number(e.key) > count()) return;
    const el = document.activeElement;
    if (el && list.contains(el)) return; // handled by `keys`
    e.preventDefault();
    select(Number(e.key) - 1);
  };
  window.addEventListener("keydown", anywhere);
  onCleanup(() => window.removeEventListener("keydown", anywhere));
  const keys = (e: KeyboardEvent) => {
    if (!viewKey(e) || !noModifiers(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      select(sel() < 0 ? (down ? 0 : count() - 1) : (sel() + (down ? 1 : -1) + count()) % count());
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= count()) {
      e.preventDefault();
      select(Number(e.key) - 1);
    }
  };
  return (
    <div class="decision" classList={{ stalled: props.d.kind === "stalled" }}>
      <div class="decision-q">
        <Icon name={props.d.kind === "stalled" ? "pause" : "message"} size={14} />
        <span>{props.d.question}</span>
      </div>
      <Show when={loginUrl() !== undefined}>
        <button class="decision-login" onClick={openLogin}>
          <Icon name="globe" size={14} />
          <span>{tr("브라우저에서 로그인")}</span>
          <Show when={loginUrl()}>{(u) => <span class="muted">{u().replace(/^https?:\/\/(www\.)?/, "").split("?")[0]}</span>}</Show>
        </button>
      </Show>
      <Show when={props.showTask !== false && t()}>
        {(x) => (
          <button class="decision-src" onClick={() => openTask(x().id)}>
            {x().topic} / {x().title}
          </button>
        )}
      </Show>
      {/* inside the job's own thread its words are right above: only pictures sent with the question */}
      <Show when={(props.showTask !== false || props.d.context.length) && context().length}>
        <div class="decision-ctx"><For each={context()}>{(b) => <BlockView block={b} />}</For></div>
      </Show>
      {/* like Codex: the choices as a list, and a line to answer in your own words */}
      <div class="decision-list" role="listbox" tabIndex={0} onKeyDown={keys} ref={list}>
        <For each={props.d.options}>
          {(o, i) => (
            <button
              class="decision-opt"
              role="option"
              aria-selected={sel() === i()}
              classList={{ on: sel() === i(), primary: !!o.primary }}
              onClick={() => select(i())}
            >
              <span class="decision-n">{i() + 1}</span>
              <span class="decision-text">
                <span class="decision-label">{o.label}</span>
                <Show when={o.note}><span class="decision-note">{o.note}</span></Show>
              </span>
            </button>
          )}
        </For>
        <Show when={own_()}>
          <form
            class="decision-opt decision-own"
            classList={{ on: sel() === props.d.options.length }}
            onClick={(e) => e.target === e.currentTarget && select(props.d.options.length)}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <span class="decision-n">{props.d.options.length + 1}</span>
            <input
              ref={own}
              class="decision-input"
              placeholder={tr("다른 답")}
              aria-label={tr("다른 답")}
              value={typed()}
              onFocus={() => setSel(props.d.options.length)}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  const allowed = !ignoredKey(e) && noModifiers(e) && !shortcutOverlay();
                  e.preventDefault();
                  if (allowed) void submit();
                  return;
                }
                if (ignoredKey(e) || !noModifiers(e) || shortcutOverlay()) return;
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel(props.d.options.length - 1);
                  list.focus();
                }
              }}
            />
          </form>
        </Show>
      </div>
      {/* answers whatever is selected, a choice or what was typed: it belongs to the card, not a row */}
      <Show when={!props.d.ui}>
        <div class="decision-foot">
          <button class="btn sm decision-send" type="button" onClick={() => submit()} disabled={!ready()} title="↵">
            {tr("응답")}
          </button>
        </div>
      </Show>
    </div>
  );
}
