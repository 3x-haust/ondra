// Plans and projects: roadmap (lanes × periods), Gantt (dependencies,
// milestones, today), milestone timeline, kanban, OKR tree and RACI.
import { For, Index, Show } from "solid-js";
import { Frame, series, status as STATUS, useTip } from "../kit";
import { t } from "../../../i18n";
import { defineViz } from "../registry";
import { Card, StatusMark, Tag, initials, measure } from "./common";
import { arr, clip, day, dayTicks, fmtDay, item, packRows, periodIx, raci, str, texts, toNum, type Checked, type State, type Status } from "./util";

/* ───────────── roadmap ───────────── */

interface RItem { label: string; note?: string; a: number; b: number; state?: State; em?: boolean; row: number }
interface RLane { label: string; items: RItem[]; rows: number }
interface RoadB { label?: string; periods?: unknown[]; lanes?: unknown[]; now?: unknown }
function checkRoad(b: RoadB): Checked<RoadB & { _p: string[]; _l: RLane[]; _now?: number }> {
  const dropped: string[] = [];
  const periods = texts(b.periods).slice(0, 12);
  const lanes: RLane[] = [];
  arr(b.lanes).forEach((x, li) => {
    const it = item(x);
    if (!it) return void dropped.push(`lanes[${li}]: label 없음`);
    const o = (x ?? {}) as Record<string, unknown>;
    const its: RItem[] = [];
    arr(o.items).forEach((y, ii) => {
      const r = item(y);
      const q = (y ?? {}) as Record<string, unknown>;
      const a = periodIx(q.from ?? q.at, periods), z = periodIx(q.to ?? q.from ?? q.at, periods);
      if (!r) return void dropped.push(`${it.label}.items[${ii}]: label 없음`);
      if (a === undefined) return void dropped.push(`${it.label} · ${r.label}: from이 periods에 없음`);
      its.push({ label: r.label, note: r.note, state: r.state, em: r.em, a: Math.round(a), b: Math.max(Math.round(a), Math.round(z ?? a)), row: 0 });
    });
    const rows = packRows(its.map((i) => ({ a: i.a, b: i.b + 1 })));
    its.forEach((i, k) => (i.row = rows[k]));
    lanes.push({ label: it.label, items: its, rows: Math.max(1, ...rows.map((r) => r + 1)) });
  });
  return { block: { ...b, _p: periods, _l: lanes, _now: periodIx(b.now, periods) }, dropped };
}
defineViz<RoadB>({
  type: "roadmap",
  family: "slide",
  title: "로드맵",
  when: "분기(기간)마다 각 트랙에서 무엇을 하나",
  check: checkRoad,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkRoad>["block"];
    const P = b._p.length;
    return (
      <Card label={b.label} class="sl-road">
        <div class="sl-road-grid" style={{ "--p": P }}>
          <div class="sl-road-head">
            <span class="sl-road-corner" />
            <Index each={b._p}>{(p, i) => <span classList={{ now: b._now === i }}>{p()}</span>}</Index>
          </div>
          <For each={b._l}>
            {(l, li) => (
              <div class="sl-road-lane" style={{ "--rows": l.rows, "--c": series(li()) }}>
                <div class="sl-road-name"><i />{l.label}</div>
                <Show when={b._now !== undefined}><span class="sl-road-now" style={{ "--a": b._now! }} /></Show>
                <For each={l.items}>
                  {(it) => (
                    <div class={`sl-road-bar s-${it.state ?? "none"}`} classList={{ em: !!it.em }} style={{ "--a": it.a, "--b": it.b, "--r": it.row }} title={`${it.label}${it.note ? ` · ${it.note}` : ""}`}>
                      <b>{it.label}</b>
                      <Show when={it.note}><span>{it.note}</span></Show>
                      <Tag state={it.state === "todo" ? undefined : it.state} />
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "2027 제품 로드맵",
      periods: ["1분기", "2분기", "3분기", "4분기"],
      now: "1분기",
      lanes: [
        { label: "앱", items: [{ label: "새 홈 화면", from: "1분기", state: "now" }, { label: "오프라인 모드", from: "2분기", to: "3분기" }, { label: "위젯", from: "4분기" }] },
        { label: "결제", items: [{ label: "간편결제 3종", from: "1분기", to: "2분기", em: true }, { label: "구독 일시정지", from: "3분기" }] },
        { label: "데이터", items: [{ label: "이벤트 스키마 정리", from: "1분기", state: "done" }, { label: "실시간 대시보드", from: "2분기", to: "4분기" }, { label: "추천 v2", from: "3분기", to: "4분기" }] },
      ],
    },
  ],
});

/* ───────────── Gantt ───────────── */

interface GTask { id: string; label: string; a: number; b: number; done?: number; dep: string[]; group?: string; em?: boolean; ms?: boolean }
interface GanttB { label?: string; unit?: string; today?: unknown; tasks?: unknown[]; milestones?: unknown[] }
function checkGantt(b: GanttB): Checked<GanttB & { _t: GTask[]; _num: boolean; _today?: number }> {
  const dropped: string[] = [];
  const raw = arr(b.tasks);
  const numeric = raw.some((x) => typeof (x as Record<string, unknown>)?.start === "number") && !raw.some((x) => day((x as Record<string, unknown>)?.start) !== undefined);
  const at = (v: unknown) => (numeric ? toNum(v) : day(v));
  const t: GTask[] = [];
  raw.forEach((x, i) => {
    const it = item(x);
    const o = (x ?? {}) as Record<string, unknown>;
    if (!it) return void dropped.push(`tasks[${i}]: label 없음`);
    const a = at(o.start);
    const len = toNum(o.days);
    const z = o.end !== undefined ? at(o.end) : a !== undefined && len !== undefined ? a + len : a;
    if (a === undefined || z === undefined) return void dropped.push(`tasks[${i}] ${it.label}: start(${numeric ? "숫자" : "YYYY-MM-DD"}) 필요`);
    const d = toNum(o.done);
    t.push({ id: str(o.id) || it.label, label: it.label, a, b: Math.max(a, z), done: d === undefined ? undefined : d > 1 ? d / 100 : d, dep: texts(o.dep ?? o.after), group: str(o.group) || undefined, em: it.em, ms: a === z && o.end === undefined && len === undefined });
  });
  arr(b.milestones).forEach((x, i) => {
    const it = item(x);
    const a = at((x as Record<string, unknown>)?.at);
    if (!it || a === undefined) return void dropped.push(`milestones[${i}]: label과 at 필요`);
    t.push({ id: it.label, label: it.label, a, b: a, dep: texts((x as Record<string, unknown>)?.dep), em: it.em, ms: true });
  });
  const ids = new Set(t.map((x) => x.id));
  for (const x of t) {
    const bad = x.dep.filter((d) => !ids.has(d));
    if (bad.length) dropped.push(`${x.label}: 없는 선행 작업 ${bad.join(", ")}`);
    x.dep = x.dep.filter((d) => ids.has(d));
  }
  return { block: { ...b, _t: t.slice(0, 30), _num: numeric, _today: at(b.today) }, dropped };
}
defineViz<GanttB>({
  type: "gantt",
  family: "slide",
  title: "간트 차트",
  when: "각 작업이 언제 시작해 언제 끝나고, 무엇에 걸려 있으며, 오늘 어디까지 왔나",
  check: checkGantt,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkGantt>["block"];
    const tasks = b._t;
    // rows: a group header before the first task of each group
    const rows: ({ kind: "group"; label: string; a: number; b: number } | { kind: "task"; t: GTask })[] = [];
    let g: string | undefined;
    for (const x of tasks) {
      if (x.group && x.group !== g) {
        const kids = tasks.filter((y) => y.group === x.group);
        rows.push({ kind: "group", label: x.group, a: Math.min(...kids.map((k) => k.a)), b: Math.max(...kids.map((k) => k.b)) });
      }
      g = x.group;
      rows.push({ kind: "task", t: x });
    }
    const lo = Math.min(...tasks.map((x) => x.a), b._today ?? Infinity), hi = Math.max(...tasks.map((x) => x.b), b._today ?? -Infinity);
    const span = Math.max(1, hi - lo);
    const narrow = (w: number) => w < 520;
    const RH = (w: number) => (narrow(w) ? 40 : 30);
    return (
      <Frame label={b.label} class="sl sl-gantt" margin={{ t: 26, r: 10, b: 4, l: 4 }} height={(w) => rows.length * RH(w) + 34}>
        {(bx) => {
          const tip = useTip();
          const nw = narrow(bx.w), rh = RH(bx.w);
          const lw = nw ? 0 : Math.min(bx.iw * 0.34, 190, Math.max(...rows.map((r) => measure(r.kind === "task" ? r.t.label : r.label, 12.5, 600))) + 16);
          const x0 = bx.x0 + lw, iw = bx.iw - lw;
          const X = (d: number) => x0 + ((d - lo) / span) * iw;
          const ticks = b._num ? Array.from({ length: Math.floor(span) + 1 }, (_, i) => lo + i).filter((_, i, a) => a.length <= iw / 50 || i % Math.ceil(a.length / (iw / 50)) === 0).map((d) => ({ at: d, label: `${d}${b.unit ?? ""}` })) : dayTicks(lo, hi, Math.max(2, Math.floor(iw / 64)));
          const rowOf = new Map<string, number>();
          rows.forEach((r, i) => r.kind === "task" && rowOf.set(r.t.id, i));
          const Y = (i: number) => bx.y0 + i * rh + (nw ? 24 : rh / 2);
          const fmt = (d: number) => (b._num ? `${d}${b.unit ?? ""}` : fmtDay(d));
          return (
            <g>
              <g class="viz-axis">
                <For each={ticks}>
                  {(k) => {
                    const tw = measure(k.label, 12, 400);
                    const hidden = b._today !== undefined && X(k.at) + 3 < X(b._today) + 20 && X(k.at) + 3 + tw > X(b._today) - 20;
                    return <g><line class="viz-grid" x1={X(k.at)} x2={X(k.at)} y1={bx.y0 - 4} y2={bx.y0 + bx.ih} /><Show when={!hidden && X(k.at) + 3 + tw <= bx.x0 + bx.iw + 10}><text x={X(k.at) + 3} y={bx.y0 - 9}>{k.label}</text></Show></g>;
                  }}
                </For>
              </g>
              {/* dependencies: finish → start */}
              <For each={tasks.flatMap((k) => k.dep.map((d) => ({ from: tasks.find((x) => x.id === d)!, to: k })))}>
                {(e) => {
                  const i0 = rowOf.get(e.from.id)!, i1 = rowOf.get(e.to.id)!;
                  const xa = X(e.from.b) + (e.from.ms ? 7 : 0), xb = X(e.to.a) - (e.to.ms ? 7 : 0), ya = Y(i0), yb = Y(i1);
                  const down = i1 > i0 ? 1 : -1;
                  // room to come in from the left: elbow into the start; otherwise drop onto the bar
                  if (xb >= xa + 12)
                    return <g><path class="sl-dep" d={`M${xa} ${ya}H${xa + 6}V${yb}H${xb - 1}`} /><path class="sl-arrowhead" d={`M${xb - 5} ${yb - 4}l4 4l-4 4`} /></g>;
                  const mx = Math.max(xa + 6, xb + 6), ye = yb - down * 8;
                  return <g><path class="sl-dep" d={`M${xa} ${ya}H${mx}V${ye}`} /><path class="sl-arrowhead" d={`M${mx - 4} ${ye - down * 4}l4 ${down * 4}l4 ${-down * 4}`} /></g>;
                }}
              </For>
              <For each={rows}>
                {(r, i) => (
                  <Show when={r.kind === "task" ? r.t : false} fallback={
                    <g>
                      <text class="sl-tl em" x={bx.x0} y={nw ? Y(i()) - 10 : Y(i()) + 4.5}>{clip((r as { label: string }).label, nw ? bx.iw : lw - 10, 12.5, measure, 700)}</text>
                      <path class="sl-gsum" d={`M${X(r.kind === "group" ? r.a : 0)} ${Y(i()) - 2}H${X(r.kind === "group" ? r.b : 0)}v6l-4 -3H${X(r.kind === "group" ? r.a : 0) + 4}l-4 3z`} />
                    </g>
                  }>
                    {(tk) => {
                      const k = tk();
                      const xa = X(k.a), xb = Math.max(X(k.b), xa + 3);
                      const late = !k.ms && b._today !== undefined && k.b < b._today && (k.done ?? 0) < 1;
                      return (
                        <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${k.label}\n${fmt(k.a)}${k.ms ? "" : ` – ${fmt(k.b)}`}${k.done !== undefined ? ` · ${Math.round(k.done * 100)}%` : ""}${late ? ` · ${t("지연")}` : ""}`)} onMouseLeave={tip.hide}>
                          <rect x={bx.x0} y={Y(i()) - (nw ? 22 : rh / 2)} width={bx.iw} height={rh} fill="transparent" />
                          <text class="sl-tl" classList={{ em: !!k.em, halo: nw }} x={nw ? Math.min(Math.max(bx.x0, xa), bx.x0 + bx.iw - 60) : bx.x0 + 8} y={nw ? Y(i()) - 9 : Y(i()) + 4.5}>{clip(k.label, nw ? bx.x0 + bx.iw - Math.min(Math.max(bx.x0, xa), bx.x0 + bx.iw - 60) : lw - 14, 12.5, measure, 500)}</text>
                          <Show when={k.ms} fallback={
                            <g>
                              <rect x={xa} y={Y(i()) - 6} width={xb - xa} height="12" rx="3" class="sl-gbar" classList={{ em: !!k.em, late }} />
                              <Show when={k.done}><rect x={xa} y={Y(i()) - 6} width={(xb - xa) * Math.min(1, k.done!)} height="12" rx="3" class="sl-gdone" classList={{ em: !!k.em, late }} /></Show>
                            </g>
                          }>
                            <path d={`M${xa} ${Y(i()) - 7}l7 7l-7 7l-7 -7z`} class="sl-gms" />
                          </Show>
                        </g>
                      );
                    }}
                  </Show>
                )}
              </For>
              <Show when={b._today !== undefined}>
                <line class="sl-today" x1={X(b._today!)} x2={X(b._today!)} y1={bx.y0 - 4} y2={bx.y0 + bx.ih} />
                <rect x={X(b._today!) - 16} y={bx.y0 - 24} width="32" height="17" rx="8.5" class="sl-today-pill" />
                <text class="sl-in-light" x={X(b._today!)} y={bx.y0 - 11.5} text-anchor="middle">{t("오늘")}</text>
              </Show>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "모바일 앱 v3 일정",
      today: "2026-11-18",
      tasks: [
        { id: "plan", label: "요구사항 정리", start: "2026-11-02", end: "2026-11-09", done: 1, group: "기획" },
        { id: "ux", label: "화면 설계", start: "2026-11-09", end: "2026-11-20", done: 0.7, dep: ["plan"], group: "기획" },
        { id: "api", label: "API 개발", start: "2026-11-12", end: "2026-12-04", done: 0.3, dep: ["plan"], group: "개발", em: true },
        { id: "app", label: "앱 화면 개발", start: "2026-11-23", end: "2026-12-11", dep: ["ux"], group: "개발" },
        { id: "qa", label: "통합 테스트", start: "2026-12-07", end: "2026-12-16", dep: ["api", "app"], group: "출시" },
      ],
      milestones: [{ label: "스토어 출시", at: "2026-12-18", dep: ["qa"] }],
    },
  ],
});

/* ───────────── milestone timeline ───────────── */

interface MS { at: number; label: string; note?: string; state?: State; em?: boolean }
interface MsB { label?: string; dir?: "h" | "v"; today?: unknown; items?: unknown[] }
function checkMs(b: MsB): Checked<MsB & { _m: MS[]; _today?: number }> {
  const dropped: string[] = [];
  const m: MS[] = [];
  arr(b.items).forEach((x, i) => {
    const it = item(x);
    const a = day((x as Record<string, unknown>)?.at ?? (x as Record<string, unknown>)?.date);
    if (!it) return void dropped.push(`items[${i}]: label 없음`);
    if (a === undefined) return void dropped.push(`items[${i}] ${it.label}: at은 YYYY-MM-DD`);
    m.push({ at: a, label: it.label, note: it.note, state: it.state, em: it.em });
  });
  m.sort((a, z) => a.at - z.at);
  return { block: { ...b, _m: m.slice(0, 16), _today: day(b.today) }, dropped };
}
defineViz<MsB>({
  type: "milestones",
  family: "slide",
  title: "마일스톤 타임라인",
  when: "주요 이정표가 실제 날짜 간격으로 언제 있고, 오늘은 어디인가",
  check: checkMs,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkMs>["block"];
    const m = b._m;
    if (!m.length) return null;
    const years = new Set(m.map((x) => new Date(x.at * 864e5).getUTCFullYear())).size > 1;
    const lo = Math.min(m[0].at, b._today ?? Infinity), hi = Math.max(m[m.length - 1].at, b._today ?? -Infinity);
    const span = Math.max(1, hi - lo);
    const LW = 132;
    // horizontal: labels packed into levels above and below the line
    const levels = (w: number) => {
      const iw = w - 8 - LW;
      const X = (d: number) => LW / 2 + ((d - lo) / span) * iw;
      const iv = m.map((x) => ({ a: X(x.at) - LW / 2, b: X(x.at) + LW / 2 }));
      const top = iv.filter((_, i) => i % 2 === 0), bot = iv.filter((_, i) => i % 2 === 1);
      const rt = packRows(top, 6), rb = packRows(bot, 6);
      return { X, row: m.map((_, i) => (i % 2 === 0 ? rt[i / 2] : rb[(i - 1) / 2])), nt: Math.max(0, ...rt) + 1, nb: Math.max(0, ...rb) + 1 };
    };
    const vertical = (w: number) => b.dir === "v" || (b.dir !== "h" && (levels(w).nt > 2 || levels(w).nb > 2 || w < 400));
    const LH = 46;
    return (
      <Frame label={b.label} class="sl sl-ms" margin={{ t: 4, r: 4, b: 4, l: 4 }}
        height={(w) => (vertical(w) ? m.length * 52 + 12 : (levels(w).nt + levels(w).nb) * LH + 30)}>
        {(bx) => {
          const tip = useTip();
          const fmt = (d: number) => fmtDay(d, years);
          if (vertical(bx.w)) {
            const dw = Math.max(...m.map((x) => measure(fmt(x.at), 12, 500))) + 10;
            const lx = bx.x0 + dw + 14;
            const ti = b._today === undefined ? -1 : m.findIndex((x) => x.at >= b._today!);
            return (
              <g>
                <line class="sl-spine" x1={lx} x2={lx} y1={bx.y0 + 10} y2={bx.y0 + (m.length - 1) * 52 + 18} />
                <Show when={ti >= 0}><g><line class="sl-today" x1={lx - 10} x2={bx.x0 + bx.iw} y1={bx.y0 + ti * 52 - 4} y2={bx.y0 + ti * 52 - 4} /><text class="sl-today-t" x={bx.x0 + bx.iw} y={bx.y0 + ti * 52 - 8} text-anchor="end">{t("오늘")}</text></g></Show>
                <For each={m}>
                  {(x, i) => {
                    const y = bx.y0 + i() * 52 + 18;
                    return (
                      <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${fmtDay(x.at, true)} · ${x.label}${x.note ? `\n${x.note}` : ""}`)} onMouseLeave={tip.hide}>
                        <text class="sl-date" x={bx.x0 + dw} y={y + 4} text-anchor="end">{fmt(x.at)}</text>
                        <circle cx={lx} cy={y} r={x.em ? 6.5 : 5} class="sl-msdot" classList={{ em: !!x.em, done: x.state === "done", todo: b._today !== undefined && x.at > b._today }} />
                        <text class="sl-tl" classList={{ em: !!x.em }} x={lx + 14} y={y + 4.5}>{clip(x.label, bx.x0 + bx.iw - lx - 14, 13, measure, 600)}</text>
                        <Show when={x.note}><text class="sl-tn" x={lx + 14} y={y + 21}>{clip(x.note!, bx.x0 + bx.iw - lx - 14, 12, measure, 400)}</text></Show>
                      </g>
                    );
                  }}
                </For>
              </g>
            );
          }
          const L = levels(bx.w);
          const cy = bx.y0 + L.nt * LH + 16;
          const X = (d: number) => bx.x0 + L.X(d);
          const ticks = dayTicks(lo, hi, Math.max(2, Math.floor(bx.iw / 90)));
          return (
            <g>
              <line class="sl-spine" x1={bx.x0} x2={bx.x0 + bx.iw} y1={cy} y2={cy} />
              <For each={ticks}>{(k) => <line class="sl-tick" x1={X(k.at)} x2={X(k.at)} y1={cy - 3} y2={cy + 3} />}</For>
              <Show when={b._today !== undefined}><g><line class="sl-today" x1={X(b._today!)} x2={X(b._today!)} y1={cy - 12} y2={cy + 12} /></g></Show>
              <For each={m}>
                {(x, i) => {
                  const up = i() % 2 === 0, lv = L.row[i()];
                  const y = up ? cy - 14 - lv * LH : cy + 40 + lv * LH;
                  const xx = X(x.at);
                  const tx = Math.min(Math.max(xx, bx.x0 + LW / 2), bx.x0 + bx.iw - LW / 2);
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${fmtDay(x.at, true)} · ${x.label}${x.note ? `\n${x.note}` : ""}`)} onMouseLeave={tip.hide}>
                      <line class="sl-leader" x1={xx} x2={xx} y1={up ? y + 6 : cy + 6} y2={up ? cy - 6 : y - 31} />
                      <circle cx={xx} cy={cy} r={x.em ? 6.5 : 5} class="sl-msdot" classList={{ em: !!x.em, done: x.state === "done", todo: b._today !== undefined && x.at > b._today }} />
                      <text class="sl-date" x={tx} y={y - 17} text-anchor="middle">{fmt(x.at)}</text>
                      <text class="sl-tl" classList={{ em: !!x.em }} x={tx} y={up ? y - 2 : y} text-anchor="middle">{clip(x.label, LW - 6, 12.5, measure, 600)}</text>
                    </g>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "시리즈 A 이후 주요 일정",
      today: "2026-11-08",
      items: [
        { label: "시리즈 A 마감", at: "2026-03-14", state: "done" }, { label: "일본 법인 설립", at: "2026-05-02", state: "done" },
        { label: "엔터프라이즈 요금제", at: "2026-08-20", state: "done" }, { label: "SOC 2 인증", at: "2026-12-01", em: true },
        { label: "도쿄 오피스 오픈", at: "2027-02-15" }, { label: "시리즈 B 준비", at: "2027-06-01" },
      ],
    },
    {
      label: "릴리스 일정",
      dir: "v",
      items: [{ label: "기능 동결", at: "2026-11-20", note: "새 기능 머지 중단" }, { label: "RC1", at: "2026-11-25" }, { label: "RC2", at: "2026-12-02", note: "버그 수정만" }, { label: "정식 배포", at: "2026-12-08", em: true }],
    },
  ],
});

/* ───────────── kanban ───────────── */

interface KanbanB { label?: string; columns?: unknown[] }
defineViz<KanbanB>({
  type: "kanban",
  family: "slide",
  title: "칸반 보드",
  when: "일감이 지금 어느 단계 칸에 몇 개씩 있나",
  render: (b) => {
    const cols = () => arr(b.columns).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      return it ? { label: it.label, limit: toNum(o.limit), cards: arr(o.cards ?? o.items).map((c) => {
        const ci = item(c);
        const q = (c ?? {}) as Record<string, unknown>;
        return ci ? { ...ci, who: str(q.who), tag: str(q.tag) } : undefined;
      }).filter((c): c is NonNullable<typeof c> => !!c) } : undefined;
    }).filter((c): c is NonNullable<typeof c> => !!c).slice(0, 6);
    return (
      <Card label={b.label} class="sl-kanban">
        <div class="sl-kanban-cols" style={{ "--n": cols().length }}>
          <For each={cols()}>
            {(c) => (
              <div class="sl-kanban-col">
                <div class="sl-kanban-head" classList={{ over: c.limit !== undefined && c.cards.length > c.limit }}>
                  <b>{c.label}</b><span>{c.cards.length}{c.limit !== undefined ? ` / ${c.limit}` : ""}</span>
                </div>
                <For each={c.cards}>
                  {(k) => (
                    <div class="sl-kcard" classList={{ em: !!k.em }}>
                      <b>{k.label}</b>
                      <Show when={k.note}><span class="sl-note">{k.note}</span></Show>
                      <Show when={k.who || k.tag || k.state}>
                        <div class="sl-kcard-meta">
                          <Show when={k.tag}><span class="sl-chip">{k.tag}</span></Show>
                          <Tag state={k.state} />
                          <Show when={k.who}><span class="sl-avatar sm" title={k.who}>{initials(k.who)}</span></Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "스프린트 23 보드",
      columns: [
        { label: "할 일", cards: [{ label: "알림 설정 화면", tag: "앱", who: "박서준" }, { label: "로그 보존 기간 정책", tag: "백엔드" }] },
        { label: "진행 중", limit: 2, cards: [{ label: "결제 재시도 큐", tag: "결제", who: "이민지", em: true }, { label: "검색 색인 재구축", who: "최도윤" }, { label: "다크 모드 색 대비", tag: "디자인", who: "한유나" }] },
        { label: "리뷰", cards: [{ label: "주문 내역 API 페이지네이션", who: "정하늘" }] },
        { label: "완료", cards: [{ label: "로그인 리다이렉트 버그", state: "done" }, { label: "CI 캐시 적용", state: "done" }] },
      ],
    },
  ],
});

/* ───────────── OKR ───────────── */

interface OkrB { label?: string; unit?: string; items?: unknown[] }
const okrStatus = (r: number): Status => (r >= 0.7 ? "good" : r >= 0.4 ? "warn" : "bad");
defineViz<OkrB>({
  type: "okr",
  family: "slide",
  title: "OKR 트리",
  when: "목표마다 핵심 결과는 무엇이고 지금 얼마나 왔나",
  render: (b) => {
    const objs = () => arr(b.items).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      if (!it) return undefined;
      const krs = arr(o.krs ?? o.items).map((k) => {
        const ki = item(k);
        const q = (k ?? {}) as Record<string, unknown>;
        if (!ki) return undefined;
        const v = toNum(q.value), t = toNum(q.target), s = toNum(q.start) ?? 0;
        const ratio = v !== undefined && t !== undefined && t !== s ? Math.max(0, Math.min(1, (v - s) / (t - s))) : toNum(q.progress) !== undefined ? Math.max(0, Math.min(1, toNum(q.progress)! > 1 ? toNum(q.progress)! / 100 : toNum(q.progress)!)) : undefined;
        return { ...ki, v, t, ratio, unit: str(q.unit) || b.unit || "" };
      }).filter((k): k is NonNullable<typeof k> => !!k);
      const rs = krs.map((k) => k.ratio).filter((r): r is number => r !== undefined);
      return { ...it, who: str(o.who), krs, ratio: rs.length ? rs.reduce((a, c) => a + c, 0) / rs.length : undefined };
    }).filter((o): o is NonNullable<typeof o> => !!o);
    return (
      <Card label={b.label} class="sl-okr">
        <For each={objs()}>
          {(o, i) => (
            <div class="sl-okr-obj" classList={{ em: !!o.em }}>
              <div class="sl-okr-head">
                <span class="sl-okr-o">O{i() + 1}</span>
                <b>{o.label}</b>
                <Show when={o.who}><span class="sl-note">{o.who}</span></Show>
                <Show when={o.ratio !== undefined}><span class="sl-okr-pct">{Math.round(o.ratio! * 100)}%</span></Show>
              </div>
              <ul class="sl-okr-krs">
                <For each={o.krs}>
                  {(k, j) => (
                    <li>
                      <span class="sl-okr-kr">KR{j() + 1}</span>
                      <span class="sl-okr-l">{k.label}</span>
                      <Show when={k.ratio !== undefined} fallback={<span />}>
                        <span class="sl-meter" title={`${Math.round(k.ratio! * 100)}%`}><i style={{ width: `${k.ratio! * 100}%`, background: STATUS[okrStatus(k.ratio!)] }} /></span>
                      </Show>
                      <span class="sl-okr-v">{k.v !== undefined && k.t !== undefined ? `${k.v.toLocaleString("ko-KR")} / ${k.t.toLocaleString("ko-KR")}${k.unit}` : k.ratio !== undefined ? `${Math.round(k.ratio * 100)}%` : ""}</span>
                      <Show when={k.ratio !== undefined}><StatusMark s={okrStatus(k.ratio!)} bare /></Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </Card>
    );
  },
  examples: [
    {
      label: "4분기 OKR · 그로스팀",
      items: [
        {
          label: "신규 고객이 첫 주에 가치를 느낀다", who: "그로스팀", em: true,
          krs: [{ label: "첫 주 활성화율", start: 31, value: 38, target: 45, unit: "%" }, { label: "온보딩 완료 시간", start: 14, value: 9, target: 5, unit: "분" }, { label: "첫 주 이탈 문의", value: 120, target: 200, start: 320, unit: "건" }],
        },
        { label: "유료 전환을 늘린다", krs: [{ label: "체험→유료 전환율", start: 8, value: 9.2, target: 12, unit: "%" }, { label: "연간 결제 비중", progress: 0.25 }] },
      ],
    },
  ],
});

/* ───────────── RACI ───────────── */

interface RaciB { label?: string; roles?: unknown[]; rows?: unknown[] }
const RACI_WORD: Record<string, string> = { R: "실행|raci", A: "책임|raci", C: "협의|raci", I: "통보|raci" };
defineViz<RaciB>({
  type: "raci",
  family: "slide",
  title: "RACI 매트릭스",
  when: "일마다 누가 실행·책임·협의·통보를 맡나",
  render: (b) => {
    const roles = () => texts(b.roles).slice(0, 10);
    const rows = () => arr(b.rows).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      if (!it) return undefined;
      const c = o.cells ?? o.v;
      const cells = Array.isArray(c) ? c.map(raci) : typeof c === "object" && c ? roles().map((r) => raci((c as Record<string, unknown>)[r])) : typeof c === "string" ? c.split(/[\s,]+/).map(raci) : [];
      return { ...it, cells };
    }).filter((r): r is NonNullable<typeof r> => !!r);
    return (
      <Card label={b.label} class="sl-raci" aside={<ul class="sl-raci-key"><For each={["R", "A", "C", "I"]}>{(l) => <li><span class={`sl-raci-l l-${l}`}>{l}</span>{t(RACI_WORD[l])}</li>}</For></ul>}>
        <div class="sl-scroll">
          <table class="sl-table">
            <thead><tr><th />{<For each={roles()}>{(r) => <th class="c">{r}</th>}</For>}</tr></thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <tr classList={{ em: !!r.em }}>
                    <th>{r.label}</th>
                    <Index each={roles()}>{(_, i) => <td class="c"><For each={(r.cells[i] ?? "").split("").filter(Boolean)}>{(l) => <span class={`sl-raci-l l-${l}`} title={RACI_WORD[l] ? t(RACI_WORD[l]) : undefined}>{l}</span>}</For></td>}</Index>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "결제 시스템 이전 역할",
      roles: ["PM", "백엔드", "QA", "보안", "CS"],
      rows: [
        { label: "이전 계획 수립", cells: ["A", "R", "C", "C", "I"] },
        { label: "결제 API 교체", cells: ["I", "AR", "C", "C", ""] },
        { label: "보안 점검", cells: ["I", "C", "", "AR", ""] },
        { label: "회귀 테스트", cells: ["I", "C", "AR", "", ""] },
        { label: "고객 공지", cells: ["A", "", "", "I", "R"] },
      ],
    },
  ],
});
