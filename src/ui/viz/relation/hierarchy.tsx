// Hierarchies: treemap, sunburst, icicle, circle packing, dendrogram (linear/radial),
// tidy tree, radial tree, org chart (collapsible) and mind map (balanced both sides).
import { createMemo, createSignal, For, Show } from "solid-js";
import { cluster, pack, partition, tree, treemap, treemapSquarify, type HierarchyNode } from "d3-hierarchy";
import { arc as d3arc, linkHorizontal } from "d3-shape";
import { defineViz } from "../registry";
import { Frame, series, useTip } from "../kit";
import { t } from "../../../i18n";
import { balance, branchOf, orgIndented, orgLayout, sized, toTree, type TNode } from "./layout/trees";
import { declutter } from "./layout/text";
import { Empty, FS, FS_SM, Safe, fit, legendOf, onFillStyle, tw, val } from "./ui";

interface TreeB { label?: string; unit?: string; root?: unknown; items?: unknown; radial?: boolean; depth?: number }

const pathOf = (n: HierarchyNode<TNode>) => n.ancestors().reverse().slice(1).map((a) => a.data.name).join(" › ") || n.data.name;
const share = (n: HierarchyNode<TNode>) => {
  const r = n.ancestors().pop()!;
  return r.value ? ` · ${Math.round(((n.value ?? 0) / r.value) * 1000) / 10}%` : "";
};
/** colour slot of a node: its top-level branch (when there are 2+ branches), else slot 0 */
const slotOf = (n: HierarchyNode<TNode>, branches: number) => (branches > 1 ? Math.min(8, Math.max(0, branchOf(n))) : 0);
const branchLegend = (root: HierarchyNode<TNode>) => {
  const k = root.children?.filter((c) => c.children?.length).length ?? 0;
  return k > 1 && (root.children?.length ?? 0) <= 9 ? legendOf(root.children!.map((c) => c.data.name), (i) => series(i)) : undefined;
};
const nested = (root: HierarchyNode<TNode>) => !!root.children?.some((c) => c.children?.length);
const hasEm = (root: HierarchyNode<TNode>) => root.descendants().some((d) => d.data.em);
const fillOf = (n: HierarchyNode<TNode>, root: HierarchyNode<TNode>) => {
  if (hasEm(root)) return n.ancestors().some((a) => a.data.em) ? { c: series(0), slot: 0 } : { c: "var(--viz-other)", slot: 8 };
  const s = nested(root) ? slotOf(n, root.children?.length ?? 0) : 0;
  return { c: series(s), slot: s };
};

