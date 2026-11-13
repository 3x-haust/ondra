// Settings › 시크릿: API keys and passwords a job's commands use as $NAME, for every job or for
// one project. The value goes to the macOS keychain when it is saved (and, for a project, into
// its .env if asked) and never comes back to this page; jobs get it in their shell and the
// model sees [secret:NAME] wherever it would show (extensions/secrets.ts).
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { secretDelete, secretImport, secretList, secretScan, secretSet, type SavedSecrets } from "../lib/native";
import { state } from "../state/store";
import { toast } from "../state/ui";
import { Icon } from "../ui/Icon";
import { GroupTitle } from "./Settings";
import { t } from "../i18n";

const GLOBAL = "";

export function SecretsSettings() {
  const [saved, { mutate }] = createResource(secretList, { initialValue: { global: [], projects: {} } as SavedSecrets });
  // this Mac's projects of the current workspace (a project on another Mac has its .env there)
  const projects = createMemo(() => (state.projects ?? []).filter((p) => p.space === state.space && !p.host));
  const [scope, setScope] = createSignal(GLOBAL);
  const project = () => projects().find((p) => p.id === scope());
  const names = () => (scope() === GLOBAL ? saved().global : (saved().projects[scope()] ?? []));
  const [name, setName] = createSignal("");
  const [value, setValue] = createSignal("");
  const [toEnv, setToEnv] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  // .env isn't ignored by git: the save waits for the user's answer
  const [askIgnore, setAskIgnore] = createSignal(false);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  // what the chosen project's .env files already hold (names only); refetched after each change
  const [found, { refetch: rescan }] = createResource(() => project()?.folder, (f) => secretScan(f), { initialValue: [] });
  const fresh = () => found().filter((f) => f.valid && !names().includes(f.name));
  const [picked, setPicked] = createSignal<Set<string> | null>(null);
  // by default the ones that look like keys, tokens or passwords
  const chosen = () => picked() ?? new Set(fresh().filter((f) => f.secret).map((f) => f.name));
  const toggle = (n: string, on: boolean) => {
    const next = new Set(chosen());
    if (on) next.add(n);
    else next.delete(n);
    setPicked(next);
  };
  const take = async () => {
    const p = project();
    if (!p || !chosen().size) return;
    setBusy(true);
    try {
      const n = chosen().size;
      mutate(await secretImport(p.id, p.folder, [...chosen()]));
      setPicked(null);
      toast(t("{n}개를 가져왔어요", { n }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const clean = () => name().trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const where = () => project()?.name ?? t("모든 작업");

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
      rescan();
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
      rescan();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    setConfirm(null);
  };

  return (
    <>
      <h2>{t("시크릿")}</h2>
      <p class="sec-intro">{t("API 키와 비밀번호를 macOS 키체인에 두고, 작업의 명령에서 $이름으로 써요. 에이전트는 이름만 알고 값은 보지 못해요. 출력에 값이 나오면 [secret:이름]으로 가려져요.")}</p>

      <div class="sec-scope">
        <span class="set-note">{t("적용 범위")}</span>
        <select class="select" aria-label={t("적용 범위")} value={scope()} onChange={(e) => (setScope(e.currentTarget.value), setAskIgnore(false), setConfirm(null), setPicked(null))}>
          <option value={GLOBAL}>{t("모든 작업")}</option>
          <For each={projects()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
        </select>
      </div>

      <Show when={project() && fresh().length}>
        <GroupTitle title={t("{name}의 .env에서 찾았어요", { name: project()!.name })}>
          <button class="btn primary sm" disabled={busy() || !chosen().size} onClick={take}>{t("{n}개 가져오기", { n: chosen().size })}</button>
        </GroupTitle>
        <div class="set-group">
          <For each={fresh()}>
            {(f) => (
              <label class="set-row check sec-found">
                <input type="checkbox" checked={chosen().has(f.name)} onChange={(e) => toggle(f.name, e.currentTarget.checked)} />
                <code>{f.name}</code>
                <span class="spacer" />
                <Show when={!f.secret}><span class="set-note">{t("설정값 같아요")}</span></Show>
                <span class="set-note">{f.file}</span>
              </label>
            )}
          </For>
          <div class="set-row sec-note"><span class="set-note">{t("값은 키체인으로 옮기고, .env는 그대로 둬요. 가져온 뒤부터 작업 출력에서 가려져요.")}</span></div>
        </div>
      </Show>
      <Show when={scope() === GLOBAL && projects().length}>
        <p class="sec-intro">{t("프로젝트를 고르면 그 프로젝트 .env에 이미 있는 키를 찾아 가져올 수 있어요.")}</p>
      </Show>

      <GroupTitle title={t("새 시크릿")} />
      <div class="set-group">
        <form class="set-row sec-add" onSubmit={(e) => (e.preventDefault(), save())}>
          <input class="input sec-name" placeholder="STRIPE_KEY" aria-label={t("이름")} autocomplete="off" spellcheck={false} value={name()} onInput={(e) => (setName(e.currentTarget.value), setAskIgnore(false))} />
          <input class="input sec-value" type="password" placeholder={t("값")} aria-label={t("값")} autocomplete="off" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
          <button class="btn primary sm" type="submit" disabled={busy() || !clean() || !value()}>{t("저장")}</button>
        </form>
        <Show when={project()}>
          {(p) => (
            <label class="set-row check sec-env">
              <input type="checkbox" checked={toEnv()} onChange={(e) => (setToEnv(e.currentTarget.checked), setAskIgnore(false))} />
              <span>{t("{name}의 .env에도 쓰기", { name: p().name })}</span>
              <span class="set-note">{t("Ondra 밖에서 실행해도 같은 값이 쓰여요. 파일에는 값이 그대로 저장돼요")}</span>
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

      <GroupTitle title={t("{where}의 시크릿", { where: where() })} />
      <div class="set-group">
        <Show when={names().length} fallback={<div class="empty-line"><span>{t("아직 없어요")}</span></div>}>
          <For each={names()}>
            {(n) => (
              <div class="set-row">
                <div class="set-label"><b><code>{n}</code></b></div>
                <div class="set-value">
                  <Show when={scope() !== GLOBAL && saved().global.includes(n)}>
                    <span class="set-note">{t("모든 작업의 값보다 먼저 쓰여요")}</span>
                  </Show>
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
      <p class="sec-intro">
        {scope() === GLOBAL
          ? t("모든 작업의 시크릿은 어느 프로젝트에서나 쓰여요. 프로젝트에 같은 이름이 있으면 그쪽이 먼저예요. 새 값은 다음에 시작하는 작업부터 쓰여요.")
          : t("이 프로젝트의 작업은 모든 작업의 시크릿과 이 목록을 함께 써요. 지우면 .env에서도 지워요(손으로 바꾼 줄은 남겨요). 새 값은 다음에 시작하는 작업부터 쓰여요.")}
      </p>
    </>
  );
}
