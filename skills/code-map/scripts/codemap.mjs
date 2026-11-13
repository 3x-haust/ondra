#!/usr/bin/env node
// The code map: one JSON file per repo that says what the system is made of
// (containers → components → files) and how the parts talk. This script reads
// the repo for facts, checks a map against the code, says who owns a file, and
// prints the map as Ondra chat blocks. Node only, no packages.
//
//   codemap.mjs where      [--repo DIR]                 the map's folder
//   codemap.mjs survey     [--repo DIR] [--depth N]     facts to build a map from
//   codemap.mjs check      [--repo DIR] [--stamp]       map vs code: errors, coverage, what changed
//   codemap.mjs owner FILE [FILE…] [--repo DIR]        the component that owns a file, and its links
//   codemap.mjs blocks     [--repo DIR] [--container ID | --component ID | --flow ID]
//   codemap.mjs from-groma [--repo DIR]                 a draft map from an existing groma/ folder
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--") && !["--stamp", "--json"].includes(all[i - 1])));

const git = (cwd, ...args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).trim();
  } catch {
    return undefined;
  }
};

const start = resolve(typeof flag("repo") === "string" ? flag("repo") : process.cwd());
const root = git(start, "rev-parse", "--show-toplevel") ?? start;
const isGit = git(root, "rev-parse", "--git-dir") !== undefined;

/**
 * Where the map lives: a map kept in the repo (.ondra/code-map/) when there is one,
 * else the repo's shared git folder (one map for every worktree, never committed),
 * else .ondra/code-map/ in a folder that isn't a repo.
 */
function mapDir() {
  if (process.env.CODEMAP_DIR) return resolve(process.env.CODEMAP_DIR);
  const inRepo = join(root, ".ondra", "code-map");
  if (existsSync(join(inRepo, "map.json"))) return inRepo;
  const common = isGit ? git(root, "rev-parse", "--path-format=absolute", "--git-common-dir") : undefined;
  return common ? join(common, "ondra", "code-map") : inRepo;
}
const mapFile = () => join(mapDir(), "map.json");

// ───────────── files

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".turbo", "vendor", "__pycache__", ".venv", "venv", "Pods", "DerivedData", ".gradle", "coverage", ".cache"]);
const LANG = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".vue": "Vue", ".svelte": "Svelte", ".astro": "Astro", ".py": "Python", ".rs": "Rust", ".go": "Go", ".swift": "Swift", ".kt": "Kotlin", ".kts": "Kotlin", ".java": "Java",
  ".scala": "Scala", ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".fs": "F#", ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".m": "Objective-C", ".mm": "Objective-C",
  ".dart": "Dart", ".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang", ".clj": "Clojure", ".hs": "Haskell", ".ml": "OCaml", ".lua": "Lua", ".r": "R", ".jl": "Julia", ".zig": "Zig",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".sql": "SQL", ".proto": "Protobuf", ".graphql": "GraphQL", ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".tf": "Terraform", ".sol": "Solidity",
};
const isSource = (f) => LANG[extname(f).toLowerCase()] !== undefined;

let fileCache;
/** Repo files, relative, with / separators: what git tracks plus new files it doesn't ignore. */
function files() {
  if (fileCache) return fileCache;
  let list;
  if (isGit) list = git(root, "ls-files", "-co", "--exclude-standard")?.split("\n").filter(Boolean);
  if (!list) {
    list = [];
    const walk = (dir, rel) => {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (list.length > 200_000) return;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        } else if (e.isFile()) list.push(rel ? `${rel}/${e.name}` : e.name);
      }
    };
    walk(root, "");
  }
  fileCache = list.filter((f) => !f.split("/").some((p) => SKIP_DIRS.has(p)) && existsSync(join(root, f)));
  return fileCache;
}

const textCache = new Map();
function text(f) {
  if (textCache.has(f)) return textCache.get(f);
  let t = "";
  try {
    const p = join(root, f);
    if (statSync(p).size < 1_000_000) t = readFileSync(p, "utf8");
  } catch {}
  textCache.set(f, t);
  return t;
}
const lines = (f) => (text(f).match(/\n/g)?.length ?? 0) + 1;

/** A path glob: `**` any depth, `*` within one folder; a bare folder means everything in it. */
function globRe(pattern) {
  let p = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!/[*?]/.test(p) && !extname(p)) p += "/**";
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
/** how specific a pattern is: an exact path beats any glob, then more literal characters win */
const specificity = (pattern) => (/[*?]/.test(pattern) ? pattern.replace(/[*?]/g, "").length - (pattern.includes("**") ? 0.5 : 0) : 1000 + pattern.length);

// ───────────── the map

