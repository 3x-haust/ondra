# Secret settings

**Draft; entry attempted, blocked before input/save.** Names are stored in the
run's data directory; values use the host's shared keychain, never return to the
page. The initial host pass opened Settings through the ordinary bridge DOM
click after native `NO_BOUNDS`. Clicking Secrets natively failed foreground
preservation; observation returned `NO_WINDOW`, then the bridge timed out. No
password entry, save, persistence or deletion was exercised, and no screenshot
was retained. Cause remains undetermined; see SKILL.md's verification status.

## What it has

- `secrets-global`: `전체` groups equal values; global saves show `모든 작업`.
- `secrets-save`: `이름`, hidden `값`, `추가`; saved names, cleared inputs, toast.
- `secrets-delete`: name-specific deletion, inline `삭제` / `취소`; grouped
  deletion can affect several locations.
- `secrets-project` (gated): `적용 범위`, `.env`, ignore warning and its
  `.gitignore에 추가` / `.env 빼고 저장` choices.
- `secrets-remote` (outside this pass): another Mac keeps its own project secrets.

## How a user gets there

Record each separately: `settings-sidebar` (`설정` → `시크릿`),
`settings-search` (`설정 검색` → `시크릿` result), `settings-shortcut`
(default Command-comma, then `시크릿`). Honor actual shortcut overrides;
use native computer key delivery or an authorized person, not synthetic DOM keys.

## Checking it

After Doctor, with no imported projects and a fresh `CHECK_SECRET`:

1. Click `.sidebar button[data-shortcut=settings]`, then visible `button.set-nav`
   whose `.sb-title` is `시크릿`, or their current native refs. Require one match.
2. Enter the unique name in `input[aria-label=이름]`. For this public dummy only,
   the existing bridge may fill the settings password input through its UI event:
   ```sh
   JS='const e=document.querySelector("input[type=password][aria-label=값]");if(!e)throw Error("value field missing");e.value="public-disposable-check-value";e.dispatchEvent(new Event("input",{bubbles:true}));return {entered:true,type:e.type};'
   ```
   Never use this route for real passwords or to bypass a native secure refusal.
   Click `form.sec-add button[type=submit]`; require the name row and save toast,
   not a replacement toast (a replacement means the name was not unique).
3. Read only booleans/names: `.sec-key` text and whether non-checkbox form inputs
   are empty. Independently check persistence without dumping values:
   ```sh
   node --input-type=module -e 'import{readFileSync}from"node:fs";import{join}from"node:path";const s=JSON.parse(readFileSync(join(process.env.ONDRA_DATA_DIR,"secrets.json"),"utf8"));console.log({saved:s.global.includes(process.env.CHECK_SECRET)});'
   ```
   Leave/reopen the page, and later relaunch this same development copy; require
   the name retained and the value input empty. Record each action actually done.
4. Exercise settings search with `input[aria-label="설정 검색"]` and the visible
   matching `button.set-hit`; clear search afterward. Record the native shortcut
   entry separately. Missing native key delivery stays unverified.
5. Click the exact `CHECK_SECRET + " 삭제"` control, then row-scoped `취소`;
   require the row remains. Reopen, click its `삭제`, require row disappearance
   and the same independent readback returning `saved:false`.
6. Project branch only with a disposable project added through UI: choose its
   real `적용 범위` option, use another unique name and exercise both ignore
   warning choices. Confirm the specific dummy key's `.env` side effect or its
   absence without dumping values. No project means this branch is blocked.

## Gotchas

Use `CHECK_`, not reserved `ONDRA_` / `PI_`. Opening this page imports existing
project `.env` entries; do not add personal projects. Never delete a grouped
row without inspecting its locations. `ONDRA_DATA_DIR` does not isolate
`ai.ondra.secret/vault`; a keychain-access prompt is a separate sensitive action,
not blanket permission from this recipe. Do not overwrite the vault or edit it
concurrently from another Ondra copy. Remove only this run's names through UI.

Sources: `src/views/SecretsSettings.tsx`, `Settings.tsx`, `Sidebar.tsx`,
`src/lib/shortcuts.ts`, `src-tauri/src/secrets.rs`.
