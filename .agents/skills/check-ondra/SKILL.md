---
name: check-ondra
description: >
  Check an explicitly authorized, scratch-packaged Ondra macOS development app:
  secret settings, live job and agent confirmations, and secure computer actions.
  Host manual checks use computer; automated computer evals remain VM-only.
  Draft; a host attempt stopped before secret entry; no complete live pass.
---

# Check Ondra

**DRAFT — host launch and Doctor recorded; feature checks remain blocked.**
Keep this label until a complete native pass includes retained proof and cleanup.
See the [feature map](features/README.md); this is not full-product coverage.

## Verification status

The initial host pass stopped before secret entry: required native permissions
were absent, Secrets navigation failed foreground preservation, observation
returned `NO_WINDOW`, and the bridge timed out. The cause of the interruption
is undetermined. No secure-input outcome or native screenshot was retained.
The development app and server were stopped; no dummy secret was saved.
Later helper changes have build coverage only. Keep run-specific paths, process
IDs and logs in the run's proof record, not in this reusable skill.

## Isolation and prerequisites

- Host manual checks require the user's permission for this development app.
  Use only its absolute scratch `.app` path with `computer.start`; never open
  the installed Ondra by name, execute its binary, or use shell `open`.
  Outside Ondra, an authorized person operates the development copy; no raw
  helper, host-input script or substitute target app is supplied here.
- `AGENTS.md`: computer use "never brings the target app or window in front of
  the user". Preserve the user's front app, window and cursor. Read computer-use.
  Its installed version may predate secure input; a refusal never authorizes
  typing, pasting or pointer fallback into a protected field.
- **Automated computer evals stay VM-only.** `evals/run.mjs` requires
  `kern.hv_vmm_present=1` for computer cases. Host manual permission does not
  waive that guard. Do not run those cases on the host or forge the VM check.
- Use fresh `ONDRA_DATA_DIR`, a free `ONDRA_DEVBRIDGE_PORT`, and a dedicated
  Vite listener matching the executable's compiled `build.devUrl`. Never copy
  state, accounts, auth files, projects or keychains from another installation.
- Data isolation is **not keychain isolation**: `src-tauri/src/secrets.rs`
  reads service `ai.ondra.secret`, account `vault`, shared by development and
  installed apps. Use a unique `CHECK_` name and a public disposable value only.
  Do not overwrite existing names, delete the vault, use personal passwords or
  answer the user's unrelated approval windows. Concurrent vault edits can
  overwrite each other because the native store caches the map; avoid them.
- A live job needs a separately authorized account connected through the UI.
  Do not import one to make coverage pass. Native secure checks additionally
  need permissions and an existing, disposable target, discovered live.
  Missing account, permission or target means blocked, not passed.

## Launch

The preparation record must export `RUN`, `CHECK_APP`, `CHECK_SCRATCH`,
`CHECK_PROOF`, `CHECK_SECRET`, `ONDRA_DATA_DIR`, `ONDRA_DEVBRIDGE_PORT`, and
`CHECK_VITE_PORT`. Scratch contains binaries, app data, PIDs and logs; proof
belongs under `${APP_ARTIFACTS_DIR}/check/$RUN` (or a separate temporary proof
folder when that variable is absent). Do not store credentials in this record.

Use the repo's `pnpm tauri bundle --debug --bundles app --config <config>`
packaging path with a distinct bundle identifier. Include the current helpers,
`app-extensions`, `app-skills` and engine components. Record the Rust source
checkout, helper hashes and engine revision; do not manufacture a checker,
launcher executable or fixture app. Cancellation checks require an engine that
emits `extension_ui_cancel`; the app-side handler alone cannot prove them.

**Environment delivery matters.** `src-tauri/helpers/cuhost.swift`'s native
background launch uses `posix_spawn` with a minimal environment, not the shell's
exports. Do not rely on `LSEnvironment` for that path. The repo's existing debug
`load_env` in `src-tauri/src/lib.rs` reads the `.env` beside the **compiled-in
source checkout** (`CARGO_MANIFEST_DIR/../.env`). For an executable already built
from a scratch checkout, write only these nonsecret settings to that scratch
file, leaving the worktree and installed app untouched:

```sh
printf 'ONDRA_DATA_DIR=%s\nONDRA_DEVBRIDGE_PORT=%s\n' \
  "$ONDRA_DATA_DIR" "$ONDRA_DEVBRIDGE_PORT" > "$CHECK_COMPILED_CHECKOUT/.env"
```

The loader reads the host app's `.env` first and existing variables win. Check
only whether either isolation key conflicts, without printing values; stop if
it does. Do not edit the host file. Other host `.env` settings and the macOS
keychain remain shared: this is not a security sandbox. Keep the compiled
scratch checkout until cleanup. Changing devUrl requires a matching build;
changing a plist or shell variable does not change the compiled URL.

