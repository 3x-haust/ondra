---
name: qa
description: >
  QA an app by using it like its users: web, iOS/Android or desktop (앱·웹
  화면 QA, "QA 해줘", "다 눌러봐", "버그 찾아줘", "출시 전에 점검", "완벽하게 테스트",
  검수, dogfood, bug hunt, smoke test, find bugs, test the whole app). Scope from a diff,
  a feature or the screen map; a risk-ordered plan; fast sweeps; confirmed issues
  with evidence; report-only or fix until no P1/P2 remain; a visual report.
---

# QA

Use the app the way its users will, find what is broken, prove each problem,
then report it, or fix it until nothing serious is left.

Built from gstack's `/qa` and `/qa-only` (Garry Tan), agent-browser's
`dogfood`, Anthropic's `webapp-testing`, the Test Heuristics Cheat Sheet
(Hendrickson, Lyndsay, Emery), Bach's HTSM, Whittaker's tours and W3C Easy Checks.

This skill decides *what* to test and how to report it. *How* to drive each
surface is in the other skills; read the one you need, don't repeat it:
web → `browser-use`, iOS/Android → `device-use`, a Mac app → `computer-use`,
tests → `test-ci`, the fix loop → `goal-loop`, blocks → `visual-report`.

## 0. Mode and safety

- **Report-only** (default): "QA 해줘", "점검", "버그 찾아줘", "다 눌러봐",
  "확인해 봐". Change no product code or tests; write only notes and evidence.
- **Fix**: the user asked for a fix or a finish ("고쳐줘", "고쳐서", "완벽하게",
  "출시할 수 있게", "될 때까지"). Go through §6 after the first pass.
- Ask nothing unless truly blocked: no way to run the app, a login only the
  user has, or a device you may not touch. Everything else, decide and say so
  in the report.
- **Never** use real customers' accounts, payments or production data. Use
  test accounts, seed data, a guest session, or mock the request (§3). A
  `localhost` that talks to a production API is production.
- No destructive or outward actions on shared environments (delete, send,
  publish, pay, invite): skip them, or `ask` first (`browser-use` rule 8).
- Never type, paste or print a password: keychain sign-in or the user signs in
  (`browser-use` rule 4). Never screenshot a visible password or token.

## 1. Scope

Work out what to cover from the request, without asking:

- **A diff or branch**: `git diff --name-only <base>...HEAD` plus uncommitted
  files. Map each file to the screens that render it: routes and views
  directly; a shared component or hook → `grep` its importers up to the
  screens; an API handler → the screens that call it; styles/tokens → every
  screen that uses them. Changed screens plus one step around them (the screen
  before and after in the flow).
- **A feature**: its entry points (route, menu item, button, deep link,
  notification) and everything it reads and writes.
- **The whole app**: build the screen map from code, not by wandering. Where
  routes live: Next.js `app/**/page.*` and `pages/`, React Router
  `<Route>`/`createBrowserRouter`, Vue/Nuxt `router`/`pages/`, SvelteKit
  `src/routes`, Expo Router `app/`, React Navigation `*.Screen`, SwiftUI
  `NavigationStack`/`TabView`/`.sheet`, Android nav graph or `NavHost`,
  Flutter `GoRouter`. Apps without URLs (one-window SPAs, desktop): the
  sidebar/tab/menu components, view switches in the root component, dialogs,
  settings tabs, keyboard shortcuts. Add the sitemap and the nav links.
  Dynamic routes: one representative id per template, not every id.

Show it: a `scope` block (in / out) and a `tree` of screens, changed ones
marked `state: "changed"`.

## 2. Plan

A `checklist` block, risk first. For each feature, the **happy path end to
end** comes first (a user reaching their goal); then the axes below. Order by:
what changed > money, data loss and security paths > most-used flows > the rest.
Leave out what doesn't apply (no login → no auth line; one language → no
language line) and name it in "확인 못 한 것" only if it does apply but you
can't run it.

