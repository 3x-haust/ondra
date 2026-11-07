---
name: computer-use
description: >
  Native Mac app automation in an isolated macOS guest. Read before operating
  Mac apps, clicking buttons, typing into fields or capturing native app screens.
  Defines the guest-only boundary, setup checks, observation and safe recovery.
---

# Computer use

Native app automation requires an **isolated macOS guest**. It does not operate
windows already open on the user's Mac. Guest apps, documents and logins are
separate. A second display, a hidden window, a process ID and an Accessibility
reference are not separate input sessions.

## Before acting

Use only a verified guest execution path. Confirm its identity, ownership by
this job and supported actions before any app launch or input. A guest address
or an environment variable alone is not evidence of isolation. If the guest or
its transport is unavailable, stop and report that setup is required. Do not
invent a connection or silently execute locally.

Do not run the bundled desktop CLI on the host. Do not substitute AppleScript,
`open` (including background flags), Accessibility calls, process-targeted key
injection, global input or a native debug app launched from the terminal.
Command checks reject known host paths but are **not an OS sandbox**. Shell
access can execute arbitrary programs; never claim that these checks isolate
all agent activity. Restoring the user's focus after activation is not focus
preservation.

Ask before additional permissions, paid services, uploads, account changes or
sharing host files with the guest. Do not enable shared clipboard, host folders
or automatic host URL opening to work around a guest limitation.

## Observe, act, verify

1. Observe the guest app. Prefer structured accessibility information when it
   contains the target. Use a guest screenshot when text is insufficient.
2. Use references only from the current observation and the same guest session.
   Re-observe after UI changes; do not guess a stale reference or coordinates.
3. Execute one supported action, then inspect its result in the guest. An
   accepted command is not proof that the requested UI change happened.
4. On timeout, disconnect or cancellation, the action's outcome can be unknown.
   Re-observe before proceeding. Never blindly repeat a send, purchase, deletion
   or other action that could already have completed.
5. If permissions or capabilities are missing, report the blocked action and
   reason. Do not switch to host input or restore/rearrange the user's windows.

Reuse an unchanged observation instead of requesting the same screenshot.
Return changed structured information when sufficient, and include an image
only when needed for the next decision or evidence. Do not trade verification
or target accuracy for fewer tokens. Text-only models cannot verify visual-only
controls; report that limitation rather than claiming universal support.

## Capture and evidence

Keep guest screenshots and recordings in `$APP_ARTIFACTS_DIR`. Inspect each
image before citing it. A blank, stale, partial or thumbnail capture is not
proof of success. Capture failures do not authorize bringing a host window
forward or changing Stage Manager, Spaces or display settings.

Record the guest environment, actions, results and any unsupported conditions.
Unit tests and mocked transports are not evidence of real macOS focus, keyboard,
mouse or window-layout preservation. Mark untested OS conditions as unverified.
Report real token usage separately from image bytes, text size and estimates.

## Other surfaces

For websites, use the browser-use skill without launching a native host browser.
For iOS simulators and Android emulators, use the device-use skill and this job's
own device. Neither substitutes for verifying native macOS app behaviour.
