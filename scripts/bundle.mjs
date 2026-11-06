// Puts everything Ondra needs inside the app bundle, so installing the app is
// the only step a user takes:
//   • agent-browser, agent-desktop (+ macOS helper)   → src-tauri/binaries/<name>-<triple>
//   • agent-browser built-in skills                    → src-tauri/resources/agent-browser-skills
//   • the agent engine (3xhaustPi coding agent, one binary) → binaries/ondra-engine-<triple>
//     and its support files                            → src-tauri/resources/engine
//   • Chrome for Testing (headless shell)              → src-tauri/resources/chrome
// Idempotent: anything already up to date is left alone.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// the iOS simulator helper (live screen + touches) is built from source here
execFileSync("sh", [join(tauri, "helpers", "build.sh")], { stdio: "inherit" });

function same(src, dest) {
  if (!existsSync(dest)) return false;
  const a = statSync(src);
  const b = statSync(dest);
  return a.size === b.size && b.mtimeMs >= a.mtimeMs;
}

function copyBin(name, src) {
  if (!existsSync(src)) {
    console.error(`bundle: missing ${src}`);
    process.exit(1);
  }
  const dest = join(binDir, `${name}-${triple}`);
  const fresh = same(src, dest);
  if (!fresh) copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  log(`${name}${fresh ? " (up to date)" : ""}`);
}

// ── agent-browser / agent-desktop ──
copyBin("agent-browser", join(root, `node_modules/agent-browser/bin/agent-browser-darwin-${nodeArch}`));
// agent-desktop 1.1.0 refuses to work while macOS lists an app with pid -1
// (Xcode's Device Hub on macOS 27). Until upstream fixes it we ship a build with
// scripts/patches/agent-desktop-1.1.0-pid-minus-one.patch, kept at
// ~/.cache/ondra/agent-desktop-patched (build: checkout v1.1.0, apply, cargo build --release -p agent-desktop).
const patchedDesktop = join(process.env.HOME ?? "", ".cache/ondra/agent-desktop-patched");
copyBin("agent-desktop", existsSync(patchedDesktop) ? patchedDesktop : join(root, `node_modules/agent-desktop/bin/agent-desktop-darwin-${nodeArch}`));
copyBin("agent-desktop-macos-helper", join(root, `node_modules/agent-desktop/bin/agent-desktop-macos-helper-darwin-${nodeArch}`));

const skillsDest = join(resDir, "agent-browser-skills");
rmSync(skillsDest, { recursive: true, force: true });
cpSync(join(root, "node_modules/agent-browser/skill-data"), skillsDest, { recursive: true });
log("agent-browser skills");

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
copyBin("ondra-engine", join(engineDist, "pi"));
const engineRes = join(resDir, "engine");
rmSync(engineRes, { recursive: true, force: true });
mkdirSync(engineRes, { recursive: true });
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
const variant = process.env.ONDRA_CHROME_VARIANT ?? "chrome-headless-shell";
const platform = nodeArch === "arm64" ? "mac-arm64" : "mac-x64";
const chromeDest = join(resDir, "chrome");
const stamp = join(chromeDest, ".version");
const cache = join(homedir(), ".cache", "ondra-build");
mkdirSync(cache, { recursive: true });

async function latest() {
  const res = await fetch("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json");
  if (!res.ok) throw new Error(`chrome-for-testing index: HTTP ${res.status}`);
  const stable = (await res.json()).channels.Stable;
  const dl = stable.downloads[variant].find((d) => d.platform === platform);
  return { version: stable.version, url: dl.url };
}

function cachedZip() {
  const zips = readdirSync(cache).filter((f) => f.startsWith(`${variant}-${platform}-`) && f.endsWith(".zip")).sort();
  return zips.length ? join(cache, zips[zips.length - 1]) : null;
}

let zip = null;
let version = null;
try {
  const info = await latest();
  version = info.version;
  zip = join(cache, `${variant}-${platform}-${version}.zip`);
  if (!existsSync(zip)) {
    log(`downloading ${variant} ${version}…`);
    const res = await fetch(info.url);
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
    execFileSync("mv", [`${zip}.part`, zip]);
  }
} catch (e) {
  zip = cachedZip();
  if (!zip) {
    console.error(`bundle: could not get Chrome (${e.message}) and nothing cached`);
    process.exit(1);
  }
  version = zip.slice(zip.lastIndexOf("-") + 1, -4);
  log(`offline, using cached ${version}`);
}
const want = `${variant} ${version}`;
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
