// First launch, one thing per screen: what Ondra does, a model account, what other tools
// already have (only when something was found), the two macOS permissions, and the first
// request, sent to Main so a task is already running when the window opens.
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { setState, state, updateAccount } from "../state/store";
import { setView } from "../state/ui";
import { importFrom, scan, sources } from "../engine/importer";
import { throwThought } from "../engine/captain";
import { engine } from "../engine/rpc";
import { accountProviders, toolStatus, type ToolStatus } from "../lib/native";
import { askPermission } from "../lib/permissions";
import { appName } from "../lib/brand";
import { Icon } from "../ui/Icon";
import { GlyphMark } from "./Sidebar";
import { LoginSheet } from "./Login";
import { t } from "../i18n";

type StepId = "hello" | "account" | "import" | "access" | "ask";
type Pane = "accessibility" | "screen";

const quiet = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// a plain browser (vite) always reports both permissions granted; dev builds can show the other case
const [fakeStatus, setFakeStatus] = createSignal<Partial<ToolStatus> | null>(null);
if (import.meta.env.DEV && typeof window !== "undefined") (window as any).__onb = { setStatus: setFakeStatus };

export function Onboarding() {
  const [realStatus, { refetch }] = createResource(toolStatus);
  const status = () => ({ ...realStatus(), ...fakeStatus() });
  const [login, setLogin] = createSignal<"sub" | "key" | null>(null);
  const [imported, setImported] = createSignal(false);
  const [asked, setAsked] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [at, setAt] = createSignal<StepId>("hello");
  const [leaving, setLeaving] = createSignal(false);
  const [dir, setDir] = createSignal<1 | -1>(1);

  const refreshLogin = async () => {
    const p = await accountProviders("default");
    updateAccount("default", (a) => (a.providers = p));
  };
  onMount(() => {
    void scan();
    void refreshLogin();
  });

  // permissions: checked often while that screen is up, and when the window comes back from System Settings
  const timer = setInterval(() => !document.hidden && at() === "access" && refetch(), 1500);
  const recheck = () => refetch();
  window.addEventListener("focus", recheck);
  onCleanup(() => (clearInterval(timer), window.removeEventListener("focus", recheck)));

  const found = () => sources().filter((s) => s.found);
  const counts = createMemo(() =>
    found().reduce((n, s) => ({ rules: n.rules + s.rules.length, skills: n.skills + s.skills.length, memories: n.memories + s.memories.length }), { rules: 0, skills: 0, memories: 0 }),
  );
  const loggedIn = () => state.accounts.some((a) => a.providers.length);
  const granted = (p: Pane) => !!(p === "accessibility" ? status()?.accessibility : status()?.screenRecording);
  const allowed = () => granted("accessibility") && granted("screen");

  const steps = createMemo<StepId[]>(() => ["hello", "account", ...(found().length || imported() ? (["import"] as const) : []), "access", "ask"]);
  const index = () => Math.max(0, steps().indexOf(at()));

  const go = (to: StepId) => {
    if (to === at() || leaving()) return;
    setDir(steps().indexOf(to) < index() ? -1 : 1);
    if (quiet()) return void setAt(to);
    setLeaving(true);
    setTimeout(() => (setAt(to), setLeaving(false)), 140);
  };
  const next = () => {
    const s = steps()[index() + 1];
    s ? go(s) : finish();
  };
  const prev = () => index() > 0 && go(steps()[index() - 1]);
  const finish = () => setState("onboarded", true);

  const doImport = () => {
    importFrom(found(), { rules: true, skills: true, memories: true });
    setImported(true);
  };
  const openPane = (p: Pane) => {
    setAsked(true);
    void askPermission(p);
  };
  const send = () => {
    const text = draft().trim();
    if (!text) return;
    throwThought(text, state.space);
    setView({ name: "main" });
    finish();
  };

  // the one main action of each screen (Enter runs it)
  const primary = (): { label: string; run: () => void } | null => {
    switch (at()) {
      case "hello":
        return { label: t("시작하기"), run: next };
      case "account":
        return loggedIn() ? { label: t("계속"), run: next } : null;
      case "import":
        return imported() ? { label: t("계속"), run: next } : { label: t("가져오기"), run: doImport };
      case "access":
        return allowed() ? { label: t("계속"), run: next } : null;
      case "ask":
        return loggedIn() ? null : { label: t("시작하기"), run: finish };
    }
  };
  const firstMissing = (): Pane | null => (!granted("accessibility") ? "accessibility" : !granted("screen") ? "screen" : null);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || login() || leaving()) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest("textarea, input, button, a, [contenteditable]")) return;
    e.preventDefault();
    const p = primary();
    if (p) return p.run();
    if (at() === "account" && !loggedIn() && engine.ready) return void setLogin("sub");
    const miss = at() === "access" && firstMissing();
    if (miss) openPane(miss);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const later = () => (at() === "ask" ? finish() : next());
  const showLater = () => (at() === "account" && !loggedIn()) || (at() === "import" && !imported()) || (at() === "access" && !allowed()) || (at() === "ask" && loggedIn());

  return (
    <div class="onb" role="dialog" aria-modal="true" aria-label={t("{name} 시작하기", { name: appName() })} tabIndex={-1} ref={(el) => queueMicrotask(() => el.focus())}>
      <div class="onb-top" data-tauri-drag-region>
        <Show when={index() > 0}>
          <button class="icon-btn onb-back" title={t("뒤로")} aria-label={t("뒤로")} onMouseDown={(e) => e.preventDefault()} onClick={prev}><Icon name="back" size={16} /></button>
        </Show>
        <ol class="onb-progress" aria-label={t("{n}/{total} 단계", { n: index() + 1, total: steps().length })} data-tauri-drag-region>
          <For each={steps()}>{(_, i) => <li classList={{ on: i() <= index(), now: i() === index() }} />}</For>
        </ol>
      </div>

      <div class="onb-stage">
        <Show when={at()} keyed>
          {(step) => (
            <section class="onb-pane" classList={{ out: leaving(), back: dir() < 0 }} data-step={step}>
              <Switch>
                <Match when={at() === "hello"}>
                  <h1>{t("말하면, 작업이 시작돼요")}</h1>
                  <p class="onb-sub">{t("작업은 뒤에서 동시에 돌아가고, 끝나면 알려 줘요.")}</p>
                  <Demo />
                </Match>

                <Match when={at() === "account"}>
                  <h1>{t("모델 계정을 연결해요")}</h1>
                  <p class="onb-sub">{t("쓰고 있는 구독이나 API 키로 작업해요.")}</p>
                  <div class="onb-group">
                    <Show
                      when={loggedIn()}
                      fallback={
                        <For each={[["sub", "구독 계정", "브라우저에서 로그인해요", "globe"], ["key", "API 키", "키를 붙여 넣어요", "key"]] as const}>
                          {([way, label, how, icon]) => (
                            <button class="onb-row onb-pick" onClick={() => setLogin(way)} disabled={!engine.ready}>
                              <span class="onb-row-icon"><Icon name={icon} size={16} /></span>
                              <span class="onb-row-main">
                                <b>{t(label)}</b>
                                <span>{t(how)}</span>
                              </span>
                              <span class="onb-chev"><Icon name="chevron" size={14} /></span>
                            </button>
                          )}
                        </For>
                      }
                    >
                      <div class="onb-row ok">
                        <span class="onb-row-icon"><Icon name="key" size={16} /></span>
                        <span class="onb-row-main"><b>{t("모델 계정")}</b></span>
                        <span class="onb-state ok"><GlyphMark g="done" />{t("연결했어요")}</span>
                      </div>
                    </Show>
                  </div>
                </Match>

                <Match when={at() === "import"}>
                  <h1>{t("쓰던 설정을 가져올까요?")}</h1>
                  <p class="onb-sub">{t("이 Mac의 다른 도구에서 찾았어요.")}</p>
                  <div class="onb-counts" classList={{ ok: imported() }}>
                    <For each={[["지침", counts().rules], ["스킬", counts().skills], ["메모리", counts().memories]] as const}>
                      {([label, n]) => (
                        <div class="onb-count">
                          <b>{n}</b>
                          <span>{t(label)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                  <p class="onb-note" classList={{ ok: imported() }}>
                    <Show when={imported()} fallback={<><Icon name="lock" size={14} />{t("로그인 정보는 가져오지 않아요")}</>}>
                      <GlyphMark g="done" />
                      {t("가져왔어요")}
                    </Show>
                  </p>
                </Match>

                <Match when={at() === "access"}>
                  <h1>{t("앱을 다루는 권한이 필요해요")}</h1>
                  <p class="onb-sub">{t("작업이 앱을 직접 눌러 보고 화면을 확인할 때 써요.")}</p>
                  <div class="onb-group">
                    <For each={[["accessibility", "손쉬운 사용", "클릭하고 입력해요", "hand"], ["screen", "화면 기록", "화면을 보고 확인해요", "monitor"]] as const}>
                      {([pane, label, why, icon]) => (
                        <div class="onb-row" classList={{ ok: granted(pane) }}>
                          <span class="onb-row-icon"><Icon name={icon} size={16} /></span>
                          <span class="onb-row-main">
                            <b>{t(label)}</b>
                            <span>{t(why)}</span>
                          </span>
                          <Show
                            when={granted(pane)}
                            fallback={<button class="btn sm" classList={{ primary: firstMissing() === pane }} onClick={() => openPane(pane)}>{t("설정 열기")}</button>}
                          >
                            <span class="onb-state ok"><GlyphMark g="done" />{t("허용됨")}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={asked() && !allowed()}>
                    <p class="onb-note">{t("켰는데 그대로면 {name}를 다시 열어 주세요", { name: appName() })}</p>
                  </Show>
                </Match>

                <Match when={at() === "ask"}>
                  <Show
                    when={loggedIn()}
                    fallback={
                      <>
                        <h1>{t("준비됐어요")}</h1>
                        <p class="onb-sub">{t("계정은 설정에서 언제든 연결할 수 있어요.")}</p>
                        <div class="onb-group">
                          <div class="onb-row">
                            <span class="onb-row-icon"><Icon name="key" size={16} /></span>
                            <span class="onb-row-main"><b>{t("모델 계정")}</b></span>
                            <span class="onb-state">{t("연결 안 됨")}</span>
                            <button class="btn sm" onClick={() => setLogin("sub")} disabled={!engine.ready}>{t("로그인")}</button>
                          </div>
                        </div>
                      </>
                    }
                  >
                    <h1>{t("무엇부터 할까요?")}</h1>
                    <p class="onb-sub">{t("메인에 보내면 바로 작업을 시작해요.")}</p>
                    <form class="onb-composer" onSubmit={(e) => (e.preventDefault(), send())}>
                      <textarea
                        rows={3}
                        autofocus
                        ref={(el) => setTimeout(() => el.focus(), quiet() ? 0 : 320)}
                        placeholder={t("메시지 보내기")}
                        aria-label={t("메시지 보내기")}
                        value={draft()}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) (e.preventDefault(), send());
                        }}
                      />
                      <div class="onb-composer-bar">
                        <button class="onb-send" type="submit" disabled={!draft().trim()} aria-label={t("보내기")} title={t("보내기 (↵)")}><Icon name="arrowUp" size={14} stroke={2} /></button>
                      </div>
                    </form>
                  </Show>
                </Match>
              </Switch>

              <div class="onb-actions">
                <Show when={primary()}>
                  {(p) => (
                    <button class="btn primary onb-go" onClick={() => p().run()}>
                      {p().label}
                      <kbd class="onb-kbd">↩</kbd>
                    </button>
                  )}
                </Show>
                <Show when={showLater()}>
                  <button class="btn ghost onb-later" onClick={later}>{t("나중에")}</button>
                </Show>
              </div>
            </section>
          )}
        </Show>
      </div>

      <Show when={login()}>
        <LoginSheet
          accountId="default"
          more={login() === "key"}
          onClose={() => {
            setLogin(null);
            void refreshLogin();
          }}
        />
      </Show>
    </div>
  );
}

/** What Ondra does, drawn with its own parts, played once: a request typed and sent, a task
 *  showing up beside it, the one before it finishing. Still under reduced motion. */
function Demo() {
  return (
    <div class="onb-demo" aria-hidden="true">
      <div class="od-side">
        <span class="od-lights"><i /><i /><i /></span>
        <div class="od-row"><GlyphMark g="done" /><span class="od-bar" style={{ width: "58%" }} /></div>
        <div class="od-row od-r2">
          <span class="od-swap">
            <GlyphMark g="running" class="od-was" />
            <GlyphMark g="done" class="od-now" />
          </span>
          <span class="od-bar" style={{ width: "72%" }} />
        </div>
        <div class="od-row od-r3"><GlyphMark g="running" /><span class="od-bar" style={{ width: "46%" }} /></div>
      </div>
      <div class="od-main">
        <div class="od-msg od-me"><span class="od-bar" style={{ width: "100%" }} /></div>
        <div class="od-reply">
          <span class="od-bar" style={{ width: "86%" }} />
          <span class="od-bar" style={{ width: "54%" }} />
        </div>
        <div class="od-composer">
          <span class="od-typed" />
          <span class="od-send"><Icon name="arrowUp" size={12} stroke={2} /></span>
        </div>
      </div>
    </div>
  );
}
