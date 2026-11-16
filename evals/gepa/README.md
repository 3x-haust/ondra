# GEPA on main's prompt

Dev-only. Evolves main's system prompt (`CAPTAIN_SYSTEM`, src/engine/prompts.ts) with
[GEPA](https://arxiv.org/abs/2507.19457) ([gepa-ai/gepa](https://github.com/gepa-ai/gepa) 0.1.4),
scored by the main simulation (`evals/main/*.json`, the checks in `evals/main-sim-check.mjs` and
`evals/main-sim-lint.mjs`). Nothing in the app changes unless a person copies a result back.

How it works
- The prompt is cut into parts: its `# ` sections, and the long Role section before each route
  bullet (`- "answer"`, `- "ask"`, …), 10 parts in all. Each part is a GEPA component.
- A metric call = one case run with one candidate prompt: main decides with the real model in a
  made-up situation (`simulateMain`, nothing starts); score = share of steps with no failed check.
- Reflection: for the failed cases of a minibatch, what main did and which checks failed, in
  words; the model proposes small JSON edits to one part (`old` → `new`), applied when `old`
  occurs once. Candidates sit on a Pareto front over the validation cases; merge combines parts
  improved in different lines.
- The app is reached only through `bridge.mjs` → `evals/devbridge.mjs` (the dev bridge
  main-sim already uses). The app's own hooks: `__ui.captain.mainSystem()`,
  `simulateMain({…, system})`, `evalOneShot(prompt)` (the space's account, no tools).

Run
```sh
# free: fake scores and edits, no app, no model (proves the loop)
evals/gepa/run.sh --mock --name dry

# real: `pnpm tauri dev` from this branch running. On its own empty data, beside any other dev app:
#   ONDRA_DATA_DIR=~/Work/cache/ondra-gepa-data ONDRA_DEVBRIDGE_PORT=17322 pnpm tauri dev \
#     --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"pnpm bundle && pnpm dev --port 1430"}}'
#   (and the same two variables for run.sh)
evals/gepa/run.sh --name main-1 --eval-only --cases greeting bug-one-job explicit-folder  # 3 calls
evals/gepa/run.sh --name main-1 --max-calls 150 --max-usd 10                             # a first real run
```
Flags: `--max-calls` (GEPA's budget; it can overshoot by one validation pass), `--max-usd` (stops on
the estimated spend; `--price-in/--price-out` USD per million tokens, default 3/15),
`--cases`/`--limit`, `--val-share` (0.35), `--minibatch` (3), `--parallel` (3), `--no-merge`,
`--seed-from-file`, `--focus <cases>` (train on the ones main gets wrong, validate them too),
`--prompt-file` (with `--eval-only`: score a run's `best.md`), `--repeats N` (run each case N times and score the mean; the model isn't
deterministic, so one run per case mostly measures luck. Costs N× per metric call). The same `--name` resumes (state in `/Users/lyu/Work/cache/gepa-runs/<name>/`).

Output in the run dir: `best.md` (whole prompt), `best.diff` (vs the seed), `summary.json`
(validation score seed → best, parts changed, per-case seed/best), `calls.jsonl` (each call with its
estimated cost), `gepa/` (GEPA's state, `candidate_tree.html`).

A result is a suggestion: read `best.diff`, keep the edits that are general (not about a case),
put them in `src/engine/prompts.ts` and run `node evals/main-sim.mjs` on all cases.

The first run (main-1, one run per case) went 31/32 → 32/32: the cases were too easy to tell
prompts apart. `evals/main/from-real-hard.json` adds moments the user had to correct main in real
use; run with `--repeats 3`.
