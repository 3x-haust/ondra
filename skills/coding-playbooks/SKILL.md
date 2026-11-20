---
name: coding-playbooks
description: >
  Step-by-step playbooks for coding work in a repo that already runs: a bug fix,
  a feature, a refactoring, performance work, and the pull request at the end
  (버그 수정, 기능 추가, 리팩토링, 성능 개선, PR). Read when the task names one of
  them; skip it for a small change (a wording, a colour, one setting) and for a
  new app built from nothing.
---

# Coding playbooks

For growing and fixing an app that already works, not for starting one. Each
playbook's numbered steps are your plan's steps, in your own short words. A
step that doesn't apply stays in the plan with its reason
(`{"text":"…","skip":"파일 두 개라 이미 다 읽었어요"}`); never drop one silently.
Ondra sends a job back that ends with a step left open or skipped without one.

Say what a claim stands on as you go: (확인함) you ran it or saw it here,
(추론) you read the code, (추측) neither. A hypothesis is (추측) until a run
settles it.

## Bug fix

Every line you ship traces to something the code did when it ran. A guard,
retry or fallback that "might help" is a hypothesis, not a fix: it doesn't ship.

1. **Reproduce it yourself** on the surface where it happens (the app through
   its check skill, the CLI, the API), before changing any code. Note the
   trigger, what you did, expected and actual. If it won't reproduce, tighten
   the conditions or add logging until it does; ask the user only for what
   the tools can't reach, after going as far as they do.
2. **List the candidate causes**, then rule them out one by one with runtime
   evidence: a log line, a probe, a narrowed repro. Take first the check that
   cuts the most possibilities. When state is unclear, print it and read it as
   the code runs. Don't fix from a guess.
3. **Confirm the mechanism** (확인함) before writing the fix: the first place
   the code made a wrong decision, not where the symptom showed. If the state
   that triggered it should never exist, find what produced it; a check where
   it surfaced hides the bug.
4. **Fix it there, smallest change.** Look for the same fault elsewhere and fix
   those too. Revert whatever you changed for a cause that turned out wrong.
5. **Rerun the same reproduction** on the same surface: it passes now. Give it
   in done as `{"kind":"repro","ref":"<the command>"}`. Unit tests show branch
   behaviour, not that the bug is gone; "inconclusive" is not a pass.
6. **Keep it from coming back** when a test is cheap: a test that fails on the
   old code for this reason, committed before the fix so the history reads
   "this failed, this fixed it". Skip it, with the reason, when it would need
   heavy mocks or a harness.

Report: **원인** with its footing, **고친 것**, **확인** with the before and
after of the reproduction.

## Feature

1. **See how others already did it**, for a new feature its user will see or
   use (a screen, a flow, a setting the app doesn't have yet). Pick two or
   three products that solved the same problem for their users, rivals or not
   (a ranking: an investing app, a language-learning app, a fitness app), and
   read how on public pages: help articles, release notes, product blogs,
   store screenshots, with web_search and web_fetch, no sign-ins. A few
   minutes and about five pages, no report or PDF; this is not deep-research.
   Then write three lines in your message, each a point to take or to avoid
   with its link; they shape the plan, come back in the report, and their
   pages go in done as `link` evidence. Skip it, with the reason, for work no
   user sees (an API, CI, a lint), more of what a screen already does, or a
   design or references the user already gave.
2. **Read how the area works now**: the code it touches, its callers, how the
   neighbours solve the same kind of problem. Where others' way and this
   app's way differ, this app's way wins unless the user asked otherwise.
3. **Name the data shape first.** State as one value with named cases (a
   status, a union, a small state machine), not booleans that must agree
   (`done` + `overdue` can say "done but overdue"). Derive what can be
   computed (overdue from the date) instead of storing it. A table or registry
   instead of an if/else chain that grows a branch per feature.
4. **Plan check** when there are several parts or open design choices: the
   `plan_review` subagent from your instructions, before building.
5. **Build it** in small pieces, each ending in a check (type check, the test
   beside it) before the next.
6. **Use it** on the surface the user will (the check skill), with proof.
7. **Commit in small, ordered commits**, then the PR below if the task wants one.

Report: what you built, the choice you made and why (with the outside points
that led to it), what you left out.

## Refactoring

The structure changes; the behaviour does not. A missing feature or a bug you
find is split out, not mixed in.

1. **Pin the behaviour first**: a characterization test, a snapshot, or a
   script that records today's output, before anything moves. A type check is
   not a pin.
2. **Name the shape the code is missing** (as in Feature step 3). Plain code
   whose shape is already clear and local stays; a reshape must delete branches
   or impossible states, not add layers.
3. **Remove before you add**: dead code, wrappers with one caller, adapters
   with one implementation, checks nothing needs, stale references. This
   commit comes first.
4. **Move in small steps**, the pin green after each. A replaced API: move
   every caller and delete the old one in the same change; no compatibility
   shim, no old and new path side by side. Check each rename against the real
   files, strings and docs included.
5. **Prove nothing changed** on the real thing: the pin, plus a run of the
   affected flow.
6. **Keep it only if it reads easier**: fewer layers to trace, less state to
   hold in your head. If it doesn't, revert it.

Report: what changed shape, the pin it held against, what you deleted, what
you reverted.

## Performance

1. **Measure a baseline** on a workload that shows the complaint: the number,
   how many runs, the spread, and what limits it (a profile, not a guess from
   reading code). If the spread is larger than the effect, the number decides
   nothing yet.
2. **Try the cheap fixes first, in this order**, and stop at the first that
   meets the target: don't do it at all → don't do it again (cache) → do less
   → do it later → do it where the user doesn't wait → do it in parallel → do
   it faster.
3. **One change, one measurement**: keep it if it moved past the noise and
   nothing broke, otherwise revert it in full.
4. **Measure the same workload after**, same way, and rule out that the
   number moved for another reason (errors, skipped work, a warm cache).

Report: baseline → after, the difference, runs and spread, what limits it now.

## Deciding by running it

A design or behaviour question you can settle by running something is not a
question for the user: build the smallest throwaway (a scratch folder, plain
HTML or a script, no tests), put the options side by side, look at each
(screenshots, timings, output), and recommend one. Say it is throwaway; the
real build follows the playbook above. A question of taste (a look, a tone)
still goes to the user, with the options to try.

## Before the commit

Read your own diff once as a reviewer would: remove debug output, code left
commented out, notes promising to come back (TODO, 임시, for now), guards for
cases that can't happen, and edits the task didn't need. Follow the repo's
comment style; a comment never explains a shortcut: fix the shortcut, or say
it in the report. Ondra checks the diff for the first three before done.

## The pull request

Title in the repo's style (`type(scope): subject` when it uses that). Body in
the repo's language, under 40 lines, these sections in order, empty ones
dropped (a repo template wins):

| Korean | English | What goes in it |
|---|---|---|
| 배경 | Background | the problem and why now, in two or three lines |
| 바꾼 것 | Changes | what is different, for a reader who hasn't seen the code |
| 범위 | Scope | what is in, and what is deliberately out |
| 버린 방법 | Alternatives | only the alternatives a reviewer would ask about, and why not |
| 영향 | Impact | what else this could break, and the fact that says it won't |
| 확인 | Checks | what was run or seen, with screenshots or a recording |

Long logs, tables and run histories go in a comment or a file, linked from the
body. Open it ready for review, not as a draft.
