// 직접 연결: a model server by its address and key (Ollama, LM Studio, OpenRouter, any
// OpenAI- or Anthropic-compatible API). It becomes an account of its own: its models
// are written to that account's engine models.json, its key to the keychain.
import { batch, createSignal, For, onMount, Show } from "solid-js";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { accountById, setState, uid, updateAccount } from "../state/store";
import type { Connection, ConnectionApi, ConnectionModel, SpaceId } from "../state/types";
import { accountRemove, providerCheck, providerModels, providerSave, type FoundModel, type ProviderFail, type ProviderTarget } from "../lib/native";
import { APIS, defaults, firstModel, GENERIC_PRESETS, modelFromFound, normalBase, PRESETS, presetForm, presetOf, providerEntry, providerId } from "../engine/connections";
import { refreshModels } from "../engine/modelList";

/** A failed request in plain words (Korean keys), with the server's own words under it. */
export function failText(f: unknown): { text: string; detail?: string } {
  const e = (typeof f === "object" && f && "kind" in f ? f : { kind: "http", detail: String(f) }) as ProviderFail;
  const status = e.status ?? "";
  const text =
    e.kind === "unreachable" ? t("주소에 연결할 수 없어요 · 서버가 켜져 있는지 확인하세요")
    : e.kind === "timeout" ? t("응답이 없어요 · 잠시 뒤 다시 해 보세요")
    : e.kind === "auth" ? t("키가 맞지 않거나 권한이 없어요")
    : e.kind === "notFound" ? t("이 주소에 API가 없어요 · 주소 끝(/v1)을 확인하세요")
    : e.kind === "model" ? t("이 모델을 찾을 수 없어요")
    : e.kind === "rate" ? t("요청이 너무 많아요 · 잠시 뒤 다시 해 보세요")
    : e.kind === "server" ? t("서버 오류예요 ({s})", { s: status })
    : e.kind === "badResponse" ? t("API 응답이 아니에요 · 주소를 확인하세요")
    : e.kind === "badUrl" ? t("주소는 http:// 또는 https://로 시작해야 해요")
    : status ? t("요청이 거절됐어요 ({s})", { s: status }) : t("요청이 거절됐어요");
  return { text, detail: e.detail?.trim() || undefined };
}

type Checked = { ok: true; ms: number; tools: boolean | null } | { ok: false; text: string; detail?: string } | "busy";
type Row = ConnectionModel & { on: boolean };

