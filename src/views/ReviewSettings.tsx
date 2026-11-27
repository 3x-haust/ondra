// Settings › 코드 리뷰: the models that review a change together, per workspace (each on that
// workspace's own accounts). Each reads it through both lenses (설계 검토, 코드 검토) and the job
// gets their findings merged: where they agree first, where they differ checked once. None set:
// the job's own model, as before. Laid out like the account list: one row per reviewer.
import { createSignal, For, Index, Show } from "solid-js";
import { setState, state, ownSpaces } from "../state/store";
import type { Account, Reviewer, SpaceId } from "../state/types";
import { reviewersFor } from "../engine/crosscheck";
import { accountName } from "../ui/AccountPicker";
import { ModelPicker } from "../ui/ModelPicker";
import { Logo } from "../ui/Logos";
import { Icon } from "../ui/Icon";
import { GroupTitle } from "./Settings";
import { t } from "../i18n";

/** at most this many models on one review (each runs both lenses) */
const MAX = 3;

/** the service an account logs in to, for its mark */
const brand = (a?: Account) => {
  const p = a?.providers[0] ?? "";
  return /anthropic|claude/.test(p) ? "claude" : /codex|chatgpt|openai/.test(p) ? "openai" : /gemini|google/.test(p) ? "googlegemini" : /copilot/.test(p) ? "githubcopilot" : "";
};

export function ReviewSettings() {
  const [space, setSpace] = createSignal<SpaceId>(state.space);
  // the workspace's own accounts that have models
  const accounts = () => state.accounts.filter((a) => a.space === space() && a.providers.length > 0);
  const list = () => reviewersFor(space());
  const save = (next: Reviewer[]) => setState("settings", "reviewersBySpace", (m) => ({ ...(m ?? {}), [space()]: next }));
  const at = (i: number, r: Reviewer) => save(list().map((x, j) => (j === i ? r : x)));
  const add = (id: string) => {
    const a = state.accounts.find((x) => x.id === id);
    if (a) save([...list(), { account: a.id, model: a.model || "" }]);
  };
  return (
    <>
      <GroupTitle title={t("코드 리뷰")}>
        <Show when={ownSpaces().length > 1}>
          <div class="seg sm">
            <For each={ownSpaces()}>{(s) => <button classList={{ on: space() === s.id }} onClick={() => setSpace(s.id)}>{s.label}</button>}</For>
          </div>
        </Show>
      </GroupTitle>
      {/* its pickers open past the group's edge: the group doesn't clip them */}
      <div class="set-group prov-list rv-list">
        <Show
          when={list().length}
          fallback={
            <div class="prov-row">
              <span class="prov-logo"><Icon name="check" size={16} /></span>
              <div class="prov-text">
                <span class="prov-title">{t("작업과 같은 모델")}</span>
                <span class="prov-sub">{t("여러 모델이 같은 변경을 리뷰하고, 결과를 합쳐서 고쳐요")}</span>
              </div>
            </div>
          }
        >
          <Index each={list()}>
            {/* by place, so changing a reviewer's model or effort keeps its row (and an open picker) */}
            {(r, i) => {
              const acc = () => state.accounts.find((a) => a.id === r().account);
              return (
                <div class="prov-row">
                  <span class="prov-logo">
                    <Show when={brand(acc())} fallback={<Icon name="key" size={16} />}>
                      <Logo name={brand(acc())} size={18} mono />
                    </Show>
                  </span>
                  <div class="prov-text">
                    <span class="prov-title">{acc() ? accountName(acc()!, true) : r().account}</span>
                    <span class="prov-sub">{t("설계 검토 · 코드 검토")}</span>
                  </div>
                  <span class="spacer" />
                  <ModelPicker accountId={r().account} model={r().model} thinking={r().thinking ?? ""} onChange={(m, e) => at(i, { account: r().account, model: m, ...(e ? { thinking: e } : {}) })} />
                  <button class="icon-btn sm prov-more" title={t("빼기")} aria-label={t("빼기")} onClick={() => save(list().filter((_, j) => j !== i))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              );
            }}
          </Index>
        </Show>
        <Show when={list().length < MAX && accounts().length}>
          <label class="prov-add ag-add">
            <Icon name="plus" size={15} />
            <span>{t("모델 추가")}</span>
            <select
              aria-label={t("모델 추가")}
              value=""
              onChange={(e) => {
                add(e.currentTarget.value);
                e.currentTarget.value = "";
              }}
            >
              <option value="" disabled>{t("모델 추가")}</option>
              <For each={accounts()}>{(a) => <option value={a.id}>{accountName(a, true)}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
    </>
  );
}
