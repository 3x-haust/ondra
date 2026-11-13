// Logos for the boxes of an `arch` diagram, beyond the few bundled in Logos.tsx:
//   1. the bundled ones, at once
//   2. every simple-icons logo (~3,300), loaded the first time a name misses the bundled
//      ones (scripts/simple-icons-all.mjs: a small index, the drawings in shards)
//   3. the brand's own colour mark from the internet (src-tauri/src/logos.rs: svgl →
//      devicon → gilbarbara, cleaned and kept on disk), drawn instead of the glyph once it comes
// What may go online: a block's `logo`, or the title of the brand a box's label matched
// ("order-api (Node)" asks for "Node.js"). A label or note itself never leaves the machine,
// so internal service names stay here. Nothing is asked while the Mac is offline.
import { createSignal } from "solid-js";
import { aliasOf, glyphColor, logoFor } from "./Logos";
import { logoFetch, type OfficialLogo } from "../lib/native";

/** slug, title, hex colour, other names, shard (as virtual:simple-icons-all has them) */
export type Entry = [slug: string, title: string, hex: string, aka: string[], shard: number];
type Icon = { slug: string; title: string; hex: string; path?: string; shard?: number };
type Named = { logo?: string; label: string; note?: string };

/** how names are compared: lowercase letters and digits ("Next.js" → nextjs, "C++" → cplusplus) */
export const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/\+/g, "plus").replace(/[^a-z0-9]/g, "");

/** the full set by every name it answers to: slug first, then title, then other names */
export function indexOf(entries: Entry[]): Map<string, Entry> {
  const m = new Map<string, Entry>();
  const put = (k: string, e: Entry) => k && !m.has(k) && m.set(k, e);
  for (const e of entries) put(e[0], e);
  for (const e of entries) put(norm(e[1]), e);
  for (const e of entries) for (const a of e[3]) put(norm(a), e);
  return m;
}

/** a name in the full set, exactly: no guessing from single words, which would find a brand in "Order Box" */
export function findIn(index: Map<string, Entry>, name?: string): Icon | undefined {
  const k = name ? norm(name) : "";
  if (k.length < 2) return undefined;
  const e = index.get(aliasOf(name!) ?? k) ?? index.get(k);
  return e && { slug: e[0], title: e[1], hex: e[2], shard: e[4] };
}

/** a brand name fit to send: short, plain characters (logos.rs checks the same) */
export const sendable = (name?: string): name is string => !!name && /^[A-Za-z0-9][A-Za-z0-9 .+_-]{0,59}$/.test(name.trim());

const bundled = (name?: string): Icon | undefined => {
  const i = logoFor(name);
  return i && { slug: i.slug, title: i.title, hex: i.hex, path: i.path };
};

/**
 * What a box shows and what may be asked online for it. `full` is the whole set once it
 * has loaded (undefined before: `waiting` says the answer may still change).
 */
export function resolve(n: Named, full?: Map<string, Entry>): { icon?: Icon; online?: string; waiting?: boolean } {
  const logo = n.logo?.trim() || undefined;
  const fromLabel = () => bundled(n.label) ?? (full && findIn(full, n.label)) ?? bundled(n.note);
  if (logo) {
    const hit = bundled(logo) ?? (full && findIn(full, logo));
    if (hit) return { icon: hit, online: sendable(hit.title) ? hit.title : undefined };
    // not known yet: its title (the better name to ask for) may be in the full set
    if (!full) return { icon: bundled(n.label) ?? bundled(n.note), waiting: true };
    // a brand simple-icons doesn't have: the label may still give a glyph, the logo goes online as given
    return { icon: fromLabel(), online: sendable(logo) ? logo.trim() : undefined };
  }
  const hit = fromLabel();
  if (!hit && !full) return { waiting: true };
  return hit ? { icon: hit, online: sendable(hit.title) ? hit.title : undefined } : {};
}

// ───────────── loading, with one signal for everything that arrives

const [tick, setTick] = createSignal(0);
const bump = () => setTick((t) => t + 1);
if (typeof window !== "undefined") window.addEventListener("online", bump);

let full: Map<string, Entry> | undefined;
let shardLoaders: (() => Promise<{ default: Record<string, string> }>)[] = [];
let fullState: "idle" | "loading" | "failed" = "idle";
function fullIndex(): Map<string, Entry> | undefined {
  tick();
  if (full || fullState === "failed") return full ?? new Map();
  if (fullState === "idle") {
    fullState = "loading";
    import("virtual:simple-icons-all")
      .then((m) => ((full = indexOf(m.icons)), (shardLoaders = m.shards)))
      .catch(() => (fullState = "failed"))
      .finally(bump);
  }
  return undefined;
}

const shards = new Map<number, Record<string, string> | null>();
function pathOf(i: Icon): string | undefined {
  if (i.path || i.shard === undefined) return i.path;
  tick();
  const s = shards.get(i.shard);
  if (s !== undefined) return s?.[i.slug];
  shards.set(i.shard, null);
  shardLoaders[i.shard]?.()
    .then((m) => shards.set(i.shard!, m.default))
    .catch(() => {})
    .finally(bump);
  return undefined;
}

// online: a few at a time; an answer (a miss too) holds for this run, a failure for five minutes
const official = new Map<string, { logo: OfficialLogo | null; at: number }>();
const asking = new Set<string>();
const queue: string[] = [];
let active = 0;
function pump() {
  while (active < 4 && queue.length) {
    const name = queue.shift()!;
    active++;
    logoFetch(name)
      .then((logo) => official.set(name.toLowerCase(), { logo, at: Date.now() }))
      .catch(() => official.set(name.toLowerCase(), { logo: null, at: Date.now() }))
      .finally(() => (asking.delete(name.toLowerCase()), active--, pump(), bump()));
  }
}
function officialFor(name: string): OfficialLogo | undefined {
  tick();
  const k = name.toLowerCase();
  const have = official.get(k);
  if (have && (have.logo || Date.now() - have.at < 5 * 60_000)) return have.logo ?? undefined;
  if (asking.has(k) || (typeof navigator !== "undefined" && navigator.onLine === false)) return have?.logo ?? undefined;
  asking.add(k);
  queue.push(name);
  pump();
  return undefined;
}

export type BrandMark = { glyph?: { d: string; color: string }; official?: OfficialLogo };

/**
 * A diagram box's logo, reactive: the simple-icons glyph first (or nothing), the official
 * mark when it arrives. Undefined when the box names no brand; {} while its glyph loads.
 */
export function brandMark(n: Named): BrandMark | undefined {
  const want = resolve(n, fullIndex());
  const off = want.online ? officialFor(want.online) : undefined;
  if (!want.icon && !off) return undefined;
  const d = want.icon && pathOf(want.icon);
  return { glyph: d ? { d, color: glyphColor(want.icon!.hex) } : undefined, official: off };
}
