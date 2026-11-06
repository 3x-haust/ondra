// Settings › 훅: shell commands that run on agent events, like Claude Code hooks.
// Saved as JSON in the app's data folder; extensions/hooks.ts reads it in every job.
import { createSignal, For, onMount, Show } from "solid-js";
import { hooksLoad, hooksSave } from "../lib/native";
import { state, uid } from "../state/store";
import { toast } from "../state/ui";
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

const EVENTS: { id: HookEvent; label: string; help: string }[] = [
  { id: "before_tool", label: "도구 쓰기 전", help: "0이 아닌 값으로 끝나면 그 호출을 막고, stderr를 이유로 알려줘요." },
  { id: "after_tool", label: "도구 쓴 뒤", help: "0이 아닌 값으로 끝나면 stderr를 결과에 붙여 모델에게 보여줘요." },
  { id: "prompt", label: "요청을 받을 때", help: "stdout에 쓴 내용이 요청 뒤에 붙어요." },
  { id: "start", label: "일을 시작할 때", help: "결과를 기다리지 않아요." },
  { id: "stop", label: "답을 마쳤을 때", help: "결과를 기다리지 않아요." },
];
const forTools = (e: HookEvent) => e === "before_tool" || e === "after_tool";

export function HooksTab() {
  const [list, setList] = createSignal<Hook[]>([]);
  const [loaded, setLoaded] = createSignal(false);
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
        <For each={list()} fallback={<div class="empty-line">{loaded() ? "아직 훅이 없어요" : "불러오는 중이에요"}</div>}>
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
                    title="도구 이름. 여러 개는 edit|write 처럼 써요"
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
                placeholder={h.event === "before_tool" ? `jq -e '.input.command | test("rm -rf") | not' >/dev/null || { echo "rm -rf는 안 돼요" >&2; exit 1; }` : "셸 명령"}
                value={h.command}
                onChange={(e) => patch(h.id, { command: e.currentTarget.value })}
                aria-label="명령"
              />
            </div>
          )}
        </For>
      </div>
      <div class="set-group-title">명령이 받는 것</div>
      <div class="hk-doc">
        표준 입력으로 JSON을 받아요: <code>event</code>, <code>cwd</code>, <code>tool</code>, <code>input</code> (도구 입력), <code>output</code> (도구 쓴 뒤), <code>prompt</code> (요청을 받을 때).
        환경 변수 <code>ONDRA_HOOK_EVENT</code>, <code>ONDRA_TOOL_NAME</code>도 있어요. 작업 폴더에서 <code>/bin/sh</code>로 실행하고, 60초가 지나면 멈춰요.
      </div>
    </>
  );
}
