---
name: ondra
description: >
  Ondra (온드라) itself, the app this runs in: what an Ondra feature, button or screen is
  and where it lives (온드라 기능, 온드라 설정, 이 화면, 내 차례, 캔버스, 결과물), pressing
  what the user could press in Ondra (연결 링크, 다른 Mac 연결, 프로젝트 추가, 작업 보관·고정,
  워크스페이스 추가, 업데이트, 화면 열기), changing Ondra's settings for the user (에이전트 설정, 디스코드 에이전트, 디스코드 연결, 테마, 동시
  작업, 기본 권한, 워크트리), the Discord agent's own ways for this user (멘션 없이 듣기, 이
  채널에선 조용히), and a feature or bug for Ondra (온드라 기능 추가, Ondra feature
  request, Ondra bug) turned into a short proposal and, when they say so, a pull request to
  3x-haust/ondra.
metadata:
  ondra-menu: 'hidden'
---

# Ondra

You run inside Ondra, a macOS app (Tauri, SolidJS, Rust) where one chat hands work to jobs that
run side by side. Open source: <https://github.com/3x-haust/ondra> (MIT). This skill is for
questions about the app, changing its settings for the user, and changing the app itself.

## What is where

The left bar: **메인** (the chat; each project has its own chat too), **캔버스** (main,
projects, jobs and subagents as a live map), **메모리**, **결과물** (everything jobs made),
**에이전트** (the Discord agent's own talk and work, when it is on), **내 차례** (questions and work waiting on the user), **프로젝트** with their jobs, **디바이스**
(iOS simulators, Android emulators), **설정** at the bottom.

| Thing | What it does |
|---|---|
| Main chat | Splits a request into jobs, answers, remembers; a project's chat works in that folder |
| Job (작업) | Its own session, worktree (when 작업마다 새 워크트리 is on), browser tab; plan, evidence, unverified items |
| Question card | A job needs the user: numbered choices, or type another answer in the input under it |
| Land question | A job left changed files: the job settles what becomes of them from the user's words, the project's memory and the repo (a PR, merging it, a release after it, a local merge, keeping the branch), and asks its own question with options that fit when those don't settle it. Nothing set is asked after it; the user can always tell the job what to do. A project whose origin is on GitHub is never merged into locally: when a job's PR is merged, Ondra removes the job's worktree and fast-forwards the folder's local main to GitHub's latest (checked out or not; never a merge commit, never over an uncommitted change). Other folders also get 합치기 (local merge into the checked-out branch, no push) |
| 확인 못 함 | What a job couldn't check; it asks before it ends |
| 결과물 | Files, pages, reports, screenshots jobs made |
| 메모리 | Rules, decisions, preferences, lessons; the same answer three times stops the question |
| 루틴 | Scheduled reminders or jobs, or jobs on GitHub events ("3시에 알려줘", "매일 9시에 …") |
| `/btw` | A quick side question without stopping the chat |
| `/skill:<name>` | Call a skill by name |
| `/feedback` | Send feedback with recent logs to Ondra's maintainers |
| Pet | A desktop pet; `/pet 피카츄` makes one |
| 다른 Mac | Connect another of the user's Macs or PCs (Settings › 연결): each runs jobs on the other, end-to-end encrypted |
| 에이전트 | Ondra on Discord, as itself: the user's words there go to the agent's own chat (Ondra main with its own session), not the user's main. Its talk, its jobs (kept out of projects, 내 차례, canvas and 결과물), its questions and its memory (people, the server, lessons) are in the sidebar's 에이전트 tab, view only; work memory is shared. Others only get talk. The `discord` tool (servers, channels, make or remove one, post, read a channel's recent messages, delete messages) is the agent chat's |

Settings tabs: 일반 (theme, size, language, links, default model and permission,
worktrees, GitHub push/PR, merging checked fixes, running the app before finishing, auto memory, rules into checks, skill fix suggestions, the job browser, alert sound,
common instructions, updates, telemetry; PR review follow-up is not on the page, only `watchPullRequests` in ondra_settings), 계정과 워크스페이스, 연결, 에이전트, 펫, then
도구, 스킬, 훅, 루틴, 시크릿 (agents), then macOS 권한, 가져오기, 단축키 (this Mac).

Not sure where something is, or how it behaves exactly? Read the code (below) instead of
guessing, and say what you checked.

## Pressing something in Ondra

Anything the user could click in Ondra, you do with `ondra_app`: `{"action":"list"}` lists
every action with the button it stands for and what it takes; then `{"action":"remote.link"}`,
`{"action":"project.add","args":{"folder":"~/code/blog"}}` and so on. Never tell the user to click
something an action does, and never say you can't press Ondra. A setting (on/off, a number, a
choice) is `ondra_settings` instead.

Another Mac or PC ("윈도우에서 이 맥 연결", "다른 맥 추가"): a connection goes both ways, so this is
done once, from either side.
1. `remote.link` makes this Mac's link (10 minutes, one device). Put it in on the other one
   (there: 설정 › 연결 › 기기 추가; with computer use, paste it there).
2. The other one connects and this Mac asks the user to allow it (a card in Ondra): that click
   is theirs. Say so in a line, and check `remote.status` after.
`remote.add` with the other device's link only uses that device (one way): letting a device in
stays the user's, so for both ways make this Mac's link instead, or the user pastes the link in
설정 › 연결 › 기기 추가.

What stays the user's: letting a Mac in, a job's security approvals, and secret values.

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
4. Then what they asked: `agent.name`, `agent.space`, `agent.channels`, `agent.voice`,
   `agent.account` (the AI account it talks and works on: an account id of its workspace, or
   `auto`); and
   `{"agent.on": true}` last. `agent.ownerId` can stay empty: the bot's owner is the user.
5. Read again: say it is connected, or why not (a wrong token, the intent off).

How the Discord agent is, the user's own way ("멘션 안 해도 들어", "이 채널에선 조용히 있어",
"민수 말은 다 받아", "매번 답하지 말고 보다가 끼어들어", "민수한텐 존댓말"): not a setting and not a
PR, but its own ways file, plain lines it keeps itself, on their Mac only: `agent/AGENT.md` in
Ondra's data folder (`~/Library/Application Support/dev.3xhaust.ondra/`; a message from Discord
names the exact path and says what is in it now). Read it first, keep what is there, one short
line per way in the user's words (a channel or person by name and id), drop one they take back,
and say in a line what it does now. It counts from the next message, nothing to restart.
- Empty or missing: the usual way only (a DM, a mention, a reply to it, its name, a question of
  its waiting there).
- With anything in it, the agent also looks on at every message not for it (others' only where
  others are answered, Settings › 에이전트), and by those lines picks: let it pass, an emoji
  reaction, a line of its own, or take it as if called (the user's words become a request).
  Each look is a quick model call, so keep the file to what was asked.
- The lines also go to its talk with others and to its own chat, so "민수한텐 존댓말" or "#공지에선
  말하지 마" work there too. Its voice stays in Settings › 에이전트 › 말투.

```md
- 내가 방금 말한 채널에서 5분 안에 주인이 이어서 하는 말은 나한테 하는 말로 받아
- 서버에서 나를 안 부른 말은 보고만 있다가, 할 말 있을 때만 끼어들고 아니면 공감 리액션만 하거나 넘어가
```

A wish these can't express (a new kind of thing to do, not when or how to talk) is a feature:
the steps below, asking first.

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
