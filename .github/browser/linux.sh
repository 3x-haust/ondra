#!/usr/bin/env bash
# After the deb is installed: start the app until it has installed the browser component, then use that
# Chrome (smoke.sh) with a password saved in the keyring. Run from the repo root as the runner user.
set -euo pipefail
export XDG_RUNTIME_DIR=$(mktemp -d)
pattern="$HOME/.local/share/dev.3xhaust.ondra/components/chrome/*/chrome-headless-shell-linux64/chrome-headless-shell"
# running, and within 3 minutes the component fetched from components.json and unpacked
xvfb-run -a dbus-run-session -- sh -c "ondra > app.log 2>&1 & pid=\$!; sleep 25; kill -0 \$pid || exit 1
  for i in \$(seq 1 80); do ls $pattern >/dev/null 2>&1 && break; sleep 2; done; kill \$pid" || { cat app.log; exit 1; }
cat app.log
chrome=$(ls $pattern 2>/dev/null | head -1)
[ -x "$chrome" ] || { echo "the app did not install the browser component"; exit 1; }
dbus-run-session -- bash -c '
  set -e
  export $(printf ci | gnome-keyring-daemon --unlock --components=secrets)
  sleep 1  # the login keyring is written just after the daemon answers
  printf "s3cret!!!" | secret-tool store --label=127.0.0.1 server 127.0.0.1 user ci@example.com
  .github/browser/smoke.sh /usr/bin "$0" /usr/lib/Ondra/app-skills/browser-use/browse' "$chrome"
