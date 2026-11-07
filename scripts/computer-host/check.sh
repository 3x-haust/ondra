#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d "${TMPDIR:-/tmp}/ondra-computer-check.XXXXXX")
trap 'rm -rf "$work"' EXIT
xcrun swiftc -typecheck -target arm64-apple-macos13.0 scripts/computer-host/HostConfiguration.swift scripts/computer-host/main.swift
xcrun swiftc -parse-as-library -target arm64-apple-macos13.0 scripts/computer-host/HostConfiguration.swift scripts/computer-host/ConfigurationTests.swift -o "$work/config-tests"
"$work/config-tests"
xcrun swiftc -parse-as-library -swift-version 6 -warnings-as-errors -target arm64-apple-macos13.0 scripts/computer-guest/BootProvisioning.swift scripts/computer-guest/ProvisionMain.swift -o "$work/ondra-computer-provision"
xcrun swiftc -parse-as-library -swift-version 6 -warnings-as-errors -D COMPUTER_GUEST_LIBRARY -target arm64-apple-macos13.0 scripts/computer-guest/main.swift scripts/computer-guest/BootProvisioning.swift scripts/computer-host/BootProvisioningTests.swift -o "$work/boot-tests"
"$work/boot-tests"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/ondra-computer-native-tests-target}" cargo test --offline --manifest-path scripts/computer-host/native-tests/Cargo.toml
