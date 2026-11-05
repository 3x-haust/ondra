#!/bin/sh
# Builds the iOS simulator helper (live screen, touches, keyboard, rotation) into
# src-tauri/binaries, where tauri.conf.json's externalBin picks it up.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
arch="$(uname -m)"
case "$arch" in arm64) triple=aarch64-apple-darwin ;; *) triple=x86_64-apple-darwin ;; esac
out="$here/../binaries/ondra-simhelper-$triple"
if [ -f "$out" ] && [ "$out" -nt "$here/simhelper.swift" ]; then
  echo "simhelper: up to date"
  exit 0
fi
xcrun swiftc -O -target "$arch-apple-macos13.0" "$here/simhelper.swift" -o "$out"
chmod 755 "$out"
echo "simhelper: built $out"
