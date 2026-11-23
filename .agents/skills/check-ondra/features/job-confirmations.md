# Job confirmation cards

**Draft; no live request recorded.** The initial host pass stopped at Secrets
navigation, before saving the required dummy or submitting a job. Doctor's
`signedIn:true` does not prove request delivery or confirmation behavior.
A genuine tool request waits for a real in-app answer; a chat message or full
job permissions does not answer it.

## What it has

- `job-confirm`: `보안 동작을 허용할까요?`, `허용` / `거부`; no `다른 답` input.
- `job-waiting`: waiting/unread job and live card, one consumption per request.
- `job-expiry`: secure confirmations request a 120-second timeout. Expiry,
  cancellation, pause, reload and engine replacement need separate observation.
  An engine with `extension_ui_cancel` support must accompany the app-side
  cancellation handler; an older engine cannot notify it of individual expiry.
- `job-select-input`: related extension cards; not password-entry fixtures.

## How a user gets there

- `job-thread`: sidebar job row → TaskView `.thread-ask`; a dock's
  `.decision-src` breadcrumb also opens the job.
- `main-dock`: sidebar `메인`, cards above the composer.
- `project-dock` (gated): the real job's project → chat dock.
- `my-turn`: `내 차례` opens the one waiting job or its observed menu title.
- `canvas-drawer`: `캔버스` → waiting job node → full card in detail drawer;
  secure cards do not use ordinary inline quick choices.
- `card-keys`: native 1/2 or card group arrows/Enter, only in the intended
  focused pane outside text editing. Direct `decide` is not key-delivery proof.

## Checking it

Preconditions: Doctor, authorized account, area 1's dummy secret and area 3's
observed disposable target. Otherwise record `blocked: no live secure request`.

1. Click `새 작업` (`.sidebar button[aria-label="새 작업"]`), enter a genuine
   request in `textarea#new-task-input`, then its visible `보내기`. Name the
   observed app/field and `CHECK_SECRET`; request fill only, no submit/login or
   permission change. Ask for the actual computer tool and live confirmation.
   Keep the exact prompt as proof. Never invent a target or seed decisions.
2. On the actual card require target/action/name context, no secret value,
   `허용` / `거부`, and no own-answer input. Scope every action by the observed
   job/question, never the first allow button in the document.
3. Visit the listed entry paths before answering, retaining entry-specific
   snapshots. Use a fresh genuine request if 120 seconds expires. Canvas needs
   the actual native node action; without it mark that entry unverified. Project
   paths are blocked when no disposable project exists.
4. First click the scoped `거부`. Require card removal, `APPROVAL_DENIED` and
   no delivered target operation, supported by target observation. On a fresh
   request click `허용`; require one delivery result and consumed card. Card
   disappearance alone does not prove successful target action.
5. On separate genuine requests, observe timeout and job `작업 일시정지`.
   Record card state and absence of delivery; a remaining stale card is a bug,
   not permission to call internal cleanup. Reload/engine replacement remain
   unverified unless actually performed. Do not extend deadlines in state.
6. Check native keyboard entry separately and ensure a text input/different
   pane does not inadvertently answer. The transcript should retain the answer
   label rather than turn the answer into a new chat request.

## Gotchas

Normal conversational cards differ from secure extension cards. Multiple docks
can show the same request; answer it only once. Number shortcuts target the
focused pane's first eligible card. A unit-test fake helper proves neither
macOS secure-field support nor live cancellation. Model/account absence is a
blocker; do not copy credentials or forge RPC to remove it.

Sources: `src/engine/extensionUi.ts`, `tasks.ts`, `src/ui/DecisionCard.tsx`,
`src/views/TaskView.tsx`, `MainView.tsx`, `Sidebar.tsx`, `Canvas.tsx`,
`src/ui/Composer.tsx`, `extensions/computer.ts`.
