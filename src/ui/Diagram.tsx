// The "diagram" block: how something works, as boxes and arrows instead of prose.
// Rows go top to bottom by dependency depth; arrows are drawn after layout so any
// box size works. Each box can point at code (file:line) and say who decided it.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { DiagramNode } from "../state/types";
import { previewFile } from "../state/ui";

type Edge = { from: string; to: string; label?: string };

/** Longest-path depth from the roots; back edges (cycles) are ignored. */
function rows(nodes: DiagramNode[], edges: Edge[]): DiagramNode[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const hasParent = new Set(edges.map((e) => e.to));
  const walk = (id: string, d: number) => {
    if (visiting.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    visiting.add(id);
    for (const n of out.get(id) ?? []) walk(n, d + 1);
    visiting.delete(id);
  };
  for (const n of nodes) if (!hasParent.has(n.id)) walk(n.id, 0);
  for (const n of nodes) if (!depth.has(n.id)) walk(n.id, 0);
  const grid: DiagramNode[][] = [];
  for (const n of nodes) (grid[depth.get(n.id)!] ??= []).push(n);
  return grid.filter(Boolean);
}

/** "src/a.ts:12" → open it; a bare path works too. */
const openCode = (ref: string) => {
  const path = ref.replace(/:\d+(:\d+)?$/, "");
  if (path.startsWith("/") || path.startsWith("~")) previewFile(ref);
};

export function Diagram(props: { label?: string; nodes: DiagramNode[]; edges?: Edge[] }) {
  let box!: HTMLDivElement;
  const edges = () => props.edges ?? [];
  const [paths, setPaths] = createSignal<{ d: string; label?: string; x: number; y: number }[]>([]);
  const [size, setSize] = createSignal({ w: 0, h: 0 });

  const draw = () => {
    const root = box.getBoundingClientRect();
    const at = (id: string) => box.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    setSize({ w: root.width, h: root.height });
    setPaths(
      edges().flatMap((e) => {
        const a = at(e.from);
        const b = at(e.to);
        if (!a || !b) return [];
        const down = b.top >= a.bottom - 2;
        const x1 = a.left + a.width / 2 - root.left;
        const y1 = (down ? a.bottom : a.top + a.height / 2) - root.top;
        const x2 = b.left + b.width / 2 - root.left;
        const y2 = (down ? b.top : b.top + b.height / 2) - root.top;
        const mid = (y1 + y2) / 2;
        const d = down ? `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2 - 3}` : `M${x1} ${y1} L${x2 + (x2 > x1 ? -b.width / 2 : b.width / 2)} ${y2}`;
        return [{ d, label: e.label, x: (x1 + x2) / 2, y: mid }];
      }),
    );
  };

  onMount(() => {
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class="blk blk-diagram">
      <Show when={props.label}><div class="blk-label">{props.label}</div></Show>
      <div class="dg" ref={box}>
        <svg class="dg-lines" width={size().w} height={size().h} aria-hidden="true">
          <defs>
            <marker id="dg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L8 4L0 8z" class="dg-head" />
            </marker>
          </defs>
          <For each={paths()}>
            {(p) => (
              <>
                <path d={p.d} class="dg-line" marker-end="url(#dg-arrow)" />
                <Show when={p.label}><text x={p.x + 6} y={p.y} class="dg-edge-label">{p.label}</text></Show>
              </>
            )}
          </For>
        </svg>
        <For each={rows(props.nodes, edges())}>
          {(row) => (
            <div class="dg-row">
              <For each={row}>
                {(n) => (
                  <div class={`dg-node ${n.state ?? ""}`} data-node={n.id}>
                    <div class="dg-top">
                      <b>{n.label}</b>
                      <Show when={n.state === "new"}><span class="dg-tag new">새로</span></Show>
                      <Show when={n.state === "changed"}><span class="dg-tag changed">바뀜</span></Show>
                      <Show when={n.state === "gone"}><span class="dg-tag">없앰</span></Show>
                      <Show when={n.by}><span class="dg-tag" title={n.by === "user" ? "내가 정한 것" : "AI가 스스로 정한 것"}>{n.by === "user" ? "요청" : "AI 판단"}</span></Show>
                    </div>
                    <Show when={n.note}><div class="dg-note">{n.note}</div></Show>
                    <Show when={n.ref}>
                      <button class="dg-ref" title="편집기에서 열기" onClick={() => openCode(n.ref!)}>{n.ref!.split("/").slice(-2).join("/")}</button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
