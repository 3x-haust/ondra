// What a turn cost and how much of the plan is left, kept right in the chat.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { AccountPicker } from "./AccountPicker";
import { limits, loadEmail, refreshLimits, windowLabel } from "../state/limits";
import { ctx } from "../state/ctx";
import { Icon } from "./Icon";
import type { Permission, Usage } from "../state/types";
import { tokens } from "./bits";
import { state } from "../state/store";
import { ContextSheet } from "../views/Context";

const promptOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
const cachePct = (u: Usage) => (promptOf(u) ? Math.round((u.cacheRead / promptOf(u)) * 100) : 0);

const secs = (ms: number) => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
};
const pct1 = (u: Usage) => (promptOf(u) ? Math.round((u.cacheRead / promptOf(u)) * 1000) / 10 : 0);

/** One quiet line under an answer: speed, cache hit, time; tokens and plan windows on hover. */
export function UsageLine(props: { u: Usage; lead?: string }) {
  const detail = () =>
    [
      `입력 ${tokens(promptOf(props.u))} (새로 ${tokens(props.u.input)} · 캐시 ${tokens(props.u.cacheRead)}${props.u.cacheWrite ? ` · 캐시 저장 ${tokens(props.u.cacheWrite)}` : ""})`,
      `출력 ${tokens(props.u.output)}`,
      ...(props.u.limits ?? []).map((l) => `${windowLabel(l.window)} ${l.used}%`),
    ].join(" · ");
  return (
    <div class="usage-line" title={detail()}>
      <Show when={props.lead}><span>{props.lead}</span></Show>
      <Show when={props.u.tps}><span>{props.u.tps} tok/s</span></Show>
      <span class="usage-cache" classList={{ low: cachePct(props.u) < 50, high: cachePct(props.u) >= 90 }}>캐시 {pct1(props.u)}%</span>
      <Show when={props.u.ms}><span>{secs(props.u.ms!)}</span></Show>
      <span class="usage-tok">입력 {tokens(promptOf(props.u))} · 출력 {tokens(props.u.output)}</span>
    </div>
  );
}

const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}분`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간` : `${Math.round(h / 24)}일`;
};

/** Live plan windows for an account, under the input. */
export function LimitBar(props: { accountId: string }) {
  onMount(() => void refreshLimits(props.accountId));
  const timer = setInterval(() => void refreshLimits(props.accountId), 5 * 60_000);
  onCleanup(() => clearInterval(timer));
  const list = () => limits[props.accountId] ?? [];
  return (
    <Show when={list().length}>
      <div class="limit-bar">
        <For each={list()}>
          {(l) => (
            <span class="limit" classList={{ hot: l.used >= 80 }} title={l.resetsAt ? `${left(l.resetsAt - Date.now())} 뒤 다시 채워져요` : undefined}>
              <span class="limit-name">{windowLabel(l.window)}</span>
              <span class="limit-track"><i style={{ width: `${Math.min(100, l.used)}%` }} /></span>
              <span class="limit-num">{Math.round(l.used)}%</span>
              <Show when={l.resetsAt}><span class="limit-reset">{left(l.resetsAt! - Date.now())} 뒤</span></Show>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * The status line under an input, like a terminal agent's footer:
 * account · plan windows · context used · permission · shells · branch.
 */
export function StatusLine(props: { accountId: string; space?: string; onAccount?: (id: string) => void; running?: boolean; agent?: string; permission?: Permission; shells?: number; branch?: string; onCompact?: () => void; last?: Usage }) {
  onMount(() => {
    void refreshLimits(props.accountId);
    void loadEmail(props.accountId);
  });
  const timer = setInterval(() => void refreshLimits(props.accountId), 5 * 60_000);
  onCleanup(() => clearInterval(timer));
  const list = () => limits[props.accountId] ?? [];
  const c = () => (props.agent ? ctx[props.agent] : undefined);
  const [ctxOpen, setCtxOpen] = createSignal(false);
  return (
    <div class="status-line">
      <Show when={state.accounts.find((a) => a.id === props.accountId)}>
        {(a) => <AccountPicker accountId={a().id} space={props.space ?? a().space} onPick={props.onAccount} running={props.running} />}
      </Show>
      <For each={list()}>
        {(l) => (
          <span class="st-lim" classList={{ hot: l.used >= 80 }} title={l.resetsAt ? `${left(l.resetsAt - Date.now())} 뒤 다시 채워져요` : undefined}>
            {l.window >= 10080 ? "7d" : l.window >= 1440 ? `${Math.round(l.window / 1440)}d` : `${Math.round(l.window / 60)}h`} {Math.round(l.used)}%
          </span>
        )}
      </For>
      <Show when={props.agent}>
        <button
          class="st-ctx"
          classList={{ hot: (c()?.percent ?? 0) >= 70 }}
          title={c() ? `대화 길이 ${tokens(c()!.tokens)}/${tokens(c()!.window)} · 누르면 모델이 받는 내용을 보여줘요` : "누르면 모델이 받는 내용을 보여줘요"}
          onClick={() => setCtxOpen(true)}
        >
          <Show when={c()} fallback="컨텍스트">
            {(x) => <>{tokens(x().tokens)} ({x().percent < 1 ? x().percent.toFixed(1) : Math.round(x().percent)}%)</>}
          </Show>
        </button>
        <Show when={ctxOpen()}>
          <ContextSheet agent={props.agent!} accountId={props.accountId} known={c() ? { tokens: c()!.tokens, window: c()!.window } : undefined} onClose={() => setCtxOpen(false)} />
        </Show>
      </Show>
      <Show when={props.shells}><span class="st-sh">셸 {props.shells}</span></Show>
      <Show when={props.branch}><span class="st-br" title="이 일의 브랜치"><Icon name="branch" size={11} />{props.branch}</span></Show>
    </div>
  );
}
