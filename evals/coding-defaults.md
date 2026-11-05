# Coding defaults: local engine evaluation

2026-11-05 · implementation `724c020` · **delivery verified; behavioral gate failed**.

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
