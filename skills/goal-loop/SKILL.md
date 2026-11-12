---
name: goal-loop
description: >
  The user gave a goal and wants it finished completely ("루프", "될 때까지",
  "100%", "eval", "반복해서", "완벽하게"). Turn the goal into checks that fail
  until the user's intent is fully met, then loop fix → re-check until every
  check passes. Done means the checks pass, not that it looks done.
---

# Goal loop

"Done" means every check passes, not that it looks done to you. The checks
are the user's intent written down so a machine can verify it. That is the
whole skill; how you get there is up to you.

## 1. Write down the intent

Before changing anything, write the intent where you and a later reviewer can
find it (`.ondra/goal/spec.md` works well):

- **Goal** in the user's words, and **what was asked**: each requirement with
  the user's words quoted (the task, earlier messages, memories you were given).
- **Must not break**: the user's rules and preferences, what works today.
- **Not asked for**: stay inside the request. Extra requirements, safety
  layers or edge cases the user didn't name pull the checks away from their
  intent; a real risk you notice goes in the report as one line instead.
- **Assumptions** you had to make. If one changes what the checks are, `ask`
  before going on.

Showing it as a `scope` block and a `checklist` helps the user correct you early.

## 2. Make the checks

Every requirement gets a runnable, objective check (a script or test; the
project's own test tools when there are any). Checks that use the feature the
way the user will (the flow, the command, the screen) catch more than checks
of internals:

| requirement is about | a good check |
|---|---|
| doing something | running it for real (tests, the CLI, the API, the app) and asserting on the output |
| how it looks | a screenshot plus measured facts (sizes, gaps, colours, nothing cut off) at the widths the user cares about |
| how it behaves | a scripted click / key / resize, then asserting on what changed |
| not breaking things | the project's typecheck, lint and existing tests, plus the rules above |
| nothing leaked | a search of what the reader sees for phrases from the task, the spec and the rules |
| taste | a rubric written from the user's words, scored against shots of the result, with evidence per point |

These keep the checks honest:

- At least one check judges the result from outside your own work: the real
  app or command driven the way the user will, real data, or the user's own
  words held against what shows. A check that only agrees with you proves
  nothing (an expected value computed from your own code, a mock of the thing
  under test, a score you gave yourself).
- Run them once before changing anything. A check that already passes for a
  requirement that isn't met yet is a wrong check: fix it.
- **Never loosen, skip or delete a check to make it pass.** If a check is
  wrong, fix the check, say why, and rerun all of them.
- A check that passes and fails at random is a bug: make it stable.

## 3. Loop

Fix, re-check, repeat. What tends to work:

- Most important failures first: broken behaviour > missing requirement >
  something it broke > look > speed.
- Find why a check fails (the actual output, logs), not just that it fails.
- Small changes, one cause at a time, then rerun the checks that cover what
  you changed, so you know which change fixed or broke what. If something
  that passed now fails, undo and try again.
- A short log (`.ondra/goal/log.md`: check · cause · fix · before → after)
  helps you and the next worker not repeat a dead end.
- A `progress` block (passing / total) keeps the user oriented on long loops.

If the same check keeps failing, stop patching: re-read the spec, doubt the
assumption, look a layer deeper. If the approach itself is wrong, undo that
part (keep the spec, checks and log) and build it another way. Truly blocked
(the user's login, a decision, a device you may not touch): `ask` with what
you tried, and end the turn.

## 4. Finish

- Run every check once more; all pass.
- Look for success that isn't real on the path the checks went through: a
  stub or hard-coded result, a caught error that ends as "ok", a fallback the
  user can't tell from the real thing, a placeholder left in. Each one is a
  failing check. A degraded state the user can see is fine.
- For a result the user will use or look at, a fresh pair of eyes catches
  what your own checks share your blind spots on. Start
  {"type":"subagent","title":"결과 확인","task":"…"} with only the **asked
  for** lines in the user's words and how to reach the result (URL, command,
  files, screens) — no plan, log or verdict of yours — and have it report per
  line what matches and what doesn't, with evidence. Every mismatch is a
  failing check. Skip it when the checks already exercise the result the way
  the user would and there is nothing to look at.
- End with `done`: the checks as evidence (`kind: "test"`, `ok: true`),
  passing checks before → after, shots of what the user will look at, and
  anything left as an assumption in `unverified`.
