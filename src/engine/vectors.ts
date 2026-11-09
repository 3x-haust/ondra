// Memory by meaning: every piece gets a vector from the local embedding model
// (multilingual, so "배포" finds "deploy"), kept compact (int8, base64) and only
// recomputed when the text changes. Recall mixes this with the word match.
// Without the model (fixture, first run before the download) recall is words only.
import { embedTexts, inTauri } from "../lib/native";
import { state } from "../state/store";
import type { Memory } from "../state/types";

const KEY = "ondra.vectors.v1";
type Kept = { h: string; v: Float32Array };
const vecs = new Map<string, Kept>();
const queries = new Map<string, Float32Array>();
let ready = false;

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const docText = (m: Memory) => [m.text, ...(m.about ?? []), ...(m.keys ?? [])].join(" · ");
const pack = (v: Float32Array) => btoa(String.fromCharCode(...Uint8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))) & 255)));
const unpack = (s: string) => Float32Array.from(atob(s), (c) => ((c.charCodeAt(0) << 24) >> 24) / 127);

function load() {
  if (ready) return;
  ready = true;
  try {
    const raw: Record<string, { h: string; v: string }> = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    for (const [id, k] of Object.entries(raw)) vecs.set(id, { h: k.h, v: unpack(k.v) });
  } catch {
    /* start over */
  }
}
function save() {
  const live = new Set(state.memory.map((m) => m.id));
  const out: Record<string, { h: string; v: string }> = {};
  for (const [id, k] of vecs) if (live.has(id)) out[id] = { h: k.h, v: pack(k.v) };
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* full: vectors are rebuilt next time */
  }
}

let busy = false;
/** Vectors for pieces that have none or whose text changed. */
export async function indexMemory() {
  if (!inTauri || busy) return;
  load();
  busy = true;
  try {
    const todo = state.memory.filter((m) => !m.invalidAt && vecs.get(m.id)?.h !== hash(docText(m)));
    for (let i = 0; i < todo.length; i += 48) {
      const part = todo.slice(i, i + 48);
      const out = await embedTexts(part.map(docText));
      if (out.length !== part.length) return;
      part.forEach((m, j) => vecs.set(m.id, { h: hash(docText(m)), v: Float32Array.from(out[j]) }));
    }
    if (todo.length) save();
  } catch {
    /* model not there yet: words only for now */
  } finally {
    busy = false;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** After memory changes: index a little later, once. */
export function soonIndex() {
  clearTimeout(timer);
  timer = setTimeout(() => void indexMemory(), 2500);
}

/** Embed a search text ahead, so the (sync) recall can use it. */
export async function prepareQuery(q: string) {
  if (!inTauri || !q.trim() || queries.has(q)) return;
  try {
    const [v] = await embedTexts([q.slice(0, 2000)], true);
    if (v) {
      queries.set(q, Float32Array.from(v));
      if (queries.size > 64) queries.delete(queries.keys().next().value!);
    }
  } catch {
    /* words only */
  }
}

/** Cosine of a piece with a prepared query (undefined = no vectors). */
export function similarity(query: string, m: Memory): number | undefined {
  load();
  const q = queries.get(query), d = vecs.get(m.id)?.v;
  if (!q || !d || q.length !== d.length) return undefined;
  let s = 0;
  for (let i = 0; i < q.length; i++) s += q[i] * d[i];
  return s;
}

/** vectors for other texts (jobs), kept for this run only: they are cheap to rebuild */
const others = new Map<string, Kept>();
/**
 * Cosine of each text with a query, by the same model as memory (jobs_search).
 * Texts are embedded once per change; empty without the model (words only then).
 */
export async function textSimilarity(query: string, items: { id: string; text: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!inTauri || !query.trim() || !items.length) return out;
  try {
    await prepareQuery(query);
    const q = queries.get(query);
    if (!q) return out;
    const todo = items.filter((i) => others.get(i.id)?.h !== hash(i.text));
    for (let i = 0; i < todo.length; i += 48) {
      const part = todo.slice(i, i + 48);
      const vs = await embedTexts(part.map((x) => x.text.slice(0, 2000)));
      if (vs.length !== part.length) break;
      part.forEach((x, j) => others.set(x.id, { h: hash(x.text), v: Float32Array.from(vs[j]) }));
    }
    if (others.size > 3000) for (const k of [...others.keys()].slice(0, others.size - 3000)) others.delete(k);
    for (const x of items) {
      const d = others.get(x.id)?.v;
      if (!d || d.length !== q.length) continue;
      let s = 0;
      for (let i = 0; i < q.length; i++) s += q[i] * d[i];
      out.set(x.id, s);
    }
  } catch {
    /* words only */
  }
  return out;
}