From the current worktree, with both ports free, start only the existing Vite
server (this does not start the native app):

```sh
nohup pnpm dev --host localhost --port "$CHECK_VITE_PORT" --strictPort \
  > "$CHECK_SCRATCH/vite.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$CHECK_SCRATCH/vite-launcher.pid"
```

Within 90 seconds, require HTTP 200 at `http://localhost:$CHECK_VITE_PORT/` and
record `lsof -nP -iTCP:"$CHECK_VITE_PORT" -sTCP:LISTEN` and its listener PID.
Failure ends startup, not an unbounded retry. Verify Info.plist with `plutil
-lint` and the local signature with `codesign --verify --strict`.

Then the operator calls **`computer.start {app: <absolute CHECK_APP path>}`**.
Record its actual opened path, PID, mode and foreground-preservation result.
An authorized human is the non-tool alternative, never a shell launch.
Onboarding must be completed through the UI: `시작하기`, account choice or
`나중에`, optional import/permissions, then `준비됐어요` → `시작하기`.
Skip accounts/imports for settings-only checks. Never fake onboarding state.

## Doctor

After native start, run in the worktree with the recorded run variables:

```sh
node --input-type=module <<'JS'
import { app } from './evals/devbridge.mjs';
const result = await app(`
  if (!window.__TAURI_INTERNALS__ || !window.__ui) throw Error('native UI not ready');
  return {
    info: await window.__ui.native.engineInfo(),
    tools: await window.__ui.native.toolStatus(),
    onboarded: window.__ui.store.state.onboarded === true,
    signedIn: window.__ui.store.state.accounts.some(a => a.providers.length > 0)
  };
`, { tries: 1, timeout: 10000 });
console.log(JSON.stringify(result, null, 2));
if (result?.info?.dataDir !== process.env.ONDRA_DATA_DIR) throw Error('wrong data directory');
if (!result?.info?.enginePath) throw Error('engine missing');
JS
```

Never print `devbridge.token`. Require the bridge listener on this run's port
to belong to the native PID just opened, correct `dataDir`, engine and usable
UI. Require account/permissions only for the areas that need them. The bridge
has no trustworthy source hash: record build provenance and relaunch after
code/helper edits. Repeat Doctor after anything unexpected. Do not continue
on the installed app if this copy fails.

## Drive

Use current `computer` refs for native UI. The repo's existing bridge can also
send ordinary DOM input events/clicks inside this native Tauri window:

```sh
node --input-type=module -e 'import {app} from "./evals/devbridge.mjs"; console.log(JSON.stringify(await app(process.argv[1], {tries:1, timeout:10000}), null, 2));' "$JS"
```

Select a visible, unique role/label, act once, then observe. Snapshot labels,
types and disabled states, never password values. DOM `.value` with `input` /
`change` is permitted only for ordinary fields and the explicitly public dummy
value in the settings recipe; not as a bypass for refused native secure input.
Never call state setters, `tasks.decide`, `extensionUi.event`, secret mutations,
fake RPC events or simulated eval entries as proof of user behavior.

A secure computer check must originate from a genuine UI-submitted job/main
request using this build's bundled tool, helper and confirmation UI. The outer
operator's installed computer tool is not proof that the modified inner tool
works. Keep sessions distinct; never invoke either helper from the shell.

## Proof

Keep area/entry ID, action, expected and observed result, before/after control
snapshots, native tool result, source identity, commands and exit status. For
ordinary UI, inspect a `computer.look` capture of the actual native window.
For sensitive surfaces, retain redacted observations and capture refusal only;
no alternate desktop capture. Plain Vite pages do not prove native behavior.

Use name-only `secrets.json` readback for persistence. Never print auth files,
bridge tokens, keychain contents or real secret values. Do not post approval
details/screenshots to Discord. Delivery accepted does not prove login or
permission granted. Record every unexercised path as blocked/unverified.

## Cleanup

1. Refuse/finish only this run's cards; stop its jobs and their computer sessions.
2. Delete only its unique dummy names through Settings and confirm name-only
   readback. Never clear the vault; deleting a data directory does not clean it.
3. Call outer `computer.stop`, not Command-Q on another app. Stop only the
   recorded Vite launcher/listener PIDs after checking their `ps` identity.
   Never kill by process name. Verify both ports are free.
4. Preserve proof, then remove only run-owned package, data and scratch `.env`.
   If cleanup or keychain access was blocked, keep the name/run record and say
   exactly what remains. Retain proof outside deleted scratch.

## Helpers and sources

No new scripts/harness. Existing driver: `evals/devbridge.mjs` and
`src-tauri/src/devbridge.rs`. Packaging paths: `src-tauri/src/tools.rs` and
`components.rs`. Launch settings: `package.json`, `vite.config.ts`,
`src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` and `engine.rs`.
Area sources are listed in the map. Use app-check-upkeep when behavior changes;
this blocked attempt does not constitute a complete live upkeep pass.
