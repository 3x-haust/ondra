import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  computerOpenSetupViewer, computerPrepare, computerRecover, computerStart, computerStatus,
  inTauri, pickFiles, type ComputerStatus,
} from "../lib/native";
import { state } from "../state/store";
import { t } from "../i18n";

/** shown with t() */
const phases: Record<ComputerStatus["phase"], string> = {
  idle: "준비 안 됨", preparing: "macOS 설치 중", setup: "게스트 설정 필요",
  stopped: "게스트 꺼짐", starting: "부팅 중", ready: "연결 가능",
  recovering: "복구 중", error: "연결 확인 필요", closed: "연결 닫힘",
};

export function ComputerSetupPanel() {
  const [status, { refetch, mutate }] = createResource(computerStatus);
  const [image, setImage] = createSignal("");
  const [task, setTask] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const candidates = createMemo(() => state.tasks.filter(x => x.space === state.space && !x.archived &&
    (x.status === "paused" || x.status === "failed")));
  const selected = () => candidates().find(x => `t:${x.id}` === task());
  const busy = () => pending() || status.loading || !!status()?.busy;
  const bound = () => candidates().find(x => `t:${x.id}` === status()?.taskId);
  const unavailable = () => !inTauri || status()?.error === "COMPUTER_UNSUPPORTED" || !!status.error;
  const run = async (action: () => Promise<ComputerStatus>) => {
    if (busy()) return;
    setPending(true);
    setError("");
    try { mutate(await action()); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setPending(false); await refetch(); }
  };
  const pickImage = async () => {
    try {
      const paths = await pickFiles(t("macOS IPSW 파일 선택"));
      if (paths.length === 1 && paths[0].toLowerCase().endsWith(".ipsw")) { setImage(paths[0]); setError(""); }
      else if (paths.length) setError(t("IPSW 파일 하나를 선택하세요"));
    } catch { setError(t("파일을 선택하지 못했어요")); }
  };
  return (
    <>
      <div class="set-group-title">{t("격리 컴퓨터")}</div>
      <div class="set-group">
        <div class="set-row col">
          <div class="set-label">
            <b>{status() ? t(phases[status()!.phase]) : t("상태 확인 중")}</b>
          </div>
          <Show when={unavailable()}><p class="desc">{t("macOS 앱에서만 쓸 수 있어요")}</p></Show>
          <Show when={error() || status()?.error || status.error}>
            <p class="desc" role="alert">{error() || status()?.error || t("상태를 불러오지 못했어요")}</p>
          </Show>
          <button class="btn sm ghost" disabled={busy()} onClick={() => void refetch()}>{t("새로고침")}</button>
        </div>
        <Show when={!status()?.prepared}>
          <div class="set-row col">
            <label class="set-label" for="computer-restore-image"><b>{t("macOS 설치 파일")}</b></label>
            <input id="computer-restore-image" class="input" value={image()} readOnly placeholder=".ipsw" />
            <div class="set-value">
              <button class="btn sm" disabled={busy() || unavailable()} onClick={() => void pickImage()}>{t("파일 선택")}</button>
              <button class="btn sm" disabled={busy() || unavailable() || !image()} onClick={() => void run(() => computerPrepare({ restoreImage: image() }))}>{t("게스트 준비")}</button>
            </div>
            <p class="desc">{t("4코어 · 메모리 8 GiB · 디스크 64 GiB")}</p>
          </div>
        </Show>
        <Show when={status()?.prepared}>
          <div class="set-row col">
            <div class="set-label">
              <b>{t("게스트 설정")}</b>
              <p>{t("준비 창에서 macOS 설정을 마치고 install-setup.sh를 sudo로 실행하세요.")}</p>
            </div>
            <button class="btn sm" disabled={busy() || status()?.phase !== "setup"} onClick={() => void run(computerOpenSetupViewer)}>{t("준비 창 열기")}</button>
          </div>
          <div class="set-row col">
            <label class="set-label" for="computer-task"><b>{t("연결할 작업")}</b></label>
            <select id="computer-task" class="select" value={task()} disabled={busy() || !!status()?.taskId} onChange={e => setTask(e.currentTarget.value)}>
              <option value="">{t("일시정지한 작업 선택")}</option>
              <For each={candidates()}>{x => <option value={`t:${x.id}`}>{x.title}</option>}</For>
            </select>
            <Show when={status()?.taskId}><p class="desc">{t("연결됨: {title}", { title: state.tasks.find(x => x.space === state.space && `t:${x.id}` === status()?.taskId)?.title ?? t("다른 워크스페이스의 작업") })}</p></Show>
            <div class="set-value">
              <button class="btn sm" disabled={busy() || (status()?.phase !== "setup" && status()?.phase !== "stopped") || !(status()?.taskId ? bound() : selected())} onClick={() => void run(() => computerStart(status()?.taskId ?? task()))}>{t("자동화 시작")}</button>
              <button class="btn sm" disabled={busy() || status()?.phase === "setup" || !status()?.taskId || !bound()} onClick={() => void run(() => computerRecover(status()!.taskId!))}>{t("연결 복구")}</button>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}
