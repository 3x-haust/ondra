# Build the Linux packages

## Get the x64 packages from CI

The [Linux packages workflow](../.github/workflows/linux.yml) runs on pull requests or manually from **Actions → Linux packages → Run workflow** (once the workflow is on the default branch). It builds on a clean GitHub-hosted Ubuntu 22.04 VM, so the packages run on distributions with glibc 2.35 or newer.

After the run succeeds, download **Ondra-linux-x64** from the run's **Artifacts** section. It holds a `.deb` (Debian, Ubuntu and their derivatives) and an `.rpm` (Fedora, openSUSE, RHEL). The **Verify the installed package** log prints their SHA-256. The artifact is kept for seven days. These are unsigned test packages, not a GitHub Release, and Linux builds don't update themselves.

## Reproduce the build locally

Install [Tauri's Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) (on Debian/Ubuntu: `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`). CI uses Rust 1.95.0, Node 24.14.0, pnpm 11.6.0 and Bun 1.3.14. These are build tools. The installed app doesn't need them.

### Prepare the engine

Ondra runs `packages/coding-agent` from [3x-haust/3xhaustpi](https://github.com/3x-haust/3xhaustpi), the same RPC engine as on macOS and Windows:

```sh
git clone https://github.com/3x-haust/3xhaustpi.git ../3xhaustpi-engine-build
(cd ../3xhaustpi-engine-build && git checkout --detach 3311ed88dc6c5c403db2ce4edc762b734acbfb25 && npm ci --ignore-scripts && npm run build:offline)
export ONDRA_ENGINE_DIST=$PWD/../3xhaustpi-engine-build/packages/coding-agent/dist
```

The bundle step compiles the Bun entry and both workers for the build machine's architecture (x64 or ARM64). It copies the themes, images, HTML export templates, photon WASM, docs and examples, and the matching `packages/tui/native/linux` clipboard addon next to them.

### Build and install

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm tauri build --bundles deb,rpm --ci -- --locked
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb   # or: sudo dnf install ./src-tauri/target/release/bundle/rpm/*.rpm
```

There is no AppImage: its packer rewrites the library path of every program inside it, and that breaks the single-file engine.

If `CARGO_TARGET_DIR` is set, look under that directory instead of `src-tauri/target`. The pre-build step also builds the remote helper (`ondra-remote`) and stages it as a sidecar. `pnpm tauri dev` prepares the same engine and helper.

## What the app uses on Linux

- **Secrets and provider keys** go to the desktop's Secret Service (GNOME Keyring, KWallet) through `secret-tool` from libsecret. Both packages depend on it (`libsecret-tools` on Debian/Ubuntu, `libsecret` on Fedora), and on `curl` and `git`. Without an unlocked keyring, Settings › 시크릿 can't save anything.
- **Opening links, files and folders** uses `xdg-open`. **Revealing a file** asks the file manager over D-Bus and falls back to opening its folder.
- **Open in terminal** uses the first terminal it finds: GNOME Terminal, Konsole, Xfce Terminal, Ptyxis, kitty, Alacritty, WezTerm, xterm, then `x-terminal-emulator`.
- **Notifications** use `notify-send`. Sounds use `paplay`.
- **Keep awake** (Settings › 연결) holds a `systemd-inhibit` lock while Ondra is open.

The browser tool, app control, dictation and the iOS simulator need macOS helpers and are not part of the Linux build. Android emulators use the SDK in `$ANDROID_HOME` or `~/Android/Sdk`.

## Check an installed copy

```sh
ls /usr/bin/ondra /usr/bin/ondra-remote /usr/lib/Ondra/engine/ondra-engine
/usr/lib/Ondra/engine/ondra-engine --version
```

Start Ondra from the app menu and run a small local job. Then use **Settings → 연결** to pair it with a second Ondra and run a job each way. See [remote control](remote-control.md) for the pairing flow.
