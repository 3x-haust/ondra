#!/bin/bash
# Put pictures and videos into a PR description's "## 화면" section.
# The files go up through the PR page's comment box in a browser signed in to
# GitHub; the comment is never sent. GitHub hands back user-attachments links,
# and gh writes them into the description. No AI in between.
# The browser: Aside (aside repl, no AI) when it is installed and signed in,
# otherwise Ondra's shared browser (your own tab). Aside failing falls back too.
#
#   pr-media.sh <PR number|URL> file...       # inside the repo folder a number is enough
#   pr-media.sh <PR> --dir <folder>           # every png/jpg/gif/webp/mp4/mov in the folder
#   pr-media.sh --print <PR> file...          # upload, print the block, leave the description
#   --account <id>                            # Aside account (default: Aside's active one)
#   --via aside|browser                       # force one browser
#
# Running it again replaces only the block it put in (<!-- pr-media --> … <!-- /pr-media -->).
# Pictures sit side by side at 300px; each video gets its own player.
set -euo pipefail

PRINT=0; PR=""; FILES=(); ACCOUNT=""; VIA=""
while (($#)); do
  case $1 in
    --print) PRINT=1 ;;
    --account) shift; ACCOUNT=$1 ;;
    --via) shift; VIA=$1 ;;
    --dir)
      shift
      while IFS= read -r f; do FILES+=("$f"); done < <(find "$1" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.webp' -o -iname '*.mp4' -o -iname '*.mov' \) | sort)
      ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) if [[ -z $PR ]]; then PR=$1; else FILES+=("$1"); fi ;;
  esac
  shift
done
[[ -n $PR && ${#FILES[@]} -gt 0 ]] || { sed -n 2,16p "$0"; exit 1; }
ABS=()
for f in "${FILES[@]}"; do
  [[ -f $f ]] || { echo "no such file: $f" >&2; exit 1; }
  ABS+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
  (($(stat -f %z "$f") <= 10485760)) || echo "warning: over 10MB, GitHub may refuse it: $(basename "$f")" >&2
done

URL=$(gh pr view "$PR" --json url -q .url)
echo "PR: $URL / ${#ABS[@]} file(s)"

LINK_RE='https:\/\/github\.com\/user-attachments\/[^\s"<>)]+'

# Aside: its scripts can't read files outside their folder, so the files are
# served for a moment on this machine only.
via_aside() {
  local acct=() tmp port srv i=0 spec=() out line
  [[ -n $ACCOUNT ]] && acct=(--account "$ACCOUNT")
  tmp=$(mktemp -d)
  for f in "${ABS[@]}"; do ln -s "$f" "$tmp/$i.$(echo "${f##*.}" | tr '[:upper:]' '[:lower:]')"; i=$((i + 1)); done
  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$tmp" >/dev/null 2>&1 &
  srv=$!
  for _ in $(seq 20); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.2; done
  local all=() k e m
  for ((s0 = 0; s0 < ${#ABS[@]}; s0 += 4)); do # four per run: one Aside run has 120 s
    spec=()
    for ((k = s0; k < s0 + 4 && k < ${#ABS[@]}; k++)); do
      f=${ABS[k]}; e=$(echo "${f##*.}" | tr '[:upper:]' '[:lower:]')
      case $e in png) m=image/png ;; jpg|jpeg) m=image/jpeg ;; gif) m=image/gif ;; webp) m=image/webp ;; mp4) m=video/mp4 ;; mov) m=video/quicktime ;; *) m=application/octet-stream ;; esac
      spec+=("[\"$k.$e\",$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$(basename "$f")"),\"$m\"]")
    done
    out=$(aside repl ${acct[@]+"${acct[@]}"} "
const pmPage = await openTab('$URL');
try {
  const pmFiles = [];
  for (const [srv, name, type] of [$(IFS=,; echo "${spec[*]}")]) {
    const r = await fetch('http://127.0.0.1:$port/' + srv);
    if (!r.ok) throw new Error('local fetch ' + r.status);
    pmFiles.push({ name, mimeType: type, buffer: Buffer.from(await r.arrayBuffer()) });
  }
  const box = pmPage.locator('#new_comment_field');
  await box.fill('');
  await pmPage.locator('#fc-new_comment_field').setInputFiles(pmFiles);
  let val = '';
  for (let t = 0; t < 100; t++) {
    val = await box.inputValue();
    const n = (val.match(/$LINK_RE/g) || []).length;
    if (n >= pmFiles.length && !/Uploading/.test(val)) break;
    await sleep(1000);
  }
  await box.fill('');
  console.log('PMRESULT ' + JSON.stringify(val.match(/$LINK_RE/g) || []));
} finally { await closeTab(pmPage); }" 2>&1) || true
    line=$(printf '%s\n' "$out" | grep '^PMRESULT ' | tail -1)
    if [[ -z $line ]]; then kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null; rm -rf "$tmp"; printf '%s\n' "$out" | tail -4 >&2; return 1; fi
    while IFS= read -r u; do all+=("$u"); done < <(printf '%s' "${line#PMRESULT }" | python3 -c 'import json,sys;print("\n".join(json.load(sys.stdin)))')
  done
  kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null; rm -rf "$tmp"
  LINKS=$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1:]))' ${all[@]+"${all[@]}"})
}

