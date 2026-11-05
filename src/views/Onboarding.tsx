// First launch: bring over what other agent tools already have, check the
// login, and ask macOS for the two permissions — then get out of the way.
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { setState, state, updateAccount } from "../state/store";
import { toast } from "../state/ui";
import { importFrom, scan, scanning, sources } from "../engine/importer";
import { engine } from "../engine/rpc";
import { accountProviders, openPrivacySettings, requestAccessibility, toolStatus } from "../lib/native";
import { appName } from "../lib/brand";
import { Icon } from "../ui/Icon";
import { LoginSheet } from "./Settings";

export function Onboarding() {
  const [status, { refetch }] = createResource(toolStatus);
  const [login, setLogin] = createSignal(false);
  const [imported, setImported] = createSignal<string | null>(null);
  const timer = setInterval(() => !document.hidden && refetch(), 2500);
  onCleanup(() => clearInterval(timer));

  const refreshLogin = async () => {
    const p = await accountProviders("default");
    updateAccount("default", (a) => (a.providers = p));
  };
  onMount(() => {
    scan();
    refreshLogin();
  });

  const found = () => sources().filter((s) => s.found);
  const loggedIn = () => state.accounts.some((a) => a.providers.length);
  const counts = () =>
    found().reduce((n, s) => ({ rules: n.rules + s.rules.length, skills: n.skills + s.skills.length, memories: n.memories + s.memories.length, sessions: n.sessions + s.sessions.length }), {
      rules: 0,
      skills: 0,
      memories: 0,
      sessions: 0,
    });

  const doImport = () => {
    const r = importFrom(found(), { rules: true, skills: true, memories: true });
    setImported(`지시 ${r.rules} · 스킬 ${r.skills} · 기억 ${r.memories} 가져옴`);
  };

  const finish = () => {
    setState("onboarded", true);
    toast(`${appName()} 준비 완료`);
  };

  return (
    <div class="onb">
      <div class="onb-drag" data-tauri-drag-region />
      <div class="onb-card">
        <h1>{appName()} 시작하기</h1>

        <div class="onb-steps">
          <div class="onb-step" classList={{ ok: !!imported() }}>
            <span class="n">{imported() ? <Icon name="check" size={11} stroke={3} /> : 1}</span>
            <div class="onb-step-main">
              <b>쓰던 도구에서 가져오기</b>
              <Show when={!scanning()} fallback={<p>이 Mac을 살펴보는 중…</p>}>
                <Show when={found().length} fallback={<p>없음</p>}>
                  <p>
                    <For each={found()}>{(s, i) => <>{i() ? ", " : ""}{s.name}</>}</For>
                  </p>
                  <p>지시 {counts().rules} · 스킬 {counts().skills} · 기억 {counts().memories} · 세션 {counts().sessions}</p>
                  <Show when={imported()}><p>{imported()} — 하던 작업은 메인 화면에서 이어서 할 수 있어요.</p></Show>
                </Show>
              </Show>
            </div>
            <Show when={found().length && !imported()}>
              <button class="btn primary sm" onClick={doImport}>가져오기</button>
            </Show>
          </div>

          <div class="onb-step" classList={{ ok: loggedIn() }}>
            <span class="n">{loggedIn() ? <Icon name="check" size={11} stroke={3} /> : 2}</span>
            <div class="onb-step-main">
              <b>모델 계정</b>
              <p>{loggedIn() ? `로그인됨 · ${state.accounts.flatMap((a) => a.providers).join(", ")}` : "ChatGPT · Claude 구독이나 API 키로 로그인해요."}</p>
            </div>
            <Show when={!loggedIn()}>
              <button class="btn sm" onClick={() => setLogin(true)} disabled={!engine.ready}>로그인</button>
            </Show>
          </div>

          <div class="onb-step" classList={{ ok: !!status()?.accessibility && !!status()?.screenRecording }}>
            <span class="n">{status()?.accessibility && status()?.screenRecording ? <Icon name="check" size={11} stroke={3} /> : 3}</span>
            <div class="onb-step-main">
              <b>앱 조작 권한</b>
            </div>
            <div style={{ display: "flex", gap: "var(--s-6)" }}>
              <Show when={!status()?.accessibility}>
                <button class="btn sm" onClick={async () => { await requestAccessibility(); openPrivacySettings("accessibility"); }}>손쉬운 사용</button>
              </Show>
              <Show when={!status()?.screenRecording}>
                <button class="btn sm" onClick={() => openPrivacySettings("screen")}>화면 기록</button>
              </Show>
            </div>
          </div>
        </div>

        <div class="onb-foot">
          <span class="muted">어디서든 <kbd>⌥ Space</kbd>로 바로 요청할 수 있어요.</span>
          <span class="spacer" />
          <button class="btn primary" onClick={finish}>시작</button>
        </div>
      </div>
      <Show when={login()}>
        <LoginSheet
          accountId="default"
          onClose={() => {
            setLogin(false);
            refreshLogin();
          }}
        />
      </Show>
    </div>
  );
}
