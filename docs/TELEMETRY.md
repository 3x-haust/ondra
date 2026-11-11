# Telemetry

Ondra sends anonymous usage numbers to its maintainers so they can see which parts are used and where jobs fail. They go to [PostHog](https://posthog.com) (US cloud). All of it is in one file, [`src/lib/telemetry.ts`](../src/lib/telemetry.ts).

Turn it off in **Settings › General › Send anonymous usage statistics**. Nothing is sent after that.

## What is never sent

- What you asked, what a job answered, titles, memory, instructions
- File names, file contents, folders, branches, repository names
- Accounts, emails, keys, tokens
- Your IP address (PostHog is set to discard it)

This holds by construction, not by promise. Every event is one of the shapes below, and every property is a number, a yes/no or one of a fixed list of names. Anything else is refused before it is queued (`vet()`), so a title or a path has no field to travel in. A model is sent as its family (`claude-opus`, `gpt-5`, `other`), never the full id, so a private model's name stays private.

No session recording, no click capture. The "person" PostHog counts is this copy of the app: a random id (`ondra.telemetry.id`, kept on your Mac) carrying the app version, the macOS version and the UI language.

## What is sent

Every event carries the app version, the macOS version, the UI language and an id for this launch.

| Event | With |
|---|---|
| `app_launched` | whether it is this install's first launch; whether onboarding is done |
| `app_active` | minutes the window was in front (sent every five) |
| `settings_snapshot` | how many spaces, accounts, tasks, memories and skills; which providers are signed in (Anthropic, OpenAI, Google, other: yes/no each); which switches are on (worktrees, memory, PR watching, GitHub writes, focus guard, links inside); default permission; theme |
| `onboarding_finished` | whether an account was signed in |
| `view_opened` | which view (`main`, `task`, `board`, `devices`, `memory`, `results`, `changes`, `settings`) |
| `panel_opened` | which side-panel tab (`flow`, `changes`, `pr`, `files`, `terminal`, `browser`, …) |
| `command_used` | which built-in `/command`; a skill is only `skill`, anything else `other` |
| `message_sent` | where (`main` or `task`); nothing of what it said |
| `decision_answered` | seconds the question waited |
| `job_started` | kind (`job`, `subagent`, `review`, `answer`), provider, model family, thinking level, permission, weight, own worktree or not, from an issue or not |
| `job_finished` | the same, plus succeeded or not, seconds, tokens, subagents, unproven claims, whether you ended it yourself |
| `job_failed` | the same, plus why as one of `network`, `auth`, `usage_limit`, `context_limit`, `refused`, `engine_exit`, `timeout`, `no_model`, `unknown`, and the error message (see below) |
| `job_merged`, `job_discarded` | hours since the job was made |
| `update_installed` | whether it worked |
| `feedback_sent` | whether the log was attached |
| `telemetry_off` | |

Two things carry words, both cut short and with keys, tokens, emails and your home folder's name removed first:

- a failed job's error message (200 characters), beside `job_failed`
- an uncaught error in the app (`$exception`): its name, its message (300 characters) and a stack of file names and line numbers from Ondra's own code, at most five a launch

Dev builds (`pnpm tauri dev`) send nothing. Neither does a build without `VITE_POSTHOG_KEY` (a fork, or your own build from source): the switch is not shown, and there is no `/feedback`.

## Feedback

`/feedback` is separate from the numbers: it is sent only when you press **Send**, also when the numbers are off. By default it goes to the maintainers only, with the app version, the macOS version, the view you were in and, if ticked, the recent log (keys, tokens, emails and your home folder's name are removed before the log is written). It is never posted anywhere public.

### The log

The log is a file on your Mac (`logs/ondra-YYYY-MM-DD.log` in the app's data folder, a week kept). It leaves your Mac only attached to feedback you send. It holds the launch (versions, counts), the views you opened, each job's states and model by id, `/commands` by name, native commands that failed, errors you were shown, uncaught errors and native panics, parts arriving, the network going away, and updates. No titles, asks or file contents; **See what is sent** in the feedback sheet shows it before you send.
