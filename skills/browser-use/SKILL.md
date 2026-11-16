---
name: browser-use
description: >
  Browser use: the app's bundled browser, driven with `browse` (ondra-browser
  underneath): light pages, lean looks, one call per step. Use when a
  worker must open a site, check a web app, fill a
  form, read a page, take screenshots, or record proof of a change. Covers the
  shared browser (your own tab, shared logins), signing in from the macOS
  keychain, live streaming to the app window, recordings as evidence, CAPTCHAs
  and canvas apps, Google Docs/Sheets and Gmail in the signed-in browser, and
  how to report with visual-report blocks. Not for a public page you only need
  to read: web_fetch does that.
metadata:
  ondra-commands: '\bondra-browser\b|(^|[\s/])browse\s'
---

# Browser use

The browser is the app's own: `browse` and `ondra-browser` are on your `PATH`
(else `<this skill's folder>/browse`) with their environment set. Never install
another browser tool, never use `npx` for one, never change any `ONDRA_BROWSER_*`
variable, and never ask the user to set anything up.

## The loop: one call per step

```bash
browse open <url>                    # load light, wait until it settles, show the controls
browse do "fill @e3 김철수" "select @e4 Support" "check @e5" "click @e6"
                                     # act in one batch, wait, show what changed (or the new page)
browse read <url>                    # the main content as markdown, in one call
browse read --outline                # long page: headings first, then
browse read --section "Pricing"      #   just the part you need
browse do "click @e9" --read         # act, then read the page it lands on
browse look [-s <css>] [--all]       # more than the folded look shows
```

- **Plan several steps from one look.** Every target you need is in it: put
  them all in one `do`, with the action that ends the step last. Refs stay valid
  on the page; after a navigation the next look has new ones.
- **Read, don't look, for text.** `look` lists controls (`role "name" @ref`,
  menus and footers folded); `read` gives the words. Public pages you only read
  (docs, articles, a README): `web_fetch` needs no browser at all.
- **Never wait for a time** (no `wait <ms>`, no `sleep` for a page to load).
  `open` and `do` already wait for the page to settle. For a specific end state
  put it in the batch: `"wait --text Saved"`,
  `"wait --url **/done"`, `"wait @e5 --state hidden"`.
- **Many items** (lists, tables, pages): one `browse do "eval ..."` or the site's
  own API, and recipes for sites you come back to: `reference.md`.
- **Also in `reference.md`**: canvas, maps and other pixel-only controls; bot
  checks and CAPTCHAs; Google Docs/Sheets, Gmail, Notion and Slack through the
  signed-in page; finding pictures you may use.
- Anything else ondra-browser does works in the same tab, plain
  (`ondra-browser --help` lists them, `ondra-browser <command> --help` for one)
  or inside `browse do`.

**Light by default.** In your tab, images, fonts, media and ad/tracker requests
are blocked and motion is reduced; pages load in a fraction of the time. When the
picture matters (proof for the user, visual QA, a captcha, a control that is only
an icon): `browse shot <file.png>` turns visuals back on and captures, or
`browse visuals on` before you start (it loads the page again, so before filling
a form); `browse visuals off` when done.

## Your tab in the shared browser

The app keeps **one shared browser per space** for every job in it. You get
**your own tab** in it; cookies and storage are shared with every other job in
this space and with the user's browser panel, and they stay across restarts: if
the user or another job in this space already signed in to a site, you are
signed in too. The other space's logins are not here; sign in again rather than
looking for them.

## Rules here

1. **Your own tab, nobody else's.** Start with `browse open <url>`; that opens
   your tab. Never pass `--session` or `--cdp`, never run `close --all`, and
   never switch to a tab you did not open (`tab list` shows other jobs' tabs
   too). A popup your page opens is yours: `ondra-browser tab <tN>` to it, and
   back when done. If your tab was closed (`tab_gone`), `browse open <url>` opens
   a new one by itself; for a plain command, run `ondra-browser tab new <url>`
   and carry on. If it fails with `Failed to read`
   / `no response came back`, the shared browser stopped answering and the app
   restarts it on the same port: wait 10 seconds, then `browse open <url>`
   again. Don't loop on `tab list` or `get url`, and don't pass a `timeout`
   under 60 to browser commands.
2. **Leave the shared state alone.** Never sign out, never `cookies clear` or
   `storage ... clear`, never `cookies get` into files: that would sign out, or
   copy the logins of, every job and the user. To see a local dev server signed
   out, open it on its other host name (`127.0.0.1` for `localhost`, or the
   reverse): it has its own cookies and storage. A live site: ask the user.
3. **The user watches already.** Your tab streams to the app on its own; don't
   run any `stream` command. Keep the `now` line current.
4. **Signing in.** Re-open the page first: you may already be signed in. A login
   form: `ondra-browser auth login <site> --credential-provider keychain
   --no-navigate --url "<login page URL>"`; the keychain fills it, you never see
   the password. Never type, read or print a password yourself. Details and what
   to do when it fails: `reference.md`.
5. **Proof is a picture.** For anything you claim works, save evidence under
   `$APP_ARTIFACTS_DIR` (`browse shot`, a recording): `reference.md`. Never
   screenshot a page while a password is visible in it.
6. **Pictures and videos into a PR:** `"<this skill's folder>/pr-media.sh" <PR>
   files...`, never the comment box by hand: `reference.md`.
7. **Close when the leg ends.** `ondra-browser close` before your `handoff`. It
   only ends your connection: your tab, and every login, stay for the next leg.
   The app closes your tab when the job ends.
8. **Outward actions need a decision.** Submitting, purchasing, posting or
   sending anything visible to other people goes through an `ask` block first.

## Fast loop: fewer turns, smaller pages

What makes a browser agent slow and costly is the number of turns and the size
of what each one reads, not the commands. So: one `do` per step, `read` with
`--section` instead of the whole page, `look -s <css>` instead of `--all`, and no
screenshot together with a look for the same step.

## Report

Keep `now` current as you move ("결제 버튼 누르는 중", "결과 확인 중"), and finish
with blocks, not prose: `checklist` of what you verified, `beforeAfter` or `shot`
for screens, `link` for the recording.
