---
name: overnight
description: >
  The user is leaving and the work goes on without them (자러 갈게, 자러 간다,
  잘게, 자고 올게, 퇴근할게, 자리 비울게, 나갔다 올게, 아침까지, 밤새, 내가 없는
  동안, 일어나서 볼게, going to bed, AFK, overnight). Settle before they go
  what only they can answer, then run unattended: decide the rest and log each
  decision, prepare but don't take steps they didn't allow, stop at a real
  dead end with why, and leave the morning a short list of what waits on them.
  goal-loop only when the work really is fix-until-it-passes.
---

# Overnight

The user sees nothing until they're back. An `ask` sent at 1 a.m. is a night
lost, and a night spent reinterpreting the goal is worse. What the run is
worth is what the user can trust when they return: work that was checked,
decisions they can audit, and a short list of what waits on them.

## Before they go (main)

- Settle now only what the work can't start or finish without and only the
  user can answer: which of two readings they mean, a login, whether it may
  merge or deploy. One `ask`, your recommendation first, and only when the
  request and memory don't already say. Otherwise don't hold them: route the
  work and say in a line what will be waiting when they're back.
- Each fork's `task` carries the user's words as they said them (that they
  are away included), the finish condition in their words, and what they
  allowed ("머지까지", "CI 깨져도 올려"), nothing more. The fork is
  `"size": "large"`.
- Separate pieces are separate forks running at the same time; one that needs
  another's result waits with `"after"`.

## Running unattended (the fork)

- **Don't wait on the user.** A choice a reasonable owner would accept and
  that can be undone (a name, a layout, which of two fixes): decide, write it
  in the decision log with the option you didn't take, and go on.
- **Prepare, don't take,** what can't be undone or leaves this machine when
  the user didn't allow it (merge, release, deploy, deleting data, sending a
  message, paying): do everything up to it and stop there; it goes on the
  morning list. A confirmation card the app shows waits for the user too: do
  the work that doesn't need it first.
- **Decision log.** Keep the one a large job keeps (`.ondra/goal/log.md`:
  time · decision or hypothesis · change · before → after · kept or
  reverted). It is what the user reads to trust the night.
- **goal-loop only when it fits:** the work is "make this fully work" and it
  can be written as checks that fail now and pass when it's done (a bug, a
  feature, tests to green). Research, a write-up, concepts to pick from or a
  one-shot change is no loop: do it, check it once, finish.
- **The finish condition never loosens** overnight. A check that can't pass
  without the user is reported failing, not redefined.
- **A dead end is a stop, not a reinterpretation.** When the same thing fails
  after a few different attempts, change the approach (a layer deeper, undo
  and build it another way). When the ways you can see are used up, stop:
  what you tried, what each showed, and what you'd try with the user's help,
  ending with `ask`.
- A run that outlives its session hands off with the whole finish condition
  as `doneWhen`, and `next` says the user is still away.

## For the morning

End with `done`, or `ask` for what waits on the user. Put first what the
user must do (approve, pick, sign in), then what was seen working, what is
done but unverified and why, and what failed. When they're back ("일어났어",
"뭐 했어?"), main brings them up to date across every fork with the recap
skill.
