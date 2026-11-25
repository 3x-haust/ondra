// Settings › 서비스: Gmail, Slack, Notion … connected for one workspace at a time (MCP servers,
// engine/services.ts). Each workspace keeps its own list and sign-ins, so the work space's Slack
// is never the personal one's. A service that only takes known clients (Google, Slack) asks for
// the user's own OAuth app: its id goes into the space's mcp.json, its secret into the keychain.
import { createResource, createSignal, For, Show } from "solid-js";
import { state, ownSpaces } from "../state/store";
import { toast } from "../state/ui";
import { openExternal } from "../lib/native";
import { addServer, PRESETS, readServers, removeServer, serverConfig, serverName, serverStates, setEnabled, signIn, type Preset, type Server, type ServerState } from "../engine/services";
import { Icon } from "../ui/Icon";
import { PageHead } from "./Settings";
import { t } from "../i18n";

const STATE_LABEL: Record<string, string> = { connected: "연결됨", "needs-auth": "로그인 필요", failed: "연결 안 됨", disabled: "꺼짐", connecting: "연결 중" };

export function ServicesSettings() {
  const [space, setSpace] = createSignal(state.space);
  const [servers, { refetch: reread }] = createResource(space, readServers, { initialValue: {} as Record<string, Server> });
  // the engine connects to each to say how it is: a moment, so it comes after the list
  const [states, { refetch: recheck }] = createResource(space, (s) => serverStates(s).catch(() => [] as ServerState[]), { initialValue: [] });
  const stateOf = (name: string) => states().find((s) => s.name === name);
  const refresh = () => (reread(), recheck());

  const [adding, setAdding] = createSignal<Preset | "custom" | null>(null);
  const [clientId, setClientId] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [customName, setCustomName] = createSignal("");
  const [customAt, setCustomAt] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal<string | null>(null);

  const reset = () => (setAdding(null), setClientId(""), setSecret(""), setCustomName(""), setCustomAt(""));
  const err = (e: unknown) => toast(e instanceof Error ? e.message : String(e), "bad");

  const login = async (name: string) => {
    setBusy(name);
    try {
      toast(t("브라우저에서 로그인해 주세요"));
      const r = await signIn(space(), name);
      if (r.ok) toast(t("{name}에 연결했어요", { name }));
      else toast(r.said || t("로그인하지 못했어요"), "bad");
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
      recheck();
    }
  };

  const add = async () => {
    const a = adding();
    if (!a) return;
    try {
      let name: string;
      if (a === "custom") {
        name = serverName(customName());
        const at = customAt().trim();
        if (!name || !at) return;
        // an address is a remote server; anything else is a command run on this Mac
        const parts = at.split(/\s+/);
        await addServer(space(), name, /^https?:\/\//.test(at) ? serverConfig({ name, url: at }) : serverConfig({ name, command: parts[0], args: parts.slice(1) }));
      } else {
        name = a.id;
        if (a.ownApp && (!clientId().trim() || !secret().trim())) return;
        await addServer(space(), name, serverConfig({ name, url: a.url, clientId: clientId().trim() || undefined, secret: !!secret().trim(), scope: a.ownApp?.scope, about: a.about }), secret());
      }
      reset();
      reread();
      await login(name);
    } catch (e) {
      err(e);
    }
  };

  const remove = async (name: string) => {
    setConfirm(null);
    try {
      await removeServer(space(), name);
      refresh();
    } catch (e) {
      err(e);
    }
  };

  const names = () => Object.keys(servers() ?? {}).sort();
  const presetOf = (name: string) => PRESETS.find((p) => p.id === name);

  return (
    <>
      <PageHead tab="services">
        <select class="select" aria-label={t("워크스페이스")} value={space()} onChange={(e) => (setSpace(e.currentTarget.value), reset(), setConfirm(null))}>
          <For each={ownSpaces()}>{(s) => <option value={s.id}>{s.label}</option>}</For>
        </select>
      </PageHead>
      <p class="set-note">{t("연결한 서비스는 이 워크스페이스의 메인과 작업만 써요. 필요할 때만 불러 써서 평소 대화를 무겁게 하지 않아요.")}</p>

      <div class="set-group">
        <For each={names()} fallback={<div class="empty-line">{t("연결한 서비스가 없어요")}</div>}>
          {(name) => {
            const s = () => servers()[name];
            const st = () => stateOf(name);
            const off = () => s()?.enabled === false;
            return (
              <div class="set-row sec-row">
                <span class="sec-key">{presetOf(name)?.name ?? name}</span>
                <span class="set-note">
                  {off() ? t("꺼짐") : st() ? `${t(STATE_LABEL[st()!.state] ?? st()!.state)}${st()!.tools.length ? ` · ${t("도구 {n}개", { n: st()!.tools.length })}` : ""}` : t("확인 중")}
                </span>
                <span class="spacer" />
                <Show when={!off() && st() && st()!.state !== "connected"}>
                  <button class="btn sm" disabled={busy() === name} onClick={() => login(name)}>{busy() === name ? t("기다리는 중") : t("로그인")}</button>
                </Show>
                <label class="check" title={t("켜기")}>
                  <input type="checkbox" checked={!off()} onChange={(e) => setEnabled(space(), name, e.currentTarget.checked).then(refresh, err)} />
                </label>
                <Show
                  when={confirm() === name}
                  fallback={<button class="icon-btn sm" title={t("삭제")} aria-label={t("{name} 삭제", { name })} onClick={() => setConfirm(name)}><Icon name="trash" size={14} /></button>}
                >
                  <button class="btn sm danger" onClick={() => remove(name)}>{t("삭제")}</button>
                  <button class="btn ghost sm" onClick={() => setConfirm(null)}>{t("취소")}</button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <div class="set-group">
        <Show
          when={adding()}
          fallback={
            <div class="set-row svc-picks">
              <For each={PRESETS.filter((p) => !servers()[p.id])}>
                {(p) => (
                  <button class="btn sm" title={t(p.about)} onClick={() => setAdding(p)}>
                    {p.name}
                  </button>
                )}
              </For>
              <button class="btn ghost sm" onClick={() => setAdding("custom")}>
                <Icon name="plus" size={14} /> {t("직접 추가")}
              </button>
            </div>
          }
        >
          {(a) => (
            <form class="set-row svc-add" onSubmit={(e) => (e.preventDefault(), add())}>
              <Show
                when={a() !== "custom" && (a() as Preset)}
                fallback={
                  <>
                    <input class="input sec-name" placeholder={t("이름")} aria-label={t("이름")} autocomplete="off" spellcheck={false} value={customName()} onInput={(e) => setCustomName(e.currentTarget.value)} />
                    <input class="input sec-value" placeholder={t("https://… 주소 또는 실행할 명령")} aria-label={t("주소")} autocomplete="off" spellcheck={false} value={customAt()} onInput={(e) => setCustomAt(e.currentTarget.value)} />
                  </>
                }
              >
                {(p) => (
                  <>
                    <span class="sec-key">{p().name}</span>
                    <Show when={p().ownApp} fallback={<span class="set-note">{t(p().about)}</span>}>
                      {(own) => (
                        <>
                          <span class="set-note">
                            {t(own().help)}{" "}
                            <a href="#" onClick={(e) => (e.preventDefault(), void openExternal(own().link))}>{t("방법")}</a>
                          </span>
                          <input class="input sec-name" placeholder="Client ID" aria-label="Client ID" autocomplete="off" spellcheck={false} value={clientId()} onInput={(e) => setClientId(e.currentTarget.value)} />
                          <input class="input sec-value" type="password" placeholder="Client Secret" aria-label="Client Secret" autocomplete="off" value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} />
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>
              <span class="spacer" />
              <button class="btn primary sm" type="submit">{t("연결")}</button>
              <button class="btn ghost sm" type="button" onClick={reset}>{t("취소")}</button>
            </form>
          )}
        </Show>
      </div>
    </>
  );
}
