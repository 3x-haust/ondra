#!/usr/bin/env node
// The Windows and Linux part of a release (.github/workflows/release.yml runs it once their builds
// pass): uploads the installer and packages with their updater signatures to the GitHub release,
// and adds them to the release's latest.json, which the Mac release wrote with darwin-aarch64 only.
//
//   node scripts/release-desktop.mjs v0.92.0 <folder with the packages and their .sig files>
//
// The updater of each install looks for "<os>-<arch>-<installer>" first (tauri-plugin-updater), so
// an NSIS install takes windows-x86_64-nsis and a deb or rpm install its own kind.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const [tag, dir] = process.argv.slice(2);
const die = (m) => (console.error(`release-desktop: ${m}`), process.exit(1));
if (!/^v\d+\.\d+\.\d+/.test(tag ?? "") || !dir) die("usage: release-desktop.mjs v<version> <folder>");
const version = tag.slice(1);
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
if (conf.version !== version) die(`${tag} is not this commit's version (${conf.version})`);

const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const all = files(dir);
/** the platforms of latest.json: the package each one installs */
const KINDS = [
  { key: "windows-x86_64-nsis", match: /-setup\.exe$/ },
  { key: "linux-x86_64-deb", match: /\.deb$/ },
  { key: "linux-x86_64-rpm", match: /\.rpm$/ },
];
const found = KINDS.map((k) => {
  const pkg = all.filter((f) => k.match.test(f));
  if (pkg.length !== 1) die(`expected one package for ${k.key}, found ${pkg.length}`);
  if (!basename(pkg[0]).includes(version)) die(`${basename(pkg[0])} is not version ${version}`);
  const sig = `${pkg[0]}.sig`;
  if (!existsSync(sig)) die(`${basename(pkg[0])} has no updater signature`);
  return { ...k, file: pkg[0], sig };
});

const gh = (args, opts = {}) => execFileSync("gh", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
gh(["release", "upload", tag, "--clobber", ...found.flatMap((f) => [f.file, f.sig])]);
console.log(`release-desktop: uploaded ${found.map((f) => basename(f.file)).join(", ")}`);

// the Mac release's latest.json, with these platforms added (a run again replaces them)
const tmp = mkdtempSync(join(tmpdir(), "latest-"));
gh(["release", "download", tag, "--pattern", "latest.json", "--dir", tmp]);
const latest = JSON.parse(readFileSync(join(tmp, "latest.json"), "utf8"));
if (latest.version !== version) die(`latest.json of ${tag} names ${latest.version}`);
const assetUrl = (f) => `https://github.com/${process.env.GH_REPO ?? "3x-haust/ondra"}/releases/download/${tag}/${encodeURIComponent(basename(f))}`;
for (const f of found) latest.platforms[f.key] = { signature: readFileSync(f.sig, "utf8").trim(), url: assetUrl(f.file) };
writeFileSync(join(tmp, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
gh(["release", "upload", tag, "--clobber", join(tmp, "latest.json")]);
console.log(`release-desktop: latest.json now names ${Object.keys(latest.platforms).join(", ")}`);
