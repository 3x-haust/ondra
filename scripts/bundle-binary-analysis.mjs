// Build-only downloads. The installed analyzer never installs or fetches tools.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "6.2.6";
const sources = [
  { name: "radare2", sha256: "1a0e09c0f781337ae8cd3f4a1d295ac64344d0b019031f75755dbc8e246b9f8a" },
  { name: "r2ghidra", sha256: "4fe9aeb4ab226b6b552b5d61a284f9b6b08b20579bbac1bcaa6785bfe957991f" },
].map((s) => ({ ...s, file: `${s.name}-${version}.tar.xz`, url: `https://github.com/radareorg/${s.name}/releases/download/${version}/${s.name}-${version}.tar.xz` }));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: "inherit", ...options });
const text = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

export function launcherLicenses() {
  // Include every locked dependency, including build/proc-macro dependencies,
  // so target-specific resolution cannot omit a distributed component's notice.
  const metadata = JSON.parse(text("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", join(root, "tools/binary-analysis/Cargo.toml")]));
  return metadata.packages.filter(p => p.source).sort((a, b) => `${a.name}-${a.version}`.localeCompare(`${b.name}-${b.version}`)).map(p => {
    const dir = dirname(p.manifest_path);
    const names = readdirSync(dir).filter(name => /^(LICENSE|COPYING|NOTICE)([.\-_]|$)/i.test(name) && statSync(join(dir, name)).isFile()).sort();
    if (p.license_file && !names.includes(p.license_file)) names.push(p.license_file);
    if (!names.length) throw new Error(`Missing license notices: ${p.name} ${p.version}`);
    return { name: p.name, version: p.version, license: p.license, notices: Object.fromEntries(names.map(name => [name, readFileSync(join(dir, name), "utf8")])) };
  });
}

