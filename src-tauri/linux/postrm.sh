#!/bin/sh
# Take back the AppArmor profile postinst.sh wrote (on remove and purge, not on upgrade).
case "$1" in
  remove|purge)
    if [ -f /etc/apparmor.d/ondra-chrome ]; then
      command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R /etc/apparmor.d/ondra-chrome 2>/dev/null || true
      rm -f /etc/apparmor.d/ondra-chrome
    fi
    ;;
esac
exit 0
