---
name: ondra-eval
description: >
  Run Ondra's evals and improve the harness until they pass. Use when the user
  says "eval", "평가 돌려", "하네스 개선 루프", or runs /ondra-eval (alone or under
  /loop). Runs evals/run.mjs against the dev app, finds why cases fail or are
  slow, fixes Ondra (skills, prompts, tools), and reruns.
---

# Ondra eval loop

Goal: Ondra does the job well **on its own**. Fix the harness, never the case.

## One iteration

1. **Run.** Dev app must be up (`pnpm tauri dev`). Then:
   `node evals/run.mjs` (all) or `node evals/run.mjs <case> …` (just the ones
   you're working on). Read `evals/results/<latest>/report.md`.
2. **Compare.** Read `evals/results/history.jsonl` to see whether the last fix
   helped (secs, tools, failed tools per case). A fix that made things worse
   gets reverted.
3. **Pick one problem.** The worst first: runner/app errors > not done > wrong
   answer > took focus / left a device running > failed tools > slow / too many
   tools.
4. **Find the cause** in the report's failed tool outputs, then in the job's
   session (`~/Library/Application Support/dev.3xhaust.ondra/sessions/<task id>/*.jsonl`).
   Ask: what would have made the job get it right the first time?
5. **Fix the harness**, smallest change that removes the cause:
   - how to do the work → `skills/<name>/SKILL.md` (copy to
     `src-tauri/target/debug/app-skills/<name>/` so the dev app uses it now)
   - how main splits work / how jobs behave → `src/engine/prompts.ts`
   - the device tool → `extensions/device.ts` (copy to `src-tauri/target/debug/app-extensions/`)
   - app behaviour (scheduling, UI) → `src/` / `src-tauri/src/`
   - a bug in a bundled tool → patch it at its source, keep the patch in `scripts/patches/`
6. **Rerun only the affected cases**, then the whole set once before stopping.
7. **Log it**: one line in `evals/LEARNINGS.md`: date · case · cause · fix · before→after.

Stop when all pass and nothing improved in the last iteration, or after 5
iterations. Then report to the user in short Korean: a table of before/after per
case and the fixes made.

## Rules

- Never solve a case by hand, answer a job's question with instructions, or
  loosen a case's checks to make it pass. If a check is wrong, say so and ask.
- One cause per iteration, so history shows what helped.
- Don't commit unless the user asks.
- Screen: never capture anything but the Ondra window; never use System Events
  keystrokes. Phones: never touch devices matching `ONDRA_PROTECTED_DEVICES`.
- New cases go in `evals/cases/<name>.json`:
  `{ "ask": "...", "kind": "computer|device|browser|taste|other", "answer": "first"?, "expect": { "textAny": [], "artifacts": ["png"], "maxSecs": 120, "maxTools": 20, "asks": false } }`.
  Add one whenever the user reports something Ondra got wrong.
