// Developer-only integration check. Never executes a sample or installs tooling.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launcherLicenses } from "./bundle-binary-analysis.mjs";

const { values } = parseArgs({ options: { analyzer: { type: "string" }, out: { type: "string" }, "package-only": { type: "boolean" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("Usage: node scripts/check-binary-analysis.mjs --analyzer /path/to/ondra-binary --out /fresh/evidence [--package-only]\n--package-only checks payload notices, dependencies, signatures and FIFO rejection without rebuilding or analyzing samples.\nmacOS developer prerequisites: clang/SDK, lipo, Rust's rust-lld. Samples are never executed.\nRuns the real analyzer with no network, no external executable access, empty PATH and a private HOME.");
  process.exit(0);
}
assert(values.analyzer && values.out, "--analyzer and --out are required");
assert.equal(process.platform, "darwin");
const analyzer = resolve(values.analyzer);
const out = resolve(values.out);
assert(!existsSync(out), "Evidence directory must be fresh");
mkdirSync(out, { recursive: true });
const home = join(out, "home");
mkdirSync(home);
const parent = dirname(analyzer);
const candidate = [join(parent, "../Resources/binary-analysis"), join(parent, "../resources/binary-analysis"), join(parent, "../../resources/binary-analysis")].map(resolvePath => resolve(resolvePath)).find(p => existsSync(join(p, "bin/radare2")));
assert(candidate, "Missing bundled engine");
// The launcher canonicalizes this path before exec; match it so the isolation
// profile's literal allowance works even when resources is reached via a symlink.
const root = realpathSync(candidate);
const records = [];
function build(command, args) {
  execFileSync(command, args, { stdio: "pipe" });
  records.push({ command, args, status: 0 });
}
const profile = `(version 1)
(allow default)
(deny network*)
(deny process-exec)
(allow process-exec (literal ${JSON.stringify(analyzer)}) (literal ${JSON.stringify(join(root, "bin/radare2"))}))
(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local") (subpath "/Library/Java") (subpath "/Applications/Xcode.app"))
`;
writeFileSync(join(out, "isolation.sb"), profile);
// A startup file must never be read, even if HOME/R2 variables are inherited.
writeFileSync(join(home, ".radare2rc"), "?e ONDRA_UNWANTED_STARTUP\n");
const env = { HOME: home, PATH: "", LC_ALL: "C", R2_PREFIX: home, R2_LIBR_PLUGINS: home, SLEIGHHOME: home };
function invoke(label, args, status = 0, error, timeout = 300_000) {
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", join(out, "isolation.sb"), analyzer, ...args], { cwd: home, env, encoding: "utf8", timeout, maxBuffer: 40 * 1024 * 1024 });
  writeFileSync(join(out, `${label}.json`), result.stdout ?? "");
  writeFileSync(join(out, `${label}.stderr`), result.stderr ?? "");
  records.push({ command: analyzer, args, status: result.status, signal: result.signal, isolated: true });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${label}: ${result.stderr}`);
  assert(!`${result.stdout}${result.stderr}`.includes("ONDRA_UNWANTED_STARTUP"), "User startup file was loaded");
  if (error) assert.match(result.stderr, error);
  return status === 0 ? JSON.parse(result.stdout) : null;
}
const cases = [];
try {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const expectedLicenses = launcherLicenses();
  const expectedDependencies = expectedLicenses.map(({ notices, ...pkg }) => ({ ...pkg, files: Object.keys(notices).map(name => join("licenses/ondra-binary", `${pkg.name}-${pkg.version}`, name)) }));
  assert.deepEqual(manifest.launcherDependencies, expectedDependencies, "Cargo dependency notice inventory must match the lockfile");
  for (const pkg of expectedLicenses) {
    for (const [name, content] of Object.entries(pkg.notices)) {
      assert.equal(readFileSync(join(root, "licenses/ondra-binary", `${pkg.name}-${pkg.version}`, name), "utf8"), content, `Unmodified upstream notice: ${pkg.name}/${name}`);
    }
  }
  console.log(`PASS launcher notices: ${expectedDependencies.length} locked dependencies`);
  const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(sha256(join(root, path)), hash, `Payload hash: ${path}`);
  for (const source of manifest.sources) assert.equal(sha256(join(root, "sources", source.file)), source.sha256);
  for (const path of ["NOTICE.md", "sources/radare2-plugins.cfg", "licenses/radare2/COPYING.md", "licenses/r2ghidra/LESSER.md", "licenses/r2ghidra/COPYING", "licenses/ghidra-native-LICENSE", "licenses/zlib-LICENSE"]) assert(existsSync(join(root, path)), `Missing notice/source: ${path}`);
  const native = [...Object.keys(manifest.files).filter(p => p.endsWith(".dylib") || p === "bin/radare2").map(p => join(root, p)), analyzer];
  const audit = [];
  for (const path of native) {
    build("/usr/bin/codesign", ["--verify", "--strict", path]);
    const arch = execFileSync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" }).trim();
    assert.equal(arch, manifest.arch === "x64" ? "x86_64" : "arm64", path);
    const load = execFileSync("/usr/bin/otool", ["-l", path], { encoding: "utf8" });
    assert.match(load, /minos 13\.0\b/, `Deployment target: ${path}`);
    const dependencies = execFileSync("/usr/bin/otool", ["-L", path], { encoding: "utf8" }).trim().split("\n").slice(1).map(line => line.trim().split(" (compatibility")[0]);
    for (const dep of dependencies) {
      if (dep.startsWith("/usr/lib/") || dep.startsWith("/System/Library/")) continue;
      assert(dep.startsWith("@loader_path/"), `External dependency: ${path}: ${dep}`);
      assert(existsSync(resolve(dirname(path), dep.slice("@loader_path/".length))), `Missing dependency: ${dep}`);
    }
    audit.push({ path, arch, dependencies, signature: "verified" });
  }
  writeFileSync(join(out, "payload-audit.json"), JSON.stringify({ native: audit, files: Object.keys(manifest.files).length, bytes: Object.keys(manifest.files).reduce((sum, p) => sum + statSync(join(root, p)).size, statSync(analyzer).size) }, null, 2));
  const denied = spawnSync("/usr/bin/sandbox-exec", ["-f", join(out, "isolation.sb"), "/usr/bin/true"], { env, encoding: "utf8" });
  assert.notEqual(denied.status, 0, "Isolation must reject external executable access");
  assert.match(denied.stderr, /Operation not permitted/);
  writeFileSync(join(out, "sandbox-control.stderr"), denied.stderr);
  const fifo = join(out, "input.fifo");
  build("/usr/bin/mkfifo", [fifo]);
  invoke("fifo", ["inspect", fifo], 1, /regular file/, 2_000);
  console.log("PASS FIFO input: rejected without waiting for a writer");
  if (!values["package-only"]) {
  const source = join(out, "sample.c");
  writeFileSync(source, "__attribute__((noinline)) unsigned classify_bucket(unsigned x) { return ((x ^ 0x5au) & 0xffu) == 0x2au ? 7u : 3u; }\nint main(void) { return (int)classify_bucket(112); }\n");
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
  const lld = join(sysroot, "lib/rustlib", host, "bin/rust-lld");
  for (const arch of ["arm64", "x86_64"]) {
    const macho = join(out, `macho-${arch}`);
    build("/usr/bin/clang", ["-arch", arch, "-mmacosx-version-min=13.0", "-O0", source, "-o", macho]);
    cases.push({ name: `macho-${arch}`, file: macho, arch, format: "MACH064" });
    for (const format of ["elf", "pe"]) {
      const cpu = arch === "arm64" ? "aarch64" : "x86_64";
      const file = join(out, `${format}-${arch}`);
      const obj = `${file}.o`;
      build("/usr/bin/clang", ["-target", `${cpu}-${format === "elf" ? "unknown-linux-gnu" : "pc-windows-msvc"}`, "-ffreestanding", "-fno-stack-protector", "-O0", "-c", source, "-o", obj]);
      build(lld, format === "elf" ? ["-flavor", "gnu", "-e", "main", obj, "-o", file] : ["-flavor", "link", "/entry:main", "/subsystem:console", "/nodefaultlib", "/export:classify_bucket", `/out:${file}`, obj]);
      cases.push({ name: `${format}-${arch}`, file, arch, format: format === "elf" ? "ELF64" : "PE32+" });
    }
  }
  const universal = join(out, "universal");
  build("/usr/bin/lipo", ["-create", join(out, "macho-arm64"), join(out, "macho-x86_64"), "-output", universal]);
  for (const arch of ["arm64", "x86_64"]) cases.push({ name: `universal-${arch}`, file: universal, arch, format: "MACH064", options: ["--arch", arch] });
  for (const sample of cases) {
    chmodSync(sample.file, 0o600);
    const hash = createHash("sha256").update(readFileSync(sample.file)).digest("hex");
    const options = sample.options ?? [];
    const inspect = invoke(`${sample.name}-inspect`, ["inspect", sample.file, ...options]);
    assert.equal(inspect.target.class, sample.format);
    assert.equal(inspect.target.arch, sample.arch === "arm64" ? "arm" : "x86");
    const functions = invoke(`${sample.name}-functions`, ["functions", sample.file, ...options]);
    const fn = functions.data.find(f => f.name.includes("classify_bucket"));
    assert(fn, `${sample.name}: missing known function`);
    const address = `0x${fn.addr.toString(16)}`;
    const assembly = invoke(`${sample.name}-disassemble`, ["disassemble", sample.file, ...options, "--address", address]);
    const decompile = invoke(`${sample.name}-decompile`, ["decompile", sample.file, ...options, "--address", address]);
    const named = invoke(`${sample.name}-named`, ["functions", sample.file, ...options, "--name", "classify_bucket"]);
    assert(named.data.length > 0 && named.data.every(f => f.name.includes("classify_bucket")), `${sample.name}: --name must return only matching functions`);
    assert(named.data.length < functions.data.length, `${sample.name}: --name must narrow the list`);
    assert(assembly.data.ops.length > 3, "Expected actual machine instructions");
    assert(assembly.data.ops.some(op => op.type === "ret"), "Expected a return instruction");
    assert.match(decompile.data.code, /return/);
    assert.match(decompile.data.code, /\b7\b/);
    assert.match(decompile.data.code, /\b3\b/);
    for (const result of [inspect, functions, assembly, decompile]) {
      assert.equal(result.sha256, hash);
      assert.equal(result.executedTarget, false);
    }
    sample.address = address;
    sample.sha256 = hash;
    console.log(`PASS ${sample.name}: metadata, functions, instructions, Ghidra pseudocode`);
  }
  // Default output must stay context-sized: many functions and one huge function.
  const bigSource = join(out, "large.c");
  const helpers = Array.from({ length: 400 }, (_, i) => `__attribute__((noinline)) unsigned f${i}(unsigned x) { return x * ${i + 3}u ^ ${i}u; }`);
  const steps = Array.from({ length: 1500 }, (_, i) => `  v = (v * ${i % 97 + 3}u) ^ (v >> ${i % 13 + 1}); if (v & ${2 ** (i % 31)}u) v += f${i % 400}(v);`);
  writeFileSync(bigSource, `${helpers.join("\n")}\n__attribute__((noinline)) unsigned huge(volatile unsigned v) {\n${steps.join("\n")}\n  return v;\n}\nint main(int c, char **a) { (void)a; return (int)huge((unsigned)c); }\n`);
  const large = join(out, "large");
  build("/usr/bin/clang", ["-O0", "-mmacosx-version-min=13.0", bigSource, "-o", large]);
  chmodSync(large, 0o600);
  const listing = invoke("large-functions", ["functions", large]);
  assert(listing.data.truncated === true && listing.data.total > 300, "Large listing must be compact");
  assert.equal(listing.data.functions.length, 200);
  assert(listing.data.functions.every(f => Object.keys(f).sort().join() === "addr,name,size"), "Preview entries carry only name/addr/size");
  assert.match(listing.data.hint, /--name/);
  const hugeFn = invoke("large-named", ["functions", large, "--name", "huge"]).data.find(f => f.name.includes("huge"));
  assert(hugeFn, "Named lookup must still return the full entry");
  const hugeAddress = `0x${hugeFn.addr.toString(16)}`;
  const longAsm = invoke("large-disassemble", ["disassemble", large, "--address", hugeAddress]);
  assert(longAsm.data.truncated === true && longAsm.data.ops.length === 300 && longAsm.data.totalOps > 300, "Disassembly must be capped");
  const longCode = invoke("large-decompile", ["decompile", large, "--address", hugeAddress]);
  assert(longCode.data.truncated === true && longCode.data.code.split("\n").length <= 401 && longCode.data.totalLines > 400, "Pseudocode must be capped");
  for (const [label, result] of [["functions", listing], ["disassemble", longAsm], ["decompile", longCode]]) {
    assert(JSON.stringify(result).length < 128 * 1024, `Bounded ${label} output must stay under 128 KiB`);
  }
  console.log("PASS large target: compact function preview, capped disassembly and pseudocode");
  invoke("name-miss", ["functions", join(out, "macho-arm64"), "--name", "no_such_function_zzz"], 1, /No analyzed function name contains/);
  invoke("name-wrong-op", ["inspect", join(out, "macho-arm64"), "--name", "main"], 2, /only filters the functions/);
  invoke("missing-slice", ["inspect", universal], 1, /requires --arch/);
  invoke("wrong-arch", ["inspect", join(out, "macho-arm64"), "--arch", "x86_64"], 1, /architecture.*not present/);
  invoke("unknown-address", ["decompile", join(out, "macho-arm64"), "--address", "0x1"], 1, /No complete|valid JSON/);
  invoke("injected-command", ["decompile", join(out, "macho-arm64"), "--address", "0x1;!touch injected"], 2, /hexadecimal/);
  const invalid = join(out, "invalid.bin");
  writeFileSync(invalid, "not a binary\n");
  invoke("unsupported", ["inspect", invalid], 1, /Unsupported target/);
  invoke("directory", ["inspect", home], 1, /regular file/);
  // Relocated filenames with spaces/metacharacters must not become engine commands.
  const tricky = join(out, "sample ; ! $ weird");
  copyFileSync(join(out, "macho-arm64"), tricky);
  invoke("quoted-path", ["inspect", tricky]);
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify({ status: "passed", scope: values["package-only"] ? "package and FIFO" : "all", launcherDependencies: expectedDependencies, cases, invocations: records.length, isolation: profile }, null, 2));
} catch (error) {
  writeFileSync(join(out, "summary.json"), JSON.stringify({ status: "failed", error: String(error), cases }, null, 2));
  throw error;
} finally {
  writeFileSync(join(out, "commands.json"), JSON.stringify(records, null, 2));
}
