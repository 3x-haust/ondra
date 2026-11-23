---
name: check-ondra
description: Check Ondra's real macOS app and Discord agent with an isolated debug build. Use after changes to Discord input, conversation actions, questions, routines or completion reporting.
---

# Check Ondra

This is a draft procedure. Isolated launch, connection, owner-input receipt and
main-chat tool execution have been exercised. The Discord conversation and work
journeys still need a complete live pass; do not treat this map as a passing QA
record.

Use a separate debug app, not the installed app's data. The installed app may
keep running, but only one Discord gateway may use the bot token. Ask before
launching a development app or interrupting the installed bot. A test never
approves a merge, release, purchase or permission change.

## Launch

1. Record the checkout commit and the installed agent's on/off setting. Use
   Settings → 에이전트, or `ondra_settings` inside Ondra. Do not read the user's
   state file or copy model credentials. Never print a bot token.
2. Choose a new run name, a scratch directory, and a proof directory. Use
   `$APP_SCRATCH_DIR` and `$APP_ARTIFACTS_DIR` when provided. Otherwise use a
   temporary directory for scratch and record the proof directory explicitly.
   Put Cargo's target directory in scratch when building outside the checkout.
3. Install the repository dependencies with `pnpm install`. Prepare the bundled
   resources with the repository's `pnpm bundle` when they are missing. Existing
   resource and dependency caches can be copied into scratch; do not change
   another checkout's caches. A version label does not identify an engine binary.
   For release parity, use the engine archive named in `components.json` and
   verify its size and SHA-256 before extracting it. A locally rebuilt engine
   with the same version can behave differently. The Rust app and frontend must
   come from this checkout.
4. Build an isolated app, replacing `RUN` with the chosen alphanumeric run name:

   ```sh
   CARGO_TARGET_DIR="$SCRATCH/target" pnpm tauri build --debug --bundles app \
     --config '{"productName":"Ondra Check","identifier":"dev.3xhaust.ondra.check-RUN","build":{"beforeBuildCommand":"pnpm build"},"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}'
   ```

   The app is `$SCRATCH/target/debug/bundle/macos/Ondra Check.app`. Its data is
   `~/Library/Application Support/dev.3xhaust.ondra.check-RUN`. The unique bundle
   identifier isolates it even when a background launcher does not inherit
   environment variables. Do not rely on `LSEnvironment` for this isolation.
5. Open that exact `.app`. Inside Ondra use `computer start` with its absolute
   path; do not run its binary or use `open` from a shell. Outside Ondra, open
   this app manually. Never substitute the installed app by name.
6. Complete onboarding without importing unrelated work. The default model
   account uses the user's normal engine login. Choose an already connected
   model account; if none exists, use the app's login flow. The user handles
   macOS permission and keychain dialogs. An agent must not type passwords or
   approve those dialogs.
7. If personal behavior is part of the check, copy only the user-approved
   `agent/AGENT.md` to the isolated app's `agent/AGENT.md`. Do not copy jobs,
   sessions or the user's state. Keep test projects in scratch.
8. Turn off the installed app's Discord agent before enabling the check app's
   Settings → 에이전트 → 디스코드에서 쓰기. Wait for the check app to say
   `메타몽(으)로 연결돼 있어요` (with the configured name). Never start another
   server bot with that token.

## Doctor

The debug build includes `src-tauri/src/devbridge.rs`. It listens on localhost
port 17321 by default and authenticates `POST /eval` with `X-Token`, read from
this check app's `devbridge.token`. Read the token inside the client process;
never print it, put it in command arguments or keep it in proof.

Use this existing bridge to read the actual webview. A request body is JavaScript
statements with a `return`, not an expression-only wrapper:

```js
const i = await window.__TAURI_INTERNALS__.invoke("engine_info");
return { title: document.title, dataDir: i.dataDir, engineVersion: i.engineVersion };
```

Require `Ondra Check`, the isolated data directory and a usable engine. Refuse
an occupied bridge port belonging to another app. The app does not expose its
source commit: record the build command and commit, and rebuild/relaunch after
product changes. `worker_extensions` reports whether a debug app loads extensions
from the checkout instead of its bundle. For a source-loaded extension change,
restart its engine and record the path before rerunning the same input. A
successful build alone is not a Discord check.

## Drive

Use the real controls or the existing debug bridge's DOM actions. Click buttons,
fill inputs and dispatch their normal input/change events. Do not write the
Solid store, call private routing functions or inject fake gateway events.
Native read-only calls can inspect the effects of real actions.

- Settings navigation: button text `에이전트`.
- Bot switch: `[role="switch"][aria-label="디스코드에서 쓰기"]`.
- Status: `.ag-status`; `.ag-status.bad` is a stopped connection.
- Agent view: sidebar `에이전트`; tabs `대화`, `작업`, `루틴`, `기억`.
- Main composer: `textarea[aria-label="메시지"]`; submit `보내기`.

Discord messages must come from its real signed-in client, as the user would
send them. Use the authorized server and channel only. Do not send through a
bot API and claim it tested the owner-input path. In Ondra, `computer` can drive
the native Discord app and `browser-use` can drive the signed-in web client.
The check app must remain running while Discord is driven: stopping the
computer session that launched the check app also closes it. Use a separate
operator/session for Discord, or the browser. Outside Ondra, a person can drive
both apps while the debug bridge observes the check app.

Start with [the feature map](features/README.md). Use one unique marker per
check. Observe before retrying a send: a timeout is an unknown outcome, not
permission to post it again. Missing model output is not a pass.

## Proof

Keep the input and its resulting Discord message/reaction, plus the matching
agent-view result or a filtered read of the isolated app's state. Screenshots
must show the result, not only a connected badge. Filter out credentials and
unrelated conversation. Keep private captures local; do not post them to the
server or PR without permission.

Report separately: what the real model did, what the transport delivered, and
what could not be exercised. Unit tests do not replace this proof.

## Cleanup

1. Disable the check app's bot and confirm its disconnected state.
2. Restore the installed bot to its recorded on/off setting, only after the
   check connection has stopped.
3. Stop the check app through the tool/session that opened it. Leave a Discord
   app that was already open running. Stop only this run's servers by saved PID.
4. Preserve proof. Keep scratch until its logs are no longer needed; never
   remove the user's data, credentials, messages or project files as cleanup.

## Limits

This skill covers the Discord-facing areas below, not every Ondra feature.
Real third-party conversation isolation needs an authorized second account.
Merge/discard and destructive Discord actions need separate authorization;
read-only or harmless questions do not prove those actions. A blocked keychain
prompt, missing login or inaccessible window is an unverified check.
