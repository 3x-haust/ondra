import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bundleCrate } from "./bundle-crate.mjs";
import { bundleEngine } from "./bundle-engine.mjs";
import { writeAppNotices } from "./notices.mjs";

export function bundleLinux(root) {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)/m)?.[1];
  const arch = { "x86_64-unknown-linux-gnu": "x64", "aarch64-unknown-linux-gnu": "arm64" }[triple];
  if (!arch) throw new Error(`Unsupported Linux target: ${triple}. Use x86_64 or aarch64 GNU.`);
  const tauri = join(root, "src-tauri");
  bundleEngine(process.env.ONDRA_ENGINE_DIST, "linux", arch, join(tauri, "resources/linux/engine"));

  // The remote and dictation helpers each have their own workspace and locked dependencies.
  bundleCrate(root, "remote/host", "ondra-remote", triple);
  bundleCrate(root, "dictate", "ondra-dictate", triple);
  writeAppNotices(undefined, { dictate: true });
}
