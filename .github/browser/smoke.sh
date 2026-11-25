#!/usr/bin/env bash
# The installed browser tool on Windows and Linux, the way the app uses it: the Chrome component the
# app installed, started once with the app's flags and shared by two jobs (each its own tab), a page
# through `browse`, a sign-in from the system's password store, and the stream the small window shows.
# From the repo root:  smoke.sh <folder with ondra and ondra-browser> <the app's Chrome> <browse>
set -euo pipefail
bin=$1 chrome=$2 browse=$3
exe=$([ "${OS:-}" = Windows_NT ] && echo .exe || true)
py=$(command -v python3 || command -v python)
native() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
tmp=$(mktemp -d)
ab() { timeout 60 "$bin/ondra-browser$exe" "$@"; }

(cd .github/browser && exec "$py" -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
# the shared browser, as browser.rs starts it (Chrome's own sandbox stays on)
"$chrome" --user-data-dir="$(native "$tmp/profile")" --remote-debugging-port=9555 --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check --window-size=1280,800 about:blank >"$tmp/chrome.log" 2>&1 &
browser=$!
trap 'ab --session job-a close >/dev/null 2>&1 || true; ab --session job-b close >/dev/null 2>&1 || true; kill $server $browser 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:9555/json/version && curl -sf -o /dev/null http://127.0.0.1:8765/login.html && break; sleep 0.5; done
curl -sf -o /dev/null http://127.0.0.1:9555/json/version || { cat "$tmp/chrome.log"; echo "the shared browser did not start"; exit 1; }

export ONDRA_BROWSER_CDP=9555 ONDRA_BROWSER_PIN_TAB=1 ONDRA_BROWSER_KEYCHAIN=$(native "$bin/ondra$exe") BROWSE_BIN=$(native "$bin/ondra-browser$exe") APP_SCRATCH_DIR=$(native "$tmp")
# two jobs, two tabs: each keeps its own page
ONDRA_BROWSER_SESSION=job-a timeout 60 "$browse" open http://127.0.0.1:8765/login.html | tee "$tmp/open.txt"
grep -q 'textbox "Email"' "$tmp/open.txt"
ab --session job-b open "http://localhost:8765/login.html" >/dev/null
[ "$(ab --session job-a get url | tr -d '\r')" = "http://127.0.0.1:8765/login.html" ] || { echo "job-b took job-a's tab"; exit 1; }

# a password goes only into the site it is saved for
if ab --session job-b auth login 127.0.0.1 --credential-provider keychain --no-navigate --url http://127.0.0.1:8765/login.html; then
  echo "the password for 127.0.0.1 went into a page on localhost"; exit 1
fi
ab --session job-a auth login 127.0.0.1 --credential-provider keychain --no-navigate --url http://127.0.0.1:8765/login.html
out=$(ab --session job-a get text '#out' | tr -d '\r')
echo "$out"
[ "$out" = "sent ci@example.com 9" ] || { echo "the keychain sign-in did not fill the form"; exit 1; }
# the exact password went in, without printing it
[ "$(ab --session job-a eval 'document.getElementById("pass").value === "s3cret!!!"' | tr -d '\r')" = "true" ] || { echo "a different password went in"; exit 1; }

port=$(ab --session job-a --json stream status | "$py" -c 'import json, sys; print(json.load(sys.stdin)["data"]["port"])')
timeout 30 "$py" .github/browser/frame.py "$port"
