---
name: sharpen
description: >
  Before building something big or vague, find out what the user actually wants:
  ask → spec → tickets, agree, then run the tickets in parallel. One question at a
  time, each with one recommended answer and a visible ambiguity score, a
  glossary of the project's words, a spec and vertical-slice tickets kept as
  GitHub issues or in the repo. Use when the user says 인터뷰해줘, 물어보고 해,
  털어줘, 그릴미, grill me, 딥인터뷰, 뾰족하게, "뭘 만들지 같이 정하자", "기능
  만들기 전에 인터뷰", 기획서, 티켓으로 쪼개서, or when
  a request is big or open enough that building now would mean guessing. Not
  for a small, clear change (a typo, "make the icon blue"): just do it.
---

# Sharpen (뾰족하게)

Nobody knows exactly what they want until they are asked well. When an AI builds
the wrong thing, the request was usually blurry, not the model. This skill
asks before anything is built, writes down what was agreed, and only then splits
the work for parallel jobs.

**Agree first, then parallel.** The order is the whole method:

```
01 ASK      02 SPEC        03 TICKETS        ┊ agreed ┊   04 PARALLEL
질문하고  →  기획서 쓰고  →  티켓으로 쪼개서   ┊ 합의 끝 ┊   병렬로
```

Nothing is built, and no job is started for the work, before the user has
agreed to the spec and the tickets.

## 0. Does this need it?

Ask yourself what you actually know about what they want, and why.

- Everything that matters is in the request: do it. No interview.
- Small but one thing is missing: one ordinary ask, not this skill.
- Big, or vague, or the user asked to be interviewed: this skill.

A spec and tickets are for big work. For medium work, the interview and a
short spec are enough; build it in one job.

## 01 ASK: one question at a time

### Facts are yours, decisions are theirs

