import { createMemo, createSignal, For, Show } from "solid-js";
import { DotGrid } from "../ui/DotGrid";
import { Icon } from "../ui/Icon";
import { JobCard, layout, MainCard, ProjCard, type Node } from "../views/Canvas";
import { SidebarToggle } from "../views/Sidebar";
import { t } from "../i18n";
import { computersIn, workState, type SpaceModel, type Work } from "./spaceModel";

export const workLabel = (status: Work["status"] | "unknown") => t(({ running: "진행 중", done: "완료", paused: "일시정지", waiting: "응답 필요", queued: "대기", failed: "실패", unknown: "상태 미확인" })[status]);

export function SpaceCanvas(props: {
  model: SpaceModel; active: string; filter: string; onFilter: (id: string) => void;
  onChat: (space: string, project?: string) => void; onMemory: (space: string, project?: string) => void;
  onWork: (id: string) => void; onComputer: (id: string) => void; onConnect: () => void; onAdd: () => void;
}) {
  const [zoom, setZoom] = createSignal(.75);
  const [grid, setGrid] = createSignal(true);
  const [mode, setMode] = createSignal("canvas");
  const [folds, setFolds] = createSignal<string[]>([]);
  const [scroll, setScroll] = createSignal({ x: 0, y: 0 });
  let viewport!: HTMLDivElement;
  const maps = createMemo(() => {
    let y = 0;
    return props.model.spaces.filter((s) => !props.filter || s.id === props.filter).map((s) => {
      const graph = layout(s.id, folds(), Math.max(.75, zoom()), false);
      const h = Math.max(200, ...graph.nodes.map((n) => n.y + n.h)) + 120;
      const w = Math.max(800, ...graph.nodes.map((n) => n.x + n.w)) + 48;
      const out = { space: s, graph, y, h, w };
      y += h + 32;
      return out;
    });
  });
  const totalHeight = () => maps().reduce((n, m) => n + m.h + 32, 32);
  const openNode = (n: Node, space: string) => {
    if (n.kind === "main") props.onChat(space);
    else if (n.kind === "proj") props.onChat(space, n.project!.id === "_" ? undefined : n.project!.id);
    else if (n.kind === "more") setFolds((ids) => ids.includes(n.project!.id) ? ids.filter((id) => id !== n.project!.id) : [...ids, n.project!.id]);
    else props.onWork(n.id);
  };
  const pan = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("button, select")) return;
    const start = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { viewport.scrollLeft = start.left - ev.clientX + start.x; viewport.scrollTop = start.top - ev.clientY + start.y; };
    const stop = () => { viewport.removeEventListener("pointermove", move); viewport.removeEventListener("pointerup", stop); viewport.removeEventListener("pointercancel", stop); };
    viewport.addEventListener("pointermove", move); viewport.addEventListener("pointerup", stop); viewport.addEventListener("pointercancel", stop);
  };
  return <div class="view canvas-view">
    <header class="head">
      <SidebarToggle />
      <div class="cv-mode" role="tablist" aria-label={t("캔버스")}><button role="tab" aria-selected={mode() === "canvas"} classList={{ on: mode() === "canvas" }} onClick={() => setMode("canvas")}>{t("캔버스")}</button><button role="tab" aria-selected={mode() === "list"} classList={{ on: mode() === "list" }} onClick={() => setMode("list")}>{t("보드")}</button></div>
      <span class="board-sum cv-legend"><span>{t("진행 중")} <b>{props.model.work.filter((w) => workState(props.model, w) === "running").length}</b></span></span>
      <span class="spacer" /><button class="btn sm ghost" onClick={() => props.onChat(props.active)}><Icon name="plus" size={14} />{t("새 작업")}</button>
    </header>
    <div class="cv-frame">
      <div class="sp-map-toolbar"><label><select aria-label={t("캔버스 범위")} value={props.filter} onChange={(e) => { props.onFilter(e.currentTarget.value); viewport?.scrollTo(0, 0); }}><option value="">{t("모든 공간")}</option><For each={props.model.spaces}>{(s) => <option value={s.id}>{s.label}</option>}</For></select></label><span class="spacer" /><button class="btn sm ghost" onClick={props.onConnect}><Icon name="monitor" size={14} />{t("기기 연결")}</button><button class="icon-btn" aria-label={t("공간 추가")} title={t("공간 추가")} onClick={props.onAdd}><Icon name="plus" size={14} /></button></div>
      <Show when={mode() === "canvas"} fallback={<div class="sp-board"><For each={maps()}>{(m) => <section><h2>{m.space.label}</h2><For each={props.model.work.filter((w) => w.space === m.space.id)}>{(w) => <button class="sb-row" onClick={() => props.onWork(w.id)}><Icon name="circle" size={14} /><span class="sb-title">{w.title}</span><span class="sb-meta">{workLabel(workState(props.model, w))}</span></button>}</For><button class="btn sm ghost" onClick={() => props.onChat(m.space.id)}>{t("대화 열기")}</button></section>}</For></div>}>
        <div class="cv-viewport sp-map-viewport" ref={viewport} onPointerDown={pan} onScroll={() => setScroll({ x: viewport.scrollLeft, y: viewport.scrollTop })}>
          <DotGrid pan={{ x: -scroll().x, y: -scroll().y }} zoom={zoom()} on={grid()} />
          <div class="sp-map-size" style={{ width: `${Math.max(880, ...maps().map((m) => m.w + 64)) * zoom()}px`, height: `${totalHeight() * zoom()}px` }}>
            <div class="cv-world" style={{ transform: `translate(24px, 24px) scale(${zoom()})`, "--cv-z": String(zoom()) }}>
              <For each={maps()}>{(m) => <section class="sp-space-boundary" classList={{ current: m.space.id === props.active }} aria-label={m.space.label} style={{ top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` }}>
                <header class="sp-space-head"><button onClick={() => props.onChat(m.space.id)}><Icon name="box" size={14} /><strong>{m.space.label}</strong></button><button class="sp-memory-link" onClick={() => props.onMemory(m.space.id)}><Icon name="memory" size={14} />{t("메모리")}<Icon name="lock" size={12} /></button><span class="spacer" /><For each={computersIn(props.model, m.space.id)}>{(c) => <button class="sp-device-link" classList={{ away: !c.online }} onClick={() => props.onComputer(c.id)}><i class={`cn-dot is-${c.online ? "ok" : "offline"}`} />{c.name}<Show when={!c.online}> · {t("연결 끊김")}</Show></button>}</For></header>
                <div class="sp-space-graph">
                  <svg class="cv-edges" width="1" height="1"><For each={m.graph.edges}>{(e) => {
                    const a = m.graph.nodes.find((n) => n.id === e.from)!;
                    const b = m.graph.nodes.find((n) => n.id === e.to)!;
                    const x = a.x + a.w, y = a.y + a.h / 2, bx = b.x, by = b.y + Math.min(b.h, 84) / 2;
                    return <g class={`cv-edge t-${e.tone}`}><path d={`M${x},${y} C${x + 24},${y} ${bx - 24},${by} ${bx},${by}`} /></g>;
                  }}</For></svg>
                  <For each={m.graph.nodes}>{(n) => <button class={`cv-node cv-${n.kind}${n.task ? ` t-${n.task.status === "running" ? "live" : n.task.status === "queued" ? "idle" : n.task.status}` : ""}`} style={{ left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` }} onClick={() => openNode(n, m.space.id)}>
                    {n.kind === "main" ? <MainCard /> : n.kind === "proj" ? <ProjCard n={n} space={m.space.id} /> : n.kind === "more" ? <div class="cv-more-row"><Icon name="chevron" size={12} />{t("완료 {n}개", { n: n.count ?? 0 })}</div> : <JobCard n={n} />}
                    <Show when={n.task && workState(props.model, props.model.work.find((w) => w.id === n.id)!) === "unknown"}><span class="sp-unknown">{t("연결 끊김 · 상태 미확인")}</span></Show>
                  </button>}</For>
                </div>
              </section>}</For>
            </div>
          </div>
        </div>
        <div class="cv-ctrl" role="toolbar" aria-label={t("캔버스 도구")}><button aria-label={t("격자 표시")} aria-pressed={grid()} classList={{ on: grid() }} onClick={() => setGrid(!grid())}><Icon name="dots" size={14} /></button><i class="cv-ctrl-sep" /><button aria-label={t("축소")} disabled={zoom() <= .5} onClick={() => setZoom(Math.max(.5, zoom() - .25))}><Icon name="minus" size={14} /></button><button class="cv-zoom" aria-label={t("기본 배율")} onClick={() => setZoom(.75)}>{Math.round(zoom() * 100)}%</button><button aria-label={t("확대")} disabled={zoom() >= 1.5} onClick={() => setZoom(Math.min(1.5, zoom() + .25))}><Icon name="plus" size={14} /></button><i class="cv-ctrl-sep" /><button aria-label={t("처음 위치로")} onClick={() => { setZoom(.75); viewport.scrollTo(0, 0); }}><Icon name="tidy" size={14} /></button></div>
      </Show>
    </div>
  </div>;
}
