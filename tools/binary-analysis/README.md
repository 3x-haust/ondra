# Bundled binary analysis

`ondra-binary` is Ondra's native, fixed-command launcher for radare2 and
r2ghidra 6.2.6. The engine, dylibs, compiled SLEIGH data, licenses and complete
corresponding upstream source archives ship in `Contents/Resources/binary-analysis`.
The launcher ships next to Ondra in `Contents/MacOS`, already on the worker PATH.
There is no first-run download, plugin installation or external runtime fallback.

## Build

`pnpm bundle` runs `scripts/bundle-binary-analysis.mjs`. To build only this tool:

```sh
node scripts/bundle-binary-analysis.mjs
cargo test --locked --manifest-path tools/binary-analysis/Cargo.toml
```

Build prerequisites: native macOS arm64 or x86_64, Node, Rust/Cargo, a C/C++
compiler/macOS SDK, make and pkg-config. These are developer dependencies, not
runtime dependencies. Source archives are SHA-256 pinned and cached under
`~/.cache/ondra-build/binary-analysis`. All non-system dynamic dependencies are
relocated to `@loader_path`; the build verifies a macOS 13 deployment target and
signs each engine Mach-O. See [NOTICE.md](NOTICE.md) for license obligations,
rebuild instructions and distribution-signing requirements.

The upstream no-GPL preset needs the LGPL `io.null` plugin added: without it,
zero-filled section mappings fail and ordinary PE files produce no functions.
The recipe records the effective plugin configuration alongside the source.
The normal build never runs r2pm, changes system installations or installs to
`/usr/local`.

## Verify a packaged app

Build the actual app with `pnpm tauri build --bundles app`. Then run:

```sh
node scripts/check-binary-analysis.mjs --help
node scripts/check-binary-analysis.mjs \
  --analyzer src-tauri/target/release/bundle/macos/Ondra.app/Contents/MacOS/ondra-binary \
  --out "$APP_ARTIFACTS_DIR/binary-analysis-check"
```

The output directory must be new. This developer check uses clang, lipo and
Rust's rust-lld to compile owned Mach-O, ELF and PE samples for both ARM64 and
x86-64, plus a universal Mach-O. It never executes the samples. The actual
analyzer runs under a macOS sandbox that denies network and every executable
except the bundled launcher/engine, with an empty PATH and private HOME.
Homebrew and Java/Xcode paths are unreadable during analysis. Startup-file and
inherited engine-path contamination are checked, as are wrong CPU selection,
unsupported input, command injection, invalid addresses and awkward filenames.

Each case must produce metadata, a discovered known function, actual instructions
and Ghidra pseudocode with the sample's two return values. Raw JSON, stderr,
commands, sample hashes and a summary are retained. This is a known-source
integration calibration, not a benchmark of unknown or hostile software.

## Supported boundary

The installed app's host platform remains Apple silicon/macOS 13+. The builder
also permits native Intel builds, but Intel host execution and minimum-OS runtime
compatibility need separate machines for validation. Target CPU and host CPU are
different: static ARM64 and x86-64 analysis does not execute either target.

Accepted targets are 64-bit ARM/x86 Mach-O, ELF and PE. Universal Mach-O requires
explicit `--arch`. Full Ghidra/Java, debuggers, managed-code decompilers, 32-bit
code and raw firmware are not included. Decompiler output is inferred pseudocode,
not recovered source, and can fail even for an accepted target. Native parsing is
not an OS security sandbox; hostile samples still require an isolated lab.

Worker usage and evidence requirements live in
[the bundled analyzer guide](../../skills/reverse-engineering/references/bundled.md).
