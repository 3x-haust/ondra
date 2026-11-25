# Build the native Windows installer

Build on Windows in PowerShell, using a short local checkout path (for example `C:\src\ondra`). Install [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/) including Visual Studio C++ Build Tools, the Windows SDK and WebView2. Use Rust stable **MSVC** (1.91 or newer), Git for Windows, Node 24, pnpm 11 and Bun 1.3.14. Git Bash is also used by the engine's shell tool at runtime. Node, pnpm, Rust and Bun are build tools, not requirements to run the installed app.

## Prepare the engine

Ondra uses `packages/coding-agent` in [3x-haust/3xhaustpi](https://github.com/3x-haust/3xhaustpi), the same RPC engine as on macOS. **Do not use the `3xhaustpi-windows-*.zip` releases**: those package the separate `packages/3xhaustpi` CLI. From the Ondra checkout:

```powershell
# Use a separate checkout; keep the committed model data byte-for-byte for its hash check.
git clone -c core.autocrlf=false https://github.com/3x-haust/3xhaustpi.git ..\3xhaustpi-engine-build
Push-Location ..\3xhaustpi-engine-build
git checkout --detach 3311ed88dc6c5c403db2ce4edc762b734acbfb25
npm ci --ignore-scripts
npm run build:offline
$env:ONDRA_ENGINE_DIST = (Resolve-Path packages\coding-agent\dist).Path
Pop-Location
```

Keep the **whole built checkout**, not just `dist`: the [upstream Windows binary recipe](https://github.com/3x-haust/3xhaustpi/blob/3311ed88dc6c5c403db2ce4edc762b734acbfb25/scripts/build-binaries.sh) compiles the Bun entry and both workers. The Ondra bundle does the same for the selected target, and copies the themes, images, HTML export templates, photon WASM, docs/examples and architecture-matched `packages/tui/native/win32/prebuilds` addon. The engine license and dependency notices travel with it.

## Build and install

```powershell
$target = 'x86_64-pc-windows-msvc'   # aarch64-pc-windows-msvc on native ARM64
rustup target add $target
pnpm install --frozen-lockfile
pnpm tauri build --target $target --ci
Get-ChildItem "src-tauri\target\$target\release\bundle\nsis\*-setup.exe"
```

If `CARGO_TARGET_DIR` is set, look under that directory instead of `src-tauri\target`. The pre-build step compiles `remote/host` with its own lockfile and stages the Tauri sidecar. `pnpm tauri dev` prepares the same engine and helper. Windows uses an NSIS installer, **not** `scripts/release.mjs`; this command neither signs nor publishes a release and does not write the macOS component/update manifest. The first build needs network access for dependencies; the installer may fetch WebView2 on systems without it.

Run the setup EXE. In the **installed application directory** (not the NSIS output directory), check:

```powershell
Get-Item .\ondra.exe, .\ondra-remote.exe, .\engine\ondra-engine.exe, .\engine\package.json
.\engine\ondra-engine.exe --version
```

Launch Ondra from Start, run a small local job, then use **Settings → 연결** to pair with a second Ondra and exchange a job. This checks the installed engine and the remote helper, not just the presence of the files. See [remote control](remote-control.md) for the pairing flow.
