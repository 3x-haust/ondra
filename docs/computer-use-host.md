# Host computer use: design

Background-mode Mac app control that runs on the user's own Mac without stealing
focus, moving the cursor or mixing with their typing. This documents the design
Ondra ships and why. How to use and build it is in `docs/computer-use.md`.

## 1. Approach

Computer use runs in the background on the user's own Mac; the earlier VM guest
mode is gone. A common way to drive background apps is to send them synthetic
activation/focus events so they believe they are frontmost, then suppress or undo
the visible fallout (a software cursor, a "focus steal" watcher, a foreground mode
that locks the user's input). Ondra does not do that, and uses only **public** APIs.

- **Genuinely background, not masked.** We never activate, never send synthetic
  activation/focus events, never warp or draw a cursor. Instead the helper
  **records the frontmost app, the key window and the mouse position before and
  after every action and verifies they are unchanged** — if an action can't be
  done without changing them, we report it as unsupported rather than forging
  focus events. No event suppression log, no picture-in-picture, no lock-screen
  auto-unlock plugin.
- **Public APIs only.** AX (`AXUIElement*`), pid-targeted `CGEventPostToPid`
  (public), and `ScreenCaptureKit` window capture (`SCScreenshotManager`
  `captureImage(contentFilter:)`). No private WindowServer SPI, no `dlopen` of
  private frameworks.
- **Pointer events reach background windows with public API.** A pid-posted
  `CGEvent` carries no window, and a background AppKit app drops it (verified: the
  test app saw `windowNumber = 0`). We build mouse events with the public
  `NSEvent.mouseEvent(with:location:…windowNumber:…)` and post its `cgEvent` to the
  pid; the event then lands in the right window at the right window-local point,
  without the private `CGEventSetWindowLocation`.
- **Target preparation per step.** `prepare` checks whether the live target needs
  confirmation. Ordinary actions use `act`; sensitive actions use a one-shot
  `commit-approval` after the user confirms. Both return the AX diff without a
  separate "get state" call.
- **Diff by default, stable IDs.** Compact AX tree with per-session stable element
  ids; later observations send only the JSON diff since the last one (or
  "unchanged"). Pixels only when the model asks (`look`).
- **Any model.** Text-only models use the AX tree; vision models can additionally
  request window crops. Measured tokens/observation and ms/action are recorded.
- **AX-action-first.** We prefer `AXUIElementPerformAction` / settable-attribute
  writes (which don't need events at all) and only fall back to pid-targeted
  events for keys/text/drag/coordinate clicks — so most actions touch no input
  queue at all. Scrolling sets the scroll area's AX scroll bar (wheel events posted
  to a background app carry no window and are dropped).
- **Window-only capture, including hidden/occluded windows**, via ScreenCaptureKit
  content filtered to the target app's own windows. Never a full-screen grab.

## 2. Summary

| | Ondra |
|---|---|
| Process / IPC | signed helper, tool ↔ stdin/stdout JSON |
| Model interface | one `computer` tool |
| Observation | AX → compact JSON, short stable ids, delta/unchanged, visible rows |
| Round trips per step | prepare + act; sensitive actions also confirm and consume the held request |
| Screenshot | window, PNG, on demand |
| Background input | `postToPid` with public `NSEvent` window routing; no forged focus |
| When background fails | fails with a reason; never foreground |
| Focus/cursor check | verifies frontmost app, key window id and mouse before/after every action |
| Drag | pixels or refs, min-jerk 120 Hz, ≤12 steps |
| Off-screen capture | ScreenCaptureKit only |
| Private APIs | none |

## 3. Techniques used, and ones ruled out

Used (all public API):
- **Batched AX reads** (`AXUIElementCopyMultipleAttributeValues`, one IPC per
  element) and a global `AXUIElementSetMessagingTimeout` so a hung app cannot hang
  the helper.
- **Visible rows only**: children outside their scroll area are left out and
  counted in `offscreen`; plus **short hashed ids** instead of path ids.
- **Settle on AX notifications** (`AXObserver`, quiet 30 ms, cap 600 ms) instead of
  a fixed 60 ms sleep.
- **Drag** with a primed pointer, eased (min-jerk) 120 Hz dragged steps, then up.
- **Window-bound coordinates**: pixels of the latest look, refused without a look
  (`NEEDS_LOOK`) or after a move/resize (`WINDOW_MOVED`); the look captures the
  window the tree describes.
- **Effect hint**: `no_change` when the tree did not change after an action, so a
  likely no-op is visible to the model.
- **User first**: event input is refused with `USER_ACTIVE` while the user is
  typing or pointing in the target app. **Password fields** are never read or
  typed into with keys; `fill-secret` replaces them through AX after an in-app
  confirmation, using a saved name resolved inside the helper. No paste or key
  fallback. Confirmed dialog keys require a verified focused control (`FOCUS_UNVERIFIED`).
- Selected text in the tree (`selection`), so a selection can be verified.

Ruled out:
- Forged focus/activation events, `CPSReleaseKeyFocus`, `CGEventSetWindowLocation`,
  `_AXUIElementGetWindow`, SkyLight capture and `SetsCursorInBackground`: private
  or focus-forging; out of bounds by design.
- Foreground mode, input lock, screen-edge glow and software cursor: they take the
  user's screen; our contract is to fail instead.
- Clipboard paste: it touches the user's clipboard, a global side effect, even if
  restored.
- JPEG + max dimension: we already capture at 1× point size; image tokens are set
  by dimensions, and PNG keeps small text exact for pixel targeting.
- Code-mode REPL batching (several actions per model call) and tree `query`
  filtering: a different tool surface; our `act` already returns the delta in the
  same call. Candidates for later.
- Reading Secure Input through `kCGSSessionSecureInputPID`: an undocumented
  dictionary key.

### Approval boundary

The helper, not a model-selected mode, classifies native sheets, dialogs, modal
windows, secure fields and non-regular agents as sensitive. Classification walks
AX independently of the clipped display tree; incomplete inspection refuses input
and capture. A window and its password fields remain protected after reveal.
Secure targets accept only ref-based AX writes/actions after confirmation.
Ordinary dialogs also permit confirmed typing/keys when focus belongs to the
confirmed control. Unsupported custom/canvas
approval UI is left to the user. `targets` lists an exact running app's windows
and direct sheets; `target` selects a live AX root while the original app stays
owned by the session. `resume` returns to that app; only `stop` releases it.

`prepare` holds a single pending action, actual AX window/root/element references
and its observation. `commit-approval` consumes its opaque id and checks the
live references with `CFEqual` and the observation contents before executing the
held action. It cannot substitute a different action. Other requests clear the
pending action. Password replacements compare field and ancestor identity/labels;
other actions compare the selected dialog contents, excluding volatile focus.
The host app's PID is excluded from launch, targets and actions so its jobs cannot
click their own confirmation cards. No persistent permit or session-wide user
authorization exists.

The helper does not read secure values/selections or their children. Saved
secret values, including short ones, are redacted from human-readable output.
After a secure-field observation, selected approval target, security process or
secret-bearing text, captures are refused for the helper's remaining lifetime,
even after returning to the original app. An ordinary sheet alone does not latch
this restriction. Both capture checks must inspect the same window; an unreadable
or unmatched window never falls back to another window. A password reveal can put
text anywhere in the image, so masking only the field would be insufficient.
This prevents PNG storage and automatic image posting, rather than relying on
post-processing an image already exposed to the model.

## 4. Measured numbers
See `docs/computer-use.md` ("Measured") for the numbers captured on a test Mac
(ms/action, bytes-and-tokens/observation, and the frontmost/key-window/cursor
invariants before vs after each action).
