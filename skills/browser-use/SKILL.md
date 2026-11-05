---
name: browser-use
description: >
  Browser use inside the app with the bundled agent-browser. Use when a worker
  must open a site, check a web app, fill a form, read a page, take screenshots, or
  record proof of a change. Covers the shared browser (your own tab, shared logins),
  signing in from the macOS keychain, live streaming to the app window, recordings
  as evidence, and how to report with visual-report blocks.
---

# Browser use

`agent-browser` and the browser it drives both ship inside the app:
`agent-browser` is already on your `PATH` and its environment is already set.
Never run `agent-browser install`, never use `npx`, never change any
`AGENT_BROWSER_*` variable, and never ask the user to set anything up.

The app keeps **one shared browser** for every job. You get **your own tab** in
it (`AGENT_BROWSER_SESSION`, attached through `AGENT_BROWSER_CDP`, pinned with
`AGENT_BROWSER_PIN_TAB`). Cookies and storage are shared with every other job and
with the user, and they stay across restarts: if the user or another job already
signed in to a site, you are signed in too.

## Before the first command

```bash
agent-browser skills get core      # the official loop: snapshot → act on @ref → re-snapshot
```

Follow that skill for commands. This file only adds the app's rules on top.

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
6. **Close when the leg ends.** `agent-browser close` before your `handoff`. It
   only ends your connection: your tab, and every login, stay for the next leg.
   The app closes your tab when the job ends.
7. **Outward actions need a decision.** Submitting, purchasing, posting or
   sending anything visible to other people goes through an `ask` block first.

## Report

Keep `now` current as you move ("결제 버튼 누르는 중", "결과 확인 중"), and finish
with blocks, not prose: `checklist` of what you verified, `beforeAfter` or `shot`
for screens, `link` for the recording.
