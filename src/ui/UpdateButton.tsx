// A newer version at the window's top left (as Codex has it). While it downloads, a ring around the
// button fills with the download and the percent counts up beside it; once it's in, the button turns
// solid blue. A press restarts into it (right after the download if it's still coming), or, while jobs
// are at work, once they end (a second press doesn't wait).
import { Show } from "solid-js";
import { available, installNow, jobsWorking, restartQueued, restartWhenIdle, updateProgress, updateReady, updateStatus } from "../engine/update";
import { Icon } from "./Icon";
import { t } from "../i18n";

const R = 9.5;
const RING = 2 * Math.PI * R;

export function UpdateButton() {
  const busy = () => updateStatus() === "installing";
  /** still coming down: the percent, or -1 while its size is unknown */
  const loading = () => !updateReady() && updateProgress() !== null;
  const pct = () => Math.max(0, Math.min(100, updateProgress() ?? 0));
  const version = () => updateReady() ?? available() ?? "";
  const label = () =>
    loading()
      ? updateProgress()! < 0
        ? t("{v} 받는 중", { v: version() })
        : t("{v} 받는 중 · {p}%", { v: version(), p: pct() })
      : busy()
        ? t("업데이트하는 중")
        : restartQueued()
          ? t("작업이 끝나면 {v}로 다시 시작해요 · 누르면 지금", { v: version() })
          : jobsWorking()
            ? t("{v}로 업데이트 · 작업이 끝나면 다시 시작해요", { v: version() })
            : t("{v}로 업데이트 · 다시 시작해요", { v: version() });
  const press = () => {
    if (busy()) return;
    if (restartQueued() || !jobsWorking()) return void installNow();
    restartWhenIdle();
  };
  return (
    <Show when={updateReady() || loading() || busy()}>
      <span class="update-wrap">
        <button
          class="update-btn"
          classList={{ loading: loading(), waiting: restartQueued(), busy: busy() }}
          title={label()}
          aria-label={label()}
          disabled={busy() && !loading()}
          onClick={press}
        >
          <Show when={loading()}>
            <svg class="update-ring" viewBox="0 0 22 22" aria-hidden="true">
              <circle class="track" cx="11" cy="11" r={R} />
              <circle class="arc" cx="11" cy="11" r={R} style={{ "stroke-dasharray": `${RING}`, "stroke-dashoffset": `${RING * (1 - pct() / 100)}` }} />
            </svg>
          </Show>
          <Icon name={restartQueued() ? "clock" : "download"} size={13} stroke={2.4} />
        </button>
        <Show when={loading() && updateProgress()! >= 0}>
          <span class="update-pct" aria-hidden="true">{pct()}%</span>
        </Show>
      </span>
    </Show>
  );
}
