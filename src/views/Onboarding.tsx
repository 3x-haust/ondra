// First launch: bring over what other agent tools already have, check the
// login, and ask macOS for the two permissions — then get out of the way.
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { setState, state, updateAccount } from "../state/store";
import { importFrom, scan, scanning, sources } from "../engine/importer";
import { engine } from "../engine/rpc";
import { accountProviders, openPrivacySettings, requestAccessibility, toolStatus } from "../lib/native";
import { appName } from "../lib/brand";
import { Icon } from "../ui/Icon";
import { LoginSheet } from "./Settings";
import { t } from "../i18n";

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
    setImported(t("지침 {r} · 스킬 {s} · 메모리 {m} 가져옴", { r: r.rules, s: r.skills, m: r.memories }));
  };

  const finish = () => setState("onboarded", true);
  const allowed = () => !!status()?.accessibility && !!status()?.screenRecording;

  return (
    <div class="onb">
      <div class="onb-drag" data-tauri-drag-region />
      <div class="onb-card">
        <h1>{t("{name} 시작하기", { name: appName() })}</h1>

        <div class="onb-steps">
          <div class="onb-step" classList={{ ok: !!imported() }}>
            <span class="n">{imported() ? <Icon name="check" size={12} stroke={2.5} /> : 1}</span>
            <div class="onb-step-main">
              <b>{t("가져오기")}</b>
              <p>
                <Show when={!scanning()} fallback={t("찾는 중")}>
                  <Show when={found().length} fallback={t("가져올 항목 없음")}>
                    <Show
                      when={imported()}
                      fallback={<>{found().map((s) => s.name).join(", ")} · {t("지침 {r} · 스킬 {s} · 메모리 {m} · 세션 {n}", { r: counts().rules, s: counts().skills, m: counts().memories, n: counts().sessions })}</>}
                    >
                      {imported()}
                    </Show>
                  </Show>
                </Show>
              </p>
            </div>
            <Show when={found().length && !imported()}>
              <button class="btn sm" onClick={doImport}>{t("가져오기")}</button>
            </Show>
          </div>

          <div class="onb-step" classList={{ ok: loggedIn() }}>
            <span class="n">{loggedIn() ? <Icon name="check" size={12} stroke={2.5} /> : 2}</span>
            <div class="onb-step-main">
              <b>{t("모델 계정")}</b>
              <p>{loggedIn() ? state.accounts.flatMap((a) => a.providers).join(", ") : "Claude · ChatGPT · API"}</p>
            </div>
            <Show when={!loggedIn()}>
              <button class="btn sm" onClick={() => setLogin(true)} disabled={!engine.ready}>{t("로그인")}</button>
            </Show>
          </div>

          <div class="onb-step" classList={{ ok: allowed() }}>
            <span class="n">{allowed() ? <Icon name="check" size={12} stroke={2.5} /> : 3}</span>
            <div class="onb-step-main">
              <b>{t("앱 제어 권한")}</b>
            </div>
            <div class="onb-acts">
              <Show when={!status()?.accessibility}>
                <button class="btn sm" onClick={async () => { await requestAccessibility(); openPrivacySettings("accessibility"); }}>{t("손쉬운 사용")}</button>
              </Show>
              <Show when={!status()?.screenRecording}>
                <button class="btn sm" onClick={() => openPrivacySettings("screen")}>{t("화면 기록")}</button>
              </Show>
            </div>
          </div>
        </div>

        <div class="onb-foot">
          <button class="btn primary" onClick={finish}>{t("시작")}</button>
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
