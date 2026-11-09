#!/usr/bin/env node
// A release of Ondra, start to finish. On main, with the version bumped (tauri.conf.json,
// Cargo.toml, package.json) and the notes written, from the repo root:
//
//   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ondra-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
//   APPLE_SIGNING_IDENTITY=7CBA1EA9C27F25912D4A2774F0D1B98B6C5A7BF5 \
//   node scripts/release.mjs notes.md [--publish]
//
// Without --publish it builds and checks everything and prints the `gh release create` command;
// with it, it runs that command too. --skip-build reuses the last `tauri build`. ONDRA_PYTHON
// picks the python for the dmg script (it needs `pip install ds_store mac_alias`).
//
//   1. reads components.json of the newest release: the component versions users already have
//   2. `pnpm tauri build --bundles app`: the app without its components. bundle.mjs packs a
//      component only when its version is new and writes the manifest the app fetches them by
//   3. Ondra.app.tar.gz, the update: only the app, gzip at the highest level, signed for the
//      updater. The first release with components ships the full app instead (once), so that
//      update needs no further download: the app copies each component out of itself
//   4. a full Ondra.app (components inside, signed again) for the dmg, which works offline
//   5. latest.json, components.json, and the archive of each component new in this release
// Secrets come from the environment only and are never printed.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetName, cacheDir, REPO, releaseUrl, sha256File } from "./components.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const skipBuild = args.includes("--skip-build");
const notes = args.find((a) => !a.startsWith("--"));
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const { productName: name, version } = conf;
const tag = `v${version}`;
const bundle = join(root, "src-tauri/target/release/bundle");
const macos = join(bundle, "macos");
const app = join(macos, `${name}.app`);
const full = join(bundle, "full", `${name}.app`);
const say = (m) => console.log(`release: ${m}`);
const die = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, stdio: "inherit", ...opts });
const mb = (path) => `${(statSync(path).size / 1e6).toFixed(1)} MB`;
const onPath = (bin) => {
  try {
    return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
};

if (notes && !existsSync(notes)) die(`no notes file ${notes}`);
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) die("TAURI_SIGNING_PRIVATE_KEY is not set: the updater checks the package with it");
const identity = process.env.APPLE_SIGNING_IDENTITY ?? "";
if (!identity && publish) die("APPLE_SIGNING_IDENTITY is not set");
if (!identity) say("APPLE_SIGNING_IDENTITY is not set: signing ad hoc (not for publishing)");
// the release points at the commit that was built (main may move during the build)
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

// ── 1. what users have ──
const res = await fetch(`${REPO}/releases/latest/download/components.json?at=${Date.now()}`, { signal: AbortSignal.timeout(30_000) }).catch((e) => die(`newest release: ${e.message}`));
if (!res.ok && res.status !== 404) die(`newest release's components.json: HTTP ${res.status}`);
const previous = res.ok ? await res.json() : null;
const previousFile = join(root, "src-tauri/target/release/components-previous.json");
mkdirSync(dirname(previousFile), { recursive: true });
writeFileSync(previousFile, `${JSON.stringify(previous)}\n`);
say(previous ? `newest release has ${previous.components.map((c) => `${c.name} ${c.version}`).join(", ")}` : "newest release has no components yet: this update carries the full app once");

// ── 2. build ──
if (!skipBuild) run("pnpm", ["tauri", "build", "--bundles", "app"], { env: { ...process.env, ONDRA_PREVIOUS_COMPONENTS: previousFile } });
const manifestFile = join(app, "Contents/Resources/components.json");
if (!existsSync(manifestFile)) die(`${manifestFile} is missing`);
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
if (!manifest.components?.length) die("the app was built without components (a development bundle?)");
const trees = manifest.components.map((c) => {
  const tree = join(cacheDir(), `${c.name}-${c.version}`);
  if (!existsSync(tree)) die(`no built ${c.name} ${c.version} in ${cacheDir()}`);
  return { c, tree };
});

// ── 4. the full app, for the dmg (and the first update with components) ──
rmSync(dirname(full), { recursive: true, force: true });
mkdirSync(dirname(full), { recursive: true });
run("ditto", [app, full]);
for (const { c, tree } of trees) run("ditto", [tree, join(full, "Contents/Resources/components", c.name)]);
// the components are signed already; this seals them into the app's signature
run("/usr/bin/codesign", ["--force", "--sign", identity || "-", ...(identity ? ["--timestamp"] : []), "--preserve-metadata=entitlements,requirements,flags,runtime", full]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", full]);
say(`full app signed and verified`);

// ── 3. the update package ──
const first = !previous;
const source = first ? full : app;
const archive = join(macos, `${name}.app.tar.gz`);
rmSync(archive, { force: true });
rmSync(`${archive}.sig`, { force: true });
// the updater reads any gzip level; libdeflate's top level is a little smaller than gzip -9
const gz = onPath("libdeflate-gzip") ? "libdeflate-gzip -12" : "gzip -9";
execFileSync("/bin/sh", ["-c", `/usr/bin/tar --no-mac-metadata -cf - -C "$1" "$2" | ${gz} -c > "$3"`, "sh", dirname(source), basename(source), archive], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  stdio: "inherit",
});
// the key and its password come from the environment; nothing of them is printed
run("pnpm", ["-s", "tauri", "signer", "sign", "--app-version", version, archive], { stdio: ["ignore", "ignore", "inherit"] });
if (!existsSync(`${archive}.sig`)) die("signing the update package failed");
say(`update package ${mb(archive)}${first ? " (full app, once)" : ""}`);

// ── dmg ──
const dmg = join(bundle, "dmg", `${name}_${version}_aarch64.dmg`);
mkdirSync(dirname(dmg), { recursive: true });
// the dmg script needs ds_store and mac_alias: ONDRA_PYTHON names a python that has them
run(process.env.ONDRA_PYTHON || "python3", [join(root, "scripts/dmg/build.py"), full, dmg], { stdio: ["ignore", "ignore", "inherit"] });
say(`dmg ${mb(dmg)}`);

// ── 5. manifests and new components ──
run("node", [join(root, "scripts/release-manifest.mjs"), ...(notes ? [notes] : [])], { stdio: ["ignore", "ignore", "inherit"] });
copyFileSync(manifestFile, join(macos, "components.json"));
const fresh = manifest.components.filter((c) => c.url === releaseUrl(tag, c));
const parts = fresh.map((c) => {
  const file = join(cacheDir(), assetName(c));
  if (!existsSync(file) || sha256File(file) !== c.sha256) die(`${file} is not the archive components.json names`);
  say(`new component ${c.name} ${c.version}: ${mb(file)}`);
  return file;
});
for (const c of manifest.components.filter((c) => !fresh.includes(c))) say(`${c.name} ${c.version}: unchanged (from ${c.url.split("/download/")[1].split("/")[0]})`);

const assets = [dmg, archive, join(macos, "latest.json"), join(macos, "components.json"), ...parts];
const gh = ["release", "create", tag, "--target", head, "--title", `${name} ${version}`, ...(notes ? ["--notes-file", notes] : ["--notes", ""]), ...assets];
if (publish) {
  run("gh", gh);
  say(`published ${tag}`);
} else {
  const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  console.log(`\nTo publish:\n  gh ${gh.map(quote).join(" ")}`);
}
