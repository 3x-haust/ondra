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

## Not there yet

- Panels that read files (changes, files, pictures) still read this Mac's disk.
- The model picker lists this Mac's models.

## Building

The helper needs Rust 1.91 (iroh). The app keeps its own toolchain. `src-tauri/helpers/build.sh` builds `ondra-remote` into `src-tauri/binaries`.

For a test with two copies of the app on one Mac, use debug builds. Set `ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT` per copy, and build with `VITE_TEST_HOOKS=1` for `window.__ui`.