| axis | try |
|---|---|
| states | empty, loading (slow network), error (request fails), one item, many items (long lists, pagination), long and odd text |
| inputs | required/invalid/boundary values, paste, emoji, Korean IME, very long text, special characters, double submit, submit with Enter |
| auth | guest vs signed in, a role without access, expired session mid-action, sign-in redirect back to where you were |
| navigation | refresh on every screen, back/forward, deep link straight in, open in a new tab, a URL with a bad id |
| sizes | web: phone (390×844) and desktop (1440×900), tablet only when targeted; desktop app: its minimum window size (from its config) and a large one; mobile: a small and a large device |
| themes, languages | light and dark; each shipped language, the longest one for overflow |
| a11y | keyboard only (Tab, Enter, Esc), visible focus, labels and names, contrast, 200% text |
| health | console errors, failed requests (4xx/5xx), loads over 3 s, layout jumps |

Inputs, states and per-platform lists to pick from: `references/checklist.md`.

## 3. Running it fast

What makes QA slow is waiting on the app and taking turns, not the clicks.

- **Serve a production build** for wide sweeps: `next build && next start`,
  `vite build && vite preview --strictPort`, the release app/APK. A dev server
  compiles each route on first hit, so a sweep over it reports slowness that
  isn't there and burns minutes. Keep the dev server for the fix loop. Use a
  free port, start it in the background, wait for the port with a deadline,
  stop it at the end.
- **Rules over lists → a unit test.** Route guards, redirects, 404s, role
  checks across many routes: one test over the route list (`test-ci`), then
  open a few representative pages in the browser instead of all of them.
- **Sweep, one line per screen.** `sweep.sh` in this folder opens each path
  in your tab and prints `ok|SLOW|FAIL path  ms  js:n console:n http:n
  (status path…)  [first heading]`, with `BLANK` for an empty screen and
  `hscroll` for sideways scrolling. Set size, theme and login first; loop over
  them (13 screens × 2 sizes × 2 themes takes about a minute on a build):
  ```bash
  for size in 390x844 1440x900; do for theme in light dark; do
    agent-browser set viewport ${size%x*} ${size#*x}; agent-browser set media $theme
    "<this skill's folder>/sweep.sh" http://localhost:4173 / /pricing /login /items/1 | grep -v '^ok'
  done; done
  ```
  Screens without their own URL: steps `label=js:<expression>` that click the
  real nav (`board=js:document.querySelector('[data-nav=board]').click()`).
  Click what users click; debug hooks (`window.__app`) are usually dev-only
  and missing from a build. The heading in `[…]` shows you landed where you meant.
  Then look at the `FAIL` lines only. Noise you have explained (a missing
  favicon, a dev-only asset): `QA_IGNORE='favicon|/@fs/'`, said once in the report.
- **Every page you touch**: read page errors, console and failed requests
  (`agent-browser errors`, `console`, `network requests --status 400-599`),
  not only the pixels. The sweep does this for loads; do it after actions too.
- **Make states instead of waiting for them**: `agent-browser network route
  "**/api/items*" --body '[]'` (empty), `--abort` (error), a big fixture body
  (many items), `set offline on`, `set media dark`, `set device "iPhone 15"`.
  `agent-browser a11y` runs axe on a page; `vitals` gives load numbers.
  Save shots to absolute paths (`$APP_ARTIFACTS_DIR/...`).
- **Screenshots only when something is wrong**, or as before/after proof.
  Read structure (`snapshot -i --delta`, `eval`) to check; look at pixels
  for layout, overflow and theme.
- **Surfaces**: web through `browser-use` (the built-in browser);
  iOS/Android through `device-use` (your own device, `stop` it
  at the end); a Mac app through `computer-use` (one app, one worker at a time).
- **In parallel, by area**: more than ~15 screens or several platforms → up to
  4 subagents, one area each (e.g. 가입·로그인 / 목록·검색 / 결제 / 설정), each
  with its own tab or device. Each task gives the base URL or build, the area's
  plan lines, the viewports, "report-only: no edits", and the issue format of §4
  to return. You merge and dedupe. Not for a Mac app (one app at a time).

