<p align="center">
  <img src="docs/assets/readme-cover.svg" width="880" alt="Ondra">
</p>

<h1 align="center">Don't manage AI.<br>Delegate the work.</h1>

<p align="center">
  Ondra is an AI workspace that breaks down the work you delegate, uses the tools it needs, and brings back results it has checked.<br>
  The important decisions stay with you.
</p>

<p align="center">
  <a href="https://github.com/3x-haust/ondra/releases"><b>Download for macOS ↗</b></a> · <a href="#install">Install</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center"><sub>macOS 13+ · Apple silicon</sub></p>

<p align="center">
  <img src="docs/assets/main-en.png" width="880" alt="Ondra's main conversation brings together task progress and decisions that need you">
</p>

## Say what you want done. Work through the rest together.

**Break down the work.** Main turns your request into tasks, and each task follows its part through. Every project has its own conversation, and work started there runs in that folder.

**Use the right tools.** Code and documents, browsers, Mac apps and mobile devices. Each task uses the tools and skills the work calls for.

**Bring back checked results.** Main gathers what changed, how it was checked and what remains. A bug comes back with its cause and fix; research with an answer and sources; a release with what shipped and its current status.

<details>
<summary>See the work at a glance</summary>

The canvas shows how Main, projects, tasks and subagents connect, along with what each task is doing now.

<img src="docs/assets/canvas-en.png" width="880" alt="The canvas connects projects, tasks and subagents with their current progress">

</details>

<details>
<summary>Let Ondra look after sessions and context</summary>

- **A session per task:** each task has its own conversation. Enable per-task worktrees to keep Git changes separate from other tasks and your working folder.
- **Carry the work forward:** long tasks hand completed work, findings, next steps and evidence to a fresh session. Following up on a finished task or changing direction starts a new task that takes over the earlier results.
- **Reuse the cache:** shared instructions and account selection are arranged to reuse prompt caches. Actual cache use depends on the model and provider.

</details>

<br>

## The important decisions stay with you.

When your intent or taste matters, Ondra brings you choices with context. Pick one and press Enter, or write your own answer. You can also step into a running task and change its direction.

> Delegate the execution. Keep the decisions that set the direction.

### Results come with what was checked

- **Show the work:** plans, changed files and diffs, before-and-after screens, videos and test results. Open HTML results, tables, checklists and diagrams in the panel too.
- **Check the record:** completion reports are compared with the task's recorded commands, files and other evidence. Unverified items are marked separately.
- **Review where it matters:** plan and code reviews help check complex or sensitive changes. The review process follows the work's scope and project instructions.
- **Carry checks forward:** a passing check stays valid until the code it covers changes. Shipping alone is not a reason to repeat it.

<br>

## Tools for the work you delegate

**Browser.** Each task uses its own tab to read and interact with the web. Logins are shared within a workspace; passwords are entered through the macOS Keychain without reaching the model.

**Mac apps.** With the required permissions, tasks can operate an app on your Mac and capture its window to check the result. Foreground protection helps keep your own work in focus.

**Mobile.** With the platform tools installed, tasks can use iOS simulators and Android emulators to check a mobile app and capture its screen. Watch and interact with the device from Ondra.

**Deep research.** Split a question into research threads, investigate sources and check quotations against the originals. Bring the answer, evidence and comparisons together in a visual report and PDF.

<details>
<summary>Tool access and boundaries</summary>

- Mac app actions need Accessibility permission; window capture needs Screen Recording. Foreground protection is configurable and is not an OS-level isolation environment.
- Mobile tasks create their own devices by default. They can also use an explicitly allowed existing device; protected devices are left alone.
- Bundled skills include browser use, computer use, device use, deep research, code review, visual reports and web design. You can invoke one directly with `/skill:<name>`.

</details>

<br>

## A workspace that fits your work

Create and name workspaces around the way you work. Configure accounts and instructions for each, and keep their browser logins, memory and task history separate.

