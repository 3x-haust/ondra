---
name: visual-report
description: Pictures, charts and report documents inside Ondra — diagrams of code and systems, charts, graphs and visual reports (보고서, 리포트, 차트, 그래프, 다이어그램, 시각화). The task prompt already covers plan, now, done and the everyday result blocks; read this for any other picture type. Its More charts catalog lists every figure type.
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
| `ask` | `question`, `options: {label, note}[]` (2–3, recommendation first), `context?: Block[]` | before risky/irreversible actions or real ambiguity — then **end your turn** |
| `remember` | `text`, `scope: "project" \| "space" \| "global"` | a lasting preference or fact future tasks need |
| `done` | `summary` (one line), `evidence: {kind, ref, ok, note?}[]`, `unverified?: string[]` | the whole task is finished — last block. `kind`: test, build, run, shot, file, link. Only what you really ran; the rest goes in `unverified` |
| `handoff` | `did: string[]`, `found?`, `next`, `doneWhen?`, `evidence: {kind, ref}[]` | only when Ondra says the context is nearly full; a fresh session continues from this card alone |

A job ends with `done`, `ask` or (when Ondra asks for one) `handoff`. Waiting
on a subagent or the user is no handoff: just end the turn.

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
| a stack, layer on layer (스택, 기술 스택, "구성 시각화") | `stack` | `items: {label, parts: string[], note?, em?}[]` top first, `side?: {label}[]` for what runs through every layer (모니터링, 인증) |
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
- A stack ("스택 시각화", "기술 스택") is `stack`: layers from the screen down to the machines, each with
  what it runs on. Who calls whom is a second picture (`arch`), only when asked.

## Pictures of code and systems

| question | type | fields |
|---|---|---|
| the code that matters in a change | `diff` | `path`, `ref` (absolute path:line), `note`, `hunks: {at, lines: ["-old", " same", "+new"]}[]` (1–3 hunks, ≤ 20 lines) |
| a test run (always when something failed) | `tests` | `suites: {name, pass, fail, skip, ms}[]`, `failures: {name, ref, msg}[]` |
| several approaches, which you chose | `options` | `criteria: string[]`, `options: {name, scores: string[], chosen?, note?}[]`, `why` |
| logic that branches or retries | `flow` | `nodes: {id, label, kind: start\|end\|step\|decision\|io, note?}[]`, `edges: {from, to, label}[]` (예 / 아니오 / a verb) |
| a status, lifecycle or reducer | `states` | `initial`, `states: {id, label, note?, final?}[]`, `transitions: {from, to, event, guard?}[]` |
| database tables and relations | `er` | `tables: {name, columns: {name, type, pk?, fk?, null?}[]}[]`, `relations: {from, to, card: 1-n\|1-1\|n-n, label?}[]` |
| running systems: services, DBs, queues | `arch` | `zones: {id, label}[]`, `nodes: {id, label, zone, kind: user\|gateway\|service\|function\|db\|cache\|queue\|storage\|external, note?, logo?}[]`, `edges: {from, to, label, async?}[]` (real product names get their `logo`, e.g. `postgresql`) |
| which module uses which, cycles | `deps` | `nodes: {id, label, group?, ref?}[]`, `edges: {from, to, kind: call\|import}[]` |
| types and how they relate | `classes` | `classes: {name, kind, fields: string[], methods: string[]}[]`, `relations: {from, to, kind: extends\|implements\|owns\|has\|uses, card?: [a, b]}[]` |
| where the time goes in a request | `trace` | `unit`, `spans: {id, label, start, dur, parent?, service?, error?}[]` |
| branches, commits, merges | `git` | `commits: {id, branch, msg, parents: string[], tag?}[]` (oldest first) |

Every box is something you read or changed: `state` new / changed / gone for
what the work touched, `ref` = absolute path:line for code, `by`: user / agent
for who decided it. When a change spans several parts, one such picture of how
the part works now and where the change goes (3–9 nodes) replaces a paragraph.

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