export async function bundleBinaryAnalysis() {
  const arch = process.env.APP_TOOLS_ARCH ?? process.arch;
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch) || arch !== process.arch) {
    throw new Error("Binary analysis must be built natively on macOS arm64 or x64 (no cross-architecture fallback)");
  }
  const triple = `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  const dest = join(root, "src-tauri/resources/binary-analysis");
  const bins = join(root, "src-tauri/binaries");
  const cache = join(homedir(), ".cache/ondra-build/binary-analysis");
  mkdirSync(cache, { recursive: true });
  mkdirSync(bins, { recursive: true });
  const licenses = launcherLicenses();
  const recipe = hash(Buffer.concat([
    readFileSync(fileURLToPath(import.meta.url)), readFileSync(join(root, "tools/binary-analysis/NOTICE.md")),
    readFileSync(join(root, "tools/binary-analysis/Cargo.toml")), readFileSync(join(root, "tools/binary-analysis/Cargo.lock")),
    Buffer.from(JSON.stringify(licenses)),
  ]));
  const stamp = join(dest, "manifest.json");
  let cached = false;
  if (existsSync(stamp)) {
    const m = JSON.parse(readFileSync(stamp, "utf8"));
    cached = m.recipe === recipe && m.arch === arch && Object.entries(m.files).every(([p, h]) => existsSync(join(dest, p)) && hash(readFileSync(join(dest, p))) === h);
  }
  if (!cached) {
    for (const source of sources) {
      const archive = join(cache, source.file);
      if (!existsSync(archive)) {
        console.log(`binary-analysis: downloading ${source.file}`);
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (hash(bytes) !== source.sha256) throw new Error(`Checksum mismatch: ${source.file}`);
        writeFileSync(`${archive}.part`, bytes);
        renameSync(`${archive}.part`, archive);
      }
      if (hash(readFileSync(archive)) !== source.sha256) throw new Error(`Checksum mismatch in build cache: ${archive}`);
    }
    // Upstream makefiles require paths without spaces. Never install to /usr/local.
    const work = mkdtempSync("/tmp/ondra-binary-build-");
    const prefix = join(work, "prefix");
    const stage = join(work, "stage");
    try {
      for (const source of sources) run("/usr/bin/tar", ["-xf", join(cache, source.file), "-C", work]);
      const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0", CFLAGS: "-O2 -mmacosx-version-min=13.0", CXXFLAGS: "-O2 -mmacosx-version-min=13.0", LDFLAGS: "-Wl,-headerpad_max_install_names", R2_PREFIX: prefix };
      const r2 = join(work, `radare2-${version}`);
      const ghidra = join(work, `r2ghidra-${version}`);
      // The upstream no-GPL preset omits LGPL io.null. Section zero-fill mapping
      // needs it (notably PE sections whose virtual size exceeds their raw size).
      const plugins = readFileSync(join(r2, "dist/plugins-cfg/plugins.nogpl.cfg"), "utf8").replace("io.malloc\n", "io.malloc\nio.null\n");
      // --without-gpl replaces plugins.cfg with this preset during configure.
      writeFileSync(join(r2, "dist/plugins-cfg/plugins.nogpl.cfg"), plugins);
      run("./configure", [`--prefix=${prefix}`, "--without-gpl", "--without-qjs", "--without-sqsh", "--without-syscapstone", "--without-syszydis", "--disable-debugger", "--disable-network"], { cwd: r2, env });
      run("make", ["-j8"], { cwd: r2, env });
      run("make", ["install"], { cwd: r2, env });
      const pluginEnv = { ...env, PATH: `${prefix}/bin:${process.env.PATH}`, PKG_CONFIG_PATH: `${prefix}/lib/pkgconfig` };
      run("./configure", [`--prefix=${prefix}`], { cwd: ghidra, env: pluginEnv });
      run("make", ["-j8"], { cwd: ghidra, env: pluginEnv });
      run("make", ["install"], { cwd: ghidra, env: pluginEnv });
      mkdirSync(join(stage, "bin"), { recursive: true });
      mkdirSync(join(stage, "lib"), { recursive: true });
      copyFileSync(realpathSync(join(prefix, "bin/radare2")), join(stage, "bin/radare2"));
      for (const name of readdirSync(join(prefix, "lib")).filter((n) => n.endsWith(".dylib"))) {
        copyFileSync(realpathSync(join(prefix, "lib", name)), join(stage, "lib", name));
      }
      const pluginDir = `lib/radare2/${version}`;
      mkdirSync(join(stage, pluginDir), { recursive: true });
      copyFileSync(join(prefix, pluginDir, "core_ghidra.dylib"), join(stage, pluginDir, "core_ghidra.dylib"));
      cpSync(join(prefix, pluginDir, "r2ghidra_sleigh"), join(stage, pluginDir, "r2ghidra_sleigh"), { recursive: true });
      cpSync(join(prefix, `share/radare2/${version}`), join(stage, `share/radare2/${version}`), { recursive: true });
      // Relocate every non-system dependency; no Homebrew or build paths may survive.
      const native = files(stage).filter((p) => p.endsWith(".dylib") || p === join(stage, "bin/radare2"));
      for (const path of native) {
        chmodSync(path, 0o755);
        const deps = text("/usr/bin/otool", ["-L", path]).split("\n").slice(1).map((line) => line.trim().split(" (compatibility")[0]);
        const changes = [];
        for (const dep of deps) {
          if (dep.startsWith("/usr/lib/") || dep.startsWith("/System/Library/")) continue;
          if (path.endsWith(".dylib") && basename(dep) === basename(path)) continue;
          const bundled = join(stage, "lib", basename(dep));
          if (!existsSync(bundled)) throw new Error(`Unbundled dependency: ${path}: ${dep}`);
          changes.push("-change", dep, `@loader_path/${relative(dirname(path), bundled)}`);
        }
        if (path.endsWith(".dylib")) changes.push("-id", `@loader_path/${basename(path)}`);
        if (changes.length) run("/usr/bin/install_name_tool", [...changes, path]);
        const load = text("/usr/bin/otool", ["-l", path]);
        const min = load.match(/\bminos (\d+\.\d+)/)?.[1];
        if (min !== "13.0") throw new Error(`Unexpected macOS deployment target for ${path}: ${min}`);
        run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
        run("/usr/bin/codesign", ["--verify", "--strict", path]);
      }
      const ioPlugins = execFileSync(join(stage, "bin/radare2"), ["-N", "-L"], { encoding: "utf8", env: { HOME: work, PATH: "", R2_PREFIX: stage } });
      if (!/\bnull\b/.test(ioPlugins)) throw new Error("Missing io.null: zero-filled sections cannot be mapped");
      // Ship corresponding source, license texts, notices and the build recipe with the binaries.
      const sourceDir = join(stage, "sources");
      mkdirSync(sourceDir);
      for (const source of sources) copyFileSync(join(cache, source.file), join(sourceDir, source.file));
      copyFileSync(fileURLToPath(import.meta.url), join(sourceDir, "bundle-binary-analysis.mjs"));
      writeFileSync(join(sourceDir, "radare2-plugins.cfg"), plugins);
      copyFileSync(join(root, "tools/binary-analysis/NOTICE.md"), join(stage, "NOTICE.md"));
      cpSync(join(r2, "doc/licenses"), join(stage, "licenses/radare2"), { recursive: true });
      copyFileSync(join(r2, "COPYING.md"), join(stage, "licenses/radare2/COPYING.md"));
      mkdirSync(join(stage, "licenses/r2ghidra"));
      for (const name of ["LICENSE.md", "LESSER.md", "COPYING"]) copyFileSync(join(ghidra, name), join(stage, "licenses/r2ghidra", name));
      copyFileSync(join(ghidra, "subprojects/ghidra-native/LICENSE"), join(stage, "licenses/ghidra-native-LICENSE"));
      copyFileSync(join(ghidra, "subprojects/zlib/LICENSE"), join(stage, "licenses/zlib-LICENSE"));
      const launcherDependencies = licenses.map(({ notices, ...pkg }) => {
        const dir = join("licenses/ondra-binary", `${pkg.name}-${pkg.version}`);
        mkdirSync(join(stage, dir), { recursive: true });
        for (const [name, content] of Object.entries(notices)) writeFileSync(join(stage, dir, name), content);
        return { ...pkg, files: Object.keys(notices).map(name => join(dir, name)) };
      });
      const manifest = { version, arch, macOS: "13.0", recipe, sources, launcherDependencies, bytes: files(stage).reduce((sum, p) => sum + statSync(p).size, 0), files: Object.fromEntries(files(stage).map((p) => [relative(stage, p), hash(readFileSync(p))])) };
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(stage, dest, { recursive: true });
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  run("cargo", ["build", "--release", "--locked", "--manifest-path", join(root, "tools/binary-analysis/Cargo.toml"), "--target", triple], { env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" } });
  const launcher = join(bins, `ondra-binary-${triple}`);
  copyFileSync(join(root, "tools/binary-analysis/target", triple, "release/ondra-binary"), launcher);
  chmodSync(launcher, 0o755);
  run("/usr/bin/codesign", ["--force", "--sign", "-", launcher]);
  // Tauri signs sidecars, but not Mach-O files stored in Resources. Sign those
  // inside-out here when the same distribution identity is supplied to Tauri.
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (identity) {
    for (const path of files(dest).filter((p) => p.endsWith(".dylib") || p === join(dest, "bin/radare2"))) {
      run("/usr/bin/codesign", ["--force", "--sign", identity, ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]), path]);
      run("/usr/bin/codesign", ["--verify", "--strict", path]);
    }
    const manifest = JSON.parse(readFileSync(stamp, "utf8"));
    for (const p of Object.keys(manifest.files)) manifest.files[p] = hash(readFileSync(join(dest, p)));
    writeFileSync(stamp, JSON.stringify(manifest, null, 2) + "\n");
  }
  console.log(`binary-analysis: ${version} ${arch}${cached ? " (verified cache)" : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) console.log("Usage: node scripts/bundle-binary-analysis.mjs\nBuild native macOS analysis engine, libraries, decompiler, source and launcher into src-tauri.");
  else await bundleBinaryAnalysis();
}
