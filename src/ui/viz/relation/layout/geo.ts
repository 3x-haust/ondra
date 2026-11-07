// Maps: matching region names (시도, countries) in whatever form the agent writes,
// the Korea tile grid, seeded dot-density sampling and flow-arc geometry.
import { geoBounds, geoContains } from "d3-geo";
import { rng } from "./text";
import { WORLD_NAMES } from "./worldNames";

/** 시도: ISO 3166-2:KR number → [short, full name] */
export const SIDO: Record<string, [string, string]> = {
  "11": ["서울", "서울특별시"], "26": ["부산", "부산광역시"], "27": ["대구", "대구광역시"], "28": ["인천", "인천광역시"],
  "29": ["광주", "광주광역시"], "30": ["대전", "대전광역시"], "31": ["울산", "울산광역시"], "50": ["세종", "세종특별자치시"],
  "41": ["경기", "경기도"], "42": ["강원", "강원특별자치도"], "43": ["충북", "충청북도"], "44": ["충남", "충청남도"],
  "45": ["전북", "전북특별자치도"], "46": ["전남", "전라남도"], "47": ["경북", "경상북도"], "48": ["경남", "경상남도"], "49": ["제주", "제주특별자치도"],
};
const EN: Record<string, string> = {
  seoul: "11", busan: "26", daegu: "27", incheon: "28", gwangju: "29", daejeon: "30", ulsan: "31", sejong: "50", gyeonggi: "41", gangwon: "42",
  northchungcheong: "43", chungbuk: "43", southchungcheong: "44", chungnam: "44", northjeolla: "45", jeonbuk: "45", southjeolla: "46", jeonnam: "46",
  northgyeongsang: "47", gyeongbuk: "47", southgyeongsang: "48", gyeongnam: "48", jeju: "49",
};
const KO_LONG: Record<string, string> = { 충청북: "43", 충청남: "44", 전라북: "45", 전북: "45", 전라남: "46", 경상북: "47", 경상남: "48" };

/** "서울", "서울시", "서울특별시", "Seoul", "KR-11", "11" → "11" */
export function sidoCode(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;
  const iso = s.match(/^(?:KR-?)?(\d{2})$/i);
  if (iso && SIDO[iso[1]]) return iso[1];
  const en = s.toLowerCase().replace(/[^a-z]/g, "").replace(/(province|do|si|metropolitancity|specialcity|city)$/, "");
  if (EN[en]) return EN[en];
  s = s.replace(/\s+/g, "");
  for (const [code, [short, full]] of Object.entries(SIDO)) if (s === short || s === full) return code;
  const stem = s.replace(/(특별자치시|특별자치도|특별시|광역시|자치시|자치도|시|도)$/, "");
  for (const [code, [short]] of Object.entries(SIDO)) if (stem === short) return code;
  for (const [k, code] of Object.entries(KO_LONG)) if (stem === k || stem.startsWith(k)) return code;
  return undefined;
}

/** a tile grid of the 17 시도 (col, row), roughly where each sits on the map */
export const SIDO_TILES: Record<string, [number, number]> = {
  "28": [0, 0], "11": [1, 0], "41": [2, 0], "42": [3, 0],
  "44": [0, 1], "50": [1, 1], "43": [2, 1], "47": [3, 1],
  "45": [0, 2], "30": [1, 2], "27": [2, 2], "31": [3, 2],
  "29": [0, 3], "46": [1, 3], "48": [2, 3], "26": [3, 3],
  "49": [1, 4],
};

