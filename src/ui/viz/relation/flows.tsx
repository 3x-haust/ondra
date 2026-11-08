// Flows: sankey (stages, a highlighted route), alluvial (categories over time),
// chord (who exchanges with whom) and the arc diagram (links along one axis).
import { createSignal, For, Show } from "solid-js";
import { chord, chordDirected, ribbon, ribbonArrow } from "d3-chord";
import { arc as d3arc } from "d3-shape";
import { defineViz } from "../registry";
import { Frame, series, useTip } from "../kit";
import { acyclic, alluvialGraph, arcOrder, chordMatrix, cleanLinks, cleanNodes, sankeyLayout, type SNode } from "./layout/flows";
import { cleanGraph, degrees } from "./layout/graph";
import { arr, declutter, toStr } from "./layout/text";
import { Empty, FS, FS_SM, Safe, fit, legendOf, tw, val } from "./ui";

const pct = (v: number, total: number) => (total > 0 ? ` · ${Math.round((v / total) * 100)}%` : "");

/** node labels beside sankey/alluvial nodes: name (and value when there is room), kept apart */
function NodeLabels(props: { nodes: SNode[]; gap: number; lastW: number; unit?: string; showValue?: boolean }) {
  const lastX = () => Math.max(...props.nodes.map((n) => n.x1));
  const placed = () => {
    const ls = props.nodes.map((n) => {
      const right = true;
      const max = Math.max(0, n.x1 < lastX() - 1 ? props.gap - 10 : props.lastW - 6);
      const name = fit(n.label, max, FS, 500);
      const v = val(n.value, props.unit);
      const two = props.showValue !== false && n.y1 - n.y0 >= 26 && tw(v, FS_SM) <= max;
      const one = props.showValue !== false && !two && tw(`${name} ${v}`, FS, 500) <= max ? `${name} ` : undefined;
      const lw = Math.max(tw(name, FS, 500), two ? tw(v, FS_SM) : 0) + (one ? tw(v, FS_SM) + 4 : 0);
      const cy = (n.y0 + n.y1) / 2;
      const h = two ? 28 : 14;
      const x = right ? n.x1 + 5 : n.x0 - 5;
      return { n, right, name, v, two, one, x, cy, rect: { x: right ? x : x - lw, y: cy - h / 2, w: lw, h, rank: n.value } };
    });
    const keep = declutter(ls.map((l) => (l.name ? l.rect : { ...l.rect, w: 0, h: 0, rank: -1 })), 1);
    return ls.filter((l, i) => keep.has(i) && l.name);
  };
  return (
    <g class="rl-labels">
      <For each={placed()}>
        {(l) => (
          <text class="rl-halo" x={l.x} y={l.two ? l.cy - 7 : l.cy} dy="0.35em" text-anchor={l.right ? "start" : "end"}>
            <tspan class="rl-strong">{l.name}</tspan>
            <Show when={l.one}><tspan class="rl-muted" dx="4">{l.v}</tspan></Show>
            <Show when={l.two}><tspan class="rl-muted" x={l.x} dy="1.2em">{l.v}</tspan></Show>
          </text>
        )}
      </For>
    </g>
  );
}

/** room kept right of the last column for its labels */
const lastCol = (labels: string[], w: number) => Math.min(Math.max(40, ...labels.map((l) => tw(l, FS, 500))) + 10, Math.max(60, w * 0.28));

// ───────────── sankey
interface SankeyB { label?: string; unit?: string; nodes?: unknown; links?: unknown; path?: unknown }

