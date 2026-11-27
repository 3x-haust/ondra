# Connections: working on another computer

A connected computer's projects show in this app's sidebar. Jobs in those projects run on that computer, with its files, tools and accounts. You don't need a remote desktop session. A connection goes both ways: each of the two computers can use the other.

## Setting it up

1. On either computer, open Settings › 연결, press **기기 추가**, then **연결 링크 복사**. The link (`ondra://connect/<id>?code=…`) works once and expires after 10 minutes.
2. On the other computer, open Settings › 연결, press **기기 추가** and paste the link. The computer that made the link then asks **허용 / 거절**.
3. Once allowed, each computer's projects appear automatically in the other's sidebar, in a workspace tab of the same name, with that computer's name beside them. A project added there later shows up too, and one removed there disappears.

The two devices reconnect on their own, with no new link needed. Older versions connected one way only (and had a **다른 기기에서 이 기기 쓰기** switch); such a connection becomes two-way by itself once both computers run this version.

## Hiding a project

A project of another device can't be deleted from here (it is that device's), but its menu in the sidebar has **목록에서 숨기기**. It and its jobs leave the list here and stay off it when that device sends its projects again. Settings › 연결 lists the hidden ones under the Mac, each with **다시 보이기**. The hidden set is kept per Mac (`settings.hosts[].hidden`).

## Disconnecting and removing

Each device has the same two actions, in Settings › 연결 and in the Mac bar's menu. Both act on the connection both ways:

- **연결 끊기** is for now and asks nothing. This Mac stops connecting to that device until **다시 연결**, even across restarts (`hosts[].off`), and that device's live connection here ends; the projects stay in the list. The other Mac shows "그 기기에서 연결을 끊었어요" and doesn't dial again until its user presses 다시 연결 or the app starts again.
- **제거** is for good and asks first. Getting back needs a new link. That device's projects, its jobs shown here, a run location set to it (`settings.computers`) and a workspace tab only it had all go, and it can't come in anymore (`remote/devices.json`; with the helper not running the file is changed directly, `remote_forget`). That Mac is told to forget this one and removes it on its side too. When it can't be reached, the goodbye waits in `settings.leaving` (shown in Settings as "연결되면 그 기기에서도 이 기기를 제거해요") and is tried at each launch and again with backoff (30 s doubling to 30 min) for 30 days.
- The other side saying no also cleans up: removed there, a refused request or a link that expired takes that device out of the list here (both ways) with a note saying why. Only "connections are off there" (an older version) is retried.

Jobs that a removed Mac started keep running on the Mac doing the work. A note names how many, with **정리**: it lists them and offers to stop and archive them. The device's ⋯ menu offers the same while any are left.

## What a connected Mac may do

The Mac doing the work checks every call (`src/engine/remoteRules.ts`):

- A job call (tell, stop, merge, remove, …) goes ahead only on a job that device may reach: a job of a project it keeps, or one it started, and their subagents. Never a job shown here from a third Mac.
- Each Mac allowed in can be limited to some workspaces (its ⋯ menu in Settings › 연결; `settings.deviceSpaces`, missing = all). It is sent only those workspaces' projects, accounts and jobs, and can only make jobs and projects there.
- A message from that device is the user's own: it can't pass for one of this Mac's agents.

## How it fits together

