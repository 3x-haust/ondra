// Pull requests only compile the app (`cargo check`), without building what `pnpm bundle` puts beside
// it. tauri-build still wants every sidecar and resource the platform's config names, so this puts
// an empty stand-in wherever one is missing: node .github/check-stubs.mjs <target triple>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const triple = process.argv[2];
if (!triple) throw new Error("usage: node .github/check-stubs.mjs <target triple>");
const tauri = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const platform = triple.includes("-windows-") ? "windows" : triple.includes("-linux-") ? "linux" : "macos";

// tauri.<platform>.conf.json is merged over tauri.conf.json as a JSON merge patch (RFC 7396)
const merge = (base, patch) => {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = merge(out[k], v);
  }
  return out;
};
const read = (f) => JSON.parse(readFileSync(join(tauri, f), "utf8"));
const conf = existsSync(join(tauri, `tauri.${platform}.conf.json`)) ? merge(read("tauri.conf.json"), read(`tauri.${platform}.conf.json`)) : read("tauri.conf.json");

const made = [];
const stub = (path) => {
  if (existsSync(path)) return;
  if (path.endsWith("/")) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".stub"), "");
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  made.push(path);
};
const exe = platform === "windows" ? ".exe" : "";
for (const bin of conf.bundle?.externalBin ?? []) stub(join(tauri, `${bin}-${triple}${exe}`));
const resources = conf.bundle?.resources ?? [];
for (const src of Array.isArray(resources) ? resources : Object.keys(resources)) {
  if (!src.includes("*")) stub(join(tauri, src));
}
console.log(made.length ? `stand-ins:\n  ${made.join("\n  ")}` : "nothing missing");