// ───────────── treemap
function Treemap(b: TreeB) {
  const root = createMemo(() => sized(toTree(b)));
  const tip = useTip();
  return (
    <Show when={(root().value ?? 0) > 0} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.max(240, Math.min(460, w * 0.62)))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={hasEm(root()) ? undefined : branchLegend(root())} alt={b.label}>
        {(box) => {
          const isNested = nested(root());
          const r = treemap<TNode>()
            .tile(treemapSquarify.ratio(1.3))
            .size([box.w, box.h])
            .paddingInner(2)
            .paddingTop((d) => (d.depth >= 1 && isNested && (d.x1 - d.x0) > 60 && (d.y1 - d.y0) > 60 ? 18 : d.depth >= 1 ? 2 : 0))
            .round(true)(root().copy());
          const leaves = r.leaves();
          const groups = r.descendants().filter((d) => d.depth >= 1 && d.children && d.y1 - d.y0 > 60 && d.x1 - d.x0 > 60);
          return (
            <g>
              <For each={groups}>
                {(gr) => (
                  <>
                    <rect class="rl-group" x={gr.x0} y={gr.y0} width={gr.x1 - gr.x0} height={gr.y1 - gr.y0} rx={3} />
                    <text class="rl-head" x={gr.x0 + 4} y={gr.y0 + 12}>{fit(`${gr.data.name}  ${val(gr.value, b.unit)}`, gr.x1 - gr.x0 - 8, FS_SM, 500)}</text>
                  </>
                )}
              </For>
              <For each={leaves}>
                {(n) => {
                  const w = n.x1 - n.x0;
                  const h = n.y1 - n.y0;
                  const f = fillOf(n, root());
                  const name = w > 28 && h > 18 ? fit(n.data.name, w - 10, FS, 500) : "";
                  const v = val(n.value, b.unit);
                  const two = name && h >= 36 && tw(v, FS_SM) <= w - 10;
                  return (
                    <g>
                      <rect
                        class="viz-mark"
                        x={n.x0} y={n.y0} width={Math.max(0, w)} height={Math.max(0, h)} rx={3}
                        fill={f.c}
                        onMouseMove={(e) => tip.show(e, `${v}${share(n)}\n${pathOf(n)}${n.data.note ? `\n${n.data.note}` : ""}`)}
                        onMouseLeave={tip.hide}
                      />
                      <Show when={name}>
                        <text class="rl-in" style={onFillStyle(f.c)} x={n.x0 + 5} y={n.y0 + 14}>
                          <tspan font-weight="500">{name}</tspan>
                          <Show when={two}><tspan x={n.x0 + 5} dy="1.25em" class="rl-num">{v}</tspan></Show>
                        </text>
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

const BUDGET: TreeB = {
  label: "2025년 R&D 예산 배분 (억 원)",
  unit: "억",
  items: [
    { label: "AI·데이터", children: [{ label: "파운데이션 모델", value: 820 }, { label: "AI 반도체", value: 640 }, { label: "데이터 댐", value: 310 }, { label: "AI 안전", value: 90 }] },
    { label: "바이오", children: [{ label: "신약 개발", value: 540 }, { label: "의료기기", value: 260 }, { label: "합성생물학", value: 150 }] },
    { label: "에너지", children: [{ label: "수소", value: 380 }, { label: "SMR", value: 290 }, { label: "배터리", value: 340 }] },
    { label: "우주·항공", children: [{ label: "발사체", value: 310 }, { label: "위성", value: 220 }] },
    { label: "양자", children: [{ label: "양자컴퓨팅", value: 180 }, { label: "양자통신", value: 70 }] },
  ],
};
const DISK: TreeB = {
  label: "저장소 용량 구성",
  unit: "MB",
  items: [
    { path: "node_modules/@tauri-apps", value: 182 },
    { path: "node_modules/typescript", value: 64 },
    { path: "node_modules/vite", value: 38 },
    { path: "node_modules/기타", value: 211 },
    { path: "src-tauri/target", value: 1460 },
    { path: "src-tauri/src", value: 3.8 },
    { path: "src/ui", value: 2.9 },
    { path: "src/state", value: 1.1 },
    { path: "public/fonts", value: 24 },
    { path: ".git", value: 310 },
  ],
};

defineViz<TreeB>({
  type: "treemap",
  family: "relation",
  title: "트리맵",
  when: "전체를 이루는 묶음과 항목이 각각 얼마나 차지하나",
  render: (b) => <Safe label={b.label}><Treemap {...b} /></Safe>,
  examples: [BUDGET, DISK],
});

// ───────────── sunburst
function Sunburst(b: TreeB) {
  const root = createMemo(() => sized(toTree(b)));
  const tip = useTip();
  return (
    <Show when={(root().value ?? 0) > 0} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.min(w, 460))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={hasEm(root()) ? undefined : branchLegend(root())} alt={b.label}>
        {(box) => {
          const R = Math.min(box.w, box.h) / 2 - 4;
          const depth = Math.max(1, root().height);
          const p = partition<TNode>().size([2 * Math.PI, depth + 1])(root().copy());
          const ring = R / (depth + 1);
          const a = d3arc<any>()
            .startAngle((d) => d.x0)
            .endAngle((d) => d.x1)
            .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.006))
            .padRadius(R / 2)
            .innerRadius((d) => d.y0 * ring + 1)
            .outerRadius((d) => d.y1 * ring - 1)
            .cornerRadius(2);
          const nodes = p.descendants().filter((d) => d.depth > 0 && d.x1 - d.x0 > 0.002);
          return (
            <g transform={`translate(${box.w / 2},${box.h / 2})`}>
              <For each={nodes}>
                {(n) => {
                  const f = fillOf(n, root());
                  const mid = (n.x0 + n.x1) / 2;
                  const rMid = ((n.y0 + n.y1) / 2) * ring;
                  const thick = ring - 6;
                  const arcLen = (n.x1 - n.x0) * rMid;
                  const name = arcLen >= 14 ? fit(n.data.name, thick, FS_SM, 500) : "";
                  const deg = (mid * 180) / Math.PI;
                  const op = n.depth === 1 ? 1 : n.depth === 2 ? 0.82 : 0.66;
                  const rot = deg - 90;
                  const flip = deg > 180;
                  return (
                    <g>
                      <path
                        class="viz-mark"
                        d={a(n) ?? ""}
                        fill={f.c}
                        fill-opacity={op}
                        onMouseMove={(e) => tip.show(e, `${val(n.value, b.unit)}${share(n)}\n${pathOf(n)}`)}
                        onMouseLeave={tip.hide}
                      />
                      <Show when={name}>
                        <text class="rl-in rl-sm" style={onFillStyle(f.c, op)} transform={`rotate(${rot}) translate(${rMid},0) rotate(${flip ? 180 : 0})`} dy="0.35em" text-anchor="middle">{name}</text>
                      </Show>
                    </g>
                  );
                }}
              </For>
              <text class="rl-strong" text-anchor="middle" dy="-0.2em">{fit(root().data.name, ring * 2 - 8, FS, 500)}</text>
              <text class="rl-muted" text-anchor="middle" dy="1.1em">{val(root().value, b.unit)}</text>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<TreeB>({
  type: "sunburst",
  family: "relation",
  title: "선버스트",
  when: "여러 단계로 나뉜 전체에서 각 갈래가 얼마나 차지하나",
  render: (b) => <Safe label={b.label}><Sunburst {...b} /></Safe>,
  examples: [
    {
      label: "고객 문의 유형",
      unit: "건",
      root: {
        label: "전체 문의",
        children: [
          { label: "결제", children: [{ label: "환불", value: 412 }, { label: "카드 오류", value: 268 }, { label: "영수증", value: 97 }] },
          { label: "계정", children: [{ label: "로그인", value: 355 }, { label: "비밀번호", value: 190 }, { label: "탈퇴", value: 64 }] },
          { label: "배송", children: [{ label: "지연", value: 288 }, { label: "파손", value: 121 }, { label: "주소 변경", value: 85 }] },
          { label: "기타", children: [{ label: "제휴", value: 40 }, { label: "칭찬", value: 33 }] },
        ],
      },
    },
  ],
});

// ───────────── icicle
function Icicle(b: TreeB) {
  const root = createMemo(() => sized(toTree(b)));
  const tip = useTip();
  return (
    <Show when={(root().value ?? 0) > 0} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={Math.round(Math.max(200, Math.min(460, root().leaves().length * 24)))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={hasEm(root()) ? undefined : branchLegend(root())} alt={b.label}>
        {(box) => {
          const depth = Math.max(1, root().height);
          const p = partition<TNode>().size([box.h, depth + 1]).padding(0)(root().copy());
          // the root is a thin column; every level below gets an equal share of the width
          const rootW = Math.min(64, box.w * 0.14);
          const colW = (box.w - rootW) / depth;
          const xOf = (d: number) => (d === 0 ? 0 : rootW + (d - 1) * colW);
          const wOf = (d: number) => (d === 0 ? rootW : colW);
          return (
            <g>
              <For each={p.descendants().filter((d) => d.x1 - d.x0 >= 1)}>
                {(n) => {
                  const f = n.depth === 0 ? { c: "var(--viz-muted)", slot: 8 } : fillOf(n, root());
                  const x = xOf(n.y0);
                  const w = wOf(n.y0) - 2;
                  const h = n.x1 - n.x0 - 2;
                  const name = h >= 15 && w > 24 ? fit(n.data.name, w - 10, FS_SM, 500) : "";
                  const v = val(n.value, b.unit);
                  const two = name && h >= 32 && tw(v, FS_SM) <= w - 10;
                  const op = n.depth <= 1 ? 1 : n.depth === 2 ? 0.82 : 0.66;
                  return (
                    <g>
                      <rect
                        class="viz-mark"
                        x={x} y={n.x0} width={Math.max(0, w)} height={Math.max(0.5, h)} rx={2}
                        fill={f.c}
                        fill-opacity={op}
                        onMouseMove={(e) => tip.show(e, `${v}${share(n)}\n${pathOf(n)}`)}
                        onMouseLeave={tip.hide}
                      />
                      <Show when={name}>
                        <text class="rl-in rl-sm" style={onFillStyle(f.c, op)} x={x + 5} y={n.x0 + (two ? 13 : h / 2 + 1)} dy={two ? 0 : "0.35em"}>
                          <tspan font-weight="500">{name}</tspan>
                          <Show when={two}><tspan x={x + 5} dy="1.25em">{v}</tspan></Show>
                        </text>
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

defineViz<TreeB>({
  type: "icicle",
  family: "relation",
  title: "아이시클",
  when: "단계별로 나뉜 구성을 위에서 아래로 쪼개 읽으려면",
  render: (b) => <Safe label={b.label}><Icicle {...b} /></Safe>,
  examples: [
    {
      label: "번들 크기 (gzip 전, KB)",
      unit: "KB",
      items: [
        { path: "app/ui/chat", value: 182 }, { path: "app/ui/viz", value: 146 }, { path: "app/ui/settings", value: 54 },
        { path: "app/state", value: 71 }, { path: "vendor/solid-js", value: 38 }, { path: "vendor/d3", value: 112 },
        { path: "vendor/markdown", value: 96 }, { path: "vendor/highlight", value: 128 }, { path: "assets/fonts", value: 240 }, { path: "assets/icons", value: 31 },
      ],
    },
  ],
});

// ───────────── circle packing
function Pack(b: TreeB) {
  const root = createMemo(() => sized(toTree(b)));
  const tip = useTip();
  return (
    <Show when={(root().value ?? 0) > 0} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.min(w, 480))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={hasEm(root()) ? undefined : branchLegend(root())} alt={b.label}>
        {(box) => {
          const s = Math.min(box.w, box.h);
          const p = pack<TNode>().size([s, s]).padding((d) => (d.depth === 0 ? 4 : 3))(root().copy());
          const ox = (box.w - s) / 2;
          const all = p.descendants();
          const leaves = all.filter((d) => !d.children);
          const parents = all.filter((d) => d.children && d.depth > 0);
          // leaf labels first, then group names along the top of their circle where free
          const labels = [
            ...leaves.map((n) => {
              const name = n.r >= 14 ? fit(n.data.name, n.r * 1.7, FS_SM, 500) : "";
              const two = name && n.r >= 24;
              const w = tw(name, FS_SM, 500);
              return { n, name, two, group: false, x: n.x + ox, y: n.y, rect: { x: n.x + ox - w / 2, y: n.y - (two ? 12 : 7), w, h: two ? 26 : 14, rank: n.r } };
            }),
            ...parents.map((n) => {
              const name = n.r >= 30 ? fit(n.data.name, n.r * 1.2, FS_SM, 600) : "";
              const w = tw(name, FS_SM, 600);
              return { n, name, two: false, group: true, x: n.x + ox, y: n.y - n.r + 12, rect: { x: n.x + ox - w / 2, y: n.y - n.r + 5, w, h: 14, rank: 1e6 + n.r } };
            }),
          ].filter((l) => l.name);
          const keep = declutter(labels.map((l) => l.rect), 1);
          return (
            <g>
              <For each={parents}>
                {(n) => <circle class="rl-pack-parent" cx={n.x + ox} cy={n.y} r={n.r} onMouseMove={(e) => tip.show(e, `${val(n.value, b.unit)}${share(n)}\n${pathOf(n)}`)} onMouseLeave={tip.hide} />}
              </For>
              <For each={leaves}>
                {(n) => {
                  const f = fillOf(n, root());
                  return <circle class="viz-mark" cx={n.x + ox} cy={n.y} r={Math.max(0.5, n.r)} fill={f.c} onMouseMove={(e) => tip.show(e, `${val(n.value, b.unit)}${share(n)}\n${pathOf(n)}`)} onMouseLeave={tip.hide} />;
                }}
              </For>
              <For each={labels.filter((_, i) => keep.has(i))}>
                {(l) =>
                  l.group ? (
                    <text class="rl-head rl-halo" x={l.x} y={l.y} dy="0.35em" text-anchor="middle">{l.name}</text>
                  ) : (
                    <text class="rl-in rl-sm" style={onFillStyle(fillOf(l.n, root()).c)} x={l.x} y={l.y + (l.two ? -6 : 0)} dy="0.35em" text-anchor="middle">
                      <tspan font-weight="500">{l.name}</tspan>
                      <Show when={l.two}><tspan x={l.x} dy="1.2em">{val(l.n.value, b.unit)}</tspan></Show>
                    </text>
                  )
                }
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<TreeB>({
  type: "pack",
  family: "relation",
  title: "원 묶음",
  when: "묶음 안에 어떤 항목이 얼마만큼 들어 있나 (대략적 크기)",
  render: (b) => <Safe label={b.label}><Pack {...b} /></Safe>,
  examples: [
    {
      label: "언어별 코드 줄 수",
      unit: "줄",
      items: [
        { label: "프론트엔드", children: [{ label: "TypeScript", value: 48200 }, { label: "TSX", value: 31800 }, { label: "CSS", value: 9400 }] },
        { label: "네이티브", children: [{ label: "Rust", value: 39600 }, { label: "Swift", value: 6100 }] },
        { label: "도구", children: [{ label: "Shell", value: 2900 }, { label: "Python", value: 4100 }, { label: "Markdown", value: 7800 }] },
      ],
    },
  ],
});

// ───────────── dendrogram (linear / radial) and trees
function colorOfBranch(n: HierarchyNode<TNode>, root: HierarchyNode<TNode>) {
  if (hasEm(root)) return n.ancestors().some((a) => a.data.em) ? series(0) : "var(--rl-edge)";
  const k = root.children?.length ?? 0;
  return k > 1 && k <= 8 && n.depth > 0 ? series(branchOf(n)) : "var(--rl-edge)";
}

function Dendrogram(b: TreeB & { kind: "dendrogram" | "tidytree" | "radialtree" }) {
  const tr = createMemo(() => sized(toTree(b)));
  const tip = useTip();
  const radial = () => b.kind === "radialtree" || (b.kind === "dendrogram" && !!b.radial);
  const leafW = () => Math.min(120, Math.max(...tr().leaves().map((l) => tw(l.data.name, FS_SM))) + 8);
  const ROW = 20;
  const heightOf = (w: number) => (radial() ? Math.round(Math.min(w, 600)) : Math.max(120, tr().leaves().length * ROW + 12));
  return (
    <Show when={tr().descendants().length > 1} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={heightOf} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={hasEm(tr()) ? undefined : branchLegend(tr())} alt={b.label}>
        {(box) => {
          const root = tr().copy();
          const isCluster = b.kind === "dendrogram";
          const heights = root.descendants().some((d) => d.data.height !== undefined);
          if (radial()) {
            const R = Math.max(50, Math.min(box.w, box.h) / 2 - leafW() - 4);
            const lay = (isCluster ? cluster<TNode>() : tree<TNode>()).size([2 * Math.PI, R]).separation((a, c) => (a.parent === c.parent ? 1 : 2) / Math.max(1, a.depth));
            const r = lay(root);
            const maxH = Math.max(1e-9, ...r.descendants().map((d) => d.data.height ?? 0));
            if (isCluster && heights) for (const d of r.descendants()) d.y = R * (1 - (d.data.height ?? 0) / maxH);
            const pt = (a: number, rr: number) => [Math.sin(a) * rr, -Math.cos(a) * rr];
            const link = (s: any, d: any) => {
              if (isCluster) {
                // radial elbow: along the parent's ring, then out
                const [x0, y0] = pt(s.x, s.y);
                const [x1, y1] = pt(d.x, s.y);
                const [x2, y2] = pt(d.x, d.y);
                const sweep = d.x > s.x ? 1 : 0;
                return `M${x0},${y0}A${s.y},${s.y} 0 0,${sweep} ${x1},${y1}L${x2},${y2}`;
              }
              const [x0, y0] = pt(s.x, s.y);
              const [x2, y2] = pt(d.x, d.y);
              const [c1x, c1y] = pt(s.x, (s.y + d.y) / 2);
              const [c2x, c2y] = pt(d.x, (s.y + d.y) / 2);
              return `M${x0},${y0}C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
            };
            const leaves = r.leaves();
            const step = (2 * Math.PI * R) / Math.max(1, leaves.length);
            return (
              <g transform={`translate(${box.w / 2},${box.h / 2})`}>
                <For each={r.links()}>{(l) => <path class="rl-tlink" classList={{ em: !!l.target.data.em }} d={link(l.source, l.target)} style={{ stroke: colorOfBranch(l.target, r) }} />}</For>
                <For each={r.descendants()}>
                  {(d) => {
                    const [x, y] = pt(d.x, d.y);
                    const deg = (d.x * 180) / Math.PI - 90;
                    const flip = d.x > Math.PI;
                    return (
                      <g>
                        <circle cx={x} cy={y} r={d.children ? 2 : 2.5} fill={d.children ? "var(--rl-edge)" : colorOfBranch(d, r)} onMouseMove={(e) => tip.show(e, `${d.value !== undefined && !d.children ? val(d.value, b.unit) + "\n" : ""}${pathOf(d)}`)} onMouseLeave={tip.hide} />
                        <Show when={!d.children && step >= 9}>
                          <text class="rl-sm" transform={`rotate(${deg}) translate(${d.y + 6},0)${flip ? " rotate(180)" : ""}`} dy="0.35em" text-anchor={flip ? "end" : "start"}>{fit(d.data.name, leafW() - 8, FS_SM)}</text>
                        </Show>
                      </g>
                    );
                  }}
                </For>
                <Show when={!isCluster}>
                  <text class="rl-strong rl-halo" text-anchor="middle" dy="-0.8em">{fit(r.data.name, 120, FS, 500)}</text>
                </Show>
              </g>
            );
          }
          // linear, left → right
          const rootW = isCluster ? 4 : Math.min(90, tw(root.data.name, FS, 500) + 10);
          const innerW = Math.max(40, box.w - leafW() - rootW - 8);
          const lay = (isCluster ? cluster<TNode>() : tree<TNode>()).size([box.h - 12, innerW]);
          const r = lay(root);
          const maxH = Math.max(1e-9, ...r.descendants().map((d) => d.data.height ?? 0));
          if (isCluster && heights) for (const d of r.descendants()) d.y = innerW * (1 - (d.data.height ?? 0) / maxH);
          const X = (d: any) => rootW + d.y;
          const Y = (d: any) => d.x + 6;
          const curve = linkHorizontal<any, any>().x((d) => X(d)).y((d) => Y(d));
          const depthGap = innerW / Math.max(1, r.height);
          // internal labels (tidy tree) sit above-left of their dot, kept apart
          const inner = isCluster ? [] : r.descendants().filter((d) => d.children && d.depth > 0).map((d) => {
            const name = fit(d.data.name, depthGap - 10, FS_SM, 500);
            const w = tw(name, FS_SM, 500);
            return { d, name, rect: { x: X(d) - 5 - w, y: Y(d) - 15, w, h: 13, rank: d.value ?? 0 } };
          });
          const keep = declutter(inner.map((i) => i.rect), 1);
          return (
            <g>
              <For each={r.links()}>
                {(l) => (
                  <path
                    class="rl-tlink"
                    classList={{ em: !!l.target.data.em }}
                    d={isCluster ? `M${X(l.source)},${Y(l.source)}V${Y(l.target)}H${X(l.target)}` : curve({ source: l.source, target: l.target }) ?? ""}
                    style={{ stroke: colorOfBranch(l.target, r) }}
                  />
                )}
              </For>
              <For each={r.descendants()}>
                {(d) => (
                  <circle cx={X(d)} cy={Y(d)} r={d.children ? (isCluster ? 0 : 2.5) : 3} fill={d.children ? "var(--rl-edge)" : colorOfBranch(d, r)} class="rl-ring" onMouseMove={(e) => tip.show(e, `${!d.children && d.data.value !== undefined ? val(d.value, b.unit) + "\n" : ""}${pathOf(d)}${d.data.note ? `\n${d.data.note}` : ""}`)} onMouseLeave={tip.hide} />
                )}
              </For>
              <For each={r.leaves()}>{(d) => <text class="rl-sm" classList={{ "rl-strong": !!d.data.em }} x={X(d) + 7} y={Y(d)} dy="0.35em">{fit(d.data.name, leafW() - 6, FS_SM)}</text>}</For>
              <For each={inner.filter((_, i) => keep.has(i))}>{(i) => <text class="rl-sm rl-strong rl-halo" x={X(i.d) - 5} y={Y(i.d) - 8} text-anchor="end">{i.name}</text>}</For>
              <Show when={!isCluster}>
                <text class="rl-strong" x={X(r) - 6} y={Y(r)} dy="0.35em" text-anchor="end">{fit(r.data.name, rootW - 8, FS, 500)}</text>
              </Show>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

const CLUSTERS: TreeB = {
  label: "고객 세그먼트 군집 (와드 연결)",
  root: {
    label: "전체", height: 9.2,
    children: [
      { label: "충성 고객", height: 4.1, children: [
        { label: "고빈도 소액", height: 1.6, children: [{ label: "출근길 구매" }, { label: "점심 정기" }] },
        { label: "저빈도 고액", height: 2.2, children: [{ label: "주말 대량" }, { label: "명절 선물" }, { label: "법인 구매" }] },
      ] },
      { label: "이탈 위험", height: 5.3, children: [
        { label: "쿠폰 반응", height: 1.9, children: [{ label: "할인 때만" }, { label: "첫 구매 후 휴면" }] },
        { label: "불만 경험", height: 2.7, children: [{ label: "배송 불만" }, { label: "환불 경험" }, { label: "문의 미해결" }] },
      ] },
      { label: "신규", height: 3.0, children: [{ label: "앱 설치만" }, { label: "장바구니 이탈" }, { label: "가입 7일 내" }] },
    ],
  },
};
const ORG_TREE: TreeB = {
  label: "서비스 기능 구조",
  root: {
    label: "온드라",
    children: [
      { label: "채팅", children: [{ label: "블록 렌더링" }, { label: "첨부 파일" }, { label: "음성 입력" }] },
      { label: "에이전트", children: [{ label: "도구 호출" }, { label: "스킬" }, { label: "메모리" }, { label: "권한 확인" }] },
      { label: "작업 공간", children: [{ label: "워크트리" }, { label: "터미널" }] },
      { label: "설정", children: [{ label: "계정" }, { label: "단축키" }, { label: "테마" }] },
    ],
  },
};

defineViz<TreeB>({
  type: "dendrogram",
  family: "relation",
  title: "덴드로그램",
  when: "항목들이 얼마나 비슷해서 어떤 순서로 묶이나 (radial: true면 원형)",
  render: (b) => <Safe label={b.label}><Dendrogram {...b} kind="dendrogram" /></Safe>,
  examples: [CLUSTERS, { ...CLUSTERS, label: "고객 세그먼트 군집 (원형)", radial: true }],
});
defineViz<TreeB>({
  type: "tidytree",
  family: "relation",
  title: "트리 다이어그램",
  when: "무엇이 무엇 아래에 속하는지 단계별로",
  render: (b) => <Safe label={b.label}><Dendrogram {...b} kind="tidytree" /></Safe>,
  examples: [ORG_TREE],
});
defineViz<TreeB>({
  type: "radialtree",
  family: "relation",
  title: "방사형 트리",
  when: "가지가 많은 계층을 한 화면에 둥글게 펼쳐 보려면",
  render: (b) => <Safe label={b.label}><Dendrogram {...b} kind="radialtree" /></Safe>,
  examples: [ORG_TREE],
});

// ───────────── org chart
interface OrgB extends TreeB { depth?: number }

function OrgChart(b: OrgB) {
  const tr = createMemo(() => toTree(b, t("조직")));
  const roles = createMemo(() => JSON.stringify(tr()).includes('"role"'));
  const [flip, setFlip] = createSignal(new Map<string, boolean>());
  const tip = useTip();
  const def = () => Math.max(1, Math.min(6, b.depth ?? 2));
  const open = (id: string, depth: number) => flip().get(id) ?? depth < def();
  const toggle = (id: string, depth: number) => setFlip((m) => new Map(m).set(id, !open(id, depth)));
  const BH = () => (roles() ? 44 : 30);
  const layoutFor = (w: number) => {
    const wide = orgLayout(tr(), open, false);
    if (wide.cols * 112 <= w) return { ...wide, indent: false };
    const compact = orgLayout(tr(), open, true);
    if (compact.cols * 104 <= w) return { ...compact, indent: false };
    return { ...orgIndented(tr(), open), cols: 1, indent: true };
  };
  return (
    <Frame label={b.label} class="rl" height={(w) => { const L = layoutFor(w); return Math.round(L.indent ? L.rows * (BH() + 8) + 4 : L.rows * BH() + 8); }} margin={{ t: 0, r: 0, b: 0, l: 0 }} alt={b.label}>
      {(box) => {
        const L = layoutFor(box.w);
        // one box-unit in px (boxes are 1 wide, gaps 0.25); never wider than 176
        const IND = 18;
        const deepest = Math.max(0, ...L.boxes.map((x) => x.depth));
        const bw = L.indent ? Math.min(300, box.w - 2 - deepest * IND) : Math.min(176, box.w / Math.max(1, L.cols));
        const ox = L.indent ? 1 : Math.max(0, (box.w - L.cols * bw) / 2);
        const bh = BH();
        const X = (x: number) => (L.indent ? ox + x * IND : ox + x * bw);
        const Y = (y: number) => (L.indent ? 2 + y * (bh + 8) : 4 + y * bh);
        const at = new Map(L.boxes.map((x) => [x.id, x]));
        return (
          <g>
            <For each={L.links}>
              {([pa, ch]) => {
                const p = at.get(pa)!;
                const c = at.get(ch)!;
                if (L.indent) {
                  const rx = X(p.x) + 9;
                  return <path class="rl-tlink" d={`M${rx},${Y(p.y) + bh}V${Y(c.y) + bh / 2}H${X(c.x)}`} />;
                }
                if (p.stacked) {
                  const rx = X(p.x) + 8;
                  return <path class="rl-tlink" d={`M${rx},${Y(p.y) + bh}V${Y(c.y) + bh / 2}H${X(c.x)}`} />;
                }
                const px = X(p.x) + bw / 2;
                const cx = X(c.x) + bw / 2;
                const mid = (Y(p.y) + bh + Y(c.y)) / 2;
                return <path class="rl-tlink" d={`M${px},${Y(p.y) + bh}V${mid}H${cx}V${Y(c.y)}`} />;
              }}
            </For>
            <For each={L.boxes}>
              {(x) => {
                const can = !!x.node.children?.length;
                const w = bw;
                return (
                  <g onClick={() => can && toggle(x.id, x.depth)} onMouseMove={(e) => x.node.note && tip.show(e, x.node.note)} onMouseLeave={tip.hide}>
                    <rect class="rl-box" classList={{ tap: can, em: !!x.node.em }} x={X(x.x)} y={Y(x.y)} width={w} height={bh} rx={6} />
                    <text class="rl-strong" x={X(x.x) + 9} y={Y(x.y) + (roles() ? 17 : bh / 2)} dy={roles() ? 0 : "0.35em"}>{fit(x.node.name, w - (x.hidden ? 40 : 18), FS, 500)}</text>
                    <Show when={roles() && x.node.role}>
                      <text class="rl-muted" x={X(x.x) + 9} y={Y(x.y) + 33}>{fit(x.node.role!, w - (x.hidden ? 40 : 18), FS_SM)}</text>
                    </Show>
                    <Show when={x.hidden}>
                      <rect class="rl-badge" x={X(x.x) + w - 30} y={Y(x.y) + bh / 2 - 9} width={24} height={18} rx={9} />
                      <text class="rl-badge-t" x={X(x.x) + w - 18} y={Y(x.y) + bh / 2} dy="0.35em" text-anchor="middle">+{x.hidden}</text>
                    </Show>
                  </g>
                );
              }}
            </For>
          </g>
        );
      }}
    </Frame>
  );
}

defineViz<OrgB>({
  type: "orgchart",
  family: "relation",
  title: "조직도",
  when: "누가 누구 아래에서 어떤 역할을 맡나 (상자를 눌러 접고 펼침)",
  render: (b) => <Safe label={b.label}><OrgChart {...b} /></Safe>,
  examples: [
    {
      label: "제품 개발본부",
      depth: 2,
      root: {
        label: "김지현", role: "본부장",
        children: [
          { label: "박서준", role: "프론트엔드 리드", children: [{ label: "이하은", role: "시니어 엔지니어" }, { label: "최도윤", role: "엔지니어" }, { label: "정예린", role: "엔지니어" }] },
          { label: "윤민재", role: "백엔드 리드", children: [{ label: "한지우", role: "시니어 엔지니어" }, { label: "오세훈", role: "엔지니어" }] },
          { label: "강수아", role: "디자인 리드", children: [{ label: "임채원", role: "프로덕트 디자이너" }, { label: "송다인", role: "UX 리서처" }] },
          { label: "조현우", role: "QA 매니저", children: [{ label: "배유진", role: "QA 엔지니어" }] },
        ],
      },
    },
  ],
});

// ───────────── mind map
function MindMap(b: TreeB) {
  const tr = createMemo(() => toTree(b, b.label ?? t("주제|root")));
  const tip = useTip();
  const ROW = 26;
  // the width a side needs: the widest label at each depth
  const depthW = (nodes: TNode[], depth = 1, acc: number[] = []): number[] => {
    for (const n of nodes) {
      acc[depth] = Math.max(acc[depth] ?? 0, Math.min(150, tw(n.name, depth === 1 ? FS : FS_SM, depth === 1 ? 500 : 400) + 22));
      if (n.children?.length) depthW(n.children, depth + 1, acc);
    }
    return acc;
  };
  const plan = (w: number) => {
    const kids = tr().children ?? [];
    const leaves = (n: TNode): number => (n.children?.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1);
    const centerW = Math.min(150, tw(tr().name, FS, 600) + 28);
    const need = (ns: TNode[]) => depthW(ns).reduce((a, x) => a + (x ?? 0), 0);
    const split = balance(kids.map(leaves));
    const right = split.right.map((i) => ({ n: kids[i], i }));
    const left = split.left.map((i) => ({ n: kids[i], i }));
    const both = centerW + need(right.map((r) => r.n)) + need(left.map((l) => l.n)) + 16 <= w;
    const R = both ? right : [...right, ...[...left].reverse()];
    const Lf = both ? left : [];
    const rows = Math.max(R.reduce((s, x) => s + leaves(x.n), 0), Lf.reduce((s, x) => s + leaves(x.n), 0), 1);
    return { both, R, L: Lf, centerW, rows };
  };
  return (
    <Show when={(tr().children?.length ?? 0) > 0} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => plan(w).rows * ROW + 16} margin={{ t: 0, r: 0, b: 0, l: 0 }} alt={b.label}>
        {(box) => {
          const p = plan(box.w);
          const H = box.h - 16;
          type P = { n: TNode; x: number; y: number; depth: number; slot: number; side: 1 | -1; w: number; parent?: P };
          const out: P[] = [];
          const sideW = (box.w - p.centerW) / (p.both ? 2 : 1);
          const layoutSide = (items: { n: TNode; i: number }[], side: 1 | -1) => {
            const dw = depthW(items.map((x) => x.n));
            const total = dw.reduce((a, x) => a + (x ?? 0), 0);
            const k = Math.min(1, (sideW - 8) / Math.max(1, total));
            const leaves = (n: TNode): number => (n.children?.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1);
            const rowsHere = items.reduce((s, x) => s + leaves(x.n), 0);
            let y = 8 + (H - rowsHere * ROW) / 2;
            const cx = box.w / 2 + (p.both ? 0 : -box.w / 2 + p.centerW / 2 + 4);
            const startX = cx + (side * p.centerW) / 2;
            const walk = (n: TNode, depth: number, x0: number, slot: number, parent?: P): P => {
              const w = (dw[depth] ?? 60) * k;
              const me: P = { n, x: x0, y: 0, depth, slot, side, w, parent };
              out.push(me);
              if (n.children?.length) {
                const kids = n.children.map((c) => walk(c, depth + 1, x0 + side * w, slot, me));
                me.y = (kids[0].y + kids[kids.length - 1].y) / 2;
              } else {
                me.y = y + ROW / 2;
                y += ROW;
              }
              return me;
            };
            for (const it of items) walk(it.n, 1, startX, Math.min(it.i, 8), undefined);
          };
          layoutSide(p.R, 1);
          if (p.both) layoutSide(p.L, -1);
          const cx = p.both ? box.w / 2 : p.centerW / 2 + 4;
          const cy = 8 + H / 2;
          const color = (s: number) => series(s);
          const tail = (q: P) => [q.x + q.side * (q.w - 10), q.y] as const;
          const head = (q: P) => [q.x, q.y] as const;
          return (
            <g>
              <For each={out}>
                {(q) => {
                  const [x0, y0] = q.parent ? tail(q.parent) : [cx + (q.side * p.centerW) / 2 - q.side * 2, cy];
                  const [x1, y1] = head(q);
                  const mx = (x0 + x1) / 2;
                  const sw = q.depth === 1 ? 2.2 : q.depth === 2 ? 1.5 : 1.1;
                  return (
                    <>
                      <path class="rl-mm-link" d={`M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}`} stroke={color(q.slot)} stroke-width={sw} fill="none" />
                      <line x1={x1} y1={y1} x2={tail(q)[0]} y2={y1} stroke={color(q.slot)} stroke-width={sw} />
                    </>
                  );
                }}
              </For>
              <For each={out}>
                {(q) => {
                  const size = q.depth === 1 ? FS : FS_SM;
                  const name = fit(q.n.name, q.w - 16, size, q.depth === 1 ? 500 : 400);
                  const x = q.side > 0 ? q.x + 4 : q.x - 4;
                  return (
                    <text class={q.depth === 1 ? "rl-strong" : "rl-sm"} x={x} y={q.y - 5} text-anchor={q.side > 0 ? "start" : "end"} onMouseMove={(e) => q.n.note && tip.show(e, q.n.note)} onMouseLeave={tip.hide}>
                      {name}
                    </text>
                  );
                }}
              </For>
              <rect class="rl-box" x={cx - p.centerW / 2} y={cy - 17} width={p.centerW} height={34} rx={17} />
              <text class="rl-strong" x={cx} y={cy} dy="0.35em" text-anchor="middle" font-weight="600">{fit(tr().name, p.centerW - 20, FS, 600)}</text>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<TreeB>({
  type: "mindmap",
  family: "relation",
  title: "마인드맵",
  when: "한 주제에서 갈라져 나온 생각을 한눈에 정리하려면",
  render: (b) => <Safe label={b.label}><MindMap {...b} /></Safe>,
  examples: [
    {
      label: "신규 기능 아이디어",
      root: {
        label: "오프라인 모드",
        children: [
          { label: "동기화", children: [{ label: "충돌 해결" }, { label: "변경 큐" }, { label: "재시도 정책" }] },
          { label: "저장소", children: [{ label: "SQLite 캐시" }, { label: "용량 한도" }] },
          { label: "사용자 경험", children: [{ label: "상태 표시" }, { label: "읽기 전용 화면" }, { label: "알림 문구" }] },
          { label: "보안", children: [{ label: "로컬 암호화" }, { label: "세션 만료" }] },
          { label: "측정", children: [{ label: "오프라인 시간" }, { label: "동기화 실패율" }] },
        ],
      },
    },
  ],
});
