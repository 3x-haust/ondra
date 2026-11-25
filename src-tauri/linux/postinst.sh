#!/bin/sh
# Ubuntu 23.10 and later stop programs without an AppArmor profile from making user namespaces,
# which Chrome's sandbox needs. Allow it for the browser Ondra downloads into each user's data folder
# (Chrome for Testing, see components.rs) and nothing else.
set -e
# Only where that restriction exists and AppArmor 4 (which knows `userns`) reads profiles.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
  cat > /etc/apparmor.d/ondra-chrome <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile ondra-chrome @{HOME}/.local/share/dev.3xhaust.ondra/components/chrome/*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/ondra-chrome>
}
PROFILE
  # a profile AppArmor can't read would fail every later reload: take it back
  apparmor_parser -r /etc/apparmor.d/ondra-chrome || rm -f /etc/apparmor.d/ondra-chrome
fi
exit 0
