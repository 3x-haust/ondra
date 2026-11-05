// A question a task is waiting on, with its answers as buttons.
import { createSignal, For, Show } from "solid-js";
import { taskById } from "../state/store";
import type { Block, Decision } from "../state/types";
import { openTask } from "../state/ui";
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
  // the recommended choice starts selected; ↑↓ move, a number or Enter answers
  const [sel, setSel] = createSignal(Math.max(0, props.d.options.findIndex((o) => o.primary)));
  let own!: HTMLInputElement;
  let list!: HTMLDivElement;
  const count = () => props.d.options.length + (props.d.ui ? 0 : 1);
  const pick = (i: number) => {
    if (i < props.d.options.length) void decide(props.d.id, props.d.options[i].id);
    else own?.focus();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = (sel() + (e.key === "ArrowDown" ? 1 : -1) + count()) % count();
      setSel(n);
      if (n === props.d.options.length) own?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel());
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= count()) {
      e.preventDefault();
      setSel(Number(e.key) - 1);
      pick(Number(e.key) - 1);
    }
  };
  return (
    <div class="decision" classList={{ stalled: props.d.kind === "stalled" }}>
      <div class="decision-q">
        <Icon name={props.d.kind === "stalled" ? "pause" : "message"} size={14} />
        <span>{props.d.question}</span>
      </div>
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
              onMouseEnter={() => setSel(i())}
              onClick={() => decide(props.d.id, o.id)}
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
            onSubmit={(e) => {
              e.preventDefault();
              const v = own.value.trim();
              if (v) void decide(props.d.id, v);
            }}
          >
            <span class="decision-n">{props.d.options.length + 1}</span>
            <input
              ref={own}
              class="decision-input"
              placeholder="직접 입력"
              onFocus={() => setSel(props.d.options.length)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel(props.d.options.length - 1);
                  list.focus();
                }
              }}
            />
            <button class="decision-send" type="submit" aria-label="보내기">
              <Icon name="send" size={13} />
            </button>
          </form>
        </Show>
      </div>
    </div>
  );
}
