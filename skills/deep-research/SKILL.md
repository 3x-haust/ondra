---
name: deep-research
description: >-
  Deep research with sources: plan the questions, search and read many primary
  sources in rounds until each question is answered, check every claim, and
  deliver a visual report in the chat plus a PDF. Use when the user asks to
  research, investigate, survey, compare or "정리" something from outside the
  folder: 리서치, 딥리서치, 조사해줘, 찾아서 정리해줘, 논문 찾아줘, 비교해줘,
  시장/경쟁사/기술 동향, "다 검색해서", "출처 달아서".
---

# Deep research

How the strong research agents work (Gemini Deep Research, OpenAI deep
research, Claude Research, Tongyi DeepResearch) and what the papers found:

- Plan first, and let the plan change: search, read, find what is still
  missing, search again. One pass of searching is not research.
- Completeness is the bar (DeepSearchQA): a list question needs the whole
  list, not the first three hits.
- Keep the working context short and the findings on disk (frequent
  compaction loses almost nothing; long piles of pages make agents worse).
  Every fact goes to a notes file the moment you find it.
- Parallel workers help on broad questions (an orchestrator with 3–5
  workers, each with a clear objective, output format and boundary).
- The known failure is made-up or misattributed citations. Every claim in the
  report points to a page this job opened (in any of its sessions: a page read
  before a handoff still counts; check a quote with `web_fetch` and `find`
  instead of reading the page again).

## Where things go

`R="$APP_ARTIFACTS_DIR/research-<short-slug>"` and `mkdir -p "$R"`. In it:

| file | what |
|---|---|
| `plan.md` | the question verbatim, the sub-questions with their "done when", fields to collect, status per round |
| `notes.jsonl` | one fact per line: `{"q":1,"claim":"…","url":"…","title":"…","published":"2026-04-21","quote":"≤ 2 lines, verbatim","source":"primary\|secondary"}` |
| `report.html` | the report, from `report.html` in this skill's folder |
| `report.pdf` | printed with `pdf.sh` in this skill's folder |
| `summary.html` | the chat card: a one-screen summary of the PDF, from `summary.html` in this skill's folder |

## 1. Scope and plan

