import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Builds one of the app's own Rust helpers (a crate with its own workspace and lockfile) for
 * `triple` and puts it where Tauri bundles sidecars: src-tauri/binaries/<bin>-<triple>[.exe].
 */
export function bundleCrate(root, crate, bin, triple, env = process.env) {
  const dir = join(root, crate);
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(dir, "target"));
  execFileSync("cargo", ["build", "--locked", "--release", "--target", triple, "--target-dir", target], { cwd: dir, stdio: "inherit", env });
  const exe = triple.includes("-windows-") ? ".exe" : "";
  const binaries = join(root, "src-tauri", "binaries");
  mkdirSync(binaries, { recursive: true });
  copyFileSync(join(target, triple, "release", `${bin}${exe}`), join(binaries, `${bin}-${triple}${exe}`));
}
