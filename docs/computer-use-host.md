# Host computer use: how Codex and Aside do it, and what we do

Background-mode Mac app control that runs on the user's own Mac without stealing
focus, moving the cursor or mixing with their typing. This documents how OpenAI's
Codex ("ChatGPT Computer Use") and Aside's computer use do it — from read-only
static analysis of the installed apps for interoperability — and the design we
ship instead.

All evidence below comes from static inspection (`otool`, `nm`, `codesign`,
`strings`, `plutil`, `llvm-objdump`, and Ondra's bundled `ondra-binary`). Nothing
was executed, no `auth.json`/tokens/credentials were read, and Codex's encrypted
runtime symbol table was **not** decrypted — that would be bypassing a protection,
and we don't need it. Reverse engineering here is to learn the technique, not to
copy code or assets.

## 1. What Codex does

### Shape
- A background agent app, `~/.codex/computer-use/Codex Computer Use.app`, bundle id
  `com.openai.sky.CUAService`, executable `SkyComputerUseService`. It is
  `LSUIElement = true` (no Dock icon, no menu bar) and holds the TCC permissions.
- The model reaches it over **MCP**; the MCP client (`SkyComputerUseClient.app`,
  `ComputerUseClient` → `ComputerUseIPCXPCTransport`) talks to the service over
  **XPC**. Evidence: demangled classes `ComputerUseMCPServer`,
  `ComputerUseIPCXPCTransport`, `SAIMachBootstrapRendezvous`.
- Linked public frameworks only (`otool -L`): `ApplicationServices`,
  `CoreGraphics`, `ScreenCaptureKit`, `AppKit`, `Carbon`, `ScriptingBridge`.
  Private frameworks are reached via `dlopen`/`dlsym` (both imported) through an
  **encrypted function-name table** resolved at launch.

### Action set (strings + demangled tool coding keys)
`list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `set_value`,
`select_text`, `scroll`, `drag`, `press_key`, `type_text`.

- `get_app_state`: "Start an app use session if needed, then get the state of the
  app's key window and return a screenshot and accessibility tree. **This must be
  called once per assistant turn before interacting with the app.**"
- Every write action returns only: "Action completed. Call `get_app_state` to
  fetch the updated UI state." — i.e. **act and observe are separate round trips**.
- `click`/`drag`/`scroll` accept **screenshot pixel coordinates**; `click` and
  `set_value`/`select_text` also accept an `element_index` into the AX tree.

### Observation
- AX tree first. Imports: `AXUIElementCopyAttributeValue(s)`,
  `AXUIElementCopyMultipleAttributeValues`, `AXUIElementPerformAction`,
  `AXUIElementSetAttributeValue`, `AXUIElementIsAttributeSettable`,
  `AXObserverCreateWithInfoCallback`. Classes `MacUIElementTreeTransformation`,
  `UIElementTreeInvalidationMonitor`, `AXTextualContext`, Markdown writer
  (`AXAttributedStringMarkdownWriter`) — the tree is serialized to Markdown-ish text.
- Tree **diffing** is built in. Strings: "The following is a diff from the previous
  accessibility tree", "The following is a cumulative diff from the initial
  accessibility tree", "There has been no change in the accessibility tree for …".
- It sets `AXEnhancedUserInterface` / `AXManualAccessibility` (strings
  `AXEnablementAssertion`, `AXEnablementOperation`) to make apps expose a richer
  tree — the same assertions VoiceOver uses.
- Screenshots are **window captures**, not whole-screen. Private WindowServer SPI
  (demangled `WindowServerSPI.captureWindowImagesInRect(options:…)` with
  `WindowServerCaptureOptions { ignoreGlobalClipShape, nominalResolution }`), plus
  public `SCScreenshotManager` / `SCWindow` (ScreenCaptureKit). Output is JPEG
  (`jpeg_compression_quality`, `maxPixelDimension`).

### Input
- A wrapper type `CGEventAPI` (24 static functions, demangled) including
  `createKeyboardEvent`, `createScrollWheelEvent`, `keyboardSetUnicodeString`,
  `post(_:tap:)`, **`postToPid(_:pid:)`**, `tapCreate`, `tapCreateForPid`,
  `tapEnable`. So keys/mouse are **posted to the target process** (`postToPid`),
  not only to the global session.
- Text typing goes through synthesized key events (`SynthesizedEvent.type(string:)`,
  `SAIVirtualKeyPress`).

### How it avoids (really: masks) focus and cursor theft
This is the key difference. Codex does **not** keep off the foreground — it
activates/targets and then **papers over** the side effects:
- `SyntheticAppFocusEnforcer` with a `State { applicationIsActive,
  applicationBelievesItHasFocus, applicationBelievesItIsActive }`, methods
  `enforceActiveState(for:)`, `notifyAppActivated/Deactivated`,
  `notifyWindowKeyFocusRemoved/Returned` (`SynthesizedEvent.notify…`). It **sends
  fake activation/focus events** so the target app believes it is frontmost.
- `SystemFocusStealPreventer` (+ `disallowedThiefProcesses`, a
  `systemProcessNotificationTap`, Carbon `kCPSNotifyNewFront` /
  `kCPSNotify*Focus*`): watches for focus theft and reacts; an
  `activationEventTap` + `activationEventSuppression` **suppresses activation
  events** and logs them to `suppressed.jsonl`.
- A **software cursor** it draws itself (`ComputerUseCursor`, `SoftwareCursorStyle`,
  `FogCursorStyle`) rather than warping the real pointer. No cursor-warp symbol
  (`CGWarpMouseCursorPosition`) is imported.
- `AXEnhancedUserInterface` is toggled to coax richer trees.

So Codex's "background" is a managed illusion: it drives the real frontmost/active
machinery for the target app and suppresses/undoes the visible fallout, with a
Picture-in-Picture view for "backgrounded apps it is working on".

### The authorization plugin
`/Library/Security/SecurityAgentPlugins/CodexComputerUseAuthorizationPlugin.bundle`
(`com.openai.sky.CUAService.AuthorizationPlugin`, team `2DC432GLL2`) is a
**login/lock-screen SecurityAgent mechanism**. On a login attempt it connects to a
unix socket `/tmp/com.openai.sky.CUAService/LockScreenLoginAuthorization.sock`,
verifies the peer's **team + signing identifier** against the Codex service via
`SecTaskCopyTeamIdentifier`/`SecTaskCopySigningIdentifier` + audit token, and asks
whether the login is allowed. It pairs with `CUALockScreenGuardian`
(`LockScreenAutoUnlockCoordinator`, `com.apple.screenIsUnlocked`). Purpose: let the
agent **drive through the lock screen / auto-unlock** for unattended sessions. A
read-only check (`security authorizationdb read`) found it staged but not wired
into `system.login.console`/`screensaver` on this machine.

### Latency / cost tricks
- AX tree + **diff-only** updates after the first turn ("no change" / cumulative
  diff) → fewer tokens per turn.
- Window-only JPEG at a capped `maxPixelDimension` → smaller images.
- Metrics it tracks itself: `time_to_first_get_app_state`, `time_to_first_write`,
  `time_from_first_get_app_state_to_first_write`.
- Cost: still **two round trips per step** (act, then a mandatory `get_app_state`),
  and an image on every `get_app_state`.

## 2. What Aside does

Read-only analysis of Aside 1.26.1107.24: `Aside Computer Use.app` (also copied to
`~/.aside/runtime-computer-use`, byte-identical), the `Aside Daemon.app` it ships
with, and the daemon's bundled `computer-use` skill. Tools: `otool -L`, `nm` +
`swift-demangle`, `strings`, `codesign -d --entitlements`, `plutil`,
`llvm-objdump` (stubs mapped with `otool -Iv`), `ondra-binary`. Nothing was run or
attached to; no account, password-manager or credential file under `~/.aside` was
read.

### Shape
- **Helper**: `aside-computer-use` (Swift, 3 MB), bundle
  `at.studio.AsideBrowser.computer-use`, `LSUIElement`, Developer ID team
  `8CPD4K4TBB`, hardened runtime. Entitlements are only
  `com.apple.security.automation.apple-events` and
  `com.apple.security.personal-information.addressbook` (its iMessage/Contacts
  features); it is not sandboxed. App control needs macOS 15 ("Native app control
  currently requires macOS 15 or later").
- **Daemon**: `Aside Daemon.app` (`at.studio.AsideBrowser.daemon`), a 161 MB
  single-file JS runtime (`allow-jit`, `disable-library-validation`). It copies
  the helper with `ditto` to a fixed path (`~/.aside/runtime-computer-use`, so TCC
  grants stick), strips quarantine, runs `codesign --verify --deep --strict`, then
  probes it.
- **IPC**: the daemon spawns the helper and speaks newline-delimited JSON on
  stdin/stdout — `{command:"invoke", id, name:"computerUse.status", payload}`.
  Commands: `computerUse.{status, apps, resolveApp, start, windows, observe,
  preview, foreground, endForeground, keepalive, stop}` plus per-lease `act`/`app`.
  Results are MCP-shaped (`result.structuredContent.tree_markdown`,
  `elements[].element_index`, `element_token`).
- **Model interface**: not MCP tools but a **JS REPL global** `computer`
  (skill: "The `computer` REPL global needs no imports"): `getApp`, `click`,
  `setValue`, `typeText`, `paste`, `pressKey` (X keysyms), `scroll`, `selectText`,
  `performSecondaryAction`, `drag`, `getAXState({query, windowId,
  disableDiffing})`, `getScreenshot`, `listWindows`, window controls,
  `requestForeground`/`endForeground`. The model batches several actions in one
  cell and ends it with `getAXState()`.

### Observation
- AX first, as Markdown-ish text: `[30] button Save`. Imports
  `AXUIElementCopyMultipleAttributeValues` (batched reads), `AXObserverCreate`,
  `AXUIElementSetMessagingTimeout`.
- **Diffs** are computed in the daemon ("~ changed, + added, removed ID ranges");
  `query` filters the tree to matching nodes and their ancestors.
- **Visible rows only**: strings " (visible and nearby context; scroll for more)",
  `ComputerUseAccessibility.visibleBounds(_:windowBounds:)`; values cut at 4,096
  characters; an open menu replaces the tree ("Only the open menu is shown").
- **Screenshots on demand**, per window, JPEG (`data:image/jpeg;base64,`), capped
  (`ComputerUseCapture.window(pid:id:bounds:maxDimension:check:)`).
- **Settle instead of sleep**: `ComputerUseAccessibility.settle(check:landed:)`,
  `settleAfterInput`, AX notifications, and up to 4 s for busy indicators.
- Actions return an **effect**, not state: `refused`, `partial`,
  `suspected_noop`, `completion_unknown` (daemon `appAction`).

### Input and focus
- Background by default: `CGEventPostToPid`. Mouse events
  (`ComputerUseOwnedInput.mouse(_:at:count:flags:)`) set CGEvent fields 1 (click
  state), 7 = 3 (subtype), **91/92** (`kCGMouseEventWindowUnderMousePointer…`) to
  the target window, plus `CGEventSetWindowLocation` — a non-public CoreGraphics
  symbol — for the window-local point.
- **Drag** (`ComputerUseOwnedInput.drag(from:to:flags:beforePress:moveCursor:)`):
  `primePointer`, mouse down, dragged steps every 1/120 s eased with
  `ComputerUseCursor.minJerk`, duration `min(reach(distance), 0.2 s)`, then up. The
  skill admits the limits: "Native sliders may ignore background drags", "Drag is
  unavailable in web content", "Drags stay inside one window".
- **Focus is forged, like Codex**: AppKit-defined events built with
  `NSEvent otherEventWithType:…subtype:data1:data2:` and posted to the pid
  (`prepareWindow(keyFocus:)`, `resetSyntheticFocus`, `syntheticFocusPIDs`), and
  `CPSReleaseKeyFocus` resolved with `dlsym` ("This macOS version cannot preserve
  user keyboard focus").
- **Foreground mode** when background input fails: `requestForeground` brings the
  app to the front, `ComputerUseInputLock` (an event tap) locks the user's mouse and
  keyboard until Esc, `ComputerUseGlow` draws a Metal screen-edge glow ("Aside is
  controlling your screen"), `ComputerUseCursor` draws its own cursor, and the real
  one is hidden (`CGDisplayHideCursor` + private
  `CGSSetConnectionProperty("SetsCursorInBackground")`); `CGWarpMouseCursorPosition`
  is imported.
- **User first**: `CGEventSourceSecondsSinceLastEventType` / `hardwareInputAt`
  — "The user is still working in …, so nothing was sent". Password fields and
  Secure Input (`kCGSSessionSecureInputPID`) are refused; system shortcuts are
  refused during screen control.

### Targeting, capture, permissions
- Windows by `windowId` (`listWindows`, `_AXUIElementGetWindow` — private — maps AX
  to CGWindowID). Coordinates are pixels of that window's latest screenshot and are
  refused after a move: "The window moved since your screenshot, so its
  coordinates no longer apply".
- Capture: ScreenCaptureKit plus private SkyLight `SLSHWCaptureWindowListInRect`
  (`dlopen` of `SkyLight.framework`) for off-screen windows.
- Permissions: Accessibility, Screen Recording, Input Monitoring (its "Context
  Awareness" recorder of typed runs), Automation (Messages), Contacts, Full Disk
  Access. Per-task **leases** with `read`/`control` access; the app's code identity
  and signing team are checked before control.

### Speed and cost tricks
Code-mode batching (many actions per model call), daemon-side diffs, `query`
filtering, visible rows only, capped values, JPEG screenshots only on demand,
notification-based settling instead of fixed sleeps, batched AX reads.

## 3. What we do

Decision (from the user): background on their own Mac is the default; the VM guest
becomes an optional isolated mode. We reverse-engineered Codex to learn the
technique and then did it better — using only **public** APIs.

- **Genuinely background, not masked.** We never activate, never send synthetic
  activation/focus events, never warp or draw a cursor. Instead the helper
  **records the frontmost app, the key window and the mouse position before and
  after every action and verifies they are unchanged** — if an action can't be
  done without changing them, we report it as unsupported rather than forging
  focus events the way `SyntheticAppFocusEnforcer`/`SystemFocusStealPreventer` do.
  No `suppressed.jsonl`, no PiP, no lock-screen auto-unlock plugin.
- **Public APIs only.** AX (`AXUIElement*`), pid-targeted `CGEventPostToPid`
  (public), and `ScreenCaptureKit` window capture (`SCScreenshotManager`
  `captureImage(contentFilter:)`). No private WindowServer SPI, no `dlopen` of
  private frameworks, no decrypted symbol table.
- **Pointer events reach background windows with public API.** A pid-posted
  `CGEvent` carries no window, and a background AppKit app drops it (verified: the
  test app saw `windowNumber = 0`). We build mouse events with the public
  `NSEvent.mouseEvent(with:location:…windowNumber:…)` and post its `cgEvent` to the
  pid; the event then lands in the right window at the right window-local point,
  without `CGEventSetWindowLocation`.
- **One round trip per step.** Our `act` returns the AX diff in the same call;
  Codex forces a separate `get_app_state` every turn. Fewer calls, fewer tokens.
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

## 4. Codex vs Aside vs Ondra

| | Codex | Aside | Ondra |
|---|---|---|---|
| Process / IPC | LSUIElement service, MCP client → XPC | LSUIElement helper, daemon ↔ stdin/stdout JSON | signed helper, tool ↔ stdin/stdout JSON |
| Model interface | MCP tools | JS REPL (`computer` global), batched cells | one `computer` tool |
| Observation | AX → Markdown, diffs | AX → Markdown `[N]`, daemon diffs, `query`, visible rows | AX → compact JSON, short stable ids, delta/unchanged, visible rows |
| Round trips per step | 2 (act, then `get_app_state`) | act returns effect; state in same cell | 1 (act returns the delta) |
| Screenshot | window, JPEG, every state | window, JPEG, on demand | window, PNG, on demand |
| Background input | `postToPid` + forged focus/activation | `postToPid` + forged focus, private window location | `postToPid` with public `NSEvent` window routing; no forged focus |
| When background fails | masks activation, own cursor | foreground mode: locks user input, glow, own cursor | fails with a reason; never foreground |
| Focus/cursor check | suppresses side effects | lease + user-activity checks | verifies frontmost app, key window id and mouse before/after every action |
| Drag | pixels | pixels, min-jerk 120 Hz, ≤0.2 s | pixels or refs, min-jerk 120 Hz, ≤12 steps |
| Off-screen capture | private WindowServer SPI | private SkyLight SPI | ScreenCaptureKit only |
| Private APIs | yes (encrypted table) | yes (SkyLight, CPS, CGS, `_AX…`) | none |

## 5. What we adopted from Aside, and what we did not

Adopted (all public API):
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
- **Effect hint**: `no_change` when the tree did not change after an action
  (Aside's `suspected_noop`).
- **User first**: event input is refused with `USER_ACTIVE` while the user is
  typing or pointing in the target app; **password fields** are never read or
  typed into; typing checks that keyboard focus really landed on the target
  (`FOCUS_UNVERIFIED`).
- Selected text in the tree (`selection`), so a selection can be verified.

Rejected:
- Forged focus/activation events, `CPSReleaseKeyFocus`, `CGEventSetWindowLocation`,
  `_AXUIElementGetWindow`, SkyLight capture and `SetsCursorInBackground`: private
  or focus-forging; out of bounds by design.
- Foreground mode, input lock, glow and software cursor: they take the user's
  screen; our contract is to fail instead.
- Clipboard paste: it touches the user's clipboard, a global side effect, even if
  restored.
- JPEG + max dimension: we already capture at 1× point size; image tokens are set
  by dimensions, and PNG keeps small text exact for pixel targeting.
- Code-mode REPL batching and `query`: a different tool surface; our `act` already
  returns the delta in the same call. Candidates for later.
- Reading Secure Input through `kCGSSessionSecureInputPID`: an undocumented
  dictionary key.

## 6. Measured numbers
See `docs/computer-use.md` ("Host background mode — measured") for the numbers
captured on the user's Mac (ms/action, bytes-and-tokens/observation, and the
frontmost/key-window/cursor invariants before vs after each action), with Codex
compared where its own metric names make it measurable.
