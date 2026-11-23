# Agent cards and secure computer

**Draft; native support and agent routing have not been driven.** The initial
host pass stopped at Secrets navigation without the required native permissions;
no inner job computer session or secure target was reached. The outer app's
successful start does not prove the bundled tool or helper's secure behavior.
Every held secure action requires fresh in-app confirmation, not a model assertion.

## What it has

- `agent-dock` / `agent-job`: configured agent sidebar name, `대화` / `작업`
  tabs, agent-level dock and real agent-owned job thread.
- `secure-fill`: `act` → `{kind:"fill-secret",ref,secret}`; name only, no value.
- `secure-approval`: supported ref-based AX actions on sensitive surfaces.
- `secure-target`: list exact running-app targets, select returned opaque ref,
  resume original app; changed targets must reject held actions.
- `secure-redaction`: no plaintext in observations; sensitive captures refused,
  including after resume. Delivery does not establish login success.

## How a user gets there

- `agent-conversation`: existing authorized agent row → role tab `대화`.
- `agent-work`: same row → `작업` → observed agent-owned job title.
- `native-in-app`: genuine UI-submitted job/main request → real computer
  `start` → observed disposable secure field/surface → confirmation.
- `native-background-agent`: requesting session alive → `targets` with exact
  running app name → `target` with returned ref → `resume` / `stop`.

## Checking it

### Agent entries: gated

This pass does not authorize Discord messages, connecting bots, importing bot
credentials or workflow changes. Without an existing authorized live agent
request, mark both agent entries blocked. Never synthesize `@agent`, state or
RPC. If a separately authorized request exists, open its configured-name row
and actual `대화` tab, use area 2's scoped card action, then check a real job
under `작업`. Require that agent-level card absent from normal main/project
and `내 차례`. An ordinary job pass does not prove agent routing.

### Native secure flow: target discovery pending

Require permissions, authorized account and area 1's dummy. First observe an
existing native app's disposable field/dialog; record app path, window, field
label and safe cancellation route. **No target has been established yet.** Do
not build a target app/harness, use the user's unrelated approval window, or
grant real system access merely to get coverage.

1. Have a real job use this build's computer tool to `start` that app, then
   `observe {full:true}`. Record opened path/PID, background preservation and
   redacted current refs. The outer operator must not run the helper directly.
2. Request `act {input:{kind:"fill-secret",ref,secret}}`, using live ref and
   saved name only. Refuse on the actual Ondra card; require `APPROVAL_DENIED`
   and no delivered operation. Observe before a new request.
3. On a fresh request allow it; require the actual delivery result. Never read
   the value back, count masked characters or claim successful login. If AX
   replacement is refused, report that target's limitation; no key/paste/CDP
   fallback. The modified helper must not answer its own host's approval UI.
4. For an existing disposable approval window, use `targets`, returned `target`
   ref and observation. Each supported ref-based action needs a new card.
   Use safe cancel where possible; a permission-changing final button needs
   approval of that specific side effect, not generic test permission.
5. Safely dismiss a disposable target while its card waits, through an approved
   native path, then answer the held card. Require target-changed refusal and
   no action on another window. Without safe dismissal leave this unverified.
6. Request `look` after sensitive observation and after `resume`; require
   refusal and no new PNG in the job artifacts. Do not bypass with a desktop
   screenshot. Retain redacted outcomes only.
7. End that job's computer session with `stop`. Record real foreground/cursor
   preservation outcomes, not mocked flags. Outer app/session cleanup follows
   SKILL.md. Keep inner and outer sessions distinct.

## Gotchas

The installed outer tool can drive the development Ondra but cannot prove the
new bundled helper's contract by itself. A settings password input is not proof
of native secure AX support. Host manual permission never enables VM-only
computer evals. Follow the installed computer-use foreground restrictions and
the new tool's explicit confirmation contract; never reinterpret a refusal as
a fallback opportunity. Capture refusal persists for the sensitive session.

Sources: `src/views/AgentView.tsx`, `Sidebar.tsx`, `src/state/store.ts`,
`src/engine/extensionUi.ts`, `src/ui/DecisionCard.tsx`, `extensions/computer.ts`,
`extensions/lib/computer-host.ts`, `tests/extensions/computer-secure-input.test.ts`.
