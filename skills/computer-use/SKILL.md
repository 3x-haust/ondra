---
name: computer-use
description: >
  Computer use inside the app with the bundled agent-desktop. Use when a worker
  must see or operate a native Mac app (Simulator, Finder, System Settings, any app
  window): click buttons, read UI state, type into fields, take screenshots. Covers
  the one-at-a-time desktop slot, headless-only input, evidence and reporting.
---

# Computer use

`agent-desktop` ships inside the app and is already on your `PATH`, with its
macOS helper wired up. The app holds the Accessibility permission; you do not ask
for it and you do not open System Settings.

## Fast path (no need to read help or other skills first)

```bash
SID=$(agent-desktop session start --name "w-$APP_WORKER_ID" --screenshots | jq -r .data.activation.value)
agent-desktop launch "Calculator" --session "$SID"            # name or bundle id; returns when it runs
agent-desktop snapshot --app "Calculator" -i --session "$SID" # refs like @s…:e12
agent-desktop click @s…:e12 --session "$SID"                   # accessibility press, no mouse
agent-desktop set-value @s…:e3 "text" --session "$SID"         # or: type @ref "text"
agent-desktop press return --app "Calculator" --session "$SID" # keys go to that app only
agent-desktop screenshot --app "Calculator" "$APP_ARTIFACTS_DIR/after.png" --session "$SID"
agent-desktop session end --session "$SID"
```

Several known clicks in a row (keypad digits, a form) go in **one** `batch`,
then one snapshot to check the result:

```bash
agent-desktop batch '[{"command":"click","args":{"ref_id":"@s…:e14"}},{"command":"click","args":{"ref_id":"@s…:e15"}}]' --stop-on-error --session "$SID"
```

`press` sends one key or combo per call (`press return`, `press cmd+a`), not a
string. For text use `type @ref "text"` / `set-value`. Check the result once;
don't redo a sequence that already worked. Act straight from the snapshot. Read
`agent-desktop skills get desktop` or `<command> --help` only after a command
fails in a way this page doesn't cover.

## Everything runs behind the user's windows

The user keeps working while you do. Nothing you run may bring a window to
the front, take the keyboard or move the mouse. Ondra stops those commands and
asks the user first, so they cost you a question:
- AppleScript `activate`, `set frontmost`, System Events `keystroke` / `click`
- `open` without `-g` (apps, files and URLs all come to the front)
- agent-desktop `launch --activate`, `focus`, `focus-window`, `maximize`,
  `--headed`, `mouse-*`, `hover`, `drag`, `--xy`, `cursor-overlay`, and
  `press` without `--app`

