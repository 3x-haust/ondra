---
name: check-ondra
description: >
  Check a scratch-packaged Ondra macOS development app on the host, with the
  owner's permission: secret settings, job confirmation cards (deny, allow,
  per-card cancel) and secure computer input. Host manual checks use the
  computer tool; automated computer evals stay VM-only.
---

# Check Ondra

Covers the secure-input areas in the [feature map](features/README.md), not
the whole product. One live pass of every area there has been run on the host.

## Rules

- Host checks need the owner's permission for this run. Automated computer
  evals stay VM-only: `evals/run.mjs` requires `kern.hv_vmm_present=1`. Host
  permission does not waive that guard.
- `AGENTS.md`: computer use never brings the target app in front of the user.
  Start the development app only with `computer.start` and its absolute `.app`
  path; never `open` or run its binary from the shell. Read computer-use.
- Never print auth files, `devbridge.token`, keychain contents or a secret
  value. Use a run-unique `CHECK_` name with a public disposable value.
- Data is isolated per run (`ONDRA_DATA_DIR`); the keychain vault is not
  (`ai.ondra.secret`/`vault` in `src-tauri/src/secrets.rs`). Never delete or
  overwrite other names, and never clear the vault.
- Other jobs may run their own `Ondra Check.app`. The computer tool keeps one
  background copy per app name under `~/Library/Caches/dev.3xhaust.ondra/
  Applications/`, so give the run's app its own `productName`, and read the
  pid and path that `start` reports.

## Build

Work in `$APP_SCRATCH_DIR`; leave the worktree and the installed app alone.

1. Engine: in the 3xhaustpi checkout under test, run
   `npm run build:binary` in `packages/coding-agent`. Bundling `dist/cli.js`
   directly fails at the first job with `Cannot find module
   './openai-codex.ts' from '/$bunfs/root/pi'`.
2. Copy the worktree without `node_modules`, `.git`, `src-tauri/target` and
   `src-tauri/resources`; symlink `node_modules`. Then, in that copy:
   `ONDRA_ENGINE_DIST=<engine>/packages/coding-agent/dist node scripts/bundle.mjs`.
   Confirm the hash of `src-tauri/resources/engine/ondra-engine` matches
   `dist/pi`.
3. In the copy's `src-tauri/tauri.conf.json` set a run-unique `productName`,
   `build.devUrl` to `http://localhost:$CHECK_VITE_PORT`, and empty
   `beforeDevCommand`/`beforeBuildCommand`/`beforeBundleCommand`.
4. Write `ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT` to the copy's `.env`
   (read by debug `load_env` in `src-tauri/src/lib.rs`; the helper launches
   the app with a minimal environment, so shell exports do not reach it).
   First check that the host's `~/Library/Application Support/
   dev.3xhaust.ondra/.env` sets neither name; existing variables win.
5. `CARGO_TARGET_DIR=$APP_SCRATCH_DIR/target cargo build --manifest-path
   src-tauri/Cargo.toml && ./node_modules/.bin/tauri bundle --debug --bundles app`.
6. Sign like the installed app so macOS gives it the same keychain access and
   privacy permissions. Without this, the vault read waits on a keychain
   question and `toolStatus` reports Accessibility and Screen Recording off.
   Set `CFBundleIdentifier` to `dev.3xhaust.ondra` in the bundle's Info.plist,
   `xattr -cr` the bundle, then `codesign -f -s <the Apple Development identity
   of the installed app> -i dev.3xhaust.ondra <app>`. Check that
   `codesign -d -r- <app>` prints the same designated requirement as
   `/Applications/Ondra.app`. The data directory and bridge port keep it apart
   from the installed app; check that the pids differ.

## Launch

1. Start Vite from the worktree: `pnpm dev --host localhost --port
   "$CHECK_VITE_PORT" --strictPort`, in the background with its pid saved.
   Wait for HTTP 200, at most 90 seconds.
2. `computer.start {app: <absolute .app path>}`. If it reports that the
   launch changed the foreground, start once more.
3. On first launch, finish onboarding through the UI: `시작하기` → `계속` →
   `나중에` (import) → `나중에` (permissions) → `나중에`.

## Doctor

Export both `ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT`, or the bridge client
reads the token of another data directory and reports "not answering".

```sh
node --input-type=module -e 'import {app} from "./evals/devbridge.mjs";
console.log(JSON.stringify(await app(`return {info: await window.__ui.native.engineInfo(),
tools: await window.__ui.native.toolStatus()}`, {tries: 3, timeout: 10000})))'
```

Require: the port's listener (`lsof -iTCP:$PORT -sTCP:LISTEN`) is the pid
`start` reported, `dataDir` is this run's, `enginePath` is the bundled engine,
and `accessibility` and `screenRecording` are true for secure-input areas.

## Drive

Native UI through `computer` refs. The bridge may read the DOM and set the
public dummy value in a password field through an `input` event. Put bridge
JS in a file and pass its path: inline shell quoting breaks easily. Never call
state setters, `tasks.decide`, `extensionUi` handlers or fake RPC events.

Jobs go through `새 작업` with a real request. Poll the bridge for a card
group whose `aria-label` starts with `보안 동작을 허용할까요?`, and read the
job's session file in `$ONDRA_DATA_DIR/sessions` to see the tool call that is
waiting and its result.

## Proof

Keep: screenshots of ordinary UI from `computer.look`, the session excerpt
with each computer call and result, name-only `secrets.json` readback, and a
search of the session files for the dummy value (must find nothing).

## Cleanup

1. Delete the dummy name in Settings › 시크릿 and confirm name-only readback.
2. Close target apps the run opened (Keychain Access: menu `키체인 접근 ›
   키체인 접근 종료`), then `computer.stop` the development app.
3. Stop the Vite pids after checking them with `ps`; never kill by name.
   Confirm both ports are free.

Sources: `evals/devbridge.mjs`, `src-tauri/src/devbridge.rs`,
`scripts/bundle.mjs`, `src-tauri/src/{lib,engine,secrets,tools}.rs`.
