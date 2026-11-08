// Strategy frames: 2x2 / 3x3 matrices with placed items, positioning maps,
// SWOT, PEST(LE), Porter's five forces, value chain, business and lean
// canvases, Ansoff, 3C/4P/STP, risk matrix and empathy map.
import { For, Index, Show } from "solid-js";
import { Frame, series, useTip, type Box } from "../kit";
import { defineViz } from "../registry";
import { Card, measure } from "./common";
import { arr, autoMax, clip, item, placeLabels, str, texts, toNum, type Checked, type Rect } from "./util";

/* ───────────── shared: a labelled matrix of text cells (HTML) ───────────── */

interface MCell { label: string; note?: string; points: string[]; em?: boolean; badge?: string; tone?: number }
/**
 * Cells in reading order with optional column heads (x, left → right) and row
 * heads (y, top → bottom) and axis titles.
 */
function Matrix(props: { n: number; cells: MCell[]; cols?: string[]; rows?: string[]; xLabel?: string; yLabel?: string; class?: string }) {
  return (
    <div class={`sl-mx ${props.class ?? ""}`} classList={{ "has-rows": !!props.rows?.length, "has-cols": !!props.cols?.length }} style={{ "--n": props.n }}>
      <Show when={props.yLabel}><div class="sl-mx-ytitle"><span>{props.yLabel}</span></div></Show>
      <Show when={props.cols?.length}>
        <div class="sl-mx-cols"><For each={props.cols}>{(c) => <span>{c}</span>}</For></div>
      </Show>
      <Show when={props.rows?.length}>
        <div class="sl-mx-rows"><For each={props.rows}>{(r) => <span><b>{r}</b></span>}</For></div>
      </Show>
      <div class="sl-mx-grid">
        <For each={props.cells}>
          {(c) => (
            <div class="sl-mx-cell" classList={{ em: !!c.em }} style={c.tone !== undefined ? { "--c": series(c.tone) } : undefined}>
              <div class="sl-mx-head">
                <Show when={c.badge}><span class="sl-badge" style={{ "--c": series(c.tone ?? 0) }}>{c.badge}</span></Show>
                <b>{c.label}</b>
              </div>
              <Show when={c.note}><p class="sl-note">{c.note}</p></Show>
              <Show when={c.points.length}><ul class="sl-points"><For each={c.points}>{(p) => <li>{p}</li>}</For></ul></Show>
            </div>
          )}
        </For>
      </div>
      <Show when={props.xLabel}><div class="sl-mx-xtitle">{props.xLabel}</div></Show>
    </div>
  );
}

/* ───────────── shared: points on two axes (SVG) ───────────── */

interface Pt { label: string; x: number; y: number; size?: number; note?: string; em?: boolean; group?: string }
interface Ax { label?: string; lo?: string; hi?: string; min?: number; max?: number }
const axis = (x: unknown): Ax => {
  if (typeof x === "string") return { label: x };
  if (!x || typeof x !== "object") return {};
  const o = x as Record<string, unknown>;
  return { label: str(o.label) || undefined, lo: str(o.lo) || undefined, hi: str(o.hi) || undefined, min: toNum(o.min), max: toNum(o.max) };
};
function readPts(raw: unknown, dropped: string[]): Pt[] {
  const out: Pt[] = [];
  arr(raw).forEach((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const it = item(r);
    const x = toNum(o.x), y = toNum(o.y);
    if (!it) return void dropped.push(`items[${i}]: label 없음`);
    if (x === undefined || y === undefined) return void dropped.push(`items[${i}] ${it.label}: x, y 숫자 필요`);
    out.push({ label: it.label, x, y, size: toNum(o.size), note: it.note, em: it.em, group: str(o.group) || undefined });
  });
  return out;
}
const groupsOf = (pts: Pt[]) => [...new Set(pts.map((p) => p.group).filter((g): g is string => !!g))].slice(0, 8);

