# Host computer use: how Codex does it, and what we do better

Background-mode Mac app control that runs on the user's own Mac without stealing
focus, moving the cursor or mixing with their typing. This documents how OpenAI's
Codex ("ChatGPT Computer Use") does it — from read-only static analysis of the
installed app for interoperability — and the design we ship instead.

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

## 2. What we do (and why it's better)

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
- **One round trip per step.** Our `act` returns the AX diff in the same call;
  Codex forces a separate `get_app_state` every turn. Fewer calls, fewer tokens.
- **Diff by default, stable IDs.** Compact AX tree with per-session stable element
  ids; later observations send only the JSON diff since the last one (or
  "unchanged"). Pixels only when the model asks (`look`).
- **Any model.** Text-only models use the AX tree; vision models can additionally
  request window crops. Measured tokens/observation and ms/action are recorded.
- **AX-action-first.** We prefer `AXUIElementPerformAction` / settable-attribute
  writes (which don't need events at all) and only fall back to pid-targeted
  events for keys/text/scroll/drag/coordinate clicks — so most actions touch no
  input queue at all.
- **Window-only capture, including hidden/occluded windows**, via ScreenCaptureKit
  content filtered to the target app's own windows. Never a full-screen grab.

### Measured numbers
See `docs/computer-use.md` ("Host background mode — measured") for the numbers
captured on the user's Mac (ms/action, bytes-and-tokens/observation, and the
frontmost/key-window/cursor invariants before vs after each action), with Codex
compared where its own metric names make it measurable.
