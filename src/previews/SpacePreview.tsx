import { batch, createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { reconcile } from "solid-js/store";
import { Icon } from "../ui/Icon";
import { freshState, setLoaded, setState, state } from "../state/store";
import { focusId, setSidebarHidden, sidebarAway, setView, view } from "../state/ui";
import { Sidebar } from "../views/Sidebar";
import { MainView } from "../views/MainView";
import { ResultsView } from "../views/Results";
import { Devices } from "../views/Devices";
import { t } from "../i18n";
import { SpaceCanvas, workLabel } from "./SpaceCanvas";
import { spaceFixture } from "./spaceFixture";
import { addSpace, canSend, computersIn, connectComputer, makeSpaceModel, memoriesIn, selectedComputer, selectComputer, sendMessage, setAccess, setOnline, showComputerPicker, workState, type Scenario } from "./spaceModel";
import "./spacePreview.css";

type Sheet = { kind: "memory"; space: string; project?: string } | { kind: "computer" | "work"; id: string } | { kind: "connect" | "space" | "picker" | "settings" };

function Dialog(props: { title: string; panel?: boolean; close: () => void; children: JSX.Element }) {
  let dialog!: HTMLDialogElement;
  onMount(() => dialog.showModal());
  return <dialog ref={dialog} class="sx-dialog" classList={{ "sx-sheet": !!props.panel }} aria-label={props.title} onCancel={(e) => { e.preventDefault(); props.close(); }} onClick={(e) => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) props.close(); } }}>
    <header class="sx-dialog-head"><h2>{props.title}</h2><button class="icon-btn sm" aria-label={t("닫기")} onClick={props.close}><Icon name="x" size={16} /></button></header>{props.children}
  </dialog>;
}

