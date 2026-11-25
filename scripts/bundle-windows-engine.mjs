// The Windows variant of 3xhaustpi's packages/coding-agent (not its separate 3xhaustpi CLI).
// Mirrors scripts/build-binaries.sh in that repository: the Bun entry and its two workers
// are compiled together, and the runtime files come from the same built checkout.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { engineNotices } from "./notices.mjs";

export function bundleWindowsEngine(dist, arch, dest) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported Windows engine architecture: ${arch}`);
  if (!dist || !existsSync(join(dist, "bun", "cli.js"))) {
    throw new Error("Set ONDRA_ENGINE_DIST to the built 3xhaustpi/packages/coding-agent/dist (see docs/windows-build.md)");
  }
  const pkg = dirname(resolve(dist));
  const repo = resolve(pkg, "../..");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const target = arch === "x64" ? "bun-windows-x64-baseline" : "bun-windows-arm64";
  execFileSync("bun", ["build", "--compile", "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", `--target=${target}`,
    ...(process.env.ONDRA_ENGINE_BUN_EXE ? [`--compile-executable-path=${process.env.ONDRA_ENGINE_BUN_EXE}`] : []),
    "./dist/bun/cli.js", "./src/utils/image-resize-worker.ts", "./src/extensions/codemode/worker.ts", "--outfile", join(dest, "ondra-engine.exe")],
  { cwd: pkg, stdio: "inherit" });

  const copy = (from, to) => cpSync(from, join(dest, to), { recursive: true, filter: (f) => ![".git", "node_modules"].includes(basename(f)) });
  for (const item of ["package.json", "README.md", "CHANGELOG.md", "docs", "examples"]) copy(join(pkg, item), item);
  const themes = join(dist, "modes/interactive/theme");
  for (const item of readdirSync(themes).filter((f) => f.endsWith(".json"))) copy(join(themes, item), join("theme", item));
  copy(join(dist, "modes/interactive/assets"), "assets");
  copy(join(dist, "core/export-html"), "export-html");
  copy(join(repo, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), "photon_rs_bg.wasm");
  const native = `native/win32/prebuilds/win32-${arch}/win32-platform.node`;
  copy(join(repo, "packages/tui", native), native);
  copy(join(repo, "LICENSE"), "LICENSE");
  writeFileSync(join(dest, "THIRD_PARTY_NOTICES.txt"), engineNotices(pkg));
  console.log(`bundle: Windows ${arch} engine and support files → ${dest}`);
}
