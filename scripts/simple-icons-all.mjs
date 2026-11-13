// Every simple-icons logo for diagrams, as a Vite plugin. src/ui/Logos.tsx bundles a
// few dozen logos; a name that misses them is looked up here, loaded only then:
//   virtual:simple-icons-all          [slug, title, hex, other names, shard][] + a loader per shard
//   virtual:simple-icons-shard-<n>    { slug: path } for that shard
// Made from node_modules at build time, so nothing big is committed and the main
// bundle stays as it is. simple-icons is CC0; the marks belong to their owners.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const INDEX = "virtual:simple-icons-all";
const SHARD = "virtual:simple-icons-shard-";
const SHARDS = 24;

let built;
function build() {
  if (built) return built;
  const require = createRequire(import.meta.url);
  const all = Object.values(require("simple-icons")).sort((a, b) => a.slug.localeCompare(b.slug));
  // other names ("aka") are only in the package's data file, keyed by title
  const dir = dirname(require.resolve("simple-icons"));
  const aka = new Map();
  for (const d of JSON.parse(readFileSync(join(dir, "_data", "simple-icons.json"), "utf8")).icons) {
    if (d.aliases?.aka?.length) aka.set(d.slug ?? d.title, d.aliases.aka);
  }
  const shards = Array.from({ length: SHARDS }, () => ({}));
  const index = all.map((i, n) => {
    shards[n % SHARDS][i.slug] = i.path;
    return [i.slug, i.title, i.hex, aka.get(i.slug) ?? aka.get(i.title) ?? [], n % SHARDS];
  });
  built = { index, shards };
  return built;
}

/** JSON.parse of a string literal: much faster to load than the same data as an object literal */
const json = (v) => `JSON.parse(${JSON.stringify(JSON.stringify(v))})`;

export function simpleIconsAll() {
  return {
    name: "simple-icons-all",
    resolveId(id) {
      if (id === INDEX || id.startsWith(SHARD)) return `\0${id}`;
    },
    load(id) {
      if (id === `\0${INDEX}`) {
        const loaders = Array.from({ length: SHARDS }, (_, n) => `() => import("${SHARD}${n}")`).join(",\n  ");
        return `export const icons = ${json(build().index)};\nexport const shards = [\n  ${loaders},\n];\n`;
      }
      if (id.startsWith(`\0${SHARD}`)) {
        const n = Number(id.slice(SHARD.length + 1));
        return `export default ${json(build().shards[n] ?? {})};\n`;
      }
    },
  };
}
