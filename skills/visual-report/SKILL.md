---
name: visual-report
description: How to report progress and results inside Ondra. Read before your first message in any task — Ondra draws these blocks instead of showing raw text. Also for reports, charts, graphs and diagrams (보고서, 리포트, 차트, 그래프, 다이어그램, 시각화) — its More charts catalog lists every figure type.
---

# Visual report

Ondra shows your tool calls live on its own. Your job is to say **what you
are doing** and **what came out**, as blocks the app can draw.

Put blocks in a fence named `blocks`, **one JSON object per line**:

````
```blocks
{"type":"plan","steps":["원인 찾기","고치기","테스트"]}
{"type":"now","text":"로그인 리다이렉트 원인 찾는 중","step":0}
```
````

You may send several fences in one message and short prose around them.
Keep prose to a few sentences; put lists, numbers and results in blocks.

## Control blocks

| type | fields | when |
|---|---|---|
| `plan` | `steps: string[]` (2–6, short) | first message, and when the plan changes |
| `now` | `text`, `step` (0-based index into plan) | whenever what you are doing changes |
| `ask` | `question`, `options: string[]` (2–4), `context?: Block[]` | before risky/irreversible actions or real ambiguity — then **end your turn** |
| `remember` | `text`, `scope: "project" \| "space" \| "global"` | a lasting preference or fact future tasks need |
| `done` | `summary` (one line), `evidence: {kind, ref, ok, note?}[]`, `unverified?: string[]` | the whole task is finished — last block. `kind`: test, build, run, shot, file, link. Only what you really ran; the rest goes in `unverified` |
| `handoff` | `did: string[]`, `next`, `evidence: {kind, ref}[]` | stopping partway; a fresh session continues from this card alone |

Every turn ends with exactly one of `ask`, `done` or `handoff`, unless the
user is mid-conversation with you and simply asked a question.

## Result blocks

| type | fields |
|---|---|
| `diagram` | `label?`, `nodes: {id, label, note?, ref?, state?, by?}[]`, `edges: {from, to, label?}[]` — how something works, as boxes and arrows (3–9 nodes). `ref` = absolute path:line, `state`: new / changed / gone, `by`: user / agent (who decided it) |
| `checklist` | `label?`, `items: {label, done}[]` |
| `files` | `files: {path, add, del}[]` |
| `compare` | `label`, `before`, `after`, `unit?`, `better: "up" \| "down"` |
| `metric` | `label`, `value` (string), `delta?`, `trend?: number[]` |
| `progress` | `label`, `value`, `total` |
| `timeline` | `label?`, `items: [{label, at?, state: "done"\|"now"\|"todo"}]` — what happened in order (e.g. 원인 찾기 → 수정 → 테스트) |
| `table` | `columns: string[]`, `rows: string[][]` (≤ 20 rows) |
| `beforeAfter` | `label`, `before`, `after`, `beforeImage?`, `afterImage?` (absolute paths) |
| `shot` | `path` (absolute PNG/JPG), `caption` |
| `page` | `path` (absolute .html), `label?`, `height?` (200–900) — a self-contained HTML page drawn inside the chat (a report, a prototype); no external scripts |
| `link` | `kind: "pr" \| "doc" \| "video" \| "file" \| "url"`, `title`, `ref` (URL or absolute path) |
| `text` | `text` (markdown, short) |

## Pictures for explanations

| question | type | fields |
|---|---|---|
| what's in / out of this work | `scope` | `label?`, `in: {label, note?}[]`, `out: {label, note?}[]` |
| how much, which is biggest | `bars` | `label?`, `unit?`, `items: {label, value, note?, highlight?}[]` |
| where things are | `tree` | `label?`, `unit?`, `items: {path, note?, value?, state?}[]` |
| what it's made of | `groups` | `label?`, `groups: {label, note?, items: {label, note?, state?, ref?}[]}[]`, `links?: {from, to, label?}[]` |
| who talks to whom | `sequence` | `label?`, `actors: string[]`, `steps: {from, to, label, note?}[]` |
| straight order | `steps` | `label?`, `items: {label, note?, state?}[]` |
| branching flow | `diagram` | see above |

Why these (research): related things placed together are found faster than in
text (Larkin & Simon 1987); show only what matters, mark it, and put the words on
the picture (Mayer: coherence, signaling, spatial contiguity); quantities read
best as lengths on a common scale (Cleveland & McGill 1984); arrows mean order
or cause (Tversky); long LLM answers are easier to grasp as diagrams
(Graphologue, UIST 2023).

- One picture answers one question. 3–7 boxes; over 12, split or cut.
- `label` is a 2–5 word title. `say` (any block) is the one-sentence takeaway,
  shown as plain text under the picture ("결제 실패는 재시도 큐로 가요").
  Don't put explanations inside the picture.
- Every line carries a verb ("읽기", "요약해 저장", "검색").
- `em: true` on the boxes and lines of the path that answers the question.
- `state`: new / changed / gone / done / now / todo, and `off` for what exists
  but isn't used (the note says why).
- Box labels are short nouns/verbs; notes ≤ ~6 words.
- Before/after: two pictures with the same boxes in the same order.
- A straight chain of boxes is `steps`, not `diagram`.

## More charts

Beyond the pictures above there is a catalog of charts and figures, one file
per family. When a question needs one, read the matching file and use its
`type` exactly as written there:

- `references/stat.md`: distributions, uncertainty, statistics and paper
  figures (histogram, box/violin, error bars, regression, ROC, survival…)
- `references/chart.md`: comparison, change over time, part of a whole,
  finance and KPIs (line, area, stacked, pie, waterfall, candlestick, gauge…)
- `references/relation.md`: networks, flows, hierarchies, sets and maps
  (sankey, chord, treemap, sunburst, venn, mind map, choropleth…)
- `references/slide.md`: presentation and business figures (2x2 matrix,
  pyramid, cycle, roadmap, gantt, SWOT, funnel, KPI grid, layouts…)

Use only the numbers you really have; never invent data to fill a chart.

## Rules

- Show, don't tell: a `compare` beats "속도가 빨라졌습니다", a `diagram` beats a paragraph about how modules talk.
- Screenshots and recordings go in `$APP_ARTIFACTS_DIR`; reference them by absolute path.
- Labels in the user's language (Korean unless they wrote otherwise), plain words, no jargon.
- Valid JSON only: double quotes, no trailing commas, one object per line.
