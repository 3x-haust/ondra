# Secure computer

The bundled `computer` tool in a job: `fill-secret` puts a saved secret into a
password field by name, and ref-based actions run on approval screens. Each
held action needs a new card (area 2).

## What it has

- `secure-fill`: `act {kind:"fill-secret", ref, secret:"<NAME>"}` →
  `done (secure-ax), password replacement accepted; its contents were not read back`.
- `secure-limits`: menus, keys and coordinates on a sensitive screen →
  `SECURE_ACTION_UNSUPPORTED`. Use refs.
- `secure-target`: `targets {app:<bundle id>}` lists windows and sheets with
  opaque refs; `target {ref}` picks one; `resume` goes back to the app's
  window. `targets` needs a running session (`start` first) and a bundle ID
  when the name is ambiguous (`AMBIGUOUS_APP`).
- `agent-routing` (not driven): agent conversation and agent-owned jobs need
  an authorized Discord agent; not part of this pass.

## How a user gets there

A job the user starts (area 2, step 1) whose request names the app, the field
and the saved secret name.

## Checking it

1. Open the target: Keychain Access → select `로그인` in the sidebar →
   `항목 추가` → `계속`. The `새로운 암호 항목` sheet has a passwordfield.
   With menus blocked on sensitive screens, the job cannot open this sheet
   itself; open it with the outer `computer` session and leave it open.
2. Tell the job: `start` the running app, `targets` with
   `com.apple.keychainaccess`, `target` the sheet, `fill-secret` the dummy,
   then `취소`, `resume`, `stop`. Never `추가`.
3. Deny the first fill card (expect `APPROVAL_DENIED`, the sheet unchanged),
   allow the retry (expect `secure-ax ... accepted`), allow `취소`.
4. Search the session files for the dummy value: no match.

## Last run

Host: every step above as expected; the sheet was cancelled, nothing added.

Sources: `extensions/computer.ts`, `extensions/lib/computer-host.ts`,
`src-tauri/helpers/cuhost.swift`, `tests/extensions/computer-secure-input.test.ts`.
