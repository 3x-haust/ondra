# Bundled binary analysis

Ondra includes radare2 6.2.6 and r2ghidra 6.2.6 as separate native processes/libraries. r2ghidra uses Ghidra's native C++ decompiler, not the Ghidra Java application. No Java, Python, Homebrew, Xcode or separately installed analysis engine is needed at runtime. The launcher does not execute the input program.

## Coverage

The launcher accepts 64-bit ARM and x86 Mach-O, ELF and PE files. Universal Mach-O requires an explicit slice selection. Other formats, 32-bit targets, raw firmware, packed/encrypted code and managed-language recovery are not promised. A recognized format does not guarantee useful analysis: optimized code, missing symbols, unsupported instructions and incomplete function discovery can prevent decompilation. The output is decompiler pseudocode, not original source. Debugging and target execution are not included.

Native build targets are macOS arm64 and x86_64, minimum deployment target 13.0. Build on each architecture separately; the build refuses cross-architecture substitution. Ondra's distributed platform remains Apple silicon. An Intel build or execution on the minimum OS needs its own validation.

## Licenses and corresponding source

- radare2: predominantly LGPL-3.0-only, with component-specific licenses. See licenses/radare2 and the full source's COPYING.md, doc/licenses.md and individual file notices. GPL-only optional plugins, QuickJS, network support and native debugging are disabled in this build.
- r2ghidra: LGPL-3.0-only. Both LGPLv3 and the incorporated GPLv3 text are included in licenses/r2ghidra.
- ghidra-native: Apache-2.0, statically linked into r2ghidra; source, processor specifications and copyright notices are in the r2ghidra source archive.
- zlib: zlib license, statically linked into r2ghidra.
- radare2 also includes components such as Capstone, sdb, Zydis, libzip and compression code under their respective notices in the complete source archive.

The native ondra-binary launcher also contains Rust dependencies. Their original license and copyright notices are included under licenses/ondra-binary/<crate>-<version>/, with the exact dependency inventory and license expressions in manifest.json (launcherDependencies). This inventory follows Cargo.lock and includes build-time dependencies as well as runtime dependencies.

Complete corresponding source archives (including vendored dependencies) accompany the engine in sources/. The SHA-256-pinned upstream URLs, checksums and installed file hashes are recorded in manifest.json. No source download is required to inspect or modify these components. Copyright notices remain in their original source files. Ondra communicates with the engine through its command-line JSON interface; it does not link the application's code against these libraries.

You may modify or replace the LGPL components, including for debugging those modifications. No Ondra license term restricts those rights. Replacing code in a signed macOS app requires re-signing the changed nested code and then the enclosing app; local ad-hoc signatures do not require Ondra's signing key. Apple distribution signing/notarization is separate from LGPL permissions.

## Rebuild

The build recipe is sources/bundle-binary-analysis.mjs in the Ondra source tree (https://github.com/3x-haust/ondra). It uses the two accompanying source archives. Build prerequisites are Node.js, Rust/Cargo, a C/C++ compiler and macOS SDK, make, pkg-config, tar, otool, install_name_tool and codesign; these are developer requirements, not end-user requirements.

For the engine alone, extract both archives to a path without spaces. Copy sources/radare2-plugins.cfg over dist/plugins-cfg/plugins.nogpl.cfg in the extracted radare2 tree (--without-gpl resets plugins.cfg from this preset). This is the upstream no-GPL preset plus LGPL io.null, needed for zero-filled section mappings (including PE). Configure radare2 with a private prefix and these options:

    ./configure --prefix=PREFIX --without-gpl --without-qjs --without-sqsh --without-syscapstone --without-syszydis --disable-debugger --disable-network
    make -j8
    make install

Set MACOSX_DEPLOYMENT_TARGET=13.0, CFLAGS/CXXFLAGS=-O2 -mmacosx-version-min=13.0 and LDFLAGS=-Wl,-headerpad_max_install_names. For r2ghidra, put PREFIX/bin first on PATH, set R2_PREFIX=PREFIX and PKG_CONFIG_PATH=PREFIX/lib/pkgconfig, then configure with the same prefix, make and make install. The distribution tarballs include their subprojects; do not run the package manager or install to system directories.

Keep radare2, its dylibs and data, core_ghidra.dylib and the compiled SLEIGH specifications. The recipe rewrites non-system load commands to bundle-relative @loader_path paths and ad-hoc signs each Mach-O after relocation. When APPLE_SIGNING_IDENTITY is set, the recipe re-signs the nested engine and libraries with that identity before Tauri signs the sidecars and enclosing app. Distribution builds must supply this environment variable, not only Tauri's signingIdentity config key; otherwise resource code stays ad-hoc signed. No debugger entitlement or system security change is needed. Ad-hoc signature checks are not notarization or a Gatekeeper assessment.

## Isolation

Each invocation copies the input into a private, non-executable temporary file, hashes that copy, uses a fresh HOME and empty PATH, clears inherited variables and ignores user startup files. Only fixed analysis commands and a numeric virtual address are accepted. Results are JSON, with engine diagnostics on stderr and nonzero exits for incomplete output. No network or dynamic analysis is enabled. These precautions do not sandbox native parsers: suspicious binaries still require a disposable isolated environment.
