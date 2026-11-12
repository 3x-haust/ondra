# browser-use: details

## browse

`browse --help` lists everything. What it does under the hood, so you can reason
about it:

- **open / read <url>**: one agent-browser batch: `open --wait-until
  domcontentloaded` (never waits for the page's last ad or tracker), then a wait
  until the page settles (no DOM change for 300 ms and no fetch/XHR still open,
  at most 4 s; `net.js`, which the app loads into every page of your tab, counts
  those), then the look or the text. A redirect or a navigation that was
  still going is followed before it looks.
- **look**: `snapshot -c`, folded: no images, icons, wrappers or styling nodes;
  each control as `role "name" @ref [state] = value`; runs of links/buttons on
  one line; header/nav/footer/aside runs cut at 8 (`look --all` for all, `look
  -s <css>` for one region); links inside running text gathered per section as
  `in text:`; a control repeated on every item ("Copy", "Reply") shown twice
  with a count; headings down to `###`. On the same page, `do` prints only what
  changed; on another page of the same site, header/nav/footer blocks that are
  as before become one line.
- **read**: the page's main content (article/main, else body) as markdown:
  headings, paragraphs, lists, tables, code. Menus, asides, footers, buttons,
  forms, cookie and share boxes are dropped. `--links` keeps link targets,
  `--max` raises the 12 000-character cut. Web components (shadow DOM) included.
- **Refs**: agent-browser keeps refs across looks on the same page. When a page
  re-renders an element, an old ref still finds the one element with the same
  role and name; if that's ambiguous the command fails, then `browse look`.
- **Light mode**: per tab, once per session daemon: `network route` aborts
  images, media and fonts, and ad/tracker hosts (Google ads and analytics, Amazon
  ads, Criteo, Taboola, Outbrain, Hotjar, Clarity, Segment and similar; no A/B
  tools, whose anti-flicker scripts would hide the page); `set media
  reduced-motion`; CSS animations and transitions made instant. The app's browser
  panel and other jobs' tabs are untouched. `browse visuals on` lifts it all and
  loads the page again (a reload loses what was typed: turn visuals on before
  filling a form you'll capture); `browse shot` does that by itself. State lives
  in `$APP_SCRATCH_DIR/.browse/`.
- Plain `agent-browser` commands still work in the same tab; `browse do` takes
  any of them (`"wait --text Saved"`, `"find role button click --name 저장"`,
  `"upload @e7 a.png"`, `"eval ..."`), or a JSON array for awkward quoting.

## Looping in the page and the site's API

- Lists, tables, pagination, checks: one `browse do "eval ..."` (or
  `agent-browser eval --stdin` with a heredoc) instead of many clicks. No
  top-level `await`: wrap it, `(async () => { ... })()`. Typing and clicking a
  page reacts to stay on `fill`/`click` (React ignores values set from a script).
- Many items or pages: find the call the page makes (`agent-browser network
  requests --type xhr,fetch --method GET`, then `agent-browser network request
  <id>`) and call it from the page, where the login already is: `eval` with
  `fetch(url, { credentials: "include" })`, several at once with `Promise.all`.
  GET only; anything that changes data goes through the page (and an `ask` when
  it leaves this machine). Never export cookies or tokens to a file for it (no
  `derive-client`, no `cookies get`).

## Recipes

Recipes for a site live in `"$ONDRA_RECIPES_DIR/<domain>/"` (this space's own;
the other space keeps its own). Before exploring a site, `ls` that folder; a
recipe is a `browse do` line, a `batch` JSON or an `eval` script with one comment
line on what it does and its inputs. Run it; if it fails, explore as usual and
fix the recipe. After a flow you'll likely repeat (a dashboard query, an upload,
a form) worked, save it there. No passwords, tokens or personal data in a recipe.

## Signing in (rule 4)

First reload or re-open the page: you may already be signed in. If a login form
is in front of you, let the keychain fill it:

```bash
agent-browser auth login <site> --credential-provider keychain --no-navigate --url "<login page URL>"
# several accounts for one site: add --item "<account>"
# unusual fields: add --username-selector / --password-selector / --submit-selector
```

The password goes from the macOS keychain straight into the page; you never see
it. macOS may show the user an approval prompt, so say so in `now` ("키체인 승인
기다리는 중"). Never type, paste, read or print a password yourself: no
`fill`/`type`/`keyboard` into a password field, no `get value` or `eval` on one,
no `auth save`, `--password`, `set credentials`. If it fails (nothing saved, the
user denied, 2FA, captcha), first `browse open` the login page in your tab (the
card's "브라우저 열어 로그인" button opens the page your tab was last on), then
send an `ask` block: question "<site> 로그인이 필요해요" (name the site and
account/workspace), options "로그인했어요" first, then the real alternatives.
Don't explain where the browser is; the card does. You continue in the same
session.

## Proof (rule 5)

- before/after: `browse shot "$APP_ARTIFACTS_DIR/before.png"`, then the same for
  `after.png`, then a `beforeAfter` block.
- a flow: `browse visuals on`, `agent-browser record start
  "$APP_ARTIFACTS_DIR/flow.webm"`, do the steps, `agent-browser record stop`, then
  a `link` block with `"kind":"video"`. Recording needs ffmpeg; if `record start`
  fails, fall back to one `browse shot` per step and say so with a `checklist`
  item `{"label":"녹화 대신 사진","done":true}`.

Never screenshot a page while a password is visible in it.

## Pictures and videos into a PR (rule 6)

Use `pr-media.sh` in this skill's folder; don't drive the comment box yourself:

```bash
"<this skill's folder>/pr-media.sh" <PR number|URL> shot1.png flow.mp4   # or --dir <folder>
```

It uploads through the PR page in your tab (nothing gets posted) and writes the
links into the description's `## 화면` section. A rerun adds to its block:
earlier pictures stay, and a file with the same name replaces its old one
(`--replace` only when the user wants the old pictures gone). Look at the
pictures yourself first, then check the result with `gh pr view <PR> --json
body`. The same script posts pictures with words where a reviewer reads them:

```bash
pr-media.sh --comment "고친 뒤 화면이에요" <PR> after.png            # a PR comment
pr-media.sh --reply <review comment id> "이렇게 바꿨어요" <PR> a.png  # answer in that review thread
pr-media.sh --at src/App.tsx:42 "이 줄이 이 화면을 만들어요" <PR> a.png  # on one line of the change
```

Review comment ids come from `gh api repos/<o>/<r>/pulls/<n>/comments --jq
'.[]|{id,path,line,body}'`. A comment notifies people: post one only when the
user asked, or when the job is answering that PR's review (each fixed point gets
its reply, with the before/after picture when the change shows on screen). Exit
code 3 means GitHub isn't signed in in the built-in browser: `ask` the user to
sign in to GitHub in the browser panel (name
the account that opens the PR), then run it again.
