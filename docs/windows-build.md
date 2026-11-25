# Build the native Windows installer

## Get the x64 installer from CI

The [Windows installer workflow](../.github/workflows/windows.yml) runs on pull requests or manually from **Actions → Windows installer → Run workflow** (once the workflow is on the default branch). It builds from a clean GitHub-hosted Windows Server 2022 VM; it does not need a self-hosted machine, signing keys or release credentials.

After the run succeeds, download **Ondra-windows-x64-nsis** from the run's **Artifacts** section and unzip it to get `*-setup.exe`. The **Verify installed payload** log includes the installer SHA-256; compare it with `Get-FileHash .\<installer-name>.exe` after extraction. The artifact is retained for seven days. This is an unsigned test installer, not a GitHub Release; Windows may show a SmartScreen warning.

## Reproduce the build locally

Use PowerShell 7 on Windows and a short local checkout path (for example `C:\src\ondra`). Install [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/) including Visual Studio C++ Build Tools, the Windows SDK and WebView2. CI uses the x64 **MSVC** Rust 1.95.0 toolchain, Git for Windows, Node 24.14.0, pnpm 11.6.0 and Bun 1.3.14. For x64 CI uses the baseline Windows Bun executable as the embedded runtime (`ONDRA_ENGINE_BUN_EXE`), rather than downloading it again during compilation. Git Bash is also used by the engine's shell tool at runtime. Node, pnpm, Rust and Bun are build tools, not requirements to run the installed app.

### Prepare the engine

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

### Build and install

```powershell
$target = 'x86_64-pc-windows-msvc'   # aarch64-pc-windows-msvc on native ARM64
$env:RUSTUP_TOOLCHAIN = "1.95.0-$target"
rustup toolchain install $env:RUSTUP_TOOLCHAIN --profile minimal
pnpm install --frozen-lockfile --ignore-scripts
pnpm tauri build --target $target --bundles nsis --ci --no-sign '--' --locked
Get-ChildItem "src-tauri\target\$target\release\bundle\nsis\*-setup.exe"
```

If `CARGO_TARGET_DIR` is set, look under that directory instead of `src-tauri\target`. The pre-build step builds the remote helper and stages it as a Tauri sidecar. `pnpm tauri dev` prepares the same engine and helper. Remote project jobs are separate from desktop automation: Windows app observation and input are not available. Windows uses an NSIS installer, **not** `scripts/release.mjs`; this command neither signs nor publishes a release and does not write the macOS component/update manifest. The first build needs network access for dependencies; the installer may fetch WebView2 on systems without it.

CI silently installs the EXE into a temporary directory on the disposable runner. It verifies that `ondra-remote.exe` matches its freshly built sidecar by SHA-256, checks the engine's WASM, x64 native addon and notices, and runs the installed engine's `--version` against the pinned source package version. It also checks that the installed application opens a window and a second launch reuses the running instance. This does not check pairing or a job on a physical PC.

For a manual smoke test, run the setup EXE. In the **installed application directory** (not the NSIS output directory), check:

```powershell
Get-Item .\ondra.exe, .\ondra-remote.exe, .\engine\ondra-engine.exe, .\engine\package.json
.\engine\ondra-engine.exe --version
```

Launch Ondra from Start, run a small local job, then use **Settings → 연결** to pair with a second Ondra and exchange a job. This checks the installed engine and the remote helper, not just the presence of the files. See [remote control](remote-control.md) for the pairing flow.
