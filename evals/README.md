# Evals

What Ondra's evals check, how to run them, and how to read the number.

| | what it checks | needs | cost |
|---|---|---|---|
| `main-sim.mjs` | main's decisions (new job, append, stop, ask, answer, project, reach…) in made-up situations from `main/` | dev app | one main call per message |
| `main-replay.mjs` | the user's real messages again; no right answer, only the shared lint and a line per decision for a person to read | dev app | one main call per message |
| `run.mjs` | real jobs from `cases/`, end to end: finished, said the right thing, left the files, time, tool count, no failed tools, no focus stealing, devices shut down, research scorecard | dev app | minutes and many calls per case |
| `gepa/` | evolves main's system prompt with GEPA, scored by the `main/` cases ([its README](gepa/README.md)) | dev app (`--mock`: nothing) | one main call per case per metric call, ×`--repeats` |
| `health.mjs` | prompt cache use and tool failure rate in real sessions | nothing | free |
| `compare.mjs` | reads saved runs: pass rate per case, flaky cases, and a verdict between two runs | nothing | free |
| `cases.test.mjs` | the case files follow the rules below; the counting adds up | nothing | free, part of `pnpm test` |

The dev app is `pnpm tauri dev`; the runners talk to it on its dev bridge (`devbridge.mjs`;
`ONDRA_DATA_DIR` and `ONDRA_DEVBRIDGE_PORT` point them at a second dev app on its own empty
data, see `gepa/README.md`). Results go to `evals/results/` (not in git): `report.md` to read,
`report.json` and `meta.json` (commit, note, model, a hash of each case) for `compare.mjs`.
GEPA keeps its own runs and scores (`summary.json`, per case seed → best).

Where things live: `main-cases.mjs` loads the `main/` cases and holds their rules,
`main-sim-check.mjs` the `expect` checks (shared with GEPA), `main-sim-lint.mjs` the checks
every decision gets, `job-cases.mjs` the `cases/` loader and rules, `tally.mjs` the counting.

## Before a run

- **Write down what would change your mind.** Pass it as `--note "..."`, for example
  `--note "fewer appends to finished jobs after the from-rule; worse if follows cases drop"`.
  It is kept with the result.
- **Run the baseline first**, on the commit you are changing from, with the same model
  and account. `meta.json` records main's model only when one is set for main; if main
  runs on the account's model, keep the account the same.
- **Repeat.** Main's decisions vary from run to run. One run per case is a smoke check:
  say so. For a claim, `--repeat 3` on both sides, close in time (GEPA: `--repeats 3`).

## Reading the number

```
node evals/compare.mjs main-<before> main-<after>
verdict: no measurable difference
passed 58/60 → 60/60 · p = 0.496
```

- The verdict is one of **better**, **worse**, **no measurable difference**, **inconclusive**.
  It counts only cases that ran on both sides and did not change in between (a changed
  case is listed under "not compared"). Inconclusive means nothing was comparable or the
  sides ran on different models.
- **Harness errors are not failures.** A run where the app did not answer or a call threw
  says nothing about the model. They are counted apart; a run with many of them is not a
  measurement, fix the cause and run again.
- **Flaky cases are the noise floor.** A case that both passed and failed in the baseline
  can flip without any change. A move that lives only in flaky cases is noise.
- The test is Fisher's exact test on the pooled passes. It treats every run as
  independent, which they are not quite (cases differ in difficulty), so read the list of
  changed cases too. A "better" that comes from one case is weak.
- **Check what happened, not what was said.** `run.mjs` reads the job's tools, its files
  and its session log, not only the final answer. Before changing a prompt for a failed
  case, read that case in `report.md`, with the context main saw.

## After a failure

- Fix the prompt or the code, not the case. If the case was wrong (asking was the right
  move, say), change it in its own commit and say why in `LEARNINGS.md`. The compare
  leaves changed cases out, so a case edit cannot pass as an improvement.
- Don't write the case's own words into a prompt. After a prompt change, run
  `main-replay.mjs` too: the user's real messages are cases the prompt was not tuned on.
- One change, one comparison. Write the result in `LEARNINGS.md`: date, case, cause, fix,
  before → after with passes over runs.
- A GEPA `best.diff` is a prompt change like any other: GEPA trained on these cases, so after
  copying edits back, compare `main-sim.mjs --repeat 3` runs before and after, and replay.

## Adding a case

