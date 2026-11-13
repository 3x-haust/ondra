# What the evals taught us

date · case · cause · fix · before → after

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
