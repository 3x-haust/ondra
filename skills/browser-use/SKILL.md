---
name: browser-use
description: >
  Browser use: Aside when the user has it, otherwise the app's bundled
  agent-browser. Use when a worker must open a site, check a web app, fill a
  form, read a page, take screenshots, or record proof of a change. Covers
  choosing the browser, the shared browser (your own tab, shared logins),
  signing in from the macOS keychain, live streaming to the app window, recordings
  as evidence, and how to report with visual-report blocks.
---

# Browser use

## Which browser

1. **Aside, when this space has an account in it.** `$ONDRA_ASIDE_ACCOUNT`
   is the Aside account of the space this job belongs to (company and
   personal each have their own). Check once per job:
   ```bash
   [ -n "$ONDRA_ASIDE_ACCOUNT" ] && command -v aside >/dev/null && aside account list | grep -E "^[* ] *$ONDRA_ASIDE_ACCOUNT[[:space:]]"
   ```
   `signed in` on that row: use Aside, always with
   `--account "$ONDRA_ASIDE_ACCOUNT"`. Never another account, and never
   Aside's active one: it may belong to the other space. No variable, or the
   account isn't signed in: the built-in browser.
2. **Otherwise the built-in browser** (`agent-browser`, the rest of this
   file). Also switch to it when Aside fails twice in a row on the same step,
   or when the user should watch the work live in Ondra's browser panel.

`pr-media.sh` (rule 6) picks between them by itself.

### Working in Aside

