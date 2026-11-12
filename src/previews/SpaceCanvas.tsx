import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DotGrid } from "../ui/DotGrid";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { computersIn, workState, type Computer, type SpaceModel, type Work } from "./spaceModel";

export const workLabel = (status: Work["status"] | "unknown") => t(({ running: "진행 중", done: "완료", paused: "일시정지", waiting: "응답 필요", queued: "대기", failed: "실패", unknown: "상태 미확인" })[status]);

export function WorkCard(props: { work: Work; model: SpaceModel; onOpen: () => void }) {
  const status = () => workState(props.model, props.work);
  const computer = () => props.model.computers.find((c) => c.id === props.work.computer);
  return <button class="sx-work" data-work={props.work.id} onClick={props.onOpen}>
    <span class="sx-work-head"><i class={`sx-glyph is-${status()}`} /><strong>{props.work.title}</strong></span>
    <span class="sx-work-step">{status() === "unknown" ? t("다시 연결하면 확인할 수 있어요") : props.work.step}</span>
    <span class="sx-work-foot"><span classList={{ "sx-warning": status() === "unknown" }}>{workLabel(status())}</span><span><Icon name="monitor" size={12} />{computer()?.name}</span></span>
  </button>;
}

export function ComputerChip(props: { computer: Computer; selected?: boolean; onClick: () => void }) {
  return <button class="sx-computer" classList={{ selected: !!props.selected, offline: !props.computer.online }} onClick={props.onClick}>
    <Icon name="monitor" size={14} /><span>{props.computer.name}</span>
    <Show when={!props.computer.online} fallback={<Show when={props.selected}><Icon name="check" size={12} /></Show>}><span class="sx-warning">{t("연결 끊김")}</span></Show>
  </button>;
}

