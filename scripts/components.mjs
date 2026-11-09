// Components: the big parts of Ondra that seldom change (the engine, Chrome, the binary analyzer).
// They are not in the app's update package; the app fetches each one once per version (see
// src-tauri/src/components.rs). A component is a folder; its archive is a tar.xz of the folder's
// contents. Each version is built and signed once and kept in ~/.cache/ondra-build/components,
// so a release only packs (and uploads) a component whose version changed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export const REPO = "https://github.com/3x-haust/ondra";
export const cacheDir = () => process.env.ONDRA_COMPONENT_CACHE ?? join(homedir(), ".cache", "ondra-build", "components");
export const assetName = (c) => `${c.name}-${c.version}.tar.xz`;
export const releaseUrl = (tag, c) => `${REPO}/releases/download/${tag}/${assetName(c)}`;
const PLAIN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,95}$/;

/** Files under a folder, sorted, as paths relative to it. */
export function files(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

/** A short hash of a folder's file names and contents: the version part that changes with them. */
export function treeHash(dir) {
  const h = createHash("sha256");
  for (const f of files(dir)) h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  return h.digest("hex").slice(0, 12);
}

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The manifest for this build. A component whose version the last release already shipped keeps
 * that release's entry (its url, so nothing is uploaded again); a new version points at this
 * release (`tag`) and is listed in `upload`.
 */
export function plan(built, previous, tag) {
  const components = built.map((c) => {
    if (!PLAIN.test(c.name) || !PLAIN.test(c.version)) throw new Error(`component name or version not plain: ${c.name} ${c.version}`);
    const before = previous?.components?.find((p) => p.name === c.name && p.version === c.version);
    return before ? { ...before } : { name: c.name, version: c.version, sha256: c.sha256, size: c.size, url: releaseUrl(tag, c) };
  });
  const upload = components.filter((c) => c.url === releaseUrl(tag, c)).map((c) => c.name);
  return { manifest: { components }, upload };
}

/**
 * Build component `name` at `version` once: `fill(dir)` puts its files in a fresh folder, the
 * Mach-O files in `sign` are signed with APPLE_SIGNING_IDENTITY (hardened runtime, as Tauri signs
 * sidecars), then it is archived. Returns { name, version, sha256, size, tree, archive }.
 */
export function pack({ name, version, fill, sign = [], log = () => {} }) {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? "";
  const signer = identity || "adhoc";
  const cache = cacheDir();
  mkdirSync(cache, { recursive: true });
  const base = join(cache, `${name}-${version}`);
  const [tree, archive, stamp] = [base, `${base}.tar.xz`, `${base}.json`];
  if (existsSync(stamp) && existsSync(tree) && existsSync(archive)) {
    const m = JSON.parse(readFileSync(stamp, "utf8"));
    if (m.signer === signer && statSync(archive).size === m.size) {
      log(`${name} ${version} (cached)`);
      return { name, version, sha256: m.sha256, size: m.size, tree, archive };
    }
  }
  for (const p of [tree, archive, stamp, `${base}.tmp`, `${archive}.part`]) rmSync(p, { recursive: true, force: true });
  const work = `${base}.tmp`;
  mkdirSync(work, { recursive: true });
  fill(work);
  if (identity) {
    for (const rel of sign) {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]), join(work, rel)], { stdio: "inherit" });
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", join(work, rel)], { stdio: "inherit" });
    }
  }
  log(`${name} ${version}: packing…`);
  // no AppleDouble files or extended attributes: the folder's contents only
  execFileSync("/usr/bin/tar", ["--no-mac-metadata", "--options", "xz:compression-level=9,xz:threads=0", "-cJf", `${archive}.part`, "-C", work, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "inherit",
  });
  renameSync(`${archive}.part`, archive);
  renameSync(work, tree);
  const sha256 = sha256File(archive);
  const size = statSync(archive).size;
  writeFileSync(stamp, `${JSON.stringify({ name, version, sha256, size, signer }, null, 2)}\n`);
  log(`${name} ${version}: ${(size / 1e6).toFixed(1)} MB`);
  return { name, version, sha256, size, tree, archive };
}

/** components.json of the newest release (null when it has none, or offline). */
export async function previousManifest() {
  const from = process.env.ONDRA_PREVIOUS_COMPONENTS;
  if (from) return existsSync(from) ? JSON.parse(readFileSync(from, "utf8")) : null;
  try {
    const res = await fetch(`${REPO}/releases/latest/download/components.json?at=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
