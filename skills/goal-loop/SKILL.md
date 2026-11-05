---
name: goal-loop
description: >
  The user gave a goal and wants it finished completely ("루프", "될 때까지",
  "100%", "eval", "반복해서", "완벽하게"). Turn the goal into checks that fail
  until the user's intent is fully met, then loop fix → re-check until every
  check passes. Never stop at "looks done".
---

# Goal loop

"Done" means every check passes, not that it looks done to you. The checks
are the user's intent written down so a machine can verify it.

## 1. Write down the intent (first, before any change)

Make `.ondra/goal/spec.md` in your folder:

- **Goal**: one sentence in the user's words.
- **Asked for**: every requirement, each with the user's words quoted
  (the task, the earlier messages, memories you were given).
- **Must not break**: the user's rules and preferences from memory, what
  works today, files and things that aren't part of this goal.
- **Not asked for**: what you will leave alone. Doing more than asked fails too.
- **Assumptions**: what you had to decide. If an assumption changes what the
  checks are, `ask` before going on (an `ask` block with 2–4 options).

Show it: a `scope` block (in / out) and a `checklist` of the requirements.

## 2. Make the checks

One check per requirement, runnable and objective, in `.ondra/goal/checks`
(a script or a test file; use the project's own test tools when there are any):

| requirement is about | check it by |
|---|---|
| doing something | running it for real (tests, the CLI, the API, the app) and asserting on the output |
| how it looks | a headless screenshot plus measured facts (sizes, gaps, colours, nothing cut off) at desktop and phone width |
| how it behaves | a scripted click / key / resize, then asserting on what changed |
| not breaking things | the project's typecheck, lint and existing tests, plus one check per rule above |
| nothing leaked | a search of what the reader sees (copy, titles, alt text, comments) for phrases from the task, the spec and the rules: none may appear |
| taste | a rubric written from the user's words, scored against shots of the result, one line of evidence per point |

- Run them once before changing anything. A check that already passes for a
  requirement that isn't met yet is a wrong check: fix it.
- Never loosen, skip or delete a check to get it to pass. If a check is
  wrong, fix the check, say why, and rerun all of them.
- A check that passes and fails at random is a bug: make it stable.

## 3. Loop

Each round:
1. Run all checks. Show a `progress` block (passing / total) and a
   `checklist` of the checks with `done` = passing.
2. Pick **one** failing check, most important first: broken behaviour >
   missing requirement > something it broke > look > speed. Say it in a `now`.
3. Find why it fails (the actual output, logs), not just what fails.
4. Make the smallest change that fixes that cause.
5. Rerun **all** checks. If another one broke, undo the change and try again.
6. Add one line to `.ondra/goal/log.md`: round · check · cause · fix · before → after.

Same check failing three rounds in a row: stop and rethink (re-read the spec,
doubt the assumption, look one layer deeper) before the next try. Truly
blocked (needs the user's login, a decision, a device you may not touch):
`ask` with what you tried, and end the turn.

## 4. Finish

- Every check passes on two runs in a row.
- Then review it the way the user would: go through **Asked for** line by
  line against the evidence (shots, outputs), not against what you remember
  doing. Anything that goes against their words is a failing check: back to 3.
- End with `done`: the checks as evidence (`kind: "test"`, `ok: true`), a
  `compare` of passing checks before → after, shots of what the user will
  look at, and anything left as an assumption in `unverified`.