function Dots(props: { pts: Pt[]; sx: (v: number) => number; sy: (v: number) => number; box: Box; obstacles?: Rect[] }) {
  const tip = useTip();
  const groups = () => groupsOf(props.pts);
  const sizes = () => props.pts.map((p) => p.size).filter((s): s is number => s !== undefined && s > 0);
  const r = (p: Pt) => {
    const m = Math.max(...sizes(), 0);
    return p.size && m ? 4 + Math.sqrt(p.size / m) * 10 : 5;
  };
  const laid = () => {
    const b = props.box;
    const pts = props.pts.map((p) => {
      const t = clip(p.label, 140, 12.5, measure, p.em ? 600 : 500);
      return { x: props.sx(p.x), y: props.sy(p.y), r: r(p), w: measure(t, 12.5, p.em ? 600 : 500), h: 15, em: p.em, t };
    });
    const pos = placeLabels(pts, { x: b.x0 - 4, y: b.y0 - 4, w: b.iw + 8, h: b.ih + 8 }, props.obstacles);
    return pts.map((p, i) => ({ ...p, pos: pos[i] }));
  };
  const color = (p: Pt) => (p.group ? series(groups().indexOf(p.group)) : series(0));
  return (
    <g>
      <For each={laid()}>
        {(d, i) => {
          const p = props.pts[i()];
          return (
            <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${p.label}${p.group ? ` · ${p.group}` : ""}${p.note ? `\n${p.note}` : ""}`)} onMouseLeave={tip.hide}>
              <circle cx={d.x} cy={d.y} r={Math.max(12, d.r + 4)} fill="transparent" />
              <circle cx={d.x} cy={d.y} r={d.r} fill={color(p)} fill-opacity={p.size ? 0.75 : 1} class="sl-dot" classList={{ em: !!p.em }} />
              <Show when={d.pos}>
                {(q) => <text class="sl-ptl" classList={{ em: !!p.em }} x={q().anchor === "start" ? q().x : q().anchor === "end" ? q().x + q().w : q().x + q().w / 2} y={q().y + 11.5} text-anchor={q().anchor}>{d.t}</text>}
              </Show>
            </g>
          );
        }}
      </For>
    </g>
  );
}

/* ───────────── quadrant ───────────── */

interface QuadB { label?: string; x?: unknown; y?: unknown; n?: number; quads?: unknown[]; items?: unknown[] }
const QUAD_POS = ["좌상", "우상", "좌하", "우하"];
function checkQuad(b: QuadB): Checked<QuadB & { _pts: Pt[]; _cells: MCell[]; _n: number }> {
  const dropped: string[] = [];
  const n = b.n === 3 ? 3 : 2;
  const cells: MCell[] = arr(b.quads).slice(0, n * n).map((q) => {
    const it = item(q);
    const o = (q ?? {}) as Record<string, unknown>;
    return { label: it?.label ?? "", note: it?.note, em: it?.em, points: texts(o.items ?? o.points) };
  });
  while (cells.length < n * n) cells.push({ label: "", points: [] });
  return { block: { ...b, _pts: readPts(b.items, dropped), _cells: cells, _n: n }, dropped };
}
function Quadrant(props: { b: ReturnType<typeof checkQuad>["block"] }) {
  const x = () => axis(props.b.x), y = () => axis(props.b.y);
  const pts = () => props.b._pts;
  const n = () => props.b._n;
  const xmax = () => x().max ?? autoMax(pts().map((p) => p.x)), ymax = () => y().max ?? autoMax(pts().map((p) => p.y));
  const xmin = () => x().min ?? 0, ymin = () => y().min ?? 0;
  // no placed items: a matrix of text cells (Eisenhower lists, 9-box)
  if (!pts().length)
    return (
      <Card label={props.b.label} class="sl-quad">
        <Matrix n={n()} cells={props.b._cells.map((c, i) => ({ ...c, label: c.label || (n() === 2 ? QUAD_POS[i] : ""), tone: undefined }))}
          cols={x().lo || x().hi ? [x().lo ?? "", x().hi ?? ""].slice(0, n()) : undefined} rows={y().lo || y().hi ? [y().hi ?? "", y().lo ?? ""] : undefined}
          xLabel={x().label} yLabel={y().label} />
      </Card>
    );
  const groups = () => groupsOf(pts());
  return (
    <Frame label={props.b.label} class="sl sl-quad" height={(w) => Math.round(Math.min(Math.max(w * 0.7, 280), 480))} margin={{ t: 4, r: 4, b: 34, l: 26 }}
      legend={groups().map((g, i) => ({ label: g, color: series(i) }))}>
      {(bx) => {
        const sx = (v: number) => bx.x0 + ((v - xmin()) / (xmax() - xmin() || 1)) * bx.iw;
        const sy = (v: number) => bx.y0 + bx.ih - ((v - ymin()) / (ymax() - ymin() || 1)) * bx.ih;
        const cw = bx.iw / n(), ch = bx.ih / n();
        const heads = props.b._cells.map((c, i) => {
          const cx = bx.x0 + (i % n()) * cw, cy = bx.y0 + Math.floor(i / n()) * ch;
          const t = c.label ? clip(c.label, cw - 16, 12.5, measure, 600) : "";
          return { c, cx, cy, t, r: { x: cx + 8, y: cy + 6, w: measure(t, 12.5, 600), h: 16 } as Rect };
        });
        return (
          <g>
            <For each={heads}>
              {(h) => (
                <g>
                  <rect x={h.cx + 1} y={h.cy + 1} width={cw - 2} height={ch - 2} rx="6" class="sl-qcell" classList={{ em: !!h.c.em }} />
                  <Show when={h.t}><text class="sl-qhead" x={h.cx + 8} y={h.cy + 18}>{h.t}</text></Show>
                </g>
              )}
            </For>
            <Axes2 x={x()} y={y()} bx={bx} />
            <Dots pts={pts()} sx={sx} sy={sy} box={bx} obstacles={heads.filter((h) => h.t).map((h) => h.r)} />
          </g>
        );
      }}
    </Frame>
  );
}
/** low → high along each edge, and the axis titles */
function Axes2(props: { x: Ax; y: Ax; bx: Box }) {
  const b = () => props.bx;
  const yl = () => `${props.y.label ?? ""}`;
  return (
    <g class="viz-axis">
      <line class="viz-base" x1={b().x0} x2={b().x0 + b().iw} y1={b().y0 + b().ih + 6} y2={b().y0 + b().ih + 6} />
      <line class="viz-base" x1={b().x0 - 6} x2={b().x0 - 6} y1={b().y0 + b().ih} y2={b().y0} />
      <path class="sl-arrowhead" d={`M${b().x0 + b().iw - 5} ${b().y0 + b().ih + 3}l5 3l-5 3`} />
      <path class="sl-arrowhead" d={`M${b().x0 - 9} ${b().y0 + 5}l3 -5l3 5`} />
      <text x={b().x0} y={b().y0 + b().ih + 22} text-anchor="start">{props.x.lo ?? "낮음"}</text>
      <text x={b().x0 + b().iw - 10} y={b().y0 + b().ih + 22} text-anchor="end">{props.x.hi ?? "높음"}</text>
      <Show when={props.x.label}><text class="sl-axt" x={b().x0 + b().iw / 2} y={b().y0 + b().ih + 22} text-anchor="middle">{clip(props.x.label!, b().iw / 2 - 40, 12, measure, 600)}</text></Show>
      <g transform={`translate(${b().x0 - 14},${b().y0 + b().ih}) rotate(-90)`}>
        <text x="0" y="0" text-anchor="start">{props.y.lo ?? "낮음"}</text>
        <text x={b().ih - 10} y="0" text-anchor="end">{props.y.hi ?? "높음"}</text>
        <Show when={yl()}><text class="sl-axt" x={b().ih / 2} y="0" text-anchor="middle">{clip(yl(), b().ih / 2 - 40, 12, measure, 600)}</text></Show>
      </g>
    </g>
  );
}

defineViz<QuadB>({
  type: "quadrant",
  family: "slide",
  title: "2x2 매트릭스",
  when: "두 기준으로 나누면 각 항목은 어느 칸에 있나 (BCG, 아이젠하워, 영향–노력, 9-box)",
  check: checkQuad,
  render: (b) => <Quadrant b={b as ReturnType<typeof checkQuad>["block"]} />,
  examples: [
    {
      label: "개선 과제 영향–노력",
      x: { label: "노력", lo: "적음", hi: "많음" },
      y: { label: "영향", lo: "작음", hi: "큼" },
      quads: [{ label: "빠른 성과", em: true }, { label: "큰 과제" }, { label: "자투리" }, { label: "보류" }],
      items: [
        { label: "검색 자동완성", x: 2, y: 8.5 }, { label: "결제 재시도", x: 3.5, y: 9, em: true }, { label: "다크 모드", x: 2.5, y: 4 },
        { label: "온보딩 개편", x: 7.5, y: 8 }, { label: "추천 모델 교체", x: 9, y: 7 }, { label: "아이콘 정리", x: 1.5, y: 2 },
        { label: "레거시 API 이전", x: 8.5, y: 3 }, { label: "알림 묶음 발송", x: 4, y: 6.5 },
      ],
    },
    {
      label: "이번 주 할 일",
      x: { lo: "긴급", hi: "긴급하지 않음" },
      y: { lo: "덜 중요", hi: "중요" },
      quads: [
        { label: "지금 하기", em: true, items: ["결제 장애 원인 보고", "보안 패치 배포"] },
        { label: "일정 잡기", items: ["분기 로드맵 초안", "온콜 문서 정리", "채용 면접 질문 준비"] },
        { label: "맡기기", items: ["회의실 예약", "주간 지표 취합"] },
        { label: "하지 않기", items: ["오래된 브랜치 정리"] },
      ],
    },
  ],
});

/* ───────────── positioning map ───────────── */

interface PosB { label?: string; x?: unknown; y?: unknown; items?: unknown[] }
function Positioning(props: { b: PosB & { _pts: Pt[] } }) {
  const x = () => axis(props.b.x), y = () => axis(props.b.y);
  const pts = () => props.b._pts;
  const dom = (vs: number[], a: Ax): [number, number] => {
    if (a.min !== undefined && a.max !== undefined) return [a.min, a.max];
    const neg = vs.some((v) => v < 0);
    const m = autoMax(vs.map(Math.abs));
    return neg ? [-m, m] : [0, m];
  };
  const groups = () => groupsOf(pts());
  return (
    <Frame label={props.b.label} class="sl sl-pos" height={(w) => Math.round(Math.min(Math.max(w * 0.72, 280), 480))} margin={{ t: 22, r: 8, b: 22, l: 8 }}
      legend={groups().map((g, i) => ({ label: g, color: series(i) }))}>
      {(bx) => {
        const [x0, x1] = dom(pts().map((p) => p.x), x()), [y0, y1] = dom(pts().map((p) => p.y), y());
        const sx = (v: number) => bx.x0 + ((v - x0) / (x1 - x0 || 1)) * bx.iw;
        const sy = (v: number) => bx.y0 + bx.ih - ((v - y0) / (y1 - y0 || 1)) * bx.ih;
        const cx = bx.x0 + bx.iw / 2, cy = bx.y0 + bx.ih / 2;
        const xl = clip(x().lo ?? "", bx.iw / 2 - 12, 12.5, measure, 600), xh = clip(x().hi ?? "", bx.iw / 2 - 12, 12.5, measure, 600);
        const yh = clip(y().hi ?? "", bx.iw - 16, 12.5, measure, 600), ylo = clip(y().lo ?? "", bx.iw - 16, 12.5, measure, 600);
        const obstacles: Rect[] = [
          { x: bx.x0, y: cy + 4, w: measure(xl, 12.5, 600), h: 16 },
          { x: bx.x0 + bx.iw - measure(xh, 12.5, 600), y: cy + 4, w: measure(xh, 12.5, 600), h: 16 },
        ];
        return (
          <g>
            <line class="sl-cross" x1={bx.x0} x2={bx.x0 + bx.iw} y1={cy} y2={cy} />
            <line class="sl-cross" x1={cx} x2={cx} y1={bx.y0} y2={bx.y0 + bx.ih} />
            <path class="sl-arrowhead" d={`M${bx.x0 + bx.iw - 6} ${cy - 4}l6 4l-6 4M${bx.x0 + 6} ${cy - 4}l-6 4l6 4M${cx - 4} ${bx.y0 + 6}l4 -6l4 6M${cx - 4} ${bx.y0 + bx.ih - 6}l4 6l4 -6`} />
            <g class="sl-poles">
              <text x={bx.x0} y={cy + 16} text-anchor="start">{xl}</text>
              <text x={bx.x0 + bx.iw} y={cy + 16} text-anchor="end">{xh}</text>
              <text x={cx} y={bx.y0 - 8} text-anchor="middle">{yh}</text>
              <text x={cx} y={bx.y0 + bx.ih + 16} text-anchor="middle">{ylo}</text>
            </g>
            <Dots pts={pts()} sx={sx} sy={sy} box={bx} obstacles={obstacles} />
          </g>
        );
      }}
    </Frame>
  );
}
defineViz<PosB>({
  type: "positioning",
  family: "slide",
  title: "포지셔닝 맵",
  when: "두 속성 축에서 우리와 경쟁자는 어디에 서 있나",
  check: (b) => {
    const dropped: string[] = [];
    return { block: { ...b, _pts: readPts(b.items, dropped) }, dropped };
  },
  render: (b) => <Positioning b={b as PosB & { _pts: Pt[] }} />,
  examples: [
    {
      label: "가정용 커피머신 포지셔닝",
      x: { lo: "저가", hi: "고가" },
      y: { lo: "간편함", hi: "전문성" },
      items: [
        { label: "우리 제품", x: 0.2, y: 0.55, em: true, size: 12 }, { label: "네스프레소", x: 0.35, y: -0.5, size: 40 },
        { label: "드롱기", x: 0.55, y: 0.35, size: 25 }, { label: "브레빌", x: 0.8, y: 0.75, size: 18 },
        { label: "일리", x: 0.15, y: -0.35, size: 10 }, { label: "필립스", x: -0.45, y: -0.15, size: 22 },
        { label: "샤오미", x: -0.8, y: -0.6, size: 15 },
      ],
    },
  ],
});

/* ───────────── SWOT ───────────── */

interface SwotB { label?: string; s?: unknown; w?: unknown; o?: unknown; t?: unknown; so?: unknown; st?: unknown; wo?: unknown; wt?: unknown }
const SWOT = [
  { k: "s", badge: "S", name: "강점", tone: 0 }, { k: "w", badge: "W", name: "약점", tone: 1 },
  { k: "o", badge: "O", name: "기회", tone: 2 }, { k: "t", badge: "T", name: "위협", tone: 7 },
] as const;
defineViz<SwotB>({
  type: "swot",
  family: "slide",
  title: "SWOT",
  when: "안의 강점·약점과 밖의 기회·위협은 무엇이고, 그래서 어떤 전략인가",
  render: (b) => {
    const tows = [["so", "SO 전략"], ["wo", "WO 전략"], ["st", "ST 전략"], ["wt", "WT 전략"]] as const;
    const has = tows.some(([k]) => texts(b[k]).length);
    return (
      <Card label={b.label} class="sl-swot">
        <Matrix n={2} rows={["내부", "외부"]} cols={["도움", "방해"]} cells={SWOT.map((q) => ({ label: q.name, badge: q.badge, tone: q.tone, points: texts(b[q.k]) }))} />
        <Show when={has}>
          <div class="sl-tows">
            <For each={tows}>{([k, name]) => <Show when={texts(b[k]).length}><div><b>{name}</b><ul class="sl-points"><For each={texts(b[k])}>{(p) => <li>{p}</li>}</For></ul></div></Show>}</For>
          </div>
        </Show>
      </Card>
    );
  },
  examples: [
    {
      label: "사내 메신저 SWOT",
      s: ["보안 인증 3종 보유", "공공기관 도입 42곳", "온프레미스 설치 지원"],
      w: ["모바일 앱 평점 3.4", "외부 연동 앱 12개뿐"],
      o: ["망분리 완화 정책", "중견기업 협업툴 수요 증가"],
      t: ["글로벌 SaaS의 가격 인하", "AI 비서 기능 경쟁"],
      so: ["공공 레퍼런스로 금융권 진출"], wt: ["모바일 앱 재작성 우선"],
    },
  ],
});

/* ───────────── PEST / PESTLE ───────────── */

interface PestB { label?: string; p?: unknown; e?: unknown; s?: unknown; t?: unknown; l?: unknown; env?: unknown }
const PEST = [
  { k: "p", badge: "P", name: "정치" }, { k: "e", badge: "E", name: "경제" }, { k: "s", badge: "S", name: "사회" },
  { k: "t", badge: "T", name: "기술" }, { k: "l", badge: "L", name: "법·제도" }, { k: "env", badge: "E", name: "환경" },
] as const;
defineViz<PestB>({
  type: "pest",
  family: "slide",
  title: "PEST · PESTLE",
  when: "정치·경제·사회·기술(·법·환경) 쪽 바깥 변화는 무엇인가",
  render: (b) => {
    const cols = () => PEST.filter((f, i) => i < 4 || texts(b[f.k]).length);
    return (
      <Card label={b.label} class="sl-pest">
        <div class="sl-cols" style={{ "--n": cols().length, "--pc": cols().length > 4 ? 3 : cols().length }}>
          <For each={cols()}>
            {(f, i) => (
              <div class="sl-col">
                <div class="sl-mx-head"><span class="sl-badge" style={{ "--c": series(i() === 3 ? 6 : i()) }}>{f.badge}</span><b>{f.name}</b></div>
                <ul class="sl-points"><For each={texts(b[f.k])}>{(p) => <li>{p}</li>}</For></ul>
              </div>
            )}
          </For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "전기차 충전 사업 외부 환경",
      p: ["충전기 보조금 2027년까지 연장", "공공주차장 설치 의무화"],
      e: ["전기요금 kWh당 8% 인상", "금리 인하로 설비 투자 여력"],
      s: ["아파트 거주 비율 64%", "충전 대기 불만 증가"],
      t: ["350kW 초급속 보급", "배터리 교환식 시범 사업"],
      l: ["개인정보 결제 정보 보관 규정"],
      env: ["탄소 배출권 가격 상승"],
    },
  ],
});

/* ───────────── frameworks: 3C, 4P, STP, any N boxes ───────────── */

interface FrameB { label?: string; preset?: string; flow?: boolean; items?: unknown[] }
const PRESETS: Record<string, { badge: string; name: string }[]> = {
  "3c": [{ badge: "C", name: "자사" }, { badge: "C", name: "고객" }, { badge: "C", name: "경쟁사" }],
  "4p": [{ badge: "P", name: "제품" }, { badge: "P", name: "가격" }, { badge: "P", name: "유통" }, { badge: "P", name: "판촉" }],
  "4c": [{ badge: "C", name: "고객 가치" }, { badge: "C", name: "고객 비용" }, { badge: "C", name: "편의성" }, { badge: "C", name: "소통" }],
  stp: [{ badge: "S", name: "시장 세분화" }, { badge: "T", name: "표적 시장" }, { badge: "P", name: "포지셔닝" }],
};
defineViz<FrameB>({
  type: "frame",
  family: "slide",
  title: "프레임워크 (3C·4P·STP)",
  when: "정해진 틀(3C, 4P, 4C, STP 등)의 칸마다 무엇이 들어가나",
  render: (b) => {
    const preset = PRESETS[str(b.preset).toLowerCase()] ?? [];
    const flow = b.flow ?? str(b.preset).toLowerCase() === "stp";
    const cols = () => {
      const raw = arr(b.items);
      const n = Math.max(raw.length, preset.length);
      return Array.from({ length: Math.min(n, 6) }, (_, i) => {
        const r = raw[i];
        const o = (r && typeof r === "object" && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
        return { badge: str(o.key) || preset[i]?.badge || String(i + 1), name: item(r)?.label ?? preset[i]?.name ?? "", sub: str(o.sub), points: Array.isArray(r) ? texts(r) : texts(o.points ?? o.items), em: o.em === true };
      }).filter((c) => c.name || c.points.length);
    };
    return (
      <Card label={b.label} class="sl-frame">
        <div class="sl-cols" classList={{ flow }} style={{ "--n": cols().length }}>
          <For each={cols()}>
            {(c, i) => (
              <div class="sl-col" classList={{ em: c.em }}>
                <div class="sl-mx-head"><span class="sl-badge" style={{ "--c": series(i() === 3 ? 6 : i()) }}>{c.badge}</span><b>{c.name}</b></div>
                <Show when={c.sub}><p class="sl-note">{c.sub}</p></Show>
                <ul class="sl-points"><For each={c.points}>{(p) => <li>{p}</li>}</For></ul>
              </div>
            )}
          </For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "구독형 밀키트 3C",
      preset: "3c",
      items: [
        { points: ["냉장 물류센터 2곳", "레시피 1,200종", "재구독률 61%"] },
        { points: ["30대 맞벌이 가구", "평일 저녁 20분 조리 선호"] },
        { points: ["대형 이커머스 PB 밀키트", "가격 15% 낮음"] },
      ],
    },
    {
      label: "신규 요금제 STP",
      preset: "stp",
      items: [
        { points: ["사용량", "업종", "결제 방식"] },
        { points: ["월 거래 1천 건 이하 소상공인"], em: true },
        { points: ["가장 싼 시작 요금", "설정 5분"] },
      ],
    },
  ],
});

/* ───────────── Porter's five forces ───────────── */

type Force = { level?: number; points: string[] };
interface ForcesB { label?: string; rivalry?: unknown; entrants?: unknown; suppliers?: unknown; buyers?: unknown; substitutes?: unknown }
const LEVEL: Record<string, number> = { "낮음": 1, low: 1, "보통": 3, mid: 3, medium: 3, "중간": 3, "높음": 5, high: 5, "매우 높음": 5 };
const force = (x: unknown): Force => {
  if (Array.isArray(x) || typeof x === "string") return { points: texts(x) };
  const o = (x ?? {}) as Record<string, unknown>;
  const n = toNum(o.level) ?? LEVEL[str(o.level).toLowerCase()];
  return { level: n === undefined ? undefined : Math.max(1, Math.min(5, Math.round(n))), points: texts(o.points ?? o.items) };
};
const LEVEL_WORD = ["", "낮음", "다소 낮음", "보통", "다소 높음", "높음"];
function ForceBox(p: { name: string; f: Force; mid?: boolean; area: string }) {
  return (
    <div class="sl-force" classList={{ mid: p.mid }} style={{ "grid-area": p.area }}>
      <div class="sl-force-head">
        <b>{p.name}</b>
        <Show when={p.f.level}>
          <span class="sl-level" title={`강도 ${p.f.level}/5`}>
            <Index each={[1, 2, 3, 4, 5]}>{(k) => <i classList={{ on: k() <= p.f.level! }} />}</Index>
            <em>{LEVEL_WORD[p.f.level!]}</em>
          </span>
        </Show>
      </div>
      <ul class="sl-points"><For each={p.f.points}>{(t) => <li>{t}</li>}</For></ul>
    </div>
  );
}
defineViz<ForcesB>({
  type: "forces",
  family: "slide",
  title: "5 Forces",
  when: "이 산업의 수익성을 누르는 다섯 힘은 각각 얼마나 센가",
  render: (b) => (
    <Card label={b.label} class="sl-forces">
      <div class="sl-forces-grid">
        <ForceBox area="n" name="신규 진입자의 위협" f={force(b.entrants)} />
        <ForceBox area="w" name="공급자의 교섭력" f={force(b.suppliers)} />
        <ForceBox area="c" name="기존 경쟁" f={force(b.rivalry)} mid />
        <ForceBox area="e" name="구매자의 교섭력" f={force(b.buyers)} />
        <ForceBox area="s" name="대체재의 위협" f={force(b.substitutes)} />
      </div>
    </Card>
  ),
  examples: [
    {
      label: "국내 배달앱 산업",
      rivalry: { level: 5, points: ["3사 점유율 95%", "수수료 인하 경쟁"] },
      entrants: { level: 2, points: ["가맹점 네트워크 구축 비용 큼"] },
      suppliers: { level: 3, points: ["라이더 수급이 계절마다 출렁임"] },
      buyers: { level: 4, points: ["앱 전환 비용 거의 없음", "쿠폰 민감도 높음"] },
      substitutes: { level: 3, points: ["포장 주문", "편의점 간편식"] },
    },
  ],
});

/* ───────────── value chain ───────────── */

interface ChainB { label?: string; support?: unknown[]; primary?: unknown[]; margin?: string }
const SUPPORT = ["기업 인프라", "인적 자원 관리", "기술 개발", "조달"];
const PRIMARY = ["입고 물류", "운영", "출고 물류", "마케팅·판매", "서비스"];
defineViz<ChainB>({
  type: "valueChain",
  family: "slide",
  title: "가치사슬",
  when: "가치는 어떤 활동들을 거쳐 만들어지고, 어디가 강하거나 약한가",
  render: (b) => {
    const read = (raw: unknown[] | undefined, names: string[]) => {
      const r = arr(raw);
      return (r.length ? r : names).map((x, i) => {
        const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
        return { label: item(x)?.label ?? names[i] ?? "", points: texts(o.points ?? o.items), em: o.em === true, note: str(o.note) };
      }).filter((x) => x.label);
    };
    const sup = () => read(b.support, SUPPORT), pri = () => read(b.primary, PRIMARY);
    return (
      <Card label={b.label} class="sl-chain">
        <div class="sl-chain-body" style={{ "--n": pri().length }}>
          <div class="sl-chain-sup">
            <For each={sup()}>{(s) => <div class="sl-chain-row" classList={{ em: s.em }}><b>{s.label}</b><span>{[s.note, ...s.points].filter(Boolean).join(" · ")}</span></div>}</For>
          </div>
          <div class="sl-chain-pri">
            <For each={pri()}>
              {(p) => (
                <div class="sl-chain-act" classList={{ em: p.em }}>
                  <b>{p.label}</b>
                  <Show when={p.note}><p class="sl-note">{p.note}</p></Show>
                  <ul class="sl-points"><For each={p.points}>{(t) => <li>{t}</li>}</For></ul>
                </div>
              )}
            </For>
          </div>
          <div class="sl-chain-margin"><span>{b.margin ?? "이윤"}</span></div>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "D2C 의류 브랜드 가치사슬",
      support: [{ label: "기업 인프라", note: "자체 주문 관리 시스템" }, { label: "인적 자원 관리", note: "MD 12명" }, { label: "기술 개발", note: "핏 추천 모델", em: true }, { label: "조달", note: "국내 봉제 공장 4곳" }],
      primary: [
        { label: "입고 물류", points: ["원단 검수"] }, { label: "생산", points: ["소량 다품종", "리드타임 9일"], em: true },
        { label: "출고 물류", points: ["당일 출고 92%"] }, { label: "마케팅·판매", points: ["자사몰 78%"] }, { label: "서비스", points: ["무료 교환"] },
      ],
    },
  ],
});

/* ───────────── business model canvas, lean canvas ───────────── */

const CANVAS_AREAS = ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const;
function Canvas(props: { label?: string; names: string[]; keys: string[]; b: Record<string, unknown>; class: string }) {
  return (
    <Card label={props.label} class={`sl-canvas ${props.class}`}>
      <div class="sl-canvas-grid">
        <For each={props.keys}>
          {(k, i) => (
            <div class="sl-canvas-cell" style={{ "grid-area": CANVAS_AREAS[i()] }} classList={{ em: k === "value" }}>
              <b>{props.names[i()]}</b>
              <ul class="sl-points"><For each={texts(props.b[k])}>{(p) => <li>{p}</li>}</For></ul>
            </div>
          )}
        </For>
      </div>
    </Card>
  );
}
const BMC_KEYS = ["partners", "activities", "resources", "value", "relations", "channels", "segments", "costs", "revenue"];
const BMC_NAMES = ["핵심 파트너", "핵심 활동", "핵심 자원", "가치 제안", "고객 관계", "채널", "고객 세그먼트", "비용 구조", "수익원"];
defineViz<Record<string, unknown>>({
  type: "bmc",
  family: "slide",
  title: "비즈니스 모델 캔버스",
  when: "누구에게 무엇을 어떻게 팔아 어떻게 돈을 버는가 (9블록)",
  render: (b) => <Canvas label={str(b.label) || undefined} names={BMC_NAMES} keys={BMC_KEYS} b={b} class="bmc" />,
  examples: [
    {
      label: "공유 킥보드 사업 모델",
      partners: ["지자체", "배터리 공급사"], activities: ["기기 재배치", "충전·정비"], resources: ["기기 1.2만 대", "수거 차량"],
      value: ["역에서 회사까지 5분", "앱 하나로 잠금 해제"], relations: ["자동 결제", "정기권 할인"], channels: ["앱", "역 주변 거치대"],
      segments: ["출퇴근 직장인", "대학생"], costs: ["기기 감가상각 38%", "인건비 27%", "보험"], revenue: ["분당 요금", "월 정기권", "광고"],
    },
  ],
});
const LEAN_KEYS = ["problem", "solution", "metrics", "value", "advantage", "channels", "segments", "costs", "revenue"];
const LEAN_NAMES = ["문제", "해결책", "핵심 지표", "고유 가치 제안", "경쟁 우위", "채널", "고객군", "비용 구조", "수익원"];
defineViz<Record<string, unknown>>({
  type: "lean",
  family: "slide",
  title: "린 캔버스",
  when: "초기 아이디어의 문제·해결책·지표·우위를 한 장으로 보면",
  render: (b) => <Canvas label={str(b.label) || undefined} names={LEAN_NAMES} keys={LEAN_KEYS} b={b} class="lean" />,
  examples: [
    {
      label: "소상공인 세무 앱",
      problem: ["부가세 신고가 어렵다", "세무사 비용 월 15만 원"], solution: ["카드 매출 자동 분류", "신고서 초안 생성"], metrics: ["월 신고 완료 수", "유료 전환율"],
      value: ["신고 10분, 세무사 비용 1/5"], advantage: ["카드사 데이터 제휴"], channels: ["카드사 앱 배너", "상인회"],
      segments: ["연 매출 3억 이하 개인사업자"], costs: ["데이터 제휴비", "상담 인력"], revenue: ["월 9,900원 구독"],
    },
  ],
});

/* ───────────── Ansoff ───────────── */

interface AnsoffB { label?: string; penetration?: unknown; product?: unknown; market?: unknown; diversification?: unknown; pick?: string }
defineViz<AnsoffB>({
  type: "ansoff",
  family: "slide",
  title: "앤소프 매트릭스",
  when: "기존·신규 제품과 시장 중 어디로 성장할 것인가",
  render: (b) => {
    const pick = str(b.pick);
    const c = (k: "penetration" | "product" | "market" | "diversification", label: string, note: string): MCell => ({ label, note, points: texts(b[k]), em: pick === k || pick === label });
    return (
      <Card label={b.label} class="sl-ansoff">
        <Matrix n={2} cols={["기존 제품", "신규 제품"]} rows={["기존 시장", "신규 시장"]}
          cells={[c("penetration", "시장 침투", "위험 낮음"), c("product", "제품 개발", "위험 중간"), c("market", "시장 개발", "위험 중간"), c("diversification", "다각화", "위험 높음")]} />
      </Card>
    );
  },
  examples: [
    {
      label: "홈트 앱 성장 방향",
      penetration: ["연간권 20% 할인", "친구 초대 보상"], product: ["식단 코칭 추가", "스마트워치 연동"],
      market: ["일본 출시", "기업 복지 제휴"], diversification: ["오프라인 PT 스튜디오"], pick: "product",
    },
  ],
});

/* ───────────── risk matrix ───────────── */

interface RiskB { label?: string; x?: string; y?: string; n?: number; items?: unknown[] }
interface Risk { no: number; label: string; note?: string; x: number; y: number }
function checkRisk(b: RiskB): Checked<RiskB & { _r: Risk[]; _n: number }> {
  const dropped: string[] = [];
  const n = b.n === 3 || b.n === 4 ? b.n : 5;
  const r: Risk[] = [];
  arr(b.items).forEach((x, i) => {
    const it = item(x);
    const o = (x ?? {}) as Record<string, unknown>;
    const ix = toNum(o.impact ?? o.x), iy = toNum(o.likely ?? o.y);
    if (!it) return void dropped.push(`items[${i}]: label 없음`);
    if (ix === undefined || iy === undefined) return void dropped.push(`items[${i}] ${it.label}: impact, likely 필요`);
    r.push({ no: r.length + 1, label: it.label, note: it.note, x: Math.max(1, Math.min(n, Math.round(ix))), y: Math.max(1, Math.min(n, Math.round(iy))) });
  });
  return { block: { ...b, _r: r, _n: n }, dropped };
}
defineViz<RiskB>({
  type: "risk",
  family: "slide",
  title: "리스크 매트릭스",
  when: "어떤 위험이 가능성과 영향 모두 커서 먼저 막아야 하나",
  check: checkRisk,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkRisk>["block"];
    const n = b._n;
    const level = (x: number, y: number) => {
      const s = (x * y) / (n * n);
      return s >= 0.6 ? "bad" : s >= 0.3 ? "serious" : s >= 0.12 ? "warn" : "good";
    };
    const cells = () => Array.from({ length: n * n }, (_, i) => ({ x: (i % n) + 1, y: n - Math.floor(i / n) }));
    return (
      <Card label={b.label} class="sl-risk">
        <div class="sl-risk-wrap" style={{ "--n": n }}>
          <div class="sl-risk-y"><span>{b.y ?? "발생 가능성"}</span></div>
          <div class="sl-risk-grid">
            <For each={cells()}>
              {(c) => (
                <div class={`sl-risk-cell l-${level(c.x, c.y)}`}>
                  <For each={b._r.filter((r) => r.x === c.x && r.y === c.y)}>
                    {(r) => <span class="sl-risk-chip" title={`${r.label}${r.note ? ` · ${r.note}` : ""}`}>{r.no}</span>}
                  </For>
                </div>
              )}
            </For>
          </div>
          <div />
          <div class="sl-risk-x">{b.x ?? "영향도"}</div>
        </div>
        <ol class="sl-risk-list">
          <For each={b._r}>{(r) => <li><span class={`sl-risk-chip l-${level(r.x, r.y)}`}>{r.no}</span><b>{r.label}</b><Show when={r.note}><em>{r.note}</em></Show></li>}</For>
        </ol>
      </Card>
    );
  },
  examples: [
    {
      label: "결제 시스템 이전 리스크",
      items: [
        { label: "이중 결제", impact: 5, likely: 3, note: "멱등 키 누락 시" }, { label: "정산 데이터 불일치", impact: 4, likely: 4 },
        { label: "PG사 API 변경", impact: 3, likely: 2 }, { label: "야간 배포 중 장애", impact: 4, likely: 2 },
        { label: "고객 문의 급증", impact: 2, likely: 4 }, { label: "인증서 만료", impact: 5, likely: 1 },
      ],
    },
  ],
});

/* ───────────── empathy map ───────────── */

interface EmpathyB { label?: string; name?: string; says?: unknown; thinks?: unknown; does?: unknown; feels?: unknown; pains?: unknown; gains?: unknown }
defineViz<EmpathyB>({
  type: "empathy",
  family: "slide",
  title: "공감 지도",
  when: "이 사용자는 무엇을 말하고, 생각하고, 하고, 느끼나",
  render: (b) => {
    const q = (label: string, x: unknown): MCell => ({ label, points: texts(x) });
    const pains = () => texts(b.pains), gains = () => texts(b.gains);
    return (
      <Card label={b.label} class="sl-empathy">
        <div class="sl-empathy-wrap">
          <Matrix n={2} cells={[q("말", b.says), q("생각", b.thinks), q("행동", b.does), q("감정", b.feels)]} />
          <Show when={b.name}><div class="sl-empathy-who"><span>{b.name}</span></div></Show>
        </div>
        <Show when={pains().length || gains().length}>
          <div class="sl-tows two">
            <Show when={pains().length}><div><b>불편</b><ul class="sl-points"><For each={pains()}>{(p) => <li>{p}</li>}</For></ul></div></Show>
            <Show when={gains().length}><div><b>얻고 싶은 것</b><ul class="sl-points"><For each={gains()}>{(p) => <li>{p}</li>}</For></ul></div></Show>
          </div>
        </Show>
      </Card>
    );
  },
  examples: [
    {
      label: "신규 가입 점주",
      name: "카페 점주 이수진",
      says: ["\"메뉴 등록이 너무 오래 걸려요\""], thinks: ["수수료만큼 주문이 늘까?", "리뷰 관리가 걱정"],
      does: ["밤 11시에 메뉴 사진 찍기", "경쟁 매장 가격 확인"], feels: ["첫 주문 전까지 불안", "알림이 많아 피곤"],
      pains: ["메뉴 30개 수작업 입력"], gains: ["첫 주에 주문 10건"],
    },
  ],
});

