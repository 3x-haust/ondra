# Evidence and completion

## Case directory

Create a new directory under `$APP_ARTIFACTS_DIR`. Do not overwrite an earlier
case. Keep originals read-only where practical. Do not commit proprietary samples,
credentials, memory dumps or user data to the repository.

A layout that works (the names are a default):
- `target.json`: provenance/permission, absolute copied path, SHA-256, byte size,
  format, architecture/slice, OS/CPU and tool paths/versions.
- `commands.jsonl`: timestamp, argv as an array, cwd, explicit environment changes,
  exit code, stdout/stderr file paths, timeout/error if applicable. Use full logs;
  excerpts in a report must point back to them. Avoid secrets in commands/logs.
- Static exports: headers, imports, symbols, strings, disassembly and (only if
  actually produced) decompiler output/project. Preserve options and base address.
- `hypotheses.md`: append observations and revisions; never rewrite a failed
  prediction as if it had been correct before the test.
- Dynamic logs: exact input, breakpoint location and hit, register/memory/stack
  observations, return/side effect, normal execution control and exit status.
- `findings.md`: answer, evidence links, reproduction and limitations.

A useful hypothesis record:

| Field | Content |
| --- | --- |
| Question | One observable behavior |
| Static lead | Hash + module + function/offset + instruction bytes |
| Hypothesis | A falsifiable rule, not a tool name |
| Alternative | Another explanation fitting current evidence |
| Prediction | Input and expected output/branch before running |
| Counterexample | A result that rejects the hypothesis |
| Observation | Raw command/log location, actual value |
| Verdict | Supported on these cases / rejected / unresolved |
| Remaining scope | Untested paths, environment dependencies |

Use "supported on these cases", not "proved for every input", unless the
instruction-level reasoning actually establishes that stronger claim. Account
for truncation, integer overflow, signedness, external state and undefined behavior.

## Completion gates

1. Target and authorization boundary are explicit; original hash is retained.
2. Relevant instructions/data flow are located, not just strings or UI behavior.
3. At least one falsifiable hypothesis and contrasting inputs are recorded.
4. Requested execution has real inputs, outputs and exit status. If debugging or
   tracing is requested, also require an actual breakpoint hit or trace event on
   that target. Normal execution does not satisfy a debugger/trace requirement.
   Unavailable execution is **blocked**, not passed or replaced by an example.
5. Every finding links to raw evidence and reproducible commands on that host.
6. Unavailable decompilation, unresolved calls and untested paths are named.

When static-only analysis was requested, gate 4 is out of scope. If a requested
execution, debugger or trace requirement is blocked, finish with an incomplete
handoff and say which environment or permission is needed. A narrower calibration
may be reported separately, but never replaces the blocked requirement. Do not
invent success counts.

## Evidence interpretation

A successful command exit alone is insufficient: a breakpoint may be pending,
a function list may be empty, or the tool may have analyzed the wrong slice.
Read the artifact and validate its identity and meaningful content. A decompiler
is an interpretation layer; compare important predicates with machine code.
A debug-enabled companion build can help explain a stripped binary but is a
**different artifact**: hash and label both, never transfer addresses blindly.

Primary command reference: https://lldb.llvm.org/use/tutorial.html
