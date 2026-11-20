// Is a Mach-O file signed already the way a release signs it? Signing again with --timestamp
// asks Apple's timestamp server, about half a second a file, and the binary analyzer has dozens
// of them that only change when it is rebuilt. Kept out of bundle-binary-analysis.mjs: that
// file's bytes are part of the analyzer's component version.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A valid signature from this certificate (its SHA-1, the way APPLE_SIGNING_IDENTITY gives it)
 * with the hardened runtime and a secure timestamp. Ad hoc ("-") never counts: it is quick to redo.
 */
export function signedBy(path, identity) {
  if (!/^[0-9A-F]{40}$/i.test(identity ?? "")) return false;
  const ok = spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=certificate leaf = H"${identity.toUpperCase()}"`, path], { stdio: "ignore" });
  if (ok.status !== 0) return false;
  return signatureFlagsOk(spawnSync("/usr/bin/codesign", ["-dvv", path], { encoding: "utf8" }).stderr ?? "");
}

/** `codesign -dvv` output of a release signature: hardened runtime and a secure timestamp. */
export const signatureFlagsOk = (info) => /flags=0x[0-9a-f]+\([^)]*runtime/.test(info) && /^Timestamp=/m.test(info);

/** The analyzer files bundle-binary-analysis.mjs signs: every dylib and bin/radare2. */
export function analyzerMachO(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p, { throwIfNoEntry: false });
      if (s?.isDirectory()) walk(p);
      else if (s?.isFile() && (name.endsWith(".dylib") || p === join(dir, "bin/radare2"))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The analyzer in `dir` is the one its manifest names and all of it is signed by `identity`. */
export function analyzerSigned(dir, identity) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return false;
  }
  const files = analyzerMachO(dir);
  return !!manifest.files && files.length > 0 && files.every((p) => signedBy(p, identity));
}
