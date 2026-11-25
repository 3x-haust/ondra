import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleEngine } from "./bundle-engine.mjs";
import { writeAppNotices } from "./notices.mjs";
import { bundleBrowser } from "./chrome.mjs";

export async function bundleLinux(root) {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)/m)?.[1];
  const arch = { "x86_64-unknown-linux-gnu": "x64", "aarch64-unknown-linux-gnu": "arm64" }[triple];
  if (!arch) throw new Error(`Unsupported Linux target: ${triple}. Use x86_64 or aarch64 GNU.`);
  const tauri = join(root, "src-tauri");
  bundleEngine(process.env.ONDRA_ENGINE_DIST, "linux", arch, join(tauri, "resources/linux/engine"));

  // The remote helper has its own workspace and locked dependencies.
  const crate = join(root, "remote/host");
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(crate, "target"));
  execFileSync("cargo", ["build", "--locked", "--release", "--target", triple, "--target-dir", target], { cwd: crate, stdio: "inherit" });
  mkdirSync(join(tauri, "binaries"), { recursive: true });
  copyFileSync(join(target, triple, "release/ondra-remote"), join(tauri, "binaries", `ondra-remote-${triple}`));
  // the browser tool and the Chrome it drives (Chrome for Testing has no ARM build here)
  await bundleBrowser({ root, triple, platform: { "x64": "linux64" }[arch] ?? null, bins: ["ondra-browser"], exe: "", log: (m) => console.log(`bundle: ${m}`) });
  writeAppNotices();
}
