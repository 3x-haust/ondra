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
- **Off-screen display**: an app the job opens runs on a `CGVirtualDisplay` the
  helper holds just off the corner of the real screens (`Backdrop`). The process is
  spawned suspended, assigned to that display's desktop (`SLSProcessAssignToSpace`),
  then resumed, so its first window opens off-screen — no flash, no Dock tile
  (it runs from an `LSBackgroundOnly` copy), no focus taken. Capture and pointer/key
  events address the window by id wherever it sits, so nothing is ever shown on the
  user's screen. On `stop` the copy is quit and cleaned up (`lsregister -u`, delete).
- **Keychain-safe copy**: the background copy is shaped per app kind so the app's
  login keychain keeps working (a modified `Info.plist` in place during a keychain
  read is rejected by securityd). `native` — `Info.plist` is a copy, everything else
  a symlink to the real app. `chromium` — an APFS clone with the real executable
  hard-linked and the real `Info.plist` swapped back the instant the app checks in
  (`_LSCopyApplicationInformationItem(ApplicationType)`). `sandboxed` — the real
  plist until the sandbox is on (`sandbox_check`), then the background plist, then
  the real one back at check-in. The `start` result's `mode` reports which kind,
  `+guard` when `ondra-bgguard.dylib` is injected to keep a self-activating app
  background. Safari web apps, Catalyst, iOS-on-Mac, App Store and system apps can't
  be copied this way (a changed web app or Web App bundle is refused as damaged) and
  run as the real app: launched hidden, its process caught the moment it exists
  (past launchd and xpcproxy; a web app by its `--bundlepath`) and assigned to the
  off-screen display's space before its first window, then shown there once every
  window has moved over (`mode: offscreen`). Its Dock tile shows it running; nothing
  else does. If it can't be placed, it stays hidden (`mode: hidden`) and a capture or
  events unhide it behind the user's windows for the moment they need. Each helper
  holds its own display (serial = its pid), so jobs running at once don't collide.
  On release (or when the helper exits) a real app the job opened is quit, so its Dock
  tile stops showing it running; one the user has brought to the front is left alone,
  and one that won't quit (a question about unsaved work) is hidden. An app the user already had open is used as-is, never
  copied. A window the user's own app left on the off-screen display is moved back.

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
- Scroll wheel events are not used (a background app drops them). A scroll area
  without a settable scroll bar or page action is scrolled by revealing the nearest
  element past its visible edge (`AXScrollToVisible`, `scrolledBy: reveal`); only
  when nothing moves does it report `SCROLL_UNAVAILABLE`.
- **Apps that need their window drawn**: a hidden app is shown for a moment for each
  capture and each pointer or key event. An app whose AX tree empties while hidden
  can only be driven with those (each shows it briefly).
- Fully offscreen/minimized windows and multi-window targeting are minimal (the AX
  key window).