function loadMap(required = true) {
  const f = mapFile();
  if (!existsSync(f)) {
    if (!required) return undefined;
    console.error(`No code map yet (${f}). Build one: see the code-map skill.`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`map.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

/** Who owns each file: the component whose most specific pattern matches it. */
function owners(map, list = files()) {
  const rules = [];
  for (const c of map.components ?? []) for (const p of c.paths ?? []) rules.push({ id: c.id, re: globRe(p), s: specificity(p), pattern: p });
  rules.sort((a, b) => b.s - a.s);
  const owner = new Map();
  for (const f of list) {
    const r = rules.find((x) => x.re.test(f));
    if (r) owner.set(f, r.id);
  }
  return { owner, rules };
}

const byIdOf = (map) => {
  const all = new Map();
  for (const [kind, list] of [["actor", map.actors], ["external", map.externals], ["container", map.containers], ["component", map.components]])
    for (const x of list ?? []) all.set(x.id, { ...x, level: kind });
  return all;
};

// ───────────── survey

function manifests() {
  const out = [];
  const pick = (f) => {
    const b = basename(f);
    const t = () => text(f);
    if (b === "package.json") {
      try {
        const j = JSON.parse(t());
        const deps = Object.keys({ ...j.dependencies }).slice(0, 14);
        out.push(`${f}: ${j.name ?? "(no name)"}${j.bin ? " · bin" : ""}${j.workspaces ? " · workspaces" : ""}${deps.length ? ` · deps: ${deps.join(", ")}` : ""}${j.scripts ? ` · scripts: ${Object.keys(j.scripts).slice(0, 8).join(", ")}` : ""}`);
      } catch {
        out.push(f);
      }
    } else if (b === "Cargo.toml") {
      const name = t().match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/)?.[1];
      const ws = /\[workspace\]/.test(t());
      const bins = [...t().matchAll(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      const deps = [...(t().split(/\[dependencies\]/)[1]?.split(/\n\[/)[0] ?? "").matchAll(/^([\w-]+)\s*=/gm)].map((m) => m[1]).slice(0, 12);
      out.push(`${f}: ${name ?? ""}${ws ? " · workspace" : ""}${bins.length ? ` · bins: ${bins.join(", ")}` : ""}${deps.length ? ` · deps: ${deps.join(", ")}` : ""}`);
    } else if (b === "go.mod") out.push(`${f}: ${t().match(/^module\s+(\S+)/m)?.[1] ?? ""}`);
    else if (b === "pyproject.toml") out.push(`${f}: ${t().match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? ""}`);
    else if (["Package.swift", "requirements.txt", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "mix.exs", "pubspec.yaml", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", "tauri.conf.json", "wrangler.toml", "vercel.json", "fly.toml", "serverless.yml", "Procfile", "Makefile", "CMakeLists.txt", "deno.json"].includes(b) || /\.csproj$|\.sln$|\.xcodeproj\/project\.pbxproj$|\.tf$/.test(f))
      out.push(f);
    else if (/^(vite|next|nuxt|astro|svelte|remix|webpack|rollup)\.config\.[cm]?[jt]s$/.test(b)) out.push(f);
  };
  for (const f of files()) if (f.split("/").length <= 4) pick(f);
  return out.slice(0, 60);
}

/** The folder a file is counted in: its first `depth` folders (a file at the top counts as "."). */
const bucket = (f, depth) => {
  const parts = f.split("/").slice(0, -1);
  return parts.length ? parts.slice(0, depth).join("/") : ".";
};

/** Local imports between source files, resolved to repo paths where the language makes that simple. */
function importEdges(src) {
  const set = new Set(src);
  const edges = [];
  const outside = new Map(); // bucket file → package names
  const tryResolve = (base) => {
    const cands = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".vue", ".svelte", ".py", ".rs"].map((e) => base + e), ...["index.ts", "index.tsx", "index.js", "mod.rs", "__init__.py"].map((i) => `${base}/${i}`)];
    const noJs = base.replace(/\.(m|c)?js$/, "");
    if (noJs !== base) cands.push(`${noJs}.ts`, `${noJs}.tsx`, `${noJs}.mts`);
    return cands.find((c) => set.has(c));
  };
  // tsconfig "paths" aliases such as "@/*": ["src/*"]
  const aliases = [];
  for (const f of files().filter((x) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(x))) {
    try {
      const j = JSON.parse(text(f).replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
      const baseUrl = posix.join(posix.dirname(f), j.compilerOptions?.baseUrl ?? ".");
      for (const [k, v] of Object.entries(j.compilerOptions?.paths ?? {})) aliases.push([k.replace(/\*$/, ""), posix.join(baseUrl, String(v[0]).replace(/\*$/, ""))]);
    } catch {}
  }
  const goMod = files().find((f) => f === "go.mod");
  const goModule = goMod ? text(goMod).match(/^module\s+(\S+)/m)?.[1] : undefined;
  for (const f of src) {
    const ext = extname(f);
    const t = text(f);
    const dir = posix.dirname(f);
    const add = (target) => target && target !== f && edges.push([f, target]);
    if (/^\.(m|c)?[jt]sx?$|^\.vue$|^\.svelte$|^\.astro$/.test(ext)) {
      for (const m of t.matchAll(/(?:^|[^\w.])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (spec.startsWith(".")) add(tryResolve(posix.normalize(posix.join(dir, spec))));
        else {
          const alias = aliases.find(([k]) => spec.startsWith(k));
          if (alias) add(tryResolve(posix.normalize(alias[1] + spec.slice(alias[0].length))));
          else if (!spec.startsWith("node:") && /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@/-]*)?$/i.test(spec) && !/^[^/]*\.(css|scss|json|svg|png|html)$/.test(spec)) {
            const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
            (outside.get(f) ?? outside.set(f, new Set()).get(f)).add(pkg);
          }
        }
      }
    } else if (ext === ".py") {
      for (const m of t.matchAll(/^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))/gm)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith(".")) {
          const up = spec.match(/^\.+/)[0].length;
          add(tryResolve(posix.join(dir, ...Array(up - 1).fill(".."), spec.slice(up).replace(/\./g, "/"))));
        } else add(tryResolve(spec.replace(/\./g, "/")) ?? tryResolve(posix.join(dir, spec.replace(/\./g, "/"))));
      }
    } else if (ext === ".rs") {
      const crate = f.includes("/src/") ? f.slice(0, f.lastIndexOf("/src/") + 4) : dir;
      for (const m of t.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) add(tryResolve(posix.join(/(main|lib|mod)\.rs$/.test(f) ? dir : f.replace(/\.rs$/, ""), m[1])));
      for (const m of t.matchAll(/\buse\s+crate::(\w+)/g)) add(tryResolve(posix.join(crate, m[1])));
    } else if (ext === ".go" && goModule) {
      for (const m of t.matchAll(/"([^"\s]+)"/g)) {
        if (!m[1].startsWith(`${goModule}/`)) continue;
        const pkg = m[1].slice(goModule.length + 1);
        const target = src.find((x) => posix.dirname(x) === pkg && x.endsWith(".go"));
        add(target);
      }
    }
  }
  return { edges, outside };
}

/** Calls across a process boundary that imports can't show. */
function boundaryHints(src) {
  const out = [];
  // Tauri: invoke("cmd") in the web side ↔ #[tauri::command] fn cmd in Rust
  const commands = new Map();
  for (const f of src.filter((x) => x.endsWith(".rs")))
    for (const m of text(f).matchAll(/#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g)) commands.set(m[1], f);
  if (commands.size) {
    const pairs = new Map();
    // invoke("cmd") or a wrapper of it: any quoted name of a command counts
    for (const f of src.filter((x) => /\.[cm]?[jt]sx?$|\.vue$|\.svelte$/.test(x) && !/\.test\.|\.spec\./.test(x)))
      for (const m of text(f).matchAll(/["'`](\w{4,})["'`]/g)) {
        const target = commands.get(m[1]);
        if (target) {
          const k = `${f} → ${target}`;
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
      }
    out.push(`Tauri commands: ${commands.size} in Rust; named from the web side (file → Rust file, names):`);
    for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 25)) out.push(`  ${k} (${n})`);
  }
  // HTTP routes served, and where requests are made
  const served = src.filter((f) => /\b(app|router|server|r)\.(get|post|put|delete|patch)\(\s*["'`]\/|@(Get|Post|Put|Delete)Mapping|@app\.(get|post|route)\(|HandleFunc\(\s*"|\.route\(\s*"\//.test(text(f)));
  if (served.length) out.push(`Serves HTTP routes: ${served.slice(0, 12).join(", ")}${served.length > 12 ? ` (+${served.length - 12})` : ""}`);
  const clients = src.filter((f) => /\bfetch\(|axios\.|reqwest::|URLSession|requests\.(get|post)|http\.(Get|Post)\(/.test(text(f)));
  if (clients.length) out.push(`Makes HTTP requests: ${clients.slice(0, 12).join(", ")}${clients.length > 12 ? ` (+${clients.length - 12})` : ""}`);
  // child processes and sockets
  const spawns = src.filter((f) => /\bspawn\(|execFile\(|Command::new\(|Process\(\)|subprocess\.|exec\.Command\(/.test(text(f)));
  if (spawns.length) out.push(`Starts processes: ${spawns.slice(0, 12).join(", ")}${spawns.length > 12 ? ` (+${spawns.length - 12})` : ""}`);
  const sockets = src.filter((f) => /new WebSocket\(|UnixStream|UnixListener|TcpListener|createServer\(|NWConnection|net\.Listen\(/.test(text(f)));
  if (sockets.length) out.push(`Sockets / servers: ${sockets.slice(0, 12).join(", ")}${sockets.length > 12 ? ` (+${sockets.length - 12})` : ""}`);
  return out;
}

function survey() {
  const depth = Number(flag("depth") ?? 2);
  const all = files();
  const src = all.filter(isSource);
  const out = [`# Survey of ${root}`, `${all.length} files, ${src.length} source files${isGit ? `, HEAD ${git(root, "rev-parse", "--short", "HEAD") ?? "?"}` : ""}`, ""];
  const langs = new Map();
  for (const f of src) {
    const l = LANG[extname(f).toLowerCase()];
    const n = lines(f);
    const x = langs.get(l) ?? { files: 0, lines: 0 };
    langs.set(l, { files: x.files + 1, lines: x.lines + n });
  }
  out.push("## Languages (files · lines)", [...langs].sort((a, b) => b[1].lines - a[1].lines).map(([l, x]) => `${l} ${x.files} · ${x.lines}`).join("; "), "");
  out.push("## Manifests and entry points", ...manifests(), "");
  const entries = src.filter((f) => /(^|\/)(main|index|app|App|server|cli|lib|mod)\.[a-z]+$/.test(f) && f.split("/").length <= 4).slice(0, 40);
  if (entries.length) out.push(`Likely entry files: ${entries.join(", ")}`, "");

  const folders = new Map();
  for (const f of src) {
    const b = bucket(f, depth);
    const x = folders.get(b) ?? { files: 0, lines: 0, langs: new Set() };
    x.files++;
    x.lines += lines(f);
    x.langs.add(LANG[extname(f).toLowerCase()]);
    folders.set(b, x);
  }
  out.push(`## Folders (first ${depth} levels; source files · lines · languages)`);
  for (const [b, x] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`${b}: ${x.files} · ${x.lines} · ${[...x.langs].join("/")}`);
  out.push("");

  const { edges, outside } = importEdges(src);
  const dirEdges = new Map();
  for (const [a, b] of edges) {
    const k = `${bucket(a, depth)} → ${bucket(b, depth)}`;
    if (bucket(a, depth) !== bucket(b, depth)) dirEdges.set(k, (dirEdges.get(k) ?? 0) + 1);
  }
  out.push(`## Imports between folders (count; ${edges.length} resolved file imports in all)`);
  for (const [k, n] of [...dirEdges].sort((a, b) => b[1] - a[1]).slice(0, 80)) out.push(`${k} (${n})`);
  out.push("");
  const pkgs = new Map();
  for (const [f, set] of outside) for (const p of set) (pkgs.get(p) ?? pkgs.set(p, new Set()).get(p)).add(bucket(f, depth));
  if (pkgs.size) {
    out.push("## Outside packages (used in folders)");
    for (const [p, set] of [...pkgs].sort((a, b) => b[1].size - a[1].size).slice(0, 40)) out.push(`${p}: ${[...set].slice(0, 6).join(", ")}${set.size > 6 ? ` (+${set.size - 6})` : ""}`);
    out.push("");
  }
  // the most imported files: usually the core types and services
  const fanIn = new Map();
  for (const [, b] of edges) fanIn.set(b, (fanIn.get(b) ?? 0) + 1);
  out.push("## Most imported files", [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([f, n]) => `${f} (${n})`).join(", "), "");
  const hints = boundaryHints(src);
  if (hints.length) out.push("## Across process boundaries", ...hints, "");
  const groma = ["groma", ".groma"].find((d) => existsSync(join(root, d, "project.md")));
  if (groma) out.push(`## A Groma map exists (${groma}/): start from it with \`codemap.mjs from-groma\``, "");
  const map = loadMap(false);
  out.push(map ? `## A code map exists: ${mapFile()} (built ${map.built?.commit?.slice(0, 7) ?? "?"}) — run \`check\` before rebuilding` : `Map file to write: ${mapFile()}`);
  console.log(out.join("\n"));
}

// ───────────── check

function check() {
  const map = loadMap();
  const errors = [];
  const warn = [];
  const ids = new Map();
  for (const [kind, list] of [["actors", map.actors], ["externals", map.externals], ["containers", map.containers], ["components", map.components]]) {
    if (list !== undefined && !Array.isArray(list)) errors.push(`${kind} must be a list`);
    for (const x of list ?? []) {
      if (!x.id || !/^[\p{Ll}\p{N}][\p{Ll}\p{N}-]*$/u.test(x.id)) errors.push(`${kind}: id "${x.id}" must be lowercase-kebab`);
      if (ids.has(x.id)) errors.push(`id "${x.id}" is used twice`);
      ids.set(x.id, kind);
      if (!x.label) errors.push(`${x.id}: no label`);
    }
  }
  if (!map.containers?.length) errors.push("no containers: a map needs at least one");
  for (const c of map.components ?? []) {
    if (ids.get(c.container) !== "containers") errors.push(`${c.id}: container "${c.container}" is not a container id`);
    if (!c.paths?.length) errors.push(`${c.id}: no paths (which files are it?)`);
    if (!c.note) warn.push(`${c.id}: no note (what it does, in a few words)`);
  }
  for (const c of map.containers ?? []) if (!c.note) warn.push(`${c.id}: no note`);
  for (const [i, r] of (map.relations ?? []).entries()) {
    if (!ids.has(r.from)) errors.push(`relation ${i + 1}: from "${r.from}" is not an id`);
    if (!ids.has(r.to)) errors.push(`relation ${i + 1}: to "${r.to}" is not an id`);
    if (!r.label) warn.push(`relation ${r.from} → ${r.to}: no label (a verb: "저장", "calls", "streams events")`);
  }
  for (const fl of map.flows ?? []) for (const s of fl.steps ?? []) if (!ids.has(s.from) || !ids.has(s.to)) errors.push(`flow ${fl.id}: step ${s.from} → ${s.to} names an unknown id`);
  // pictures a newcomer can read: plain verbs, flows of six parts at most, names that fit
  for (const r of map.relations ?? []) if (codeLike(r.label)) warn.push(`relation ${r.from} → ${r.to}: "${r.label}" names code; say what happens and put the mechanism in tech`);
  if (!errors.length) {
    const byId = byIdOf(map);
    const containerOf = (id) => (byId.get(id)?.level === "component" ? byId.get(id).container : id);
    for (const fl of map.flows ?? []) {
      const { steps, parts, name } = flowSteps(map, fl, byId, containerOf);
      if (parts.length > MAX_PARTS) errors.push(`flow ${fl.id}: ${parts.length} parts even with components folded into containers (at most ${MAX_PARTS}): drop minor hops`);
      for (const s of steps) if (codeLike(s.label)) warn.push(`flow ${fl.id}: step "${s.label}" names code; say what happens`);
      for (const id of parts) if ([...name(id)].length > 10) warn.push(`flow ${fl.id}: "${name(id)}" is too long for the picture; give ${id} a short name (≤ 10 characters)`);
    }
  }

  const all = files();
  const src = all.filter(isSource);
  const { owner, rules } = owners(map, all);
  for (const r of rules) if (!all.some((f) => r.re.test(f))) errors.push(`${r.id}: path "${r.pattern}" matches no file`);
  for (const c of map.components ?? []) {
    const ref = c.entry?.replace(/:\d+(:\d+)?$/, "");
    if (ref && !existsSync(join(root, ref))) errors.push(`${c.id}: entry "${c.entry}" does not exist`);
  }
  const owned = src.filter((f) => owner.has(f));
  const unowned = src.filter((f) => !owner.has(f) && !(map.ignore ?? []).some((p) => globRe(p).test(f)));
  const ignored = src.length - owned.length - unowned.length;
  const out = [`# Code map check: ${mapFile()}`];
  out.push(`${map.containers?.length ?? 0} containers, ${map.components?.length ?? 0} components, ${map.relations?.length ?? 0} relations, ${map.flows?.length ?? 0} flows`);
  out.push(`Source files owned by a component: ${owned.length}/${src.length - ignored} (${Math.round((owned.length / Math.max(1, src.length - ignored)) * 100)}%)${ignored ? `, ${ignored} ignored` : ""}`);
  if (unowned.length) {
    const groups = new Map();
    for (const f of unowned) groups.set(bucket(f, 2), (groups.get(bucket(f, 2)) ?? 0) + 1);
    out.push(`Not on the map (folder: files): ${[...groups].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => `${d}: ${n}`).join(", ")}`);
  }
  // what changed since the map was last checked against the code
  const base = map.built?.commit;
  if (isGit && base) {
    const known = git(root, "cat-file", "-e", `${base}^{commit}`) !== undefined;
    if (!known) warn.push(`built.commit ${base.slice(0, 7)} is not in this repo: check the whole map`);
    else {
      const ancestor = git(root, "merge-base", "--is-ancestor", base, "HEAD") !== undefined;
      if (!ancestor) warn.push(`built.commit ${base.slice(0, 7)} is not in this branch's history (another branch updated the map): the list below compares the two trees`);
      const changed = (git(root, "diff", "--name-status", "--no-renames", base) ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"));
      for (const f of (git(root, "ls-files", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean)) changed.push(["A", f]);
      const touched = new Map();
      const added = [];
      const removed = [];
      for (const [st, f] of changed) {
        if (!isSource(f)) continue;
        const o = owner.get(f) ?? owners(map, [f]).owner.get(f);
        if (o) (touched.get(o) ?? touched.set(o, new Set()).get(o)).add(f);
        if (st === "A" && !o) added.push(f);
        if (st === "D") removed.push(f);
      }
      out.push(`Since ${base.slice(0, 7)}: ${changed.length} files changed`);
      if (touched.size) out.push("Components whose files changed (re-read them; fix notes and relations that are no longer true):", ...[...touched].map(([id, set]) => `  ${id}: ${[...set].slice(0, 6).join(", ")}${set.size > 6 ? ` (+${set.size - 6})` : ""}`));
      if (added.length) out.push(`New files no component owns: ${added.slice(0, 20).join(", ")}${added.length > 20 ? ` (+${added.length - 20})` : ""}`);
      if (removed.length) out.push(`Deleted: ${removed.slice(0, 20).join(", ")}`);
    }
  } else if (isGit) warn.push("no built.commit: run check --stamp once the map is right");
  if (errors.length) out.push("", "Errors:", ...errors.map((e) => `  ✗ ${e}`));
  if (warn.length) out.push("", "Warnings:", ...warn.slice(0, 30).map((e) => `  • ${e}`));
  if (flag("stamp")) {
    if (errors.length) out.push("", "Not stamped: fix the errors first.");
    else if (isGit) {
      map.built = { ...map.built, commit: git(root, "rev-parse", "HEAD"), at: new Date().toISOString().slice(0, 10) };
      writeFileSync(mapFile(), `${JSON.stringify(map, null, 2)}\n`);
      out.push("", `Stamped at ${map.built.commit.slice(0, 7)}.`);
    }
  }
  console.log(out.join("\n"));
  process.exitCode = errors.length ? 1 : 0;
}

// ───────────── owner

function owner() {
  const map = loadMap();
  const byId = byIdOf(map);
  const asked = positional.map((p) => {
    const abs = resolve(start, p);
    return relative(root, abs).split("\\").join("/");
  });
  if (!asked.length) {
    console.error("usage: codemap.mjs owner FILE [FILE…]");
    process.exit(2);
  }
  const { owner: own } = owners(map, asked);
  const out = [];
  for (const f of asked) {
    const id = own.get(f);
    if (!id) {
      out.push(isSource(f) ? `${f}: no component owns it (add it to one, or a new component, when you change it)` : `${f}: not source code; the map doesn't track it`);
      continue;
    }
    const c = byId.get(id);
    const cont = byId.get(c.container);
    out.push(`${f} → ${c.label} (${id}) in ${cont?.label ?? c.container}: ${c.note ?? ""}`);
    for (const r of map.relations ?? []) {
      if (r.from === id) out.push(`  → ${byId.get(r.to)?.label ?? r.to}: ${r.label ?? ""}${r.tech ? ` [${r.tech}]` : ""}`);
      if (r.to === id) out.push(`  ← ${byId.get(r.from)?.label ?? r.from}: ${r.label ?? ""}${r.tech ? ` [${r.tech}]` : ""}`);
    }
    if (c.gotchas?.length) out.push(...c.gotchas.map((g) => `  ! ${g}`));
  }
  console.log(out.join("\n"));
}

// ───────────── blocks

const home = process.env.HOME;
/** a path the chat can open: absolute, with the home folder as ~ */
const abs = (ref) => {
  if (!ref) return undefined;
  const p = ref.startsWith("/") ? ref : join(root, ref);
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
};
const KINDS = new Set(["user", "app", "service", "function", "db", "cache", "queue", "storage", "external", "gateway"]);

/** Relations seen at one level: each end lifted to the node that stands for it there, one entry per direction. */
function lifted(map, standFor) {
  const seen = new Map();
  for (const r of map.relations ?? []) {
    const a = standFor(r.from);
    const b = standFor(r.to);
    if (!a || !b || a === b) continue;
    const k = `${a}>${b}`;
    const direct = r.from === a && r.to === b;
    const x = seen.get(k) ?? seen.set(k, { from: a, to: b, labels: [], count: 0, async: true, overview: false, out: 0 }).get(k);
    x.count++;
    if (r.label && !x.labels.includes(r.label)) direct ? x.labels.unshift(r.label) : x.labels.push(r.label);
    x.async &&= !!r.async;
    if (r.overview === true) x.overview = true;
    if (r.overview === false) x.out++;
  }
  // forced in by any of its relations, left out only when all of them say so
  return [...seen.values()].map(({ out, ...x }) => ({ ...x, overview: x.overview ? true : out === x.count ? false : undefined }));
}

/** A label that names code (agent_spawn, bridge:call, invoke) instead of saying what happens. */
const CODE_WORD = /^(invoke|emit|spawn|exec|rpc|ipc|dispatch|subscribe|listen|callback)$/i;
const codeLike = (label) => !!label && (/[_`]|::|\w:\w|\(\)|=>|[a-z][A-Z]/.test(label) || label.split(/\s*[·,/]\s*/).some((w) => CODE_WORD.test(w.trim())));

/**
 * The overview's lines: one per pair of boxes (the busier direction, the other one's verb
 * added), and only the main ones: every box keeps its busiest line, then the busiest of the
 * rest up to a cap. `overview: true|false` on a relation forces it in or out.
 */
function overviewEdges(map, standFor, boxes, all_ = false) {
  const pairs = new Map();
  const order = new Map(boxes.map((id, i) => [id, i]));
  for (const e of lifted(map, standFor)) {
    const k = [e.from, e.to].sort().join("|");
    const p = pairs.get(k);
    if (!p) {
      pairs.set(k, { ...e, label: e.labels[0], weight: e.count });
      continue;
    }
    // both ways: one line, drawn the way a request goes (from the box listed first), both verbs on it
    const [main, back] = (order.get(e.from) ?? 0) < (order.get(p.from) ?? 0) ? [e, p] : [p, e];
    const label = [main.labels[0], back.labels[0] ?? back.label].filter(Boolean).join(" ⇄ ") || undefined;
    pairs.set(k, { ...main, label, weight: p.weight + e.count, async: main.async && back.async, overview: p.overview || e.overview ? true : p.overview === false && e.overview === false ? false : undefined });
  }
  const all = [...pairs.values()].filter((e) => all_ || e.overview !== false).sort((a, b) => b.weight - a.weight);
  if (all_) return all.map((e) => ({ from: e.from, to: e.to, label: e.label, async: e.async || undefined }));
  const keep = new Set(all.filter((e) => e.overview === true));
  for (const id of boxes) {
    const best = all.find((e) => e.from === id || e.to === id);
    if (best) keep.add(best);
  }
  const cap = Math.max(5, Math.round(boxes.length * 0.75));
  for (const e of all) if (keep.size < cap) keep.add(e);
  return all.filter((e) => keep.has(e)).map((e) => ({ from: e.from, to: e.to, label: e.label, async: e.async || undefined }));
}

const MAX_PARTS = 6;
/** A flow as drawn: past six parts, components fold into their containers and the hops inside one container go. */
function flowSteps(map, fl, byId, containerOf) {
  const parts = (st) => new Set(st.flatMap((s) => [s.from, s.to]));
  const plain = (s, from, to) => {
    if (s.label && !codeLike(s.label)) return s.label;
    const r = (map.relations ?? []).find((x) => x.from === from && x.to === to && x.label && !codeLike(x.label));
    return r?.label ?? s.label;
  };
  let steps = (fl.steps ?? []).map((s) => ({ from: s.from, to: s.to, label: plain(s, s.from, s.to), note: s.note }));
  if (parts(steps).size > MAX_PARTS) {
    steps = steps
      .map((s) => ({ ...s, from: containerOf(s.from) ?? s.from, to: containerOf(s.to) ?? s.to }))
      .filter((s) => s.from !== s.to)
      .filter((s, i, all) => !(i && all[i - 1].from === s.from && all[i - 1].to === s.to));
  }
  const name = (id) => byId.get(id)?.short ?? byId.get(id)?.label ?? id;
  return { steps, parts: [...parts(steps)], name };
}

const clean = (o) => JSON.stringify(o, (_, v) => (v === undefined || (Array.isArray(v) && !v.length) ? undefined : v));

function blocks() {
  const map = loadMap();
  const byId = byIdOf(map);
  const out = [];
  const containerOf = (id) => {
    const x = byId.get(id);
    return !x ? undefined : x.level === "component" ? x.container : id;
  };
  const kindOf = (x, fallback) => (x?.level === "actor" ? "user" : KINDS.has(x?.kind) ? x.kind : x?.level === "external" ? "external" : fallback);
  const cId = flag("container");
  const compId = flag("component");
  const flowId = flag("flow");
  if (typeof cId === "string") {
    const cont = byId.get(cId);
    if (!cont || cont.level !== "container") throw new Error(`no container "${cId}"; containers: ${(map.containers ?? []).map((c) => c.id).join(", ")}`);
    const mine = (map.components ?? []).filter((c) => c.container === cId);
    const inside = new Set(mine.map((c) => c.id));
    // a component of this container stands for itself; anything else for its container (or itself)
    const standFor = (id) => (inside.has(id) ? id : containerOf(id));
    const touching = lifted(map, standFor).filter((e) => inside.has(e.from) || inside.has(e.to));
    const outsideIds = [...new Set(touching.flatMap((e) => [e.from, e.to]).filter((id) => !inside.has(id)))];
    // one line per pair here too, every pair shown (outside to outside never was)
    const near = (id) => {
      const x = standFor(id);
      return inside.has(x) || outsideIds.includes(x) ? x : undefined;
    };
    const edges = overviewEdges(map, near, [...inside, ...outsideIds], true).filter((e) => inside.has(e.from) || inside.has(e.to));
    // the same picture as the system one, one level down: this container as the zone, its neighbours around it
    const nodes = [
      ...mine.map((c) => ({ id: c.id, label: c.label, zone: cId, kind: kindOf(c, "service"), note: c.note, logo: c.logo, ref: abs(c.entry ?? (c.paths?.[0] && !/[*?]/.test(c.paths[0]) && extname(c.paths[0]) ? c.paths[0] : undefined)) })),
      ...outsideIds.map((id) => {
        const x = byId.get(id);
        return { id, label: x?.label ?? id, kind: kindOf(x, "app"), note: x?.tech ?? x?.note, logo: x?.logo };
      }),
    ];
    out.push(clean({ type: "arch", label: `${cont.label} 안`, zones: [{ id: cId, label: cont.label }], nodes, edges, say: cont.note }));
  } else if (typeof compId === "string") {
    const c = byId.get(compId);
    if (!c || c.level !== "component") throw new Error(`no component "${compId}"`);
    const { owner: own } = owners(map);
    const mineFiles = [...own].filter(([, id]) => id === compId).map(([f]) => f).filter(isSource);
    out.push(clean({ type: "tree", label: `${c.label} 파일`, unit: "줄", items: mineFiles.slice(0, 40).map((f) => ({ path: f, value: lines(f), note: c.files?.[f] })) }));
    const rows = (map.relations ?? []).filter((r) => r.from === compId || r.to === compId).map((r) => [r.from === compId ? "→" : "←", byId.get(r.from === compId ? r.to : r.from)?.label ?? "", r.label ?? "", r.tech ?? ""]);
    if (rows.length) out.push(clean({ type: "table", columns: ["", "상대", "하는 일", "방식"], rows }));
  } else if (typeof flowId === "string") {
    const fl = (map.flows ?? []).find((f) => f.id === flowId);
    if (!fl) throw new Error(`no flow "${flowId}"; flows: ${(map.flows ?? []).map((f) => f.id).join(", ")}`);
    const { steps, parts, name } = flowSteps(map, fl, byId, containerOf);
    if (parts.length > MAX_PARTS) console.error(`flow ${flowId}: ${parts.length} parts even at container level (at most ${MAX_PARTS}); cut minor hops in map.json`);
    out.push(clean({ type: "sequence", label: fl.label, actors: parts.map(name), steps: steps.map((s) => ({ from: name(s.from), to: name(s.to), label: s.label, note: s.note })) }));
  } else {
    // the whole system: who uses it, its containers, what it talks to outside; the main lines only
    const sys = map.system?.label ?? basename(root);
    const zones = [{ id: "sys", label: sys }];
    if (map.externals?.length) zones.push({ id: "outside", label: map.system?.outside ?? "외부" });
    const nodes = [
      ...(map.actors ?? []).map((a) => ({ id: a.id, label: a.label, kind: "user", note: a.note })),
      ...(map.containers ?? []).map((c) => ({ id: c.id, label: c.label, zone: "sys", kind: kindOf(c, "app"), note: c.tech ?? c.note, logo: c.logo, ref: abs(c.entry) })),
      ...(map.externals ?? []).map((x) => ({ id: x.id, label: x.label, zone: "outside", kind: kindOf(x, "external"), note: x.note, logo: x.logo })),
    ];
    const edges = overviewEdges(map, containerOf, nodes.map((n) => n.id));
    out.push(clean({ type: "arch", label: map.system?.label ? `${map.system.label} 구조` : "구조", zones, nodes, edges, say: map.summary }));
  }
  console.log(["```blocks", ...out, "```"].join("\n"));
}

// ───────────── from-groma

/** The small YAML Groma writes in frontmatter: nested maps, lists of maps, plain scalars. */
function yaml(src) {
  const L = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  const scalar = (s) => {
    s = s.trim();
    if (/^".*"$/.test(s)) return JSON.parse(s);
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    return s;
  };
  const block = (ind) => {
    if (!L[i].trim().startsWith("- ")) return map(ind);
    const arr = [];
    while (i < L.length && indentOf(L[i]) === ind && L[i].trim().startsWith("- ")) {
      const rest = L[i].trim().slice(2);
      if (/^[\w-]+:(\s|$)/.test(rest)) {
        L[i] = " ".repeat(ind + 2) + rest; // the item's first key, as if on its own line
        arr.push(map(ind + 2));
      } else {
        i++;
        arr.push(scalar(rest));
      }
    }
    return arr;
  };
  const map = (ind) => {
    const obj = {};
    while (i < L.length) {
      const li = indentOf(L[i]);
      if (li < ind) break;
      const kv = L[i].trim().match(/^([\w-]+):\s*(.*)$/);
      i++;
      if (li > ind || !kv) continue;
      if (kv[2] === "|" || kv[2] === ">" || kv[2] === "|-" || kv[2] === ">-") {
        const text = [];
        while (i < L.length && indentOf(L[i]) > ind) text.push(L[i++].trim());
        obj[kv[1]] = text.join(kv[2].startsWith("|") ? "\n" : " ");
      } else if (kv[2]) obj[kv[1]] = scalar(kv[2]);
      else if (i < L.length && (indentOf(L[i]) > ind || (indentOf(L[i]) === ind && L[i].trim().startsWith("- ")))) obj[kv[1]] = block(indentOf(L[i]));
      else obj[kv[1]] = null;
    }
    return obj;
  };
  return L.length ? map(indentOf(L[0])) : {};
}

function fromGroma() {
  const dir = ["groma", ".groma"].map((d) => join(root, d)).find((d) => existsSync(join(d, "project.md")));
  if (!dir) {
    console.error("No groma/ or .groma/ folder with project.md here.");
    process.exit(2);
  }
  const docs = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && e.name !== "index.md" && e.name !== "log.md") docs.push(p);
    }
  };
  walk(dir);
  const map = { version: 1, system: {}, summary: "", built: { from: `groma (${relative(root, dir)})` }, actors: [], externals: [], containers: [], components: [], relations: [], flows: [] };
  const fileOwner = new Map();
  const bodies = [];
  const titleOf = new Map();
  const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  for (const p of docs) {
    const t = readFileSync(p, "utf8");
    const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) continue;
    const fm = yaml(m[1]);
    const body = m[2].trim();
    const g = fm.groma ?? {};
    const id = g.id ?? slug(fm.title ?? basename(p, ".md"));
    const prose = body.split(/\n## /)[0].trim().split("\n\n")[0]?.replace(/\s+/g, " ").slice(0, 160);
    const note = (fm.description || prose || "").slice(0, 120) || undefined;
    if (fm.type === "Groma Project") {
      map.system.label = fm.title;
      map.summary = (fm.description || prose || "").slice(0, 300);
      continue;
    }
    titleOf.set(id, fm.title ?? id);
    const code = Array.isArray(g.code) ? g.code.map((c) => c?.file).filter(Boolean) : [];
    if (fm.type === "C4 Actor") map.actors.push({ id, label: fm.title, note });
    else if (fm.type === "C4 System" && (p.includes(`${join(dir, "externals")}/`) || g.external)) map.externals.push({ id, label: fm.title, note });
    else if (fm.type === "C4 System") map.system.label ??= fm.title;
    else if (fm.type === "C4 Container") map.containers.push({ id, label: fm.title, note, tech: g.technology });
    else if (fm.type === "C4 Component") {
      const files = [...new Set(code)];
      for (const f of files) fileOwner.set(f, id);
      map.components.push({ id, container: g.parent, label: fm.title, note, group: g.group, paths: files, ...(files[0] ? { entry: files[0] } : {}), tech: g.technology });
    } else if (fm.type?.includes("Flow")) map.flows.push({ id, label: fm.title, steps: [], _body: body, _path: p });
    bodies.push({ p, id, body });
  }
  // components placed straight under the system: one "unplaced" container, as Groma draws them
  const containerIds = new Set(map.containers.map((c) => c.id));
  if (map.components.some((c) => !containerIds.has(c.container))) {
    map.containers.push({ id: "unplaced", label: "Unplaced", note: "Groma: components without a container" });
    for (const c of map.components) if (!containerIds.has(c.container)) c.container = "unplaced";
  }
  // relationship rows: | [source](link) | [target](link) | description | technology |
  const target = (from, link) => {
    const clean = decodeURIComponent(link.replace(/^<|>$/g, ""));
    const absPath = resolve(dirname(from), clean);
    const rel = relative(root, absPath).split("\\").join("/");
    if (fileOwner.has(rel)) return fileOwner.get(rel);
    const doc = basename(absPath, ".md");
    if (titleOf.has(doc)) return doc;
    const parentDoc = basename(dirname(absPath));
    return titleOf.has(parentDoc) ? parentDoc : undefined;
  };
  // inline links and reference-style ones ([Payments][payments] … [payments]: ../path.md)
  const linkIn = (cell, body) => {
    const inline = cell.match(/\]\(([^)]+)\)/)?.[1];
    if (inline) return inline;
    const ref = cell.match(/\]\[([^\]]+)\]/)?.[1];
    if (!ref) return undefined;
    return body.match(new RegExp(`^\\[${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:\\s*(\\S+)`, "m"))?.[1];
  };
  const rowsOf = (section) => section.split("\n").filter((l) => /^\|\s*\[/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  for (const { p, id, body } of bodies) {
    const sections = body.split(/\n(?=## )/);
    for (const s of sections) {
      const head = s.match(/^## (.+)/)?.[1] ?? "";
      if (!/relationships/i.test(head) || /draft/i.test(head)) continue;
      for (const cells of rowsOf(s)) {
        const la = linkIn(cells[0], body);
        const lb = linkIn(cells[1], body);
        const a = la ? target(p, la) : id;
        const b = lb ? target(p, lb) : undefined;
        if (a && b && a !== b) map.relations.push({ from: a, to: b, label: cells[2] || undefined, tech: cells[3] || undefined, ...(/derived/i.test(head) ? { by: "scan" } : {}) });
      }
    }
  }
  for (const fl of map.flows) {
    const steps = fl._body.split(/\n(?=## )/).find((x) => /^## Steps/.test(x)) ?? "";
    for (const cells of rowsOf(steps)) {
      const la = linkIn(cells[0], fl._body);
      const lb = linkIn(cells[1], fl._body);
      const a = la && target(fl._path, la);
      const b = lb && target(fl._path, lb);
      if (a && b) fl.steps.push({ from: a, to: b, label: cells[2] || undefined });
    }
    delete fl._body;
    delete fl._path;
  }
  map.flows = map.flows.filter((f) => f.steps.length);
  const outDir = mapDir();
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, existsSync(join(outDir, "map.json")) ? "map.from-groma.json" : "map.json");
  writeFileSync(outFile, `${JSON.stringify(map, null, 2)}\n`);
  console.log(`${outFile}: ${map.containers.length} containers, ${map.components.length} components, ${map.relations.length} relations, ${map.flows.length} flows from ${relative(root, dir)}/.`);
  console.log("Groma keeps one component per scanned file until someone curates it: merge them into real parts, then run check.");
}

// ───────────── main

try {
  if (cmd === "where") console.log(mapFile());
  else if (cmd === "survey") survey();
  else if (cmd === "check") check();
  else if (cmd === "owner") owner();
  else if (cmd === "blocks") blocks();
  else if (cmd === "from-groma") fromGroma();
  else {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
