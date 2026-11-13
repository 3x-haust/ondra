# What the evals taught us

date · case · cause · fix · before → after (passes/runs, from `node evals/compare.mjs`)

- 2026-11-05 · coding defaults · real engine delivered both full worker prompts, but local-model workers skipped pre-edit reproduction and post-edit CLI verification · no speculative production change; [behavioral evidence and limits](coding-defaults.md) · independent CLI output 9 → 23 in both fixtures, workflow gate still failed

- 2026-11-05 · cu-* · jobs read help pages and turned on the screen cursor overlay · fast path + no-focus rules in skills/computer-use · ~5 min → 70 s
- 2026-11-05 · dev-android · job lost its emulator after an app restart; emulator window took focus; job left it running · device.ts remembers its device, -no-window, stop before final answer · blocked → done
- 2026-11-05 · web-example, ask-taste · shared browser "바로 닫혔어요": `pkill -f --user-data-dir=…` read the pattern as an option and killed nothing, so a leftover Chrome kept the profile locked · `pkill -f -- <pattern>` in browser.rs · 5 failed browser tools → rerun pending

## 2026-11-06 · main simulation, wide

- 61 scenarios (one-off, busy worlds of 5–8 jobs in each space, from real messages) and a replay of 38 real messages.
- Found and fixed: a job list that showed main only "id · status · title · now" (now also what a finished job did, what a waiting one asks, why a failed one stopped); offers of more work tacked onto replies ("원하시면 말씀해 주세요", now taken out by the app); a question turned into a fork after one failed search (now retried or read directly); a PR base branch named against memory ("PR to main" while memory says dev).
- Cases that failed because the case was wrong, not main: slides with no topic (asking is right), a blog with no topic, a demo that waits on two jobs (a new job after them is right).

## A finished job is closed (2026-11-06)

More work on a done or failed job used to be appended to it, so it ran on top of
the old job's whole context. Now it is a new job with `"from"`: a fresh context
on the old job's branch, handed its result. Cases that expected an append to a
finished job expect `"follows": "<id>"` instead; an append to a finished job is
still turned into a follow-up in code, but the check fails so the prompt stays
honest. 42/42 after the change.

## 2026-11-13 · GEPA on main's prompt (evals/gepa)

- One run per case mostly measured luck (31/32 → 32/32 on a single sample). Now `--repeats 3`, and
  `--focus` trains on the cases main gets wrong while still validating on the rest.
- 10 moments the user had to correct main in real use (`from-real-hard.json`): 9 already pass 3/3.
- Two independent runs proposed the same rule: a project's report answers the request it was
  handed, even after newer messages; say what finished and what's pending. All 104 cases × 3:
  97.4% → 99.4% (two-handdowns 0/3 → 3/3, repo-no-project 2/3 → 3/3; review-fix and known-name
  each lost one of three runs).
- demo-after: appending the demo to the queued check job (t-qa) that follows t-cu is right too.
- Runs on its own empty data: `ONDRA_DATA_DIR=… ONDRA_DEVBRIDGE_PORT=17322` and vite on 1430
  (see evals/gepa/README.md); a simulation adds a space the app lacks and borrows any account.

## Counting runs (2026-11-13)

Read back the saved runs with `compare.mjs`. Of the nine `run.mjs` runs on 2026-11-05,
four were the app not answering ("runner" on every case); they were logged as 0/6 like
real failures. Harness errors are now counted apart and left out of pass rates. Every
saved run from 11-05 and 11-06 had one run per case, so no before → after from those days
shows its noise: the cu-calculator 0/1 → 1/1 between two runs that day is "no measurable difference" (p = 1).
Runs now keep the commit, a note and a hash of each case; a case edited between two runs
is not compared. The project and folder a job case runs in were named "평가 …" and
".../evals-workspace", and simulated jobs were "sim-t1": all told main and the jobs it was
a test, now "새 폴더 …", ".../workspace" and "job-1".
