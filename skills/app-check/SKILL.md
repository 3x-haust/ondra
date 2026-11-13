---
name: app-check
description: >
  Write a project's own check skill (check-<name>): start, doctor, drive,
  proof and cleanup steps for the running product, plus a feature map. Use
  when a change must be proved by using it for real and the repo has no
  check skill yet, or for "앱 확인 스킬", "검증 스킬", "verification skill",
  "control skill".
---

# App check

A change to an app is proved by using the app: launch it, do what its user
would do, and keep what you saw. This skill writes that down once, as a skill
inside the project, so every later job (and any other agent) proves its work
the same way without working out the app again. Write it for a reader who has
never seen the app and opens it in the middle of a job.

The result lives in the repo: `.agents/skills/check-<name>/`, one per product,
named after it (`check-notes`), not one per surface. Ondra and Codex read
`.agents/skills/`; Claude Code reads `.claude/skills/` and Cursor
`.cursor/skills/`: if the repo already keeps skills in one of those, put it
there instead. If a check skill already exists in any of them (`check-*`,
`verify-*`, `control-*`), don't make a second one: improve it with
app-check-upkeep.

## 1. Learn the app from the repo, not the user

Answer these from the code; ask the user only what the repo can't show:

- **What a user touches.** A web app, a CLI or TUI, a service's API, a desktop
  app, a mobile app. A product can have several (a web page and a CLI on the
  same data): every one gets areas in the map; "main" only decides what Launch
  starts. List at the end only the surfaces this skill can't drive, with why.
- **Run.** The repo's own dev command (package scripts, Makefile, README).
  Ports, env vars, seed data, sign-in.
- **Drive.** The steps must run from the repo alone, for any agent: a harness
  the repo already has (Playwright or Cypress, expect scripts, a debug port,
  curl-able routes), else a small helper shipped in the skill's `scripts/`
  (a Chrome DevTools Protocol driver over a headless Chrome, a PTY wrapper,
  curl). Ondra's own tools may be named as the faster way inside Ondra
  (`browse` from browser-use for the web, the computer tool for a Mac app,
  device-use for iOS and Android), never as the only way.
- **See.** What proof can be kept: screenshots, terminal transcripts, response
  bodies, logs, exit codes, rows or files written.
- **Isolate.** Can a second copy run beside the user's (its own port, data
  folder, profile)? If not, the skill says so and refuses to drive the user's
  own instance; driving a shared one can break their session.

If the checkout doesn't build or start as it is, fix that first or say exactly
what fails: a skill written against a broken start teaches the wrong steps. A
missing file that blocks startup and has nothing to do with the check (a
sample config, an empty static folder) may be created by the skill, marked as
check scaffolding and removed in cleanup.

## 2. Write the skill

`SKILL.md` with frontmatter (`name: check-<app>`, and a `description` naming
the app, what a user touches and when to reach for it; without frontmatter it
never loads) and these sections, each from what step 1 found, with no
placeholders left:

- **Launch.** The exact command that starts a copy for checking, and how to
  tell it is ready: usable, not just answering (a database can pass a health
  check while its setup scripts still run). It reaches a usable state from an
  empty data folder, migrations and seed data included. A run name, picked per
  attempt, sets the port, the data folder and the proof folder. Nothing to keep
  running for a CLI: build once; an interactive CLI or TUI gets a fresh tmux or
  PTY session per drive, a one-shot command is one recorded process per call.
- **Doctor.** One read-only check: is this copy worth driving? It is ours (our
  port, our data folder), up, the right build, signed in. If the running copy
  can't report what build it is, say so and relaunch after every code edit.
  Run first, and again whenever something looks off.
- **Drive.** The harness with this repo's real selectors and commands, not
  examples. Stable handles first (roles and labels, data attributes, prompt
  strings, routes), never coordinates or tab order. One action, then look,
  then the next.
- **Proof.** What to keep and where: `$APP_ARTIFACTS_DIR/check/<run>/` when
  that is set (Ondra sets it), else a temporary folder named in the skill.
  Scratch (data, browser profiles, pid files) lives outside the proof folder;
  side-effect files worth keeping are copied into the proof before cleanup. The
  bar: the real user path, not internal setters or test-only routes; the
  action and the state it led to, not only the last screen; side effects
  (files, rows, messages sent) next to what is visible; mocks only where the
  product already isolates an outside system. A dry-run or test mode is
  checked by watching what it really skips (files, network, git refs), not
  trusted by its name.
- **Cleanup.** Stop what this run started, by its process id or session name,
  never by process name. Cleanup removes copies and scratch data, never the
  proof.
- **Helpers.** Any script the skill ships is executable, lives in its
  `scripts/`, and its exact call is shown in the skill. A helper the reader has
  to reverse-engineer is not a helper.

## 3. Start the feature map

`features/README.md` plus one file per area a user meets, from routes,
commands, menus and docs: the top three to five to start. The format is in
`references/feature-map.md`: an index in sweep order, then each area with the
same four parts (what it has, how a user gets there, checking it, gotchas).
If the seed data lacks what a check needs, the check fails and the reason goes
under that area's gotchas; never weaken a check to make it pass. The map is
the project's record of what to check: a proof that drives one convenient way
in is incomplete when the map lists others.

## 4. Prove it once before handing it over

Run the new skill's own steps end to end: launch, doctor, drive one mapped
area through every way in its file lists, keep the proof, clean up. Then
confirm the proof is still at its place; a cleanup that eats the proof fails
this step. Fix what fails, with a new run name per attempt (a failed attempt's
proof stays, its folder marked failed), running the skill's cleanup after
every failed attempt so nothing is left holding a port.
A skill never run is a draft. If you proved it somewhere that stands in for
the real target (a local stack for a remote one), list every step the stand-in
did that the real target won't; those stay unverified.

## 5. Finish

- The new files are part of the change: when the job commits, they go in its
  commit; when making the skill was the job, commit them if the user's rules
  allow commits. Name them in the report.
- Save one memory (`memory_save`, project scope, in the user's language,
  `key: check-skill`, `cites`: the new SKILL.md): where the check skill is and
  what it drives, so later jobs find it without searching. No memory tool →
  put that line in the report.
- In the report, say the map should be kept honest as the app changes: the
  app-check-upkeep skill does that, and a routine can run it regularly
  ("매주 앱 확인 스킬 점검해줘"). Offer it once; don't make the routine.

Adapted from pstack's create-verification-skill (MIT, Lauren Tan); see NOTICE.md.
