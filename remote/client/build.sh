#!/bin/sh
# Builds the browser module into remote/web/pkg (needs Rust 1.91 with the wasm32 target,
# llvm-ar from its llvm-tools, and wasm-bindgen-cli 0.2.130).
set -e
here=$(cd "$(dirname "$0")" && pwd)
tc=${RUSTUP_TOOLCHAIN_REMOTE:-1.91.0}
host=$(rustc +"$tc" -vV 2>/dev/null | sed -n 's/^host: //p' || echo aarch64-apple-darwin)
ar="$HOME/.rustup/toolchains/$tc-$host/lib/rustlib/$host/bin/llvm-ar"
bindgen=${WASM_BINDGEN:-wasm-bindgen}
cd "$here"
RUSTUP_TOOLCHAIN=$tc AR_wasm32_unknown_unknown="$ar" CC_wasm32_unknown_unknown=clang \
  RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo build -q --release --target wasm32-unknown-unknown
"$bindgen" --target web --out-dir "$here/../web/pkg" "$here/target/wasm32-unknown-unknown/release/ondra_remote_client.wasm"