Whatever the model sees must read like a real user's day. Main and the jobs must not be
able to tell they are being tested.

- Messages, chat, job titles, project names, folders and memory: plain, organic text. No
  "eval", "judge", "rubric", "평가", "채점", "시뮬레이션" (the list is `META` in
  `main-cases.mjs`; `cases.test.mjs` fails on them). Names a user would pick.
- The `note`, the `expect` and an `each` entry's `id` are for people: main never sees them.
  Put the reason for the case there, not in the message.
- Don't hint at the right move in the message ("새 작업으로 해줘") unless a user would.

### A main case (`main/<name>.json`)

```json
{
  "note": "why this case exists",
  "space": "home",
  "project": "초롱 PC",
  "projects": [{ "name": "초롱 PC", "folder": "/Users/me/Work/projects/chorong-pc" }],
  "tasks": [{ "id": "t-logo", "title": "로고 시안", "topic": "브랜드", "status": "running" }],
  "memory": ["PR은 dev로 올려요"],
  "chat": [{ "from": "me", "text": "..." }, { "from": "captain", "text": "..." }],
  "messages": ["로고는 그만 만들어"],
  "expect": [{ "stop": "t-logo", "new": 0 }]
}
```

- `expect` is a list, one entry per message. Jobs main starts get ids `job-1`, `job-2`…
  in order, so a later message can expect an append to `job-1`.
- A message can be what main is told when a job ends: `{ "event": "fork", "text": "Fork t-x … finished." }`.
- `"world": "busy-home"` builds on `main/_worlds/busy-home.json`; `"each": [{ "id", "text", "expect" }]`
  holds many one-message cases in one world (an entry can add its own `tasks`, `memory`…).
- Leave out `memory` to use the space's real memory.

Expect keys (all optional; `check()` and the list `EXPECT_KEYS` in `main-sim-check.mjs`;
`cases.test.mjs` fails when the two drift apart):

| key | passes when |
|---|---|
| `new` | that many new jobs (`2`, or `{ "min": 1, "max": 2 }`) |
| `append` | an append to this job id (`false`: no append) |
| `appendAny`, `appendOrAfter` | an append to one of these / to it, or a new job after it |
| `stop`, `stopCount` | that job is stopped / that many stops |
| `follows` | a new job carries on this finished job (`from`) |
| `after`, `noAfter`, `afterTask` | a new job waits / none waits / one waits on this job |
| `answerOnly`, `quiet` | only an answer / nothing added at all |
| `ask` | main asks the user (`false`: it just goes) |
| `has`, `hasNot` | these route kinds are there / are not |
| `project`, `cwdIncludes`, `cwdEmpty` | the new job's project or folder |
| `reach` | the new job may reach these other spaces (`[]`: none) |
| `taskIncludes`, `taskExcludes` | words in a new job's title or task |
| `answerIncludes`, `answerIncludesAny`, `maxAnswer` | the answer's words / its length |

Every decision also gets the shared lint (`main-sim-lint.mjs`): known route kinds, no empty
answer or task, short titles, branch names, absolute folders, no offer of more work as a
question, no PR to main against memory.

### A job case (`cases/<name>.json`)

```json
{ "ask": "브라우저로 https://example.com 열어서 페이지 제목이 뭔지 알려줘", "kind": "browser",
  "expect": { "textAny": ["Example Domain"], "maxSecs": 120, "maxTools": 12 } }
```

- `kind: "device"` also checks that simulators and emulators are shut down after.
- `answer: "first"` picks the first option when a job asks; otherwise a question ends the run.
- `expect`: `asks` (the job should ask first), `textAny`, `artifacts` (file extensions),
  `research` (`{}` or `{ "blocked": true }`: the deep-research scorecard), `maxSecs`,
  `maxTools`. Always checked: finished, no failed tools, no focus stealing.

### Then

```
npx vitest run --environment node evals/      # the case follows the rules
node evals/main-sim.mjs <name> --repeat 3     # paid: it should pass every time on the current build,
                                              # or fail for the reason you are fixing
```

A case that passes only sometimes on a build you trust is a flaky case; fix its wording or
its expectation before you count on it.

## Credit

The run rules (blind cases, write the decision first, count errors apart, repeat and report
the spread, a four-way verdict) borrow ideas from pstack's eval playbook and its
explain-the-number and benchmark-checklist notes: https://github.com/cursor/plugins/tree/main/pstack
(MIT, Lauren Tan).
