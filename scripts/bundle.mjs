// Puts everything Ondra needs in place, so installing the app is the only step a user takes:
//   • the Swift helpers (ondra-browser, ondra-cuhost, ondra-simhelper) and ondra-remote,
//     built from source by src-tauri/helpers/build.sh → src-tauri/binaries/<name>-<triple>
// and the components, which live outside the app's update package (scripts/components.mjs):
//   • the agent engine (3xhaustPi coding agent, one binary, and its support files) → src-tauri/resources/engine
//   • Chrome for Testing (headless shell)              → src-tauri/resources/chrome
//   • the binary analyzer                              → src-tauri/resources/binary-analysis
// A development build runs them from there. A release build (`tauri build`, `--release`) also packs each
// version once and writes src-tauri/resources/components.json, which the app reads to fetch them.
// Idempotent: anything already up to date is left alone.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleBinaryAnalysis } from "./bundle-binary-analysis.mjs";
import { pack, plan, previousManifest, treeHash } from "./components.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const tauri = join(root, "src-tauri");
const binDir = join(tauri, "binaries");
const resDir = join(tauri, "resources");

const archs = { arm64: "aarch64", x64: "x86_64" };
const nodeArch = process.env.APP_TOOLS_ARCH ?? process.arch;
const triple = `${archs[nodeArch]}-apple-darwin`;
if (process.platform !== "darwin" || !archs[nodeArch]) {
  console.error(`bundle: only macOS is supported (got ${process.platform}/${nodeArch})`);
  process.exit(1);
}
const log = (msg) => console.log(`bundle: ${msg}`);
mkdirSync(binDir, { recursive: true });
mkdirSync(resDir, { recursive: true });

// our own helpers (browser tool, computer use, iOS simulator, remote) are built from source here
execFileSync("sh", [join(tauri, "helpers", "build.sh")], { stdio: "inherit" });

// ── native static binary analysis (engine, decompiler, libraries and source) ──
await bundleBinaryAnalysis();

// ── engine: 3xhaustPi coding agent compiled with bun ──
// the engine build worktree tracks main (the main checkout may be on a feature branch)
const engineDist =
  process.env.ONDRA_ENGINE_DIST ??
  [join(root, "..", "3xhaustpi-engine-build", "packages", "coding-agent", "dist"), join(root, "..", "3xhaustpi", "packages", "coding-agent", "dist")].find((d) => existsSync(join(d, "pi"))) ??
  join(root, "..", "3xhaustpi", "packages", "coding-agent", "dist");
if (!existsSync(join(engineDist, "pi"))) {
  const pkg = dirname(engineDist);
  if (!existsSync(join(pkg, "package.json"))) {
    console.error(`bundle: engine not found at ${engineDist}. Set ONDRA_ENGINE_DIST to 3xhaustpi/packages/coding-agent/dist.`);
    process.exit(1);
  }
  log("building engine binary (npm run build:binary)…");
  execFileSync("npm", ["run", "build:binary"], { cwd: pkg, stdio: "inherit" });
}
const engineRes = join(resDir, "engine");
rmSync(engineRes, { recursive: true, force: true });
mkdirSync(engineRes, { recursive: true });
// the engine component is one folder: the binary next to the files it reads
copyFileSync(join(engineDist, "pi"), join(engineRes, "ondra-engine"));
chmodSync(join(engineRes, "ondra-engine"), 0o755);
for (const item of ["package.json", "theme", "assets", "export-html", "photon_rs_bg.wasm"]) {
  const src = join(engineDist, item);
  if (existsSync(src)) cpSync(src, join(engineRes, item), { recursive: true });
}
// the engine's prompt points jobs at its README, docs and examples next to it
for (const item of ["README.md", "docs", "examples"]) {
  const src = join(dirname(engineDist), item);
  if (existsSync(src)) cpSync(src, join(engineRes, item), { recursive: true, filter: (f) => !/node_modules|\.git/.test(f) });
}
log("engine assets");

// ── Chrome for Testing (headless shell), cached so it downloads once ──
// Pinned: a new version is a new component every user downloads, so it changes only when bumped here.
const CHROME_VERSION = process.env.ONDRA_CHROME_VERSION ?? "157.0.8103.38";
const variant = process.env.ONDRA_CHROME_VARIANT ?? "chrome-headless-shell";
const platform = nodeArch === "arm64" ? "mac-arm64" : "mac-x64";
const chromeDest = join(resDir, "chrome");
const stamp = join(chromeDest, ".version");
const cache = join(homedir(), ".cache", "ondra-build");
mkdirSync(cache, { recursive: true });

const zip = join(cache, `${variant}-${platform}-${CHROME_VERSION}.zip`);
if (!existsSync(zip)) {
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/${variant}-${platform}.zip`;
  log(`downloading ${variant} ${CHROME_VERSION}…`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`bundle: could not get Chrome ${CHROME_VERSION} (HTTP ${res.status})`);
    process.exit(1);
  }
  writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
  execFileSync("mv", [`${zip}.part`, zip]);
}
const want = `${variant} ${CHROME_VERSION}`;
if (existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
  log(`chrome (up to date: ${want})`);
} else {
  rmSync(chromeDest, { recursive: true, force: true });
  mkdirSync(chromeDest, { recursive: true });
  // ditto keeps the app bundle's symlinks and signatures intact.
  execFileSync("ditto", ["-x", "-k", zip, chromeDest]);
  // Downloaded apps carry quarantine; strip it so the bundled browser launches.
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", chromeDest]);
  } catch {}
  writeFileSync(stamp, want);
  log(`chrome → resources/chrome (${want})`);
}

// ── components.json: what a release build of the app fetches, and from where ──
const manifestFile = join(resDir, "components.json");
// `tauri build` runs `pnpm bundle --release` (tauri.conf.json beforeBuildCommand)
if (process.argv.includes("--release")) {
  const conf = JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8"));
  const enginePkg = JSON.parse(readFileSync(join(engineRes, "package.json"), "utf8"));
  const analyzer = JSON.parse(readFileSync(join(resDir, "binary-analysis", "manifest.json"), "utf8"));
  const ditto = (from) => (dir) => execFileSync("ditto", [from, dir]);
  // in the order a first run needs them: no job runs without the engine
  const built = [
    pack({ name: "engine", version: `${enginePkg.version}-${treeHash(engineRes)}`, fill: ditto(engineRes), sign: ["ondra-engine"], log }),
    pack({ name: "chrome", version: variant === "chrome-headless-shell" ? CHROME_VERSION : `${CHROME_VERSION}-${variant}`, fill: ditto(chromeDest), log }),
    // the analyzer's files are signed in place by bundle-binary-analysis.mjs
    pack({ name: "binary-analysis", version: `${analyzer.version}-${analyzer.recipe.slice(0, 12)}`, fill: ditto(join(resDir, "binary-analysis")), log }),
  ];
  const { manifest, upload } = plan(built, await previousManifest(), `v${conf.version}`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`components.json (new in this release: ${upload.join(", ") || "none"})`);
} else {
  // development builds run the components from src-tauri/resources and fetch nothing
  writeFileSync(manifestFile, `${JSON.stringify({ components: [] }, null, 2)}\n`);
}