Choose your model, permissions and concurrency in Settings. Per-task worktrees, automatic memory saving and PR review follow-up are configurable too.

<details>
<summary>Keep pull requests with the work</summary>

Connect a GitHub account to view PR status, checks, reviews and changed files alongside the task. Hand review comments back to the task, or attach screenshots and videos to a PR.

Pushes and PR changes require GitHub write access. Enable automatic review follow-up in Settings if you want tasks to respond to new reviews, failed checks and conflicts.

</details>

<details>
<summary>More ways to make it yours</summary>

- **Memory:** keep useful preferences and lessons, or import existing notes. Automatic saving can be turned off.
- **Quick questions:** use `/btw` for an aside without interrupting the current conversation, or open side chat.
- **Search and shortcuts:** find tasks, projects, memories and commands. Customize keyboard shortcuts in Settings.
- **Hooks:** configure shell commands at the points in a task's lifecycle where you need them.
- **Notifications:** enable system notifications to hear when work finishes or needs your attention.
- **Usage data:** optional anonymous telemetry can be disabled in Settings. See [what is sent](docs/TELEMETRY.md).

</details>

<br>

## Install

**macOS 13+ · Apple silicon**

1. Download `Ondra_<version>_aarch64.dmg` from the [latest release](https://github.com/3x-haust/ondra/releases) and drag Ondra into Applications.
2. Open Ondra and connect a model account, such as ChatGPT/Codex or Claude, in Settings.
3. Choose a project and say what you want done.

Ondra checks GitHub Releases and offers updates in the app. Mac app actions and capture need **Accessibility and Screen Recording** permissions. To work with mobile devices, install **Xcode's iOS Simulator** or the **Android SDK emulator**.

<details>
<summary>If macOS blocks the first launch</summary>

Confirm that the app came from [this repository's releases](https://github.com/3x-haust/ondra/releases), then right-click it in Finder and choose **Open**. If the quarantine attribute still blocks it, you can run the following once, only for a download you trust:

```sh
xattr -dr com.apple.quarantine /Applications/Ondra.app
```

</details>

<details>
<summary>Build from source</summary>

```sh
pnpm install
cp .env.example .env           # fill in the values you need
pnpm bundle                    # prepare tools, the agent engine and app components
pnpm tauri dev                 # run in development
pnpm release notes.md          # release build (see scripts/release.mjs)
```

- The agent engine comes from [3xhaustpi](https://github.com/3x-haust/3xhaustpi). Put it in a sibling folder or point `ONDRA_ENGINE_DIST` at `packages/coding-agent/dist`.
- The engine, Chrome and binary analyzer are components downloaded once per version. Updates use the app and any changed components; the DMG's app includes these components.
- Static binary analysis includes radare2, r2ghidra, native libraries and processor data, with no separate analysis engine to install. See [build and package checks](tools/binary-analysis/README.md).

</details>

<details>
<summary>Local settings and repository layout</summary>

### Local settings (`.env`)

| Key | Meaning |
|---|---|
| `ONDRA_PROTECTED_DEVICES` | Devices no task may boot or operate (regex) |
| `ONDRA_DEVICES_ALLOWED` | Devices a task may use besides the ones it created |

Development builds read the repository's `.env`; the installed app reads `~/Library/Application Support/dev.3xhaust.ondra/.env`.

### Layout

```text
src/                 SolidJS UI
  engine/            main conversation and tasks, prompts, engine connection
  views/ ui/         screens and components
  styles/            design tokens
src-tauri/src/       Rust: engine process, browser, worktrees, keychain, devices
skills/              skills for tasks
extensions/          permissions, computer/device use, hooks, memory and other engine extensions
brand/ docs/         brand and documentation
```

</details>

---

<p align="center">
  <a href="https://github.com/3x-haust/ondra/releases">Releases</a> · <a href="docs/TELEMETRY.md">Telemetry</a> · <a href="https://github.com/3x-haust/ondra/issues">Report an issue</a>
</p>