ab() { agent-browser "$@"; }
# eval prints its result as JSON: a string comes back as plain text, anything else as JSON
js() { ab eval "$1" 2>/dev/null | tail -1 | python3 -c 'import json,sys
t = sys.stdin.read().strip()
try: v = json.loads(t)
except Exception: v = t
print(v if isinstance(v, str) else json.dumps(v))'; }

# Ondra's shared browser: your own tab, the login the user made in the browser panel.
via_browser() {

  # your tab may be gone (closed, or the browser restarted): then a new one
  ab open "$URL" >/dev/null 2>&1 || ab tab new "$URL" >/dev/null
  ab wait --load networkidle >/dev/null 2>&1 || true

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
    signed-out) echo "GitHub is not signed in in Ondra's browser. Ask the user to sign in to GitHub (the account that opens PRs) in the browser panel, then run this again." >&2; exit 3 ;;
    *) echo "Couldn't find the comment box on $URL ($FOUND)." >&2; exit 1 ;;
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

aside_ready() { command -v aside >/dev/null 2>&1 && aside account status 2>/dev/null | grep -q "signed in"; }
LINKS=""
if [[ $VIA == aside ]] || { [[ -z $VIA ]] && aside_ready; }; then
  echo "via Aside${ACCOUNT:+ ($ACCOUNT)}"
  if ! via_aside; then
    [[ $VIA == aside ]] && { echo "Aside upload failed." >&2; exit 1; }
    echo "Aside upload failed; using Ondra's browser." >&2
    via_browser
  fi
else
  echo "via Ondra's browser"
  via_browser
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

BODY=$(gh pr view "$URL" --json body -q .body)
NEW=$(BLOCK="$BLOCK" python3 -c '
import os, re, sys
body, block = sys.stdin.read(), os.environ["BLOCK"]
if "<!-- pr-media -->" in body:
    body = re.sub(r"<!-- pr-media -->.*?<!-- /pr-media -->", lambda m: block, body, flags=re.S)
elif re.search(r"^## 화면[^\n]*$", body, flags=re.M):
    body = re.sub(r"^(## 화면[^\n]*\n)", lambda m: m.group(1) + "\n" + block + "\n\n", body, count=1, flags=re.M)
else:
    body = body.rstrip() + "\n\n## 화면\n\n" + block + "\n"
print(body, end="")' <<<"$BODY")
gh pr edit "$URL" --body "$NEW" >/dev/null
echo "added to $URL (${#ABS[@]} file(s))"
