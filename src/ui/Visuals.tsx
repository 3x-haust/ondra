// Pictures for what agents explain, one per kind of question (after Dan Roam's
// "six ways of seeing" and Napkin's "match the visual to the intent"):
//   what's in / out of scope → scope      how much → bars
//   where things are         → tree       what it's made of → groups
//   who talks to whom        → sequence   in what order → steps
// The diagram block (Diagram.tsx) stays for branching flows.
// Same reading rules as Charts.tsx: a state is a color AND a word, "off" (there but
// not used) is dimmed with its reason on the same row, lines carry their verb.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { previewFile } from "../state/ui";
import { textW } from "./Charts";
import { Icon } from "./Icon";

type Item = { label: string; note?: string; state?: "new" | "changed" | "gone" | "done" | "now" | "todo" | "off"; ref?: string };

const openCode = (ref?: string) => ref && /^[/~]/.test(ref) && previewFile(ref);
/** a code location ("to", because "ref" is reserved in Solid) */
const Ref = (p: { to?: string }) => (
  <Show when={p.to}>
    <button class="vz-ref" title="앱에서 열기" onClick={() => openCode(p.to)}>{p.to!.split("/").slice(-2).join("/")}</button>
  </Show>
);
const Label = (p: { text?: string }) => <Show when={p.text}><div class="blk-label">{p.text}</div></Show>;
const TAG: Partial<Record<NonNullable<Item["state"]>, string>> = { new: "새로", changed: "바뀜", gone: "없앰", off: "안 씀" };
const Tag = (p: { state?: Item["state"] }) => (
  <Show when={p.state && TAG[p.state]}>
    <span class={`dg-tag vz-tag s-${p.state}`}>{TAG[p.state!]}</span>
  </Show>
);

const ScopeItem = (p: { i: Item }) => (
  <div class={`vz-scope-item s-${p.i.state ?? "none"}`}>
    <div class="vz-scope-top"><b>{p.i.label}</b><Tag state={p.i.state} /></div>
    <Show when={p.i.note}><span>{p.i.note}</span></Show>
  </div>
);

/** 하는 것 / 안 하는 것: the boundary of a piece of work at a glance. */
export function Scope(props: { label?: string; in?: Item[]; out?: Item[] }) {
  return (
    <div class="blk vz-scope">
      <Label text={props.label} />
      <div class="vz-scope-cols">
        <div class="vz-scope-col in">
          <div class="vz-scope-head"><Icon name="check" size={12} stroke={3} />하는 것</div>
          <For each={props.in ?? []}>{(i) => <ScopeItem i={i} />}</For>
        </div>
        <div class="vz-scope-col out">
          <div class="vz-scope-head"><Icon name="x" size={12} stroke={3} />안 하는 것</div>
          <For each={props.out ?? []}>{(i) => <ScopeItem i={i} />}</For>
        </div>
      </div>
    </div>
  );
}

const fmt = (v: number, unit = "") => `${v >= 100 ? Math.round(v).toLocaleString() : +v.toFixed(1)}${unit}`;

/** How much: sorted horizontal bars with share of the total. */
export function Bars(props: { label?: string; unit?: string; items: { label: string; value: number; note?: string; highlight?: boolean }[]; total?: number }) {
  const items = () => [...props.items].filter((i) => typeof i.value === "number").sort((a, b) => b.value - a.value);
  const max = () => Math.max(...items().map((i) => i.value), 1);
  const total = () => props.total ?? items().reduce((n, i) => n + i.value, 0);
  return (
    <div class="blk vz-bars">
      <div class="vz-bars-head">
        <Label text={props.label} />
        <span class="vz-total">합계 {fmt(total(), props.unit)}</span>
      </div>
      <For each={items()}>
        {(i) => (
          <div class="vz-bar" classList={{ hi: i.highlight }}>
            <span class="vz-bar-label" title={i.note}>{i.label}<Show when={i.note}><em>{i.note}</em></Show></span>
            <span class="vz-bar-track"><i style={{ width: `${(i.value / max()) * 100}%` }} /></span>
            <span class="vz-bar-v">{fmt(i.value, props.unit)}</span>
            <span class="vz-bar-pct">{total() ? Math.round((i.value / total()) * 100) : 0}%</span>
          </div>
        )}
      </For>
    </div>
  );
}

