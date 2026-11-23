# Job confirmation cards

A held secure computer action shows `보안 동작을 허용할까요? — <bundle id> ·
<window> · <control> · <action>` with `허용` / `거부`. The card never shows a
secret value. It waits 120 seconds.

## What it has

- `job-deny`: `거부` → the tool gets `APPROVAL_DENIED: nothing was sent`.
- `job-allow`: `허용` → the action runs once; the answer stays in the thread.
- `job-retry`: after a denial the job may ask once more with a new card.
- `job-cancel-one`: pausing one job removes only that job's card.
- `job-timeout`: an unanswered card disappears after 120 s on its own and the
  tool gets `APPROVAL_DENIED`. This needs an engine that sends
  `extension_ui_cancel` (3xhaustpi PR #33); older engines leave the card.

## How a user gets there

- `job-thread`: the job's row in the sidebar → card above its composer.
- `main-dock`: `메인` → cards above the composer, each with its job's breadcrumb.
- `my-turn`: the `내 차례` count includes waiting cards.

## Checking it

1. `새 작업` → a request that makes the job use `computer` on a real app
   (Keychain Access works: `/System/Library/CoreServices/Applications/
   Keychain Access.app`). `보내기`.
2. On the card, `거부`. Expect the card gone, `거부` in the thread, and
   `APPROVAL_DENIED` in the session file. Then `허용` on the next card and
   expect a `done` result.
3. Two cancel jobs: start A and B, each asking one click and to stop on denial.
   With both cards on `메인`, open A and send `/pause` from its composer (the
   `더 보기` menu needs the foreground). Expect A `일시정지`, only B's card left
   on `메인`. Leave B: its card disappears about 120 s after it appeared, and B's
   session shows `APPROVAL_DENIED` then `stop`.

## Last run

Host, engine `fix/rpc-extension-ui-cancel` built with `build:binary`: deny,
retry, allow, and pause-one/timeout-other all behaved as above.

Sources: `src/engine/extensionUi.ts`, `src/engine/tasks.ts`,
`src/ui/DecisionCard.tsx`, `src/views/TaskView.tsx`, `src/views/MainView.tsx`.
