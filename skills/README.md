# Worker skills

Skills every worker loads. They ship inside the app (`app-skills/`) and
The app passes them to every pi worker with `--skill`.

| Skill | What it is for |
|---|---|
| `visual-report` | How workers report: JSON blocks the app draws (rings, bars, checklists, before/after, decision buttons) instead of prose. |
| `browser-use` | Browser use with the bundled agent-browser: one shared browser, own tab per worker, keychain sign-in, live stream, recordings as proof. |
| `web-design` | Designing pages that look made by a designer: real references first, concepts as live prototypes, the user picks, and the tells of AI-made pages to avoid. |
| `computer-use` | Computer use with the bundled agent-desktop: one worker at a time, headless input only, traces and screenshots as proof. |

The official agent-browser and agent-desktop skills ship with their binaries
(`agent-browser skills get core`, `agent-desktop skills get desktop`); these
files only add the app's rules on top, so they stay correct when the tools update.

## Environment a worker receives

Set by the app when it starts a worker (`worker_env` in `src-tauri/src/tools.rs`):

| Variable | Value |
|---|---|
| `PATH` | the app's bundled binaries first |
| `AGENT_BROWSER_SESSION` | `w-<worker id>-<shared browser port>` (`w-<worker id>` if the shared browser could not start) |
| `AGENT_BROWSER_CDP` | the shared browser's DevTools port (`src-tauri/src/browser.rs`) |
| `AGENT_BROWSER_PIN_TAB` | `1`: the session opens and keeps its own tab |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | the session daemon's idle timeout (its tab stays) |
| `AGENT_BROWSER_PLUGINS` | the `keychain` credential provider (`ondra --keychain-credential`, `src-tauri/src/keychain.rs`) |
| `AGENT_BROWSER_SKILLS_DIR` | bundled agent-browser skills |
| `AGENT_DESKTOP_MACOS_HELPER_PATH` | bundled macOS helper |
| `APP_WORKER_ID` | the worker's id |
| `APP_ARTIFACTS_DIR` | where screenshots and recordings go (one folder per worker) |
