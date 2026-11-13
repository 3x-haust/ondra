// Settings › 시크릿: API keys and passwords a job's commands use as $NAME, for every job or for
// one project. Opening the page takes the keys, tokens and passwords this Mac's projects already
// keep in their .env files (any folder inside them) into the keychain by itself (secret_sync). A
// value typed here goes to the keychain (and, for a project, into its .env if asked) and never
// comes back to this page; jobs get it in their shell and the model sees [secret:NAME] wherever
// it would show (extensions/secrets.ts).
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { secretDelete, secretList, secretOverview, secretSet, secretSync, type SavedSecrets, type SecretGroup } from "../lib/native";
import { state } from "../state/store";
import { toast } from "../state/ui";
import { Icon } from "../ui/Icon";
import { PageHead } from "./Settings";
import { t } from "../i18n";

const GLOBAL = "";
/** A project secret is "NAME" or "dir/sub:NAME" (from the .env in that folder). */
const split = (item: string) => {
  const i = item.lastIndexOf(":");
  return i < 0 ? { dir: "", name: item } : { dir: item.slice(0, i), name: item.slice(i + 1) };
};

export function SecretsSettings() {
  const [saved, { mutate: setSaved }] = createResource(secretList, { initialValue: { global: [], projects: {} } as SavedSecrets });
  // 전체: every secret, the ones with the same value (base64 of one key in two places …) as one row
  const [groups, { refetch: regroup }] = createResource(secretOverview, { initialValue: [] as SecretGroup[] });
  const mutate = (s: SavedSecrets) => (setSaved(s), regroup());
  // this Mac's projects of the current workspace (a project on another Mac has its .env there)
  const projects = createMemo(() => (state.projects ?? []).filter((p) => p.space === state.space && !p.host));
  const [scope, setScope] = createSignal(GLOBAL);
  const project = () => projects().find((p) => p.id === scope());
  const items = () => saved().projects[scope()] ?? [];
  const placeLabel = (pl: SecretGroup["places"][number]) => {
    const p = pl.project ? (state.projects ?? []).find((x) => x.id === pl.project) : undefined;
    const dir = split(pl.item).dir;
    return pl.project ? `${p?.name ?? t("지운 프로젝트")}${dir ? `/${dir}` : ""}` : t("모든 작업");
  };
  const groupKey = (g: SecretGroup) => g.places.map((pl) => `${pl.project ?? ""}/${pl.item}`).join("|");
  const count = (id: string) => saved().projects[id]?.length ?? 0;
  const [name, setName] = createSignal("");
  const [value, setValue] = createSignal("");
  const [toEnv, setToEnv] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  // .env isn't ignored by git: the save waits for the user's answer
  const [askIgnore, setAskIgnore] = createSignal(false);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const clean = () => name().trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

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
      const replaced = items().includes(clean());
      mutate(await secretSet({ name: clean(), value: value(), project: p?.id, folder: p?.folder, writeDotenv: !!p && toEnv(), addIgnore }));
      toast(replaced ? t("{name}을(를) 바꿨어요", { name: clean() }) : t("{name}을(를) 저장했어요", { name: clean() }));
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
  const remove = async (item: string) => {
    try {
      const p = project();
      mutate(await secretDelete({ name: item, project: p?.id, folder: p?.folder }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    setConfirm(null);
  };
  // a merged row goes from every place it is saved
  const removeGroup = async (g: SecretGroup) => {
    try {
      let last: SavedSecrets | undefined;
      for (const pl of g.places) {
        const p = pl.project ? (state.projects ?? []).find((x) => x.id === pl.project) : undefined;
        last = await secretDelete({ name: pl.item, project: pl.project ?? undefined, folder: p?.folder });
      }
      if (last) mutate(last);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
    setConfirm(null);
  };

  return (
    <>
      <PageHead tab="secrets">
        <select class="select" aria-label={t("적용 범위")} value={scope()} onChange={(e) => (setScope(e.currentTarget.value), setAskIgnore(false), setConfirm(null))}>
          <option value={GLOBAL}>{t("전체")}</option>
          <For each={projects()}>{(p) => <option value={p.id}>{count(p.id) ? `${p.name} · ${count(p.id)}` : p.name}</option>}</For>
        </select>
      </PageHead>

      <div class="set-group">
        <Show when={scope() === GLOBAL}>
          <For each={groups()} fallback={<div class="empty-line">{t("없어요")}</div>}>
            {(g) => (
              <div class="set-row sec-row">
                <code class="sec-key">{g.names.join(" · ")}</code>
                <span class="sec-places">
                  <For each={g.places}>{(pl) => <span class="sec-place">{placeLabel(pl)}</span>}</For>
                </span>
                <span class="spacer" />
                <Show
                  when={confirm() === groupKey(g)}
                  fallback={<button class="icon-btn sm" title={t("삭제")} aria-label={t("{name} 삭제", { name: g.names[0] })} onClick={() => setConfirm(groupKey(g))}><Icon name="trash" size={14} /></button>}
                >
                  <button class="btn sm danger" onClick={() => removeGroup(g)}>{g.places.length > 1 ? t("{n}곳에서 삭제", { n: g.places.length }) : t("삭제")}</button>
                  <button class="btn ghost sm" onClick={() => setConfirm(null)}>{t("취소")}</button>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <For each={scope() === GLOBAL ? [] : items()} fallback={<Show when={scope() !== GLOBAL}><div class="empty-line">{t("없어요")}</div></Show>}>
          {(item) => (
            <div class="set-row sec-row">
              <code class="sec-key">{split(item).name}</code>
              <Show when={split(item).dir}><span class="set-note">{split(item).dir}</span></Show>
              <span class="spacer" />
              <Show
                when={confirm() === item}
                fallback={<button class="icon-btn sm" title={t("삭제")} aria-label={t("{name} 삭제", { name: split(item).name })} onClick={() => setConfirm(item)}><Icon name="trash" size={14} /></button>}
              >
                <button class="btn sm danger" onClick={() => remove(item)}>{t("삭제")}</button>
                <button class="btn ghost sm" onClick={() => setConfirm(null)}>{t("취소")}</button>
              </Show>
            </div>
          )}
        </For>
        <form class="set-row sec-add" onSubmit={(e) => (e.preventDefault(), save())}>
          <input class="input sec-name" placeholder="NAME" aria-label={t("이름")} autocomplete="off" spellcheck={false} value={name()} onInput={(e) => (setName(e.currentTarget.value), setAskIgnore(false))} />
          <input class="input sec-value" type="password" placeholder={t("값")} aria-label={t("값")} autocomplete="off" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
          <Show when={project()}>
            <label class="check sec-env" title={t("Ondra 밖에서 실행해도 같은 값이 쓰여요")}>
              <input type="checkbox" checked={toEnv()} onChange={(e) => (setToEnv(e.currentTarget.checked), setAskIgnore(false))} />.env
            </label>
          </Show>
          <button class="btn primary sm" type="submit" disabled={busy() || !clean() || !value()}>{t("추가")}</button>
        </form>
        <Show when={askIgnore()}>
          <div class="set-row sec-warn">
            <Icon name="alert" size={14} />
            <span>{t(".env가 .gitignore에 없어요")}</span>
            <span class="spacer" />
            <button class="btn primary sm" disabled={busy()} onClick={() => save(true)}>{t(".gitignore에 추가")}</button>
            <button class="btn ghost sm" disabled={busy()} onClick={() => (setToEnv(false), setAskIgnore(false), save())}>{t(".env 빼고 저장")}</button>
          </div>
        </Show>
      </div>
    </>
  );
}
