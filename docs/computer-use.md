# Computer use

The `computer` tool operates one Mac app in the background on the user's own Mac,
without taking focus.

## How it works

A signed Swift helper, `ondra-cuhost` (`src-tauri/helpers/cuhost.swift`, built by
`src-tauri/helpers/build.sh`, bundled via `externalBin`), drives one target app
using only **public** APIs:

- **Observe** the target app's Accessibility tree as a compact tree where every
  element has a stable `id`; later observations are a JSON **delta** since the
  last tree, or `unchanged`.
- **Act** with AX first — `AXUIElementPerformAction` and settable-attribute writes
  need no events at all; scrolling sets the scroll area's AX scroll bar — falling
  back to **pid-targeted** `CGEventPostToPid` for keys, text, coordinate clicks and
  drags. Mouse events are built with the public `NSEvent` mouse-event initializer
  so they carry the target window. Never the global session.
- **Capture** the target app's own key window with ScreenCaptureKit
  (`SCScreenshotManager`), only when the model asks (`look`). Never the whole
  screen.
- **Launch** without activation (`NSWorkspace.OpenConfiguration.activates = false`),
  so the user's frontmost app stays in front.
- **Hidden**: an app the launch opens starts hidden (`OpenConfiguration.hides`),
  so nothing shows on the user's screen and Stage Manager doesn't switch. AX reads
  and actions work on a hidden app. A capture or pointer/key events unhide it
  without activation (behind the user's windows) for the moment they need, then
  hide it again. Parking windows off-screen instead doesn't work: a visible window
  is kept on the stage (Stage Manager) and a parked window can't be captured. An app
  that was already running is not hidden.

The background contract is **verified, not masked**: the helper records the
frontmost app, key window and mouse position before and after every action and
returns whether they changed; the tool refuses to continue if they did, rather
than forging focus events the way Codex does (see `computer-use-host.md`). It
never activates an app, warps the cursor or posts global events. `act` re-observes
in the **same call**, so one step is one round trip (Codex needs two). The
TypeScript side is `extensions/lib/computer-host.ts`; the tool is available when
`ONDRA_COMPUTER_HOST=1`, which the app sets whenever the helper is bundled.
`ONDRA_COMPUTER_EVALUATION_MODE=forced-full` makes every observation and image
full, for evaluations.

Any model works: text-only models use the AX tree; vision models can also request
window crops with `look`.

### Permissions

The **host app** (Ondra) needs, in System Settings → Privacy & Security:
- **Accessibility** — to read the tree and perform actions.
- **Screen Recording** — only for `look` (window capture).
Grant them to Ondra; the helper inherits them. The tool reports a missing
permission rather than failing silently.

### Measured (on the user's Mac, 2026‑11‑08, macOS 26 / arm64)

Measured with the helper driving apps the test launched (TextEdit, Calculator and
a tiny built AppKit app with a drag pad, two text fields and a 300-row table),
while the user's terminal stayed frontmost throughout. "Before" is the previous
helper on the same apps.

| App (window) | AX tree bytes before → after | observe median before → after | act median before → after |
|---|---:|---:|---:|
| Test app (300-row table) | 90.5 KB → 3.0 KB | 114 ms → 24 ms | — |
| Calculator | 7.1 KB → 3.4 KB | 9 ms → 9 ms | 91–98 ms → 53–56 ms (AXPress + re-observe) |
| TextEdit (new document) | 7.6 KB → 5.6 KB | 11 ms → — | — → 85 ms (type + re-observe) |

- **Drag** (test app, 10 drags, ~260 px): events posted in a median **142 ms**
  (12 eased steps), 177 ms with settling, 225 ms per tool round trip including the
  re-observed delta. The app saw the exact down/up points and never became active.
- **Where the bytes went**: offscreen table rows are left out and counted
  (`offscreen: 293`), and ids are 8-character hashes instead of path strings.
- **Background invariant**: 20 actions across the three apps, frontmost app, front
  window id and mouse position identical before and after every one, and at the
  start and end of the run. (The previous check compared window titles and
  flagged a terminal's animated title as a focus change.)
- **Window-only `look`**: the AX key window, never the whole screen.

### Limits in background mode

- **Stage Manager**: a background window parked in the strip is captured as a small
  skewed thumbnail. `look` marks it `staged` and not actionable; use element refs.
- **Views that poll the real mouse button** ignore background drags: TextEdit's
  text selection did not change (`effect: no_change`), while a double-click still
  selected a word. Prefer `set-value` or keys there.
- Scroll wheel events are not used (a background app drops them); scroll areas
  without a settable scroll bar or page action report `SCROLL_UNAVAILABLE`.
- **Apps that need their window drawn**: a hidden app is shown for a moment for each
  capture and each pointer or key event. An app whose AX tree empties while hidden
  can only be driven with those (each shows it briefly).
- Fully offscreen/minimized windows and multi-window targeting are minimal (the AX
  key window).

