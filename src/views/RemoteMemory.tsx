// The memory of another Mac's project (Settings › 연결). Its jobs run on that Mac and are told
// that Mac's memory, so this lists, adds, edits and forgets pieces there (engine/far.ts); this
// Mac's own memory is left as it is. Shown in the Memory page's tree under its own heading.
import { createResource, createSignal, For, Show } from "solid-js";
import { farError, farMemAdd, farMemEdit, farMemForget, farMemList, type FarMemory } from "../engine/far";
import { hostName } from "../engine/hosts";
import { splitProjectId } from "../state/mirror";
import { projectsShown, state } from "../state/store";
import type { Project } from "../state/types";
import { toast } from "../state/ui";
import { ago } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";

/** a remote project's row id in the tree */
export const remoteMemId = (p: Project) => `rp:${p.id}`;
/** the other Macs' projects of this space */
export const remoteProjects = () => projectsShown(state.space).filter((p) => !!splitProjectId(p.id));

/** their rows, under the tree */
export function RemoteMemoryRows(props: { sel: string; onSel: (id: string) => void }) {
  return (
    <Show when={remoteProjects().length}>
      <div class="mt-row t-home folder mt-far-head" style={{ "--d": 0 }} role="treeitem">
        <span class="mt-chev" />
        <Icon name="monitor" size={13} class="mt-ic dir" />
        <span class="mt-name">{t("다른 Mac")}</span>
      </div>
      <For each={remoteProjects()}>
        {(p) => (
          <div
            class="mt-row t-home"
            classList={{ on: props.sel === remoteMemId(p) }}
            style={{ "--d": 1 }}
            role="treeitem"
            aria-selected={props.sel === remoteMemId(p)}
            title={`${p.hostName ?? ""} · ${p.folder}`}
            onClick={() => props.onSel(remoteMemId(p))}
          >
            <span class="mt-chev" />
            <Icon name="folder" size={13} class="mt-ic dir" />
            <span class="mt-name">
              {p.name}
              <span class="mt-hint"> · {p.hostName}</span>
            </span>
          </div>
        )}
      </For>
    </Show>
  );
}

/** one remote project's pieces, kept on its Mac */
export function RemoteMemory(props: { id: string }) {
  const p = () => remoteProjects().find((x) => remoteMemId(x) === props.id);
  const far = () => splitProjectId(p()?.id);
  const [err, setErr] = createSignal("");
  const [list, { refetch, mutate }] = createResource(
    () => far(),
    (f) => (setErr(""), farMemList(f.host, f.id).catch((e) => (setErr(farError(e)), [] as FarMemory[]))),
  );
  const [text, setText] = createSignal("");
  const fail = (e: unknown) => toast(farError(e), "bad");
  const add = () => {
    const f = far();
    const v = text().trim();
    if (!f || !v) return;
    setText("");
    void farMemAdd(f.host, { project: f.id, text: v }).then(() => refetch(), fail);
  };
  const edit = (m: FarMemory, v: string) => {
    const f = far();
    if (!f || !v.trim() || v.trim() === m.text) return;
    mutate((l) => l?.map((x) => (x.id === m.id ? { ...x, text: v.trim() } : x)));
    void farMemEdit(f.host, f.id, m.id, v.trim()).catch((e) => (fail(e), refetch()));
  };
  const forget = (m: FarMemory) => {
    const f = far();
    if (!f) return;
    mutate((l) => l?.filter((x) => x.id !== m.id));
    void farMemForget(f.host, f.id, m.id).catch((e) => (fail(e), refetch()));
  };
  return (
    <aside class="md-side">
      <Show when={p()} fallback={<div class="md-empty">{t("없음")}</div>}>
        {(pr) => (
          <div class="md-in">
            <div class="md-head">
              <Icon name="monitor" size={14} class="md-head-ic" />
              <span class="md-title">{pr().name}</span>
              <span class="spacer" />
              <button class="icon-btn sm" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => refetch()}><Icon name="refresh" size={14} /></button>
            </div>
            <div class="md-sub">{t("{name}의 메모리 · 그 Mac에서 하는 작업이 읽어요", { name: hostName(far()!.host) })}</div>
            <form class="mt-add" onSubmit={(e) => (e.preventDefault(), add())}>
              <input placeholder={t("{where}에 메모리 추가", { where: pr().name })} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
            </form>
            <Show when={!list.loading} fallback={<div class="md-empty" />}>
              <Show when={(list() ?? []).length} fallback={<div class="md-empty">{err() || t("없음")}</div>}>
                <div class="ms-list">
                  <For each={list()}>
                    {(m) => (
                      <div class={`ms-piece far mk-${m.kind ?? "fact"}`}>
                        <i />
                        <textarea class="md-text" value={m.text} rows={Math.min(6, Math.ceil(m.text.length / 34) + 1)} onChange={(e) => edit(m, e.currentTarget.value)} />
                        <span class="muted nowrap" title={m.updatedAt ? new Date(m.updatedAt).toLocaleString() : undefined}>{m.updatedAt ? ago(m.updatedAt) : ""}</span>
                        <button class="icon-btn sm" title={t("잊기")} aria-label={t("잊기")} onClick={() => forget(m)}><Icon name="trash" size={14} /></button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        )}
      </Show>
    </aside>
  );
}