type Node = { name: string; note?: string; value?: number; state?: Item["state"]; kids: Node[] };
/** every item under a folder is "off": nothing there is used, so it starts folded */
const allOff = (n: Node): boolean => (n.kids.length ? n.kids.every(allOff) : n.state === "off");
const count = (n: Node): number => (n.kids.length ? n.kids.reduce((a, k) => a + count(k), 0) : 1);
/**
 * Where things are: paths as an indented tree with guide lines; each row says
 * what the file is for on the same line. Used rows read strong, "off" rows are
 * dimmed with their reason, folders where nothing is used start folded.
 */
export function Tree(props: { label?: string; unit?: string; items: { path: string; note?: string; value?: number; state?: Item["state"] }[] }) {
  const root = createMemo(() => {
    const top: Node = { name: "", kids: [] };
    for (const it of props.items) {
      let cur = top;
      const parts = it.path.split("/").filter(Boolean);
      parts.forEach((p, i) => {
        let next = cur.kids.find((k) => k.name === p);
        if (!next) cur.kids.push((next = { name: p, kids: [] }));
        if (i === parts.length - 1) Object.assign(next, { note: it.note, value: it.value, state: it.state });
        cur = next;
      });
    }
    // "~ › 01_Project › 01_Projects" with nothing said about the middle → one row
    const squash = (n: Node): Node => {
      n.kids = n.kids.map(squash);
      while (n.name && n.kids.length === 1 && n.note === undefined && n.value === undefined && n.state === undefined) {
        const k = n.kids[0];
        n = { ...k, name: `${n.name}/${k.name}`, kids: k.kids };
      }
      return n;
    };
    top.kids = top.kids.map(squash);
    return top;
  });
  const max = () => Math.max(...props.items.map((i) => i.value ?? 0), 1);
  const someUsed = () => props.items.some((i) => i.state !== "off");
  const Row = (p: { n: Node }) => {
    const folder = () => p.n.kids.length > 0;
    const [open, setOpen] = createSignal(!(folder() && someUsed() && allOff(p.n)));
    const off = () => p.n.state === "off" || (folder() && allOff(p.n));
    return (
      <div class="vz-tree-node">
        <div
          class={`vz-tree-row s-${p.n.state ?? "none"}`}
          classList={{ off: off(), folder: folder() }}
          onClick={() => folder() && setOpen(!open())}
          role={folder() ? "button" : undefined}
          aria-expanded={folder() ? open() : undefined}
        >
          <Show when={folder()} fallback={<Icon name={/\.[a-z0-9]{1,6}$/i.test(p.n.name) ? "file" : "folder"} size={14} class="vz-tree-ic" />}>
            <Icon name="chevron" size={12} class={`vz-tree-chev${open() ? " open" : ""}`} />
          </Show>
          <span class="vz-tree-name" classList={{ gone: p.n.state === "gone" }}>{p.n.name}{folder() ? "/" : ""}</span>
          <Tag state={p.n.state} />
          <Show when={p.n.note}><span class="vz-tree-note">{p.n.note}</span></Show>
          <Show when={folder() && !open()}><span class="vz-tree-more">{count(p.n)}개</span></Show>
          <span class="spacer" />
          <Show when={p.n.value !== undefined}>
            <span class="vz-tree-bar"><i style={{ width: `${((p.n.value ?? 0) / max()) * 100}%` }} /></span>
            <span class="vz-tree-v">{fmt(p.n.value!, props.unit)}</span>
          </Show>
        </div>
        <Show when={folder()}>
          <div class="vz-tree-kids" classList={{ shut: !open() }}>
            <div>
              <For each={p.n.kids}>{(k) => <Row n={k} />}</For>
            </div>
          </div>
        </Show>
      </div>
    );
  };
  return (
    <div class="blk vz-tree">
      <Label text={props.label} />
      <div class="vz-tree-body">
        <For each={root().kids}>{(k) => <Row n={k} />}</For>
      </div>
    </div>
  );
}

/**
 * What it's made of: zones side by side, each holding its parts. Links between
 * parts are drawn as arrows from part to part (what feeds what), so the picture
 * says it without a sentence; only links that don't name a part stay as text.
 */
