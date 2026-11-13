---
name: code-map
description: >
  Explaining a codebase with an architecture map (코드 설명, 코드 설명해줘, 구조
  설명, 구조 설명해줘, 아키텍처 지도, 코드 지도, 이 레포 어떻게 돼 있어, 레포 구조,
  프로젝트 구조, 코드베이스 파악, 온보딩, explain this codebase, how is this repo
  organized, architecture map, C4): system → containers → components, which files
  belong to each part and how the parts talk, drawn in the chat as arch blocks
  with drill-down, and kept in one map file that later jobs read before a
  change and update after it. Reads an existing Groma (groma/) map too.
metadata:
  ondra-reads: '/code-map/map\.json$'
  ondra-commands: '\bcodemap\.mjs\b'
---

# Code map

A code explanation that is gone after one chat is redone by the next job. A
map kept on disk is read in a second, checked against the code in a second,
and gets better each time someone fixes it. The map is a C4-style picture
(after [Groma](https://github.com/MrLesk/Groma.md), see `NOTICE.md`):

| level | what | in the chat |
|---|---|---|
| system | the repo as one thing, who uses it, what it talks to outside | `arch` block |
| container | a part that runs or ships on its own: web app, desktop shell, server, CLI, worker, helper binary, database | `arch` node |
| component | a responsibility inside a container, owning files by path globs | `arch` block per container |
| code | the files of one component | `tree` + `table` |

The script is `scripts/codemap.mjs` next to this file (Node, no packages).
Below, `codemap` means `node <this skill's folder>/scripts/codemap.mjs`; run it
in the project folder (or pass `--repo DIR`).

## Where the map lives

`codemap where` prints it. One `map.json` per repo, in the repo's shared git
folder (`.git/ondra/code-map/map.json`): every worktree and every job sees the
same map, and it is never committed or merged by accident. A folder that isn't
a git repo keeps it in `.ondra/code-map/`. When the user wants the map in the
repo (reviewed in PRs, shared with the team), move it to
`.ondra/code-map/map.json` there; the script prefers that copy.

The format, with an example, is in `references/format.md`. Read it before
writing a map.

## 1. Start from what exists

```sh
codemap check
```

- **A map exists and check is clean:** answer from it right away (step 4).
- **It lists changed components or new files:** read those, fix their
  `note`, `paths` and relations in `map.json`, then answer. Don't rebuild a map
  that only drifted.
- **No map:** build one (step 2). Tell the user in one line that you are
  making a map once so later questions are instant.
- **The repo has `groma/` or `.groma/`** (Groma's map): `codemap from-groma`
  turns it into a draft `map.json` (names, notes, relations, flows kept).
  Groma's first scan has one component per file: merge them into real parts
  in step 2. Never edit files under `groma/`: Groma's own CLI owns them.

## 2. Build it from the code

```sh
codemap survey            # --depth 3 for a deeper folder split
```

The survey gives languages, manifests and entry files, source folders with
size, imports between folders, outside packages, the most imported files and
calls across process boundaries (Tauri commands, HTTP, child processes,
sockets). It is evidence, not the answer: folder names are not architecture.

1. **Read before naming.** Open the entry files, the most imported files and
   the main file of each big folder. Read enough to say what each part *does*.
   For a big repo, split the reading across subagents by folder and ask each
   for parts, files and who-calls-whom with `path:line`.
2. **Containers** (2–8): what runs or ships separately. A UI and its backend
   in one process can still be two containers when they are separate code
   bases talking over a boundary (Tauri webview ↔ Rust core, app ↔ worker
   process, CLI ↔ helper binary). Give each `tech` and `entry`.
3. **Components** (3–12 per container): one responsibility each, named by it
   ("작업 실행", "Job runner"), not by the folder. `paths` are globs relative
   to the repo; a file goes to its most specific pattern, so a broad
   `src/ui/**` and a narrow `src/ui/viz/**` can sit side by side.
4. **Relations**: `label` says what happens, in the user's words, as a
   newcomer would say it: `"작업 시작"`, `"진행과 결과 돌려주기"`, never a
   function, event or command name (`agent_spawn`, `bridge:call`, `invoke`).
   The mechanism goes in `tech` (`Tauri invoke`, `HTTP POST /orders`,
   `stdin JSON`), the call site in `ref` (`path:line`) when you saw it in code.
   Draw the calls a newcomer must know, not an import between every pair.
5. **Actors and externals:** who uses it, and outside systems. A real product
   gets `logo` (its brand name or slug). Ondra's pictures never guess a logo
   from a brand word inside a label like `파일·git`.
6. **Flows** (1–3): the main path of one user request, as a story:

   - 3–8 steps, **six parts at most** (an actor, container or component each).
     Past six, `blocks` folds components into their containers and drops the
     hops inside one container, so pick parts at one level when you can.
   - Each step's `label` is a short plain sentence of what happens
     (`"작업 지시 보내기"`, `"모델에게 묻기"`); the same rule as relations.
   - Part names must fit a narrow column: give a part with a long label a
     `short` name (10 characters at most).

   ```json
   {"id": "send-task", "label": "요청 하나가 작업이 되기까지", "steps": [
     {"from": "user", "to": "views", "label": "메시지 입력"},
     {"from": "views", "to": "captain", "label": "메인 채팅에 전달"},
     {"from": "tasks", "to": "processes", "label": "에이전트 프로세스 띄우기"},
     {"from": "processes", "to": "engine-tools", "label": "작업 지시 보내기"},
     {"from": "engine-tools", "to": "model-api", "label": "모델에게 묻기"},
     {"from": "processes", "to": "tasks", "label": "진행과 결과 돌려주기"}]}
   ```
7. **Write the summary** (2–3 sentences: what it is, how it's split).
8. Check until clean, then stamp it at the current commit:

```sh
codemap check             # errors, coverage, unowned folders
codemap check --stamp     # only when it has no errors
```

`check` also warns about labels that name code, flows past six parts and
names too long for the picture: fix those like errors. Aim for ≥ 80% of
source files owned. Tests, fixtures, generated code and
vendored samples go in `ignore`, not in a component.

## 3. Keep it honest

- Everything in the map comes from code you read or the survey printed.
  Unsure? Leave the relation out rather than guess.
- Remember it once, so every later job in the project knows the map is there:
  `{"type":"remember","scope":"project","text":"코드 지도: <path> (code-map 스킬). 코드 바꾸기 전 codemap owner <파일>, 바꾼 뒤 codemap check"}`.

## 4. Show it

```sh
codemap blocks                      # the system: containers, outside systems, main lines only (arch)
codemap blocks --container engine   # the parts inside one container and its neighbours (arch)
codemap blocks --component jobs     # one part's files and links (tree + table)
codemap blocks --flow send-task     # one flow, step by step (sequence)
```

Each prints a ```` ```blocks ```` fence: paste it into your answer as it is
(visual-report draws it; a node with a file opens it in the editor). The
system picture keeps it readable by itself: one line per pair of boxes (both
verbs on it when they talk both ways), every box's busiest line and then the
busiest others, outside systems grouped; the rest shows in each container's
picture. `"overview": true` (or `false`) on a relation forces it in (or out). Start
with the system picture and 2–4 sentences, then offer the containers to open
("엔진 · 화면 · 셸 중 어디를 더 볼까요?"). Two pictures per message at most.
When the question is about one place ("결제는 어디서 처리돼?"), answer with
`owner` and that part's picture instead of the whole system.

## 5. In a job that changes code

The map is read before the change and fixed after it.

- **Before:** `codemap owner <files you will touch>` shows the part, what it
  does, who it talks to and its gotchas. Read those neighbours before
  changing an interface between parts.
- **After (before `done`):** `codemap check`. If your change added a part,
  moved a responsibility, added or changed a call between parts, or the check
  lists new files no part owns, edit `map.json` (notes, paths, relations),
  then `codemap check --stamp`. A change inside one part that keeps what it
  does needs nothing.
- In a worktree the map is shared with the main checkout: stamp at your
  commit. If the work is thrown away, the next check says the stamp is off
  the branch and lists the parts to re-read.

## Groma itself

Groma (`groma.md` on npm, MIT) keeps a live C4 map as Markdown in the repo,
with a browser map and PR diffs. It is not installed by this skill: it needs
Node ≥ 26.12 or Bun ≥ 1.4.4 (or its 120 MB standalone binary), writes `groma/`
and an `AGENTS.md` block into the repo, and caches scanners (~600 MB for
TypeScript, Rust and Swift) in `~/.groma`. Its first scan is one component per
file and still needs curation. Install it only when the user asks for Groma by
name; then follow `groma agent-instructions`, and `from-groma` keeps Ondra's
map in step with it.
