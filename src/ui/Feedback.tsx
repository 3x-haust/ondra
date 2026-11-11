// /feedback: what went wrong, in the user's words, with the app's version and its recent log
// (redacted). It goes to Ondra's maintainers only (lib/telemetry.ts), never anywhere public. A build
// that can't send it (no PostHog key, such as a fork's) has no /feedback.
import { createResource, createSignal, Show } from "solid-js";
import { Sheet } from "./Sheet";
import { logsRecent, osVersion } from "../lib/native";
import { flushLog, logInfo, redact } from "../lib/log";
import { canSendFeedback, sendFeedback, track } from "../lib/telemetry";
import { toast, view } from "../state/ui";
import { state } from "../state/store";
import { t } from "../i18n";

const [open, setOpen] = createSignal<string | null>(null);
/** Open the feedback sheet, with what was typed after /feedback. */
export const openFeedback = (text = "") => setOpen(text);

let version = "";
export const setFeedbackVersion = (v: string) => void (version = v);

/** /feedback, in a command list: none where this build can't send it. */
export const feedbackCommands = () =>
  canSendFeedback
    ? [
        {
          name: "feedback",
          get desc() {
            return t("피드백 보내기");
          },
          icon: "flag",
          run: (arg: string) => openFeedback(arg.trim()),
        },
      ]
    : [];

export function FeedbackHost() {
  return (
    <Show when={open() !== null}>
      <FeedbackSheet initial={open()!} onClose={() => setOpen(null)} />
    </Show>
  );
}

/** How things stand when the sheet opens, as the log's last line: the view and the jobs by state (no titles). */
function snapshot() {
  const by = new Map<string, number>();
  for (const x of state.tasks) if (!x.archived) by.set(x.status, (by.get(x.status) ?? 0) + 1);
  const v = view();
  return `opened in ${[v.name, "id" in v && v.id].filter(Boolean).join(" ")} · ${[...by].map(([s, n]) => `${s} ${n}`).join(" · ") || "no jobs"} · ${navigator.onLine ? "online" : "offline"}`;
}

function FeedbackSheet(props: { initial: string; onClose: () => void }) {
  const [text, setText] = createSignal(props.initial);
  const [withLog, setWithLog] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  // the log as it is when the sheet opens (what waits is written first)
  const [logs] = createResource(async () => (logInfo("feedback", snapshot()), flushLog(), await new Promise((r) => setTimeout(r, 150)), await logsRecent(48_000).catch(() => "")));
  const [os] = createResource(() => osVersion().catch(() => "macOS"), { initialValue: "macOS" });
  const where = () => `view: ${view().name}`;
  /** what goes, as the user can read it before sending */
  const preview = () => [redact(text().trim()), "", "---", `Ondra ${version || "?"} · ${os()} · ${where()}`, ...(withLog() && logs()?.trim() ? ["", logs()!.trim()] : [])].join("\n");
  const send = async () => {
    if (!text().trim() || busy()) return;
    setBusy(true);
    logInfo("feedback", "sending");
    track("feedback_sent", { with_log: withLog() });
    try {
      await sendFeedback(redact(text().trim()), { version, os: os(), where: where(), logs: withLog() ? logs() : undefined });
      props.onClose();
      toast(t("피드백을 보냈어요"));
    } catch {
      // the words stay in the sheet to send again
      toast(t("보내지 못했어요. 연결을 확인해 주세요."), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={t("피드백 보내기")}
      class="sk-sheet fb-sheet"
      onClose={props.onClose}
      foot={
        <>
          <span class="fb-note">{t("만드는 사람만 봐요. 로그의 키·토큰·이메일은 가려져요.")}</span>
          <span class="spacer" />
          <button class="btn" onClick={props.onClose}>{t("취소")}</button>
          <button class="btn primary" disabled={!text().trim() || busy()} onClick={() => void send()}>{busy() ? t("보내는 중") : t("보내기")}</button>
        </>
      }
    >
      <textarea
        class="fb-text"
        rows={6}
        placeholder={t("무슨 일이 있었나요? 어떻게 하다가 그랬는지도 적어 주세요.")}
        value={text()}
        ref={(el) => queueMicrotask(() => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)))}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void send());
        }}
      />
      <label class="fb-log">
        <input type="checkbox" checked={withLog()} onChange={(e) => setWithLog(e.currentTarget.checked)} />
        <span>{t("최근 로그 붙이기")}</span>
        <Show when={logs()}>{(l) => <span class="fb-count">{t("{n}줄", { n: l().trim().split("\n").length })}</span>}</Show>
      </label>
      <details class="fb-preview">
        <summary>{t("보낼 내용 보기")}</summary>
        <pre>{preview()}</pre>
      </details>
    </Sheet>
  );
}
