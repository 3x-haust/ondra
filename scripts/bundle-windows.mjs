import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bundleCrate } from "./bundle-crate.mjs";
import { bundleEngine } from "./bundle-engine.mjs";
import { writeAppNotices } from "./notices.mjs";
import { bundleBrowser } from "./chrome.mjs";

export async function bundleWindows(root) {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)/m)?.[1];
  const arch = { "x86_64-pc-windows-msvc": "x64", "aarch64-pc-windows-msvc": "arm64" }[triple];
  if (!arch) throw new Error(`Unsupported Windows target: ${triple}. Use the x64 or ARM64 MSVC toolchain.`);
  const tauri = join(root, "src-tauri");
  bundleEngine(process.env.ONDRA_ENGINE_DIST, "win32", arch, join(tauri, "resources/windows/engine"));

  // Standalone workspaces and lockfiles; never ask Tauri to bundle an old sidecar or a Mac helper.
  bundleCrate(root, "remote/host", "ondra-remote", triple,
    process.env.RUSTUP_TOOLCHAIN_REMOTE ? { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN_REMOTE } : process.env);
  bundleCrate(root, "dictate", "ondra-dictate", triple);
  // the browser tool and the Chrome it drives (Chrome for Testing has no ARM build here)
  await bundleBrowser({ root, triple, platform: { "x64": "win64" }[arch] ?? null, bins: ["ondra-browser", "browse"], exe: ".exe", log: (m) => console.log(`bundle: ${m}`) });
  writeAppNotices(undefined, { dictate: true });
}
