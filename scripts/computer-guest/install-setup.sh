#!/bin/bash
# Run manually inside the newly created guest, from its read-only setup share.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077
[ "$#" -eq 0 ] && [ "$(id -u)" -eq 0 ] || { printf '%s\n' '게스트 안에서 sudo /bin/bash install-setup.sh 로 실행하세요.' >&2; exit 64; }
cd -P -- "$(dirname -- "$0")"
# The native provisioner checks the guest/host identity before any installation.
./ondra-computer-provision --check-setup < enrollment.json
[ ! -e /private/var/db/ondra-computer-enrollment ] || { printf '%s\n' '이미 준비된 게스트입니다.' >&2; exit 65; }
/usr/bin/shasum -a 256 -c assets.sha256 >/dev/null
# Create the dedicated desktop account interactively; its password never leaves the guest.
if ! /usr/bin/id ondra-computer >/dev/null 2>&1; then
  printf '%s\n' '전용 게스트 계정 ondra-computer의 암호를 입력하세요.' >&2
  /usr/sbin/sysadminctl -addUser ondra-computer -fullName 'Ondra Computer' -home /Users/ondra-computer -password - >&2
fi
[ "$(/usr/bin/dscl . -read /Users/ondra-computer NFSHomeDirectory)" = 'NFSHomeDirectory: /Users/ondra-computer' ]
/usr/bin/install -d -o ondra-computer -g staff -m 700 /Users/ondra-computer
/usr/bin/install -d -o root -g wheel -m 755 /usr/local/libexec /usr/local/libexec/ondra-computer /usr/local/libexec/ondra-computer/1.1.0
/usr/bin/install -o root -g wheel -m 755 ondra-computer-endpoint /usr/local/libexec/ondra-computer-endpoint
/usr/bin/install -o root -g wheel -m 755 ondra-computer-provision /usr/local/libexec/ondra-computer-provision
/usr/bin/install -o root -g wheel -m 755 agent-desktop agent-desktop-macos-helper /usr/local/libexec/ondra-computer/1.1.0/
/usr/bin/install -d -o root -g wheel -m 700 /private/var/db/ondra-computer-enrollment
/usr/bin/install -o root -g wheel -m 600 enrollment.json /private/var/db/ondra-computer-enrollment/enrollment.json
/usr/bin/install -o root -g wheel -m 600 server-key /private/var/db/ondra-computer-enrollment/server-key
# Keys are not added to the general system SSH service or a sudoers shell rule.
printf 'restrict,command="/usr/local/libexec/ondra-computer-provision --authenticated-boot" %s\n' "$(<provision-client.pub)" > /private/var/db/ondra-computer-enrollment/root.keys
printf 'restrict,command="/usr/local/libexec/ondra-computer-endpoint" %s\n' "$(<client.pub)" > /private/var/db/ondra-computer-enrollment/guest.keys
# The guest key file must be readable by the non-root login account; its parent remains root controlled.
/usr/bin/install -d -o root -g wheel -m 755 /private/etc/ondra-computer
/usr/bin/install -o root -g wheel -m 644 /private/var/db/ondra-computer-enrollment/guest.keys /private/etc/ondra-computer/guest.keys
cat > /private/var/db/ondra-computer-enrollment/sshd_config <<'CONFIG'
Port 2222
AddressFamily inet
ListenAddress 0.0.0.0
HostKey /private/var/db/ondra-computer-enrollment/server-key
PidFile /private/var/run/ondra-computer-sshd.pid
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin forced-commands-only
AllowUsers root ondra-computer
StrictModes yes
UsePAM yes
DisableForwarding yes
PermitTTY no
PermitUserEnvironment no
PermitUserRC no
X11Forwarding no
LogLevel ERROR
Match User root
    AuthorizedKeysFile /private/var/db/ondra-computer-enrollment/root.keys
    ForceCommand /usr/local/libexec/ondra-computer-provision --authenticated-boot
Match User ondra-computer
    AuthorizedKeysFile /private/etc/ondra-computer/guest.keys
    ForceCommand /usr/local/libexec/ondra-computer-endpoint
CONFIG
/usr/sbin/sshd -t -f /private/var/db/ondra-computer-enrollment/sshd_config
cat > /Library/LaunchDaemons/dev.3xhaust.ondra.computer-sshd.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.3xhaust.ondra.computer-sshd</string>
<key>ProgramArguments</key><array><string>/usr/sbin/sshd</string><string>-D</string><string>-e</string><string>-f</string><string>/private/var/db/ondra-computer-enrollment/sshd_config</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
PLIST
/bin/chmod 644 /Library/LaunchDaemons/dev.3xhaust.ondra.computer-sshd.plist
/usr/sbin/chown root:wheel /Library/LaunchDaemons/dev.3xhaust.ondra.computer-sshd.plist
printf '%s\n' '설치 완료. 전용 계정으로 로그인하여 필요한 게스트 권한을 승인하세요. Ondra의 명시적 자동화 시작은 공유를 제거한 새 부팅에서 SSH 서비스를 시작합니다.'