Before asking anything, find what can be found: the code, the project's memory
(`memory_search`), its docs, how neighbouring features do it. Never ask what
the code or memory answers ("DB 뭐 쓰세요?"). When the domain is unfamiliar
(a law, a payment flow, an API you don't know), read its primary sources first
(the deep-research skill for anything big) and bring what you found into the
questions. Ask only what needs the user's intent or taste: goals, scope, what
"done" means, trade-offs, words.

Technical choices (library, file layout, how to build it) you make yourself.

### The decision tree and its frontier

Lay the decisions out as a tree: each decision branches into the ones that
hang off it. The **frontier** is every decision whose prerequisites are
settled, the ones you can ask now without guessing at answers you haven't
heard. Don't ask about rental cars before it's settled whether the trip is to
Jeju or Osaka.

Ask one question at a time, the way a person interviews: of the frontier,
the one that matters most now (aim at the weakest part of the score). Wait
for its answer, redraw the tree with it, then pick the next question; the
answer often changes what is worth asking next. Never send several questions
at once.

### One recommendation per question

Every question carries exactly one recommended answer: the one you would pick,
from what you found. If it fits, they take it with one press; they stop only
where they have to think. Anything else, they write in their own words. Don't
offer a menu of alternatives: a list of options boxes their thinking in, and
writing the answer is how they discover what they want. Put the reason for
your recommendation in `why` (one line).

Send each question as one ask block with a single question:

```json
{"type":"ask",
 "questions":[
   {"question":"지난 회차를 안 끝냈는데 새 회차가 생기면요?","recommend":"밀린 건 하나로 합쳐 최근 회차만 남겨요","why":"운동이 세 개씩 쌓이지 않게"}
 ],
 "clarity":{"score":0.55,"parts":[{"label":"목표","score":0.8},{"label":"범위","score":0.5},{"label":"완료 기준","score":0.3},{"label":"제약","score":0.6}]}}
```

In main, the same as an `ask` route with `questions` and `clarity`.

Ondra shows it as a card (the recommendation is the only choice; any other
answer they type in the chat box) and sends the answer back as
`"question" → answer`. A block with several questions is cut to its first.

Questions are in plain words, answerable from the question line alone. One
decision per question.

### The ambiguity score

After every answer, score how clear each part is (0 to 1), honestly, from what
was said and found, not from how many questions were asked:

| Part | New thing | Change to existing code |
|---|---|---|
| 목표: what it is for, for whom | 0.35 | 0.30 |
| 범위: what's in, and what is explicitly not | 0.25 | 0.20 |
| 완료 기준: how we'll know it works (checks you could run) | 0.25 | 0.20 |
| 제약: limits, data, access, what must not change | 0.15 | 0.10 |
| 맞물림: how it fits the code and features already there | — | 0.20 |

`clarity.score` = the weighted sum; the card shows it as 모호함 (1 − score).
Aim each question at the weakest part; when you move to another part, say so
in a line ("완료 기준이 제일 흐려서 그걸 물어볼게요"). Done asking when 모호함 is 20% or less
and the gates below pass. The user can stop at any time ("그만", "알아서 해"):
then the rest is settled by your recommendations, and the spec says which
decisions were made that way.

### Keep every thread

A request with several parts keeps all of them: after a few questions on one,
come back to the others. When questions only polish wording or narrow edge cases,
offer to stop.

### Words: the glossary

Whenever a word turns out to mean two things ("완료": this week's turn done, or
the repetition ended?), settle it in the next question and write it down:

```json
{"type":"remember","kind":"term","text":"완료 = 이번 회차를 끝냄. 반복을 그만두는 건 '반복 종료'"}
```

From then on, talk and code use those words (names of types, functions,
columns). If the repo keeps a glossary (`CONTEXT.md`, `GLOSSARY.md`, a docs
page), the spec job adds the term there too. Lasting decisions ("밀린 회차는
하나로 합친다") go in memory as `"kind":"decision"`, so they're never asked
again.

### Before closing

- Concrete values, not concepts: real paths, which account or service and how
  it is reached, the command or check that will prove it works. Don't make
  these up; ask if they aren't found.
- Restate the goal in one short paragraph (what, for whom, what's out, how
  we'll know) and ask whether it's right: one question, its recommendation
  "맞아요, 기획서로 정리해요". Their correction leads to the next question.

## 02 SPEC: write down what was agreed

No new questions: put together what was said and found.

- **목표**: one paragraph.
- **안 할 것**: what is explicitly out.
- **결정**: each decision with its reason and who made it (사용자 · 추천대로 · 코드에서).
- **용어**: the terms settled.
- **완료 기준**: checks that can be run (a test, a command, what to click and see).
- **열린 것**: anything left open, and what it would take to close it.

## 03 TICKETS: vertical slices

Cut the spec into tickets like slices of a cake, never layers: each ticket is a
narrow feature that goes through every layer (data, logic, screen, test), so
it can be tried on its own when it's done. Not "all the DB", then "all the UI".

Each ticket: what it does, its 완료 기준 (from the spec), and **blocked by**
(the tickets that must be done first). The first ticket should be usable by
itself.

Blocked by is how a house is built: walls first, then the electrician and the
plumber at the same time, since both need the walls but not each other. Mark
only real dependencies (it needs the other's code, data or screen); "it would
be tidier after" isn't one. Whatever has nothing blocking it runs at once.

Show the tickets like this, and ask whether the size and order are right:

```
1. 매일 반복 하나만 끝까지 — Blocked by: 없음
2. 매주, 매월 반복 추가 — Blocked by: 1
3. 완료하면 다음 회차 생성 — Blocked by: 1
4. 밀린 회차 하나로 합치기 — Blocked by: 3
```

When 1 is done, 2 and 3 start together; 4 waits for 3.

## Where specs and tickets live

Two ways; the project decides, once:

- **GitHub 이슈**: the spec is an issue, each ticket a sub-issue (or an issue
  with "Part of #n"), "Blocked by #n" in its body, the labels the repo uses.
  Good for teams and anything others will see.
- **로컬 파일**: `docs/specs/<slug>/spec.md` and
  `docs/specs/<slug>/tickets/NN-<slug>.md` in the repo (committed with the
  work), "blocked by: 01, 02" at the top of each ticket. Good alone, or with no
  GitHub.

Search memory first (where this project keeps specs). If nothing says, make it
the first question, recommending GitHub issues for a repo on
GitHub with issues on, else local files, and remember the answer as a project
decision. Never ask again.

## The agreement gate (합의 끝)

Show the spec's 목표 and the ticket list (as above), and ask once: "쪼갠 크기와
먼저 할 일이 맞나요?", recommending "네, 이대로 시작". A correction (merge two,
split one, another order) redraws the list and asks again. Until they say yes,
nothing is built.

## 04 PARALLEL

- **In main**: hand the spec and tickets to one job to write them down (as
  issues or files, per the project), then one job per ticket. A ticket's job
  gets the ticket and the spec (their issue numbers or paths), and `after` the
  writing job and the jobs of the tickets that block it; tickets with nothing
  between them run at the same time. All of them are then one piece of work:
  listed under the writing job, one result and one sound when the last ends. Each job starts fresh with just its ticket: the interview
  isn't carried, the written spec is.
- **In a job** (the interview happened there): write the spec and tickets down,
  then build them in order yourself when they're few or tightly linked; when
  they're many and independent, say in your done that they're ready to run in
  parallel, with their order, and main starts them.

Each ticket's job builds test-first from its 완료 기준: a test that fails, then
the code that passes it. The done's evidence is those checks.

---

Ideas from Matt Pocock's skills (grilling, grill-with-docs, to-spec,
to-tickets; https://github.com/mattpocock/skills, MIT), the ambiguity score from
oh-my-claudecode's deep-interview (https://github.com/Yeachan-Heo/oh-my-claudecode,
MIT), closing checks from Ouroboros (https://github.com/Q00/ouroboros, MIT). No
text copied.