interface Country { atlas: string; a2: string; a3: string; ko: string }
let countries: Country[] | undefined;
// NFKD splits accents off (Côte → Cote); NFC then puts Hangul syllables back together
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").replace(/[^a-z0-9가-힣]/g, "");
const ALIAS: Record<string, string> = {
  한국: "KR", 남한: "KR", korea: "KR", republicofkorea: "KR", 조선: "KP", 미합중국: "US", usa: "US", us: "US", america: "US", unitedstates: "US",
  uk: "GB", britain: "GB", greatbritain: "GB", 호주: "AU", 체코: "CZ", czechia: "CZ", 러시아연방: "RU", 콩고민주공화국: "CD", drc: "CD", 콩고공화국: "CG",
  uae: "AE", 아랍에미리트: "AE", 중화인민공화국: "CN", 버마: "MM", burma: "MM", ivorycoast: "CI", 코트디부아르: "CI", 터키: "TR", turkey: "TR", 튀르키예: "TR", 스와질란드: "SZ",
  vietnam: "VN", 대만: "TW", 타이완: "TW", 홍콩: "HK", 마케도니아: "MK", 이란: "IR", 시리아: "SY", 라오스: "LA", 볼리비아: "BO", 베네수엘라: "VE", 탄자니아: "TZ", 몰도바: "MD",
};
function table(): Country[] {
  return (countries ??= WORLD_NAMES.split(";").map((r) => {
    const [atlas, a2, a3, ko] = r.split("|");
    return { atlas, a2, a3, ko };
  }));
}
/** "KR", "KOR", "대한민국", "한국", "South Korea" → the world-atlas feature name */
export function countryName(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const t = table();
  const up = s.toUpperCase();
  const byCode = t.find((c) => (up.length === 2 && c.a2 === up) || (up.length === 3 && c.a3 === up));
  if (byCode) return byCode.atlas;
  const n = norm(s);
  if (!n) return undefined;
  const alias = ALIAS[n];
  if (alias) return t.find((c) => c.a2 === alias)?.atlas;
  return (t.find((c) => norm(c.atlas) === n || norm(c.ko) === n) ?? t.find((c) => norm(c.ko).replace(/공화국$/, "") === n.replace(/공화국$/, "")))?.atlas;
}
/** the Korean name for a world-atlas feature name */
export const countryKo = (atlas: string) => table().find((c) => c.atlas === atlas)?.ko ?? atlas;

/** [lon, lat] from {lon, lat} / {lng, lat} / [lon, lat] / [lat, lon] when obviously so */
export function lonLat(p: unknown): [number, number] | undefined {
  if (Array.isArray(p) && p.length >= 2) {
    const [a, b] = p.map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    return Math.abs(a) <= 90 && Math.abs(b) > 90 ? [b, a] : [a, b];
  }
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    const lon = Number(o.lon ?? o.lng ?? o.long ?? o.x);
    const lat = Number(o.lat ?? o.y);
    if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lon, lat];
  }
  return undefined;
}

/**
 * `n` points spread inside a GeoJSON feature (rejection sampling in its lon/lat
 * bounds), the same points every time for the same seed.
 */
export function dotsIn(feature: any, n: number, seed: number): [number, number][] {
  const out: [number, number][] = [];
  if (!feature || n <= 0) return out;
  const [[x0, y0], [x1, y1]] = geoBounds(feature);
  const rand = rng(seed);
  for (let tries = 0; out.length < n && tries < n * 60; tries++) {
    const p: [number, number] = [x0 + (x1 - x0) * rand(), y0 + (y1 - y0) * rand()];
    if (geoContains(feature, p)) out.push(p);
  }
  return out;
}

/**
 * A curved flow arc from a to b (screen space), bending left of the direction of
 * travel, stopping `trim` px short of b so an arrowhead can sit there.
 */
export function flowArc(a: [number, number], b: [number, number], bend = 0.22, trim = 0): { d: string; mid: [number, number]; end: [number, number]; angle: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const c: [number, number] = [(a[0] + b[0]) / 2 - dy * bend, (a[1] + b[1]) / 2 + dx * bend];
  const angle = Math.atan2(b[1] - c[1], b[0] - c[0]);
  const e: [number, number] = [b[0] - Math.cos(angle) * trim, b[1] - Math.sin(angle) * trim];
  const mid: [number, number] = [0.25 * a[0] + 0.5 * c[0] + 0.25 * e[0], 0.25 * a[1] + 0.5 * c[1] + 0.25 * e[1]];
  return { d: `M${a[0]},${a[1]}Q${c[0]},${c[1]} ${e[0]},${e[1]}`, mid, end: e, angle };
}

/** nice legend steps for a value range: [min, max] split into `k` equal bins */
export function bins(min: number, max: number, k = 5): number[] {
  if (!(max > min)) return [min, max];
  return Array.from({ length: k + 1 }, (_, i) => min + ((max - min) * i) / k);
}