export default function SpacePreview() {
  const params = new URLSearchParams(location.search);
  const scenario = params.get("state") ?? "multi";
  const [model, setModel] = createSignal(makeSpaceModel((["simple", "devices", "spaces", "multi", "offline"].includes(scenario) ? scenario : "multi") as Scenario));
  const [filter, setFilter] = createSignal("");
  const [sheet, setSheet] = createSignal<Sheet>();
  const [notice, setNotice] = createSignal("");
  const [theme, setTheme] = createSignal(params.get("theme") === "dark" ? "dark" : "light");
  const [narrow, setNarrow] = createSignal(matchMedia("(max-width: 760px)").matches);
  const at = Date.now() - 120_000;
  let focusBack: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout>;
  const say = (text: string) => { clearTimeout(timer); setNotice(text); timer = setTimeout(() => setNotice(""), 3000); };
  onCleanup(() => clearTimeout(timer));
  // This entry point never mounts App: no saved state, scheduler, relay or engine startup.
  const base = freshState();
  setState({ ...base, onboarded: true, space: "personal", settings: { ...base.settings, language: "ko", theme: theme() as "light" | "dark" } });
  setLoaded(true);
  setView({ name: params.get("view") === "canvas" ? "board" : "main" });
  setSidebarHidden(narrow());
  createEffect(() => {
    const m = model();
    const data = spaceFixture(m, at);
    batch(() => {
      setState("spaces", reconcile(m.spaces));
      setState("projects", reconcile(m.projects));
      setState("memory", reconcile(m.memory));
      setState("tasks", reconcile(data.tasks));
      setState("captain", reconcile(data.captain));
      setState("accounts", reconcile(m.spaces.map((s) => ({ ...base.accounts[0], id: `preview-${s.id}`, space: s.id, providers: ["openai-codex"], model: "openai-codex/gpt-5.6-terra" }))));
    });
  });
  createEffect(() => { document.documentElement.dataset.theme = theme(); document.documentElement.lang = "ko"; setState("settings", "theme", theme() as "light" | "dark"); });
  onMount(() => {
    const mq = matchMedia("(max-width: 760px)");
    const update = () => { setNarrow(mq.matches); setSidebarHidden(mq.matches); };
    mq.addEventListener("change", update);
    onCleanup(() => mq.removeEventListener("change", update));
  });
  const active = () => state.space;
  const space = () => model().spaces.find((s) => s.id === active())!;
  const current = () => selectedComputer(model(), active());
  const project = () => { const v = view(); return v.name === "main" ? v.project : undefined; };
  const close = () => { setSheet(undefined); requestAnimationFrame(() => focusBack?.isConnected && focusBack.focus({ preventScroll: true })); };
  const open = (next: Sheet) => { if (!sheet()) focusBack = document.activeElement as HTMLElement; if (narrow()) setSidebarHidden(true); setSheet(next); };
  const chat = (id = active(), project?: string) => { setState("space", id); setView({ name: "main", project }); close(); if (narrow()) setSidebarHidden(true); };
  const send = (text: string, project?: string) => setModel((m) => sendMessage(m, active(), text, project));
  // Original sidebar and chat rows navigate through the same view store.
  createEffect(() => { const v = view(); if (v.name === "task") open({ kind: "work", id: v.id }); });
  const closeWork = () => { if (view().name === "task") setView({ name: "main" }); close(); };

  function SpaceChecks(props: { value: string[]; onChange: (ids: string[]) => void }) {
    return <div class="sx-checks"><For each={model().spaces}>{(s) => <label><input type="checkbox" checked={props.value.includes(s.id)} onChange={(e) => props.onChange(e.currentTarget.checked ? [...props.value, s.id] : props.value.filter((id) => id !== s.id))} /><span>{s.label}</span><small>{t("작업 · 메모리")}</small></label>}</For></div>;
  }
  function MemorySheet(props: { space: string; project?: string }) {
    const [scope, setScope] = createSignal(props.project ?? "");
    const s = () => model().spaces.find((s) => s.id === props.space)!;
    const ps = () => model().projects.filter((p) => p.space === props.space);
    const p = () => ps().find((p) => p.id === scope());
    return <Dialog title={t("메모리")} panel close={close}>
      <div class="sx-sheet-space"><Icon name="layers" size={16} /><strong>{s().label}</strong><span class="sx-current">{t("이 공간만")}</span></div>
      <label class="sx-field"><span>{t("적용 범위")}</span><select aria-label={t("메모리 적용 범위")} value={scope()} onChange={(e) => setScope(e.currentTarget.value)}><option value="">{t("공간 전체")}</option><For each={ps()}>{(p) => <option value={p.id}>{t("프로젝트 · {name}", { name: p.name })}</option>}</For></select></label>
      <div class="sx-memory-list"><For each={memoriesIn(model(), props.space, p()?.folder)}>{(m) => <article><p>{m.text}</p><span>{m.kind === "preference" ? t("취향") : m.kind === "decision" ? t("결정") : t("규칙")}</span></article>}</For></div>
      <dl class="sx-facts"><div><dt>{t("사용되는 작업")}</dt><dd>{p()?.name ?? t("이 공간의 모든 작업")}</dd></div><div><dt>{t("다른 공간에 공유")}</dt><dd>{t("안 함")}</dd></div></dl>
      <h3 class="sx-label">{t("접근 가능한 기기")}</h3><For each={computersIn(model(), props.space)}>{(c) => <button class="sx-detail-row" onClick={() => open({ kind: "computer", id: c.id })}><Icon name="monitor" size={16} /><span>{c.name}</span><small classList={{ "sx-warning": !c.online }}>{c.local ? t("이 기기") : c.online ? t("연결됨") : t("연결 끊김")}</small></button>}</For>
      <p class="sx-consequence"><Icon name="lock" size={14} />{t("암호·로그인은 자동으로 복사하지 않아요.")}</p>
    </Dialog>;
  }
  function ComputerSheet(props: { id: string }) {
    const computer = () => model().computers.find((c) => c.id === props.id)!;
    const [access, setAllowed] = createSignal([...computer().access]);
    const [editing, setEditing] = createSignal(false);
    return <Dialog title={computer().name} panel close={close}>
      <div class="sx-device-heading"><Icon name="monitor" size={24} /><div><strong>{computer().name}</strong><span classList={{ "sx-warning": !computer().online }}>{computer().local ? t("이 기기") : computer().online ? t("연결됨") : t("연결 끊김")}</span></div></div>
      <div class="sx-section-head"><h3>{t("접근할 수 있는 공간")}</h3><Show when={!editing()}><button class="btn sm ghost" onClick={() => { setAllowed([...computer().access]); setEditing(true); }}>{t("변경")}</button></Show></div>
      <Show when={editing()} fallback={<For each={model().spaces.filter((s) => computer().access.includes(s.id))}>{(s) => <div class="sx-detail-row"><Icon name="layers" size={16} /><span>{s.label}</span><small>{t("작업 · 메모리")}</small></div>}</For>}>
        <SpaceChecks value={access()} onChange={setAllowed} /><div class="sx-form-actions"><button class="btn sm" onClick={() => setEditing(false)}>{t("취소")}</button><button class="btn sm primary" onClick={() => { setModel((m) => setAccess(m, props.id, access())); setEditing(false); say(t("공간 접근을 저장했어요")); }}>{t("저장")}</button></div>
      </Show>
      <Show when={!computer().access.length && !editing()}><p class="sx-empty-text">{t("접근 가능한 공간 없음")}</p></Show>
      <p class="sx-consequence"><Icon name="lock" size={14} />{t("허용한 공간의 작업과 메모리만 이어져요.")}</p>
      <Show when={!computer().local}><div class="sx-device-actions"><button class="btn" onClick={() => setModel((m) => setOnline(m, props.id, !computer().online))}><Icon name={computer().online ? "pause" : "refresh"} size={14} />{computer().online ? t("연결 일시중지") : t("다시 연결")}</button></div></Show>
      <Show when={!computer().online}><p class="sx-offline-detail">{t("작업 상태는 다시 연결하면 확인할 수 있어요.")}</p></Show>
    </Dialog>;
  }
  function ConnectSheet() {
    const [name, setName] = createSignal("");
    const [access, setAllowed] = createSignal<string[]>([]);
    return <Dialog title={t("기기 연결")} close={close}><form onSubmit={(e) => { e.preventDefault(); if (!name().trim() || !access().length) return; setModel((m) => connectComputer(m, name(), access())); close(); say(t("기기를 연결했어요")); }}>
      <label class="sx-field"><span>{t("기기 이름")}</span><input autofocus value={name()} placeholder="Mac Studio" onInput={(e) => setName(e.currentTarget.value)} /></label><fieldset><legend>{t("이 기기가 접근할 공간")}</legend><SpaceChecks value={access()} onChange={setAllowed} /></fieldset>
      <p class="sx-consequence"><Icon name="lock" size={14} />{t("선택하지 않은 공간은 공유하지 않아요. 메모리와 암호는 합쳐지지 않아요.")}</p><div class="sx-form-actions"><button type="button" class="btn" onClick={close}>{t("취소")}</button><button class="btn primary" disabled={!name().trim() || !access().length}>{t("연결")}</button></div>
    </form></Dialog>;
  }
  function AddSheet() {
    const [name, setName] = createSignal("");
    return <Dialog title={t("공간 추가")} close={close}><form onSubmit={(e) => { e.preventDefault(); if (!name().trim()) return; const next = addSpace(model(), name()); setModel(next); chat(next.spaces[next.spaces.length - 1].id); }}><label class="sx-field"><span>{t("공간 이름")}</span><input autofocus value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label><div class="sx-detail-row"><Icon name="monitor" size={16} /><span>{t("처음 사용할 기기")}</span><small>{t("이 Mac")}</small></div><p class="sx-consequence"><Icon name="memory" size={14} />{t("메모리는 새로 시작해요.")}</p><div class="sx-form-actions"><button type="button" class="btn" onClick={close}>{t("취소")}</button><button class="btn primary" disabled={!name().trim()}>{t("만들기")}</button></div></form></Dialog>;
  }
  function PickerSheet() {
    return <Dialog title={t("실행 기기")} close={close}><p class="sx-picker-context">{space().label}</p><For each={computersIn(model(), active())}>{(c) => <button class="sx-picker-row" disabled={!c.online} aria-pressed={model().selected[active()] === c.id} onClick={() => { setModel((m) => selectComputer(m, active(), c.id)); close(); }}><Icon name="monitor" size={16} /><span><strong>{c.name}</strong><small>{c.local ? t("이 기기") : c.online ? t("연결됨") : t("연결 끊김")}</small></span><Show when={model().selected[active()] === c.id}><Icon name="check" size={16} /></Show></button>}</For><Show when={!computersIn(model(), active()).length}><p class="sx-empty-text">{t("이 공간에 접근할 수 있는 기기가 없어요.")}</p></Show><div class="sx-picker-bottom"><button class="btn ghost" onClick={() => open({ kind: "connect" })}><Icon name="plus" size={14} />{t("기기 연결")}</button></div></Dialog>;
  }
  function SettingsSheet() {
    return <Dialog title={t("설정")} panel close={close}><div class="sx-section-head"><h3>{t("연결된 기기")}</h3><button class="btn sm ghost" onClick={() => open({ kind: "connect" })}><Icon name="plus" size={14} />{t("연결")}</button></div><For each={model().computers}>{(c) => <button class="sx-detail-row" onClick={() => open({ kind: "computer", id: c.id })}><Icon name="monitor" size={16} /><span>{c.name}</span><small classList={{ "sx-warning": !c.online }}>{c.local ? t("이 기기") : c.online ? t("연결됨") : t("연결 끊김")}</small><Icon name="chevron" size={12} /></button>}</For><div class="sx-section-head"><h3>{t("공간")}</h3><button class="btn sm ghost" onClick={() => open({ kind: "space" })}><Icon name="plus" size={14} />{t("추가")}</button></div><For each={model().spaces}>{(s) => <button class="sx-detail-row" onClick={() => chat(s.id)}><Icon name="layers" size={16} /><span>{s.label}</span><Icon name="chevron" size={12} /></button>}</For><div class="sx-section-head"><h3>{t("화면")}</h3></div><label class="sx-detail-row"><Icon name="theme" size={16} /><span>{t("테마")}</span><select aria-label={t("테마")} value={theme()} onChange={(e) => setTheme(e.currentTarget.value)}><option value="light">{t("라이트")}</option><option value="dark">{t("다크")}</option></select></label></Dialog>;
  }
  function WorkSheet(props: { id: string }) {
    const job = () => model().work.find((w) => w.id === props.id)!;
    const computer = () => model().computers.find((c) => c.id === job().computer)!;
    const s = () => model().spaces.find((s) => s.id === job().space)!;
    const p = () => model().projects.find((p) => p.id === job().project);
    return <Dialog title={t("작업")} panel close={closeWork}><h3 class="sx-job-title">{job().title}</h3><span class="sx-status-text" classList={{ "sx-warning": workState(model(), job()) === "unknown" }}>{workLabel(workState(model(), job()))}</span><p class="sx-job-step">{workState(model(), job()) === "unknown" ? t("작업 상태는 다시 연결하면 확인할 수 있어요.") : job().step}</p><dl class="sx-facts"><div><dt>{t("공간")}</dt><dd>{s().label}</dd></div><Show when={p()}><div><dt>{t("프로젝트")}</dt><dd>{p()!.name}</dd></div></Show><div><dt>{t("실행 기기")}</dt><dd><button onClick={() => open({ kind: "computer", id: computer().id })}>{computer().name}<Icon name="chevron" size={12} /></button></dd></div></dl><button class="sx-detail-row" onClick={() => open({ kind: "memory", space: job().space, project: job().project })}><Icon name="memory" size={16} /><span>{t("메모리 범위")}</span><Icon name="chevron" size={12} /></button><div class="sx-device-actions"><button class="btn" onClick={() => chat(job().space, job().project)}><Icon name="message" size={14} />{t("대화 열기")}</button><Show when={!computer().online}><button class="btn primary" onClick={() => setModel((m) => setOnline(m, computer().id, true))}><Icon name="refresh" size={14} />{t("다시 연결")}</button></Show></div></Dialog>;
  }

  const status = () => <div class="status-line"><Show when={showComputerPicker(model(), active())}><button class="st-acc st-comp" classList={{ away: !current()?.online }} aria-label={t("실행 기기 선택")} onClick={() => open({ kind: "picker" })}><i class={`cn-dot is-${current()?.online ? "ok" : "offline"}`} /><span class="st-acc-name">{current()?.name ?? t("기기 선택")}</span><Icon name="chevron" size={12} class="st-acc-chev" /></button></Show><span class="st-acc">{t("기본")}</span><Show when={model().spaces.length > 1 || model().computers.length > 1}><button class="st-acc sp-memory-status" onClick={() => open({ kind: "memory", space: active(), project: project() })}><Icon name="lock" size={12} />{space().label} · {t("메모리")}</button></Show></div>;
  const offline = () => <Show when={!canSend(model(), active())}><div class="sp-offline" role="status"><Icon name="alert" size={14} /><span>{current() ? t("{name} · 연결 끊김", { name: current()!.name }) : t("실행할 기기를 선택해 주세요")}</span><button class="btn sm ghost" onClick={() => open({ kind: "picker" })}>{t("기기 선택")}</button><Show when={current()}><button class="btn sm ghost" onClick={() => setModel((m) => setOnline(m, current()!.id, true))}>{t("다시 연결")}</button></Show></div></Show>;
  return <>
    <div class="app sp-preview" classList={{ "sb-hidden": sidebarAway() }}>
      <div class="sb-wrap" inert={sidebarAway() || undefined} onClick={(e) => { if (narrow() && (e.target as Element).closest(".sb-main, .space-seg button, .sb-proj")) setSidebarHidden(true); }}><Sidebar actions={{ newTask: () => { chat(); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#main-input")?.focus()); }, memory: () => open({ kind: "memory", space: active() }), settings: () => open({ kind: "settings" }) }} /></div>
      <Show when={narrow() && !sidebarAway()}><button class="sp-nav-scrim" aria-label={t("메뉴 닫기")} onClick={() => setSidebarHidden(true)} /></Show>
      <main class="main" inert={narrow() && !sidebarAway() || undefined}>
        <div class="panes still"><section class="pane focused corner" data-pane={focusId()} style={{ inset: "0" }}><div class="slide">
        <Show when={view().name === "board"} fallback={<Show when={view().name === "results"} fallback={<Show when={view().name === "devices"} fallback={<MainView interaction={{ send, get status() { return status(); }, get disabled() { return !canSend(model(), active()); }, get top() { return offline(); }, plus: [{ label: t("기기 연결"), icon: "monitor", run: () => open({ kind: "connect" }) }, { label: t("공간 추가"), icon: "plus", run: () => open({ kind: "space" }) }, { label: t("캔버스 열기"), icon: "canvas", run: () => setView({ name: "board" }) }] }} />}><Devices /></Show>}><ResultsView /></Show>}>
          <SpaceCanvas model={model()} active={active()} filter={filter()} onFilter={setFilter} onChat={chat} onMemory={(space, project) => open({ kind: "memory", space, project })} onWork={(id) => open({ kind: "work", id })} onComputer={(id) => open({ kind: "computer", id })} onConnect={() => open({ kind: "connect" })} onAdd={() => open({ kind: "space" })} />
        </Show>
        </div></section></div>
      </main>
    </div>
    <Show when={sheet()} keyed>{(s) => s.kind === "memory" ? <MemorySheet space={s.space} project={s.project} /> : s.kind === "computer" ? <ComputerSheet id={s.id} /> : s.kind === "connect" ? <ConnectSheet /> : s.kind === "space" ? <AddSheet /> : s.kind === "picker" ? <PickerSheet /> : s.kind === "settings" ? <SettingsSheet /> : s.kind === "work" ? <WorkSheet id={s.id} /> : null}</Show>
    <Show when={notice()}><div class="sx-toast" role="status">{notice()}</div></Show>
  </>;
}
