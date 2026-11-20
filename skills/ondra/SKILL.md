---
name: ondra
description: >
  Ondra (온드라) itself, the app this runs in: what an Ondra feature, button or screen is
  and where it lives (온드라 기능, 온드라 설정, 이 화면, 내 차례, 캔버스, 결과물), changing
  Ondra's settings for the user (에이전트 설정, 디스코드 에이전트, 디스코드 연결, 테마, 동시
  작업, 기본 권한, 워크트리), and a feature or bug for Ondra (온드라 기능 추가, Ondra feature
  request, Ondra bug) turned into a short proposal and, when they say so, a pull request to
  3x-haust/ondra.
---

# Ondra

You run inside Ondra, a macOS app (Tauri, SolidJS, Rust) where one chat hands work to jobs that
run side by side. Open source: <https://github.com/3x-haust/ondra> (MIT). This skill is for
questions about the app, changing its settings for the user, and changing the app itself.

## What is where

The left bar: **메인** (the chat; each project has its own chat too), **캔버스** (main,
projects, jobs and subagents as a live map), **메모리**, **결과물** (everything jobs made),
**내 차례** (questions and work waiting on the user), **프로젝트** with their jobs, **디바이스**
(iOS simulators, Android emulators), **설정** at the bottom.

| Thing | What it does |
|---|---|
| Main chat | Splits a request into jobs, answers, remembers; a project's chat works in that folder |
| Job (작업) | Its own session, worktree (when 작업마다 새 워크트리 is on), browser tab; plan, evidence, unverified items |
| Question card | A job needs the user: numbered choices, or type another answer in the input under it |
| Land question | A job left changed files: PR로 올리기 (recommended) or 버리기. A project whose origin is on GitHub is never merged into locally: when a job's PR is merged, Ondra removes the job's worktree and fast-forwards the folder's local main to GitHub's latest (checked out or not; never a merge commit, never over an uncommitted change). Other folders also get 합치기 (local merge into the checked-out branch, no push) |
| 확인 못 함 | What a job couldn't check; it asks before it ends |
| 결과물 | Files, pages, reports, screenshots jobs made |
| 메모리 | Rules, decisions, preferences, lessons; the same answer three times stops the question |
| 루틴 | Scheduled reminders or jobs, or jobs on GitHub events ("3시에 알려줘", "매일 9시에 …") |
| `/btw` | A quick side question without stopping the chat |
| `/skill:<name>` | Call a skill by name |
| `/feedback` | Send feedback with recent logs to Ondra's maintainers |
| Pet | A desktop pet; `/pet 피카츄` makes one |
| 다른 Mac | Run jobs on another of the user's Macs (Settings › 연결), end-to-end encrypted |
| 에이전트 | Ondra on Discord, as itself (main is the agent, not a relay): the user's words there are main's; others only get talk. Its own memory (people, the server, lessons; Settings › 에이전트 › 기억) is apart from the work memory. Main acts on the server with the `discord` tool (servers, channels, make or remove one, post) |

Settings tabs: 일반 (theme, size, language, links, default model and permission, parallel jobs,
worktrees, PR review follow-up, GitHub push/PR, auto memory, job browser preview, job sound,
common instructions, updates, telemetry), 계정과 워크스페이스, 연결, 에이전트, 펫, then
도구, 스킬, 훅, 루틴, 시크릿 (agents), then macOS 권한, 가져오기, 단축키 (this Mac).

Not sure where something is, or how it behaves exactly? Read the code (below) instead of
guessing, and say what you checked.

## Changing a setting

Use `ondra_settings`: no arguments reads every setting (value, where it is, what it takes);
`changes` sets some. Change only what the user asked; say what was and what is now, in one
line each.

The Discord agent ("에이전트 설정해줘", "디스코드 연결해줘"):
1. Read the settings. `agent.token` says whether a bot token is in the keychain.
2. No token: the user needs a bot. Discord Developer Portal → New Application → Bot →
   Reset Token, turn on **MESSAGE CONTENT INTENT**, invite it with the `bot` scope (Send
   Messages, Read Message History, Add Reactions). Ask them to save the token in
   Settings › 시크릿 under a name (e.g. `DISCORD_BOT_TOKEN`). Never ask them to paste it in
   the chat. If a saved secret already looks like it (`$NAME` in a shell shows it exists, the
   secrets skill has how), use that name.
3. `{"agent.token": "<NAME>"}`: the value moves inside the app; you never see it.
4. Then what they asked: `agent.name`, `agent.space`, `agent.channels`, `agent.voice`; and
   `{"agent.on": true}` last. `agent.ownerId` can stay empty: the bot's owner is the user.
5. Read again: say it is connected, or why not (a wrong token, the intent off).

## A feature they want, or a bug in Ondra

1. **Does it exist?** Check the table, Settings, and the code. If it does, show how to use it
   (where, which keys). Done.
2. **Understand it.** One question at most, only if it could mean two different things.
3. **Propose, briefly**: what the user will see change (where in the app, one or two
   sentences each), what it touches (front end, Rust, engine prompt, a skill), and what is out
   of scope. For a bug: what happens, what should happen, how you'd reproduce it, from the
   logs (`~/Library/Application Support/dev.3xhaust.ondra/logs/`) if they help.
4. **Ask**, with an ask block: "이대로 Ondra에 PR 올릴까요?", options **PR 올리기**
   (recommended), **더 다듬기**, **그만**. Nothing is cloned or changed before the answer.
5. **On PR 올리기**:
   - The repo: a clone the user already has (memory, or `git -C <dir> remote -v` showing
     `3x-haust/ondra`), else `gh repo clone 3x-haust/ondra` into a work folder. No push
     rights (`gh repo view 3x-haust/ondra --json viewerPermission`) → fork, push to the fork.
   - A branch from the latest `origin/main` (`feat/…`, `fix/…`); the coding-playbooks skill
     for the work itself. Read `AGENTS.md` / `CLAUDE.md` in the repo first.
   - Where things are: `src/` (SolidJS app; `src/engine/` main, jobs, memory, prompts;
     `src/views/` screens, `src/views/Settings.tsx` settings; `src/i18n/en/` English text,
     the Korean string is the key), `src-tauri/src/` (Rust: windows, keychain, git, Discord,
     remote), `extensions/` (engine tools), `skills/` (skills shipped with the app, this one
     included), `docs/`.
   - Check before the PR: `pnpm install`, `npx tsc --noEmit`, `npx vitest run`, and
     `cargo test` in `src-tauri/` when Rust changed. A test that fails without the change.
     Running the whole app (`pnpm tauri dev`) takes long and opens a second Ondra: only when
     the user asks.
   - The PR to `3x-haust/ondra` `main`: title in Conventional Commits; body in the user's
     language: why, what changed (what they will see), how it was checked, what wasn't.
     Never merge it or make a release; say the link and that the maintainers review it.

## Questions about Ondra

Answer from what you checked: this skill, the app's code, the repo's `README.md` and `docs/`.
One or two lines plus where to click; a picture of the screen (a screenshot the user sent)
is read for its labels first. If it isn't in Ondra, say so and offer step 3 above.
