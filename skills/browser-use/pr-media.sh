#!/bin/bash
# Put pictures and videos into a PR description's screenshots section: the one the
# repo's PR template already has ("## Screenshots", "## 화면" …), else a new one in
# the description's language ("## 화면" when it is Korean, "## Screenshots" otherwise).
# The files go up through the PR page's comment box in a browser signed in to
# GitHub; the comment is never sent. GitHub hands back user-attachments links,
# and gh writes them into the description. No AI in between.
# The browser: Ondra's shared browser (your own tab). Sign in to GitHub in
# the browser panel before uploading.
#
#   pr-media.sh <PR number|URL> file...       # inside the repo folder a number is enough
#   pr-media.sh <PR> --dir <folder>           # every png/jpg/gif/webp/mp4/mov in the folder
#   pr-media.sh --print <PR> file...          # upload, print the block, leave the description
#   --comment "text" <PR> file...             # post them as a PR comment under that text instead
#   --reply <comment id> "text" <PR> file...  # reply in a review thread (an inline comment's id)
#   --at <path:line> "text" <PR> file...      # a new review comment on that line of the PR's head
#   --via browser                            # Ondra's shared browser (the default)
#   --heading "## Demo"                       # the section to use or add (default: as above)
#
# Running it again adds to the block it put in (<!-- pr-media --> … <!-- /pr-media -->): earlier
# pictures stay, a file with the same name replaces its old picture. --replace starts the block over.
# Pictures sit side by side at 300px; each video gets its own player.
set -euo pipefail

PRINT=0; PR=""; FILES=(); VIA=browser; REPLACE=0; MODE=body; TEXT=""; REPLY=""; AT=""
HEADING=""
while (($#)); do
  case $1 in
    --print) PRINT=1 ;;
    --replace) REPLACE=1 ;;
    --comment) MODE=comment; shift; TEXT=$1 ;;
    --reply) MODE=reply; shift; REPLY=$1; shift; TEXT=$1 ;;
    --at) MODE=at; shift; AT=$1; shift; TEXT=$1 ;;
    --via) shift; VIA=$1 ;;
    --heading) shift; HEADING=$1 ;;
    --dir)
      shift
      while IFS= read -r f; do FILES+=("$f"); done < <(find "$1" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.webp' -o -iname '*.mp4' -o -iname '*.mov' \) | sort)
      ;;
    -h|--help) sed -n 2,23p "$0"; exit 0 ;;
    *) if [[ -z $PR ]]; then PR=$1; else FILES+=("$1"); fi ;;
  esac
  shift
