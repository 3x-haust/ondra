// Settings › 훅: shell commands that run on agent events, like Claude Code hooks.
// Saved as JSON in the app's data folder; extensions/hooks.ts reads it in every job.
import { createSignal, For, onMount, Show } from "solid-js";
import { hooksLoad, hooksSave } from "../lib/native";
import { state, uid } from "../state/store";
import { toast } from "../state/ui";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";

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
  { id: "before_tool", label: "도구를 쓰기 전" },
  { id: "after_tool", label: "도구를 쓴 뒤" },
  { id: "prompt", label: "요청이 올 때" },
  { id: "start", label: "작업이 시작될 때" },
  { id: "stop", label: "답이 끝날 때" },
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
    hooksSave(JSON.stringify(next, null, 2)).catch((e) => toast(t("저장하지 못했어요 · {e}", { e: String(e) }), "bad"));
  };
  const patch = (id: string, p: Partial<Hook>) => save(list().map((h) => (h.id === id ? { ...h, ...p } : h)));
  // a new hook is empty and off; it turns on with its first command, and off when the command is cleared
  const setCommand = (h: Hook, command: string) => {
    const has = !!command.trim();
    patch(h.id, { command, enabled: has ? (h.command.trim() ? h.enabled : true) : false });
  };
  const add = () => {
    save([...list(), { id: uid("hk"), event: "before_tool", matcher: "", command: "", enabled: false, space: state.space }]);
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLTextAreaElement>(".hk-cmd")].pop()?.focus());
  };

  return (
    <>
      <div class="set-head">
        <h2>{t("훅")}</h2>
        <button class="btn ghost sm" onClick={add}><Icon name="plus" size={14} />{t("추가")}</button>
      </div>
      <div class="set-group">
        <For each={list()} fallback={<div class="empty-line">{loaded() ? t("훅 없음") : t("불러오는 중…")}</div>}>
          {(h) => (
            <div class="hk-row" classList={{ off: !h.enabled && !!h.command.trim() }}>
              <div class="hk-line">
                <label class="hk-field">
                  <span>{t("시점")}</span>
                  <select class="select" value={h.event} onChange={(e) => patch(h.id, { event: e.currentTarget.value as HookEvent })}>
                    <For each={EVENTS}>{(ev) => <option value={ev.id}>{t(ev.label)}</option>}</For>
                  </select>
                </label>
                <label class="hk-field">
                  <span>{t("워크스페이스|one")}</span>
                  <select class="select" value={h.space ?? ""} onChange={(e) => patch(h.id, { space: e.currentTarget.value || undefined })}>
                    <option value="">{t("전체")}</option>
                    <For each={state.spaces}>{(sp) => <option value={sp.id}>{t(sp.label)}</option>}</For>
                  </select>
                </label>
                <Show when={forTools(h.event)}>
                  <label class="hk-field">
                    <span>{t("도구|one")}</span>
                    <input
                      class="input hk-matcher"
                      placeholder={t("모든 도구")}
                      title={t("여러 개는 edit|write")}
                      value={h.matcher}
                      onChange={(e) => patch(h.id, { matcher: e.currentTarget.value.trim() })}
                    />
                  </label>
                </Show>
              </div>
              <div class="hk-acts">
                <button
                  class="switch"
                  classList={{ on: h.enabled }}
                  role="switch"
                  aria-checked={h.enabled}
                  disabled={!h.command.trim()}
                  title={h.enabled ? t("켜짐") : t("꺼짐")}
                  aria-label={h.enabled ? t("훅 켜짐") : t("훅 꺼짐")}
                  onClick={() => patch(h.id, { enabled: !h.enabled })}
                ><i /></button>
                <button class="icon-btn" title={t("삭제")} aria-label={t("삭제")} onClick={() => save(list().filter((x) => x.id !== h.id))}><Icon name="trash" size={14} /></button>
              </div>
              <textarea
                class="hk-cmd"
                rows={2}
                spellcheck={false}
                placeholder={t("실행할 명령")}
                value={h.command}
                onChange={(e) => setCommand(h, e.currentTarget.value)}
                aria-label={t("실행할 명령")}
              />
            </div>
          )}
        </For>
      </div>
      <button class="hk-more" classList={{ on: more() }} onClick={() => setMore(!more())}>
        <Icon name="chevron" size={12} />
        {t("훅에 넘기는 값")}
      </button>
      <Fold open={more()}>
        <dl class="hk-doc">
          <dt>{t("입력")}</dt>
          <dd><code>event</code> <code>cwd</code> <code>tool</code> <code>input</code> <code>output</code> <code>prompt</code></dd>
          <dt>{t("환경 변수")}</dt>
          <dd><code>ONDRA_HOOK_EVENT</code> <code>ONDRA_TOOL_NAME</code></dd>
          <dt>{t("차단")}</dt>
          <dd>{t("도구를 쓰기 전 훅이 0이 아닌 코드로 끝나면 그 도구를 막아요")}</dd>
          <dt>{t("제한 시간")}</dt>
          <dd>{t("60초")}</dd>
        </dl>
      </Fold>
    </>
  );
}
