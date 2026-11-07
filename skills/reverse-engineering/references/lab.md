# Owned sample calibration

This lab compiles only `samples/bucket.c`, which reads one unsigned integer and
prints a bucket number. It has no networking, credentials, file mutation or
third-party target. The source is intentionally available: this is a transparent
toolchain calibration, not a claim of blind source recovery or a RE benchmark.

## Prerequisites and execution

Native macOS arm64 or x86_64, Python 3, file, nm, otool, clang and LLDB are required.
Use the tool guide if anything is missing. Run from any directory:

```sh
python3 "<skill-directory>/scripts/verify.py" --help
python3 "<skill-directory>/scripts/verify.py" --out "$APP_ARTIFACTS_DIR/reversing-lab"
```

The output directory must not already exist; choose a new name for every run.
No input executable option exists, so the runner cannot accidentally execute an
unknown sample. The script copies its source to the output directory and builds
with `-O1 -g0 -Wall -Wextra -Werror`. There is a function symbol but no source-level
debug information. Compiler optimizations may fold the source operations.

Full verification returns zero only after normal runs **and** three actual LLDB
breakpoint/register/return observations pass. A missing tool, bad output, pending
breakpoint, launch failure or timeout leaves `status: incomplete` and a nonzero
exit code. The 45-second debugger deadline is separate from compilation's
300-second limit. The runner attempts to stop only its own descendant processes
on timeout; inspect remaining job-owned processes if cleanup itself errors.

If a debugger cannot launch and the useful authorized scope is disassembly plus
normal execution, select it explicitly:

```sh
python3 "<skill-directory>/scripts/verify.py" --runtime-only \
  --out "$APP_ARTIFACTS_DIR/reversing-runtime"
```

This leaves `debugger: not requested` and `debugger_cases: 0`. A pass here means
only static inspection and uninstrumented execution passed. It does not make a
previous failed debugger run pass. Keep that failed run and report it separately.
Never select this narrower mode to claim a required debugger gate was satisfied.

## Inspect, hypothesize, test

Read `*-function.stdout.txt`, not just `summary.json`. Find the mask, comparison,
conditional selection and return. On an arm64 build, the compiler may produce
`and` with `0xff` and `cmp` with `0x70` instead of the literal source XOR. Determine
the actual instructions and addresses from the output, not this example.

The lab records these **predictions before normal execution**:

| Input | H1: low byte equals 112 | H2: full value equals 112 |
| --- | --- | --- |
| 112 | bucket 7 | bucket 7 |
| 113 | bucket 3 | bucket 3 |
| 368 | bucket 7 | bucket 3 |
| 0 | bucket 3 | bucket 3 |

368 is 112 + 256, so it separates the two explanations. `invalid` must return
exit code 2. These numbers describe the owned fixture contract, not observed
results. The script asserts actual output and records command exit codes.

Full mode additionally launches three cases (112, 113, 368), stops at the actual
function entry, captures module addresses, reads the argument register, steps
out, reads the return register and continues to normal exit. Read the logs to
verify the target hash, resolved location, hit count and values. Compare against
the uninstrumented runs. This is instruction/register observation, not decompilation.

## Reproduce individual commands

`commands.jsonl` contains the exact argv arrays, cwd, time, explicit environment
overrides, expected tool timeout, stdout/stderr paths and exit codes/errors.
Use those values for a precise replay. Preserve the tool versions and compare
source/binary hashes. Builds on a different toolchain can produce different
bytes; label a rebuild as a new target instead of claiming byte identity.

For manual LLDB reproduction, use the recorded binary and ABI registers:

```sh
lldb --no-lldbinit --batch "/absolute/evidence/bucket" \
  -o 'breakpoint set --name classify_bucket --skip-prologue false' \
  -o 'run 368' -o 'image list -o -f' -o 'breakpoint list' \
  -o 'register read w0' -o 'disassemble --name classify_bucket --bytes' \
  -o 'thread step-out' -o 'register read w0' -o continue
```

`w0` is for native arm64 only; on the supported native x86_64 lab use `edi` for
the input and `eax` for the return. If launch/attach blocks, stop and preserve
the error; do not change OS security policies or attach to a user's other app.

## What this does not verify

Ghidra/decompilation, Frida hooks, stripped/packed binaries, Windows/Linux guests,
unknown apps, adversarial inputs and every integer value are outside this lab.
Support instructions for these are not claims that they were tested on this host.
