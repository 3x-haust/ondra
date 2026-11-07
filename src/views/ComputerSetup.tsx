import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  computerOpenSetupViewer, computerPrepare, computerRecover, computerStart, computerStatus,
  inTauri, pickFiles, type ComputerStatus,
} from "../lib/native";
import { state } from "../state/store";

const phases: Record<ComputerStatus["phase"], string> = {
  idle: "아직 준비하지 않았어요", preparing: "macOS를 설치하고 있어요", setup: "게스트 설정을 마쳐 주세요",
  starting: "공유 없이 새로 부팅하고 있어요", ready: "선택한 작업에 연결할 수 있어요",
  recovering: "이전 실행을 종료하고 복구하고 있어요", error: "연결 상태를 확인해 주세요", closed: "연결이 닫혔어요",
};

export function ComputerSetupPanel() {
  const [status, { refetch, mutate }] = createResource(computerStatus);
  const [image, setImage] = createSignal("");
  const [task, setTask] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const candidates = createMemo(() => state.tasks.filter(t => t.space === state.space && !t.archived &&
    (t.status === "paused" || t.status === "failed")));
  const selected = () => candidates().find(t => `t:${t.id}` === task());
  const busy = () => pending() || status.loading || !!status()?.busy;
  const bound = () => candidates().find(t => `t:${t.id}` === status()?.taskId);
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
      const paths = await pickFiles("게스트에 설치할 로컬 macOS IPSW 파일을 선택하세요");
      if (paths.length === 1 && paths[0].toLowerCase().endsWith(".ipsw")) { setImage(paths[0]); setError(""); }
      else if (paths.length) setError("IPSW 파일 하나를 선택해 주세요.");
    } catch { setError("설치 파일을 선택하지 못했어요."); }
  };
  return (
    <>
      <div class="set-group-title">격리 컴퓨터</div>
      <div class="set-group">
        <div class="set-row col">
          <div class="set-label">
            <b>{status() ? phases[status()!.phase] : "상태를 확인하고 있어요"}</b>
            <p>별도 macOS 안의 앱만 조작해요. 이 Mac의 열린 창과 로그인은 사용하지 않아요.</p>
            <p>준비 때만 전용 폴더를 읽기 전용으로 연결하고, 자동화 때는 공유를 제거해요.</p>
          </div>
          <Show when={unavailable()}><p class="desc">이 환경에서는 준비할 수 없어요. 컴퓨터 실행 자산이 포함된 macOS 앱이 필요해요.</p></Show>
          <Show when={error() || status()?.error || status.error}>
            <p class="desc" role="alert">{error() || status()?.error || "상태를 불러오지 못했어요."}</p>
          </Show>
          <button class="btn sm ghost" disabled={busy()} onClick={() => void refetch()}>상태 새로고침</button>
        </div>
        <Show when={!status()?.prepared}>
          <div class="set-row col">
            <label class="set-label" for="computer-restore-image"><b>로컬 macOS 설치 파일</b></label>
            <input id="computer-restore-image" class="input" value={image()} readOnly placeholder=".ipsw 파일을 선택하세요" />
            <div class="set-value">
              <button class="btn sm" disabled={busy() || unavailable()} onClick={() => void pickImage()}>파일 선택</button>
              <button class="btn sm" disabled={busy() || unavailable() || !image()} onClick={() => void run(() => computerPrepare({ restoreImage: image() }))}>새 게스트 준비</button>
            </div>
            <p class="desc">4코어 · 메모리 8 GiB · 디스크 64 GiB로 새로 설치해요. 다운로드는 하지 않아요. 앱을 종료하면 기존 게스트에 다시 연결할 수 없어요.</p>
          </div>
        </Show>
        <Show when={status()?.prepared}>
          <div class="set-row col">
            <div class="set-label">
              <b>최초 게스트 설정</b>
              <p>준비 창에서 macOS 설정을 마치고, 읽기 전용 준비 볼륨의 install-setup.sh를 게스트 Terminal에서 sudo /bin/bash로 실행해 주세요.</p>
              <p>게스트 전용 계정에 로그인하고 접근성·화면 기록 권한을 승인해 주세요. 호스트 권한은 바꾸지 않아요. 무인 부팅에는 게스트 자동 로그인이 필요해요.</p>
            </div>
            <button class="btn sm" disabled={busy() || status()?.phase !== "setup"} onClick={() => void run(computerOpenSetupViewer)}>준비 창 열기</button>
          </div>
          <div class="set-row col">
            <label class="set-label" for="computer-task"><b>연결할 작업</b></label>
            <select id="computer-task" class="select" value={task()} disabled={busy() || !!status()?.taskId} onChange={e => setTask(e.currentTarget.value)}>
              <option value="">일시정지한 작업을 선택하세요</option>
              <For each={candidates()}>{t => <option value={`t:${t.id}`}>{t.title}</option>}</For>
            </select>
            <Show when={status()?.taskId}><p class="desc">연결 작업: {state.tasks.find(t => t.space === state.space && `t:${t.id}` === status()?.taskId)?.title ?? "다른 공간의 작업"}</p></Show>
            <p class="desc">작업을 먼저 일시정지해 주세요. 시작·복구는 게스트를 재부팅해요. 연결한 뒤 해당 작업의 ‘다시 시작’을 눌러 새 엔진으로 진행해 주세요.</p>
            <div class="set-value">
              <button class="btn sm" disabled={busy() || status()?.phase !== "setup" || !(status()?.taskId ? bound() : selected())} onClick={() => void run(() => computerStart(status()?.taskId ?? task()))}>자동화 시작</button>
              <button class="btn sm" disabled={busy() || status()?.phase === "setup" || !status()?.taskId || !bound()} onClick={() => void run(() => computerRecover(status()!.taskId!))}>연결 복구</button>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}
