// The newer version, downloaded and ready: one blue button at the window's top left (as Codex has it).
// A press restarts into it, or, while jobs are at work, once they end (a second press doesn't wait).
import { Show } from "solid-js";
import { installNow, jobsWorking, restartQueued, restartWhenIdle, updateReady, updateStatus } from "../engine/update";
import { Icon } from "./Icon";
import { t } from "../i18n";

export function UpdateButton() {
  const busy = () => updateStatus() === "installing";
  const label = () =>
    busy()
      ? t("업데이트하는 중")
      : restartQueued()
        ? t("작업이 끝나면 {v}로 다시 시작해요 · 누르면 지금", { v: updateReady() ?? "" })
        : jobsWorking()
          ? t("{v}로 업데이트 · 작업이 끝나면 다시 시작해요", { v: updateReady() ?? "" })
          : t("{v}로 업데이트 · 다시 시작해요", { v: updateReady() ?? "" });
  const press = () => {
    if (busy()) return;
    if (restartQueued() || !jobsWorking()) return void installNow();
    restartWhenIdle();
  };
  return (
    <Show when={updateReady() || busy()}>
      <button class="update-btn" classList={{ waiting: restartQueued(), busy: busy() }} title={label()} aria-label={label()} disabled={busy()} onClick={press}>
        <Icon name={restartQueued() ? "clock" : "download"} size={13} stroke={2.4} />
      </button>
    </Show>
  );
}
