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
- **changed**: proven fixes to the skill, map or helpers, in one commit.
- **blocked**: the pass couldn't finish, or a proven fix couldn't land safely.
  Say exactly what blocked it.

## The pass

0. **Find it, and what's known.** The project's check skill: a skill with
   launch and drive sections and a feature map, in `.agents/skills/`,
   `.claude/skills/` or `.cursor/skills/` (`check-*`, `verify-*`,
   `control-*`). Several → ask which. None → stop and say app-check makes
   one; don't invent a target. Then `memory_search` for this project's check
   skill (no memory tool → the last upkeep notes in `$APP_ARTIFACTS_DIR`):
   earlier outcomes, product bugs still open, areas that need a sign-in or a
   device.
1. **The index.** Read `features/README.md` and list the files beside it. Fix
   missing, extra, duplicate or dead entries. Light; no generated inventory.
2. **Read every area from the source, in parallel.** One read-only subagent
   per area file, all at once (no subagents → read them yourself, one by
   one). Give each its area file, the skill's Drive section and the repo; it
   answers "how does this work for its user now?" from the code, cites drift
   between the file and the code (file and line), including recipe steps that
   contradict each other, names anything new in its area, and returns one
   short recipe for checking it live. They never drive the app and never edit.
   Return shape: what the area does / where it starts in the code / drift or
   none / new in this area / one recipe. Drift in shared files (SKILL.md, the
   helpers, the index) is yours to check; subagents name it in one line.
3. **Reconcile.** Every area has a summary. Spot-check the drift they cite;
   don't re-prove clean claims. Look through the commits since the check
   skill's folder last changed
   (`git log $(git log -1 --format=%h -- <skill folder>)..HEAD`) for screens,
   commands or routes the map lacks; call one missing only with the source
   path that adds it, and add it as an area file in the four-part format with
   an index line. Plan the live pass as the index's sweep order on one copy;
   recipes read ids from output, never assume an empty store.
4. **One live pass, even when the source looks clean.** You drive; follow the
   skill's own launch model (one long-lived copy driven in turn for a server or
   UI, a fresh session per drive for a CLI). Use every area at least once,
   areas added in step 3 included, relaunching when a rule below asks for it,
   and keep three rules the whole time:
   - Never drive a copy you haven't health-checked since it last surprised
     you: doctor before the first drive, after any failed drive, and on each
     new session. When doctor can't see the trouble (a stuck screen on a
     healthy process), reset or relaunch rather than hope.
   - Proof kept so far survives every cleanup: check it at its place.
   - Nothing a drive started outlives its use: clean up after failed attempts
     too, and on a shared copy clean what you left, not the copy.

   A doctor failure or a drive that fails because the skill, map or a helper
   is wrong is drift: fix it, note it, and carry on with the fix (retry once,
   restarting only what the fix touched, before calling the pass blocked). An
   area you can't reach is "unreachable" only with the concrete reason (a
   sign-in, a plan, an OS, outside state) and the way you tried; if the map
   doesn't mention that reason, that is drift too. Any recipe or helper you
   changed is driven once more before it lands. Tear down after the last
   drive.
5. **Sort what you found.**
   - The map describes it wrong or not at all → drift: fix the map. A change
     that looks intended (its commit message, tests or docs say so) is drift;
     one nothing explains is reported as a possible product bug.
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
shouldn't (when it was last checked, what is broken right now). No memory
tool → put the same lines in the report. Keep run notes in
`$APP_ARTIFACTS_DIR/check/upkeep-<date>.md`; don't commit them.

Adapted from pstack's maintain-verification-skill (MIT, Lauren Tan); see
the app-check skill's NOTICE.md.