1. Write the user's question verbatim at the top of `plan.md`.
2. Split it into 3–6 sub-questions. For each, write **done when**: what a
   complete answer looks like ("every vendor with a public API, with price
   and launch date", "the mechanism, from the vendor's own docs").
3. For comparisons, list the items and the fields to collect for each item
   (they become the table columns).
4. Size it: **quick** (one question, ~10 sources, you alone) or **deep**
   (several sub-questions, 20+ sources, subagents).
5. Send the `plan` block with the sub-questions and go. Ask first (one `ask`
   block) only when the question splits into reports that differ in kind
   (which market, which time range, for what decision) and the request or
   memory doesn't settle it.

## 2. Gather in rounds

For each sub-question, repeat until its "done when" holds:

1. `web_search` 2–4 queries from different angles: the user's language and
   English, the official name, the year ("2026"), "paper", "docs",
   "release notes", "pricing", "benchmark". Prefer recent results unless the
   question is historical.
2. `web_fetch` the primary sources: the vendor's docs, blog or changelog,
   the paper (arXiv abs/html), the repository, the standard, the filing.
   Aggregators, SEO guides and resellers only lead you to primary sources.
   A search snippet is not reading.
3. Append each fact to `notes.jsonl` right away, with the verbatim quote and
   the date. Don't keep whole pages in your head.
4. Gap check in `plan.md`: what is answered (with note count), what is
   missing, what conflicts. Missing → new, narrower queries. Conflict → find
   the primary source or the newer date.
5. Stop a sub-question when "done when" holds with at least two independent
   sources, or one primary source for a fact only its owner can state. After
   three rounds with nothing new, mark it "찾지 못함" and move on.

Budget: quick ~15 searches, deep ~40–80. Spend searches where the gaps are,
not on re-confirming what two sources already agree on.

**Deep mode, in parallel**: with 3+ independent sub-questions, hand them to
subagents (at most 3 at a time; every job shares one search engine, so more
in parallel only wait for each other), one sub-question each:

```
{"type":"subagent","title":"리서치: <짧게>","task":"Research ONE question for a report: <sub-question>. Done when: <done when>. Fields per item: <fields>. Use web_search (when it says the engine is busy, search through Aside: aside skills show google-search), then web_fetch the primary sources (official docs, papers, repos, changelogs); aggregators only lead to them. Write every fact as one JSON line to <R>/notes-<n>.jsonl: {\"q\":<n>,\"claim\",\"url\",\"title\",\"published\",\"quote\" (verbatim, ≤2 lines),\"source\":\"primary|secondary\"}. Don't conclude beyond the sources. Report back: what is answered, what is missing, what conflicts."}
```

Merge their notes into `notes.jsonl`, then run your own gap check on the
whole.

## 3. Check before writing

- Every claim you will write has a note with a URL you fetched in this
  session. No note, no claim.
- Numbers: the unit, the date and what was measured (a benchmark subset, a
  vendor's own eval, an estimate) come with them. Recompute what can be
  recomputed.
- Seen only in secondary sources → tag `확인 안 됨`. Sources disagree →
  show both with their dates and tag `출처 엇갈림`.
- Dates are absolute (2026-04-21, not "지난달").
- Vendor claims are claims ("구글은 … 라고 밝혔어요"), not facts.

## 4. Write the report

Read `writing/README.md` in this skill's folder first: the user has to get
the report in one read, and it must not sound machine-written.

Copy this skill's `report.html` to `$R/report.html` and fill it:

- Title = the answer in one plain sentence. Then "지금 할 일" (1–3 actions the
  user can take) and 3 takeaways with source numbers.
- One section per sub-question, its heading the question in the user's
  words: the answer in the first sentence, then why.
- Options to choose between → the decision grid (●◐○, the pick marked), not a
  table of sentences. A table only for short facts (cells of a few words or a
  number, numbers right-aligned).
- 1–4 pictures drawn the way a good paper draws them (`writing/figures.md`):
  how something works → the method diagram (numbered stages, boxes colored by
  role, arrows, a loop when something comes back); how much → bars on one
  scale from zero; when → a timeline; a cited paper's own figure (embedded,
  credited) when it answers the question exactly. Each has a "그림 N." caption.
  Copy the template's markup; no scripts, no CDN, no web fonts, so the same
  file shows in the chat and prints to PDF.
- "말 풀이" when a term the user didn't use can't be avoided: a few words each.
- "확실하지 않은 것": what wasn't found, conflicts, unverified items. Caveats
  live here, not at the end of every paragraph.
- Numbered sources: title, publisher, published date, the date you read it.
- The user's language (Korean unless they wrote otherwise), 해요체, plain words.

Then take the AI out of it: run `check-writing.py` on the report and fix
every hit until it passes (exit 0), as `writing/README.md` says. Keep every
fact, number and source number; change the wording, not the claims.

Then print it:

```bash
"<this skill's folder>/pdf.sh" "$R/report.html"   # prints $R/report.pdf
```

Open the PDF's first page once (screenshot it, or read the file size and
page count) to make sure it isn't blank or cut off.

## 5. Show it in the chat

The chat shows the PDF in short: one card that looks like the report's cover
page, then the PDF itself. Not the whole report, and not the same tables and
charts again as loose blocks.

1. Copy this skill's `summary.html` to `$R/summary.html` and fill it from the
   report only (and run `check-writing.py` on it too): the same title, what to do now, 2–4 numbers that carry the answer (each with
   what it is and its source number), the 3 takeaways, the report's one most
   telling picture (smaller, same data and colors), and the footer (page
   count, source count, one line of what's uncertain). Nothing that isn't in
   the report.
2. Send one message: a one-line answer, the card, the PDF, `done`.

```blocks
{"type":"text","text":"**<답 한 문장>**"}
{"type":"page","path":"<R>/summary.html","label":"리서치 요약","height":460}
{"type":"link","kind":"file","title":"보고서 PDF","ref":"<R>/report.pdf"}
{"type":"done","summary":"…","evidence":[{"kind":"file","ref":"<R>/report.pdf","ok":true},{"kind":"link","ref":"<main source URL>","ok":true}],"unverified":["…"]}
```

- `height`: about 460 for numbers + takeaways + one picture; less when a part
  was dropped. The card never scrolls: cut it down rather than raise it past 560.
- `link` opens the full PDF beside the chat.
- `evidence` links are pages this job opened (earlier sessions count); list
  the 3–8 that carry the answer, and check any a subagent found with
  `web_fetch` and `find` (just the quoted passage) before you list it.
- When the user asks about one part afterwards, answer from `notes.jsonl`
  and the report, with a `table` or `bars` block for that part only.

## Don'ts

- Don't answer from memory when a source can be fetched; say what you
  couldn't open.
- Don't pad: no background the user didn't ask for, no "향후 전망" filler.
- Don't cite a page you didn't open, and don't put a URL in the report that
  isn't in `notes.jsonl`.
- Don't rerun the whole search when the user asks a follow-up: read
  `notes.jsonl` and `plan.md` first, search only for what is new.
