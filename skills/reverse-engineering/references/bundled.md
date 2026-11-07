# Ondra's bundled static analyzer

`ondra-binary` is a native command on the worker's bundled PATH. It uses radare2
6.2.6 and r2ghidra 6.2.6, including Ghidra's C++ decompiler and compiled SLEIGH
processor data. It does not launch the target or require Java, Python, Xcode,
Homebrew, a paid license or another analysis-tool installation.

## Commands

Check local help and version before analysis:

```sh
command -v ondra-binary
ondra-binary --help
ondra-binary --version
```

Use an owned/authorized file, an absolute path and a fresh artifact directory.
Keep stdout and stderr separately; do not discard nonzero exits:

```sh
ondra-binary inspect "$BIN" > "$OUT/inspect.json" 2> "$OUT/inspect.stderr"
ondra-binary functions "$BIN" > "$OUT/functions.json" 2> "$OUT/functions.stderr"
```

A real application can hold thousands of functions; the full `functions` JSON
for one app bundle can exceed a model's context. Narrow it instead of reading it
whole. Pass `--name SUBSTR` (case-insensitive) to return only matching functions,
or filter the file on disk without loading it:

```sh
ondra-binary functions "$BIN" --name check_password > "$OUT/functions-named.json" 2> "$OUT/functions-named.stderr"
jq '.data[] | {name, addr, size}' "$OUT/functions.json"   # or: grep '"name"'
```

`--name` exits 1 when nothing matches. Discovery is heuristic, so a stripped or
optimized target may name the relevant code `sym.func.<addr>`; also search by
address range or follow references from strings and imports. Read the chosen
entry's `addr`, `name` and `size`. Convert its virtual address to hexadecimal;
do not use a file offset, runtime ASLR address or guessed symbol. Then run both
operations using that same numeric address:

```sh
ondra-binary disassemble "$BIN" --address "$ADDRESS" > "$OUT/disassembly.json" 2> "$OUT/disassembly.stderr"
ondra-binary decompile "$BIN" --address "$ADDRESS" > "$OUT/decompile.json" 2> "$OUT/decompile.stderr"
```

For universal Mach-O, add `--arch arm64` or `--arch x86_64` to every command.
The choice must match the target under investigation. Thin files normally detect
their CPU automatically. On Apple silicon the system binaries and most shipping
apps are `arm64e` (sometimes with an extra `arm64e.x1` slice) rather than plain
`arm64`; `--arch arm64` selects any 64-bit ARM slice, so use it for those and
confirm `target.machine` in the output. The analyzer rejects unknown options and free-form
engine commands. It never falls back to a system tool or installs a plugin.

## Read the result

Every successful command returns one JSON object containing `engine`, `operation`,
`input`, `sha256`, `size`, `target`, `address`, `data` and `executedTarget: false`.
The hash is computed from the exact private copy passed to the engine. Check
that all exports share the target hash and selected architecture.

- `inspect`: format, CPU, base address and binary metadata in `data`/`target`.
- `functions`: discovered functions in `data`. Discovery is not guaranteed complete.
- `disassemble`: instruction addresses, bytes, opcodes and analysis in `data.ops`.
- `decompile`: actual Ghidra decompiler output in `data.code`, with annotations.
  Label it **decompiler pseudocode**. Compare its critical branches to assembly;
  inferred types, names and calling conventions can be wrong.

Exit 1 means analysis is incomplete or failed, including missing resources,
unsupported input, empty/invalid output and timeouts. Exit 2 means invalid
arguments. Preserve stderr and report the failed operation; an earlier successful
disassembly does not turn failed decompilation into a pass.

## Scope and safety

Supported target boundary: 64-bit ARM/x86 Mach-O, ELF and PE. Parsing a Linux or
Windows binary on macOS does not make it runnable there. Universal Mach-O requires
explicit selection. 32-bit code, raw firmware, DEX/APK, packed/encrypted files,
source recovery and debugger attachment are outside this command's promise.
Unsupported instructions, optimizations or bad function boundaries can prevent
useful decompilation even within the accepted formats.

The launcher copies the input to a non-executable file in a private temporary
directory, clears inherited environment variables, uses an empty PATH and fresh
HOME, and ignores user startup files/plugins. Each engine invocation has a
120-second limit and 32 MiB output limit; inputs are limited to 512 MiB.
It cleans up its temporary working files; exported JSON and stderr are the
persistent evidence. It does not create a full Ghidra project.

These precautions are not an OS security sandbox. Native parsers can have bugs.
Use a disposable isolated lab for hostile samples and keep the skill's ownership,
no-upload and no-target-execution boundaries. The optional Python/LLDB lab is a
separate debugger calibration, not a prerequisite for these static commands.

The app's `Contents/Resources/binary-analysis/NOTICE.md`, `licenses/`, `sources/`
and `manifest.json` contain redistribution notices, corresponding source, build
recipe, upstream URLs and checksums. Both engine and decompiler are LGPLv3;
Ghidra's native core is Apache-2.0. The whole Java Ghidra application is not bundled.
