# A feature map

A map of what an app does, written for whoever checks it next (an agent or a
person): one short file per area, so a check opens only the file for the
change instead of rereading the whole code or a wiki. Keep it behavior-level:
what a user sees and does, never how the code is built.

## Layout

```text
check-<app>/features/
  README.md        # the shared rules and the index in sweep order
  <area>.md        # one per area (sign-in, sidebar, editor, settings, sync …)
  journeys.md      # flows that cross areas, run last in a full sweep
```

## README.md

- **Starting state.** How every check begins: the copy launched by the
  skill's Launch step, its URL or command, its own data folder (named per run,
  so two runs never share it), the seed data or test account, and the doctor
  result to require before driving.
- **Driving rules.** Handles to prefer (roles and labels over CSS or position),
  what to wait on, commands taken literally, data a check changes put back
  afterwards, proof never removed by cleanup.
- **Proof and skips.** What each kind of proof holds: a UI check keeps a
  snapshot and a screenshot with the app visible; a CLI check keeps the
  command, stdout, stderr and exit code; a change that saves something is read
  back a second way. Every proof names the area and the way in it used. A way
  in that couldn't be reached is reported with what was tried and what was
  missing, never as checked through another way.
- **Areas.** Grouped and in the order a full sweep walks them, one line each,
  linking the area files; `journeys.md` last.

## Each area file: the same four parts

```markdown
# <Area>

One or two sentences: what a user does here.

## What it has
- <id>: what it does, in a line. Gated or plan-only ones say so.

## How a user gets there
- Every way in: the button and where it is, the menu item, the shortcut, the
  link, the command.
- What happens on success, on cancel, on an error, when empty, after a reload.

## Checking it
<!-- recipes run one after another on one copy: use text unique to the recipe
     and read ids from the output, never assume an empty store or fixed ids -->
- Preconditions: (account, data, a flag), then each user action paired with
  the exact driver command and the result to see.
- The state to wait for before checking, and what to read (screen, file,
  request, row).

## Gotchas
- What looks like a bug and isn't, what is easy to mix up (two commands with
  similar names, a shortcut that means different things by focus), what the
  seed data lacks, and what can't be driven and stays manual.
```

Split a file when one section starts needing its own preconditions. Fix the
map in the same change as the UI it describes; a map that drifted is worse
than none.
