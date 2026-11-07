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

Ondra is an agent workspace for macOS. Tell the main chat what you want, once. It splits the work into jobs, each job sees its part through to the end on its own branch, and the result comes back to main: what changed, why, and how it was checked. Long, hard-to-read model output turns into progress, changed files, screens and choices.

<table>
  <tr>
    <td width="50%" valign="top">
      <b>One chat, many jobs</b><br>
      Main plans, hands out the work and reports back. You don't have to watch each job.
    </td>
    <td width="50%" valign="top">
      <b>Work and personal, kept apart</b><br>
      Each space has its own git accounts, browser logins, memory, devices and history.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <b>Shown, not told</b><br>
      Plans, to-dos, diffs, before/after screenshots, test results and diagrams instead of paragraphs.
    </td>
    <td valign="top">
      <b>Proof, not claims</b><br>
      Every "done" is checked against what the job actually ran. Whatever wasn't checked says so.
    </td>
  </tr>
</table>

## How it works

**Main splits the work.** "Build me a portfolio site" becomes checking the material, finding references, planning, building and verifying, and each step starts when the one before it is done. Every project folder gets its own chat, and jobs started there work in that folder.

**Each job has a fresh start.** A job works in its own git worktree, starting from the latest remote code, so jobs never overwrite each other or the folder you are working in. More work on a finished job starts a new job that takes over its branch and results. When you change direction mid-way, the old job wraps up and a new one picks up.

**Results come back to main.** When a job ends, main tells you in its own words, shaped to the work: the cause, the fix and the check for a bug; what changed for a feature; what went out for a release; the answer and its sources for research.

**It only asks what needs you.** Questions that need your intent or taste come up with choices and the context behind them. Pick one and press Enter, or write your own answer. You can also step into any running job and redirect it.

<p align="center">
  <img src="docs/assets/job.png" width="880" alt="A job and its question card">
</p>

## Spaces

Work and personal are separate workspaces, not filters. Switching spaces switches everything:

- **Accounts:** commits, pushes, PRs and terminals run as that space's git identity and GitHub login. A space without one says so instead of borrowing the other's.
- **Browser:** logins and cookies stay in their space.
- **Memory and skills:** what Ondra learned in one space is used only there.
- **Devices:** each simulator and emulator belongs to work, personal or both.
- **History:** search, side chat, `btw` and the input history see only this space. Jobs can't read other jobs' or other spaces' files and logs.

## What jobs can see and use

**Shared browser.** A real Chrome inside the app, with a tab per job. Sign in once in the panel and that space's jobs use the session. Passwords come from the macOS Keychain and never reach the model. With Aside installed, jobs browse through it.

**Computer use.** Native Mac app automation requires a separately prepared, isolated macOS guest. It does not control windows already open on your Mac. Known host desktop commands are blocked, including process-targeted input; without a verified guest connection, native app automation stops instead of switching to your desktop. These command checks are not an OS sandbox for arbitrary shell commands.

**Device use.** Each job makes its own iOS simulator or Android emulator, leaves screenshots as evidence and removes it when done. You can watch and touch the screen from the device panel. Emulators render on the Mac GPU and idle when nothing changes.

**Deep research.** Several researchers search in parallel and write one report: the answer and what to do first, how it works as a step diagram, and options compared side by side, with a PDF.

## Shown, not told

Jobs report in blocks that the app draws:

- plan and to-do list, kept in step with the work
- changed files with line counts, and the diff in the panel
- before/after screenshots, videos and HTML pages, opened in the panel
- test results, tables, checklists and diagrams of structure and flow
- evidence for each claim, marked as checked by the app or not

The canvas shows how main, projects, jobs and sub-agents connect, and what each one is doing right now.

<p align="center">
  <img src="docs/assets/canvas.png" width="880" alt="Canvas">
</p>

## Proof and review

- **Evidence is checked.** The app compares a job's "done" with its session: did that command run, did it pass, did code change after it, does the file exist. A job that doesn't add up is sent back, and what stays unproven is listed.
- **Review before it ships.** Large or risky changes get a review sub-agent before anything is pushed, merged or released. The job fixes what it found.
- **No checking twice.** A check that passed stays valid until a change touches what it covered, so a release doesn't re-test the fix that came before it.

## Pull requests

- **PR tab.** A job's pull request opens in the side panel: state, checks, reviews and comment threads, and the changed files with line comments placed at their lines. Hand any comment to the job in one click.
- **Pictures in PRs.** Jobs put screenshots and videos into the PR description, a comment, a review reply or a comment on one line, uploaded the same way GitHub's own editor does.
- **Watching (opt-in).** Turn it on in Settings and Ondra checks the PRs jobs opened. New reviews, failed checks and conflicts go back to the job, which fixes and replies in the thread.

## More

- **Memory:** rules, taste and lessons, pulled in only when relevant. A graph view shows how they connect. Notes from other tools (CLAUDE.md, AGENTS.md…) can be brought in.
- **btw and side chat:** ask a quick question about any conversation without interrupting it (`/btw`), or keep a second conversation per space (⌘J).
- **Search (⌘K):** jobs, projects, memory and commands.
- **Hooks:** run your own shell commands before or after tools, on a request, or when a job starts or stops, per space.
- **Notifications:** finished, needs an answer or stuck, with the space's name, when the window is in the back.
- **Skills:** browser use, computer use, device use, deep research, code review, visual reports, web design and more. Call one with `/skill:<name>`.

## Install

1. Download `Ondra_<version>_aarch64.dmg` from [Releases](https://github.com/3x-haust/ondra/releases) and drag Ondra into Applications.
2. Beta builds are not notarized yet. The first time, right-click the app in Finder and choose **Open**, or run once:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ondra.app
   ```
3. Connect a model account (ChatGPT/Codex, Claude, …) in Settings. Native computer use requires a separate macOS guest with its own apps and permissions; granting host Accessibility or Screen Recording permission does not provide an isolated environment.

Ondra checks GitHub Releases and offers to update itself.

Requirements: macOS 13 or later, Apple silicon. Device use needs Xcode (iOS Simulator) or the Android SDK (emulator).

## Build from source

```sh
pnpm install
cp .env.example .env           # fill in values if you need them
pnpm bundle                    # browser, desktop, agent engine, Chrome and native binary analyzer into the app
pnpm tauri dev                 # run in development
pnpm tauri build && pnpm dmg   # .app, then the install .dmg (pip install ds_store mac_alias)
pnpm manifest                  # latest.json for in-app updates (build with TAURI_SIGNING_PRIVATE_KEY set)
```

- Static binary analysis ships with radare2 and r2ghidra, including native libraries and processor data; users need no separate engine or runtime. Build and isolated package checks: [binary analyzer](tools/binary-analysis/README.md).
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
src-tauri/src/       Rust: engine process, shared browser, worktrees, keychain, devices, notifications
skills/              skills every job gets
extensions/          engine extensions (permissions, devices, hooks, memory)
evals/               harness evals and the improvement loop
brand/ docs/         brand and design system
```

## Evals

The bar for changing Ondra is "does it do the next request well on its own". The cases in `evals/cases/` are sent to main for real and graded; `evals/main/` checks how main routes requests.

```sh
node evals/run.mjs                  # all
node evals/run.mjs cu-calculator    # just one
node evals/main-sim.mjs --parallel 5 <cases>   # main's routing
```

Each case checks whether it finished, the answer, evidence screenshots, time taken, tool count, failed tools, whether it took focus, and whether it cleaned up its devices. Results go to `evals/results/`; what was learned goes to `evals/LEARNINGS.md`.
