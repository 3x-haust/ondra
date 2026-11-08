#!/bin/sh
# Builds the bundled Swift helpers into src-tauri/binaries, where tauri.conf.json's
# externalBin picks them up:
#   - ondra-simhelper: iOS simulator live screen/input.
#   - ondra-cuhost:    background host computer use (AX + pid-targeted events +
#                      ScreenCaptureKit window capture), signed with cuhost.entitlements.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
arch="$(uname -m)"
case "$arch" in arm64) triple=aarch64-apple-darwin ;; *) triple=x86_64-apple-darwin ;; esac
mkdir -p "$here/../binaries"

build() {
  name="$1"; src="$2"; ents="$3"
  out="$here/../binaries/$name-$triple"
  if [ -f "$out" ] && [ "$out" -nt "$here/$src" ] && { [ -z "$ents" ] || [ "$out" -nt "$here/$ents" ]; }; then
    echo "$name: up to date"
    return 0
  fi
  xcrun swiftc -O -target "$arch-apple-macos13.0" "$here/$src" -o "$out"
  if [ -n "$ents" ]; then
    /usr/bin/codesign --force --sign "${CODE_SIGN_IDENTITY:--}" --entitlements "$here/$ents" "$out"
    /usr/bin/codesign --verify --strict "$out"
  fi
  chmod 755 "$out"
  echo "$name: built $out"
}

build ondra-simhelper simhelper.swift ""
build ondra-cuhost cuhost.swift cuhost.entitlements
