# Coding defaults: local engine evaluation

2026-11-05 · implementation `724c020` · **delivery verified; behavioral gate failed**.

The follow-up below adds explicit completion evidence requirements and repeats
the isolated evaluation. **Both behavioral cases still fail.**

## Method

Executed the bundled `ondra-engine` in RPC mode, once with the current full
`TASK_SYSTEM` and once with `SUB_SYSTEM`, against separate temporary invoice
fixtures. Constants were evaluated from `src/engine/prompts.ts`, not retyped.
Both used `--append-system-prompt`, built-in read/bash/edit/write tools, and
no skills, extensions, MCP, prompt templates or discovered context files.

A loopback recording proxy forwarded real requests, unchanged, to a private
Ollama server using the already-installed `gpt-oss:20b`. No scripted model
responses were used. Captured provider requests contained the entire selected
role prompt verbatim and exactly one `# Coding work` section in each case.
Server logs confirmed a 32768-token context and `truncated = 0` for every
completed request in the final run.

The task only requested fixing the sample invoice total to account for quantity
and print 23. It did not restate the coding workflow. Each fixture had a README,
`total.mjs`, `cli.mjs`, and two existing tests (empty invoice and quantity one).
The bug summed unit prices without quantities, so the CLI printed 9 instead of
23. Existing tests intentionally did not cover that fault. The evaluator's
before/after executions were not shown to the model and do not count as model
verification.

## Expected vs observed

| Check | Task worker | Subagent |
| --- | --- | --- |
| Full default prompt reaches real model request | Pass: verbatim, one coding section | Pass: verbatim, one coding section |
| Inspect implementation and nearby tests before editing | Pass | Pass; also read README and CLI |
| Execute reproduction before changing production code | Fail: no reproduction | Fail: no reproduction |
| Trace and report the root cause | Quantity multiplication added, but no explicit root-cause report | Quantity multiplication added, but no final findings report |
| Keep the implementation small | One expression in one file; also added an unmotivated `quantity ?? 1` fallback | Same change and fallback |
| Add a focused regression and observe it fail first | Fail: test file unchanged | Fail: test file unchanged |
| Rerun original CLI after editing | Fail: never ran CLI | Fail: never ran CLI |
| Run fixture's required executable checks | Partial: `node total.test.mjs`, 2 passed; no syntax checks | Fail: no execution after edit |
| Report only demonstrated verification | Fail: done with empty `unverified`, without checking changed behavior | Fail: ended with a plan object, not findings |
| Independent evaluator checks final result | CLI 9 → 23; existing tests 2 passed | CLI 9 → 23; existing tests 2 passed |

Observed tool order:

- Task: `bash ls -R .` → read implementation → read tests → edit implementation → `bash node total.test.mjs` → done.
- Subagent: `bash ls -R` → read implementation → read tests → read README → read CLI → edit implementation → plan text.

Both changed only this expression:

```diff
-return items.reduce((sum, item) => sum + item.price, 0);
+return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);
```

Passing the existing tests was insufficient: they also passed with the original
bug. Both behavioral cases fail the reproduction → fix → executable evidence
gate, despite the independently observed correct final sample output.

## Isolation and initial failures

- Each engine had a fresh HOME, configuration, session directory and working
  folder. No user credentials or account environment were copied.
- macOS sandbox profiles denied writes outside the role's temporary directory,
  reads of the user's home except the needed engine assets and Node executable,
  and network access except the recording proxy's loopback port. Preflight
  probes confirmed an allowed fixture write and denied out-of-fixture write
  and credential-file read.
- The private model server allowed only loopback networking and temporary-home
  writes; the existing model store was read-only. Cloud access and pruning were
  disabled. No download, paid inference or external authentication was performed.
  Ollama created its own local server key in the temporary HOME; it was not used
  to sign in to any service.
- The first run used the existing local server's 4096-token context and omitted
  Node's actual installation directory from PATH. The task repeatedly called
  nonexistent tools; the subagent's test failed with `node: command not found`.
  These confounded results were retained, not counted as clean behavioral tests.
