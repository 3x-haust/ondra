#!/bin/sh
# Ubuntu 23.10 and later stop programs without an AppArmor profile from making user namespaces,
# which Chrome's sandbox needs. Allow it for the browser Ondra downloads into each user's data folder
# (Chrome for Testing, see components.rs) and nothing else.
set -e
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
  cat > /etc/apparmor.d/ondra-chrome <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile ondra-chrome @{HOME}/.local/share/dev.3xhaust.ondra/components/chrome/*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/ondra-chrome>
}
PROFILE
  apparmor_parser -r /etc/apparmor.d/ondra-chrome || true
fi
exit 0