export function SpaceCanvas(props: {
  model: SpaceModel; active: string; filter: string; onFilter: (id: string) => void;
  onChat: (space: string, project?: string) => void; onMemory: (space: string, project?: string) => void;
  onWork: (id: string) => void; onComputer: (id: string) => void; onConnect: () => void; onAdd: () => void;
}) {
  const [zoom, setZoom] = createSignal(1);
  const [grid, setGrid] = createSignal(true);
  const [scroll, setScroll] = createSignal({ x: 0, y: 0 });
  const [size, setSize] = createSignal({ w: 1040, h: 560 });
  let viewport!: HTMLDivElement;
  let world!: HTMLDivElement;
  const spaces = () => props.model.spaces.filter((s) => !props.filter || s.id === props.filter);
  onMount(() => {
    const measure = () => setSize({ w: world.offsetWidth, h: world.offsetHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(world);
    onCleanup(() => ro.disconnect());
  });
  const pan = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("button, select, a")) return;
    const start = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
    const move = (ev: PointerEvent) => { viewport.scrollLeft = start.left - ev.clientX + start.x; viewport.scrollTop = start.top - ev.clientY + start.y; };
    const stop = () => { viewport.classList.remove("panning"); viewport.removeEventListener("pointermove", move); viewport.removeEventListener("pointerup", stop); viewport.removeEventListener("pointercancel", stop); };
    viewport.addEventListener("pointermove", move); viewport.addEventListener("pointerup", stop); viewport.addEventListener("pointercancel", stop);
  };
  return <section class="sx-canvas" aria-label={t("공간 캔버스")}>
    <div class="sx-canvas-bar">
      <label class="sx-scope"><Icon name="tidy" size={14} /><select aria-label={t("캔버스 범위")} value={props.filter} onChange={(e) => props.onFilter(e.currentTarget.value)}>
        <option value="">{t("모든 공간")}</option><For each={props.model.spaces}>{(s) => <option value={s.id}>{s.label}</option>}</For>
      </select></label>
      <span class="sx-canvas-context">{t("{name}에서 대화 중", { name: props.model.spaces.find((s) => s.id === props.active)?.label ?? "" })}</span>
      <div class="spacer" /><button class="btn sm ghost" onClick={props.onConnect}><Icon name="monitor" size={14} />{t("기기 연결")}</button>
      <button class="btn sm ghost" onClick={props.onAdd}><Icon name="plus" size={14} />{t("공간 추가")}</button>
    </div>
    <div class="sx-map-shell">
      <DotGrid pan={{ x: -scroll().x, y: -scroll().y }} zoom={zoom()} on={grid()} />
      <div class="sx-map-scroll" ref={viewport} onPointerDown={pan} onScroll={() => setScroll({ x: viewport.scrollLeft, y: viewport.scrollTop })}>
        <div class="sx-map-size" style={{ width: `${size().w * zoom() + 64}px`, height: `${size().h * zoom() + 64}px` }}>
          <div class="sx-world" classList={{ single: spaces().length === 1 }} ref={world} style={{ transform: `scale(${zoom()})` }}>
            <For each={spaces()}>{(space) => {
              const projects = () => props.model.projects.filter((p) => p.space === space.id);
              const jobs = () => props.model.work.filter((w) => w.space === space.id);
              const unfiled = () => jobs().filter((w) => !w.project);
              const memories = () => props.model.memory.filter((m) => m.space === space.id && !m.invalidAt).length;
              return <section class="sx-space" classList={{ current: props.active === space.id }} data-space={space.id}>
                <header class="sx-space-title"><span class="sx-initial">{space.label.slice(0, 1)}</span><h2>{space.label}</h2><Show when={props.active === space.id}><span class="sx-current">{t("현재 공간")}</span></Show><span class="spacer" /><button class="icon-btn sm" aria-label={t("{name} 대화 열기", { name: space.label })} title={t("대화 열기")} onClick={() => props.onChat(space.id)}><Icon name="arrow" size={16} /></button></header>
                <div class="sx-space-body">
                  <div class="sx-space-hub">
                    <button class="sx-node sx-chat-node" onClick={() => props.onChat(space.id)}><Icon name="message" size={16} /><strong>{t("메인")}</strong><span>{t("대화 열기")}</span></button>
                    <div class="sx-hub-line" aria-hidden="true" />
                    <button class="sx-node sx-memory-node" onClick={() => props.onMemory(space.id)}><Icon name="memory" size={16} /><strong>{t("메모리")}</strong><span>{t("{n}개", { n: memories() })}<Icon name="lock" size={11} /></span></button>
                  </div>
                  <div class="sx-space-projects">
                    <For each={projects()}>{(p) => <section class="sx-project">
                      <button class="sx-project-title" onClick={() => props.onChat(space.id, p.id)}><Icon name="folder" size={15} /><span>{p.name}</span><Icon name="chevron" size={12} /></button>
                      <div class="sx-project-jobs"><For each={jobs().filter((w) => w.project === p.id)}>{(w) => <WorkCard model={props.model} work={w} onOpen={() => props.onWork(w.id)} />}</For><Show when={!jobs().some((w) => w.project === p.id)}><span class="sx-no-work">{t("작업 없음")}</span></Show></div>
                    </section>}</For>
                    <For each={unfiled()}>{(w) => <WorkCard model={props.model} work={w} onOpen={() => props.onWork(w.id)} />}</For>
                    <Show when={!projects().length && !unfiled().length}><button class="sx-start" onClick={() => props.onChat(space.id)}><Icon name="plus" size={16} />{t("새 대화 시작")}</button></Show>
                  </div>
                </div>
                <footer class="sx-space-footer"><span class="sx-label"><Icon name="monitor" size={13} />{t("접근 가능한 기기")}</span><div class="sx-computers"><For each={computersIn(props.model, space.id)}>{(c) => <ComputerChip computer={c} selected={props.model.selected[space.id] === c.id} onClick={() => props.onComputer(c.id)} />}</For><Show when={!computersIn(props.model, space.id).length}><span class="sx-warning">{t("접근 가능한 기기 없음")}</span></Show></div></footer>
              </section>;
            }}</For>
          </div>
        </div>
      </div>
    </div>
    <div class="sx-canvas-tools"><button class="icon-btn sm" aria-label={grid() ? t("격자 숨기기") : t("격자 표시")} aria-pressed={grid()} onClick={() => setGrid(!grid())}><Icon name="dots" size={14} /></button><div class="sx-zoom"><button class="icon-btn sm" aria-label={t("축소")} disabled={zoom() <= .7} onClick={() => setZoom((z) => Math.max(.7, z - .1))}><Icon name="minus" size={14} /></button><button class="sx-zoom-number" title={t("100%로 보기")} onClick={() => { setZoom(1); viewport.scrollTo({ left: 0, top: 0 }); }}>{Math.round(zoom() * 100)}%</button><button class="icon-btn sm" aria-label={t("확대")} disabled={zoom() >= 1.3} onClick={() => setZoom((z) => Math.min(1.3, z + .1))}><Icon name="plus" size={14} /></button></div><span class="spacer" /><span class="sx-map-note"><Icon name="lock" size={12} />{t("메모리는 각 공간 안에서만 사용")}</span></div>
  </section>;
}