- An intermediate private-server run was interrupted because keep-alive zero
  reloaded the model on every request. Its partial logs were retained. The final
  run kept the model loaded, used 32768 tokens, and corrected Node's PATH/access.
- The final run settled both sessions, closed its engine processes, recording
  proxy and private model server. The user's existing Ollama service was left
  running. Temporary fixtures and evidence were retained, not deleted.

## Limits and disposition

This checks the real engine CLI/RPC → provider boundary, not the live Tauri UI,
`agent_spawn` process owner, captain routing, or automatic subagent spawning.
The existing `src/engine/prompts.test.ts` tests cover application-side assembly
and startup with a mocked native boundary; they were not rerun here. The two
boundaries were not exercised together end to end in this session.

There is one clean sample per role, one local model, and no old-prompt control.
These results do not establish improvement over the previous prompt or predict
behavior of the user's configured external model. No paid external-model run or
new external authentication was attempted. Resume/handoff, independent review,
parallel ownership and the production completion gate were not behavior-tested.
The isolated fixtures had no type-check or lint configuration; omitted syntax
checks remain omissions, not type-check/lint passes.

No production prompt or routing changes were made on the strength of these two
samples. This session adds evaluation documentation only; it does not repeat
previously passing package tests, type checks or builds, and the package has no
lint script. A further deployment decision must not treat prompt delivery as
proof that agents follow the workflow.

## Evidence

Local artifact directory:
`/Users/lyu/Library/Application Support/dev.3xhaust.ondra/artifacts/tmw37bji6rkgq/`

- `run-local-eval.mjs`: executed evaluation driver (final configuration).
- `corrected-run/{task,subagent}-launch.json`: engine flags and isolated environment.
- `corrected-run/{task,subagent}-request-*.json`: actual provider request bodies.
- `corrected-run/{task,subagent}-events.jsonl`: ordered engine events and tool results.
- `corrected-run/{task,subagent}-result.json`: final files, tool traces and independent CLI/test outputs.
- `corrected-run/{task,subagent}-sandbox-check.json`: sandbox profiles and preflight results.
- `corrected-run/context-evidence.txt`: context size, non-truncation and loopback requests.
- `corrected-run/local-eval-summary.json`: combined final run.
- Root-level case files and `interrupted-run/`: initial and interrupted attempts.

The driver was run with `node "$APP_ARTIFACTS_DIR/run-local-eval.mjs"` from this
worktree; it is not installed in the application. Raw local evidence is not
included in the repository. The existing results workflow is documented in
`evals/run.mjs`; that runner was not used because it mutates the live app state.

Local provider configuration followed the engine's checked-out `docs/models.md`
and CLI help. Ollama's local OpenAI endpoint is documented at
https://docs.ollama.com/api/openai-compatibility .

## Follow-up: observable completion evidence

### Diagnosis and minimal change

The original prompt already explicitly required reproduction before editing,
a focused failing regression when cheap, and rerunning the original surface.
The recorded requests contained those instructions; neither role attempted the
required executions. This is observed instruction-following failure, not a
missing delivery path. It is not proof of an intrinsic model limitation.

The completion criteria could nevertheless be more observable: reading code
was not explicitly excluded as reproduction, passing pre-existing tests was
not explicitly distinguished from exercising the faulty path, and missing
checks lacked a concise failure-report contract shared by both roles.
`CODING_WORK` now makes those distinctions and asks for each success condition's
command/action and observed result, or the skipped/failed check, reason and
remaining verification. An unproven required condition must be reported as
incomplete. This is a prompt requirement, not a new runtime enforcement gate.

Only the shared coding text changed. Role routing, model configuration,
subagent ownership, reporting formats and native process code are unchanged.
No fixture names, expected values, solution expressions or evaluation-specific
workflow hints were added to production instructions.

### Same-fixture reevaluation

