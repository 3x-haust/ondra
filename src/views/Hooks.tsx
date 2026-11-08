// Settings › 훅: shell commands that run on agent events, like Claude Code hooks.
// Saved as JSON in the app's data folder; extensions/hooks.ts reads it in every job.
import { createSignal, For, onMount, Show } from "solid-js";
import { hooksLoad, hooksSave } from "../lib/native";
import { state, uid } from "../state/store";
import { toast } from "../state/ui";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";

export type HookEvent = "before_tool" | "after_tool" | "prompt" | "start" | "stop";
export interface Hook {
  id: string;
  event: HookEvent;
  /** tool names as a regular expression ("edit|write"); empty = every tool */
  matcher: string;
  command: string;
  enabled: boolean;
  /** only for jobs of this space; unset = every space */
  space?: string;
}

const EVENTS: { id: HookEvent; label: string }[] = [
  { id: "before_tool", label: "도구 쓰기 전" },
  { id: "after_tool", label: "도구 쓴 뒤" },
  { id: "prompt", label: "요청을 받을 때" },
  { id: "start", label: "일을 시작할 때" },
  { id: "stop", label: "답을 마쳤을 때" },
];
const forTools = (e: HookEvent) => e === "before_tool" || e === "after_tool";

export function HooksTab() {
  const [list, setList] = createSignal<Hook[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [more, setMore] = createSignal(false);
  onMount(async () => {
    try {
      const v = JSON.parse(await hooksLoad());
      setList(Array.isArray(v) ? v : []);
    } catch {
      setList([]);
    }
    setLoaded(true);
  });
  const save = (next: Hook[]) => {
    setList(next);
    hooksSave(JSON.stringify(next, null, 2)).catch((e) => toast(`저장하지 못했어요 · ${e}`, "bad"));
  };
  const patch = (id: string, p: Partial<Hook>) => save(list().map((h) => (h.id === id ? { ...h, ...p } : h)));
  const add = () => {
    save([...list(), { id: uid("hk"), event: "before_tool", matcher: "bash", command: "", enabled: true, space: state.space }]);
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLTextAreaElement>(".hk-cmd")].pop()?.focus());
  };

  return (
    <>
      <h2>훅</h2>
      <div class="set-group-title" style={{ display: "flex", "align-items": "center" }}>
        훅 목록
        <span class="spacer" />
        <button class="btn ghost sm" onClick={add}><Icon name="plus" size={13} />훅 추가</button>
      </div>
      <div class="set-group">
        <For each={list()} fallback={<div class="empty-line">{loaded() ? "훅 없음" : "불러오는 중"}</div>}>
          {(h) => (
            <div class="hk-row" classList={{ off: !h.enabled }}>
              <div class="hk-line">
                <select class="select" value={h.event} onChange={(e) => patch(h.id, { event: e.currentTarget.value as HookEvent })} aria-label="언제">
                  <For each={EVENTS}>{(ev) => <option value={ev.id}>{ev.label}</option>}</For>
                </select>
                <select class="select" value={h.space ?? ""} onChange={(e) => patch(h.id, { space: e.currentTarget.value || undefined })} aria-label="공간">
                  <option value="">모든 공간</option>
                  <For each={state.spaces}>{(sp) => <option value={sp.id}>{sp.label}</option>}</For>
                </select>
                <Show when={forTools(h.event)}>
                  <input
                    class="input hk-matcher"
                    placeholder="모든 도구"
                    title="여러 개는 edit|write"
                    value={h.matcher}
                    onChange={(e) => patch(h.id, { matcher: e.currentTarget.value.trim() })}
                    aria-label="도구"
                  />
                </Show>
              </div>
              <div class="hk-acts">
                <button class="switch" classList={{ on: h.enabled }} role="switch" aria-checked={h.enabled} title={h.enabled ? "끄기" : "켜기"} onClick={() => patch(h.id, { enabled: !h.enabled })}><i /></button>
                <button class="icon-btn" title="지우기" onClick={() => save(list().filter((x) => x.id !== h.id))}><Icon name="trash" size={14} /></button>
              </div>
              <textarea
                class="hk-cmd"
                rows={2}
                spellcheck={false}
                placeholder="실행할 명령"
                value={h.command}
                onChange={(e) => patch(h.id, { command: e.currentTarget.value })}
                aria-label="명령"
              />
            </div>
          )}
        </For>
      </div>
      <button class="hk-more" classList={{ on: more() }} onClick={() => setMore(!more())}>
        <Icon name="chevron" size={12} />
        명령에 넘어가는 값
      </button>
      <Fold open={more()}>
        <dl class="hk-doc">
          <dt>입력</dt>
          <dd><code>event</code> <code>cwd</code> <code>tool</code> <code>input</code> <code>output</code> <code>prompt</code></dd>
          <dt>환경 변수</dt>
          <dd><code>ONDRA_HOOK_EVENT</code> <code>ONDRA_TOOL_NAME</code></dd>
          <dt>막기</dt>
          <dd>도구 쓰기 전에 0이 아닌 값으로 끝나면 막아요</dd>
          <dt>시간</dt>
          <dd>60초</dd>
        </dl>
      </Fold>
    </>
  );
}