## Boards: an explanation drawn stroke by stroke

Explaining how something works, a concept, or what a real thing is made of
(how an engine runs, how DNS resolves, the parts of a camera) → a fenced ```board
in "text": your own chalkboard. Write it as a short JavaScript program that draws;
the user watches it drawn stroke by stroke as you write it, each step's sentence
under it, so keep the prose around it to a line or two. Draw the things themselves,
not a flowchart of boxes: a laptop as its screen and base, a tunnel as two curves,
a lock, a wave, a gear with its teeth. Loops and arithmetic make repeats and curves
(Math works). Canvas 800 wide, y down, cropped to what you draw. One call per line:
  title("짧은 제목")   step("이 단계에서 일어나는 일")   (what follows a step belongs to it; 3–6 steps)
  box(x, y, w, h, o)   circle(x, y, r, o)   ellipse(cx, cy, rx, ry, o)   poly([[x, y], …], o) closed
  line(x1, y1, x2, y2, o)   arrow(x1, y1, x2, y2, o)   pen([[x, y], …], o) a smooth stroke through points
  arc(cx, cy, r, fromDeg, toDeg, o)   path("M… C… A… Z", o)   text(x, y, "글", o)   highlight(x, y, w, h)   dot(x, y, o)
  o: {label, color, fill, dash, arrow, width, size, bold, align: "center"}; color: ink quiet accent ok warn bad
  live violet, red orange yellow green teal sky blue purple pink brown, or a #hex
Short labels, under 80 marks. For a physical object, build a 3D model instead (the
user turns it and clicks a part to ask about it), parts in building order:
  part("이름", "box", [w, h, d], [x, y, z], {color, rot: [rx, ry, rz]})   shapes: box [w, h, d]
  cylinder [r, h, r_top] cone [r, h] sphere [r] torus [R, r] capsule [r, h]; y up, the ground at 0;
  color: the colour the real thing has, or a material steel wood glass gold copper rubber plastic stone paper
5–40 parts placed where the real ones sit, so it reads as the thing.

Example:

```board
title("VPN이 내 데이터를 지키는 방법")
step("내 노트북이 VPN 서버와 암호화된 터널을 만들어요")
// 노트북
box(70, 150, 120, 76, { color: "blue", fill: true })
path("M50 232L210 232L198 246L62 246Z", { color: "blue" })
text(130, 272, "내 노트북", { align: "center", size: 16 })
// 서버: 같은 칸 세 개
for (let i = 0; i < 3; i++) box(560, 140 + i * 34, 110, 28, { color: "purple" })
for (let i = 0; i < 3; i++) dot(578, 154 + i * 34, { r: 4, color: "green" })
text(615, 262, "VPN 서버", { align: "center", size: 16 })
// 터널
pen([[200, 168], [300, 146], [460, 146], [555, 168]], { color: "accent" })
pen([[200, 218], [300, 240], [460, 240], [555, 218]], { color: "accent" })
step("데이터는 잠긴 상자에 담겨 터널 안을 지나가요")
for (let i = 0; i < 4; i++) box(240 + i * 80, 184, 26, 18, { color: "sky", fill: true })
arc(383, 176, 13, 180, 360, { width: 2.4 })
box(366, 176, 34, 28, { color: "orange", fill: true })
text(383, 282, "통신사·와이파이는 내용을 못 봐요", { align: "center", size: 15, color: "quiet" })
step("서버가 대신 사이트에 접속해서, 사이트에는 서버 주소만 보여요")
circle(735, 320, 42, { color: "green" })
ellipse(735, 320, 17, 42, { color: "green" })
line(693, 320, 777, 320, { color: "green" })
arrow(628, 212, 700, 284)
text(676, 236, "대신 접속", { size: 14, color: "quiet" })
text(735, 385, "웹사이트", { align: "center", size: 16 })
highlight(650, 404, 170, 20)
text(735, 414, "보이는 주소: VPN 서버", { align: "center", size: 14 })
```
