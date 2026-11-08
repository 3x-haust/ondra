// Signing in to a model service, drawn by the app: pick a service, finish in the
// browser (or type a code / paste a key), done. The engine does the actual flow
// over RPC (get_login_providers / login / login_prompt / login_event).
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { refreshModels } from "../engine/modelList";
import { accountProviders, agentKill, agentSend, agentSpawn, openUrl } from "../lib/native";
import { engine, listen, request } from "../engine/rpc";
import { accountEnv } from "../engine/tasks";
import { updateAccount } from "../state/store";
import { toast } from "../state/ui";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";
import { Logo } from "../ui/Logos";
import { t } from "../i18n";
import { ignoredKey, noModifiers } from "../lib/shortcuts";

interface Provider {
  id: string;
  name: string;
  authType: "oauth" | "api_key";
  label?: string;
  subscription: boolean;
  configured: boolean;
}
type Prompt = { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
type Step =
  | { kind: "pick" }
  | { kind: "busy"; p: Provider; url?: string; device?: { code: string; uri: string }; note?: string; prompt?: Prompt }
  | { kind: "done"; p: Provider };

/** The services people actually sign in with, in the order they look for them. `sub` is a Korean key for t(). */
const TOP: Record<string, { title: string; sub: string }> = {
  anthropic: { title: "Claude", sub: "Pro · Max 구독" },
  "openai-codex": { title: "ChatGPT", sub: "Plus · Pro 구독" },
  "github-copilot": { title: "GitHub Copilot", sub: "Copilot 구독" },
};
const ORDER = ["anthropic", "openai-codex", "github-copilot"];

/** the engine's English prompts, said the app's way */
const say = (m: string) =>
  m
    .replace(/^Select (.+) login method:?$/i, (_, name) => t("{name} 로그인 방법", { name }))
    .replace(/^Complete login in your browser.*$/i, () => t("로그인 후 주소 붙여넣기"))
    .replace(/^Enter (.+) API key:?$/i, (_, name) => t("{name} API 키", { name }));

export function LoginSheet(props: { accountId: string; title?: string; onClose: () => void }) {
  const agent = `login:${props.accountId}:${Date.now()}`;
  // the last list shows at once; the engine (≈2s to start) refreshes it behind
  const KEY = `ondra.loginProviders.${props.accountId}`;
  const kept = (): Provider[] | null => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "null");
    } catch {
      return null;
    }
  };
  const [providers, setProviders] = createSignal<Provider[] | null>(kept());
  const [error, setError] = createSignal("");
  const [step, setStep] = createSignal<Step>({ kind: "pick" });
  const [more, setMore] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  let loginId = "";
  /** the engine is up (a kept list can be clicked before it is) */
  let ready: Promise<void> = Promise.resolve();
  let opened = "";

  const load = async () => {
    try {
      const r = await request(agent, { type: "get_login_providers" }, 30_000);
      setProviders(r.providers as Provider[]);
      try {
        localStorage.setItem(KEY, JSON.stringify(r.providers));
      } catch {
        /* private mode */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  onMount(async () => {
    listen(agent, {
      event: (ev) => {
        // one login at a time per engine: the first event tells us its id (for cancel)
        if (ev.loginId) loginId = ev.loginId;
        const s = step();
        if (s.kind !== "busy") return;
        if (ev.type === "login_event") {
          const e = ev.event;
          if (e.type === "auth_url") {
            if (opened !== e.url) (opened = e.url), void openUrl(e.url);
            setStep({ ...s, url: e.url });
          } else if (e.type === "device_code") {
            if (opened !== e.verificationUri) {
              opened = e.verificationUri;
              void navigator.clipboard.writeText(e.userCode).catch(() => {});
              void openUrl(e.verificationUri);
            }
            setStep({ ...s, device: { code: e.userCode, uri: e.verificationUri } });
          } else if (e.type === "progress" || e.type === "info") setStep({ ...s, note: e.message });
        } else if (ev.type === "login_prompt") {
          const p: Prompt = { id: ev.id, ...ev.prompt };
          // "browser or copy code?" has an obvious answer on a Mac with a browser
          if (p.type === "select" && p.options?.some((o) => o.id === "browser")) return reply(p.id, "browser");
          setAnswer("");
          setStep({ ...s, prompt: p });
        }
      },
    });
    ready = (async () => {
      await agentSpawn(agent, engine.info.home, ["--no-session", "--no-tools"], await accountEnv(props.accountId));
    })();
    try {
      await ready;
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });
  onCleanup(() => {
    if (loginId) void agentSend(agent, { type: "login_cancel", loginId }).catch(() => {});
    setTimeout(() => void agentKill(agent), 300);
  });

  const reply = (id: string, value: string) => {
    void agentSend(agent, { type: "extension_ui_response", id, value });
    const s = step();
    if (s.kind === "busy" && s.prompt?.id === id) setStep({ ...s, prompt: undefined, note: t("확인 중") });
  };

  const start = async (p: Provider) => {
    opened = "";
    setError("");
    setStep({ kind: "busy", p });
    loginId = "";
    try {
      await ready;
      await request(agent, { type: "login", provider: p.id, authType: p.authType }, 15 * 60_000);
      loginId = "";
      const list = await accountProviders(props.accountId);
      updateAccount(props.accountId, (a) => (a.providers = list));
      void refreshModels(props.accountId, true);
      setStep({ kind: "done", p });
      toast(t("{name}에 로그인했어요", { name: TOP[p.id]?.title ?? p.name }));
      setTimeout(props.onClose, 900);
    } catch (e) {
      loginId = "";
      const msg = e instanceof Error ? e.message : String(e);
      setStep({ kind: "pick" });
      if (!/abort|cancel/i.test(msg)) setError(msg);
    }
  };
  const cancel = () => {
    const s = step();
    if (s.kind !== "busy") return;
    setStep({ kind: "pick" });
    if (loginId) return void request(agent, { type: "login_cancel", loginId }, 5_000).catch(() => {});
    // nothing heard yet: start over with a fresh engine
    void agentKill(agent).then(async () => {
      await agentSpawn(agent, engine.info.home, ["--no-session", "--no-tools"], await accountEnv(props.accountId));
      await load();
    });
  };

  // Esc steps back from a sign-in under way, or closes the sheet
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || ignoredKey(e) || !noModifiers(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (step().kind === "busy") cancel();
    else props.onClose();
  };
  window.addEventListener("keydown", esc, true);
  onCleanup(() => window.removeEventListener("keydown", esc, true));

  const top = createMemo(() => ORDER.map((id) => providers()?.find((p) => p.id === id && p.authType === "oauth")).filter((p): p is Provider => !!p));
  const rest = createMemo(() => {
    const k = q().trim().toLowerCase();
    return (providers() ?? [])
      .filter((p) => !(ORDER.includes(p.id) && p.authType === "oauth"))
      .filter((p) => !k || p.name.toLowerCase().includes(k) || p.id.includes(k))
      .sort((a, b) => Number(b.authType === "oauth") - Number(a.authType === "oauth") || a.name.localeCompare(b.name));
  });

  return (
    <div class="backdrop" onClick={props.onClose}>
      <div class="sheet login-sheet" role="dialog" aria-modal="true" aria-label={props.title ?? t("로그인")} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <Show when={step().kind === "busy"}>
            <button class="icon-btn" title={t("뒤로")} aria-label={t("뒤로")} onClick={cancel}><Icon name="back" size={16} /></button>
          </Show>
          {props.title ?? t("로그인")}
          <span class="spacer" />
          <button class="icon-btn" title={t("닫기")} aria-label={t("닫기")} onClick={props.onClose}><Icon name="x" size={16} /></button>
        </div>
        <div class="login-body">
          <Switch>
            <Match when={step().kind === "pick"}>
              <Show when={error()}><p class="login-err">{error()}</p></Show>
              <Show when={providers()} fallback={<div class="login-wait"><span class="spin sm" />{t("불러오는 중")}</div>}>
                <div class="login-top">
                  <For each={top()}>
                    {(p) => (
                      <button class="login-card" onClick={() => void start(p)}>
                        <Logo name={p.id === "anthropic" ? "claude" : p.id} size={22} class="login-card-logo" />
                        <span class="login-card-t">{TOP[p.id].title}</span>
                        <span class="login-card-s">{t(TOP[p.id].sub)}</span>
                        <Show when={p.configured}><span class="pill ok login-card-on">{t("로그인됨")}</span></Show>
                      </button>
                    )}
                  </For>
                </div>
                <button class="login-more" classList={{ open: more() }} onClick={() => setMore(!more())}>
                  <Icon name="chevron" size={12} />
                  {t("다른 서비스 · API 키")} <span class="muted">{rest().length}</span>
                </button>
                <Fold open={more()}>
                  <div class="login-rest">
                    <input class="input" placeholder={t("검색")} aria-label={t("검색")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
                    <div class="login-list">
                      <For each={rest()}>
                        {(p) => (
                          <button class="login-row" onClick={() => void start(p)}>
                            <span class="login-row-logo"><Logo name={p.id} size={14} /></span>
                            <span class="login-row-t">{p.name}</span>
                            <span class="login-row-k">{p.authType === "oauth" ? t("브라우저") : t("API 키")}</span>
                            <Show when={p.configured}><span class="pill ok">{t("로그인됨")}</span></Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Fold>
              </Show>
            </Match>
            <Match when={step().kind === "busy" && (step() as Extract<Step, { kind: "busy" }>)}>
              {(s) => (
                <div class="login-flow">
                  <h3>{TOP[s().p.id]?.title ?? s().p.name}</h3>
                  <Switch fallback={<div class="login-wait"><span class="spin sm" />{s().note ?? t("준비 중")}</div>}>
                    <Match when={s().prompt && s().prompt!.type !== "manual_code" && s().prompt}>
                      {(p) => (
                        <Show
                          when={p().type === "select"}
                          fallback={
                            <form class="login-ask" onSubmit={(e) => (e.preventDefault(), reply(p().id, answer().trim()))}>
                              <label>{say(p().message)}</label>
                              <input
                                class="input"
                                type={p().type === "secret" ? "password" : "text"}
                                placeholder={p().placeholder ?? (p().type === "secret" ? t("키 붙여넣기") : "")}
                                value={answer()}
                                autofocus
                                onInput={(e) => setAnswer(e.currentTarget.value)}
                              />
                              <div class="login-acts">
                                <button class="btn primary sm" type="submit" disabled={p().type === "secret" && !answer().trim()}>
                                  {p().type === "text" && !answer().trim() ? t("건너뛰기") : t("계속")}
                                </button>
                              </div>
                            </form>
                          }
                        >
                          <div class="login-ask">
                            <label>{say(p().message)}</label>
                            <For each={p().options}>
                              {(o) => (
                                <button class="login-row" onClick={() => reply(p().id, o.id)}>
                                  <span class="login-row-t">{o.label}</span>
                                  <Show when={o.description}><span class="login-row-k">{o.description}</span></Show>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      )}
                    </Match>
                    <Match when={s().device}>
                      {(d) => (
                        <div class="login-device">
                          <p>{t("브라우저에 코드 입력")}</p>
                          <code class="login-code">{d().code}</code>
                          <div class="login-acts">
                            <button class="btn sm" onClick={() => (void navigator.clipboard.writeText(d().code), toast(t("복사했어요")))}><Icon name="copy" size={14} />{t("코드 복사")}</button>
                            <button class="btn sm" onClick={() => void openUrl(d().uri)}><Icon name="link" size={14} />{t("페이지 다시 열기")}</button>
                          </div>
                          <div class="login-wait"><span class="spin sm" />{t("기다리는 중")}</div>
                        </div>
                      )}
                    </Match>
                    <Match when={s().url}>
                      {(u) => (
                        <div class="login-device">
                          <p>{t("브라우저에서 로그인하세요")}</p>
                          <div class="login-acts">
                            <button class="btn sm" onClick={() => void openUrl(u())}><Icon name="link" size={14} />{t("다시 열기")}</button>
                            <button class="btn sm" onClick={() => (void navigator.clipboard.writeText(u()), toast(t("복사했어요")))}><Icon name="copy" size={14} />{t("링크 복사")}</button>
                          </div>
                          <div class="login-wait"><span class="spin sm" />{t("기다리는 중")}</div>
                          <Show when={s().prompt?.type === "manual_code" && s().prompt}>
                            {(p) => (
                              <form class="login-ask small" onSubmit={(e) => (e.preventDefault(), answer().trim() && reply(p().id, answer().trim()))}>
                                <label>{say(p().message)}</label>
                                <div class="login-inline">
                                  <input class="input" placeholder={p().placeholder ?? t("주소 또는 코드")} value={answer()} onInput={(e) => setAnswer(e.currentTarget.value)} />
                                  <button class="btn sm" type="submit" disabled={!answer().trim()}>{t("계속")}</button>
                                </div>
                              </form>
                            )}
                          </Show>
                        </div>
                      )}
                    </Match>
                  </Switch>
                </div>
              )}
            </Match>
            <Match when={step().kind === "done"}>
              <div class="login-done">
                <Icon name="check" size={16} />
                {t("로그인했어요")}
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}
