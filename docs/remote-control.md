# Remote control

Phones see and steer jobs over Ondra's own private network. Nothing goes through a server that can read it.

## How it fits together

- **`remote/host`** is the `ondra-remote` helper, written in Rust on iroh.
  - The Mac's key lives in `<data dir>/remote/key` (0600). Its public half is the Mac's address.
  - Phones dial that address over QUIC: hole-punched UDP when possible, otherwise through a relay. Either way the connection is end-to-end encrypted.
  - Only devices listed in `remote/devices.json` get in.
  - The app drives the helper over stdin/stdout (JSON lines; see the top of `main.rs`).
- **`remote/client`** is the phone's side of the connection, compiled to WebAssembly. The phone's key stays in its browser.
- **`remote/web`** is the phone page, a small Solid app built from the same `tokens.css`.
- **`src-tauri/src/remote.rs`** starts and stops the helper. `src/engine/remote.ts` answers phones from the app's state.
- **Settings › 원격 제어** turns it on, shows the pairing QR, and lists devices.

## Adding a phone

1. The QR holds the page URL with the Mac's id and a one-time code (`#m=…&p=…`). The code is good for 10 minutes, for one device.
2. The phone connects with that code. The Mac asks "허용 / 거절".
3. Once allowed, the phone's key is remembered and it comes back on its own. 연결 끊기 removes it and closes its connection.

## Building

The helper and the browser module need Rust 1.91 (iroh). The app itself stays on its own toolchain.

- `src-tauri/helpers/build.sh` builds `ondra-remote` into `src-tauri/binaries`.
- `pnpm remote:build` builds the browser module and the page into `dist-remote/`. It needs the `wasm32-unknown-unknown` target, `llvm-tools`, and `wasm-bindgen-cli` 0.2.130.
- `pnpm remote:dev` serves the page on this Wi-Fi, port 4740. A dev build's QR points there.
