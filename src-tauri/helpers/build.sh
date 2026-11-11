#!/bin/sh
# Builds the bundled Swift helpers into src-tauri/binaries, where tauri.conf.json's
# externalBin picks them up:
#   - ondra-simhelper: iOS simulator live screen/input.
#   - ondra-cuhost:    background host computer use (AX + pid-targeted events +
#                      ScreenCaptureKit window capture + an off-screen display to hold
#                      background windows), signed with cuhost.entitlements. If a
#                      per-source header (cuhost.h) exists it is imported.
#   - ondra-bgguard.dylib: injected into an app cuhost starts in the background so the
#                      app cannot turn itself into a Dock app or come to the front.
#                      A plain resource (not externalBin); universal, team-signed.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
arch="$(uname -m)"
case "$arch" in arm64) triple=aarch64-apple-darwin ;; *) triple=x86_64-apple-darwin ;; esac
mkdir -p "$here/../binaries"

build() {
  name="$1"; src="$2"; ents="$3"
  out="$here/../binaries/$name-$triple"
  header="$here/${src%.swift}.h"
  [ -f "$header" ] || header=""
  if [ -f "$out" ] && [ "$out" -nt "$here/$src" ] && { [ -z "$ents" ] || [ "$out" -nt "$here/$ents" ]; } && { [ -z "$header" ] || [ "$out" -nt "$header" ]; }; then
    echo "$name: up to date"
    return 0
  fi
  xcrun swiftc -O -target "$arch-apple-macos13.0" ${header:+-import-objc-header "$header"} "$here/$src" -o "$out"
  if [ -n "$ents" ]; then
    /usr/bin/codesign --force --sign "${CODE_SIGN_IDENTITY:--}" --entitlements "$here/$ents" "$out"
    /usr/bin/codesign --verify --strict "$out"
  fi
  chmod 755 "$out"
  echo "$name: built $out"
}

# The guard is one universal dylib (both arches), named without a triple so cuhost can
# load the same file on either host. It ships in the app's Resources, which Tauri does
# not sign, so it is signed here with the release identity (hardened runtime + timestamp)
# — both so notarization and `codesign --verify --deep --strict` of the app accept it,
# and so library validation accepts it when it is injected into a hardened target app.
build_guard() {
  out="$here/../binaries/ondra-bgguard.dylib"
  src="$here/bgguard.m"
  if [ -f "$out" ] && [ "$out" -nt "$src" ]; then echo "ondra-bgguard: up to date"; return 0; fi
  # SetFrontProcess is used only as an interpose target (a function pointer, never called);
  # its 10.9 deprecation is expected.
  xcrun clang -dynamiclib -arch arm64 -arch x86_64 -fobjc-arc -Wno-deprecated-declarations \
    -framework AppKit -framework ApplicationServices \
    -o "$out" "$src"
  identity="${APPLE_SIGNING_IDENTITY:-${CODE_SIGN_IDENTITY:--}}"
  if [ "$identity" = "-" ]; then
    /usr/bin/codesign --force --sign - "$out"
  else
    /usr/bin/codesign --force --sign "$identity" --options runtime --timestamp "$out"
  fi
  /usr/bin/codesign --verify --strict "$out"
  echo "ondra-bgguard: built $out"
}

# ondra-remote: remote control's private network (remote/host, Rust). Its own crate and a
# newer Rust (iroh needs 1.91), so it builds apart from the app.
build_remote() {
  out="$here/../binaries/ondra-remote-$triple"
  crate="$here/../../remote/host"
  newest=$(find "$crate/src" "$crate/Cargo.toml" "$crate/Cargo.lock" -type f -newer "$out" 2>/dev/null | head -1)
  if [ -f "$out" ] && [ -z "$newest" ]; then echo "ondra-remote: up to date"; return 0; fi
  (cd "$crate" && RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN_REMOTE:-1.91.0}" cargo build -q --release --target "$triple")
  cp "$crate/target/$triple/release/ondra-remote" "$out"
  chmod 755 "$out"
  echo "ondra-remote: built $out"
}

build ondra-simhelper simhelper.swift ""
build ondra-cuhost cuhost.swift cuhost.entitlements
build_guard
build_remote