The background way does the same work:
- Start an app: `agent-desktop launch "<App>"` (it doesn't come forward).
- Open a document in an app: `open -g -a TextEdit "$APP_ARTIFACTS_DIR/note.txt"`.
  The window opens behind the others, so you can snapshot and screenshot it.
  Don't add `-j` when you need pictures: a hidden app's windows can't be
  captured.
- Clicks, text and keys: `click @ref`, `set-value @ref "…"`, `type @ref "…"`,
  `press <key> --app "<App>"`. These go to that app only, by accessibility or
  straight to its process.
- Pictures: `screenshot --app "<App>"` captures the window even when it's
  behind other windows (not when it's minimized or hidden).
- An app you start yourself from a terminal (`pnpm dev` of an Electron app,
  `electron .`, a debug build, a booting simulator) may bring itself forward
  when it opens its window. Ondra sends it straight back behind the user's
  window, so you don't need to do anything about it. Don't bring it forward
  again to work around that: snapshot, screenshot and `press --app` all work
  on a window that's behind. Still run the built app with `open -g` when you
  can.
- Never make keys or clicks for the whole system: no code posting CGEvents to
  the HID or session tap (a Swift/Python/JS script with `CGEventPost`,
  `.post(tap:)`, `CGEvent(keyboardEventSource:…)`, `Quartz.CGEventPost`), no
  `cliclick`, no AppleScript `keystroke` / `key code` / `click at`. They land in
  whatever the user has in front (their terminal, their editor), and Ondra
  refuses them. Keys for one app you launched go to that app only:
  `agent-desktop press <key> --app "<App>"`, or `CGEventPostToPid` with its pid.
  Shortcuts and typing are tested with unit tests or the app's own test hooks;
  the real key press goes in "unverified".
- Work that only happens in the frontmost app (keyboard and input-method
  behaviour, e.g. a typing-correction app): test the logic with unit or
  integration tests, or feed it input through a scripted path. Driving it in
  front of the user needs an `ask` first, with the reason.

## Stage Manager

When Stage Manager is on, a window that sits behind shrinks into the side
strip, and a screen capture of it (`screenshot --app`, `screencapture -l`)
comes back as that small, perspective-warped thumbnail. Check once per job:
`"<this skill's folder>/shot-check.sh"` prints `stage-manager on|off`. With a
picture and the app (`shot-check.sh <png> "<App>"`) it compares the picture
with the window's real size and exits 3 for a thumbnail.

Stage Manager is the user's setting: never turn it off, and never bring the
window forward to get a better picture. When it is on, take pictures from
inside the app instead of from the screen:
- Electron or web: CDP `Page.captureScreenshot` on the app's remote debugging
  port (`launch --cdp`, or start it with `--remote-debugging-port=<port>`), or
  `webContents.capturePage()` through the app's test hook.
- iOS simulator: `xcrun simctl io <udid> screenshot "$APP_ARTIFACTS_DIR/<name>.png"`.
- Android: `adb -s <serial> exec-out screencap -p > "$APP_ARTIFACTS_DIR/<name>.png"`.
- A native app with none of these: read what's on screen from the
  accessibility tree (`snapshot`), report that, and put the picture under
  "unverified" as not taken.

An app a job launches may land in the strip. That's expected: it stays behind
the user's window.

## Rules here

1. **One worker at a time.** The screen is shared, so desktop work is a heavy job.
   The app only starts you when the desktop slot is free; finish quickly and leave
   apps the way you found them.
2. **Headless only.** Act on refs (`click @s…:e…`, `set-value`, `toggle`). These
   go through accessibility calls and never move the user's mouse or steal focus.
   Never switch to headed, AppleScript or `open -a` to recover from a headless
   failure: snapshot again, try another ref or action, or report what didn't work.
3. **Refs are per snapshot.** Snapshot, act, re-snapshot the same region to
   verify. On `STALE_REF` take a new snapshot; retry an action only when
   `error.disposition.retry` is `safe`.
4. **Keep a replay, not a visible cursor.** Work in a traced session named after
   you so the app can replay the leg. Never turn on the cursor overlay
   (`--cursor`, `cursor-overlay`): it draws on the user's screen.

   ```bash
   agent-desktop session start --name "w-$APP_WORKER_ID" --screenshots
   # read the session id from the JSON envelope's data, then pass it everywhere:
   agent-desktop snapshot --session "$SID" --app "Simulator" -i
   # … every command in the leg takes --session "$SID" …
   agent-desktop trace export --session "$SID" --out "$APP_ARTIFACTS_DIR/desktop-trace.html"
   agent-desktop session end --session "$SID"
   ```
   `--screenshots` keeps a picture
   before and after every action. Send the exported trace as a `link` block with
   `"kind":"file"`.
5. **Proof is a picture.** `agent-desktop screenshot --app "<App>"
   "$APP_ARTIFACTS_DIR/<name>.png"` before and after the change, then a
   `beforeAfter` block. Screenshots can contain private data: keep them inside
   `$APP_ARTIFACTS_DIR` only. Look at every picture before you use it, and run
   `"<this skill's folder>/shot-check.sh" <png> "<App>"` on it (see below). A
   tiny, skewed or blank picture counts as not taken. Never put one in a report
   or a PR as proof.
6. **Outward or destructive actions need a decision.** Sending, deleting,
   purchasing, changing system settings or signing in goes through `ask` first.

## Report

```blocks
{"type":"now","text":"시뮬레이터에서 백업 버튼 누르는 중"}
{"type":"checklist","items":[{"label":"백업 버튼","done":true},{"label":"완료 표시","done":true}]}
{"type":"beforeAfter","label":"백업 화면","before":"실패 표시","after":"완료 + 시각","beforeImage":"before.png","afterImage":"after.png"}
```
