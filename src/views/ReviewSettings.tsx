// Settings › 코드 리뷰: the model each review lens runs on. Two lenses read a change side by side
// (설계 검토, 코드 검토); on two different models one doesn't fixate where the other looks away.
import { For, Show } from "solid-js";
import { setState, state } from "../state/store";
import type { Reviewer } from "../state/types";
import { accountName } from "../ui/AccountPicker";
import { ModelPicker } from "../ui/ModelPicker";
import { GroupTitle, Row } from "./Settings";
import { t } from "../i18n";

const LENSES = [
  { id: "design", title: "설계 검토 모델", desc: "기획한 대로 만들었는지, 전체 설계를 봐요" },
  { id: "code", title: "코드 검토 모델", desc: "한 줄씩 보며 버그와 위험한 곳을 찾아요" },
] as const;

/** accounts with models, this workspace's first */
const accounts = () => state.accounts.filter((a) => a.providers.length > 0).sort((x, y) => Number(y.space === state.space) - Number(x.space === state.space));

export function ReviewSettings() {
  const set = (lens: "design" | "code", r: Reviewer | undefined) =>
    setState("settings", "reviewers", (now) => {
      const next = { ...(now ?? {}) };
      if (r) next[lens] = r;
      else delete next[lens];
      return next;
    });
  return (
    <>
      <GroupTitle title={t("코드 리뷰")} />
      <div class="set-group">
        <For each={LENSES}>
          {(l) => {
            const cur = () => state.settings.reviewers?.[l.id];
            return (
              <Row title={t(l.title)} desc={t(l.desc)}>
                <div class="set-inline">
                  <select
                    class="select"
                    aria-label={t(l.title)}
                    value={cur()?.account ?? ""}
                    onChange={(e) => {
                      const id = e.currentTarget.value;
                      const a = state.accounts.find((x) => x.id === id);
                      set(l.id, a ? { account: a.id, model: a.model || "" } : undefined);
                    }}
                  >
                    <option value="">{t("작업과 같은 모델")}</option>
                    <For each={accounts()}>{(a) => <option value={a.id}>{accountName(a, true)}</option>}</For>
                  </select>
                  <Show when={cur()}>
                    {(r) => (
                      <ModelPicker
                        accountId={r().account}
                        model={r().model}
                        thinking={r().thinking ?? ""}
                        onChange={(m, e) => set(l.id, { account: r().account, model: m, ...(e ? { thinking: e } : {}) })}
                      />
                    )}
                  </Show>
                </div>
              </Row>
            );
          }}
        </For>
      </div>
    </>
  );
}
