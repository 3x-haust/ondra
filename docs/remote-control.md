# Connections: working on another Mac

You add another Mac's project to this app's sidebar. Jobs in that project run on that Mac, with its files, tools and accounts. They show up here like any other job.

## Setting it up

1. On the Mac that does the work, open Settings › 연결 and turn on **다른 Mac에서 이 Mac 쓰기**. Press **연결 링크 복사**. The link (`ondra://connect/<id>?code=…`) works once and expires after 10 minutes.
2. On the other Mac, open Settings › 연결, press **Mac 추가** and paste the link. The first Mac then asks **허용 / 거절**.
3. Once it's allowed, press **프로젝트 추가**. Pick one of that Mac's projects, or type a folder path there. The project shows in the sidebar with the Mac's name beside it.

After that the Macs find each other again on their own, with no new link needed. Either side can remove the other: **빼기** on one side, **연결 끊기** on the other.

## How it fits together

- **The network.** `remote/host` is the `ondra-remote` helper, written in Rust on iroh. Each Mac keeps a key in `<data dir>/remote/key` (0600); the public half is its address. Macs reach each other over QUIC. That is hole-punched UDP when possible, or a relay when not. Either way the traffic is end-to-end encrypted. Only Macs listed in `remote/devices.json` get in, and only while 다른 Mac에서 이 Mac 쓰기 is on. One helper process plays both sides: it accepts other Macs and dials out to them. The app drives it over stdin/stdout (see the top of `main.rs`).
- **The side doing the work** is `src/engine/remote.ts`. It sends the jobs of the projects the other Mac added: first each whole job, then only what changed (a job's fields, and its entries from the first one that differs). It does what the other Mac asks with the same functions the window uses: create, tell, stop, merge, queue edits and so on.
- **The side looking on** is `src/engine/hosts.ts` and `src/state/mirror.ts`. Those jobs are held in memory and never written to this Mac's state.json. `taskById`, `projectById`, `projectsShown` and `tasksShown` include them, so the sidebar and the job view work unchanged. The engine's own loops (scheduler, PR watching and so on) read `state.tasks`, which doesn't include them. An action on another Mac's job is sent there; see `far()` at the top of each action in `tasks.ts`.

## Files, terminals and memory of those jobs

Everything a job's panels read comes from the Mac it runs on: the changes and their diff, the files and find in files, its results, screenshots and pictures in its replies, PRs, issues and git (commit, push, PR), the binary-analysis trace, the skills in the `/` menu and `/remember`. The client asks with `far.*` calls (`src/engine/far.ts`); the host answers in `src/engine/farHost.ts`.

- **What the other Mac may reach.** Only paths inside the folders of the projects it added and of the jobs it sees (folder, worktree, results folder) and its own attachments folder, after following links. A file one of those jobs named itself (a screenshot in a reply) can be read on its own, but not listed around. A folder as wide as the home folder never counts, so a job started in `~` shows no files. Jobs and projects in a call must be ones the Mac sees. The rules are in `src/engine/farPaths.ts`.
- **Sizes.** A diff or a trace comes in one answer of at most 3 MB (the changes bar says 일부만 when cut); a file to read is at most 2 MB, as here. Pictures, videos and pages are fetched in 512 KB pieces into `<data dir>/remote/cache` (by path and version, dropped after a week unused), up to 48 MB each. Attachments go the other way the same way, into `<data dir>/attachments/remote` there, up to 100 MB each; the message then names the paths there.
- **Terminal.** A job's terminal tab opens a shell there in the app (`far.ptyOpen`). Keys go as `{t:"pty-in"}` and size changes as `{t:"pty-size"}`, with no answer. The output comes back as `{t:"pty",id,data}` every 40 ms at most, then `{t:"pty",id,exit}`. A Mac may keep six open, and they close when it goes.
- **On that Mac's screen.** 편집기 / Finder for those jobs open on that Mac (`far.editor`, `far.reveal`).
- **Memory.** The Memory page lists the other Macs' projects under 다른 Mac; their pieces are read, added, edited and forgotten there (`far.mem*`).
- **Older Ondra.** A Mac whose Ondra doesn't know a `far.*` call answers `unknown: …`, and the panel says to update it. The new message kinds are ignored by older versions, and the helper carries them as any other line.

## Not there yet

- The model picker lists this Mac's models.

## Building

The helper needs Rust 1.91 (iroh). The app keeps its own toolchain. `src-tauri/helpers/build.sh` builds `ondra-remote` into `src-tauri/binaries`.

For a test with two copies of the app on one Mac, use debug builds. Set `ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT` per copy, and build with `VITE_TEST_HOOKS=1` for `window.__ui`.
