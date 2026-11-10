# Worker skills

Skills every worker loads. They ship inside the app (`app-skills/`) and
The app passes them to every pi worker with `--skill`.

| Skill | What it is for |
|---|---|
| `visual-report` | How workers report: JSON blocks the app draws (rings, bars, checklists, before/after, decision buttons) instead of prose. |
| `browser-use` | Browser use with the bundled agent-browser: one shared browser, own tab per worker, keychain sign-in, live stream, recordings as proof. |
| `web-design` | Designing pages that look made by a designer: real references first, concepts as live prototypes, the user picks, and the tells of AI-made pages to avoid. |
| `mimikyu` | Implementing supplied designs (Figma links, 피그마 그대로, 디자인 그대로): save the design contract, build, measure pixels and DOM, then fix until the gates pass. Available to every job without a personal skill install; Figma access and project measurement dependencies are checked when used. |
| `goal-loop` | A goal to finish completely ("루프", "될 때까지", "100%"): the user's intent written as checks, then fix → re-check until all pass. |
| `qa` | QA by using the app ("QA 해줘", "다 눌러봐", "출시 전에 점검"): scope from a diff or the screen map, a risk-ordered plan, fast sweeps (`sweep.sh`), confirmed issues with evidence, report-only or fix until no P1/P2 remain. |
| `test-ci` | Tests and CI the way large open-source projects do them: behaviour tests that fail for real, local scripts first, a locked-down GitHub Actions workflow checked locally. |
| `deep-research` | Research with sources (리서치, 조사해서 정리, 논문 찾아): plan sub-questions, search and read primary sources in rounds with findings on disk, check every claim, then a visual HTML report shown in the chat and printed to PDF (`pdf.sh`). |
| `computer-use` | Computer use with the bundled agent-desktop: one worker at a time, headless input only, traces and screenshots as proof. |

## When a skill is offered

Each user message is matched against the skills' names and descriptions, and
the ones that clearly fit go to the model with that message. While a job works,
a skill can also be offered by what the work does, named in its frontmatter
(one regular expression each):

```yaml
metadata:
  ondra-commands: '\bagent-browser\b'    # a shell command
  ondra-writes: '\.github/workflows/'     # a file edited or written
  ondra-reads: '/Contents/MacOS/'          # a file read
  ondra-urls: 'figma\.com/design/'         # a link in a message or a fetch
  ondra-tools: 'computer,device'          # a tool called
```

The first match adds a short note to that tool's result. A skill the job has
already read is not offered again until its conversation is compacted.

The official agent-browser and agent-desktop skills ship with their binaries
(`agent-browser skills get core`, `agent-desktop skills get desktop`); these
files only add the app's rules on top, so they stay correct when the tools update.

## Verify the macOS bundle

After building the app, check the packaged files and the bundled engine's skill
loader (no model request or personal skill installation):

```sh
node scripts/check-bundled-skills.mjs src-tauri/target/debug/bundle/macos/Ondra.app
```

Use `target/release` instead of `target/debug` for a release build. The check
compares `skills/mimikyu/` and all its supporting files byte-for-byte with
`Contents/Resources/app-skills/mimikyu/`, requires the `browser-use` prerequisite,
and asks the app's own engine for `get_commands` with the worker's
`--no-skills --skill ...` loading pattern. Its home and configuration are empty
temporary directories; it must find exactly one `skill:mimikyu` at the bundled
path. This verifies packaging and engine discovery, not a model's decision to
read the full skill or a Figma implementation.

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
| `APP_SCRATCH_DIR` | builds, caches and scratch work (one folder per worker, in the system temp folder) |
