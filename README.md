<p align="center">
  <img src="docs/assets/logo.svg" width="88" alt="">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark-light.svg" height="40" alt="Ondra">
  </picture>
</p>

<p align="center"><b>Make what AI says visible.</b></p>

<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<p align="center">
  <a href="https://github.com/3x-haust/ondra/releases"><img src="https://img.shields.io/github/v/release/3x-haust/ondra?include_prereleases&label=release&color=1f6fd8" alt="release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%2013%2B%20·%20Apple%20silicon-18181b" alt="platform">
  <img src="https://img.shields.io/badge/status-beta-f59e0b" alt="beta">
</p>

<p align="center">
  <img src="docs/assets/main.png" width="880" alt="Ondra main view">
</p>

Ondra is an agent workspace for macOS. You tell the main chat once; it splits the work across several agents, and each one sees its part through to the end. You only watch the main chat. Long, hard-to-read LLM output turns into progress bars, changed files, screens and choices.

## What it does

**Main splits the work.** A request like "build me a portfolio site" becomes checking the material, finding references, planning, building and verifying, and each step starts only when the one before it is done. Every job runs on its own worktree in the project folder.

**See it instead of reading it.** Jobs report in blocks, not prose: plan and progress, changed files with line counts, before/after screenshots, tables, checklists. Dozens of tool calls fold into "edited 5 files", "ran 3 commands".

**It only asks what needs you.** Only questions that need your intent or taste come up to main, with choices and context attached. Pick one, then press Enter, or write your own answer.

<p align="center">
  <img src="docs/assets/job.png" width="880" alt="A job and its question card">
</p>

**It has hands and eyes.**
- Shared browser: one headless Chrome inside the app; every job gets its own tab. You sign in once, straight from the macOS Keychain. Passwords never reach the model.
- Computer use: drives Mac apps through the Accessibility API, without taking your mouse or focus.
- Device use: each job makes its own iOS simulator or Android emulator and removes it when done. You can watch and touch the device screen alongside it.

**Canvas and memory.** The canvas shows how projects and jobs connect at a glance. Rules, taste and lessons stay in memory, and only what's relevant is pulled in when needed.

<p align="center">
  <img src="docs/assets/canvas.png" width="880" alt="Canvas">
</p>

## Install

1. Download `Ondra_<version>_aarch64.dmg` from [Releases](https://github.com/3x-haust/ondra/releases) and drag Ondra into Applications.
2. Beta builds are not notarized yet. The first time, right-click the app in Finder and choose **Open**, or run once:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ondra.app
   ```
3. Connect a model account (Codex/ChatGPT, …) in Settings and you're ready. Computer use asks once for Accessibility and Screen Recording permission.

Requirements: macOS 13 or later, Apple silicon. Device use needs Xcode (iOS Simulator) or the Android SDK (emulator).

## Build from source

```sh
pnpm install
cp .env.example .env        # fill in values if you need them
pnpm bundle                 # agent-browser, agent-desktop, the engine and headless Chrome into the app
pnpm tauri dev              # run in development
pnpm tauri build && pnpm dmg   # .app, then the install .dmg (pip install ds_store mac_alias)
```

- The agent engine is the coding-agent from [3xhaustpi](https://github.com/3x-haust/3xhaustpi), built into a single file. Put it in a sibling folder or point `ONDRA_ENGINE_DIST` at it.
- On macOS 27, agent-desktop 1.1.0 hangs on every command when an app with pid -1 (Xcode's Device Hub) is running. Build it with the patch in `scripts/patches/` and put the binary at `~/.cache/ondra/agent-desktop-patched`; the bundle step uses it.

### Local settings (`.env`)

| Key | Meaning |
|---|---|
| `ONDRA_PROTECTED_DEVICES` | Devices no job may boot or touch (regex), e.g. simulators shared by a team |
| `ONDRA_DEVICES_ALLOWED` | Devices a job may use besides the ones it made itself |

Development builds read the repo's `.env`; the installed app reads `~/Library/Application Support/dev.3xhaust.ondra/.env`.

## Layout

```
src/                 SolidJS UI
  engine/            main chat (captain) and jobs (tasks), prompts, engine RPC
  views/ ui/         screens and parts · styles/ design tokens
src-tauri/src/       Rust: engine process, shared browser, keychain, devices, notifications
skills/              skills every job gets (visual-report, browser-use, computer-use, device-use, web-design …)
extensions/          engine extensions (device tool, permissions, hooks, memory)
evals/               harness evals and the improvement loop
brand/ docs/         brand and design system
```

## Evals and the improvement loop

The bar for changing Ondra is "does it do the next request well on its own". The cases in `evals/cases/` are sent to main for real and graded.

```sh
node evals/run.mjs                  # all
node evals/run.mjs cu-calculator    # just one
```

Each case checks: whether it finished, the answer, evidence screenshots, time taken, tool count, failed tools, whether it took focus, and whether it cleaned up its devices. Results go to `evals/results/`; what was learned goes to `evals/LEARNINGS.md`. In Claude Code, `/ondra-eval` (or `/loop /ondra-eval`) repeats run → find the cause → fix skills, prompts or tools → run again.
