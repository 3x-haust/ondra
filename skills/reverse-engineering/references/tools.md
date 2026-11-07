# Tool and host guide

Check executable paths, versions and local help before using any command below.
These are recipes, not evidence that the tools ran. Do not install a backend or
upload a sample without permission. This skill bundles no decompiler, debugger,
MCP server, Java runtime, license or isolated guest OS.

## Capability matrix

| Target / host | Static inspection | Dynamic work | Requirements / limits |
| --- | --- | --- | --- |
| Mach-O on macOS | file, nm, otool, LLDB; optional Ghidra | Native LLDB on owned programs | Xcode or Command Line Tools; debugger permission and compatible CPU. SIP/protected targets can deny attach even for root. |
| ELF on macOS | Format-aware LLVM or Ghidra | Compatible isolated Linux guest | Parsing ELF does not make it runnable on macOS. CPU and OS ABI both matter. |
| PE on macOS | Ghidra or LLVM COFF inspection | Authorized isolated Windows environment | PE parsing is not Windows process debugging. Do not execute through an unreviewed compatibility layer. |
| Android DEX/APK | Optional JADX for DEX; native libraries separately | Authorized emulator/device and suitable instrumentation | Java decompilation does not cover JNI native libraries. APK installation is execution. |
| JavaScript/Electron | Source/bundle/AST and source-map inspection | Authorized app runtime/devtools | Static IPC edges do not prove handlers were registered or executed. |
| Raw/packed/unknown | Inspect headers/entropy/loader clues in isolation | Only an approved disposable lab | CPU/load address may be unknown; do not guess a decompiler architecture and present it as fact. |

macOS local checks:

```sh
command -v file nm otool clang lldb python3
clang --version
lldb --version
otool --version
```

Apple's Command Line Tools installation is a user-approved setup step, not an
implicit action of this skill. A binary on PATH is not proof that the SDK is
usable, a license is accepted or a debugger can launch. Keep launch errors and
permission prompts; never change developer/security policies automatically.

## Native static inspection

On a Mach-O copy, after checking local help:

```sh
file "$BIN"
otool -hv "$BIN"
otool -L "$BIN"
nm "$BIN"
otool -tvV "$BIN"
lldb --no-lldbinit --batch "$BIN" -o 'disassemble --name FUNCTION --bytes'
```

Replace FUNCTION with a symbol found in the binary. LLDB in this last command
loads and disassembles; it does **not** execute the target or prove a breakpoint.
For universal files, enumerate slices and choose the intended CPU. `strings`
provides leads only; search references before assigning meaning.

With installed LLVM tools, inspect their help and select format-specific options:

```sh
llvm-readobj --file-header --sections --symbols --relocations "$BIN"
llvm-objdump --disassemble --reloc "$BIN"
```

For ELF, check magic, EI_CLASS, EI_DATA and e_machine. For PE, check PE signature,
Machine and optional-header magic. For Mach-O, check magic and cputype/cpusubtype.
File offset, image-relative RVA, virtual address and runtime ASLR address differ.
Disable external symbol downloads when analyzing private samples; the current
LLVM docs include `--no-debuginfod`, but check the installed tool supports it.

## Decompilation with Ghidra

Use the official release archive and the JDK required by **that release's**
installation guide. Do not assume an old JDK recipe applies to the current
release or that the source archive is an executable distribution. macOS, Linux
and Windows have separate native-component requirements.

Read the installed `support/analyzeHeadlessREADME.html` in full before running.
A documented import/analysis skeleton is:

```sh
"$GHIDRA_HOME/support/analyzeHeadless" "$OUT/projects" case-name \
  -import "$BIN" -analysisTimeoutPerFile 120 -max-cpu 1 \
  -log "$OUT/ghidra.log" -scriptlog "$OUT/ghidra-script.log"
```

Create `$OUT/projects` first and use a fresh project name. Windows uses the
`.bat` entry point. Do not supply `-processor` or a compiler spec until the
format/CPU evidence supports it. Read the selected language, errors and timeout
status in the logs: command exit alone is not a complete-analysis guarantee.

