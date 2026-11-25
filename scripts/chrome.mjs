// Chrome for Testing (headless shell), the browser ondra-browser drives: one pinned version for every
// platform, downloaded once into ~/.cache/ondra-build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Pinned: a new version is a new component every user downloads, so it changes only when bumped here.
export const CHROME_VERSION = process.env.ONDRA_CHROME_VERSION ?? "157.0.8103.38";
export const CHROME_VARIANT = process.env.ONDRA_CHROME_VARIANT ?? "chrome-headless-shell";

/** Where Chrome for Testing publishes a platform's zip (mac-arm64, mac-x64, win64, linux64). */
export function chromeUrl(platform) {
  return `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/${CHROME_VARIANT}-${platform}.zip`;
}

/** The platform's zip, from the cache or downloaded into it. */
export async function chromeZip(platform, log) {
  const cache = join(homedir(), ".cache", "ondra-build");
  mkdirSync(cache, { recursive: true });
  const zip = join(cache, `${CHROME_VARIANT}-${platform}-${CHROME_VERSION}.zip`);
  if (!existsSync(zip)) {
    log(`downloading ${CHROME_VARIANT} ${CHROME_VERSION} (${platform})…`);
    const res = await fetch(chromeUrl(platform));
    if (!res.ok) throw new Error(`could not get Chrome ${CHROME_VERSION} for ${platform} (HTTP ${res.status})`);
    writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${zip}.part`, zip);
  }
  return zip;
}

/** The browser as a component the app downloads straight from Chrome for Testing (Windows and Linux). */
export async function chromeComponent(platform, log) {
  const data = readFileSync(await chromeZip(platform, log));
  return {
    name: "chrome",
    version: CHROME_VARIANT === "chrome-headless-shell" ? CHROME_VERSION : `${CHROME_VERSION}-${CHROME_VARIANT}`,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
    url: chromeUrl(platform),
  };
}

/**
 * Windows and Linux: build the Rust ondra-browser (and `bins`, e.g. browse.exe) into src-tauri/binaries,
 * and put Chrome where the app finds it: a release build downloads it as a component (components.json);
 * a development build runs it from src-tauri/resources/chrome. `platform` is null where Chrome for Testing
 * has no build (ARM): the app then uses a system Chrome or Edge.
 */
export async function bundleBrowser({ root, triple, platform, bins, exe = "", log }) {
  const tauri = join(root, "src-tauri");
  const crate = join(root, "browser");
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(crate, "target"));
  execFileSync("cargo", ["build", "--locked", "--release", "--target", triple, "--target-dir", target], { cwd: crate, stdio: "inherit" });
  mkdirSync(join(tauri, "binaries"), { recursive: true });
  for (const bin of bins) copyFileSync(join(target, triple, "release", `${bin}${exe}`), join(tauri, "binaries", `${bin}-${triple}${exe}`));
  log(`${bins.join(", ")} → binaries`);

  const manifestFile = join(tauri, "resources", "components.json");
  mkdirSync(dirname(manifestFile), { recursive: true });
  const components = [];
  if (platform && process.argv.includes("--release")) {
    components.push(await chromeComponent(platform, log));
  } else if (platform) {
    const dest = join(tauri, "resources", "chrome");
    const stamp = join(dest, ".version");
    const want = `${CHROME_VARIANT} ${CHROME_VERSION}`;
    if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== want) {
      const zip = await chromeZip(platform, log);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      // bsdtar on Windows reads zips; unzip keeps the browser executable on Linux
      if (process.platform === "win32") execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "inherit" });
      else execFileSync("unzip", ["-q", "-o", zip, "-d", dest], { stdio: "inherit" });
      writeFileSync(stamp, want);
    }
    log(`chrome → resources/chrome (${want})`);
  }
  writeFileSync(manifestFile, `${JSON.stringify({ components }, null, 2)}\n`);
  log(`components.json (${components.map((c) => `${c.name} ${c.version}`).join(", ") || "nothing to fetch"})`);
}
