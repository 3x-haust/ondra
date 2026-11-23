// Settings › 코드 리뷰: the models that review a change together, per workspace (each on that
// workspace's own accounts). Each reads it through both lenses (설계 검토, 코드 검토) and the job
// gets their findings merged: where they agree first, where they differ checked once. None set:
// the job's own model, as before.
import { createSignal, For, Show } from "solid-js";
import { setState, state } from "../state/store";
import type { Reviewer, SpaceId } from "../state/types";
import { reviewersFor } from "../engine/crosscheck";
import { accountName } from "../ui/AccountPicker";
import { ModelPicker } from "../ui/ModelPicker";
import { Icon } from "../ui/Icon";
import { GroupTitle, Row } from "./Settings";
import { t } from "../i18n";

/** at most this many models on one review (each runs both lenses) */
const MAX = 3;

export function ReviewSettings() {
  const [space, setSpace] = createSignal<SpaceId>(state.space);
  // the workspace's own accounts that have models
  const accounts = () => state.accounts.filter((a) => a.space === space() && a.providers.length > 0);
  const list = () => reviewersFor(space());
  const save = (next: Reviewer[]) => setState("settings", "reviewersBySpace", (m) => ({ ...(m ?? {}), [space()]: next }));
  const at = (i: number, r: Reviewer) => save(list().map((x, j) => (j === i ? r : x)));
  const add = () => {
    // the next account not used yet, on its own model
    const used = new Set(list().map((r) => r.account));
    const a = accounts().find((x) => !used.has(x.id)) ?? accounts()[0];
    if (a) save([...list(), { account: a.id, model: a.model || "" }]);
  };
  return (
    <>
      <GroupTitle title={t("코드 리뷰")} />
      <div class="set-group">
        <Show when={state.spaces.length > 1}>
          <Row title={t("워크스페이스")}>
            <div class="seg">
              <For each={state.spaces}>{(s) => <button classList={{ on: space() === s.id }} onClick={() => setSpace(s.id)}>{s.label}</button>}</For>
            </div>
          </Row>
        </Show>
        <Show
          when={list().length}
          fallback={
            <Row title={t("함께 리뷰할 모델")} desc={t("여러 모델이 같은 변경을 리뷰하고, 결과를 합쳐서 고쳐요")}>
              <span class="set-quiet">{t("작업과 같은 모델")}</span>
            </Row>
          }
        >
          <For each={list()}>
            {(r, i) => (
              <Row title={i() ? "" : t("함께 리뷰할 모델")} desc={i() ? undefined : t("여러 모델이 같은 변경을 리뷰하고, 결과를 합쳐서 고쳐요")}>
                <div class="set-inline">
                  <select
                    class="select"
                    aria-label={t("AI 계정")}
                    value={r.account}
                    onChange={(e) => {
                      const a = state.accounts.find((x) => x.id === e.currentTarget.value);
                      if (a) at(i(), { account: a.id, model: a.model || "" });
                    }}
                  >
                    {/* one from another workspace (set before lists were per workspace) still shows what it is */}
                    <Show when={!accounts().some((a) => a.id === r.account)}>
                      <option value={r.account}>{accountName(state.accounts.find((a) => a.id === r.account) ?? { id: r.account, label: r.account } as never, true)}</option>
                    </Show>
                    <For each={accounts()}>{(a) => <option value={a.id}>{accountName(a, true)}</option>}</For>
                  </select>
                  <ModelPicker accountId={r.account} model={r.model} thinking={r.thinking ?? ""} onChange={(m, e) => at(i(), { account: r.account, model: m, ...(e ? { thinking: e } : {}) })} />
                  <button class="icon-btn sm" title={t("빼기")} aria-label={t("빼기")} onClick={() => save(list().filter((_, j) => j !== i()))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              </Row>
            )}
          </For>
        </Show>
        <Show when={list().length < MAX && accounts().length}>
          <Row title="">
            <button class="btn ghost sm" onClick={add}>
              {t("모델 추가")}
            </button>
          </Row>
        </Show>
      </div>
    </>
  );
}
