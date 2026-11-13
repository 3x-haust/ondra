// Settings › 시크릿: API keys and passwords a job's commands use as $NAME. The value goes to the
// macOS keychain when it is saved and never comes back to this page; jobs get it in their shell
// and the model sees [secret:NAME] wherever it would show (extensions/secrets.ts).
import { createResource, createSignal, For, Show } from "solid-js";
import { secretDelete, secretList, secretSet } from "../lib/native";
import { toast } from "../state/ui";
import { Icon } from "../ui/Icon";
import { GroupTitle } from "./Settings";
import { t } from "../i18n";

export function SecretsSettings() {
  const [names, { mutate }] = createResource(secretList, { initialValue: [] });
  const [name, setName] = createSignal("");
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const clean = () => name().trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const save = async () => {
    if (!clean() || !value()) return;
    setBusy(true);
    try {
      const replaced = names().includes(clean());
      mutate(await secretSet(clean(), value()));
      toast(replaced ? t("{name}을(를) 바꿨어요", { name: clean() }) : t("{name}을(를) 저장했어요", { name: clean() }));
      setName("");
      setValue("");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n: string) => {
    try {
      mutate(await secretDelete(n));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    setConfirm(null);
  };
  return (
    <>
      <h2>{t("시크릿")}</h2>
      <p class="sec-intro">{t("API 키와 비밀번호를 macOS 키체인에 두고, 작업의 명령에서 $이름으로 써요. 에이전트는 이름만 알고 값은 보지 못해요. 출력에 값이 나오면 [secret:이름]으로 가려져요.")}</p>

      <GroupTitle title={t("새 시크릿")} />
      <div class="set-group">
        <form class="set-row sec-add" onSubmit={(e) => (e.preventDefault(), save())}>
          <input class="input sec-name" placeholder="STRIPE_KEY" aria-label={t("이름")} autocomplete="off" spellcheck={false} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <input class="input sec-value" type="password" placeholder={t("값")} aria-label={t("값")} autocomplete="off" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
          <button class="btn primary sm" type="submit" disabled={busy() || !clean() || !value()}>{t("저장")}</button>
        </form>
      </div>

      <GroupTitle title={t("저장된 시크릿")} />
      <div class="set-group">
        <Show when={names().length} fallback={<div class="empty-line"><span>{t("아직 없어요")}</span></div>}>
          <For each={names()}>
            {(n) => (
              <div class="set-row">
                <div class="set-label"><b><code>{n}</code></b></div>
                <div class="set-value">
                  <span class="set-note">••••••••</span>
                  <Show
                    when={confirm() === n}
                    fallback={<button class="icon-btn sm" title={t("삭제")} aria-label={t("{name} 삭제", { name: n })} onClick={() => setConfirm(n)}><Icon name="trash" size={14} /></button>}
                  >
                    <button class="btn sm danger" onClick={() => remove(n)}>{t("삭제")}</button>
                    <button class="btn ghost sm" onClick={() => setConfirm(null)}>{t("취소")}</button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
      <p class="sec-intro">{t("같은 이름으로 다시 저장하면 값이 바뀌어요. 작업 폴더의 .env에 있는 키·토큰·비밀번호 값도 출력에서 가려져요. 새 값은 다음에 시작하는 작업부터 쓰여요.")}</p>
    </>
  );
}
