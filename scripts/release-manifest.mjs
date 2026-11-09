#!/usr/bin/env node
// latest.json for the in-app updater, written next to the release build (scripts/release.mjs runs it):
//   node scripts/release-manifest.mjs [notes.md]   # → src-tauri/target/release/bundle/macos/latest.json
// It points at Ondra.app.tar.gz of the GitHub release v<version>; the app reads
// releases/latest/download/latest.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const dir = join(root, "src-tauri/target/release/bundle/macos");
const archive = `${conf.productName}.app.tar.gz`;
const sig = join(dir, `${archive}.sig`);
if (!existsSync(sig)) {
  console.error(`missing ${sig}: build with TAURI_SIGNING_PRIVATE_KEY set`);
  process.exit(1);
}
const notes = process.argv[2] ? readFileSync(process.argv[2], "utf8").trim() : "";
const manifest = {
  version: conf.version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature: readFileSync(sig, "utf8").trim(),
      url: `https://github.com/3x-haust/ondra/releases/download/v${conf.version}/${archive}`,
    },
  },
};
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(join(dir, "latest.json"));
