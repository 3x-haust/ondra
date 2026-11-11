// /feedback: what went wrong, in the user's words, with the app's version and its recent log
// (redacted). It goes to Ondra's maintainers only (lib/telemetry.ts); ticked, it is filed as a public
// issue on Ondra's repository instead, with the user's GitHub CLI (without one, the new-issue page
// opens with it filled in).
import { createResource, createSignal, Show } from "solid-js";
import { Sheet } from "./Sheet";
import { feedbackIssue, logsRecent, openExternal, osVersion } from "../lib/native";
import { flushLog, logInfo, redact } from "../lib/log";
import { canSendFeedback, sendFeedback, track } from "../lib/telemetry";
import { issueBody, issueTitle } from "../lib/issue";
import { toast, view } from "../state/ui";
import { state } from "../state/store";
import { t } from "../i18n";

const REPO = "3x-haust/ondra";
const [open, setOpen] = createSignal<string | null>(null);
/** Open the feedback sheet, with what was typed after /feedback. */
export const openFeedback = (text = "") => setOpen(text);

let version = "";
export const setFeedbackVersion = (v: string) => void (version = v);

export const feedbackCommand = () => ({
  name: "feedback",
  get desc() {
    return t("피드백 보내기");
  },
  icon: "flag",
  run: (arg: string) => openFeedback(arg.trim()),
});

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
  const [asIssue, setAsIssue] = createSignal(!canSendFeedback);
  const [busy, setBusy] = createSignal(false);
  // the log as it is when the sheet opens (what waits is written first)
  const [logs] = createResource(async () => (logInfo("feedback", snapshot()), flushLog(), await new Promise((r) => setTimeout(r, 150)), await logsRecent(48_000).catch(() => "")));
  const [os] = createResource(() => osVersion().catch(() => "macOS"), { initialValue: "macOS" });
  const where = () => `view: ${view().name}`;
  const body = (max?: number) => issueBody(text(), { version, where: where(), os: os(), logs: withLog() ? logs() : undefined }, max);
  const sendPrivate = async () => {
    try {
      await sendFeedback(redact(text().trim()), { version, os: os(), where: where(), logs: withLog() ? logs() : undefined });
      props.onClose();
      toast(t("피드백을 보냈어요"));
    } catch {
      // the words stay in the sheet to send again
      toast(t("보내지 못했어요. 연결을 확인해 주세요."), "bad");
    }
  };
  const send = async () => {
    if (!text().trim() || busy()) return;
    setBusy(true);
    logInfo("feedback", "sending");
    track("feedback_sent", { to: asIssue() ? "github" : "private", with_log: withLog() });
    if (!asIssue()) return void (await sendPrivate(), setBusy(false));
    try {
      const url = await feedbackIssue(issueTitle(text()), body());
      props.onClose();
      toast(t("이슈를 올렸어요"), "info", url ? { label: t("열기"), run: () => void openExternal(url) } : undefined);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== "NO_GH") toast(why, "bad");
      // no GitHub CLI (or it failed): the new-issue page, filled in; a URL holds only so much log
      const u = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(issueTitle(text()))}&body=${encodeURIComponent(body(5_500))}`;
      void openExternal(u);
      props.onClose();
      toast(t("GitHub에서 이어서 올려 주세요"));
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
          <span class="fb-note">{asIssue() ? t("GitHub 공개 이슈로 올라가요. 로그의 키·토큰·이메일은 가려져요.") : t("만드는 사람만 봐요. 로그의 키·토큰·이메일은 가려져요.")}</span>
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
      <label class="fb-log" hidden={!canSendFeedback}>
        <input type="checkbox" checked={asIssue()} onChange={(e) => setAsIssue(e.currentTarget.checked)} />
        <span>{t("GitHub 공개 이슈로 올리기")}</span>
      </label>
      <details class="fb-preview">
        <summary>{t("보낼 내용 보기")}</summary>
        <pre>{body()}</pre>
      </details>
    </Sheet>
  );
}
