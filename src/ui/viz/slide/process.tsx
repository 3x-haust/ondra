// Process: chevrons, a staircase, a cycle, swimlanes, a customer journey with
// its emotion curve, a fishbone (Ishikawa) and a conversion funnel.
import { For, Show } from "solid-js";
import { Frame, compact, num, seq, series, useTip, withUnit } from "../kit";
import { t } from "../../../i18n";
import { defineViz } from "../registry";
import { Card, Tag, measure } from "./common";
import { arr, around, clip, conversions, feel, item, items, pct, str, texts, toNum, wrapPx, type Checked, type Item } from "./util";

/* ───────────── chevron process ───────────── */

interface ChevB { label?: string; items?: unknown[] }
defineViz<ChevB>({
  type: "chevrons",
  family: "slide",
  title: "셰브론 프로세스",
  when: "일이 어떤 단계를 차례로 거치고, 지금 어디쯤인가 (발표용 화살표 단계)",
  render: (b) => {
    const list = () => items(b.items).slice(0, 8);
    const hasNow = () => list().some((i) => i.state);
    return (
      <Card label={b.label} class="sl-chev">
        <ol class="sl-chev-row" style={{ "--n": list().length }}>
          <For each={list()}>
            {(it, i) => (
              <li class={`s-${it.state ?? (hasNow() ? "todo" : "none")}`} classList={{ em: !!it.em }}>
                <div class="sl-chev-shape"><span class="sl-chev-no">{i() + 1}</span><b>{it.label}</b></div>
                <Show when={it.note || it.state}>
                  <div class="sl-chev-note"><Show when={it.note}><span>{it.note}</span></Show><Tag state={it.state === "todo" ? undefined : it.state} /></div>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Card>
    );
  },
  examples: [
    {
      label: "신규 기능 출시 절차",
      items: [
        { label: "문제 정의", note: "인터뷰 12명", state: "done" }, { label: "설계", note: "API 초안 확정", state: "done" },
        { label: "개발", note: "2주 스프린트", state: "now" }, { label: "베타", note: "고객사 5곳" }, { label: "정식 출시" },
      ],
    },
  ],
});

/* ───────────── staircase (maturity, step-up) ───────────── */

interface StairB { label?: string; items?: unknown[]; now?: number }
defineViz<StairB>({
  type: "staircase",
  family: "slide",
  title: "계단식 단계",
  when: "한 단계씩 올라가는 성숙도·로드맵에서 지금 몇 번째 계단인가",
  render: (b) => {
    const list = () => items(b.items).slice(0, 7);
    const now = () => (typeof b.now === "number" ? b.now : list().findIndex((i) => i.state === "now"));
    return (
      <Card label={b.label} class="sl-stair">
        <ol class="sl-stair-row" style={{ "--n": list().length }}>
          <For each={list()}>
            {(it, i) => (
              <li style={{ "--i": i() }} classList={{ now: i() === now(), past: now() >= 0 && i() < now(), em: !!it.em }}>
                <div class="sl-stair-step">
                  <span class="sl-stair-no">{t("{n}단계", { n: i() + 1 })}</span>
                  <b>{it.label}</b>
                  <Show when={it.note}><span class="sl-note">{it.note}</span></Show>
                  <Show when={i() === now()}><span class="sl-tag t-now">{t("현재")}</span></Show>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Card>
    );
  },
  examples: [
    {
      label: "데이터 활용 성숙도",
      items: [
        { label: "수작업 리포트", note: "엑셀 취합" }, { label: "대시보드", note: "주요 지표 자동 집계" },
        { label: "셀프 분석", note: "현업이 직접 쿼리" }, { label: "예측", note: "수요 예측 모델" }, { label: "자동 의사결정", note: "가격·재고 자동 조정" },
      ],
      now: 2,
    },
  ],
});

/* ───────────── cycle ───────────── */

interface CycleB { label?: string; center?: string; items?: unknown[] }
defineViz<CycleB>({
  type: "cycle",
  family: "slide",
  title: "순환 프로세스",
  when: "끝나면 다시 처음으로 돌아가는 반복 과정은 어떤 단계로 이루어지나",
  render: (b) => {
    const list = () => items(b.items).slice(0, 8);
    return (
      <Frame label={b.label} class="sl sl-cycle" margin={{ t: 4, r: 4, b: 4, l: 4 }} height={(w) => Math.round(Math.max(260, Math.min(w * 0.66, 420)))}>
        {(bx) => {
          const tip = useTip();
          const n = list().length;
          const nodeW = Math.min(160, Math.max(96, bx.iw / (n > 5 ? 3.3 : 2.9))), nodeH = 44;
          const cx = bx.x0 + bx.iw / 2, cy = bx.y0 + bx.ih / 2;
          const rx = bx.iw / 2 - nodeW / 2, ry = bx.ih / 2 - nodeH / 2;
          const ps = around(n, cx, cy, 1).map((p) => ({ x: cx + (p.x - cx) * rx, y: cy + (p.y - cy) * ry, a: p.a }));
          // an arrow along the ellipse from node i to i+1, trimmed clear of both boxes
          const arc = (i: number) => {
            const a0 = ps[i].a, a1 = i + 1 < n ? ps[i + 1].a : ps[0].a + Math.PI * 2;
            const pt = (a: number) => ({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
            const outside = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) > nodeW / 2 + 5 || Math.abs(p.y - q.y) > nodeH / 2 + 5;
            let s = a0, e = a1;
            const st = (a1 - a0) / 200;
            while (s < a1 && !outside(pt(s), ps[i])) s += st;
            const nxt = ps[(i + 1) % n];
            while (e > s && !outside(pt(e), nxt)) e -= st;
            if (e - s < st * 6) return "";
            const steps = 24, d: string[] = [];
            for (let k = 0; k <= steps; k++) {
              const p = pt(s + ((e - s) * k) / steps);
              d.push(`${k ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
            }
            const p1 = pt(e), p0 = pt(e - st * 4);
            const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
            const head = `M${(p1.x - 7 * Math.cos(ang - 0.45)).toFixed(1)} ${(p1.y - 7 * Math.sin(ang - 0.45)).toFixed(1)}L${p1.x.toFixed(1)} ${p1.y.toFixed(1)}L${(p1.x - 7 * Math.cos(ang + 0.45)).toFixed(1)} ${(p1.y - 7 * Math.sin(ang + 0.45)).toFixed(1)}`;
            return `${d.join("")}${head}`;
          };
          const cl = b.center ? wrapPx(b.center, Math.min(rx, ry) * 1.1, 13.5, 2, measure, 600) : [];
          return (
            <g>
              <For each={list()}>{(_, i) => <path class="sl-arc" d={arc(i())} />}</For>
              <For each={cl}>{(l, i) => <text class="sl-tl sl-center" x={cx} y={cy + 5 + (i() - (cl.length - 1) / 2) * 17} text-anchor="middle">{l}</text>}</For>
              <For each={list()}>
                {(it, i) => {
                  const p = ps[i()];
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${i() + 1}. ${it.label}${it.note ? `\n${it.note}` : ""}`)} onMouseLeave={tip.hide}>
                      <rect x={p.x - nodeW / 2} y={p.y - nodeH / 2} width={nodeW} height={nodeH} rx={nodeH / 2} class="sl-node" classList={{ em: !!it.em }} style={{ "--c": series(0) }} />
                      <circle cx={p.x - nodeW / 2 + 16} cy={p.y} r="9" class="sl-numc" />
                      <text class="sl-in-dark sl-num" x={p.x - nodeW / 2 + 16} y={p.y + 4} text-anchor="middle">{i() + 1}</text>
                      <text class="sl-tl" x={p.x - nodeW / 2 + 31} y={it.note ? p.y - 2 : p.y + 4.5}>{clip(it.label, nodeW - 42, 12.5, measure, 600)}</text>
                      <Show when={it.note}><text class="sl-tn" x={p.x - nodeW / 2 + 31} y={p.y + 13}>{clip(it.note!, nodeW - 42, 11.5, measure, 400)}</text></Show>
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
      label: "제품 개선 루프",
      center: "2주마다",
      items: [{ label: "측정", note: "핵심 지표 확인" }, { label: "학습", note: "인터뷰·로그 분석" }, { label: "가설", note: "개선안 3개" }, { label: "실험", note: "A/B 테스트", em: true }, { label: "배포", note: "전체 적용" }],
    },
  ],
});

/* ───────────── swimlane ───────────── */

interface Step { id: string; lane: number; label: string; note?: string; col: number; to: string[]; em?: boolean; edge?: string }
interface SwimB { label?: string; lanes?: unknown[]; steps?: unknown[] }
function checkSwim(b: SwimB): Checked<SwimB & { _lanes: string[]; _steps: Step[] }> {
  const dropped: string[] = [];
  const lanes = texts(b.lanes);
  const steps: Step[] = [];
  arr(b.steps).forEach((x, i) => {
    const it = item(x);
    const o = (x ?? {}) as Record<string, unknown>;
    if (!it) return void dropped.push(`steps[${i}]: label 없음`);
    const ln = typeof o.lane === "number" ? o.lane : lanes.indexOf(str(o.lane));
    if (ln < 0 || ln >= lanes.length) return void dropped.push(`steps[${i}] ${it.label}: lane이 lanes에 없음`);
    const col = toNum(o.col);
    steps.push({ id: str(o.id) || String(i), lane: ln, label: it.label, note: it.note, em: it.em, col: col ?? -1, to: o.to === undefined ? [] : texts(o.to), edge: str(o.edge) || undefined });
  });
  // columns: given, or one after another (a step in another lane right after its predecessor)
  let c = -1;
  for (const s of steps) c = s.col >= 0 ? s.col : c + 1, (s.col = c);
  // no explicit links anywhere → a chain in the order written
  if (!steps.some((s) => s.to.length)) steps.forEach((s, i) => i + 1 < steps.length && s.to.push(steps[i + 1].id));
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const bad = s.to.filter((t) => !ids.has(t));
    if (bad.length) dropped.push(`${s.label}: 없는 단계로 연결 ${bad.join(", ")}`);
    s.to = s.to.filter((t) => ids.has(t));
  }
  return { block: { ...b, _lanes: lanes, _steps: steps }, dropped };
}
defineViz<SwimB>({
  type: "swimlane",
  family: "slide",
  title: "스윔레인",
  when: "여러 담당(사람·팀·시스템)이 일을 어떤 순서로 주고받나",
  check: checkSwim,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkSwim>["block"];
    const lanes = b._lanes, steps = b._steps;
    const cols = Math.max(1, ...steps.map((s) => s.col + 1));
    const vertical = (w: number) => (w - 90) / cols < 96;
    return (
      <Frame label={b.label} class="sl sl-swim" margin={{ t: 4, r: 4, b: 4, l: 4 }}
        height={(w) => (vertical(w) ? 34 + cols * 62 : lanes.length * 70 + 8)}>
        {(bx) => {
          const tip = useTip();
          const v = vertical(bx.w);
          const head = v ? 30 : Math.min(96, Math.max(64, ...lanes.map((l) => measure(l, 12.5, 600) + 18)));
          // geometry in one orientation; vertical swaps the axes
          const laneSz = v ? bx.iw / lanes.length : (bx.ih) / lanes.length;
          const colSz = v ? (bx.ih - head) / cols : (bx.iw - head) / cols;
          const bw = v ? Math.min(laneSz - 14, 170) : Math.min(colSz - 18, 170), bh = v ? 44 : 46;
          const C = (s: Step) => v
            ? { x: bx.x0 + s.lane * laneSz + laneSz / 2, y: bx.y0 + head + s.col * colSz + colSz / 2 }
            : { x: bx.x0 + head + s.col * colSz + colSz / 2, y: bx.y0 + s.lane * laneSz + laneSz / 2 };
          const byId = new Map(steps.map((s) => [s.id, s]));
          const link = (a: Step, z: Step) => {
            const p = C(a), q = C(z);
            if (v) {
              const y0 = p.y + bh / 2, y1 = q.y - bh / 2;
              if (a.lane === z.lane) return `M${p.x} ${y0}V${y1}`;
              const my = q.y > p.y ? y0 + (y1 - y0) / 2 : y0 + 8;
              return `M${p.x} ${y0}V${my}H${q.x}V${y1}`;
            }
            const x0 = p.x + bw / 2, x1 = q.x - bw / 2;
            if (a.lane === z.lane) return `M${x0} ${p.y}H${x1}`;
            const mx = x0 + Math.max(8, (x1 - x0) / 2);
            return `M${x0} ${p.y}H${mx}V${q.y}H${x1}`;
          };
          const end = (z: Step) => {
            const q = C(z);
            return v ? `M${q.x - 4} ${q.y - bh / 2 - 6}l4 6l4 -6` : `M${q.x - bw / 2 - 6} ${q.y - 4}l6 4l-6 4`;
          };
          return (
            <g>
              <For each={lanes}>
                {(l, i) => (
                  <g>
                    <rect class="sl-lane" classList={{ alt: i() % 2 === 1 }} x={v ? bx.x0 + i() * laneSz : bx.x0} y={v ? bx.y0 : bx.y0 + i() * laneSz} width={v ? laneSz - 2 : bx.iw} height={v ? bx.ih : laneSz - 2} rx="6" />
                    <text class="sl-lanel" x={v ? bx.x0 + i() * laneSz + laneSz / 2 : bx.x0 + 10} y={v ? bx.y0 + 19 : bx.y0 + i() * laneSz + laneSz / 2 + 4.5} text-anchor={v ? "middle" : "start"}>{clip(l, v ? laneSz - 12 : head - 16, 12.5, measure, 600)}</text>
                  </g>
                )}
              </For>
              <For each={steps}>
                {(s) => (
                  <For each={s.to}>
                    {(t) => {
                      const z = byId.get(t)!;
                      return <g><path class="sl-link" classList={{ em: !!(s.em && z.em) }} d={link(s, z)} /><path class="sl-arrowhead" classList={{ em: !!(s.em && z.em) }} d={end(z)} /></g>;
                    }}
                  </For>
                )}
              </For>
              <For each={steps}>
                {(s) => {
                  const p = C(s);
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${lanes[s.lane]} · ${s.label}${s.note ? `\n${s.note}` : ""}`)} onMouseLeave={tip.hide}>
                      <rect x={p.x - bw / 2} y={p.y - bh / 2} width={bw} height={bh} rx="7" class="sl-node" classList={{ em: !!s.em }} />
                      <text class="sl-tl" x={p.x} y={s.note ? p.y - 3 : p.y + 4.5} text-anchor="middle">{clip(s.label, bw - 14, 12.5, measure, 600)}</text>
                      <Show when={s.note}><text class="sl-tn" x={p.x} y={p.y + 13} text-anchor="middle">{clip(s.note!, bw - 14, 11.5, measure, 400)}</text></Show>
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
      label: "환불 처리 흐름",
      lanes: ["고객", "상담원", "결제 시스템", "정산팀"],
      steps: [
        { id: "a", lane: "고객", label: "환불 요청", to: ["b"] },
        { id: "b", lane: "상담원", label: "사유 확인", note: "5분 이내", to: ["c"] },
        { id: "c", lane: "상담원", label: "승인", to: ["d"], em: true },
        { id: "d", lane: "결제 시스템", label: "카드 취소", to: ["e", "f"], em: true },
        { id: "e", lane: "고객", label: "취소 알림", col: 4 },
        { id: "f", lane: "정산팀", label: "매출 차감", note: "익일 반영", col: 4 },
      ],
    },
  ],
});

/* ───────────── customer journey ───────────── */

interface Stage { label: string; doing: string[]; touch: string[]; think?: string; pain?: string; idea?: string; feel?: number }
interface JourneyB { label?: string; scale?: number; stages?: unknown[] }
function checkJourney(b: JourneyB): Checked<JourneyB & { _s: Stage[] }> {
  const dropped: string[] = [];
  const s5 = b.scale === 5;
  const s: Stage[] = [];
  arr(b.stages).forEach((x, i) => {
    const it = item(x);
    if (!it) return void dropped.push(`stages[${i}]: label 없음`);
    const o = (x ?? {}) as Record<string, unknown>;
    const f = feel(o.feel, s5);
    if (o.feel !== undefined && f === undefined) dropped.push(`stages[${i}] ${it.label}: feel은 -2..2 숫자`);
    s.push({ label: it.label, doing: texts(o.doing ?? o.actions), touch: texts(o.touch ?? o.touchpoints), think: str(o.think) || undefined, pain: str(o.pain) || undefined, idea: str(o.idea) || undefined, feel: f });
  });
  return { block: { ...b, _s: s.slice(0, 8) }, dropped };
}
const FEEL_WORD = ["매우 나쁨", "나쁨", "보통", "좋음", "매우 좋음"];
defineViz<JourneyB>({
  type: "journey",
  family: "slide",
  title: "고객 여정 지도",
  when: "고객이 단계마다 무엇을 하고, 어디서 만나고, 기분이 어떻게 오르내리나",
  check: checkJourney,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkJourney>["block"];
    const s = b._s;
    const n = s.length;
    const GAP = 8;
    const rows: [keyof Stage, string][] = [["doing", "행동"], ["touch", "접점"], ["think", "생각"], ["pain", "불편"], ["idea", "개선 기회"]];
    const used = rows.filter(([k]) => s.some((x) => (Array.isArray(x[k]) ? (x[k] as string[]).length : x[k])));
    const grid = (
      <div class="sl-journey-grid" style={{ "--n": n }}>
        <For each={s}>
          {(x, i) => (
            <div class="sl-journey-col">
              <div class="sl-journey-stage"><span class="sl-chev-no">{i() + 1}</span><b>{x.label}</b></div>
              <For each={used}>
                {([k, name]) => {
                  const v = x[k];
                  const list = Array.isArray(v) ? v : v ? [v as string] : [];
                  return (
                    <Show when={list.length}>
                      <div class={`sl-journey-cell k-${k}`}>
                        <span class="sl-journey-k">{t(name)}</span>
                        <Show when={k === "touch"} fallback={<ul class="sl-points"><For each={list}>{(t) => <li>{t}</li>}</For></ul>}>
                          <div class="sl-chips"><For each={list}>{(t) => <span class="sl-chip">{t}</span>}</For></div>
                        </Show>
                      </div>
                    </Show>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    );
    if (!s.some((x) => x.feel !== undefined)) return <Card label={b.label} class="sl-journey">{grid}</Card>;
    return (
      <Frame label={b.label} class="sl sl-journey" margin={{ t: 10, r: 0, b: 22, l: 0 }} height={128} below={grid}>
        {(bx) => {
          const tip = useTip();
          const colW = (bx.w - GAP * (n - 1)) / Math.max(1, n);
          const X = (i: number) => i * (colW + GAP) + colW / 2;
          const Y = (f: number) => bx.y0 + ((2 - f) / 4) * bx.ih;
          const pts = s.map((x, i) => ({ i, x: X(i), y: x.feel === undefined ? undefined : Y(x.feel), f: x.feel }));
          const def = pts.filter((p) => p.y !== undefined) as { i: number; x: number; y: number; f: number }[];
          // a smooth curve through the known points (monotone in x)
          const d = def.map((p, k) => {
            if (!k) return `M${p.x} ${p.y}`;
            const q = def[k - 1], mx = (q.x + p.x) / 2;
            return `C${mx} ${q.y} ${mx} ${p.y} ${p.x} ${p.y}`;
          }).join("");
          const low = Math.min(...def.map((p) => p.f));
          return (
            <g>
              <line class="viz-grid" x1={0} x2={bx.w} y1={Y(0)} y2={Y(0)} />
              <text class="sl-axt2" x={2} y={bx.y0 + 2}>{t("좋음")}</text>
              <text class="sl-axt2" x={2} y={bx.y0 + bx.ih + 2}>{t("나쁨")}</text>
              <path d={d} class="sl-curve" />
              <For each={def}>
                {(p) => (
                  <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${s[p.i].label} · ${t(FEEL_WORD[Math.round(p.f) + 2])}`)} onMouseLeave={tip.hide}>
                    <circle cx={p.x} cy={p.y} r="12" fill="transparent" />
                    <circle cx={p.x} cy={p.y} r="5" class="sl-feel" classList={{ low: p.f === low && p.f < 0, good: p.f > 0 }} />
                  </g>
                )}
              </For>
              <For each={pts}>{(p) => <text class="sl-tn" x={p.x} y={bx.y0 + bx.ih + 18} text-anchor="middle">{bx.w < 600 ? clip(`${p.i + 1}. ${s[p.i].label}`, colW - 4, 11.5, measure, 500) : p.i + 1}</text>}</For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "첫 구매 고객 여정",
      stages: [
        { label: "발견", doing: ["인스타 광고 클릭"], touch: ["광고", "랜딩"], think: "가격이 괜찮네", feel: 1 },
        { label: "탐색", doing: ["리뷰 비교", "사이즈표 확인"], touch: ["상품 상세"], feel: 0 },
        { label: "결제", doing: ["회원가입", "카드 입력"], touch: ["결제창"], pain: "가입 단계 5개", feel: -2, idea: "비회원 결제" },
        { label: "배송", doing: ["배송 조회"], touch: ["알림톡"], feel: 1 },
        { label: "사용", doing: ["착용 후기 작성"], touch: ["리뷰 요청"], think: "다음에도 살 듯", feel: 2 },
      ],
    },
  ],
});

/* ───────────── fishbone / Ishikawa ───────────── */

interface FishB { label?: string; effect?: string; items?: unknown[] }
defineViz<FishB>({
  type: "fishbone",
  family: "slide",
  title: "피시본 (특성요인도)",
  when: "이 문제(결과)를 낳는 원인은 범주별로 무엇이 있나",
  render: (b) => {
    const cats = () => arr(b.items).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      return it ? { ...it, causes: texts(o.causes ?? o.items) } : undefined;
    }).filter((x): x is Item & { causes: string[] } => !!x).slice(0, 8);
    const narrow = (w: number) => w < 560;
    const per = (w: number) => (w - 8 - 110) / Math.max(1, Math.ceil(cats().length / 2));
    const maxC = () => Math.max(1, ...cats().map((c) => c.causes.length));
    return (
      <Frame label={b.label} class="sl sl-fish" margin={{ t: 4, r: 4, b: 4, l: 4 }}
        height={(w) => {
          if (!narrow(w) && per(w) >= 130) return 2 * (34 + maxC() * 20) + 40;
          // vertical: categories in two columns, the head at the bottom
          const rows = Math.ceil(cats().length / 2);
          return rows * (30 + maxC() * 19) + 64;
        }}>
        {(bx) => {
          const tip = useTip();
          const effect = b.effect ?? "";
          const list = cats();
          if (!narrow(bx.w) && per(bx.w) >= 130) {
            const headW = 104, slots = Math.ceil(list.length / 2), slotW = (bx.iw - headW) / Math.max(1, slots);
            const cy = bx.y0 + bx.ih / 2, boneH = bx.ih / 2 - 26;
            const hl = wrapPx(effect, headW - 16, 13, 3, measure, 600);
            return (
              <g>
                <line class="sl-spine" x1={bx.x0} x2={bx.x0 + bx.iw - headW} y1={cy} y2={cy} />
                <path class="sl-arrowhead strong" d={`M${bx.x0 + bx.iw - headW - 8} ${cy - 5}l8 5l-8 5`} />
                <rect x={bx.x0 + bx.iw - headW + 2} y={cy - 32} width={headW - 2} height={64} rx="8" class="sl-node em" />
                <For each={hl}>{(l, i) => <text class="sl-tl" x={bx.x0 + bx.iw - headW / 2 + 1} y={cy + 5 + (i() - (hl.length - 1) / 2) * 16} text-anchor="middle">{l}</text>}</For>
                <For each={list}>
                  {(c, i) => {
                    const top = i() % 2 === 0, slot = Math.floor(i() / 2);
                    const sx = bx.x0 + (slot + 1) * slotW - 10;
                    const ex = sx - boneH * 0.45, ey = top ? cy - boneH : cy + boneH;
                    const at = (k: number) => (k + 1) / (c.causes.length + 1);
                    return (
                      <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${c.label}\n${c.causes.join("\n")}`)} onMouseLeave={tip.hide}>
                        <line class="sl-bone" x1={sx} y1={cy} x2={ex} y2={ey} />
                        <text class="sl-tl em" x={ex} y={top ? ey - 8 : ey + 18} text-anchor="middle">{clip(c.label, slotW - 12, 13, measure, 600)}</text>
                        <For each={c.causes}>
                          {(t, k) => {
                            const f = 1 - at(k()), px = sx + (ex - sx) * (1 - f), py = cy + (ey - cy) * (1 - f);
                            const lx = px - 6;
                            const room = lx - (bx.x0 + slot * slotW) - 4;
                            return <g><line class="sl-twig" x1={px} x2={lx} y1={py} y2={py} /><text class="sl-tn" x={lx - 4} y={py + 4} text-anchor="end">{clip(t, room, 12, measure, 400)}</text></g>;
                          }}
                        </For>
                      </g>
                    );
                  }}
                </For>
              </g>
            );
          }
          // vertical
          const rows = Math.ceil(list.length / 2), rowH = (bx.ih - 60) / Math.max(1, rows);
          const cx = bx.x0 + bx.iw / 2, colW = bx.iw / 2 - 14;
          return (
            <g>
              <line class="sl-spine" x1={cx} x2={cx} y1={bx.y0} y2={bx.y0 + bx.ih - 52} />
              <path class="sl-arrowhead strong" d={`M${cx - 5} ${bx.y0 + bx.ih - 60}l5 8l5 -8`} />
              <rect x={bx.x0} y={bx.y0 + bx.ih - 48} width={bx.iw} height={46} rx="8" class="sl-node em" />
              <text class="sl-tl" x={cx} y={bx.y0 + bx.ih - 20} text-anchor="middle">{clip(effect, bx.iw - 20, 13, measure, 600)}</text>
              <For each={list}>
                {(c, i) => {
                  const left = i() % 2 === 0, r = Math.floor(i() / 2);
                  const y = bx.y0 + r * rowH + 16;
                  const x = left ? cx - 14 : cx + 14;
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${c.label}\n${c.causes.join("\n")}`)} onMouseLeave={tip.hide}>
                      <line class="sl-bone" x1={cx} y1={y + 18} x2={x} y2={y + 4} />
                      <text class="sl-tl em" x={x + (left ? -2 : 2)} y={y + 4} text-anchor={left ? "end" : "start"}>{clip(c.label, colW - 4, 13, measure, 600)}</text>
                      <For each={c.causes}>{(t, k) => <text class="sl-tn" x={x + (left ? -2 : 2)} y={y + 24 + k() * 19} text-anchor={left ? "end" : "start"}>{clip(t, colW - 4, 12, measure, 400)}</text>}</For>
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
      label: "배송 지연 원인",
      effect: "익일 배송 실패 8%",
      items: [
        { label: "사람", causes: ["야간 인력 부족", "신규 작업자 교육"] }, { label: "설비", causes: ["분류기 잦은 정지", "스캐너 오인식"] },
        { label: "방법", causes: ["합포장 기준 모호", "마감 시간 22시"] }, { label: "자재", causes: ["박스 규격 부족"] },
        { label: "환경", causes: ["우천 시 간선 지연"] }, { label: "측정", causes: ["지연 집계 하루 늦음"] },
      ],
    },
  ],
});

/* ───────────── funnel ───────────── */

interface FunnelB { label?: string; unit?: string; items?: unknown[] }
function checkFunnel(b: FunnelB): Checked<FunnelB & { _i: Item[] }> {
  const dropped: string[] = [];
  const out: Item[] = [];
  arr(b.items).forEach((x, i) => {
    const it = item(x);
    if (!it) return void dropped.push(`items[${i}]: label 없음`);
    if (it.value === undefined || it.value < 0) return void dropped.push(`items[${i}] ${it.label}: value 필요`);
    out.push(it);
  });
  return { block: { ...b, _i: out.slice(0, 10) }, dropped };
}
defineViz<FunnelB>({
  type: "funnel",
  family: "slide",
  title: "퍼널",
  when: "단계를 지날 때마다 얼마나 남고, 어디서 가장 많이 빠지나",
  check: checkFunnel,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkFunnel>["block"];
    const list = b._i;
    const conv = conversions(list.map((i) => i.value!));
    const worst = conv.reduce((w, c, i) => (c.ofPrev !== null && (w < 0 || c.ofPrev < conv[w].ofPrev!) ? i : w), -1);
    const GAP = 24;
    // wide: label | bar | value on one line; narrow: label and value above each bar
    const narrow = (w: number) => w - 8 < 460;
    const RH = (w: number) => (narrow(w) ? 44 : 30);
    return (
      <Frame label={b.label} class="sl sl-funnel" margin={{ t: 4, r: 4, b: 4, l: 4 }} height={(w) => list.length * (RH(w) + GAP) - GAP + 8}>
        {(bx) => {
          const tip = useTip();
          const nw = narrow(bx.w), rh = RH(bx.w), BH = nw ? 22 : 30, top = rh - BH;
          const lw = nw ? 0 : Math.min(150, Math.max(...list.map((i) => measure(i.label, 13, 600))) + 12);
          const rw = nw ? 0 : Math.max(...list.map((i, k) => measure(`${compact(i.value!)}  ${pct(conv[k].ofFirst)}`, 12.5, 600))) + 10;
          const aw = bx.iw - lw - rw;
          const cx = bx.x0 + lw + aw / 2;
          const max = Math.max(...list.map((i) => i.value!), 1);
          const W = (v: number) => Math.max(aw * 0.06, (v / max) * aw);
          return (
            <g>
              <For each={list}>
                {(it, i) => {
                  const y = bx.y0 + i() * (rh + GAP) + top, w = W(it.value!);
                  const nx = list[i() + 1];
                  const nw2 = nx ? W(nx.value!) : 0;
                  const c = conv[i() + 1];
                  const shade = Math.max(0, 1 - i() / Math.max(1, list.length - 1));
                  const val = `${compact(it.value!)}`, share = `  ${pct(conv[i()].ofFirst)}`;
                  const vw = measure(val + share, 12.5, 600);
                  return (
                    <g>
                      <Show when={nx}>
                        <path class="sl-funnel-gap" d={`M${cx - w / 2} ${y + BH}L${cx + w / 2} ${y + BH}L${cx + nw2 / 2} ${y + BH + GAP + top}L${cx - nw2 / 2} ${y + BH + GAP + top}Z`} />
                        <text class="sl-conv" classList={{ worst: i() + 1 === worst }} x={cx} y={y + BH + (GAP + top) / 2 + (nw ? 10 : 4.5)} text-anchor="middle">{pct(c.ofPrev)}</text>
                      </Show>
                      <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${it.label}\n${withUnit(num(it.value!), it.unit ?? b.unit)} · ${t("처음 대비 {p}", { p: pct(conv[i()].ofFirst) })}${c && nx ? `\n${t("다음 단계로 {p}", { p: pct(c.ofPrev) })}` : ""}`)} onMouseLeave={tip.hide}>
                        <rect x={cx - w / 2} y={y} width={w} height={BH} rx="4" fill={seq(0.35 + shade * 0.6)} />
                        <text class="sl-tl" classList={{ em: !!it.em }} x={nw ? bx.x0 : bx.x0 + lw - 10} y={nw ? y - 7 : y + BH / 2 + 4.5} text-anchor={nw ? "start" : "end"}>{clip(it.label, nw ? bx.iw - vw - 12 : lw - 12, 13, measure, 600)}</text>
                        <text class="sl-tl" x={bx.x0 + bx.iw} y={nw ? y - 7 : y + BH / 2 + 4.5} text-anchor="end">{val}<tspan class="sl-tn">{share}</tspan></text>
                      </g>
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
      label: "가입 전환 퍼널 (10월)",
      unit: "명",
      items: [{ label: "방문", value: 48200 }, { label: "가입 시작", value: 9640 }, { label: "이메일 인증", value: 6120 }, { label: "첫 프로젝트 생성", value: 2210, em: true }, { label: "유료 전환", value: 410 }],
    },
  ],
});

