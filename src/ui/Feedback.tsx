// /feedback: what went wrong, in the user's words, filed as an issue on Ondra's repository with the
// app's version and its recent log (redacted). Sent with the user's GitHub CLI; without one, the
// new-issue page opens with it filled in.
import { createResource, createSignal, Show } from "solid-js";
import { Sheet } from "./Sheet";
import { feedbackIssue, logsRecent, openExternal, osVersion } from "../lib/native";
import { flushLog, logInfo } from "../lib/log";
import { issueBody, issueTitle } from "../lib/issue";
import { toast, view } from "../state/ui";
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
    return t("피드백 보내기 · GitHub 이슈");
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

function FeedbackSheet(props: { initial: string; onClose: () => void }) {
  const [text, setText] = createSignal(props.initial);
  const [withLog, setWithLog] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  // the log as it is when the sheet opens (what waits is written first)
  const [logs] = createResource(async () => (flushLog(), await new Promise((r) => setTimeout(r, 150)), await logsRecent(48_000).catch(() => "")));
  const [os] = createResource(() => osVersion().catch(() => "macOS"), { initialValue: "macOS" });
  const body = (max?: number) => issueBody(text(), { version, where: `view: ${view().name}`, os: os(), logs: withLog() ? logs() : undefined }, max);
  const send = async () => {
    if (!text().trim() || busy()) return;
    setBusy(true);
    logInfo("feedback", "sending");
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
          <span class="fb-note">{t("GitHub 공개 이슈로 올라가요. 로그의 키·토큰·이메일은 가려져요.")}</span>
          <span class="spacer" />
          <button class="btn" onClick={props.onClose}>{t("취소")}</button>
          <button class="btn primary" disabled={!text().trim() || busy()} onClick={() => void send()}>{busy() ? t("올리는 중") : t("보내기")}</button>
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
        <pre>{body()}</pre>
      </details>
    </Sheet>
  );
}
