// Settings › 시크릿: API keys and passwords a job's commands use as $NAME, for every job or for
// one project. Opening the page takes the keys, tokens and passwords this Mac's projects already
// keep in their .env files into the keychain by itself (secret_sync). A value typed here goes to
// the keychain (and, for a project, into its .env if asked) and never comes back to this page;
// jobs get it in their shell and the model sees [secret:NAME] wherever it would show
// (extensions/secrets.ts).
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { secretDelete, secretList, secretSet, secretSync, type SavedSecrets } from "../lib/native";
import { state } from "../state/store";
import { toast } from "../state/ui";
import { Icon } from "../ui/Icon";
import { EmptyState, GroupTitle, PageHead } from "./Settings";
import { t } from "../i18n";

const GLOBAL = "";

export function SecretsSettings() {
  const [saved, { mutate }] = createResource(secretList, { initialValue: { global: [], projects: {} } as SavedSecrets });
  // this Mac's projects of the current workspace (a project on another Mac has its .env there)
  const projects = createMemo(() => (state.projects ?? []).filter((p) => p.space === state.space && !p.host));
  const [scope, setScope] = createSignal(GLOBAL);
  const project = () => projects().find((p) => p.id === scope());
  const names = () => (scope() === GLOBAL ? saved().global : (saved().projects[scope()] ?? []));
  const count = (id: string) => saved().projects[id]?.length ?? 0;
  const [name, setName] = createSignal("");
  const [value, setValue] = createSignal("");
  const [toEnv, setToEnv] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  // .env isn't ignored by git: the save waits for the user's answer
  const [askIgnore, setAskIgnore] = createSignal(false);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const clean = () => name().trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const where = () => project()?.name ?? t("모든 작업");

  // what the projects' .env files already hold comes in by itself
  onMount(async () => {
    try {
      const r = await secretSync(projects().map((p) => [p.id, p.folder]));
      mutate(r.saved);
      if (r.added.length) toast(t("프로젝트 .env에서 {n}개를 가져왔어요", { n: r.added.length }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  });

  const save = async (addIgnore = false) => {
    if (!clean() || !value()) return;
    setBusy(true);
    try {
      const p = project();
      const replaced = names().includes(clean());
      mutate(await secretSet({ name: clean(), value: value(), project: p?.id, folder: p?.folder, writeDotenv: !!p && toEnv(), addIgnore }));
      const env = p && toEnv() ? t(" · .env에도 썼어요") : "";
      toast((replaced ? t("{name}을(를) 바꿨어요", { name: clean() }) : t("{name}을(를) 저장했어요", { name: clean() })) + env);
      setName("");
      setValue("");
      setAskIgnore(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("ENV_NOT_IGNORED")) setAskIgnore(true);
      else toast(msg, "bad");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n: string) => {
    try {
      const p = project();
      mutate(await secretDelete({ name: n, project: p?.id, folder: p?.folder }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    setConfirm(null);
  };

  return (
    <>
      <PageHead tab="secrets">
        <select class="select" aria-label={t("적용 범위")} value={scope()} onChange={(e) => (setScope(e.currentTarget.value), setAskIgnore(false), setConfirm(null))}>
          <option value={GLOBAL}>{t("모든 작업")}</option>
          <For each={projects()}>{(p) => <option value={p.id}>{count(p.id) ? `${p.name} · ${count(p.id)}` : p.name}</option>}</For>
        </select>
      </PageHead>

      <GroupTitle title={t("{where}의 시크릿", { where: where() })} />
      <div class="set-group">
        <Show
          when={names().length}
          fallback={
            <EmptyState
              icon="lock"
              title={t("아직 없어요")}
              desc={
                scope() === GLOBAL
                  ? t("어느 프로젝트에서나 쓸 키를 아래에 넣어요. 프로젝트 .env에 있던 키는 프로젝트를 고르면 보여요.")
                  : t("이 프로젝트 .env에는 키·토큰·비밀번호로 보이는 값이 없었어요. 아래에서 넣을 수 있어요.")
              }
            />
          }
        >
          <For each={names()}>
            {(n) => (
              <div class="set-row two">
                <div class="set-label">
                  <b><code>{n}</code></b>
                  <span class="set-sub">
                    {scope() !== GLOBAL && saved().global.includes(n) ? t("모든 작업의 값 대신 이 값이 쓰여요") : t("작업의 명령에서 ${name}으로 써요", { name: n })}
                  </span>
                </div>
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

      <GroupTitle title={t("새 시크릿")} />
      <div class="set-group">
        <form class="set-row sec-add" onSubmit={(e) => (e.preventDefault(), save())}>
          <input class="input sec-name" placeholder="STRIPE_KEY" aria-label={t("이름")} autocomplete="off" spellcheck={false} value={name()} onInput={(e) => (setName(e.currentTarget.value), setAskIgnore(false))} />
          <input class="input sec-value" type="password" placeholder={t("값")} aria-label={t("값")} autocomplete="off" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
          <button class="btn primary sm" type="submit" disabled={busy() || !clean() || !value()}>{t("저장")}</button>
        </form>
        <Show when={project()}>
          {(p) => (
            <label class="set-row two check sec-env">
              <input type="checkbox" checked={toEnv()} onChange={(e) => (setToEnv(e.currentTarget.checked), setAskIgnore(false))} />
              <div class="set-label">
                <b>{t("{name}의 .env에도 쓰기", { name: p().name })}</b>
                <span class="set-sub">{t("Ondra 밖에서 실행해도 같은 값이 쓰여요. 파일에는 값이 그대로 저장돼요")}</span>
              </div>
            </label>
          )}
        </Show>
        <Show when={askIgnore()}>
          <div class="set-row sec-warn">
            <Icon name="alert" size={14} />
            <span>{t(".env가 .gitignore에 없어서 커밋될 수 있어요.")}</span>
            <span class="spacer" />
            <button class="btn primary sm" disabled={busy()} onClick={() => save(true)}>{t(".gitignore에 추가하고 쓰기")}</button>
            <button class="btn ghost sm" disabled={busy()} onClick={() => (setToEnv(false), setAskIgnore(false))}>{t(".env에는 쓰지 않기")}</button>
          </div>
        </Show>
      </div>
      <p class="sec-foot">
        {t("값은 macOS 키체인에만 두고, 에이전트는 이름만 알아요. 출력에 값이 나오면 [secret:이름]으로 가려져요. 프로젝트 시크릿은 모든 작업의 시크릿보다 먼저 쓰이고, 새 값은 다음에 시작하는 작업부터 쓰여요.")}
      </p>
    </>
  );
}
