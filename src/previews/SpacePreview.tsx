import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Composer } from "../ui/Composer";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { setLoaded, setState } from "../state/store";
import { t } from "../i18n";
import { SpaceCanvas, WorkCard, workLabel } from "./SpaceCanvas";
import { addSpace, canSend, computersIn, connectComputer, makeSpaceModel, memoriesIn, selectedComputer, selectComputer, sendMessage, setAccess, setOnline, showComputerPicker, showSpacePicker, workState, type Scenario } from "./spaceModel";
import "./spacePreview.css";

type Sheet = { kind: "memory"; space: string; project?: string } | { kind: "computer" | "work"; id: string } | { kind: "connect" | "space" | "switch" | "picker" | "settings" };

function Dialog(props: { title: string; panel?: boolean; close: () => void; children: JSX.Element }) {
  let dialog!: HTMLDialogElement;
  onMount(() => dialog.showModal());
  return <dialog ref={dialog} class="sx-dialog" classList={{ "sx-sheet": !!props.panel }} aria-label={props.title} onCancel={(e) => { e.preventDefault(); props.close(); }} onClick={(e) => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) props.close(); } }}>
    <header class="sx-dialog-head"><h2>{props.title}</h2><button class="icon-btn sm" aria-label={t("닫기")} title={t("닫기")} onClick={props.close}><Icon name="x" size={16} /></button></header>
    {props.children}
  </dialog>;
}