export function Groups(props: { label?: string; groups: { label: string; note?: string; items: Item[] }[]; links?: { from: string; to: string; label?: string }[] }) {
  let box!: HTMLDivElement;
  const zones = new Map<string, HTMLElement>();
  const parts = new Map<string, HTMLElement>();
  const key = (s: string) => s.trim().toLowerCase();
  // "앱" finds "앱 (Tauri)": exact name first, then a name that starts with it, then one
  // that has it; groups before items, so "엔진" is the group, not the item "엔진 실행"
  const look = (m: Map<string, HTMLElement>, k: string) => {
    if (m.has(k)) return m.get(k);
    const all = [...m.entries()];
    return (all.find(([n]) => n.startsWith(k)) ?? all.find(([n]) => n.includes(k)))?.[1];
  };
  const find = (name: string) => {
    const k = key(name);
    return zones.get(k) ?? parts.get(k) ?? look(zones, k) ?? look(parts, k);
  };
  const LANE = 28;
  const [under, setUnder] = createSignal(0);
  const [paths, setPaths] = createSignal<{ d: string; label?: string; x: number; y: number }[]>([]);
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [drawn, setDrawn] = createSignal(false);
  const measure = () => {
    if (!box) return;
    const b = box.getBoundingClientRect();
    setSize({ w: b.width, h: b.height });
    const out: { d: string; label?: string; x: number; y: number }[] = [];
    const zoneBoxes = [...zones.values()].map((z) => z.getBoundingClientRect());
    const bottom = Math.max(0, ...zoneBoxes.map((z) => z.bottom - b.top));
    let lanes = 0;
    for (const l of props.links ?? []) {
      const a = find(l.from), c = find(l.to);
      if (!a || !c) continue;
      const ra = a.getBoundingClientRect(), rc = c.getBoundingClientRect();
      // something sits between them: go around underneath instead of through it
      const lo = Math.min(ra.right, rc.right), hi = Math.max(ra.left, rc.left);
      const between = zoneBoxes.some((z) => z.left >= lo - 2 && z.right <= hi + 2);
      if (between) {
        const y = bottom + 22 + lanes * LANE;
        lanes++;
        const x1 = ra.left + ra.width / 2 - b.left, y1 = ra.bottom - b.top;
        const x2 = rc.left + rc.width / 2 - b.left, y2 = rc.bottom - b.top;
        out.push({ d: `M${x1},${y1} C${x1},${y} ${x1},${y} ${x1 + Math.sign(x2 - x1) * 14},${y} L${x2 - Math.sign(x2 - x1) * 14},${y} C${x2},${y} ${x2},${y} ${x2},${y2 + 2}`, label: l.label, x: (x1 + x2) / 2, y });
        continue;
      }
      const right = rc.left >= ra.right - 4;
      const x1 = (right ? ra.right : ra.left) - b.left, y1 = ra.top + ra.height / 2 - b.top;
      const x2 = (right ? rc.left : rc.right) - b.left, y2 = rc.top + rc.height / 2 - b.top;
      const dx = Math.max(24, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
      out.push({ d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, label: l.label, x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    }
    setUnder(lanes);
    setPaths(out);
    setDrawn(out.length > 0);
  };
  onMount(() => {
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  // room between zones for the longest verb on a line
  const gap = () => Math.min(160, Math.max(64, ...(props.links ?? []).map((l) => (l.label ? textW(l.label, 12.5, 500) + 30 : 0))));
  const allNew = (g: { items: Item[] }) => g.items.length > 1 && g.items.every((i) => i.state === "new");
  const loose = () => (drawn(), (props.links ?? []).filter((l) => !(find(l.from) && find(l.to))));
  return (
    <div class="blk vz-groups">
      <Label text={props.label} />
      <div class="vz-zones-wrap" ref={box} style={{ "padding-bottom": under() ? `${under() * LANE + 20}px` : undefined }}>
        <div class="vz-zones" classList={{ linked: drawn() }} style={{ "--zones": String(props.groups.length), "--gap": `${gap()}px` }}>
          <For each={props.groups}>
            {(g) => (
              <div class="vz-zone" ref={(el) => zones.set(key(g.label), el)}>
                <div class="vz-zone-head">
                  <b>{g.label}</b>
                  <Show when={allNew(g)}><Tag state="new" /></Show>
                  <Show when={g.note}><span>{g.note}</span></Show>
                </div>
                <For each={g.items}>
                  {(i) => (
                    <div class={`vz-part s-${i.state ?? "none"}`} ref={(el) => parts.set(key(i.label), el)}>
                      <div class="vz-part-top"><span>{i.label}</span><Show when={!allNew(g)}><Tag state={i.state} /></Show></div>
                      <Show when={i.note}><div class="vz-part-note">{i.note}</div></Show>
                      <Ref to={i.ref} />
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <Show when={paths().length}>
          <svg class="vz-wires" width={size().w} height={size().h}>
            <defs>
              <marker id="vz-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M 0 0.5 L 7 4 L 0 7.5" />
              </marker>
            </defs>
            <For each={paths()}>{(p) => <path d={p.d} marker-end="url(#vz-arrow)" />}</For>
          </svg>
          <For each={paths().filter((p) => p.label)}>
            {(p) => <span class="vz-wire-label" style={{ left: `${p.x}px`, top: `${p.y}px` }}>{p.label}</span>}
          </For>
        </Show>
      </div>
      <Show when={loose().length}>
        <div class="vz-links">
          <For each={loose()}>{(l) => <span class="vz-link">{l.from}<Icon name="arrow" size={11} />{l.to}<Show when={l.label}><em>{l.label}</em></Show></span>}</For>
        </div>
      </Show>
    </div>
  );
}

/**
 * Who talks to whom, in order: few columns (the roles), time runs down, each
 * message is a numbered arrow with its verb on it; answers come back dashed.
 */
export function Sequence(props: { label?: string; actors: string[]; steps: { from: string; to: string; label: string; note?: string; em?: boolean }[] }) {
  const col = (a: string) => Math.max(0, props.actors.indexOf(a));
  const W = () => 100 / Math.max(1, props.actors.length);
  const x = (a: string) => `${(col(a) + 0.5) * W()}%`;
  const em = () => props.steps.some((s) => s.em);
  return (
    <div class="blk vz-seq" classList={{ "has-em": em() }}>
      <Label text={props.label} />
      <div class="vz-seq-actors">
        <For each={props.actors}>{(a) => <div class="vz-actor" style={{ width: `${W()}%` }}><span>{a}</span></div>}</For>
      </div>
      <div class="vz-seq-body">
        <For each={props.actors}>{(a) => <span class="vz-life" style={{ left: x(a) }} />}</For>
        <For each={props.steps}>
          {(s, i) => {
            const a = () => col(s.from);
            const b = () => col(s.to);
            const self = () => a() === b();
            const left = () => (Math.min(a(), b()) + 0.5) * W();
            const width = () => (self() ? W() * 0.32 : Math.abs(b() - a()) * W());
            // the words may run a little past a short arrow, never past the next role's middle
            const room = () => (self() ? W() * 0.62 : width() + W() * 0.8);
            const mid = () => (self() ? left() + width() + 1.5 : left() + width() / 2);
            return (
              <div class="vz-msg" classList={{ em: !!s.em, self: self() }}>
                <div class="vz-msg-line" classList={{ back: b() < a(), self: self() }} style={{ left: `${left()}%`, width: `${width()}%` }} />
                <div class="vz-msg-label" classList={{ self: self() }} style={{ left: `${mid()}%`, "max-width": `${room()}%` }}>
                  <b>{i() + 1}</b>
                  <span>{s.label}</span>
                </div>
                <Show when={s.note}>
                  <div class="vz-msg-note" classList={{ self: self() }} style={{ left: `${mid()}%`, "max-width": `${room()}%` }}>{s.note}</div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** In what order: numbered steps on one line, left to right (more than 5: top to bottom). */
export function Steps(props: { label?: string; items: Item[] }) {
  const down = () => props.items.length > 5;
  return (
    <div class="blk vz-steps">
      <Label text={props.label} />
      <ol class="vz-step-list" classList={{ down: down() }} style={{ "--n": String(Math.max(1, props.items.length)) }}>
        <For each={props.items}>
          {(s, i) => (
            <li class={`vz-step s-${s.state ?? "none"}`}>
              <span class="vz-step-n">
                <Show when={s.state === "done"} fallback={i() + 1}><Icon name="check" size={12} stroke={3} /></Show>
              </span>
              <div class="vz-step-body">
                <b>{s.label}</b>
                <Show when={s.note}><span>{s.note}</span></Show>
                <Ref to={s.ref} />
              </div>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}