export function ConnectionSheet(props: { space: SpaceId; accountId?: string; onClose: () => void }) {
  const editing = props.accountId ? accountById(props.accountId) : undefined;
  const conn = editing?.connection;
  const accountId = props.accountId ?? uid("acc");
  const [preset, setPreset] = createSignal(conn?.preset ?? "ollama");
  const [name, setName] = createSignal(editing?.label ?? presetForm("ollama").name);
  const [baseUrl, setBaseUrl] = createSignal(conn?.baseUrl ?? presetForm("ollama").baseUrl);
  const [api, setApi] = createSignal<ConnectionApi>(conn?.api ?? "openai-completions");
  const [key, setKey] = createSignal("");
  // editing: the stored key stays unless a new one is typed or it is cleared
  const [keyTouched, setKeyTouched] = createSignal(false);
  const hasStoredKey = () => !!conn?.hasKey && !keyTouched();
  const [headers, setHeaders] = createSignal<{ name: string; value: string | null }[]>((conn?.headers ?? []).map((n) => ({ name: n, value: null })));
  const [rows, setRows] = createSignal<Row[]>((conn?.models ?? []).map((m) => ({ ...m, on: true })));
  const [listing, setListing] = createSignal(false);
  const [listErr, setListErr] = createSignal<{ text: string; detail?: string }>();
  const [checks, setChecks] = createSignal<Record<string, Checked>>({});
  const [typed, setTyped] = createSignal("");
  const [saveErr, setSaveErr] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const local = () => !!presetOf(preset()).local;

  let nameEl!: HTMLInputElement;
  onMount(() => requestAnimationFrame(() => (editing ? nameEl.focus() : undefined)));

  const pick = (id: string) => {
    const f = presetForm(id);
    batch(() => {
      setPreset(id);
      setName(f.name);
      setBaseUrl(f.baseUrl);
      setApi(f.api);
      setRows([]);
      setChecks({});
      setListErr(undefined);
    });
  };

  const target = (): ProviderTarget => ({
    baseUrl: normalBase(api(), baseUrl()),
    api: api(),
    key: hasStoredKey() ? null : key().trim() || null,
    headers: headers().filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })),
    stored: editing && conn ? { accountId, provider: conn.provider } : null,
  });

  const merge = (found: FoundModel[]) =>
    setRows((have) => {
      const byId = new Map(have.map((r) => [r.id, r]));
      const out = [...have];
      for (const f of found) if (!byId.has(f.id)) out.push({ ...modelFromFound(f, local()), on: false });
      return out;
    });

  const list = async () => {
    setListing(true);
    setListErr(undefined);
    try {
      const found = await providerModels(target());
      merge(found);
      // one model only: it is the one to use
      if (found.length === 1) setRows((r) => r.map((x) => (x.id === found[0].id ? { ...x, on: true } : x)));
    } catch (e) {
      setListErr(failText(e));
    } finally {
      setListing(false);
    }
  };

  const addTyped = () => {
    const id = typed().trim();
    if (!id) return;
    setRows((r) => (r.some((x) => x.id === id) ? r.map((x) => (x.id === id ? { ...x, on: true } : x)) : [...r, { id, ...defaults(local()), tools: true, reasoning: false, image: false, on: true }]));
    setTyped("");
  };

  const edit = (id: string, f: (r: Row) => Row) => setRows((rs) => rs.map((r) => (r.id === id ? f(r) : r)));
  const chosen = () => rows().filter((r) => r.on);

  /** 연결 확인: every chosen model answers, and whether it calls a tool sets 도구 사용 가능 */
  const check = async () => {
    for (const r of chosen()) {
      setChecks((c) => ({ ...c, [r.id]: "busy" }));
      try {
        const res = await providerCheck(target(), r.id, r.reasoning);
        if (res.tools !== null) edit(r.id, (x) => ({ ...x, tools: !!res.tools }));
        setChecks((c) => ({ ...c, [r.id]: { ok: true, ms: res.ms, tools: res.tools } }));
      } catch (e) {
        const f = failText(e);
        setChecks((c) => ({ ...c, [r.id]: { ok: false, ...f } }));
        // the address or key is wrong: the other models would say the same
        if (!(typeof e === "object" && e && (e as ProviderFail).kind === "model")) break;
      }
    }
  };
  const checking = () => Object.values(checks()).includes("busy");

  const save = async () => {
    const url = baseUrl().trim();
    const label = name().trim() || (GENERIC_PRESETS.has(preset()) ? (() => { try { return new URL(url).host; } catch { return ""; } })() : presetOf(preset()).name);
    if (!/^https?:\/\//.test(url)) return setSaveErr(t("주소는 http:// 또는 https://로 시작해야 해요"));
    if (!chosen().length) return setSaveErr(t("쓸 모델을 하나 이상 고르세요"));
    if (presetOf(preset()).key === "required" && !hasStoredKey() && !key().trim()) return setSaveErr(t("API 키가 필요해요"));
    setSaveErr("");
    setSaving(true);
    const provider = conn?.provider ?? providerId(label);
    const next: Connection = {
      provider,
      preset: preset(),
      baseUrl: normalBase(api(), url),
      api: api(),
      headers: headers().map((h) => h.name.trim()).filter(Boolean),
      hasKey: hasStoredKey() || !!key().trim(),
      models: chosen().map(({ on: _, ...m }) => m),
    };
    try {
      const keyArg = editing ? (keyTouched() ? key().trim() : null) : key().trim();
      await providerSave(accountId, provider, providerEntry(next, label), keyArg, target().headers);
    } catch (e) {
      setSaving(false);
      if (!editing) void accountRemove(accountId).catch(() => {});
      return setSaveErr(typeof e === "string" ? t(e) : failText(e).text);
    }
    if (editing) {
      updateAccount(accountId, (a) => {
        a.label = label;
        a.connection = next;
        a.providers = [...new Set([...a.providers.filter((p) => !p.startsWith("direct-")), provider])];
        if (!next.models.some((m) => `${provider}/${m.id}` === a.model)) a.model = firstModel(next);
        a.badModels = [];
      });
    } else {
      setState("accounts", (l) => [
        ...l,
        { id: accountId, space: props.space, label, providers: [provider], model: firstModel(next), badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, connection: next },
      ]);
    }
    void refreshModels(accountId, true);
    setSaving(false);
    props.onClose();
  };

  const Status = (p: { id: string }) => {
    const c = () => checks()[p.id];
    return (
      <Show when={c()}>
        {(s) => (
          <Show when={s() !== "busy"} fallback={<span class="cn-st"><span class="spin sm" /></span>}>
            {(() => {
              const v = s() as Exclude<Checked, "busy">;
              return v.ok ? (
                <span class="cn-st ok">{[t("응답함"), `${(v.ms / 1000).toFixed(1)}s`, v.tools === false ? t("도구 없음") : v.tools ? t("도구 확인됨") : ""].filter(Boolean).join(" · ")}</span>
              ) : (
                <span class="cn-st bad" title={v.detail}>{v.text}</span>
              );
            })()}
          </Show>
        )}
      </Show>
    );
  };

  return (
    <Sheet
      title={editing ? editing.label : t("직접 연결|provider")}
      class="sp-sheet cn-sheet"
      onClose={props.onClose}
      foot={
        <>
          <Show when={saveErr()}><span class="cn-err">{saveErr()}</span></Show>
          <span class="spacer" />
          <button class="btn sm" disabled={!chosen().length || checking()} onClick={() => void check()}>{checking() ? t("확인 중") : t("연결 확인")}</button>
          <button class="btn sm" onClick={props.onClose}>{t("취소")}</button>
          <button class="btn primary sm" disabled={saving()} onClick={() => void save()}>{editing ? t("저장") : t("추가")}</button>
        </>
      }
    >
      <div class="sp-form">
        <Show when={!editing}>
          <div class="sp-field">
            <span>{t("종류")}</span>
            <div class="seg cn-presets" role="radiogroup" aria-label={t("종류")}>
              <For each={PRESETS}>
                {(p) => (
                  <button type="button" role="radio" aria-checked={preset() === p.id} classList={{ on: preset() === p.id }} onClick={() => pick(p.id)}>
                    {GENERIC_PRESETS.has(p.id) ? t(p.name) : p.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <label class="sp-field">
          <span>{t("이름")}</span>
          <input ref={nameEl} class="input" value={name()} placeholder={GENERIC_PRESETS.has(preset()) ? t("예: 회사 게이트웨이") : presetOf(preset()).name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="sp-field">
          <span>{t("주소")}</span>
          <input class="input" value={baseUrl()} placeholder={presetOf(preset()).example ?? presetOf(preset()).baseUrl} spellcheck={false} autocomplete="off" onInput={(e) => setBaseUrl(e.currentTarget.value)} />
        </label>
        <label class="sp-field">
          <span>{t("API 형식")}</span>
          <select class="select" value={api()} onChange={(e) => setApi(e.currentTarget.value as ConnectionApi)}>
            <For each={APIS}>{(a) => <option value={a.id}>{t(a.label)}</option>}</For>
          </select>
        </label>
        <div class="sp-field">
          <span>{t("API 키")}</span>
          <div class="cn-key">
            <input
              class="input"
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={key()}
              aria-label={t("API 키")}
              placeholder={hasStoredKey() ? t("저장된 키 유지") : presetOf(preset()).key === "none" ? t("필요 없음") : presetOf(preset()).key === "required" ? t("필수") : t("선택|optional")}
              onInput={(e) => (setKey(e.currentTarget.value), setKeyTouched(true))}
            />
            <Show when={conn?.hasKey && !keyTouched()}>
              <button class="btn ghost sm" onClick={() => (setKey(""), setKeyTouched(true))}>{t("키 지우기")}</button>
            </Show>
          </div>
        </div>
        <div class="sp-field sp-top">
          <span>{t("추가 헤더")}</span>
          <div class="cn-headers">
            <For each={headers()}>
              {(h, i) => (
                <div class="cn-header">
                  <input class="input" placeholder={t("이름")} aria-label={t("헤더 이름")} value={h.name} spellcheck={false} onInput={(e) => setHeaders((l) => l.map((x, j) => (j === i() ? { ...x, name: e.currentTarget.value } : x)))} />
                  <input class="input" type="password" autocomplete="off" placeholder={h.value === null ? t("저장된 값 유지") : t("값")} aria-label={t("헤더 값")} value={h.value ?? ""} onInput={(e) => setHeaders((l) => l.map((x, j) => (j === i() ? { ...x, value: e.currentTarget.value } : x)))} />
                  <button class="icon-btn sm" title={t("삭제")} aria-label={t("삭제")} onClick={() => setHeaders((l) => l.filter((_, j) => j !== i()))}><Icon name="x" size={14} /></button>
                </div>
              )}
            </For>
            <button class="btn ghost sm cn-add" onClick={() => setHeaders((l) => [...l, { name: "", value: "" }])}><Icon name="plus" size={14} />{t("헤더 추가")}</button>
          </div>
        </div>
        <div class="sp-field sp-top">
          <span>{t("모델|list")}</span>
          <div class="cn-models">
            <div class="cn-model-bar">
              <button class="btn sm" disabled={listing() || !baseUrl().trim()} onClick={() => void list()}>
                <Show when={listing()} fallback={<Icon name="download" size={14} />}><span class="spin sm" /></Show>
                {t("모델 불러오기")}
              </button>
              <input class="input" placeholder={t("모델 ID 직접 입력")} aria-label={t("모델 ID 직접 입력")} value={typed()} spellcheck={false} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTyped())} />
              <button class="btn ghost sm" disabled={!typed().trim()} onClick={addTyped}>{t("추가")}</button>
            </div>
            <Show when={listErr()}>{(e) => <div class="cn-st bad" title={e().detail}>{e().text}<Show when={e().detail}><span class="cn-detail">{e().detail}</span></Show></div>}</Show>
            <Show when={rows().length}>
              <div class="cn-list">
                <For each={rows()}>
                  {(r) => (
                    <div class="cn-model" classList={{ on: r.on }}>
                      <div class="cn-model-line">
                        <label class="check cn-model-id" title={r.name ?? r.id}>
                          <input type="checkbox" checked={r.on} onChange={(e) => edit(r.id, (x) => ({ ...x, on: e.currentTarget.checked }))} />
                          <code>{r.id}</code>
                        </label>
                        <Status id={r.id} />
                      </div>
                      <Show when={r.on}>
                        <div class="cn-model-opts">
                          <label class="check"><input type="checkbox" checked={r.tools} onChange={(e) => edit(r.id, (x) => ({ ...x, tools: e.currentTarget.checked }))} />{t("도구 사용 가능")}</label>
                          <label class="check"><input type="checkbox" checked={r.reasoning} onChange={(e) => edit(r.id, (x) => ({ ...x, reasoning: e.currentTarget.checked }))} />{t("추론")}</label>
                          <label class="cn-num">
                            <span>{t("컨텍스트")}</span>
                            <input class="input" type="number" min="1024" step="1024" value={r.contextWindow} onChange={(e) => edit(r.id, (x) => ({ ...x, contextWindow: Math.max(1024, Number(e.currentTarget.value) || x.contextWindow) }))} />
                          </label>
                          <label class="cn-num">
                            <span>{t("최대 출력")}</span>
                            <input class="input" type="number" min="256" step="256" value={r.maxTokens} onChange={(e) => edit(r.id, (x) => ({ ...x, maxTokens: Math.max(256, Number(e.currentTarget.value) || x.maxTokens) }))} />
                          </label>
                          <Show when={r.reasoning}>
                            <label class="cn-num cn-efforts" title={t("서버가 받는 reasoning_effort 값")}>
                              <span>{t("추론 강도 값")}</span>
                              <input class="input" placeholder="low, medium, high" value={(r.efforts ?? []).join(", ")} spellcheck={false} onChange={(e) => edit(r.id, (x) => ({ ...x, efforts: e.currentTarget.value.split(/[\s,]+/).filter(Boolean) }))} />
                            </label>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