- **The network.** `remote/host` is the `ondra-remote` helper, written in Rust on iroh. Each Mac keeps a key in `<data dir>/remote/key` (0600); the public half is its address. Macs reach each other over QUIC. That is hole-punched UDP when possible, or a relay when not. Either way the traffic is end-to-end encrypted. Only Macs listed in `remote/devices.json` get in. One helper process plays both sides: it accepts other Macs and dials out to them. It runs while this Mac has a device in either list, or while 기기 추가 is open. The app drives it over stdin/stdout, and the Macs' own first lines are described at the top of `main.rs`.
- **Both ways.** A Mac dialing says `"both": true` in its hello. When the host answers ok, the dialing helper adds the host to its own `devices.json` before anything else, and the host, seeing `both`, adds the dialing Mac to its `settings.hosts` and dials back (`dialBack` in `hosts.ts`). So one link and one 허용 connect both ways, and a one-way connection from an older version becomes two-way at its next connect.
- **Saying why.** A Mac removing another dials it with `"bye": true` in its hello; the host forgets it and answers `{"t":"bye"}`. A host ending a connection closes it with a reason the other side reads: `revoked` (removed) or `dropped` (cut for now). Older hosts also say `off` (hosting turned off).
- **Older versions.** A field or answer a peer doesn't know is ignored. An older host doesn't know a goodbye: it lets the Mac in instead, which then hangs up and tells its user to remove it on that device too. An older client hears a "cut for now" as a plain disconnect and dials again. An older Mac doesn't say `both`, so it is only dialed back once it is updated.
- **The side doing the work** is `src/engine/remote.ts`. It sends the jobs of the projects the other Mac keeps: first each whole job, then only what changed (a job's fields, and its entries from the first one that differs). It does what the other Mac asks with the same functions the window uses: create, tell, stop, merge, queue edits and so on.
- **The side looking on** is `src/engine/hosts.ts` and `src/state/mirror.ts`. Those jobs are held in memory and never written to this Mac's state.json. `taskById`, `projectById`, `projectsShown` and `tasksShown` include them, so the sidebar and the job view work unchanged. The engine's own loops (scheduler, PR watching and so on) read `state.tasks`, which doesn't include them. An action on another device's job is sent there; see `far()` at the top of each action in `tasks.ts`.

## Files, terminals and memory of those jobs

Everything a job's panels read comes from the Mac it runs on: the changes and their diff, the files and find in files, its results, screenshots and pictures in its replies, PRs, issues and git (commit, push, PR), the binary-analysis trace, the skills in the `/` menu and `/remember`. The client asks with `far.*` calls (`src/engine/far.ts`); the host answers in `src/engine/farHost.ts`.

- **What the other Mac may reach.** Only paths inside the folders of the projects it added and of the jobs it sees (folder, worktree, results folder) and its own attachments folder, after following links. A file one of those jobs named itself (a screenshot in a reply) can be read on its own, but not listed around. A folder as wide as the home folder never counts, so a job started in `~` shows no files. Jobs and projects in a call must be ones the Mac sees. The rules are in `src/engine/farPaths.ts`.
- **Sizes.** A diff or a trace comes in one answer of at most 3 MB (the changes bar says 일부만 when cut); a file to read is at most 2 MB, as here. Pictures, videos and pages are fetched in 512 KB pieces into `<data dir>/remote/cache` (by path and version, dropped after a week unused), up to 48 MB each. An HTML page comes with every file it links to (pictures, styles, scripts, fonts, other pages, followed through styles and scripts too; at most 400 files and 200 MB), laid out as there under `<data dir>/remote/sites/<mac>/…` so its relative links work; it is copied again when the page changes there, and a file that device won't share is left out. Attachments go the other way the same way, into `<data dir>/attachments/remote` there, up to 100 MB each; the message then names the paths there.
- **Terminal.** A job's terminal tab opens a shell there in the app (`far.ptyOpen`). Keys go as `{t:"pty-in"}` and size changes as `{t:"pty-size"}`, with no answer. The output comes back as `{t:"pty",id,data}` every 40 ms at most, then `{t:"pty",id,exit}`. A Mac may keep six open, and they close when it goes.
- **On that computer's screen.** 편집기 / Finder for those jobs open on the host (`far.editor`, `far.reveal`); a Windows host opens File Explorer and its editor.
- **Memory.** The Memory page lists the other Macs' projects under 다른 기기; their pieces are read, added, edited and forgotten there (`far.mem*`).
- **Older Ondra.** A Mac whose Ondra doesn't know a `far.*` call answers `unknown: …`, and the panel says to update it. The new message kinds are ignored by older versions, and the helper carries them as any other line.

## Not there yet

- The model picker lists this Mac's models.

## Building

The helper needs Rust 1.91 (iroh). The app keeps its own toolchain. `src-tauri/helpers/build.sh` builds `ondra-remote` into `src-tauri/binaries`.

For a test with two copies of the app on one Mac, use debug builds. Set `ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT` per copy, and build with `VITE_TEST_HOOKS=1` for `window.__ui`.