## 4. Each issue

Write each one down when you find it (`$APP_ARTIFACTS_DIR/qa/issues.md`), not
at the end: the notes survive an interruption or a handoff.

- **Severity**: **P1** broken core flow, crash, data loss, security or privacy
  exposure; **P2** wrong behaviour with a workaround, a feature broken on one
  viewport/theme/language, a failed request the user feels; **P3** polish:
  copy, alignment, small visual or a11y issues that don't block.
- **Fields**: screen · steps to reproduce (numbered, from a fresh load) ·
  expected vs actual · evidence (shot or recording path, the console line, the
  failing request) · viewport/device · likely source (`path:line` from the
  stack trace, the component that renders the text, a `grep` of the copy).
- **Confirm before reporting**: reproduce once more from a fresh load or a new
  session. It happens only sometimes → say how often (2/5). It doesn't come back
  → leave it out, or list it under "한 번만 보임".
- **Check your own check.** A scripted check that flags something (no focus
  ring, a missing label, a dead shortcut) gets one look at that element
  before it counts: the script may be looking at the wrong thing (focus that
  left the page, a key sent as `Meta+k` where the app reads `Meta+KeyK`).
- **Not a bug**: what the code, docs or the user's spec say is intended; an
  outage of a third party; dev-only warnings that a production build doesn't
  have; the test environment itself (a proxy, a symlinked `node_modules` the
  dev server refuses to serve, a fixture with no backend). Note environment
  problems once, separately.
- **Dedupe**: one root cause = one issue, with every screen it shows on.
- **No padding, no quota.** Three real P2s beat fifteen guesses. Zero issues
  is a valid result when the coverage says what was checked.

Good: "P2 · 장바구니 · 수량에 0 입력 → 저장되고 합계 0원 (기대: 1 이상만) ·
`src/cart/Qty.tsx:41`". Not: "장바구니에 문제가 있을 수 있어요".

## 5. Report-only: finish

Go straight to §7. Don't fix, even small things; the issue list is the result.

## 6. Fix mode: loop until no P1/P2

Follow `goal-loop` with the confirmed P1/P2 repros as the checks. Each round,
most severe first:

1. A regression test that fails for this bug (`test-ci`): unit or integration
   where it can catch it, an e2e step only when smaller tests can't. Pure
   layout bugs: the before shot and a measured check (sizes, overflow) instead.
2. The smallest fix in the source; no refactors on the way.
3. The test passes; the exact repro from §4 now works (after shot, same
   viewport); console and requests are clean.
4. Re-run the plan lines that touch the changed files (§1's mapping again).
   Something that passed now fails → undo and try another fix.

Same issue failing three rounds → stop and rethink (`goal-loop`). P3s: fix
them when the user asked for "완벽하게" and the fix is local; else list them.
When no P1/P2 remain: a fresh production build and a final sweep of the main
flows on phone and desktop. Don't commit, push or open a PR unless the task says so.

## 7. Report

Plain Korean (the user's language), short sentences, no filler ("꼼꼼하게
살펴봤습니다" adds nothing). Blocks (`visual-report`):

- **Coverage**: a `table` of screens or flows × viewports/devices/themes
  (`✓`, `✗ P2`, `–` not run), or a `checklist` of the plan with `done`.
- **Issues**: a `table` — 심각도 · 화면 · 문제 · 재현 · 위치 — P1 first.
  A `shot` for each P1/P2 (the broken state), a `link` `kind: "video"` for
  a flow you recorded.
- **Fixes** (fix mode): a `beforeAfter` per fixed issue on screen, a `tests`
  block for the regression tests, `files` changed.
- **Not covered**: what you didn't or couldn't check and why (no test account,
  no Android image, payment skipped) → the `done` block's `unverified`.
- `done` evidence: only what you really ran — the sweep output file, shots,
  test runs.
