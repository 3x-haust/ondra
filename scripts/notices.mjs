// The licenses of the open-source code Ondra ships, gathered at bundle time (MIT, Apache-2.0 and
// most others ask for their notice to travel with every copy, binaries included):
//   • the app: its web view's npm packages and its Rust crates, and ondra-remote's crates
//     → src-tauri/resources/notices/THIRD_PARTY_NOTICES.txt (shipped in the app)
//   • the engine: the pi coding agent it is built from and the npm packages compiled into it
//     → <engine component>/LICENSE and THIRD_PARTY_NOTICES.txt
// Each package's own license files are copied as they are; packages with the same text are listed
// together over one copy of it. A package with no license file is named with its license id and
// where its source is.
//
//   node scripts/notices.mjs            writes the app's notices (the engine's come from bundle.mjs)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([._-].*)?$/i;

/** the license and notice files in a package folder, as they are */
function licenseTexts(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile());
  } catch {
    return [];
  }
  // some keep it one folder down (dist/, docs/)
  if (!names.length) {
    for (const sub of ["dist", "docs", "doc", "license", "licenses"]) {
      const found = licenseTexts.inner(join(dir, sub));
      if (found.length) return found.map((t) => ({ ...t, file: `${sub}/${t.file}` }));
    }
  }
  return names.sort().map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() }));
}
licenseTexts.inner = (dir) => {
  try {
    return readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() }));
  } catch {
    return [];
  }
};

/** @typedef {{ name: string, version: string, license: string, source?: string, dir?: string }} Pkg */

/** The web view's npm packages (production only), as pnpm resolved them. */
export function appNpm(cwd = root) {
  const out = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  /** @type {Pkg[]} */
  const list = [];
  for (const [license, pkgs] of Object.entries(JSON.parse(out))) {
    for (const p of pkgs) p.versions.forEach((v, i) => list.push({ name: p.name, version: v, license, source: p.homepage, dir: p.paths[i] }));
  }
  return list;
}

/** A crate graph's packages (every crate Cargo.lock resolves for it, the package itself left out). */
export function cargoCrates(manifest) {
  const out = execFileSync("cargo", ["metadata", "--manifest-path", manifest, "--format-version", "1", "--locked"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
  const meta = JSON.parse(out);
  const members = new Set(meta.workspace_members);
  return meta.packages
    .filter((p) => !members.has(p.id))
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? p.license_file ?? "unknown", source: p.repository ?? `https://crates.io/crates/${p.name}`, dir: dirname(p.manifest_path) }));
}

/** The npm packages a package needs to run (dependencies and optional ones), followed down, found as Node finds them. */
export function npmRuntime(pkgDir) {
  /** @type {Map<string, Pkg>} */
  const seen = new Map();
  const find = (from, name) => {
    for (let d = from; ; d = dirname(d)) {
      const p = join(d, "node_modules", name);
      if (existsSync(join(p, "package.json"))) return realpathSync(p);
      if (dirname(d) === d) return undefined;
    }
  };
  const walk = (dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const at = find(dir, name);
      if (!at) continue;
      const dep = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
      const key = `${dep.name}@${dep.version}`;
      if (seen.has(key)) continue;
      const license = typeof dep.license === "string" ? dep.license : dep.license?.type ?? (Array.isArray(dep.licenses) ? dep.licenses.map((l) => l.type).join(" OR ") : "unknown");
      const repo = typeof dep.repository === "string" ? dep.repository : dep.repository?.url;
      seen.set(key, { name: dep.name, version: dep.version, license, source: dep.homepage ?? repo, dir: at });
      walk(at);
    }
  };
  walk(realpathSync(pkgDir));
  return [...seen.values()];
}

/** One notices file: packages grouped by identical license text, one copy of each text. */
export function noticesText(title, sections) {
  const lines = [
    title,
    "",
    "This product includes the open-source software listed below. Each is used under its own license,",
    "reproduced here as found in the package. Software under the Mozilla Public License 2.0 is used",
    "unmodified; its source code is available at the source listed with it.",
    "",
  ];
  for (const { heading, pkgs } of sections) {
    lines.push("=".repeat(78), heading, "=".repeat(78), "");
    /** @type {Map<string, { texts: { file: string, text: string }[], pkgs: Pkg[] }>} */
    const groups = new Map();
    const bare = [];
    for (const p of [...pkgs].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
      const texts = p.dir ? licenseTexts(p.dir) : [];
      if (!texts.length) {
        bare.push(p);
        continue;
      }
      const key = createHash("sha256").update(texts.map((t) => t.text).join("\n\f\n")).digest("hex");
      const g = groups.get(key) ?? { texts, pkgs: [] };
      g.pkgs.push(p);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      for (const p of g.pkgs) lines.push(`${p.name} ${p.version} (${p.license})${p.source ? ` — ${p.source}` : ""}`);
      lines.push("");
      for (const t of g.texts) lines.push(`----- ${t.file} -----`, t.text, "");
      lines.push("-".repeat(78), "");
    }
    if (bare.length) {
      lines.push("Packages without a license file of their own (license as declared; text at the source):", "");
      for (const p of bare) lines.push(`${p.name} ${p.version} (${p.license})${p.source ? ` — ${p.source}` : ""}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The app's notices: web view, the app's crates, ondra-remote's crates. */
export function writeAppNotices(outDir = join(root, "src-tauri", "resources", "notices")) {
  const text = noticesText("Ondra — third-party notices", [
    { heading: "Ondra app: web view (npm)", pkgs: appNpm() },
    { heading: "Ondra app: native (Rust crates)", pkgs: cargoCrates(join(root, "src-tauri", "Cargo.toml")) },
    { heading: "ondra-remote (Rust crates)", pkgs: cargoCrates(join(root, "remote", "host", "Cargo.toml")) },
  ]);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "THIRD_PARTY_NOTICES.txt");
  writeFileSync(file, text);
  return file;
}

/** The engine's notices, for the npm packages compiled into it (from its package folder). */
export function engineNotices(pkgDir) {
  return noticesText("Ondra engine (pi coding agent) — third-party notices", [{ heading: "Compiled into the engine (npm)", pkgs: npmRuntime(pkgDir) }]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = writeAppNotices();
  console.log(`notices: ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
}