function Sankey(b: SankeyB) {
  const links = () => acyclic(cleanLinks(b.links));
  const nodes = () => cleanNodes(b.nodes, links());
  const path = () => arr(b.path).map(toStr).filter(Boolean) as string[];
  const tip = useTip();
  // the tallest column decides the height
  const height = () => {
    const depth = new Map<string, number>();
    for (let k = 0; k < 8; k++) for (const l of links()) depth.set(l.to, Math.max(depth.get(l.to) ?? 0, (depth.get(l.from) ?? 0) + 1));
    const cols = new Map<number, number>();
    for (const n of nodes()) cols.set(depth.get(n.id) ?? 0, (cols.get(depth.get(n.id) ?? 0) ?? 0) + 1);
    return Math.max(200, Math.min(520, Math.max(0, ...cols.values()) * 40 + 20));
  };
  return (
    <Show when={links().length} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={height()} margin={{ t: 6, r: 1, b: 6, l: 1 }} alt={b.label}>
        {(box) => {
          const sinks = nodes().filter((n) => !links().some((l) => l.from === n.id) && links().some((l) => l.to === n.id));
          const inflow = (id: string) => links().filter((l) => l.to === id).reduce((a, l) => a + l.value, 0);
          const innerW = box.iw - lastCol(sinks.map((n) => `${n.label} ${val(inflow(n.id), b.unit)}`), box.iw);
          const s = sankeyLayout(nodes(), links(), innerW, box.ih, { path: path(), nodeWidth: 10, pad: 12 });
          const total = s.nodes.filter((n) => n.depth === 0).reduce((a, n) => a + n.value, 0);
          const cols = [...new Set(s.nodes.map((n) => n.x0))].sort((a, c) => a - c);
          const gap = cols.length > 1 ? cols[1] - cols[0] - 10 : box.iw / 2;
          const colorL = (l: (typeof s.links)[number]) => (s.em ? (l.em ? series(0) : "var(--viz-other)") : series(l.color));
          const colorN = (n: SNode) => (s.em ? (n.em ? series(0) : "var(--viz-muted)") : series(n.color));
          return (
            <g transform={`translate(${box.x0},${box.y0})`}>
              <g fill="none">
                <For each={[...s.links].sort((a, c) => Number(a.em) - Number(c.em))}>
                  {(l) => (
                    <path
                      class="viz-mark rl-link"
                      classList={{ em: s.em && l.em, dim: s.em && !l.em }}
                      d={l.path}
                      stroke={colorL(l)}
                      stroke-width={l.width}
                      onMouseMove={(e) => tip.show(e, `${val(l.value, b.unit)}${pct(l.value, total)}\n${l.from.label} → ${l.to.label}${l.note ? `\n${l.note}` : ""}`)}
                      onMouseLeave={tip.hide}
                    />
                  )}
                </For>
              </g>
              <For each={s.nodes}>
                {(n) => (
                  <rect
                    class="viz-mark"
                    x={n.x0}
                    y={n.y0}
                    width={n.x1 - n.x0}
                    height={Math.max(1, n.y1 - n.y0)}
                    rx={2}
                    fill={colorN(n)}
                    onMouseMove={(e) => tip.show(e, `${val(n.value, b.unit)}${pct(n.value, total)}\n${n.label}`)}
                    onMouseLeave={tip.hide}
                  />
                )}
              </For>
              <NodeLabels nodes={s.nodes} gap={gap} lastW={box.iw - innerW} unit={b.unit} />
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<SankeyB>({
  type: "sankey",
  family: "relation",
  title: "생키 다이어그램",
  when: "양이 여러 단계를 거치며 어디로 갈라지고 모이나",
  render: (b) => <Safe label={b.label}><Sankey {...b} /></Safe>,
  examples: [
    {
      label: "가입 퍼널 유입 경로",
      unit: "명",
      path: ["검색", "랜딩", "회원가입", "결제"],
      links: [
        { from: "검색", to: "랜딩", value: 4200 },
        { from: "SNS", to: "랜딩", value: 2600 },
        { from: "추천", to: "랜딩", value: 1100 },
        { from: "SNS", to: "이탈", value: 900 },
        { from: "랜딩", to: "회원가입", value: 3100 },
        { from: "랜딩", to: "이탈", value: 4800 },
        { from: "회원가입", to: "결제", value: 820 },
        { from: "회원가입", to: "무료 유지", value: 2280 },
      ],
    },
    {
      label: "2025년 에너지 공급과 소비 (만 TOE)",
      links: [
        { from: "석유", to: "수송", value: 3600 },
        { from: "석유", to: "산업", value: 4100 },
        { from: "석탄", to: "발전", value: 5200 },
        { from: "석탄", to: "산업", value: 1700 },
        { from: "LNG", to: "발전", value: 3100 },
        { from: "LNG", to: "가정·상업", value: 1900 },
        { from: "원자력", to: "발전", value: 3900 },
        { from: "신재생", to: "발전", value: 1400 },
        { from: "발전", to: "전력 소비", value: 8600 },
        { from: "발전", to: "변환 손실", value: 5000 },
        { from: "전력 소비", to: "산업", value: 4500 },
        { from: "전력 소비", to: "가정·상업", value: 4100 },
      ],
    },
  ],
});

// ───────────── alluvial
interface AlluvialB { label?: string; unit?: string; stages?: unknown; items?: unknown }

function Alluvial(b: AlluvialB) {
  const g = () => alluvialGraph(b.stages, b.items);
  const tip = useTip();
  const legend = () => legendOf(g().cats.slice(0, 9), (i) => series(i));
  return (
    <Show when={g().links.length} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.max(220, Math.min(420, 160 + g().cats.length * 26 + (w < 480 ? 20 : 0)))} margin={{ t: 22, r: 1, b: 4, l: 1 }} legend={legend()} alt={b.label}>
        {(box) => {
          const gg = g();
          const innerW = box.iw - lastCol(gg.nodes.filter((n) => n.stage === gg.stages.length - 1).map((n) => n.label), box.iw);
          const s = sankeyLayout(gg.nodes, gg.links, innerW, box.ih, { nodeWidth: 8, pad: 8, align: (n: any) => n.stage, sort: (a: any, c: any) => a.cat - c.cat });
          const cols = gg.stages.map((_, k) => s.nodes.find((n) => n.stage === k)?.x0 ?? 0);
          const gap = cols.length > 1 ? cols[1] - cols[0] - 8 : box.iw / 2;
          const totalAt = (k: number) => s.nodes.filter((n) => n.stage === k).reduce((a, n) => a + n.value, 0);
          const colorOf = (cat: number) => series(cat);
          return (
            <g transform={`translate(${box.x0},${box.y0})`}>
              <For each={gg.stages}>
                {(st, k) => {
                  const x = cols[k()] + 4;
                  const anchor = k() === 0 || k() === gg.stages.length - 1 ? "start" : "middle";
                  const ax = k() === 0 || k() === gg.stages.length - 1 ? cols[k()] : x;
                  return <text class="rl-head" x={ax} y={-9} text-anchor={anchor}>{fit(st, Math.max(24, gap - 4), FS_SM, 500)}</text>;
                }}
              </For>
              <g fill="none">
                <For each={s.links}>
                  {(l) => (
                    <path
                      class="viz-mark rl-link"
                      d={l.path}
                      stroke={colorOf(l.cat ?? 0)}
                      stroke-width={l.width}
                      onMouseMove={(e) => tip.show(e, `${val(l.value, b.unit)}\n${gg.stages[l.from.stage!]} ${l.from.label} → ${gg.stages[l.to.stage!]} ${l.to.label}`)}
                      onMouseLeave={tip.hide}
                    />
                  )}
                </For>
              </g>
              <For each={s.nodes}>
                {(n) => (
                  <rect
                    class="viz-mark"
                    x={n.x0}
                    y={n.y0}
                    width={n.x1 - n.x0}
                    height={Math.max(1, n.y1 - n.y0)}
                    rx={2}
                    fill={colorOf(n.cat ?? 0)}
                    onMouseMove={(e) => tip.show(e, `${val(n.value, b.unit)}${pct(n.value, totalAt(n.stage!))}\n${gg.stages[n.stage!]} · ${n.label}`)}
                    onMouseLeave={tip.hide}
                  />
                )}
              </For>
              <NodeLabels nodes={s.nodes.filter((n) => n.stage === 0 || n.stage === gg.stages.length - 1)} gap={gap} lastW={box.iw - innerW} unit={b.unit} showValue={box.iw > 380} />
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<AlluvialB>({
  type: "alluvial",
  family: "relation",
  title: "충적도",
  when: "범주 사이를 시간에 따라 얼마나 옮겨 다녔나",
  render: (b) => <Safe label={b.label}><Alluvial {...b} /></Safe>,
  examples: [
    {
      label: "요금제 이동 (분기별)",
      unit: "명",
      stages: ["1분기", "2분기", "3분기"],
      items: [
        { path: ["무료", "무료", "무료"], value: 5200 },
        { path: ["무료", "베이직", "베이직"], value: 1400 },
        { path: ["무료", "베이직", "프로"], value: 380 },
        { path: ["무료", "해지", "해지"], value: 1900 },
        { path: ["베이직", "베이직", "베이직"], value: 2100 },
        { path: ["베이직", "프로", "프로"], value: 640 },
        { path: ["베이직", "해지", "해지"], value: 420 },
        { path: ["프로", "프로", "프로"], value: 980 },
        { path: ["프로", "베이직", "해지"], value: 150 },
      ],
    },
  ],
});

// ───────────── chord
interface ChordB { label?: string; unit?: string; names?: unknown; matrix?: unknown; links?: unknown; directed?: boolean }

function Chord(b: ChordB) {
  const m = () => chordMatrix(b);
  const tip = useTip();
  const [hot, setHot] = createSignal(-1);
  const color = (i: number) => series(i < 8 ? i : 8);
  const lm = () => Math.min(84, Math.max(30, ...m().names.map((n) => tw(n, FS, 500))) + 10);
  return (
    <Show when={m().matrix.some((r) => r.some((v) => v > 0))} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.min(w - 2 * lm(), 360) + 44} margin={{ t: 0, r: 0, b: 0, l: 0 }} alt={b.label}>
        {(box) => {
          const R = Math.max(50, Math.min(box.iw / 2 - lm(), box.ih / 2 - 22) - 10);
          const ring = 10;
          const layout = (b.directed ? chordDirected() : chord()).padAngle(Math.min(0.04, 2 / R)).sortSubgroups((a, c) => c - a);
          const chords = layout(m().matrix);
          const groupArc = d3arc<any>().innerRadius(R).outerRadius(R + ring);
          const rib = (b.directed ? ribbonArrow().headRadius(R * 0.06) : ribbon()).radius(R - 2) as any;
          const totals = m().matrix.map((r, i) => r.reduce((a, v) => a + v, 0) + m().matrix.reduce((a, row) => a + row[i], 0) - r[i]);
          const lit = (c: any) => hot() < 0 || c.source.index === hot() || c.target.index === hot();
          return (
            <g transform={`translate(${box.w / 2},${box.h / 2})`} onMouseLeave={() => setHot(-1)}>
              <g>
                <For each={chords as any[]}>
                  {(c) => (
                    <path
                      class="rl-ribbon"
                      classList={{ dim: !lit(c) }}
                      d={rib(c)}
                      fill={color(c.source.index)}
                      onMouseMove={(e) => tip.show(e, `${m().names[c.source.index]} → ${m().names[c.target.index]}  ${val(c.source.value, b.unit)}${!b.directed && c.source.index !== c.target.index ? `\n${m().names[c.target.index]} → ${m().names[c.source.index]}  ${val(c.target.value, b.unit)}` : ""}`)}
                      onMouseLeave={tip.hide}
                    />
                  )}
                </For>
              </g>
              <For each={chords.groups as any[]}>
                {(g) => {
                  const mid = (g.startAngle + g.endAngle) / 2;
                  const lx = Math.sin(mid) * (R + ring + 7);
                  const ly = -Math.cos(mid) * (R + ring + 7);
                  const side = Math.abs(Math.sin(mid)) < 0.18 ? "middle" : Math.sin(mid) > 0 ? "start" : "end";
                  const room = (g.endAngle - g.startAngle) * (R + ring + 6);
                  const name = room >= 10 ? fit(m().names[g.index], lm() - 10, FS, 500) : "";
                  return (
                    <g onMouseEnter={() => setHot(g.index)}>
                      <path
                        class="viz-mark"
                        d={groupArc(g) ?? ""}
                        fill={color(g.index)}
                        onMouseMove={(e) => tip.show(e, `${val(totals[g.index], b.unit)}\n${m().names[g.index]} 합계`)}
                        onMouseLeave={tip.hide}
                      />
                      <Show when={name}>
                        <text class="rl-strong" x={lx} y={ly + (Math.abs(Math.sin(mid)) < 0.18 ? (ly < 0 ? -4 : 8) : 0)} dy="0.35em" text-anchor={side}>{name}</text>
                      </Show>
                    </g>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<ChordB>({
  type: "chord",
  family: "relation",
  title: "코드 다이어그램",
  when: "여러 집단이 서로 얼마나 주고받나",
  render: (b) => <Safe label={b.label}><Chord {...b} /></Safe>,
  examples: [
    {
      label: "권역 간 인구 이동 (2024, 천 명)",
      links: [
        { from: "수도권", to: "충청권", value: 182 },
        { from: "충청권", to: "수도권", value: 151 },
        { from: "수도권", to: "강원권", value: 64 },
        { from: "강원권", to: "수도권", value: 58 },
        { from: "영남권", to: "수도권", value: 176 },
        { from: "수도권", to: "영남권", value: 121 },
        { from: "호남권", to: "수도권", value: 98 },
        { from: "수도권", to: "호남권", value: 71 },
        { from: "영남권", to: "충청권", value: 44 },
        { from: "호남권", to: "충청권", value: 39 },
        { from: "충청권", to: "호남권", value: 33 },
        { from: "영남권", to: "호남권", value: 21 },
      ],
    },
  ],
});

// ───────────── arc diagram
interface ArcB { label?: string; unit?: string; nodes?: unknown; links?: unknown }

function ArcDiagram(b: ArcB) {
  const g = () => cleanGraph(b);
  const order = () => arcOrder(g().nodes.map((n) => ({ id: n.id, label: n.label, group: n.group, em: n.em })));
  const tip = useTip();
  const [hot, setHot] = createSignal<string | null>(null);
  const ROW = 22;
  const legend = () => (g().groups.length > 1 ? legendOf(g().groups, (i) => series(i)) : undefined);
  return (
    <Show when={g().links.length} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={order().length * ROW + 12} margin={{ t: 6, r: 6, b: 6, l: 0 }} legend={legend()} alt={b.label}>
        {(box) => {
          const ns = order();
          const y = new Map(ns.map((n, i) => [n.id, box.y0 + i * ROW + ROW / 2]));
          const deg = degrees(g());
          const dmax = Math.max(1, ...deg.values());
          const lw = Math.min(Math.max(...ns.map((n) => tw(n.label, FS, 500))) + 4, Math.max(70, box.w * 0.34));
          const x = lw + 12;
          const room = box.w - x - box.x0 - 6;
          const vmax = Math.max(1e-9, ...g().links.map((l) => l.value));
          const emAny = g().links.some((l) => l.em) || ns.some((n) => n.em);
          const gi = (id: string) => g().groups.indexOf(g().nodes.find((n) => n.id === id)?.group ?? "");
          const linkOn = (l: { from: string; to: string }) => !hot() || l.from === hot() || l.to === hot();
          return (
            <g onMouseLeave={() => setHot(null)}>
              <g fill="none">
                <For each={[...g().links].sort((a, c) => c.value - a.value)}>
                  {(l) => {
                    const ya = y.get(l.from)!;
                    const yb = y.get(l.to)!;
                    const r = Math.abs(yb - ya) / 2;
                    const rx = Math.min(r, room);
                    const [y0, y1] = ya < yb ? [ya, yb] : [yb, ya];
                    const c = emAny ? (l.em ? series(0) : "var(--viz-other)") : g().groups.length ? series(Math.max(0, gi(l.from))) : series(0);
                    return (
                      <path
                        class="rl-arc"
                        classList={{ dim: !linkOn(l), em: emAny && !!l.em }}
                        d={`M${x},${y0}A${rx},${r} 0 0,1 ${x},${y1}`}
                        stroke={c}
                        stroke-width={1 + 4 * (l.value / vmax)}
                        onMouseMove={(e) => tip.show(e, `${val(l.value, b.unit)}\n${g().nodes.find((n) => n.id === l.from)?.label} — ${g().nodes.find((n) => n.id === l.to)?.label}`)}
                        onMouseLeave={tip.hide}
                      />
                    );
                  }}
                </For>
              </g>
              <For each={ns}>
                {(n) => (
                  <g onMouseEnter={() => setHot(n.id)} class="rl-hit">
                    <rect x={0} y={y.get(n.id)! - ROW / 2} width={x + 8} height={ROW} fill="transparent" />
                    <text class="rl-strong" classList={{ dimtext: !!hot() && hot() !== n.id }} x={lw} y={y.get(n.id)} dy="0.35em" text-anchor="end">{fit(n.label, lw, FS, 500)}</text>
                    <circle cx={x} cy={y.get(n.id)} r={2.5 + 3 * Math.sqrt((deg.get(n.id) ?? 0) / dmax)} fill={emAny ? (n.em ? series(0) : "var(--viz-muted)") : g().groups.length ? series(Math.max(0, gi(n.id))) : series(0)} class="rl-ring" />
                  </g>
                )}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<ArcB>({
  type: "arcdiagram",
  family: "relation",
  title: "아크 다이어그램",
  when: "한 줄로 늘어놓은 항목들이 서로 어떻게 이어지나",
  render: (b) => <Safe label={b.label}><ArcDiagram {...b} /></Safe>,
  examples: [
    {
      label: "모듈 간 호출 횟수",
      unit: "회",
      nodes: [
        { id: "auth", label: "인증", group: "코어" },
        { id: "session", label: "세션", group: "코어" },
        { id: "db", label: "DB 풀", group: "코어" },
        { id: "order", label: "주문", group: "도메인" },
        { id: "pay", label: "결제", group: "도메인" },
        { id: "stock", label: "재고", group: "도메인" },
        { id: "noti", label: "알림", group: "외부" },
        { id: "mail", label: "메일 발송", group: "외부" },
        { id: "log", label: "감사 로그", group: "외부" },
      ],
      links: [
        { from: "auth", to: "session", value: 820 },
        { from: "auth", to: "db", value: 410 },
        { from: "order", to: "pay", value: 640 },
        { from: "order", to: "stock", value: 590 },
        { from: "order", to: "db", value: 900 },
        { from: "pay", to: "db", value: 380 },
        { from: "pay", to: "noti", value: 210 },
        { from: "noti", to: "mail", value: 190 },
        { from: "auth", to: "log", value: 120 },
        { from: "pay", to: "log", value: 260 },
        { from: "session", to: "order", value: 300 },
      ],
    },
  ],
});
