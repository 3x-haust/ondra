#!/usr/bin/env bash
# The installed browser tool on Windows and Linux: Chrome for Testing as components.json names it,
# a page through `browse`, and a sign-in from the system's password store. From the repo root:
#   smoke.sh <folder with ondra and ondra-browser> <components.json> <browse>
set -euo pipefail
bin=$1 manifest=$2 browse=$3
exe=$([ "${OS:-}" = Windows_NT ] && echo .exe || true)
py=$(command -v python3 || command -v python)
native() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
tmp=$(mktemp -d)

# the Chrome a release build downloads, checked against the manifest the installer carries
read -r url sha < <(node -p "const c = require(process.argv[1]).components.find((c) => c.name === 'chrome'); c.url + ' ' + c.sha256" "$(native "$manifest")")
curl -sSfL -o "$tmp/chrome.zip" "$url"
echo "$sha  $tmp/chrome.zip" | sha256sum -c -
(cd "$tmp" && "$py" -m zipfile -e chrome.zip .)
chrome=$(ls "$tmp"/chrome-headless-shell-*/chrome-headless-shell$exe)
chmod +x "$chrome"
export ONDRA_BROWSER_EXECUTABLE_PATH=$(native "$chrome")

(cd .github/browser && exec "$py" -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
trap '"$bin/ondra-browser$exe" --session smoke close >/dev/null 2>&1 || true; kill $server 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8765/login.html && break; sleep 0.5; done

# each step is quick; a step still running after a minute is waiting on a pipe a daemon holds
export ONDRA_BROWSER_SESSION=smoke ONDRA_BROWSER_KEYCHAIN=$(native "$bin/ondra$exe") BROWSE_BIN=$(native "$bin/ondra-browser$exe") APP_SCRATCH_DIR=$(native "$tmp")
timeout 60 "$browse" open http://127.0.0.1:8765/login.html | tee "$tmp/open.txt"
grep -q 'textbox "Email"' "$tmp/open.txt"
timeout 60 "$bin/ondra-browser$exe" --session smoke auth login 127.0.0.1 --credential-provider keychain --no-navigate --url http://127.0.0.1:8765/login.html
out=$(timeout 60 "$bin/ondra-browser$exe" --session smoke get text '#out' | tr -d '\r')
echo "$out"
[ "$out" = "sent ci@example.com 9" ] || { echo "the keychain sign-in did not fill the form"; exit 1; }