done
[[ -n $PR && ${#FILES[@]} -gt 0 ]] || { sed -n 2,20p "$0"; exit 1; }
[[ $VIA == browser ]] || { echo "--via supports only browser." >&2; exit 1; }
[[ $MODE != at || $AT == *:* ]] || { echo "--at needs <path:line>" >&2; exit 1; }
ABS=()
for f in "${FILES[@]}"; do
  [[ -f $f ]] || { echo "no such file: $f" >&2; exit 1; }
  case "$(echo "${f##*.}" | tr '[:upper:]' '[:lower:]')" in
    png|jpg|jpeg|gif|webp|mp4|mov) ;;
    *) echo "not a picture or video (png, jpg, gif, webp, mp4, mov): $f" >&2; exit 1 ;;
  esac
  ABS+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
  (($(stat -f %z "$f") <= 10485760)) || echo "warning: over 10MB, GitHub may refuse it: $(basename "$f")" >&2
done

URL=$(gh pr view "$PR" --json url -q .url)
echo "PR: $URL / ${#ABS[@]} file(s)"

ab() { agent-browser "$@"; }
# eval prints its result as JSON: a string comes back as plain text, anything else as JSON
# a failed eval prints nothing instead of ending the script
js() { local o; o=$(ab eval "$1" 2>/dev/null) || o=""; printf '%s\n' "$o" | tail -1 | python3 -c 'import json,sys
t = sys.stdin.read().strip()
try: v = json.loads(t)
except Exception: v = t
print(v if isinstance(v, str) else json.dumps(v))'; }

# Ondra's shared browser: your own tab, the login the user made in the browser panel.
via_browser() {

  # your tab may be gone (closed, or the browser restarted): then a new one
  ab open "$URL" --wait-until domcontentloaded >/dev/null 2>&1 || ab tab new "$URL" >/dev/null
  # GitHub never goes network-idle: wait for the comment box (or the sign-in link) instead
  ab wait --fn "!!(document.querySelector('textarea') || document.querySelector('a[href*=\"/login\"]'))" >/dev/null 2>&1 || true

  # Find the comment box and its file input, whatever GitHub calls them today, and mark them.
  FOUND=$(js "(() => {
    const box = document.querySelector('#new_comment_field') || document.querySelector('textarea[name=\"comment[body]\"]') || [...document.querySelectorAll('textarea')].find(t => /comment/i.test(t.placeholder || t.getAttribute('aria-label') || ''));
    if (!box) return document.querySelector('a[href*=\"/login\"]') ? 'signed-out' : 'no-box';
    const form = box.closest('form') || document;
    const input = document.querySelector('#fc-new_comment_field') || form.querySelector('input[type=file]');
    if (!input) return 'no-input';
    box.setAttribute('data-ondra-box', '1');
    input.setAttribute('data-ondra-upload', '1');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()")
  case $FOUND in
    ok) ;;
    signed-out) return 3 ;;
    *) echo "Couldn't find the comment box on $URL ($FOUND)." >&2; return 1 ;;
  esac

  ab upload '[data-ondra-upload]' "${ABS[@]}" >/dev/null

  COUNT_JS="(() => { const v = document.querySelector('[data-ondra-box]').value; const n = (v.match(/https:\\/\\/github\\.com\\/user-attachments\\/[^\\s\"<>)]+/g) || []).length; return /Uploading/.test(v) ? -1 : n; })()"
  for ((t = 0; t < 120; t++)); do
    n=$(js "$COUNT_JS")
    [[ $n == "${#ABS[@]}" ]] && break
    sleep 1
  done
  LINKS=$(js "JSON.stringify(document.querySelector('[data-ondra-box]').value.match(/https:\\/\\/github\\.com\\/user-attachments\\/[^\\s\"<>)]+/g) || [])")
  # leave the box empty: nothing gets posted
  js "(() => { const b = document.querySelector('[data-ondra-box]'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()" >/dev/null
}

LINKS=""
echo "via Ondra's browser"
rc=0; via_browser || rc=$?
if ((rc == 3)); then
  echo "GitHub is not signed in in Ondra's browser. Ask the user to sign in to GitHub (the account that opens PRs) in the browser panel, then run this again." >&2; exit 3
elif ((rc)); then
  exit 1
fi

BLOCK=$(LINKS="$LINKS" python3 - "${ABS[@]}" <<'EOF'
import html, json, os, sys
urls = json.loads(os.environ["LINKS"] or "[]")
files = sys.argv[1:]
if len(urls) != len(files):
    sys.exit(f"uploaded {len(urls)} of {len(files)}; run it again")
imgs, vids = [], []
for f, u in zip(files, urls):
    stem = os.path.splitext(os.path.basename(f))[0]
    if f.lower().endswith((".mp4", ".mov")):
        vids.append(f"`{stem}`\n\n{u}")
    else:
        imgs.append(f'<img width="300" alt="{html.escape(stem)}" src="{u}" />')
parts = (["\n".join(imgs)] if imgs else []) + vids
print("<!-- pr-media -->\n" + "\n\n".join(parts) + "\n<!-- /pr-media -->")
EOF
)

if ((PRINT)); then printf '%s\n' "$BLOCK"; exit 0; fi

# a comment, a reply in a review thread, or a comment on one line: the text, then the pictures
if [[ $MODE != body ]]; then
  MSG=$(printf '%s\n\n%s\n' "$TEXT" "$BLOCK")
  BASE_REPO=$(sed -E 's#https://github.com/([^/]+/[^/]+)/pull/.*#\1#' <<<"$URL")
  N=${URL##*/}
  case $MODE in
    comment) gh pr comment "$URL" --body "$MSG" >/dev/null ;;
    reply) gh api "repos/$BASE_REPO/pulls/$N/comments/$REPLY/replies" -f body="$MSG" --jq .html_url ;;
    at)
      SHA=$(gh pr view "$URL" --json headRefOid -q .headRefOid)
      gh api "repos/$BASE_REPO/pulls/$N/comments" -f body="$MSG" -f commit_id="$SHA" -f path="${AT%:*}" -F line="${AT##*:}" -f side=RIGHT --jq .html_url ;;
  esac
  echo "posted on $URL (${#ABS[@]} file(s))"
  exit 0
fi

BODY=$(gh pr view "$URL" --json body -q .body)
NEW=$(BLOCK="$BLOCK" REPLACE="$REPLACE" HEADING="$HEADING" python3 -c '
import os, re, sys
body, block = sys.stdin.read(), os.environ["BLOCK"]

def items(b):
    imgs = re.findall(r"<img[^>]*?alt=\"([^\"]*)\"[^>]*/>", b)
    tags = re.findall(r"<img[^>]*/>", b)
    vids = re.findall(r"`([^`]+)`\n\n(https://\S+)", b)
    return list(zip(imgs, tags)), vids

old = re.search(r"<!-- pr-media -->.*?<!-- /pr-media -->", body, flags=re.S)
if old and os.environ["REPLACE"] != "1":
    # keep what was there; a file with the same name takes its old place
    oi, ov = items(old.group(0))
    ni, nv = items(block)
    names = {n for n, _ in ni} | {n for n, _ in nv}
    imgs = [t for n, t in oi if n not in names] + [t for _, t in ni]
    vids = [f"`{n}`\n\n{u}" for n, u in ov if n not in names] + [f"`{n}`\n\n{u}" for n, u in nv]
    parts = (["\n".join(imgs)] if imgs else []) + vids
    block = "<!-- pr-media -->\n" + "\n\n".join(parts) + "\n<!-- /pr-media -->"
if old:
    body = re.sub(r"<!-- pr-media -->.*?<!-- /pr-media -->", lambda m: block, body, flags=re.S)
else:
    want = os.environ.get("HEADING", "").strip()
    if want:
        pat = r"^" + re.escape(want) + r"[ \t]*$"
    else:
        # a section the PR template already has
        pat = r"^#{2,3}[ \t]+(화면|스크린샷|Screenshots?|Screen ?shots?|Screen recordings?|Demo|Visuals?|Media)\b[^\n]*$"
    found = re.search(pat, body, flags=re.M | re.I)
    if found:
        at = found.end()
        body = body[:at] + "\n\n" + block + "\n" + body[at:]
    else:
        heading = want or ("## 화면" if re.search(r"[\uac00-\ud7a3]", body) else "## Screenshots")
        body = body.rstrip() + "\n\n" + heading + "\n\n" + block + "\n"
print(body, end="")' <<<"$BODY")
gh pr edit "$URL" --body "$NEW" >/dev/null
echo "added to $URL (${#ABS[@]} file(s))"
