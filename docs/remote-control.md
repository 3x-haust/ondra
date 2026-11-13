# Connections: working on another Mac

Another Mac's projects show in this app's sidebar. Jobs in those projects run on that Mac, with its files, tools and accounts. They show up here like any other job.

## Setting it up

1. On the Mac that does the work, open Settings › 연결 and turn on **다른 Mac에서 이 Mac 쓰기**. Press **연결 링크 복사**. The link (`ondra://connect/<id>?code=…`) works once and expires after 10 minutes.
2. On the other Mac, open Settings › 연결, press **Mac 추가** and paste the link. The first Mac then asks **허용 / 거절**.
3. Once it's allowed, every project of that Mac shows in the sidebar by itself, in the workspace tab of the same name, with the Mac's name beside it. A project made there later shows up too, and one removed there goes.

After that the Macs find each other again on their own, with no new link needed.

## Hiding a project

A project of another Mac can't be deleted from here (it is that Mac's), but its menu in the sidebar has **목록에서 숨기기**. It and its jobs leave the list here and stay off it when that Mac sends its projects again. Settings › 연결 lists the hidden ones under the Mac, each with **다시 보이기**. The hidden set is kept per Mac (`settings.hosts[].hidden`).

## Disconnecting and removing

Both sides have the same two actions, in Settings › 연결 and (on the Mac doing the looking) in the Mac bar's menu:

- **연결 끊기** is for now and asks nothing. On the Mac looking on, it stops connecting to that Mac until **다시 연결**, even across restarts (`hosts[].off`); the projects stay in the list. On the Mac doing the work, it ends that Mac's live connection; the other Mac shows "그 Mac에서 연결을 끊었어요" and doesn't dial again until its user presses 다시 연결 or the app starts again.
- **제거** is for good and asks first. Getting back needs a new link.
  - From the Mac looking on: that Mac's projects, its jobs shown here, a run location set to it (`settings.computers`) and a workspace tab only it had all go. That Mac is told to forget this one. When it can't be reached, the goodbye waits in `settings.leaving` (shown in Settings as "연결되면 그 Mac에서도 이 Mac을 제거해요") and is tried at each launch and again with backoff (30 s doubling to 30 min) for 30 days.
  - From the Mac doing the work: that Mac can't come in anymore. It works whether hosting is on or not: the list in `remote/devices.json` is always shown, and with the helper not running the file is changed directly (`remote_forget`). The other Mac hears why it was cut off and removes this Mac on its side too, so nothing stale is left there.
- The other side saying no also cleans up: removed there, a refused request or a link that expired takes that Mac out of the list here with a note saying why. Only "connections are off there" is retried.

Jobs that a removed Mac started keep running on the Mac doing the work. A note names how many, with **정리**: it lists them and offers to stop and archive them. The device's ⋯ menu offers the same while any are left.

## What a connected Mac may do

The Mac doing the work checks every call (`src/engine/remoteRules.ts`):

- A job call (tell, stop, merge, remove, …) goes ahead only on a job that Mac may reach: a job of a project it keeps, or one it started, and their subagents. Never a job shown here from a third Mac.
- Each Mac allowed in can be limited to some workspaces (its ⋯ menu in Settings › 연결 › 이 Mac; `settings.deviceSpaces`, missing = all). It is sent only those workspaces' projects, accounts and jobs, and can only make jobs and projects there.
- A message from that Mac is the user's own: it can't pass for one of this Mac's agents.

## How it fits together

- **The network.** `remote/host` is the `ondra-remote` helper, written in Rust on iroh. Each Mac keeps a key in `<data dir>/remote/key` (0600); the public half is its address. Macs reach each other over QUIC. That is hole-punched UDP when possible, or a relay when not. Either way the traffic is end-to-end encrypted. Only Macs listed in `remote/devices.json` get in, and only while 다른 Mac에서 이 Mac 쓰기 is on (a goodbye gets through even while it's off). One helper process plays both sides: it accepts other Macs and dials out to them. The app drives it over stdin/stdout, and the Macs' own first lines are described at the top of `main.rs`.
- **Saying why.** A Mac removing another dials it with `"bye": true` in its hello; the host forgets it and answers `{"t":"bye"}`. A host ending a connection closes it with a reason the other side reads: `revoked` (removed), `dropped` (cut for now) or `off` (hosting turned off).
- **Older versions.** A field or answer a peer doesn't know is ignored. An older host doesn't know a goodbye: it lets the Mac in instead, which then hangs up and tells its user to remove it on that Mac too. An older client hears a "cut for now" as a plain disconnect and dials again.
- **The side doing the work** is `src/engine/remote.ts`. It sends the jobs of the projects the other Mac keeps: first each whole job, then only what changed (a job's fields, and its entries from the first one that differs). It does what the other Mac asks with the same functions the window uses: create, tell, stop, merge, queue edits and so on.
- **The side looking on** is `src/engine/hosts.ts` and `src/state/mirror.ts`. Those jobs are held in memory and never written to this Mac's state.json. `taskById`, `projectById`, `projectsShown` and `tasksShown` include them, so the sidebar and the job view work unchanged. The engine's own loops (scheduler, PR watching and so on) read `state.tasks`, which doesn't include them. An action on another Mac's job is sent there; see `far()` at the top of each action in `tasks.ts`.

## Not there yet

- Panels that read files (changes, files, pictures) still read this Mac's disk.
- The model picker lists this Mac's models.

## Building

The helper needs Rust 1.91 (iroh). The app keeps its own toolchain. `src-tauri/helpers/build.sh` builds `ondra-remote` into `src-tauri/binaries`.

For a test with two copies of the app on one Mac, use debug builds. Set `ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT` per copy, and build with `VITE_TEST_HOOKS=1` for `window.__ui`.
