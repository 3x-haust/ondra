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
links into the description's screenshots section: the one the repo's PR
template has, else a new one in the description's language (`## 화면` or
`## Screenshots`; `--heading` picks another). A rerun adds to its block: earlier pictures stay, and a file with the same name replaces its old one
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

## Pixel-only controls

Canvas editors (slides, whiteboards, image editors), maps, sliders, drag
handles, crop boxes and timelines often have no ref, or a ref that keeps
hitting the wrong spot. Work from a picture there, and only there:

```bash
browse shot "$APP_SCRATCH_DIR/s.png"                  # see where things are
agent-browser screenshot --annotate "$APP_SCRATCH_DIR/a.png"  # refs drawn on, when some exist
agent-browser mouse move 420 315; agent-browser mouse down; agent-browser mouse up        # a click
agent-browser mouse move 240 540; agent-browser mouse down
agent-browser mouse move 410 540 --steps 12; agent-browser mouse up                      # a drag
agent-browser mouse move 600 400; agent-browser mouse wheel 300                         # scroll that spot
```

- Coordinates are the page's CSS pixels. If the picture is wider than
  `window.innerWidth`, divide by `window.devicePixelRatio`.
- Take a new picture after each action that changes the page, before the next
  one. A popup, cookie banner or dialog in the way comes first.
- Two or three misses on the same spot: change approach (the tool's toolbar or
  menu, a keyboard shortcut, the app's own API, zooming in) rather than nudging
  the numbers again.
- Back to refs and `read` as soon as the pixel step is done.

## Bot checks and CAPTCHAs

These guard sites against automation, so the aim is to let the user get on
with their own work, not to defeat them.

- Many clear themselves: a "checking your browser" page usually passes in a few
  seconds. Wait for something of the real page (`browse do "wait --text …"`) or
  open it once more.
- A single "I'm not a robot" checkbox on a site the user is using themselves:
  click it once, as a person would, and look at the result.
- Anything more (picture grids, puzzles, typed letters, audio), or the box
  comes back: the user solves it. Open the page in your tab, then an `ask` as
  for a failed sign-in (rule 4): question "<site>에서 로봇 확인이 나왔어요",
  options "풀었어요" first, then the real alternatives.
- Stay on the visible, honest path: no solving services, no stealth or
  fingerprint tricks, no rotating addresses, no retry loops. A site that keeps
  asking is saying slow down; its API or export is usually the better road.
- Searches through your tab go one at a time, each read before the next: bursts
  of parallel queries are what bring these checks on.

## Google, Notion, Slack and other signed-in apps

The shared browser is often signed in already. Work through the page: never
lift tokens or cookies out of it (no reading a session token from
`localStorage` to build an API client).

- **Several Google accounts**: their URLs carry `/u/<n>/`. Check which account
  is the right one (the account menu, the link the user gave) before reading or
  writing, and keep that `/u/<n>/` in every URL.
- **Google Docs, Sheets, Slides as text**: from a page on docs.google.com, fetch
  the export in `eval` (GET, signed in through the page):
  `fetch("https://docs.google.com/document/d/<id>/export?format=txt", { credentials: "include" }).then(r => r.text())`.
  Sheets: `/spreadsheets/d/<id>/export?format=csv&gid=<gid>`, one sheet at a
  time (the `gid` is in the sheet tab's URL). Slides: `/presentation/d/<id>/export?format=txt`.
  The export holds every row; a long sheet read off the screen holds only the
  rows that have loaded.
- **Gmail**: read threads with `browse read`. To write, open the compose window
  with its fields filled,
  `https://mail.google.com/mail/u/<n>/?view=cm&fs=1&to=<to>&su=<subject>&body=<body>`
  (URL-encoded), and stop at the draft: sending is an `ask` (visual-report,
  "Drafts before they go out").
- **Notion, Slack, Linear and the like**: `browse read` a page or thread
  (scroll for older messages); change things through the page as a user would.
  Posting or sending goes through an `ask` first.

## Finding pictures

- **To look at** (what a thing looks like, design references): an image search
  in your tab (`https://www.google.com/search?udm=2&q=<query>`, or Naver or
  Bing images), then `browse shot`.
- **To use in the user's work**: take it from a source that states a license:
  Wikimedia Commons (`web_fetch "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=<query>&prop=imageinfo&iiprop=url|extmetadata&format=json"`
  gives file URLs with author and license), Unsplash or Pexels under their own
  terms, a company's press kit. Download the original from its page rather than
  a search thumbnail, and keep where it came from and its license next to it
  (`sources.txt`). A search engine's license filter is a hint, not permission.
