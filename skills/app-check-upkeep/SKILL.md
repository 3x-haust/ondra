---
name: app-check-upkeep
description: >
  Upkeep of a project's check skill (check-<app>) and its feature map: every
  area read from source, every area driven in one live pass, drift fixed in
  the skill and map only, product bugs reported. Use for "앱 확인 스킬 점검",
  "기능 지도 업데이트", "audit the check skill", or a routine running it.
---

# App check upkeep

A feature map goes stale the moment the app changes. This is its upkeep: every
area gets read from the source and used live once, without proving every
sentence. It edits only the check skill's own folder (SKILL.md, `features/`,
its `scripts/`), never product code. Something the map describes that the app
no longer does is either drift (fix the map) or a product bug (report it;
don't paper over it in the map).

## Outcome: say which

- **clean**: every area was read and driven, nothing worth changing.
- **changed**: proven fixes to the skill, map or helpers, in one change.
- **blocked**: the pass couldn't finish, or a proven fix couldn't land safely.
  Say exactly what blocked it.

## The pass

0. **Find it, and what's known.** The project's check skill: a skill with
   launch and drive sections and a feature map, in `.agents/`, `.claude/` or
   `.cursor/skills/` (`check-*`, `verify-*`). Several → ask which. None → stop
   and say app-check makes one; don't invent a target. Then `memory_search`
   for this project's check skill: earlier outcomes, product bugs still open,
   areas that need a sign-in or a device.
1. **The index.** Read `features/README.md` and list the files beside it. Fix
   missing, extra, duplicate or dead entries. Light; no generated inventory.
2. **Read every area from the source, in parallel.** One read-only subagent
   per area file, all at once. Each answers "how does this work for its user?"
   from the code, cites what looks drifted (file and line), and returns one
   short recipe for checking it live. They never drive the app and never edit.
   Return shape: what the area does / where it starts in the code / drift or
   none / one recipe.
3. **Reconcile.** Every area has a summary. Merge recipes into as few app
   states as you can. Spot-check the drift they cite; don't re-prove clean
   claims. Look through recent commits for screens, commands or routes the map
   lacks; call one missing only with the source path that adds it.
4. **One live pass, even when the source looks clean.** You drive; follow the
   skill's own launch model (one long-lived copy driven in turn for a server or
   UI, a fresh session per drive for a short-lived CLI). Use every area at
   least once, and keep three rules the whole time:
   - Never drive a copy you haven't health-checked since it last surprised
     you: doctor before the first drive, after any failed drive, and on each
     new session. When doctor can't see the trouble (a stuck screen on a
     healthy process), reset or relaunch rather than hope.
   - Proof kept so far survives every cleanup: check it at its place.
   - Nothing a drive started outlives its use: clean up after failed attempts
     too, and on a shared copy clean what you left, not the copy.

   A doctor failure caused by the skill itself is drift: fix it and retry
   once, restarting only what the fix touched, before calling the pass
   blocked. An area you can't reach is "unreachable" only with the concrete
   reason (a sign-in, a plan, an OS, outside state) and the way you tried; if
   the map doesn't mention that reason, that is drift too. A helper you fixed
   gets driven live again before it lands. Tear down after the last drive.
5. **Sort what you found.**
   - The map describes it wrong or not at all → drift: fix the map.
   - The app works but the harness can't drive it → harness gap: fix the
     helper (executable, its call shown in the skill).
   - The app is broken → product bug: write it down for the user, keep it out
     of this change.
6. **Land it or stop.** Changed: one change with the proven fixes, every
   changed file reread first. Clean or blocked: no change. Either way, report
   the outcome and what was covered, honestly.

## Remember it

Save what the next pass needs (`memory_save`, project scope, the user's
language, `cites`: the check skill's SKILL.md), one fact per call:

- `key: check-upkeep` (saving the same key updates it): the date, the outcome
  and the areas covered, unreachable ones with their reason.
- Each product bug found, as its own memory, so a later job that touches that
  area sees it; `replaces` the old one when a later pass finds it fixed.

The map stays the record of what the app does; memory holds only what the map
shouldn't (when it was last checked, what is broken right now). Keep run notes
in `$APP_ARTIFACTS_DIR`; don't commit them.

Adapted from pstack's maintain-verification-skill (MIT, Lauren Tan); see
the app-check skill's NOTICE.md.
