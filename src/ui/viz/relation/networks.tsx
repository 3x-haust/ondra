// Networks: node-link (force layout run to rest), adjacency matrix ordered by cluster,
// hierarchical edge bundling and the ego (radial) network.
import { createMemo, createSignal, For, Show } from "solid-js";
import { cluster, hierarchy } from "d3-hierarchy";
import { curveBundle, lineRadial } from "d3-shape";
import { defineViz } from "../registry";
import { Frame, seq, series, useTip } from "../kit";
import { bundleTree, cleanGraph, degrees, egoLayout, forceLayout, matrixOrder, type Graph } from "./layout/graph";
import { declutter, toStr } from "./layout/text";
import { Empty, FS, FS_SM, Ramp, Safe, fit, legendOf, tw, val } from "./ui";

interface NetB { label?: string; unit?: string; nodes?: unknown; links?: unknown; edges?: unknown; directed?: boolean; center?: unknown; depth?: number }

const groupColor = (g: Graph, group?: string) => (g.groups.length ? series(Math.max(0, g.groups.indexOf(group ?? ""))) : series(0));
const neighbours = (g: Graph) => {
  const m = new Map<string, Set<string>>();
  for (const l of g.links) for (const [a, b] of [[l.from, l.to], [l.to, l.from]]) (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
  return m;
};
const legendFor = (g: Graph) => (g.groups.length > 1 ? legendOf(g.groups.slice(0, 9), (i) => series(i)) : undefined);

// ───────────── node-link
function Network(b: NetB) {
  const g = createMemo(() => cleanGraph(b));
  const nb = createMemo(() => neighbours(g()));
  const tip = useTip();
  const [hot, setHot] = createSignal<string | null>(null);
  const near = (id: string) => !hot() || hot() === id || !!nb().get(hot()!)?.has(id);
  return (
    <Show when={g().nodes.length > 1} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.max(280, Math.min(520, w * 0.72)))} margin={{ t: 4, r: 4, b: 4, l: 4 }} legend={legendFor(g())} alt={b.label}>
        {(box) => {
          const ps = forceLayout(g(), box.iw, box.ih, { pad: 18, rmin: 3.5, rmax: box.iw < 420 ? 9 : 12 });
          const at = new Map(ps.map((p) => [p.id, p]));
          const vmax = Math.max(1e-9, ...g().links.map((l) => l.value));
          const emAny = g().links.some((l) => l.em) || g().nodes.some((n) => n.em);
          const emNode = g().nodes.some((n) => n.em);
          // label the important nodes (degree, value, em) that fit without collisions
          const k = Math.max(4, Math.min(24, Math.floor((box.iw * box.ih) / 9000)));
          const ranked = [...ps].sort((a, c) => Number(!!c.em) - Number(!!a.em) || (c.value ?? c.deg) - (a.value ?? a.deg));
          const want = new Set(ranked.slice(0, k).map((p) => p.id));
          const cands = ps.filter((p) => want.has(p.id)).map((p) => {
            const t = fit(p.label, 110, FS, 500);
            const w = tw(t, FS, 500);
            const right = p.x + p.r + 4 + w < box.iw;
            const x = right ? p.x + p.r + 4 : p.x - p.r - 4;
            return { p, t, x, right, rect: { x: right ? x : x - w, y: p.y - 7, w, h: 14, rank: (p.em ? 1e9 : 0) + (p.value ?? p.deg) } };
          });
          const keep = declutter([...cands.map((c) => c.rect), ...ps.map((p) => ({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2, rank: 1e12 }))], 1);
          const labels = cands.filter((_, i) => keep.has(i));
          return (
            <g transform={`translate(${box.x0},${box.y0})`} onMouseLeave={() => setHot(null)}>
              <g>
                <For each={g().links}>
                  {(l) => {
                    const a = at.get(l.from)!;
                    const c = at.get(l.to)!;
                    return (
                      <line
                        class="rl-edge"
                        classList={{ em: emAny && !!l.em, dim: !!hot() && hot() !== l.from && hot() !== l.to }}
                        x1={a.x} y1={a.y} x2={c.x} y2={c.y}
                        stroke-width={0.8 + 2.6 * Math.sqrt(l.value / vmax)}
                        stroke-opacity={emAny && !l.em ? 0.5 : 0.85}
                        onMouseMove={(e) => tip.show(e, `${val(l.value, b.unit)}\n${a.label} — ${c.label}${l.label ? `\n${l.label}` : ""}`)}
                        onMouseLeave={tip.hide}
                      />
                    );
                  }}
                </For>
              </g>
              <For each={ps}>
                {(p) => (
                  <circle
                    class="rl-node rl-ring"
                    classList={{ dim: !near(p.id) }}
                    cx={p.x} cy={p.y} r={p.r}
                    fill={emNode && !p.em ? "var(--viz-muted)" : groupColor(g(), p.group)}
                    onMouseEnter={() => setHot(p.id)}
                    onMouseMove={(e) => tip.show(e, `${p.label}${p.group ? ` · ${p.group}` : ""}\n연결 ${nb().get(p.id)?.size ?? 0}${p.value !== undefined ? ` · ${val(p.value, b.unit)}` : ""}${p.note ? `\n${p.note}` : ""}`)}
                    onMouseLeave={tip.hide}
                  />
                )}
              </For>
              <For each={labels}>
                {(c) => <text class="rl-strong rl-halo" classList={{ dimtext: !near(c.p.id) }} x={c.x} y={c.p.y} dy="0.35em" text-anchor={c.right ? "start" : "end"}>{c.t}</text>}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

const TEAM = {
  nodes: [
    { id: "지수", group: "프론트엔드", value: 42 }, { id: "민호", group: "프론트엔드", value: 31 }, { id: "서연", group: "프론트엔드", value: 18 }, { id: "하늘", group: "프론트엔드", value: 9 },
    { id: "도윤", group: "백엔드", value: 47 }, { id: "예준", group: "백엔드", value: 28 }, { id: "시우", group: "백엔드", value: 22 }, { id: "주원", group: "백엔드", value: 11 },
    { id: "하은", group: "데이터", value: 26 }, { id: "지안", group: "데이터", value: 14 }, { id: "윤서", group: "데이터", value: 8 },
    { id: "채원", group: "디자인", value: 19 }, { id: "다은", group: "디자인", value: 7 },
  ],
  links: [
    { from: "지수", to: "민호", value: 34 }, { from: "지수", to: "서연", value: 21 }, { from: "민호", to: "하늘", value: 9 }, { from: "서연", to: "하늘", value: 6 },
    { from: "도윤", to: "예준", value: 30 }, { from: "도윤", to: "시우", value: 24 }, { from: "예준", to: "주원", value: 10 }, { from: "시우", to: "주원", value: 7 },
    { from: "하은", to: "지안", value: 15 }, { from: "하은", to: "윤서", value: 9 }, { from: "채원", to: "다은", value: 12 },
    { from: "지수", to: "도윤", value: 26, em: true }, { from: "민호", to: "예준", value: 8 }, { from: "도윤", to: "하은", value: 18, em: true },
    { from: "시우", to: "지안", value: 6 }, { from: "지수", to: "채원", value: 16 }, { from: "서연", to: "다은", value: 5 }, { from: "하은", to: "채원", value: 4 },
  ],
};

defineViz<NetB>({
  type: "network",
  family: "relation",
  title: "네트워크 그래프",
  when: "무엇이 무엇과 이어져 있고, 어디에 무리가 지나",
  render: (b) => <Safe label={b.label}><Network {...b} /></Safe>,
  examples: [
    { label: "팀 간 코드 리뷰 관계 (최근 90일, 건)", unit: "건", ...TEAM },
  ],
});

// ───────────── adjacency matrix
function Matrix(b: NetB) {
  const g = createMemo(() => cleanGraph(b));
  const order = createMemo(() => matrixOrder(g()).slice(0, 48));
  const tip = useTip();
  const [hot, setHot] = createSignal<[number, number] | null>(null);
  const lw = () => Math.min(96, Math.max(...order().map((n) => tw(n.label, FS_SM, 400))) + 6);
  return (
    <Show when={g().links.length} fallback={<Empty label={b.label} />}>
      <Frame
        label={b.label}
        class="rl"
        height={(w) => {
          const cell = Math.max(6, Math.min(24, (w - lw() - 8) / order().length));
          return Math.round(cell * order().length + lw() + 8);
        }}
        margin={{ t: 0, r: 0, b: 0, l: 0 }}
        legend={legendFor(g())}
        alt={b.label}
        below={g().groups.length ? undefined : <Ramp min={0} max={Math.max(...g().links.map((l) => l.value))} unit={b.unit} />}
      >
        {(box) => {
          const ns = order();
          const n = ns.length;
          const cell = Math.max(6, Math.min(24, (box.w - lw() - 8) / n));
          const ox = Math.max(lw() + 4, (box.w - n * cell + lw()) / 2);
          const oy = lw() + 4;
          const idx = new Map(ns.map((x, i) => [x.id, i]));
          const vmax = Math.max(1e-9, ...g().links.map((l) => l.value));
          const cells: { i: number; j: number; v: number }[] = [];
          for (const l of g().links) {
            const i = idx.get(l.from);
            const j = idx.get(l.to);
            if (i === undefined || j === undefined) continue;
            cells.push({ i, j, v: l.value });
            if (!g().directed) cells.push({ i: j, j: i, v: l.value });
          }
          // the diagonal blocks of each group
          const blocks: { a: number; z: number; gi: number }[] = [];
          ns.forEach((x, i) => {
            const last = blocks[blocks.length - 1];
            if (last && ns[last.a].group === x.group) last.z = i;
            else blocks.push({ a: i, z: i, gi: g().groups.indexOf(x.group ?? "") });
          });
          const showLabels = cell >= 9;
          const same = (i: number, j: number) => !!ns[i].group && ns[i].group === ns[j].group;
          return (
            <g onMouseLeave={() => setHot(null)}>
              <For each={g().groups.length ? blocks : []}>
                {(bk) => <rect class="rl-band" x={ox + bk.a * cell} y={oy + bk.a * cell} width={(bk.z - bk.a + 1) * cell} height={(bk.z - bk.a + 1) * cell} rx={2} />}
              </For>
              <For each={cells}>
                {(c) => (
                  <rect
                    class="rl-cell"
                    x={ox + c.j * cell + 1}
                    y={oy + c.i * cell + 1}
                    width={cell - 2}
                    height={cell - 2}
                    rx={Math.min(3, cell / 5)}
                    fill={g().groups.length ? (same(c.i, c.j) ? series(Math.max(0, g().groups.indexOf(ns[c.i].group!))) : "var(--viz-muted)") : seq(c.v / vmax)}
                    fill-opacity={g().groups.length ? 0.22 + 0.78 * Math.sqrt(c.v / vmax) : 1}
                    onMouseEnter={() => setHot([c.i, c.j])}
                    onMouseMove={(e) => tip.show(e, `${val(c.v, b.unit)}\n${ns[c.i].label} ${g().directed ? "→" : "—"} ${ns[c.j].label}`)}
                    onMouseLeave={tip.hide}
                  />
                )}
              </For>
              <Show when={showLabels}>
                <For each={ns}>
                  {(x, i) => (
                    <>
                      <text classList={{ "rl-strong": hot()?.[0] === i() }} x={ox - 4} y={oy + i() * cell + cell / 2} dy="0.35em" text-anchor="end" class="rl-sm">{fit(x.label, lw() - 6, FS_SM)}</text>
                      <text classList={{ "rl-strong": hot()?.[1] === i() }} transform={`translate(${ox + i() * cell + cell / 2},${oy - 4}) rotate(-90)`} dy="0.35em" text-anchor="start" class="rl-sm">{fit(x.label, lw() - 6, FS_SM)}</text>
                    </>
                  )}
                </For>
              </Show>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<NetB>({
  type: "adjmatrix",
  family: "relation",
  title: "인접 행렬",
  when: "많은 항목 사이의 연결을 빠짐없이, 무리별로 보려면",
  render: (b) => <Safe label={b.label}><Matrix {...b} /></Safe>,
  examples: [{ label: "팀 간 코드 리뷰 (건)", unit: "건", ...TEAM }],
});

// ───────────── hierarchical edge bundling
function Bundle(b: NetB) {
  const g = createMemo(() => cleanGraph(b));
  const tip = useTip();
  const [hot, setHot] = createSignal<string | null>(null);
  const lm = () => Math.min(90, Math.max(...g().nodes.map((n) => tw(n.label, FS_SM, 400))) + 10);
  return (
    <Show when={g().links.length} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.min(w, 540))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={legendFor(g())} alt={b.label}>
        {(box) => {
          const R = Math.max(60, Math.min(box.w, box.h) / 2 - lm() - 6);
          const root = cluster<any>().size([2 * Math.PI, R])(hierarchy(bundleTree(g())) as any);
          const leaves = root.leaves();
          const byId = new Map(leaves.map((l: any) => [l.data.id, l]));
          const line = lineRadial<any>().curve(curveBundle.beta(0.85)).radius((d: any) => d.y).angle((d: any) => d.x);
          const vmax = Math.max(1e-9, ...g().links.map((l) => l.value));
          const nodeOf = new Map(g().nodes.map((n) => [n.id, n]));
          const on = (l: { from: string; to: string }) => !hot() || l.from === hot() || l.to === hot();
          const step = (2 * Math.PI * R) / Math.max(1, leaves.length);
          return (
            <g transform={`translate(${box.w / 2},${box.h / 2})`} onMouseLeave={() => setHot(null)}>
              <g fill="none">
                <For each={g().links}>
                  {(l) => {
                    const a = byId.get(l.from);
                    const c = byId.get(l.to);
                    if (!a || !c) return null;
                    return (
                      <path
                        class="rl-arc"
                        classList={{ dim: !on(l), em: !!hot() && on(l) }}
                        d={line(a.path(c)) ?? ""}
                        stroke={hot() && on(l) ? (g().directed && l.to === hot() ? series(1) : series(0)) : groupColor(g(), nodeOf.get(l.from)?.group)}
                        stroke-width={0.8 + 1.8 * (l.value / vmax)}
                        onMouseMove={(e) => tip.show(e, `${val(l.value, b.unit)}\n${nodeOf.get(l.from)?.label} ${g().directed ? "→" : "—"} ${nodeOf.get(l.to)?.label}`)}
                        onMouseLeave={tip.hide}
                      />
                    );
                  }}
                </For>
              </g>
              <For each={leaves}>
                {(d: any) => {
                  const deg = (d.x * 180) / Math.PI - 90;
                  const flip = d.x >= Math.PI;
                  const n = nodeOf.get(d.data.id)!;
                  return (
                    <g transform={`rotate(${deg}) translate(${d.y},0)`} onMouseEnter={() => setHot(d.data.id)}>
                      <circle r={2.5} fill={groupColor(g(), n.group)} />
                      <Show when={step >= 9}>
                        <text x={flip ? -6 : 6} dy="0.35em" transform={flip ? "rotate(180)" : undefined} text-anchor={flip ? "end" : "start"} class="rl-sm" classList={{ "rl-strong": hot() === d.data.id, dimtext: !!hot() && hot() !== d.data.id }}>
                          {fit(n.label, lm() - 8, FS_SM)}
                        </text>
                      </Show>
                      <rect x={flip ? -lm() : 0} y={-step / 2} width={lm()} height={step} fill="transparent" />
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

defineViz<NetB>({
  type: "bundle",
  family: "relation",
  title: "계층 엣지 번들링",
  when: "묶음(모듈·부서) 사이에 연결이 어디로 몰리나",
  render: (b) => <Safe label={b.label}><Bundle {...b} /></Safe>,
  examples: [
    {
      label: "패키지 간 의존 (import 수)",
      unit: "개",
      directed: true,
      nodes: [
        { id: "ui/chat", group: "ui" }, { id: "ui/sidebar", group: "ui" }, { id: "ui/settings", group: "ui" }, { id: "ui/viz", group: "ui" }, { id: "ui/editor", group: "ui" },
        { id: "state/session", group: "state" }, { id: "state/store", group: "state" }, { id: "state/prefs", group: "state" },
        { id: "agent/run", group: "agent" }, { id: "agent/tools", group: "agent" }, { id: "agent/skills", group: "agent" }, { id: "agent/memory", group: "agent" },
        { id: "core/ipc", group: "core" }, { id: "core/fs", group: "core" }, { id: "core/git", group: "core" }, { id: "core/log", group: "core" },
      ],
      links: [
        { from: "ui/chat", to: "state/session", value: 9 }, { from: "ui/chat", to: "ui/viz", value: 6 }, { from: "ui/chat", to: "agent/run", value: 4 },
        { from: "ui/sidebar", to: "state/store", value: 5 }, { from: "ui/settings", to: "state/prefs", value: 7 }, { from: "ui/editor", to: "core/fs", value: 5 },
        { from: "state/session", to: "core/ipc", value: 8 }, { from: "state/store", to: "core/ipc", value: 6 }, { from: "state/prefs", to: "core/fs", value: 3 },
        { from: "agent/run", to: "agent/tools", value: 9 }, { from: "agent/run", to: "agent/memory", value: 4 }, { from: "agent/tools", to: "core/fs", value: 7 },
        { from: "agent/tools", to: "core/git", value: 5 }, { from: "agent/skills", to: "core/fs", value: 3 }, { from: "agent/run", to: "core/log", value: 3 },
        { from: "core/git", to: "core/log", value: 2 }, { from: "ui/viz", to: "state/prefs", value: 2 }, { from: "agent/memory", to: "state/store", value: 3 },
      ],
    },
  ],
});

// ───────────── ego network
function Ego(b: NetB) {
  const g = createMemo(() => cleanGraph(b));
  const e = createMemo(() => egoLayout(g(), toStr(b.center), b.depth === 1 ? 1 : 2));
  const tip = useTip();
  const [hot, setHot] = createSignal<string | null>(null);
  return (
    <Show when={e().center && e().nodes.length > 1} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.max(300, Math.min(w * 0.82, 560)))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={legendFor(g())} alt={b.label}>
        {(box) => {
          const has2 = e().nodes.some((n) => n.ring === 2);
          const lw = Math.min(84, box.w * 0.2);
          const R = Math.max(60, Math.min(box.w / 2 - lw, box.h / 2 - 18));
          const r1 = has2 ? R * 0.52 : R;
          const pos = new Map(e().nodes.map((n) => [n.id, n.ring === 0 ? [0, 0] : [Math.cos(n.angle) * (n.ring === 1 ? r1 : R), Math.sin(n.angle) * (n.ring === 1 ? r1 : R)]] as const));
          const deg = degrees(g());
          const dmax = Math.max(1, ...e().nodes.map((n) => deg.get(n.id) ?? 0));
          const vmax = Math.max(1e-9, ...e().links.map((l) => l.value));
          const color = (n: { ring: number; group?: string; em?: boolean }) => (g().groups.length ? groupColor(g(), n.group) : n.ring === 0 ? "var(--ink-2)" : n.ring === 1 ? series(0) : "var(--viz-muted)");
          const lit = (id: string) => !hot() || hot() === id || e().links.some((l) => (l.from === hot() && l.to === id) || (l.to === hot() && l.from === id));
          // labels: centre below its dot, rings outward; ring 2 only where they don't collide
          const cands = e().nodes.map((n) => {
            const [x, y] = pos.get(n.id)!;
            const size = n.ring === 2 ? FS_SM : FS;
            const max = n.ring === 0 ? 120 : n.ring === 1 && has2 ? 64 : lw - 8;
            const t = fit(n.label, max, size, n.ring < 2 ? 500 : 400);
            const w = tw(t, size, n.ring < 2 ? 500 : 400);
            const c = Math.cos(n.angle);
            const anchor: "middle" | "start" | "end" = n.ring === 0 || Math.abs(c) < 0.3 ? "middle" : c > 0 ? "start" : "end";
            const off = n.ring === 0 ? 0 : 9;
            const lx = n.ring === 0 ? x : x + Math.cos(n.angle) * off;
            const ly = n.ring === 0 ? y + 20 : y + Math.sin(n.angle) * off + (anchor === "middle" ? (Math.sin(n.angle) > 0 ? 6 : -6) : 0);
            const rx = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
            return { n, t, size, lx, ly, anchor, rect: { x: rx, y: ly - 7, w, h: 14, rank: (3 - n.ring) * 1e6 + (deg.get(n.id) ?? 0) } };
          });
          const keep = declutter(cands.map((c) => c.rect), 2);
          return (
            <g transform={`translate(${box.w / 2},${box.h / 2})`} onMouseLeave={() => setHot(null)}>
              <circle class="rl-ringline" r={r1} />
              <Show when={has2}><circle class="rl-ringline" r={R} /></Show>
              <For each={e().links}>
                {(l) => {
                  const [x1, y1] = pos.get(l.from)!;
                  const [x2, y2] = pos.get(l.to)!;
                  return (
                    <line
                      class="rl-edge"
                      classList={{ dim: !!hot() && hot() !== l.from && hot() !== l.to, em: !!l.em }}
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke-width={0.8 + 2.6 * Math.sqrt(l.value / vmax)}
                      onMouseMove={(ev) => tip.show(ev, `${val(l.value, b.unit)}\n${g().nodes.find((n) => n.id === l.from)?.label} — ${g().nodes.find((n) => n.id === l.to)?.label}`)}
                      onMouseLeave={tip.hide}
                    />
                  );
                }}
              </For>
              <For each={e().nodes}>
                {(n) => {
                  const [x, y] = pos.get(n.id)!;
                  return (
                    <circle
                      class="rl-node rl-ring"
                      classList={{ dim: !lit(n.id) }}
                      cx={x} cy={y}
                      r={n.ring === 0 ? 10 : 3 + (n.ring === 1 ? 5 : 3) * Math.sqrt((deg.get(n.id) ?? 0) / dmax)}
                      fill={color(n)}
                      onMouseEnter={() => setHot(n.id)}
                      onMouseMove={(ev) => tip.show(ev, `${n.label}${n.group ? ` · ${n.group}` : ""}\n${n.ring === 0 ? "중심" : n.ring === 1 ? "직접 연결" : `${g().nodes.find((m) => m.id === n.parent)?.label} 거쳐 연결`}${n.note ? `\n${n.note}` : ""}`)}
                      onMouseLeave={tip.hide}
                    />
                  );
                }}
              </For>
              <For each={cands.filter((_, i) => keep.has(i))}>
                {(c) => (
                  <text class={c.size === FS_SM ? "rl-halo rl-sm" : "rl-halo"} classList={{ "rl-strong": c.n.ring < 2, dimtext: !lit(c.n.id) }} x={c.lx} y={c.ly} dy="0.35em" text-anchor={c.anchor}>{c.t}</text>
                )}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<NetB>({
  type: "ego",
  family: "relation",
  title: "에고 네트워크",
  when: "한 대상을 중심으로 직접·간접 연결이 누구인가",
  render: (b) => <Safe label={b.label}><Ego {...b} /></Safe>,
  examples: [
    { label: "도윤 님의 협업 관계", unit: "건", center: "도윤", ...TEAM },
  ],
});
