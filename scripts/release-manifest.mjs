#!/usr/bin/env node
// latest.json for the in-app updater, written next to the release build:
//   TAURI_SIGNING_PRIVATE_KEY=… pnpm tauri build   # makes Ondra.app.tar.gz and its .sig
//   node scripts/release-manifest.mjs [notes.md]   # → src-tauri/target/release/bundle/macos/latest.json
// Upload latest.json and Ondra.app.tar.gz to the GitHub release v<version>; the app
// reads releases/latest/download/latest.json.
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
