// A question a task is waiting on, with its answers as buttons.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { taskById } from "../state/store";
import type { Block, Decision } from "../state/types";
import { openBrowser, openTask } from "../state/ui";
import { decide } from "../engine/tasks";
import { BlockView } from "./Blocks";
import { Icon } from "./Icon";

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
    return out.slice(-4);
  };
  // the recommended choice starts selected. Clicking, ↑↓ or a number only
  // selects; Enter or the send button answers (never on hover, never by accident)
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
  const [sel, setSel] = createSignal(Math.max(0, props.d.options.findIndex((o) => o.primary)));
  const [typed, setTyped] = createSignal("");
  let own!: HTMLInputElement;
  let list!: HTMLDivElement;
  const count = () => props.d.options.length + (props.d.ui ? 0 : 1);
  const select = (i: number) => {
    setSel(i);
    if (i === props.d.options.length) own?.focus();
    else list.focus();
  };
  const ready = () => sel() < props.d.options.length || !!typed().trim();
  const submit = () => {
    if (sel() < props.d.options.length) void decide(props.d.id, props.d.options[sel()].id);
    else if (typed().trim()) void decide(props.d.id, typed().trim());
    else own?.focus();
  };
  // a number pressed anywhere (not while typing) selects that choice and
  // brings the keyboard here, so Enter then answers
  const anywhere = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key) || Number(e.key) > count()) return;
    const el = document.activeElement as HTMLTextAreaElement | null;
    if (el && list.contains(el)) return; // handled by `keys`
    const typing = !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
    if (typing && !(el!.id === "task-input" && !el!.value)) return;
    if (document.querySelector('[role="dialog"]')) return;
    e.preventDefault();
    select(Number(e.key) - 1);
  };
  window.addEventListener("keydown", anywhere);
  onCleanup(() => window.removeEventListener("keydown", anywhere));
  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select((sel() + (e.key === "ArrowDown" ? 1 : -1) + count()) % count());
    } else if (e.key === "Enter" && !e.isComposing) {
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
          <span>브라우저 열어 로그인</span>
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
      <Show when={context().length}>
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
        <Show when={!props.d.ui}>
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
              placeholder="직접 입력"
              onFocus={() => setSel(props.d.options.length)}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => {
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
          <button class="decision-send" classList={{ ready: ready() }} type="button" onClick={() => submit()} disabled={!ready()}>
            보내기
            <kbd>Enter</kbd>
          </button>
        </div>
      </Show>
    </div>
  );
}
