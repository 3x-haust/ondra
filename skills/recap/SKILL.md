---
name: recap
description: >
  Catching the user up on what happened while they were away, in plain words
  and small pictures, with every decision waiting on them first (따라잡기,
  브리핑, 그동안 뭐 됐어, 뭐 했어, 어떻게 됐어, 자고 왔어, 일어났어, 다녀왔어,
  밀린 거, 지금까지 정리, catch me up, recap, what happened). Reads the jobs,
  their PRs and decision logs; changes nothing.
---

# Recap

The user remembers their last message and nothing after it. Bring them to
now, so their next decision rests on what is true, and lay out each call
waiting on them so they can make it from your reply alone.

## Gather (read only)

- **From when:** the user's last message in this chat, or the time they
  name ("어젯밤부터", "이번 주"). What came before is known: leave it out,
  except a decision still waiting on them, however old.
- **Every job that moved since then:** `jobs_search` (no query lists the live
  ones first, then the latest), then `job_read` for each one: seen working,
  done but unverified (and why), failed, still running, waiting.
- **Live state, not what a job said:** a PR's state, checks and reviews
  (`gh pr view`), whether a branch merged. Check every number you'll show
  against where it came from, and say so when you correct one.
- **Decisions made without the user:** a large job's decision log
  (`.ondra/goal/log.md` in its worktree).
- Start, tell, stop and merge nothing. A recap only reads.

## What waits on the user

A call only the user can make: a choice of product or taste, an approval
(merge, release, deploy), a step that can't be undone, a login or access no
job has, an open question. Work a job can still do by itself is not one.
Never make one up to fill the reply.

For each: what it changes for the user, the evidence, the risk and your pick,
with the job or PR it is about. "모름" for a fact the call needs and nobody
knows.

## Write it

1. One sentence: what waits on the user, or that nothing does. Nothing
   happened and nothing waits: say so and stop.
2. The calls. A choice between options is an `ask` (your pick first); the
   rest one line each, about 30 words. Never drop or shorten one to keep the
   reply short.
3. What happened, pictures first: the shots and recordings the jobs made, a
   picture of a change when it explains it (visual-report). Then one line per
   thing the user asked for, what came of it and whether it is seen working,
   done but not checked, running, or failed (a `checklist` or `timeline`
   holds it well). Under 100 words besides the pictures.
4. A word a job coined that the user hasn't used (a branch nickname, a
   phase name): say what it is instead, or one line explaining it.

Say it as you would out loud: "검색이 느렸던 건 인덱스가 없어서였어요", not
"검색: 완료". Call each job, PR and thing what the user calls it; hashes,
paths, commands and test counts only when the user needs one to act. A screen
or less unless the calls need more. End by offering to open any of it in depth.
