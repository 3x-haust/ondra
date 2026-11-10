# Aside (opt-in)

Aside is the user's own browser app. Use it only when the user asks for Aside, or
when a site needs their signed-in Aside session and the built-in browser can't sign
in (the keychain sign-in failed and the user would rather not sign in again). Back
to the built-in browser when Aside fails twice in a row on the same step.

## Which account

`$ONDRA_ASIDE_ACCOUNT` is the Aside account of this job's space (company and
personal each have their own). Check once:

```bash
[ -n "$ONDRA_ASIDE_ACCOUNT" ] && command -v aside >/dev/null && aside account list | grep -E "^[* ] *$ONDRA_ASIDE_ACCOUNT[[:space:]]"
```

`signed in` on that row: use it, always with `--account "$ONDRA_ASIDE_ACCOUNT"`.
Never another account, and never Aside's active one: it may belong to the other
space. No variable, or not signed in: no Aside.

## Working in it

- `aside repl --account "$ONDRA_ASIDE_ACCOUNT" "<js>"`: Playwright-style JavaScript
  in the user's browser, 120 s per run, `console.log` to get values back. Read
  `aside guide repl` once before the first run. No AI runs here; never use
  `aside exec` or a bare `aside "<task>"` (Aside's own agent, it spends the
  user's credits) unless the user asks for it.
- One run does a whole stretch: `openTab`, the actions, the wait for the end
  state, then print only `snapshot(page).diff` (not the whole tree) for the next
  run. `openTab` and `click` already wait.
- Your tabs only: open them with `openTab(url)` and close them with
  `closeTab(page)` in a `finally`. Never attach to, read or close a tab you
  didn't open (`getTabs`, `listBrowserTabs`, `attachActiveBrowserTab` are the
  user's tabs).
- Its `fs` can't reach outside Aside's folder. To get a file out, print it:
  `console.log("IMG " + (await page.screenshot()).toString("base64"))`, then
  `| sed -n 's/^IMG //p' | base64 -d > "$APP_ARTIFACTS_DIR/after.png"`. To put
  a file in, serve it for a moment on 127.0.0.1 and `fetch` it from the run.
- Signed out of a site in Aside: never type a password. `ask` the user to sign
  in there (name the site and the account), or use the built-in browser's
  keychain sign-in instead.
- Recipes can be Aside scripts too: same folder, `.aside.js`.
