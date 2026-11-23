# Secret settings

Names live in the run's `secrets.json`; values live in the shared keychain
vault and never return to the page.

## What it has

- `secrets-save`: `이름`, hidden `값`, `추가`; the row shows the name and
  `모든 작업`, toast `<NAME>을(를) 저장했어요`.
- `secrets-delete`: `<NAME> 삭제` → inline `삭제` / `취소`; empty list shows `없어요`.
- `secrets-project` (not driven): `적용 범위`, `.env` and ignore choices; needs
  a disposable project added through the UI.

## How a user gets there

`설정` (sidebar) → `시크릿`. Search (`설정 검색`) and Command-comma also reach
it; they were not driven.

## Checking it

1. `설정` → `시크릿`. The page must answer at once, with the window still
   observable and the bridge answering. A keychain question from macOS must
   not stop the window (fixed: keychain reads run off the main thread).
2. `type` the name into `이름` (native `set-value` does not reach this field).
   Fill `값` through the bridge with the public value:
   `e.value="public-disposable-check-value"; e.dispatchEvent(new Event("input",{bubbles:true}))`.
   Click `추가`; expect the row and the save toast.
3. Name-only readback: `JSON.parse(secrets.json).global.includes(NAME)` is true.
4. Cleanup: `<NAME> 삭제` → `삭제`; expect `없어요` and the readback false.

## Last run

Host, signed like the installed app: saved, read back, deleted, read back
false. Before the fix, an ad-hoc-signed build lost its window on `시크릿`
(`NO_WINDOW`); `sample` showed the main thread in `secret_sync` →
`SecItemCopyMatching`.

Sources: `src/views/SecretsSettings.tsx`, `src-tauri/src/secrets.rs`.
