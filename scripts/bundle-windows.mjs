import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleEngine } from "./bundle-engine.mjs";
import { writeAppNotices } from "./notices.mjs";
import { bundleBrowser } from "./chrome.mjs";

export async function bundleWindows(root) {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)/m)?.[1];
  const arch = { "x86_64-pc-windows-msvc": "x64", "aarch64-pc-windows-msvc": "arm64" }[triple];
  if (!arch) throw new Error(`Unsupported Windows target: ${triple}. Use the x64 or ARM64 MSVC toolchain.`);
  const tauri = join(root, "src-tauri");
  bundleEngine(process.env.ONDRA_ENGINE_DIST, "win32", arch, join(tauri, "resources/windows/engine"));

  // A standalone workspace and lockfile; never ask Tauri to bundle an old sidecar or a Mac helper.
  const crate = join(root, "remote/host");
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(crate, "target"));
  execFileSync("cargo", ["build", "--locked", "--release", "--target", triple, "--target-dir", target], {
    cwd: crate, stdio: "inherit",
    env: process.env.RUSTUP_TOOLCHAIN_REMOTE ? { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN_REMOTE } : process.env,
  });
  mkdirSync(join(tauri, "binaries"), { recursive: true });
  copyFileSync(join(target, triple, "release/ondra-remote.exe"), join(tauri, "binaries", `ondra-remote-${triple}.exe`));
  // the browser tool and the Chrome it drives (Chrome for Testing has no ARM build here)
  await bundleBrowser({ root, triple, platform: { "x64": "win64" }[arch] ?? null, bins: ["ondra-browser", "browse"], exe: ".exe", log: (m) => console.log(`bundle: ${m}`) });
  writeAppNotices();
}