export default function SpacePreview() {
  const params = new URLSearchParams(location.search);
  const scenario = params.get("state") ?? "multi";
  const [model, setModel] = createSignal(makeSpaceModel((["simple", "devices", "spaces", "multi", "offline"].includes(scenario) ? scenario : "multi") as Scenario));
  const [active, setActive] = createSignal("personal");
  const [page, setPage] = createSignal<"chat" | "canvas">(params.get("view") === "canvas" ? "canvas" : "chat");
  const [project, setProject] = createSignal<string>();
  const [filter, setFilter] = createSignal("");
  const [sheet, setSheet] = createSignal<Sheet>();
  const [nav, setNav] = createSignal(false);
  const [narrow, setNarrow] = createSignal(matchMedia("(max-width: 760px)").matches);
  const [theme, setTheme] = createSignal(params.get("theme") === "dark" ? "dark" : "light");
  const [notice, setNotice] = createSignal("");
  let noticeTimer: ReturnType<typeof setTimeout>;
  let focusBack: HTMLElement | null = null;
  const say = (text: string) => { clearTimeout(noticeTimer); setNotice(text); noticeTimer = setTimeout(() => setNotice(""), 3000); };
  onCleanup(() => clearTimeout(noticeTimer));
  onMount(() => {
    document.documentElement.lang = "ko";
    const mq = matchMedia("(max-width: 760px)");
    const update = () => setNarrow(mq.matches);
    mq.addEventListener("change", update);
    onCleanup(() => mq.removeEventListener("change", update));
  });
  // Only this browser page uses the shared visual components' language and input history.
  setLoaded(true);
  setState("settings", "language", "ko");
  createEffect(() => { document.documentElement.dataset.theme = theme(); setState("settings", "theme", theme() as "light" | "dark"); });
  createEffect(() => setState("space", active()));
  const space = () => model().spaces.find((s) => s.id === active())!;
  const current = () => selectedComputer(model(), active());
  const projects = () => model().projects.filter((p) => p.space === active());
  const messages = () => model().messages.filter((m) => m.space === active() && (!project() || model().work.find((w) => w.id === m.work)?.project === project()));
  const jobs = () => model().work.filter((w) => w.space === active());
  const open = (next: Sheet) => { if (!sheet()) focusBack = document.activeElement as HTMLElement; setNav(false); setSheet(next); };
  const close = () => { setSheet(undefined); requestAnimationFrame(() => focusBack?.isConnected && focusBack.focus({ preventScroll: true })); };
  const changeSpace = (id: string) => { setActive(id); setProject(undefined); setNav(false); };
  const chat = (id = active(), p?: string) => { changeSpace(id); setProject(p); setPage("chat"); close(); };
  const send = (text: string) => {
    setModel((m) => sendMessage(m, active(), text, project()));
    requestAnimationFrame(() => { const el = document.querySelector(".sx-thread"); if (el) el.scrollTop = el.scrollHeight; });
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || sheet()) return;
    if (nav()) { setNav(false); document.querySelector<HTMLButtonElement>(".sx-nav-toggle")?.focus(); }
  };
  window.addEventListener("keydown", key);
  onCleanup(() => window.removeEventListener("keydown", key));

  function MemorySheet(props: { space: string; project?: string }) {
    const [scope, setScope] = createSignal(props.project ?? "");
    const s = () => model().spaces.find((s) => s.id === props.space)!;
    const ps = () => model().projects.filter((p) => p.space === props.space);
    const p = () => ps().find((p) => p.id === scope());
    const entries = () => memoriesIn(model(), props.space, p()?.folder);
    return <Dialog title={t("메모리")} panel close={close}>
      <div class="sx-sheet-space"><span class="sx-initial">{s().label.slice(0, 1)}</span><strong>{s().label}</strong><span class="sx-current">{t("이 공간만")}</span></div>
      <label class="sx-field"><span>{t("적용 범위")}</span><select aria-label={t("메모리 적용 범위")} value={scope()} onChange={(e) => setScope(e.currentTarget.value)}><option value="">{t("공간 전체")}</option><For each={ps()}>{(p) => <option value={p.id}>{t("프로젝트 · {name}", { name: p.name })}</option>}</For></select></label>
      <div class="sx-memory-list"><For each={entries()}>{(m) => <article><p>{m.text}</p><span>{m.kind === "preference" ? t("취향") : m.kind === "decision" ? t("결정") : t("규칙")}</span></article>}</For><Show when={!entries().length}><p class="sx-empty-text">{t("저장된 메모리 없음")}</p></Show></div>
      <dl class="sx-facts"><div><dt>{t("사용되는 작업")}</dt><dd>{p()?.name ?? t("이 공간의 모든 작업")}</dd></div><div><dt>{t("다른 공간에 공유")}</dt><dd>{t("안 함")}</dd></div></dl>
      <h3 class="sx-label">{t("접근 가능한 기기")}</h3><For each={computersIn(model(), props.space)}>{(c) => <button class="sx-detail-row" onClick={() => open({ kind: "computer", id: c.id })}><Icon name="monitor" size={16} /><span>{c.name}</span><small classList={{ "sx-warning": !c.online }}>{c.local ? t("이 기기") : c.online ? t("연결됨") : t("연결 끊김")}</small></button>}</For>
      <p class="sx-consequence"><Icon name="lock" size={14} />{t("암호·로그인은 기기를 연결해도 자동으로 복사하지 않아요.")}</p>
    </Dialog>;
  }

  function ComputerSheet(props: { id: string }) {
    const computer = () => model().computers.find((c) => c.id === props.id)!;
    const [access, setAllowed] = createSignal([...computer().access]);
    const [editing, setEditing] = createSignal(false);
    const save = () => { setModel((m) => setAccess(m, props.id, access())); setEditing(false); say(t("공간 접근을 저장했어요")); };
    return <Dialog title={computer().name} panel close={close}>
      <div class="sx-device-heading"><Icon name="monitor" size={24} /><div><strong>{computer().name}</strong><span classList={{ "sx-warning": !computer().online }}>{computer().local ? t("이 기기") : computer().online ? t("연결됨") : t("연결 끊김")}</span></div></div>
      <div class="sx-section-head"><h3>{t("접근할 수 있는 공간")}</h3><Show when={!editing()}><button class="btn sm ghost" onClick={() => { setAllowed([...computer().access]); setEditing(true); }}>{t("변경")}</button></Show></div>
      <Show when={editing()} fallback={<div class="sx-access-list"><For each={model().spaces.filter((s) => computer().access.includes(s.id))}>{(s) => <div class="sx-detail-row"><span class="sx-initial">{s.label.slice(0, 1)}</span><span>{s.label}</span><small>{t("작업 · 메모리")}</small></div>}</For><Show when={!computer().access.length}><p class="sx-empty-text">{t("접근 가능한 공간 없음")}</p></Show></div>}>
        <SpaceChecks value={access()} onChange={setAllowed} />
        <div class="sx-form-actions"><button class="btn sm" onClick={() => setEditing(false)}>{t("취소")}</button><button class="btn sm primary" onClick={save}>{t("저장")}</button></div>
      </Show>
      <p class="sx-consequence"><Icon name="lock" size={14} />{t("허용한 공간의 작업과 메모리만 이어져요.")}</p>
      <Show when={!computer().local}><div class="sx-device-actions"><button class="btn" onClick={() => { setModel((m) => setOnline(m, props.id, !computer().online)); say(computer().online ? t("다시 연결했어요") : t("연결을 일시중지했어요")); }}><Icon name={computer().online ? "pause" : "refresh"} size={14} />{computer().online ? t("연결 일시중지") : t("다시 연결")}</button></div></Show>
      <Show when={!computer().online}><p class="sx-offline-detail">{t("진행 중이던 작업의 상태는 다시 연결하면 확인할 수 있어요.")}</p></Show>
    </Dialog>;
  }

  function SpaceChecks(props: { value: string[]; onChange: (ids: string[]) => void }) {
    return <div class="sx-checks"><For each={model().spaces}>{(s) => <label><input type="checkbox" value={s.id} checked={props.value.includes(s.id)} onChange={(e) => props.onChange(e.currentTarget.checked ? [...props.value, s.id] : props.value.filter((id) => id !== s.id))} /><span class="sx-initial">{s.label.slice(0, 1)}</span><span>{s.label}</span><small>{t("작업 · 메모리")}</small></label>}</For></div>;
  }
  function ConnectSheet() {
    const [name, setName] = createSignal("");
    const [access, setAllowed] = createSignal<string[]>([]);
    return <Dialog title={t("기기 연결")} close={close}><form onSubmit={(e) => { e.preventDefault(); if (!name().trim() || !access().length) return; setModel((m) => connectComputer(m, name(), access())); close(); say(t("기기를 연결했어요")); }}>
      <label class="sx-field"><span>{t("기기 이름")}</span><input autofocus value={name()} placeholder="Mac Studio" onInput={(e) => setName(e.currentTarget.value)} /></label>
      <fieldset><legend>{t("이 기기가 접근할 공간")}</legend><SpaceChecks value={access()} onChange={setAllowed} /></fieldset>
      <p class="sx-consequence"><Icon name="lock" size={14} />{t("선택하지 않은 공간은 공유하지 않아요. 메모리와 암호는 합쳐지지 않아요.")}</p>
      <div class="sx-form-actions"><button type="button" class="btn" onClick={close}>{t("취소")}</button><button type="submit" class="btn primary" disabled={!name().trim() || !access().length}>{t("연결")}</button></div>
    </form></Dialog>;
  }
  function AddSheet() {
    const [name, setName] = createSignal("");
    return <Dialog title={t("공간 추가")} close={close}><form onSubmit={(e) => { e.preventDefault(); if (!name().trim()) return; const next = addSpace(model(), name()); setModel(next); chat(next.spaces[next.spaces.length - 1].id); say(t("공간을 만들었어요")); }}>
      <label class="sx-field"><span>{t("공간 이름")}</span><input autofocus value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label><div class="sx-detail-row"><Icon name="monitor" size={16} /><span>{t("처음 사용할 기기")}</span><small>{t("이 Mac")}</small></div><p class="sx-consequence"><Icon name="memory" size={14} />{t("메모리는 새로 시작해요.")}</p><div class="sx-form-actions"><button type="button" class="btn" onClick={close}>{t("취소")}</button><button class="btn primary" disabled={!name().trim()}>{t("만들기")}</button></div>
    </form></Dialog>;
  }
  function PickerSheet() {
    return <Dialog title={t("실행 기기")} close={close}><p class="sx-picker-context">{space().label}</p><For each={computersIn(model(), active())}>{(c) => <button class="sx-picker-row" disabled={!c.online} aria-pressed={model().selected[active()] === c.id} onClick={() => { setModel((m) => selectComputer(m, active(), c.id)); close(); }}><Icon name="monitor" size={16} /><span><strong>{c.name}</strong><small>{c.local ? t("이 기기") : c.online ? t("연결됨") : t("연결 끊김")}</small></span><Show when={model().selected[active()] === c.id}><Icon name="check" size={16} /></Show></button>}</For><Show when={!computersIn(model(), active()).length}><p class="sx-empty-text">{t("이 공간에 접근할 수 있는 기기가 없어요.")}</p></Show><div class="sx-picker-bottom"><button class="btn ghost" onClick={() => open({ kind: "connect" })}><Icon name="plus" size={14} />{t("기기 연결")}</button></div></Dialog>;
  }
  function SettingsSheet() {
    return <Dialog title={t("설정")} panel close={close}><div class="sx-section-head"><h3>{t("연결된 기기")}</h3><button class="btn sm ghost" onClick={() => open({ kind: "connect" })}><Icon name="plus" size={14} />{t("연결")}</button></div><For each={model().computers}>{(c) => <button class="sx-detail-row" onClick={() => open({ kind: "computer", id: c.id })}><Icon name="monitor" size={16} /><span>{c.name}</span><small classList={{ "sx-warning": !c.online }}>{c.local ? t("이 기기") : c.online ? t("연결됨") : t("연결 끊김")}</small><Icon name="chevron" size={12} /></button>}</For><div class="sx-section-head"><h3>{t("공간")}</h3><button class="btn sm ghost" onClick={() => open({ kind: "space" })}><Icon name="plus" size={14} />{t("추가")}</button></div><For each={model().spaces}>{(s) => <button class="sx-detail-row" onClick={() => chat(s.id)}><span class="sx-initial">{s.label.slice(0, 1)}</span><span>{s.label}</span><Icon name="chevron" size={12} /></button>}</For><div class="sx-section-head"><h3>{t("화면")}</h3></div><label class="sx-detail-row"><Icon name="theme" size={16} /><span>{t("테마")}</span><select aria-label={t("테마")} value={theme()} onChange={(e) => setTheme(e.currentTarget.value)}><option value="light">{t("라이트")}</option><option value="dark">{t("다크")}</option></select></label></Dialog>;
  }
  function WorkSheet(props: { id: string }) {
    const job = () => model().work.find((w) => w.id === props.id)!;
    const computer = () => model().computers.find((c) => c.id === job().computer)!;
    const s = () => model().spaces.find((s) => s.id === job().space)!;
    const p = () => model().projects.find((p) => p.id === job().project);
    return <Dialog title={t("작업")} panel close={close}><div class="sx-job-heading"><i class={`sx-glyph is-${workState(model(), job())}`} /><h3>{job().title}</h3></div><span class="sx-status-text" classList={{ "sx-warning": workState(model(), job()) === "unknown" }}>{workLabel(workState(model(), job()))}</span><p class="sx-job-step">{workState(model(), job()) === "unknown" ? t("진행 중이던 작업의 상태는 다시 연결하면 확인할 수 있어요.") : job().step}</p><dl class="sx-facts"><div><dt>{t("공간")}</dt><dd>{s().label}</dd></div><Show when={p()}><div><dt>{t("프로젝트")}</dt><dd>{p()!.name}</dd></div></Show><div><dt>{t("실행 기기")}</dt><dd><button onClick={() => open({ kind: "computer", id: computer().id })}>{computer().name}<Icon name="chevron" size={12} /></button></dd></div></dl><button class="sx-detail-row" onClick={() => open({ kind: "memory", space: job().space, project: job().project })}><Icon name="memory" size={16} /><span>{t("메모리 범위")}</span><Icon name="chevron" size={12} /></button><div class="sx-device-actions"><button class="btn" onClick={() => chat(job().space, job().project)}><Icon name="message" size={14} />{t("대화 열기")}</button><Show when={!computer().online}><button class="btn primary" onClick={() => setModel((m) => setOnline(m, computer().id, true))}><Icon name="refresh" size={14} />{t("다시 연결")}</button></Show></div></Dialog>;
  }

  return <div class="app sx-app" classList={{ "sx-nav-open": nav() }}>
    <aside class="sidebar sx-sidebar" inert={narrow() && !nav()}>
      <div class="sb-top sx-sidebar-top"><div class="sx-window-dots" aria-hidden="true"><i /><i /><i /></div><span class="spacer" /><button class="icon-btn sx-mobile" aria-label={t("메뉴 닫기")} onClick={() => setNav(false)}><Icon name="x" size={16} /></button></div>
      <Show when={showSpacePicker(model())}><button class="sx-space-switch" aria-label={t("공간 전환")} aria-haspopup="dialog" onClick={() => open({ kind: "switch" })}><span class="sx-initial">{space().label.slice(0, 1)}</span><strong>{space().label}</strong><span class="spacer" /><Icon name="down" size={12} /></button></Show>
      <div class="sb-scroll">
        <button class="sb-row sb-main" classList={{ on: page() === "chat" && !project() }} onClick={() => chat()}><Icon name="message" size={16} /><span class="sb-title">{t("메인")}</span></button>
        <button class="sb-row sb-main" classList={{ on: page() === "canvas" }} onClick={() => { setPage("canvas"); setNav(false); }}><Icon name="canvas" size={16} /><span class="sb-title">{t("캔버스")}</span><span class="sx-nav-count">{model().work.filter((w) => w.status === "running").length || ""}</span></button>
        <button class="sb-row sb-main" onClick={() => open({ kind: "memory", space: active() })}><Icon name="memory" size={16} /><span class="sb-title">{t("메모리")}</span></button>
        <Show when={projects().length}><h2 class="sx-nav-heading">{t("프로젝트")}</h2><For each={projects()}>{(p) => <div><button class="sb-row sb-main" classList={{ on: page() === "chat" && project() === p.id }} onClick={() => chat(active(), p.id)}><Icon name="folder" size={16} /><span class="sb-title">{p.name}</span></button><For each={jobs().filter((w) => w.project === p.id)}>{(w) => <button class="sb-row sx-job-row" onClick={() => open({ kind: "work", id: w.id })}><i class={`sx-glyph is-${workState(model(), w)}`} /><span class="sb-title">{w.title}</span></button>}</For></div>}</For></Show>
        <Show when={jobs().some((w) => !w.project)}><h2 class="sx-nav-heading">{t("최근 작업")}</h2><For each={jobs().filter((w) => !w.project)}>{(w) => <button class="sb-row" onClick={() => open({ kind: "work", id: w.id })}><i class={`sx-glyph is-${workState(model(), w)}`} /><span class="sb-title">{w.title}</span></button>}</For></Show>
      </div>
      <div class="sx-sidebar-bottom"><button class="sb-row" onClick={() => open({ kind: "settings" })}><Icon name="gear" size={16} /><span class="sb-title">{t("설정")}</span></button><Show when={model().computers.length > 1}><button class="sx-connection-summary" onClick={() => open({ kind: "settings" })}><i class="sx-online-dot" classList={{ offline: model().computers.some((c) => !c.online) }} />{model().computers.some((c) => !c.online) ? t("연결 끊긴 기기 {n}대", { n: model().computers.filter((c) => !c.online).length }) : t("기기 {n}대 연결됨", { n: model().computers.length })}<Icon name="chevron" size={12} /></button></Show></div>
    </aside>
    <Show when={narrow() && nav()}><button class="sx-nav-scrim" aria-label={t("메뉴 닫기")} onClick={() => setNav(false)} /></Show>
    <main class="main sx-main" inert={narrow() && nav()}>
      <header class="head sx-head"><button class="icon-btn sx-mobile sx-nav-toggle" aria-label={t("메뉴 열기")} onClick={() => { setNav(true); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".sx-sidebar .sx-mobile")?.focus()); }}><Icon name="panelLeft" size={16} /></button><h1>{page() === "canvas" ? t("캔버스") : projects().find((p) => p.id === project())?.name ?? t("메인")}</h1><Show when={page() === "chat" && showSpacePicker(model())}><span class="sx-breadcrumb">/ {space().label}</span></Show><span class="spacer" /><Show when={page() === "canvas"} fallback={<button class="btn sm ghost sx-head-canvas" onClick={() => setPage("canvas")}><Icon name="canvas" size={15} />{t("캔버스 열기")}</button>}><button class="btn sm ghost" onClick={() => chat()}><Icon name="message" size={15} />{t("대화로")}</button></Show><button class="icon-btn" title={t("메모리 범위")} aria-label={t("메모리 범위")} onClick={() => open({ kind: "memory", space: active(), project: project() })}><Icon name="memory" size={16} /></button></header>
      <Show when={page() === "canvas"} fallback={<section class="sx-chat" classList={{ empty: !messages().length }}>
        <div class="sx-thread"><div class="sx-thread-inner"><Show when={messages().length} fallback={<div class="sx-welcome"><h2>{t("무엇을 할까요?")}</h2></div>}><For each={messages()}>{(message) => <div class="sx-turn"><div class="sx-user-message">{message.text}</div><Markdown text={message.reply} class="sx-answer" /><Show when={model().work.find((w) => w.id === message.work)}>{(w) => <WorkCard work={w()} model={model()} onOpen={() => open({ kind: "work", id: w().id })} />}</Show><button class="sx-turn-canvas" onClick={() => { setFilter(active()); setPage("canvas"); }}><Icon name="canvas" size={14} />{t("캔버스에서 보기")}<Icon name="arrow" size={12} /></button></div>}</For></Show></div></div>
        <div class="sx-compose-dock"><Show when={!canSend(model(), active())}><div class="sx-offline-banner" role="status"><Icon name="alert" size={16} /><div><strong>{current() ? t("{name}에 연결할 수 없어요", { name: current()!.name }) : t("실행할 기기를 선택해 주세요")}</strong><span>{current() ? t("작업 상태는 다시 연결하면 확인할 수 있어요.") : t("이 공간에 접근할 수 있는 기기가 필요해요.")}</span></div><button class="btn sm" onClick={() => current() ? setModel((m) => setOnline(m, current()!.id, true)) : open({ kind: "picker" })}>{current() ? t("다시 연결") : t("기기 선택")}</button></div></Show>
          <Composer id="space-input" placeholder={t("무엇을 할까요?")} draftKey={`space-preview:${active()}:${project() ?? ""}`} onSend={send} disabled={!canSend(model(), active())} big
            left={<Show when={showComputerPicker(model(), active())}><button class="chip sx-run-chip" type="button" aria-label={t("실행 기기 선택")} aria-haspopup="dialog" onClick={() => open({ kind: "picker" })}><i class="sx-online-dot" classList={{ offline: !current()?.online }} /><span>{current()?.name ?? t("기기 선택")}</span><Icon name="down" size={12} /></button></Show>}
            right={<span class="sx-model-name">{t("기본 모델")}</span>}
            plus={[{ label: t("기기 연결"), icon: "monitor", run: () => open({ kind: "connect" }) }, { label: t("공간 추가"), icon: "plus", run: () => open({ kind: "space" }) }, { label: t("캔버스 열기"), icon: "canvas", run: () => setPage("canvas") }]}
          />
          <Show when={showSpacePicker(model()) || model().computers.length > 1}><div class="sx-compose-context"><button onClick={() => open({ kind: "memory", space: active(), project: project() })}><Icon name="lock" size={12} />{t("{name}의 메모리 사용", { name: space().label })}</button><span>{projects().find((p) => p.id === project())?.name ?? ""}</span></div></Show>
        </div>
      </section>}><SpaceCanvas model={model()} active={active()} filter={filter()} onFilter={setFilter} onChat={chat} onMemory={(space, project) => open({ kind: "memory", space, project })} onWork={(id) => open({ kind: "work", id })} onComputer={(id) => open({ kind: "computer", id })} onConnect={() => open({ kind: "connect" })} onAdd={() => open({ kind: "space" })} /></Show>
    </main>
    <Show when={sheet()} keyed>{(s) => s.kind === "memory" ? <MemorySheet space={s.space} project={s.project} /> : s.kind === "computer" ? <ComputerSheet id={s.id} /> : s.kind === "connect" ? <ConnectSheet /> : s.kind === "space" ? <AddSheet /> : s.kind === "picker" ? <PickerSheet /> : s.kind === "settings" ? <SettingsSheet /> : s.kind === "work" ? <WorkSheet id={s.id} /> : <Dialog title={t("공간 전환")} close={close}><For each={model().spaces}>{(space) => <button class="sx-picker-row" aria-pressed={active() === space.id} onClick={() => { changeSpace(space.id); close(); }}><span class="sx-initial">{space.label.slice(0, 1)}</span><span>{space.label}</span><Show when={active() === space.id}><Icon name="check" size={16} /></Show></button>}</For><div class="sx-picker-bottom"><button class="btn ghost" onClick={() => open({ kind: "space" })}><Icon name="plus" size={14} />{t("공간 추가")}</button></div></Dialog>}</Show>
    <Show when={notice()}><div class="sx-toast" role="status">{notice()}</div></Show>
  </div>;
}