- `aside repl --account "$ONDRA_ASIDE_ACCOUNT" "<js>"`: Playwright-style JavaScript in the
  user's browser, 120 s per run, `console.log` to get values back. Read
  `aside guide repl` once before the first run. No AI runs here; never use
  `aside exec` or a bare `aside "<task>"` (Aside's own agent, it spends the
  user's credits) unless the user asks for it.
- Fast loop, Aside style: one run does a whole stretch: `openTab`, the
  actions, the wait for the end state, then print only `snapshot(page).diff`
  (not the whole tree) for the next run. `openTab` and `click` already wait.
- Your tabs only: open them with `openTab(url)` and close them with
  `closeTab(page)` in a `finally`. Never attach to, read or close a tab you
  didn't open (`getTabs`, `listBrowserTabs`, `attachActiveBrowserTab` are the
  user's tabs).
- Its `fs` can't reach outside Aside's folder. To get a file out, print it:
  `console.log("IMG " + (await page.screenshot()).toString("base64"))`, then
  `| sed -n 's/^IMG //p' | base64 -d > "$APP_ARTIFACTS_DIR/after.png"`. To put
  a file in, serve it for a moment on 127.0.0.1 and `fetch` it from the run.
- Signed out of a site in Aside: never type a password. `ask` the user to
  sign in there (name the site and the account), or use the built-in
  browser's keychain sign-in (rule 4) instead.
- Recipes (fast loop 6) can be Aside scripts too: same folder, `.aside.js`.

## The built-in browser

`agent-browser` and the browser it drives both ship inside the app:
`agent-browser` is already on your `PATH` and its environment is already set.
Never run `agent-browser install`, never use `npx`, never change any
`AGENT_BROWSER_*` variable, and never ask the user to set anything up.

The app keeps **one shared browser per space** for every job in it. You get
**your own tab** in it (`AGENT_BROWSER_SESSION`, attached through
`AGENT_BROWSER_CDP`, pinned with `AGENT_BROWSER_PIN_TAB`). Cookies and storage
are shared with every other job in this space and with the user's browser
panel there, and they stay across restarts: if the user or another job in this
space already signed in to a site, you are signed in too. The other space's
logins are not here; sign in again rather than looking for them.

## Before the first command

```bash
agent-browser skills get core      # the official loop: snapshot → act on @ref → re-snapshot
```

Use that skill for the commands. Its loop (snapshot → one action → snapshot)
is the slow way: every step costs a whole turn. Here, work in the fast loop
below; the app's rules after it still hold.

## Fast loop: fewer turns, smaller pages

What makes a browser agent slow is the number of turns, not the commands
(a command takes ~15 ms). Each turn should move as far as it can.

1. **Plan several steps from one look.** When a snapshot already shows every
   target you need, send the actions, a wait for the end state and the next
   look in one call:
   ```bash
   agent-browser batch --bail "fill @e3 김철수" "fill @e4 a@b.c" "click @e5" "wait --url **/done" "snapshot -i --delta"
   ```
   Refs stay valid on the same page; a navigation ends them, so stop the batch
   there, or use `find` locators that need no snapshot and survive navigation:
   `find role button click --name 저장`, `find label 이메일 fill a@b.c`.
2. **Look small.** `snapshot -i --delta` after the first full look: it prints
   only what changed (or `unchanged`). Narrow it with `-s <css>` (one region)
   or `-d <n>` (depth); add `--urls` only when you need links. For an article's
   text, `read`. A screenshot only when the picture is the question (layout,
   proof), never together with a snapshot for the same step.
3. **Wait for a condition, never a time.** `wait --url <glob>`,
   `wait --text <t>`, `wait --fn "<js>"`, `wait <sel> --state hidden`,
   `wait --download <path>`. No `wait <ms>`, no polling with snapshots;
   `open` and `click` already wait for the page.
4. **Read and loop in the page.** Lists, tables, pagination, checks: one
   `eval --stdin` instead of many clicks. No top-level `await`: wrap it,
   ```bash
   agent-browser eval --stdin <<'JS'
   (async () => { const rows = [...document.querySelectorAll("tr")].map(r => r.innerText); return rows.slice(0, 50); })()
   JS
   ```
   Typing and clicking that a page reacts to stay on `fill`/`click` (React
   ignores values set from a script).
5. **Use the site's own API for reading.** Many items or pages: find the call
   the page makes (`network requests --type xhr,fetch --method GET`, then
   `network request <id>`) and call it from the page, where the login already
   is: `eval` with `fetch(url, { credentials: "include" })`, several at once
   with `Promise.all`. GET only; anything that changes data goes through the
   page (and an `ask` when it leaves this machine). Never export cookies or
   tokens to a file for it (no `derive-client`, no `cookies get`).
6. **Reuse what worked.** Recipes for a site live in
   `"$ONDRA_RECIPES_DIR/<domain>/"` (this space's own; the other space keeps its own). Before exploring a
   site, `ls` that folder; a recipe is a `batch` JSON or an `eval` script with
   one comment line on what it does and its inputs. Run it; if it fails, explore
   as usual and fix the recipe. After a flow you'll likely repeat (a dashboard
   query, an upload, a form) worked, save it there. No passwords, tokens or
   personal data in a recipe.

## Rules here

1. **Your own tab, nobody else's.** Start with `agent-browser open <url>`; that
   opens your tab. Never pass `--session`, `--cdp`, `--profile`, `--state`,
   `--restore`, `--headed`, `--auto-connect` or `--provider`, never run
   `close --all`, and never switch to a tab you did not open (`tab list` shows
   other jobs' tabs too). A popup your page opens is yours: `tab <n>` to it, and
   back when done. If a command fails with `tab_gone`, run
   `agent-browser tab new <url>` and carry on.
   If a command fails with `Failed to read` / `no response came back`, the
   shared browser stopped answering and the app restarts it on the same port:
   wait 10 seconds, then `agent-browser open <url>` again. Don't loop on
   `tab list` or `get url`, and don't pass a `timeout` under 60 to browser
   commands. Public pages you only need to read (docs, articles, a README):
   `web_fetch` is faster and never hangs.
2. **Leave the shared state alone.** Never sign out, never `cookies clear` or
   `storage ... clear`, never `state save` / `cookies get` into files: that would
   sign out, or copy the logins of, every job and the user.
3. **The user watches already.** Your tab streams to the app on its own; don't
   run any `stream` command. Keep the `now` line current.
4. **Signing in.** First reload or re-open the page: you may already be signed in.
   If a login form is in front of you, let the keychain fill it:
   ```bash
   agent-browser auth login <site> --credential-provider keychain --no-navigate --url "<login page URL>"
   # several accounts for one site: add --item "<account>"
   # unusual fields: add --username-selector / --password-selector / --submit-selector
   ```
   The password goes from the macOS keychain straight into the page; you never
   see it. macOS may show the user an approval prompt, so say so in `now`
   ("키체인 승인 기다리는 중"). Never type, paste, read or print a password
   yourself: no `fill`/`type`/`keyboard` into a password field, no `get value` or
   `eval` on one, no `auth save`, `--password`, `set credentials`. If it fails
   (nothing saved, the user denied, 2FA, captcha), first `agent-browser open`
   the login page in your tab (the card's "브라우저 열어 로그인" button opens
   the page your tab was last on), then send an `ask` block: question
   "<site> 로그인이 필요해요" (name the site and account/workspace), options
   "로그인했어요" first, then the real alternatives. Don't explain where the
   browser is; the card does. You continue in the same session.
5. **Proof is a picture.** For anything you claim works, save evidence under
   `$APP_ARTIFACTS_DIR`:
   - before/after: `agent-browser screenshot "$APP_ARTIFACTS_DIR/before.png"`,
     then the same for `after.png`, then a `beforeAfter` block.
   - a flow: `agent-browser record start "$APP_ARTIFACTS_DIR/flow.webm"`, do the
     steps, `agent-browser record stop`, then a `link` block with `"kind":"video"`.
     Recording needs ffmpeg; if `record start` fails, fall back to one screenshot
     per step and say so with a `checklist` item `{"label":"녹화 대신 사진","done":true}`.
   Never screenshot a page while a password is visible in it.
6. **Pictures and videos into a PR.** Use `pr-media.sh` in this skill's folder
   (Aside with this space's account when it is signed in, else your tab
   here); don't drive the comment box yourself:
   ```bash
   "<this skill's folder>/pr-media.sh" <PR number|URL> shot1.png flow.mp4   # or --dir <folder>
   ```
   It uploads through the PR page in your tab (nothing gets posted), writes the
   links into the description's `## 화면` section, and replaces its own block
   on a rerun. Look at the pictures yourself first, then check the result with
   `gh pr view <PR> --json body`. Exit code 3 means GitHub isn't signed in in
   the built-in browser (and Aside wasn't there or failed): `ask` the user to sign in to GitHub in the browser panel
   (name the account that opens the PR), then run it again.
7. **Close when the leg ends.** `agent-browser close` before your `handoff`. It
   only ends your connection: your tab, and every login, stay for the next leg.
   The app closes your tab when the job ends.
8. **Outward actions need a decision.** Submitting, purchasing, posting or
   sending anything visible to other people goes through an `ask` block first.

## Report

Keep `now` current as you move ("결제 버튼 누르는 중", "결과 확인 중"), and finish
with blocks, not prose: `checklist` of what you verified, `beforeAfter` or `shot`
for screens, `link` for the recording.