Ran `node "$APP_ARTIFACTS_DIR/rerun-local-eval.mjs"` once for each role.
The driver is a copy of the earlier driver with only its output and temporary
run-directory names changed. It reads the updated production prompt constants.
The four fixture files, user request, boundary instruction, tool selection,
model settings, 32768-token context and low thinking level are unchanged.
Each role again starts with a fresh HOME, configuration and session directory.
The model manifest digest matches the earlier run:
`a0b38d0b19f7c5dd3589e5e6598edfed41c81969d73f9e4774011c1328e9dad8`.

The comparison audit checked identical baseline files and normalized launch
environments/flags. All nine provider requests contain their full updated role
prompt and one coding section. Server logs show nine completed requests with
`truncated = 0`. Both runs settled normally with `stopReason: stop`, not a
provider error or deadline. All attempted tools succeeded. The sandbox write
and credential-read denial probes passed again. Only the private server and
proxy were used and stopped; no live app settings, user credentials, external
inference, original repository files or existing Ollama service were changed.

| Check | Task worker | Subagent |
| --- | --- | --- |
| Inspect implementation and nearby tests | Implementation only | Both |
| Execute reproduction before production edit | Fail | Fail |
| Add and run a failing regression | Fail | Fail |
| Rerun original CLI after edit | Fail | Fail |
| Run fixture checks after edit | Fail: no execution | Fail: no execution |
| Report evidence or explain missing checks | Fail: unsupported completion claim | Fail: ends with plan text |
| Independent evaluator only | CLI 9 → 23; existing tests 2 passed | CLI 9 → 23; existing tests 2 passed |

Observed tool order:

- Task: list files → read implementation → edit implementation → completion text.
- Subagent: list files → read implementation → read tests → edit implementation → plan text.

Both changed only the subtotal expression to multiply each price by its quantity;
neither hardcoded the requested result or modified tests. The evaluator's CLI
and test executions remain separate from model evidence and cannot make these
behavioral cases pass. No improvement in the reproduction/verification gate
was observed. The task worker also omitted the test execution seen in the
previous sample; this is not enough data to infer a regression rate.

### Package checks and limits

- Added two prompt-contract assertions in `src/engine/prompts.test.ts`. They
  failed against the old text before implementation, then passed in `pnpm test`:
  12 tests total, including the six fresh/resume/handoff delivery cases across
  both roles. These are instruction/delivery tests, not model behavior tests.
- `pnpm typecheck` passed. No lint script, linter dependency or tracked lint
  configuration exists; lint was unavailable, not passed. `git diff --check`
  passed; it is not a substitute for lint.
- The first post-run comparison audit assumed user content was a string; the
  captured API uses text-block arrays. Correcting only that audit's text
  extraction made it pass. Neither model run was repeated or altered.
- Prompt-only clarification did not enforce the workflow in these two samples.
  The evidence supports a limitation of this tested model/prompt/runtime
  combination, not a claim that every local or external model will fail, nor
  that another prompt could never work. No same-session randomized control or
  repeated sampling was performed; the previous clean run is the comparator.
- Stopped after this one revision and two role runs, rather than tune to the
  fixture or repeat until a lucky pass. Behavioral acceptance remains failed.
- Live Tauri UI → captain → process owner → provider end-to-end delivery,
  automatic subagent creation, independent review and completion enforcement
  remain unverified. The mocked-native application tests and isolated real
  engine/provider runs cover different boundaries, not one full app run.

Additional local evidence under the artifact directory above:

- `rerun-local-eval.mjs`: executed driver; previous driver and results retained.
- `completion-run/{task,subagent}-{baseline,launch,sandbox-check,result}.json`.
- `completion-run/{task,subagent}-events.jsonl` and `*-request-*.json`.
- `completion-run/local-server.log`, `local-models.json`, `local-eval-summary.json`.
- `completion-run/comparability.json`: fixture/configuration/model identity,
  full-prompt delivery, context and command audit; behavioral failures retained.

The bundled engine's documentation directory was absent in this session. The
corresponding source checkout at `3xhaustpi-engine-build/packages/coding-agent`
supplied the CLI, RPC, JSON event, configuration and model docs and the RPC and
custom-prompt examples; the installed engine's CLI help confirmed the flags.
No engine SDK, extension, skill or model-provider implementation was changed.
