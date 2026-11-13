# Worker skills

Skills every worker loads. They ship inside the app (`app-skills/`) and
The app passes them to every pi worker with `--skill`.

| Skill | What it is for |
|---|---|
| `visual-report` | How workers report: JSON blocks the app draws (rings, bars, checklists, before/after, decision buttons) instead of prose. |
| `browser-use` | Browser use with the bundled ondra-browser (our own browser tool, `src-tauri/helpers/browser`): one shared browser, own tab per worker, keychain sign-in, live stream, recordings as proof. |
| `web-design` | Designing pages that look made by a designer: real references first, concepts as live prototypes, the user picks, and the tells of AI-made pages to avoid. |
| `mimikyu` | Implementing supplied designs (Figma links, 피그마 그대로, 디자인 그대로): save the design contract, build, measure pixels and DOM, then fix until the gates pass. Available to every job without a personal skill install; Figma access and project measurement dependencies are checked when used. |
| `motion-graphics` | Promo and launch films, reels and kinetic type (모션그래픽, 홍보 영상): strong product films as references, a beat-timed structure, scenes as deterministic HTML rendered to MP4 with motion blur, synthesized sound, and measured flicker and loudness checks. |
| `logo-design` | Logos, brand marks and wordmarks (로고, 브랜드 키트): a brief, real references, a few distinct concepts as hand-built SVG with their construction, measured checks (16px, one colour, light/dark contrast, likeness to known marks), a comparison page the user picks from, then a brand kit (lockups, favicon set, palette, type, OG image, usage guide). |
| `modern-web-guidance` | Current HTML, CSS and client-side JS practice from the Chrome team, offline: 209 short guides (dialogs, popovers, forms, accessibility, performance…) found through `guides/INDEX.md`, read when UI code is written. |
| `goal-loop` | A goal to finish completely ("루프", "될 때까지", "100%"): the user's intent written as checks, then fix → re-check until all pass. |
| `qa` | QA by using the app ("QA 해줘", "다 눌러봐", "출시 전에 점검"): scope from a diff or the screen map, a risk-ordered plan, fast sweeps (`sweep.sh`), confirmed issues with evidence, report-only or fix until no P1/P2 remain. |
| `test-ci` | Tests and CI the way large open-source projects do them: behaviour tests that fail for real, local scripts first, a locked-down GitHub Actions workflow checked locally. |
| `deep-research` | Research with sources (리서치, 조사해서 정리, 논문 찾아): plan sub-questions, search and read primary sources in rounds with findings on disk, check every claim, then a visual HTML report shown in the chat and printed to PDF (`pdf.sh`). |
| `office-docs` | Word, Excel, PowerPoint, PDF and HWPX files: read them with `office.py` (no install), pick the library for a change, keep an existing file's look, and check the result as page pictures. |
| `computer-use` | Mac app automation in the background through the `computer` tool and its `ondra-cuhost` helper: one target app at a time, the user's focus and cursor untouched, screenshots as proof. |
| `stack-diagram` | Architecture, stack and infra diagrams with official logos (아키텍처·스택 다이어그램, 시스템 구성도) as one self-contained HTML and light/dark PNGs. Vendored from [caru-ini/stack-diagram](https://github.com/caru-ini/stack-diagram) at `9175bde` (MIT, `LICENSE`; fonts SIL OFL); Ondra's only changes are the PNG fallback to its bundled headless Chrome in `render_png.py` and a few notes in `SKILL.md`. |
| `secrets` | API keys, tokens and .env files: use Ondra's secrets as `$NAME` without seeing values, find and save what each one is for in memory, and what to do when one is missing or pasted into the chat. |

## When a skill is offered

Each user message is matched against the skills' names and descriptions, and
the ones that clearly fit go to the model with that message. While a job works,
a skill can also be offered by what the work does, named in its frontmatter
(one regular expression each):

```yaml
metadata:
  ondra-commands: '\bondra-browser\b'    # a shell command
  ondra-writes: '\.github/workflows/'     # a file edited or written
  ondra-reads: '/Contents/MacOS/'          # a file read
  ondra-urls: 'figma\.com/design/'         # a link in a message or a fetch
  ondra-tools: 'computer,device'          # a tool called
```

The first match adds a short note to that tool's result. A skill the job has
already read is not offered again until its conversation is compacted.

`ondra-browser --help` lists every browser command (`<command> --help` for
one); these files carry the app's rules for using them.

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
| `ONDRA_BROWSER_SESSION` | `w-<worker id>-<shared browser port>` (`w-<worker id>` if the shared browser could not start) |
| `ONDRA_BROWSER_CDP` | the shared browser's DevTools port (`src-tauri/src/browser.rs`) |
| `ONDRA_BROWSER_PIN_TAB` | `1`: the session opens and keeps its own tab |
| `ONDRA_BROWSER_IDLE_TIMEOUT_MS` | the session daemon's idle timeout (its tab stays) |
| `ONDRA_BROWSER_KEYCHAIN` | the keychain helper for `auth login` (`ondra --keychain-credential`, `src-tauri/src/keychain.rs`) |
| `ONDRA_BROWSER_EXECUTABLE_PATH` | the bundled Chrome, for a session that starts a browser of its own |
| `ONDRA_BROWSER_INIT_SCRIPTS` | `browse`'s `net.js`, run in every page of the job's tab |
| `APP_WORKER_ID` | the worker's id |
| `APP_ARTIFACTS_DIR` | where screenshots and recordings go (one folder per worker) |
| `APP_SCRATCH_DIR` | builds, caches and scratch work (one folder per worker, in the system temp folder) |
