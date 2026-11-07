// Maps, all offline (no tiles, no network): world and 시도 choropleths, the 시도
// tile grid, bubble (symbol) maps, dot density, great-circle connections and flow maps.
// Shapes: world-atlas 110m (Natural Earth, public domain) and layout/krSido.ts.
import { createMemo, createResource, For, Show, type JSX } from "solid-js";
import { geoCentroid, geoEqualEarth, geoMercator, geoPath, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import { defineViz } from "../registry";
import { Frame, div, seq, series, useTip } from "../kit";
import { SIDO, SIDO_TILES, classify, countryKo, countryName, dotsIn, flowArc, lonLat, sidoCode } from "./layout/geo";
import { arr, declutter, hash, isObj, toNum, toStr } from "./layout/text";
import { Empty, FS_SM, Ramp, Safe, fit, onFillStyle, tw, val } from "./ui";

type Feat = { type: "Feature"; id?: string; properties: { name?: string; code?: string }; geometry: any };
type MapKind = "world" | "korea";

// ───────────── shapes (loaded once, lazily, from the bundle)
let worldP: Promise<Feat[]> | undefined;
let koreaP: Promise<Feat[]> | undefined;
const loadWorld = () =>
  (worldP ??= import("world-atlas/countries-110m.json").then((m: any) => {
    const topo = m.default ?? m;
    return (feature(topo, topo.objects.countries) as any).features.filter((f: Feat) => f.properties.name !== "Antarctica") as Feat[];
  }));
const loadKorea = () =>
  (koreaP ??= import("./layout/krSido").then((m) => (feature(m.KR_SIDO, m.KR_SIDO.objects.sido) as any).features as Feat[]));
const useShapes = (kind: () => MapKind) => {
  const [r] = createResource(kind, (k) => (k === "korea" ? loadKorea() : loadWorld()));
  return r;
};

/** a projection fitted to the width, and the height the map then needs */
function fitMap(kind: MapKind, feats: Feat[], w: number, maxH: number, opt: { rotate?: number; side?: number } = {}): { proj: GeoProjection; h: number } {
  const fc = { type: "FeatureCollection", features: feats } as any;
  if (kind === "korea") {
    const side = opt.side ?? 0;
    // as tall as the map is at this width (no empty band), within 220..maxH
    const probe = geoMercator().fitWidth(Math.max(40, w - 2 * side - 12), fc);
    const [[, y0], [, y1]] = geoPath(probe).bounds(fc);
    const h = Math.round(Math.max(220, Math.min(maxH, y1 - y0 + 12)));
    return { proj: geoMercator().fitExtent([[6 + side, 6], [w - 6 - side, h - 6]], fc), h };
  }
  const proj = geoEqualEarth().rotate([-(opt.rotate ?? 0), 0]).fitWidth(w - 2, opt.rotate ? ({ type: "Sphere" } as any) : fc);
  const [[, y0], [, y1]] = geoPath(proj).bounds(opt.rotate ? { type: "FeatureCollection", features: feats.filter((f) => !/Antarctic/.test(f.properties.name ?? "")) } as any : fc);
  proj.translate([proj.translate()[0] + 1, proj.translate()[1] - y0 + 2]);
  return { proj, h: Math.ceil(y1 - y0 + 4) };
}

/** where a region's label goes: the centroid of its largest piece (so France sits in Europe) */
function labelAt(path: ReturnType<typeof geoPath>, f: Feat): [number, number] {
  const g = f.geometry;
  if (g?.type !== "MultiPolygon") return path.centroid(f as any) as [number, number];
  let best: any = null;
  let area = -1;
  for (const c of g.coordinates) {
    const piece = { type: "Polygon", coordinates: c } as any;
    const a = path.area(piece);
    if (a > area) (area = a), (best = piece);
  }
  return path.centroid(best) as [number, number];
}

/** which map: given, or Korea when every place is a 시도 / inside Korea's box */
function pickMap(given: unknown, places: { region?: string; ll?: [number, number] }[]): MapKind {
  if (given === "korea" || given === "kr" || given === "한국") return "korea";
  if (given === "world" || given === "세계") return "world";
  const inKorea = (ll: [number, number]) => ll[0] > 124 && ll[0] < 132 && ll[1] > 33 && ll[1] < 39;
  return places.length && places.every((p) => (p.ll ? inKorea(p.ll) : !!p.region && !!sidoCode(p.region))) ? "korea" : "world";
}

/** the feature key an item's region matches: 시도 code or world-atlas name */
const regionKey = (kind: MapKind, raw: unknown) => (kind === "korea" ? sidoCode(raw) : countryName(raw));
const featKey = (kind: MapKind, f: Feat) => (kind === "korea" ? f.properties.code : f.properties.name);
const featName = (kind: MapKind, f: Feat) => (kind === "korea" ? SIDO[f.properties.code ?? ""]?.[0] ?? "" : countryKo(f.properties.name ?? ""));

interface Valued { key: string; label: string; value: number; note?: string; em?: boolean }
function valued(kind: MapKind, raw: unknown): Valued[] {
  const out = new Map<string, Valued>();
  for (const it of arr(raw)) {
    if (!isObj(it)) continue;
    const key = regionKey(kind, it.region ?? it.code ?? it.name ?? it.label);
    const value = toNum(it.value);
    if (!key || value === undefined || out.has(key)) continue;
    out.set(key, { key, label: toStr(it.label ?? it.region ?? it.name) ?? key, value, note: toStr(it.note), em: !!(it.em || it.highlight) });
  }
  return [...out.values()];
}

/** colour for a value: classes from layout/geo classify (quantile when skewed, diverging around 0) */
function scaleOf(vs: number[]) {
  const c = classify(vs);
  return { ...c, diverging: c.kind === "diverging", color: (v: number) => (c.kind === "diverging" ? div(c.t(v)) : seq(c.t(v))) };
}

/** maps overlap marks everywhere, so only three colours stay apart: the rest fold into "기타" grey */
const gslot = (i: number) => (i < 0 ? 0 : i < 3 ? i : 8);
const groupLegend = (gs: string[]) => [...gs.slice(0, 3).map((g, i) => ({ label: g, color: series(i) })), ...(gs.length > 3 ? [{ label: "기타", color: series(8) }] : [])];

interface MapB { label?: string; unit?: string; map?: string; items?: unknown; places?: unknown; links?: unknown; per?: number }

const MapFrame = (p: { label?: string; kind: MapKind; feats: Feat[] | undefined; maxH?: number; rotate?: number; side?: (w: number) => number; below?: JSX.Element; legend?: { label: string; color: string }[]; children: (proj: GeoProjection, path: ReturnType<typeof geoPath>, w: number, h: number) => JSX.Element }) => (
  <Frame
    label={p.label}
    class="rl"
    height={(w) => (p.feats ? fitMap(p.kind, p.feats, w, p.maxH ?? 520, { rotate: p.rotate, side: p.side?.(w) }).h : Math.round(p.kind === "korea" ? Math.min(520, w * 1.1) : w * 0.47))}
    margin={{ t: 0, r: 0, b: 0, l: 0 }}
    legend={p.legend}
    below={p.below}
    alt={p.label}
  >
    {(box) => (
      <Show when={p.feats}>
        {(fs) => {
          const { proj } = fitMap(p.kind, fs(), box.w, p.maxH ?? 520, { rotate: p.rotate, side: p.side?.(box.w) });
          return p.children(proj, geoPath(proj), box.w, box.h);
        }}
      </Show>
    )}
  </Frame>
);

// ───────────── choropleths
const METRO_W = ["28", "11", "50", "30", "29"]; // labelled in the left column
const METRO_E = ["27", "31", "26"]; // right column
const calloutW = (w: number) => (w >= 300 ? Math.min(64, w * 0.17) : 0);

function Choropleth(b: MapB & { kind: MapKind }) {
  const feats = useShapes(() => b.kind);
  const data = createMemo(() => valued(b.kind, b.items));
  const tip = useTip();
  const sc = createMemo(() => scaleOf(data().map((d) => d.value)));
  const korea = () => b.kind === "korea";
  return (
    <Show when={data().length} fallback={<Empty label={b.label} />}>
      <MapFrame label={b.label} kind={b.kind} feats={feats()} side={korea() ? calloutW : undefined} below={<Ramp min={sc().min} max={sc().max} unit={b.unit} diverging={sc().diverging} breaks={sc().breaks} noData={!!feats() && feats()!.length > data().length} />}>
        {(_proj, path, w, h) => {
          const by = new Map(data().map((d) => [d.key, d]));
          const fs = feats()!;
          const side = korea() ? calloutW(w) : 0;
          const metro = new Set(side ? [...METRO_W, ...METRO_E] : []);
          const [[mx0], [mx1]] = path.bounds({ type: "FeatureCollection", features: fs } as any);
          // labels inside regions: Korea's provinces (and metros when there is no callout room); the world's biggest few
          const labels = fs
            .map((f) => {
              const key = featKey(b.kind, f) ?? "";
              const d = by.get(key);
              if (!d || metro.has(key)) return null;
              const [cx, cy] = labelAt(path, f);
              const [[x0, y0], [x1, y1]] = path.bounds(f as any);
              const name = featName(b.kind, f);
              const v = val(d.value, b.unit);
              const tw1 = Math.max(tw(name, FS_SM, 500), tw(v, FS_SM));
              const area = (x1 - x0) * (y1 - y0);
              if (b.kind === "world" && (x1 - x0 < tw1 * 0.9 || area < 900)) return null;
              return { d, name, v, x: cx, y: cy, rect: { x: cx - tw1 / 2, y: cy - 13, w: tw1, h: 26, rank: (d.em ? 1e12 : 0) + (korea() ? area : Math.abs(d.value) * 1e3 + area) } };
            })
            .filter(Boolean) as { d: Valued; name: string; v: string; x: number; y: number; rect: any }[];
          // metro callouts: a column each side, in map order top to bottom, leader line to the city
          const callouts: { name: string; v: string; d: Valued; x: number; y: number; ax: number; ay: number; left: boolean }[] = [];
          for (const [codes, left] of [[METRO_W, true], [METRO_E, false]] as const) {
            if (!side) break;
            const items = codes
              .map((code) => {
                const f = fs.find((x) => x.properties.code === code);
                const d = by.get(code);
                if (!f || !d) return null;
                const [ax, ay] = labelAt(path, f);
                return { name: SIDO[code][0], v: val(d.value, b.unit), d, ax, ay, left, x: left ? Math.max(side - 4, mx0 - 10) : Math.min(w - side + 4, mx1 + 10), y: ay };
              })
              .filter(Boolean) as (typeof callouts)[number][];
            items.sort((p, q) => p.ay - q.ay);
            let prev = -Infinity;
            for (const it of items) {
              it.y = Math.min(Math.max(it.ay, prev + 30, 16), h - 16);
              prev = it.y;
            }
            callouts.push(...items);
          }
          const keep = declutter([...callouts.map((c) => ({ x: c.left ? c.x - 60 : c.x, y: c.y - 13, w: 60, h: 26, rank: 1e15 })), ...labels.map((l) => l.rect)], 2);
          const shown = labels.filter((_, i) => keep.has(i + callouts.length)).slice(0, b.kind === "world" ? Math.max(3, Math.floor(w / 110)) : 17);
          return (
            <g>
              <For each={fs}>
                {(f) => {
                  const d = by.get(featKey(b.kind, f) ?? "");
                  return (
                    <path
                      class="rl-region"
                      classList={{ nodata: !d }}
                      d={path(f as any) ?? ""}
                      fill={d ? sc().color(d.value) : undefined}
                      style={d?.em ? { stroke: "var(--ink)", "stroke-width": "1.5px" } : undefined}
                      onMouseMove={(e) => tip.show(e, d ? `${val(d.value, b.unit)}\n${featName(b.kind, f)}${d.note ? `\n${d.note}` : ""}` : `${featName(b.kind, f)}\n자료 없음`)}
                      onMouseLeave={tip.hide}
                    />
                  );
                }}
              </For>
              <For each={callouts}>
                {(c) => (
                  <g>
                    <path class="rl-leader" d={`M${c.ax},${c.ay}L${c.left ? c.x + 4 : c.x - 4},${c.y}`} />
                    <circle cx={c.ax} cy={c.ay} r={2} fill="var(--ink-2)" />
                    <text class="rl-sm" x={c.x} y={c.y - 6} text-anchor={c.left ? "end" : "start"}>
                      <tspan class="rl-strong">{c.name}</tspan>
                      <tspan class="rl-num" x={c.x} dy="1.2em">{c.v}</tspan>
                    </text>
                  </g>
                )}
              </For>
              <For each={shown}>
                {(l) => (
                  <text class="rl-in rl-fillhalo rl-sm" style={onFillStyle(sc().color(l.d.value), 1, true)} x={l.x} y={l.y - 6} text-anchor="middle">
                    <tspan font-weight="600">{l.name}</tspan>
                    <tspan class="rl-num" x={l.x} dy="1.2em">{l.v}</tspan>
                  </text>
                )}
              </For>
            </g>
          );
        }}
      </MapFrame>
    </Show>
  );
}

defineViz<MapB>({
  type: "worldmap",
  family: "relation",
  title: "세계 단계구분도",
  when: "나라마다 값이 어떻게 다른가",
  render: (b) => <Safe label={b.label}><Choropleth {...b} kind="world" /></Safe>,
  examples: [
    {
      label: "국가별 월간 활성 사용자",
      unit: "명",
      items: [
        { region: "KR", value: 412000, em: true }, { region: "JP", value: 186000 }, { region: "US", value: 254000 }, { region: "CN", value: 61000 },
        { region: "TW", value: 48000 }, { region: "VN", value: 39000 }, { region: "IN", value: 72000 }, { region: "DE", value: 54000 },
        { region: "GB", value: 47000 }, { region: "FR", value: 33000 }, { region: "CA", value: 41000 }, { region: "AU", value: 29000 },
        { region: "BR", value: 36000 }, { region: "ID", value: 44000 }, { region: "MX", value: 18000 }, { region: "RU", value: 9000 },
      ],
    },
  ],
});

const SIDO_POP = [
  { region: "서울", value: 933 }, { region: "부산", value: 326 }, { region: "대구", value: 236 }, { region: "인천", value: 302 },
  { region: "광주", value: 141 }, { region: "대전", value: 144 }, { region: "울산", value: 110 }, { region: "세종", value: 39 },
  { region: "경기", value: 1369 }, { region: "강원", value: 152 }, { region: "충북", value: 159 }, { region: "충남", value: 213 },
  { region: "전북", value: 174 }, { region: "전남", value: 179 }, { region: "경북", value: 255 }, { region: "경남", value: 325 }, { region: "제주", value: 67 },
];
const SIDO_CHANGE = [
  { region: "서울특별시", value: -0.6 }, { region: "부산광역시", value: -0.9 }, { region: "대구광역시", value: -0.7 }, { region: "인천광역시", value: 0.9 },
  { region: "광주광역시", value: -0.5 }, { region: "대전광역시", value: -0.2 }, { region: "울산광역시", value: -0.8 }, { region: "세종특별자치시", value: 1.4 },
  { region: "경기도", value: 0.7 }, { region: "강원특별자치도", value: -0.3 }, { region: "충청북도", value: 0.1 }, { region: "충청남도", value: 0.4 },
  { region: "전북특별자치도", value: -0.8 }, { region: "전라남도", value: -0.6 }, { region: "경상북도", value: -0.7 }, { region: "경상남도", value: -0.5 }, { region: "제주특별자치도", value: -0.1 },
];

defineViz<MapB>({
  type: "koreamap",
  family: "relation",
  title: "시도 단계구분도",
  when: "시도마다 값이 어떻게 다른가",
  render: (b) => <Safe label={b.label}><Choropleth {...b} kind="korea" /></Safe>,
  examples: [
    { label: "시도별 주민등록 인구 (2025, 만 명)", unit: "만", items: SIDO_POP },
    { label: "시도별 인구 증감률 (전년 대비)", unit: "%", items: SIDO_CHANGE },
  ],
});

// ───────────── 시도 tile grid
function KoreaTiles(b: MapB) {
  const data = createMemo(() => valued("korea", b.items));
  const tip = useTip();
  const sc = createMemo(() => scaleOf(data().map((d) => d.value)));
  return (
    <Show when={data().length} fallback={<Empty label={b.label} />}>
      <Frame
        label={b.label}
        class="rl"
        height={(w) => Math.round(Math.min(76, (w - 8) / 4) * 5 + 4)}
        margin={{ t: 0, r: 0, b: 0, l: 0 }}
        below={<Ramp min={sc().min} max={sc().max} unit={b.unit} diverging={sc().diverging} breaks={sc().breaks} noData={data().length < 17} />}
        alt={b.label}
      >
        {(box) => {
          const s = Math.min(76, (box.w - 8) / 4);
          const ox = (box.w - s * 4) / 2;
          const by = new Map(data().map((d) => [d.key, d]));
          return (
            <g>
              <For each={Object.entries(SIDO_TILES)}>
                {([code, [c, r]]) => {
                  const d = by.get(code);
                  const fillC = d ? sc().color(d.value) : "var(--rl-land)";
                  const x = ox + c * s + 1;
                  const y = r * s + 1;
                  const v = d ? val(d.value, b.unit) : "";
                  return (
                    <g class="rl-tile" onMouseMove={(e) => tip.show(e, d ? `${val(d.value, b.unit)}\n${SIDO[code][1]}${d.note ? `\n${d.note}` : ""}` : `${SIDO[code][1]}\n자료 없음`)} onMouseLeave={tip.hide}>
                      <rect x={x} y={y} width={s - 2} height={s - 2} rx={4} fill={fillC} style={d?.em ? { stroke: "var(--ink)", "stroke-width": "2px" } : undefined} />
                      <text class="rl-in" style={d ? onFillStyle(fillC) : undefined} x={x + (s - 2) / 2} y={y + (s - 2) / 2 + (v && s >= 44 ? -7 : 0)} dy="0.35em" text-anchor="middle" font-weight="600">{SIDO[code][0]}</text>
                      <Show when={v && s >= 44}>
                        <text class="rl-in rl-sm rl-num" style={onFillStyle(fillC)} x={x + (s - 2) / 2} y={y + (s - 2) / 2 + 10} dy="0.35em" text-anchor="middle">{fit(v, s - 8, FS_SM)}</text>
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

defineViz<MapB>({
  type: "koreatile",
  family: "relation",
  title: "시도 타일맵",
  when: "면적에 휘둘리지 않고 17개 시도 값을 고르게 비교하려면",
  render: (b) => <Safe label={b.label}><KoreaTiles {...b} /></Safe>,
  examples: [
    {
      label: "시도별 전기차 보급률 (%)",
      unit: "%",
      items: [
        { region: "서울", value: 3.1 }, { region: "부산", value: 2.9 }, { region: "대구", value: 3.6 }, { region: "인천", value: 2.7 },
        { region: "광주", value: 3.3 }, { region: "대전", value: 3.0 }, { region: "울산", value: 2.4 }, { region: "세종", value: 3.4 },
        { region: "경기", value: 2.6 }, { region: "강원", value: 2.2 }, { region: "충북", value: 2.5 }, { region: "충남", value: 2.3 },
        { region: "전북", value: 2.4 }, { region: "전남", value: 2.6 }, { region: "경북", value: 2.1 }, { region: "경남", value: 2.5 }, { region: "제주", value: 9.8, em: true },
      ],
    },
  ],
});

// ───────────── places (points by lat/lon, a 시도 or a country)
interface Place { id: string; label: string; ll?: [number, number]; region?: string; value?: number; group?: string; note?: string; em?: boolean }
function placesOf(raw: unknown): Place[] {
  const out: Place[] = [];
  for (const it of arr(raw)) {
    if (!isObj(it)) continue;
    const label = toStr(it.label ?? it.name ?? it.region ?? it.id) ?? "";
    out.push({ id: toStr(it.id) ?? label, label, ll: lonLat(it.at ?? it.coord ?? it.coords) ?? lonLat(it), region: toStr(it.region ?? (lonLat(it) ? undefined : it.label ?? it.name)), value: toNum(it.value), group: toStr(it.group), note: toStr(it.note), em: !!(it.em || it.highlight) });
  }
  return out;
}
/** screen point for a place: its lat/lon, else the centroid of its 시도 / country */
function locate(kind: MapKind, feats: Feat[], proj: GeoProjection, p: Place): [number, number] | undefined {
  const ll = p.ll ?? (() => {
    const key = regionKey(kind, p.region);
    const f = key && feats.find((x) => featKey(kind, x) === key);
    return f ? (geoCentroid(f as any) as [number, number]) : undefined;
  })();
  const xy = ll && proj(ll);
  return xy && Number.isFinite(xy[0]) ? (xy as [number, number]) : undefined;
}

/** two reference circles drawn on the map's bottom-left, at the map's own scale */
const SizeKey = (p: { max: number; R: number; h: number; unit?: string }) => {
  /** the largest 1-significant-digit value not above v (48,200 → 40,000) */
  const nice = (v: number) => {
    const k = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-9))));
    return Math.floor(v / k) * k;
  };
  const vals = [nice(p.max), nice(p.max / 4)].filter((v, i, a) => v > 0 && a.indexOf(v) === i && v <= p.max * 1.001);
  const r = (v: number) => p.R * Math.sqrt(v / p.max);
  const big = r(vals[0] ?? p.max);
  const by = p.h - 6;
  return (
    <g class="rl-sizekey" pointer-events="none">
      <For each={vals}>
        {(v) => (
          <>
            <circle cx={6 + big} cy={by - r(v)} r={r(v)} fill="none" stroke="var(--ink-3)" stroke-width="1" />
            <line x1={6 + big} x2={6 + big * 2 + 8} y1={by - 2 * r(v)} y2={by - 2 * r(v)} stroke="var(--ink-3)" stroke-width="0.8" stroke-dasharray="1 2" />
            <text class="rl-muted rl-tiny" x={6 + big * 2 + 10} y={by - 2 * r(v)} dy="0.35em">{val(v, p.unit)}</text>
          </>
        )}
      </For>
    </g>
  );
};

// ───────────── bubble (symbol) map
function BubbleMap(b: MapB) {
  const ps = createMemo(() => placesOf(b.items).filter((p) => p.value !== undefined && p.value > 0));
  const kind = createMemo(() => pickMap(b.map, ps()));
  const feats = useShapes(kind);
  const tip = useTip();
  const groups = createMemo(() => [...new Set(ps().map((p) => p.group).filter(Boolean))] as string[]);
  const vmax = () => Math.max(1e-9, ...ps().map((p) => p.value!));
  const rmax = (w: number) => (kind() === "korea" ? Math.min(30, w / 14) : Math.min(26, w / 22));
  return (
    <Show when={ps().length} fallback={<Empty label={b.label} />}>
      <MapFrame label={b.label} kind={kind()} feats={feats()} legend={groups().length > 1 ? groupLegend(groups()) : undefined} >
        {(proj, path, w, h) => {
          const R = rmax(w);
          const pts = ps()
            .map((p) => ({ p, xy: locate(kind(), feats()!, proj, p), r: Math.max(2, R * Math.sqrt(p.value! / vmax())) }))
            .filter((x) => x.xy)
            .sort((a, c) => c.r - a.r) as { p: Place; xy: [number, number]; r: number }[];
          const emAny = pts.some((x) => x.p.em);
          const cands = pts.map((x) => {
            const t = fit(x.p.label, 90, FS_SM, 500);
            const lw = tw(t, FS_SM, 500);
            return { x, t, rect: { x: x.xy[0] + x.r + 3, y: x.xy[1] - 7, w: lw, h: 14, rank: (x.p.em ? 1e12 : 0) + x.p.value! } };
          });
          const keyBox = { x: 0, y: h - 2 * R - 12, w: 2 * R + 60, h: 2 * R + 12, rank: 1e15 };
          const keep = declutter([...cands.map((c) => c.rect), keyBox], 1);
          const labelled = cands.filter((_, i) => keep.has(i)).slice(0, Math.max(4, Math.floor(w / 60)));
          return (
            <g>
              <For each={feats()!}>{(f) => <path class="rl-land" d={path(f as any) ?? ""} />}</For>
              <For each={pts}>
                {(x) => (
                  <circle
                    class="rl-bubble"
                    cx={x.xy[0]} cy={x.xy[1]} r={x.r}
                    fill={emAny && !x.p.em ? "var(--viz-muted)" : series(groups().length ? gslot(groups().indexOf(x.p.group ?? "")) : 0)}
                    onMouseMove={(e) => tip.show(e, `${val(x.p.value, b.unit)}\n${x.p.label}${x.p.group ? ` · ${x.p.group}` : ""}${x.p.note ? `\n${x.p.note}` : ""}`)}
                    onMouseLeave={tip.hide}
                  />
                )}
              </For>
              <For each={labelled}>{(c) => <text class="rl-halo rl-sm rl-strong" x={c.rect.x} y={c.x.xy[1]} dy="0.35em">{c.t}</text>}</For>
              <SizeKey max={vmax()} R={R} h={h} unit={b.unit} />
            </g>
          );
        }}
      </MapFrame>
    </Show>
  );
}

defineViz<MapB>({
  type: "bubblemap",
  family: "relation",
  title: "버블 지도",
  when: "어느 지점에 얼마나 몰려 있나 (위경도·시도·나라, map: korea|world)",
  render: (b) => <Safe label={b.label}><BubbleMap {...b} /></Safe>,
  examples: [
    {
      label: "물류센터별 일 출고량",
      unit: "건",
      map: "korea",
      items: [
        { label: "이천", lat: 37.27, lon: 127.44, value: 48200 }, { label: "용인", lat: 37.24, lon: 127.18, value: 36100 },
        { label: "인천", lat: 37.46, lon: 126.71, value: 29800 }, { label: "대전", lat: 36.35, lon: 127.38, value: 18400 },
        { label: "칠곡", lat: 35.99, lon: 128.4, value: 15600 }, { label: "김해", lat: 35.23, lon: 128.89, value: 21300 },
        { label: "광주", lat: 35.16, lon: 126.85, value: 11200 }, { label: "원주", lat: 37.34, lon: 127.92, value: 6400 },
        { label: "제주", lat: 33.5, lon: 126.53, value: 2900 },
      ],
    },
    {
      label: "리전별 API 요청 (일, 백만 건)",
      unit: "백만",
      map: "world",
      items: [
        { label: "서울", lat: 37.57, lon: 126.98, value: 412, group: "아시아" }, { label: "도쿄", lat: 35.68, lon: 139.69, value: 288, group: "아시아" },
        { label: "싱가포르", lat: 1.35, lon: 103.82, value: 164, group: "아시아" }, { label: "뭄바이", lat: 19.08, lon: 72.88, value: 96, group: "아시아" },
        { label: "프랑크푸르트", lat: 50.11, lon: 8.68, value: 210, group: "유럽" }, { label: "런던", lat: 51.51, lon: -0.13, value: 175, group: "유럽" },
        { label: "버지니아", lat: 38.03, lon: -78.48, value: 356, group: "미주" }, { label: "오리건", lat: 45.52, lon: -122.68, value: 198, group: "미주" },
        { label: "상파울루", lat: -23.55, lon: -46.63, value: 71, group: "미주" }, { label: "시드니", lat: -33.87, lon: 151.21, value: 84, group: "아시아" },
      ],
    },
  ],
});

// ───────────── dot density
function DotMap(b: MapB) {
  const items = createMemo(() =>
    arr(b.items)
      .filter(isObj)
      .map((it) => ({ region: it.region ?? it.label ?? it.name, value: toNum(it.value) ?? 0, group: toStr(it.group) }))
      .filter((i) => i.value > 0),
  );
  const kind = createMemo(() => pickMap(b.map, items().map((i) => ({ region: toStr(i.region) }))));
  const feats = useShapes(kind);
  const tip = useTip();
  const groups = createMemo(() => [...new Set(items().map((i) => i.group).filter(Boolean))] as string[]);
  const total = () => items().reduce((s, i) => s + i.value, 0);
  /** units per dot: about 1,500 dots in all, rounded to 1/2/5 × 10^k */
  const per = () => {
    if (b.per && b.per > 0) return b.per;
    const raw = total() / 1500;
    const k = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    return [1, 2, 5, 10].map((m) => m * k).find((v) => v >= raw) ?? raw;
  };
  const dots = createMemo(() => {
    const fs = feats();
    if (!fs) return [];
    const out: { ll: [number, number]; g: number; key: string }[] = [];
    for (const it of items()) {
      const key = regionKey(kind(), it.region);
      const f = key && fs.find((x) => featKey(kind(), x) === key);
      if (!f) continue;
      const n = Math.min(4000, Math.round(it.value / per()));
      const g = it.group ? groups().indexOf(it.group) : 0;
      for (const ll of dotsIn(f, n, hash(`${key}|${it.group ?? ""}`))) out.push({ ll, g, key: key as string });
    }
    // interleave groups so no colour sits on top of another everywhere
    return out.sort((a, c) => hash(`${a.ll[0]}${a.ll[1]}`) - hash(`${c.ll[0]}${c.ll[1]}`));
  });
  return (
    <Show when={items().length} fallback={<Empty label={b.label} />}>
      <MapFrame
        label={b.label}
        kind={kind()}
        feats={feats()}
        legend={groups().length > 1 ? groupLegend(groups()) : undefined}
        below={<div class="rl-ramp"><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="2" fill={series(0)} /></svg><span>= {val(per(), b.unit)}</span></div>}
      >
        {(proj, path) => {
          const totals = new Map<string, number>();
          for (const it of items()) {
            const k = regionKey(kind(), it.region);
            if (k) totals.set(k, (totals.get(k) ?? 0) + it.value);
          }
          return (
            <g>
              <For each={feats()!}>
                {(f) => (
                  <path class="rl-land" d={path(f as any) ?? ""} onMouseMove={(e) => tip.show(e, `${val(totals.get(featKey(kind(), f) ?? ""), b.unit)}\n${featName(kind(), f)}`)} onMouseLeave={tip.hide} />
                )}
              </For>
              <g pointer-events="none">
                <For each={dots()}>
                  {(d) => {
                    const xy = proj(d.ll);
                    return xy ? <circle cx={xy[0]} cy={xy[1]} r={1.3} fill={series(gslot(d.g))} fill-opacity={0.85} /> : null;
                  }}
                </For>
              </g>
            </g>
          );
        }}
      </MapFrame>
    </Show>
  );
}

defineViz<MapB>({
  type: "dotmap",
  family: "relation",
  title: "점밀도 지도",
  when: "지역 안에 무엇이 얼마나 퍼져 있나 (점 하나 = per)",
  render: (b) => <Safe label={b.label}><DotMap {...b} /></Safe>,
  examples: [
    {
      label: "시도별 사업체 수 (업종별)",
      unit: "곳",
      per: 2000,
      items: [
        { region: "서울", value: 820000, group: "서비스" }, { region: "서울", value: 98000, group: "제조" },
        { region: "경기", value: 910000, group: "서비스" }, { region: "경기", value: 260000, group: "제조" },
        { region: "인천", value: 190000, group: "서비스" }, { region: "인천", value: 52000, group: "제조" },
        { region: "부산", value: 270000, group: "서비스" }, { region: "부산", value: 41000, group: "제조" },
        { region: "경남", value: 230000, group: "서비스" }, { region: "경남", value: 88000, group: "제조" },
        { region: "경북", value: 180000, group: "서비스" }, { region: "경북", value: 64000, group: "제조" },
        { region: "대구", value: 170000, group: "서비스" }, { region: "대구", value: 38000, group: "제조" },
        { region: "충남", value: 140000, group: "서비스" }, { region: "충남", value: 45000, group: "제조" },
        { region: "충북", value: 110000, group: "서비스" }, { region: "충북", value: 36000, group: "제조" },
        { region: "전북", value: 120000, group: "서비스" }, { region: "전남", value: 130000, group: "서비스" },
        { region: "광주", value: 100000, group: "서비스" }, { region: "대전", value: 110000, group: "서비스" },
        { region: "울산", value: 70000, group: "서비스" }, { region: "울산", value: 22000, group: "제조" },
        { region: "강원", value: 120000, group: "서비스" }, { region: "제주", value: 60000, group: "서비스" }, { region: "세종", value: 20000, group: "서비스" },
      ],
    },
  ],
});

// ───────────── connections (great circles) and flows (directed arcs)
function Routes(b: MapB & { flow: boolean }) {
  const places = createMemo(() => placesOf(b.places));
  const links = createMemo(() =>
    arr(b.links)
      .filter(isObj)
      .map((l) => ({ from: l.from, to: l.to, value: toNum(l.value), em: !!(l.em || l.highlight), note: toStr(l.note) }))
      .filter((l) => l.from != null && l.to != null),
  );
  // an end is a place id, a 시도 / country name, or {lat, lon}
  const endOf = (raw: unknown): Place | undefined => {
    if (isObj(raw)) return placesOf([raw])[0];
    const s = toStr(raw);
    if (!s) return undefined;
    return places().find((p) => p.id === s || p.label === s) ?? { id: s, label: s, region: s };
  };
  const ends = createMemo(() => links().map((l) => [endOf(l.from), endOf(l.to)] as const));
  const kind = createMemo(() => pickMap(b.map, ends().flatMap(([a, c]) => [a, c]).filter(Boolean).map((p) => ({ ll: p!.ll, region: p!.region }))));
  const feats = useShapes(kind);
  const tip = useTip();
  /** the world map turns to the middle of the places (a hub in Asia puts the Pacific in the centre) */
  const centerLon = () => {
    const ls = ends().flatMap(([a, c]) => [a, c]).map((p) => p?.ll?.[0]).filter((x): x is number => x !== undefined);
    if (!ls.length) return 0;
    const sx = ls.reduce((s, l) => s + Math.cos((l * Math.PI) / 180), 0);
    const sy = ls.reduce((s, l) => s + Math.sin((l * Math.PI) / 180), 0);
    return Math.round((Math.atan2(sy, sx) * 180) / Math.PI);
  };
  return (
    <Show when={links().length} fallback={<Empty label={b.label} />}>
      <MapFrame label={b.label} kind={kind()} feats={feats()} rotate={kind() === "world" ? centerLon() : undefined}>
        {(proj, path, w) => {
          const fs = feats()!;
          const vmax = Math.max(1e-9, ...links().map((l) => l.value ?? 1));
          const emAny = links().some((l) => l.em);
          const pts = new Map<string, { p: Place; xy: [number, number]; total: number }>();
          const segs = links()
            .map((l, i) => {
              const [a, c] = ends()[i];
              const xa = a && locate(kind(), fs, proj, a);
              const xc = c && locate(kind(), fs, proj, c);
              if (!a || !c || !xa || !xc) return null;
              for (const [p, xy] of [[a, xa], [c, xc]] as const) {
                const k = p.id;
                const cur = pts.get(k) ?? { p, xy, total: 0 };
                cur.total += l.value ?? 1;
                pts.set(k, cur);
              }
              const llA = a.ll ?? (proj.invert?.(xa) as [number, number]);
              const llC = c.ll ?? (proj.invert?.(xc) as [number, number]);
              const width = b.flow ? 1.2 + 5.5 * ((l.value ?? 1) / vmax) : 1 + 2 * Math.sqrt((l.value ?? 1) / vmax);
              const arc = flowArc(xa, xc, 0.2, 5);
              return { l, a, c, d: b.flow ? arc.d : path({ type: "LineString", coordinates: [llA, llC] } as any) ?? "", width, arc };
            })
            .filter(Boolean) as { l: ReturnType<typeof links>[number]; a: Place; c: Place; d: string; width: number; arc: ReturnType<typeof flowArc> }[];
          const color = (em: boolean) => (emAny && !em ? "var(--viz-muted)" : series(0));
          const cands = [...pts.values()].map((x) => {
            const t = fit(x.p.label, 90, FS_SM, 500);
            const lw = tw(t, FS_SM, 500);
            return { x, t, rect: { x: x.xy[0] + 5, y: x.xy[1] - 7, w: lw, h: 14, rank: x.total } };
          });
          const keep = declutter(cands.map((c) => c.rect), 1);
          const labelled = cands.filter((_, i) => keep.has(i)).slice(0, Math.max(5, Math.floor(w / 50)));
          return (
            <g>
              <For each={fs}>{(f) => <path class="rl-land" d={path(f as any) ?? ""} />}</For>
              <For each={[...segs].sort((a, c) => (a.l.value ?? 0) - (c.l.value ?? 0))}>
                {(s) => (
                  <g onMouseMove={(e) => tip.show(e, `${s.l.value !== undefined ? val(s.l.value, b.unit) + "\n" : ""}${s.a.label} → ${s.c.label}${s.l.note ? `\n${s.l.note}` : ""}`)} onMouseLeave={tip.hide}>
                    <path class="rl-route" d={s.d} stroke={color(s.l.em)} stroke-width={s.width} />
                    <Show when={b.flow}>
                      <path
                        d={`M0,0L${-Math.max(6, s.width + 4)},${-Math.max(3.5, s.width / 2 + 3)}L${-Math.max(6, s.width + 4)},${Math.max(3.5, s.width / 2 + 3)}Z`}
                        transform={`translate(${s.arc.end[0]},${s.arc.end[1]}) rotate(${(s.arc.angle * 180) / Math.PI})`}
                        fill={color(s.l.em)}
                        fill-opacity="0.9"
                      />
                    </Show>
                  </g>
                )}
              </For>
              <For each={[...pts.values()]}>{(x) => <circle class="rl-ring" cx={x.xy[0]} cy={x.xy[1]} r={3} fill="var(--ink-2)" />}</For>
              <For each={labelled}>{(c) => <text class="rl-halo rl-sm rl-strong" x={c.rect.x} y={c.x.xy[1]} dy="0.35em">{c.t}</text>}</For>
            </g>
          );
        }}
      </MapFrame>
    </Show>
  );
}

defineViz<MapB>({
  type: "connmap",
  family: "relation",
  title: "연결 지도",
  when: "어느 지점과 어느 지점이 이어져 있나 (대권 항로)",
  render: (b) => <Safe label={b.label}><Routes {...b} flow={false} /></Safe>,
  examples: [
    {
      label: "인천공항 출발 주요 노선 (주간 운항)",
      unit: "회",
      map: "world",
      places: [
        { id: "ICN", label: "인천", lat: 37.46, lon: 126.44 }, { id: "NRT", label: "도쿄", lat: 35.77, lon: 140.39 },
        { id: "LAX", label: "로스앤젤레스", lat: 33.94, lon: -118.41 }, { id: "JFK", label: "뉴욕", lat: 40.64, lon: -73.78 },
        { id: "CDG", label: "파리", lat: 49.01, lon: 2.55 }, { id: "SIN", label: "싱가포르", lat: 1.36, lon: 103.99 },
        { id: "SYD", label: "시드니", lat: -33.94, lon: 151.18 }, { id: "DXB", label: "두바이", lat: 25.25, lon: 55.36 },
        { id: "FRA", label: "프랑크푸르트", lat: 50.04, lon: 8.56 },
      ],
      links: [
        { from: "ICN", to: "NRT", value: 98 }, { from: "ICN", to: "LAX", value: 35 }, { from: "ICN", to: "JFK", value: 28 },
        { from: "ICN", to: "CDG", value: 21 }, { from: "ICN", to: "SIN", value: 42 }, { from: "ICN", to: "SYD", value: 14 },
        { from: "ICN", to: "DXB", value: 14 }, { from: "ICN", to: "FRA", value: 17 },
      ],
    },
  ],
});

defineViz<MapB>({
  type: "flowmap",
  family: "relation",
  title: "흐름 지도",
  when: "어디에서 어디로 얼마나 옮겨 가나 (출발 → 도착, 굵기 = 양)",
  render: (b) => <Safe label={b.label}><Routes {...b} flow={true} /></Safe>,
  examples: [
    {
      label: "수도권 전입 인구의 출발지 (2024, 천 명)",
      unit: "천 명",
      map: "korea",
      links: [
        { from: "부산", to: "서울", value: 38 }, { from: "대구", to: "서울", value: 29 }, { from: "광주", to: "서울", value: 21 },
        { from: "대전", to: "경기", value: 33 }, { from: "충남", to: "경기", value: 41, em: true }, { from: "강원", to: "경기", value: 27 },
        { from: "전북", to: "서울", value: 19 }, { from: "경북", to: "경기", value: 24 }, { from: "경남", to: "서울", value: 22 },
        { from: "제주", to: "서울", value: 8 },
      ],
    },
  ],
});