This import does **not** export decompiled C. Use the GUI decompiler or a reviewed
local post-script through `-scriptPath` / `-postScript`, checked against the
installed Ghidra API. Save script/hash, function addresses, decompiler errors and
output. Never claim a decompilation run merely because `analyzeHeadless` started.
Ghidra p-code and inferred variables/types are analysis models, not original
source. Compare important predicates with disassembly and observed behavior.

radare2 and Rizin are optional alternatives, not prerequisites. Inspect the local
command help and installed plugins: radare2's r2ghidra decompilation is not a
promise of the base install, and Rizin is a distinct project, not a command alias.
Hopper/IDA require their own installation and applicable licenses. No engine
backend should be silently swapped while retaining another tool's label.

## Dynamic observation

LLDB for an owned native executable:

```sh
lldb --no-lldbinit "$BIN"
```

Inside LLDB, consult `help` for each command, then use a real function name:

```text
breakpoint set --name FUNCTION --skip-prologue false
breakpoint list
run INPUT
image list -o -f
thread backtrace
register read
disassemble --frame --bytes
thread step-inst
thread step-out
continue
```

The initial breakpoint may be pending. Verify a resolved location and actual
hit. Use the ABI to choose argument/return registers; the lab uses w0 on macOS
arm64, edi/eax on native macOS x86_64. Do not apply those to other ABIs. Avoid
`expression` for passive observation because it may run target code.

On a suitable Linux host, GDB can inspect the same classes of evidence. Avoid
untrusted initialization/auto-load scripts (`-nx`, `-iex 'set auto-load no'`);
check local docs. `-batch` success is not the inferior's exit status. Preserve
both, and inspect `-return-child-result` semantics when using it.

Frida requires its tools and an instrumentation-capable host/target. Read
installation and platform docs; remote devices have additional requirements.
A reviewed `Interceptor.attach` hook or `frida-trace` can record calls, inputs,
returns and stacks. Log tool/target versions, module identity, the script hash,
hook resolution and actual events. No events can mean a bad hook, not absence of
behavior. Keep an uninstrumented control; tracing may change timing. Never
bypass signing or system protections to make a demonstration pass.

## Official references

- Agent Skills: https://agentskills.io/specification
- Arm AAPCS64 (register widths and parameter/result rules): https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst
- Apple ARM64 ABI differences: https://developer.apple.com/documentation/xcode/writing-arm64-code-for-apple-platforms
- LLDB tutorial: https://lldb.llvm.org/use/tutorial.html
- LLDB command map: https://lldb.llvm.org/use/map.html
- LLVM readobj: https://llvm.org/docs/CommandGuide/llvm-readobj.html
- LLVM objdump: https://llvm.org/docs/CommandGuide/llvm-objdump.html
- PE format: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
- ELF header: https://gabi.xinuos.com/elf/02-eheader.html
- Mach-O headers: https://github.com/apple-oss-distributions/xnu/blob/main/EXTERNAL_HEADERS/mach-o/loader.h
- Ghidra installation: https://github.com/NationalSecurityAgency/ghidra
- Ghidra headless: https://raw.githubusercontent.com/NationalSecurityAgency/ghidra/master/Ghidra/Features/Base/src/main/help/help/topics/HeadlessAnalyzer/HeadlessAnalyzer.htm
- Ghidra decompiler concepts: https://raw.githubusercontent.com/NationalSecurityAgency/ghidra/master/Ghidra/Features/Decompiler/src/main/help/help/topics/DecompilePlugin/DecompilerConcepts.html
- GDB batch mode: https://sourceware.org/gdb/current/onlinedocs/gdb/Mode-Options.html
- GDB auto-loading: https://sourceware.org/gdb/current/onlinedocs/gdb/Auto_002dloading-safe-path.html
- Frida installation: https://frida.re/docs/installation/
- Frida tracing: https://frida.re/docs/frida-trace/
- Apple runtime protections (archived): https://developer.apple.com/library/archive/documentation/Security/Conceptual/System_Integrity_Protection_Guide/RuntimeProtections/RuntimeProtections.html
- radare2: https://github.com/radareorg/radare2
- Rizin: https://github.com/rizinorg/rizin
- JADX: https://github.com/skylot/jadx
