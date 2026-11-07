#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "$#" -ne 1 ]; then
  printf '%s\n' '사용법: bash scripts/computer-host/build.sh <출력 폴더>' >&2
  exit 64
fi
mkdir -p "$1"
output=$(cd "$1" && pwd -P)
xcrun swiftc -O -target arm64-apple-macos13.0 scripts/computer-host/HostConfiguration.swift scripts/computer-host/main.swift -o "$output/ondra-computer-host"
/usr/bin/codesign --force --sign "${CODE_SIGN_IDENTITY:--}" --entitlements scripts/computer-host/entitlements.plist "$output/ondra-computer-host"
/usr/bin/codesign --verify --strict "$output/ondra-computer-host"
/usr/bin/shasum -a 256 "$output/ondra-computer-host" | /usr/bin/awk '{print $1}' > "$output/ondra-computer-host.sha256"
xcrun swiftc -O -parse-as-library -swift-version 6 -warnings-as-errors -target arm64-apple-macos13.0 scripts/computer-guest/BootProvisioning.swift scripts/computer-guest/ProvisionMain.swift -o "$output/ondra-computer-provision"
xcrun swiftc -O -parse-as-library -swift-version 6 -warnings-as-errors -target arm64-apple-macos13.0 scripts/computer-guest/main.swift -o "$output/ondra-computer-endpoint"
for name in ondra-computer-provision ondra-computer-endpoint; do
  /usr/bin/codesign --force --sign "${CODE_SIGN_IDENTITY:--}" "$output/$name"
  /usr/bin/codesign --verify --strict "$output/$name"
  /usr/bin/shasum -a 256 "$output/$name" | /usr/bin/awk '{print $1}' > "$output/$name.sha256"
done
/usr/bin/install -m 755 scripts/computer-guest/install-setup.sh "$output/install-setup.sh"
/usr/bin/shasum -a 256 "$output/install-setup.sh" | /usr/bin/awk '{print $1}' > "$output/install-setup.sh.sha256"
printf '%s\n' '빌드와 로컬 서명만 완료했습니다. VM 실행·게스트 설치는 하지 않았습니다.'
