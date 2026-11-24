---
name: visual-report
description: Pictures and charts drawn in Ondra's chat — diagrams of code and systems, charts, graphs and visual reports (보고서, 리포트, 차트, 그래프, 다이어그램, 시각화). Its More charts catalog lists every figure type. Everyday progress blocks need none of this; it draws only in the chat.
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
| running systems: services, DBs, queues | `arch` | `zones: {id, label}[]`, `nodes: {id, label, zone, kind: user\|gateway\|service\|function\|db\|cache\|queue\|storage\|external, note?, logo?}[]`, `edges: {from, to, label, async?}[]` (real products get a `logo`: any brand slug or name — a simple-icons slug like `postgresql`, `nextdotjs`, `githubactions`, or a brand title like `Neon`, `Clerk`; the brand's official mark is drawn when found, else its simple-icons glyph. Internal services get none) |
| which module uses which, cycles | `deps` | `nodes: {id, label, group?, ref?}[]`, `edges: {from, to, kind: call\|import}[]` |
| types and how they relate | `classes` | `classes: {name, kind, fields: string[], methods: string[]}[]`, `relations: {from, to, kind: extends\|implements\|owns\|has\|uses, card?: [a, b]}[]` |
| where the time goes in a request | `trace` | `unit`, `spans: {id, label, start, dur, parent?, service?, error?}[]` |
| branches, commits, merges | `git` | `commits: {id, branch, msg, parents: string[], tag?}[]` (oldest first) |

One to three `diff` blocks a message, for the code that matters; the rest
goes in `files`.

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

## Pages: when the blocks aren't enough

A `page` block shows your own HTML file in the chat: for a report with
several parts, an interactive comparison, or a mock-up. The blocks above draw
in the app's own style, so reach for a page only when they can't say it.

What the frame is: as wide as the chat column (up to about 830 px, narrower in
a small window), as tall as the `height` you give (200–900), on a white card,
sandboxed with no outside scripts or fonts. So:

- Make it read fully without its scripts: numbers and labels in the HTML,
  script only for extras such as a hover value or switching tabs.
- Fluid width: grids with `repeat(auto-fit, minmax(…))`, `flex-wrap`, SVG with
  a `viewBox` and `width: 100%`. Charts get a fixed pixel height; `100vh` means little in a fixed frame.
- Set your own background and text colours, light by default, with a
  `@media (prefers-color-scheme: dark)` block if you style dark too.
- Images sit next to the HTML file and are referenced by relative path.

What tends to look native rather than generated:

- Type carries the hierarchy: one large figure or heading per idea (22–28 px,
  semibold), small muted labels (12 px), `font-variant-numeric: tabular-nums`
  for numbers, the system font (`-apple-system, "Apple SD Gothic Neo",
  sans-serif`).
- Colour means something: neutral by default, one accent for what the reader
  should look at, the same accent faded for context, red and green only for
  bad and good.
- Few boxes: whitespace and thin dividers before cards; no shadows, gradients,
  emoji or decorative icons.
- Label data where it is (values on bars, names at line ends) instead of a
  legend, and write the insight on the chart ("캐시 도입", a dashed average line)
  so the prose around it stays short.
- Hand-built HTML, CSS and inline SVG over a chart library: they need no
  network and match the app.

Before you send it, look at it. In your browser tab: `browse open
"file://<page>.html"`, then `ondra-browser set viewport 830 900` and
`browse shot`, then again at 420 wide (a blank or half-drawn shot usually
means a script failed). Set `height` to the page's real height
(`ondra-browser eval "Math.ceil(document.body.getBoundingClientRect().bottom)"`)
so it neither scrolls inside nor leaves a gap.

## Drafts before they go out

When the work ends in something sent in the user's name (an email, a Slack or
messenger message, a post, an invite), show it exactly as it will go out
before sending: an `ask` whose `context` holds the draft (`table` for
recipients, subject and time; `text` for the body, unedited), options like
"보내기" / "고칠게요". Messages written for the user read best in their voice:
read a few of their own recent messages in that place (length, greeting, 존댓말
or 반말, emoji, one message or several) and follow that, not a generic polite
tone. A reply shows the message it answers too.

## Rules

- Show, don't tell: a `compare` beats "속도가 빨라졌습니다", a `diagram` beats a paragraph about how modules talk.
- Screenshots and recordings go in `$APP_ARTIFACTS_DIR`; reference them by absolute path.
- Labels in the user's language (the one they wrote in), plain words, no jargon.
- Valid JSON only: double quotes, no trailing commas, one object per line.

## Boards: an explanation that builds up step by step

Explaining how something works or happens, with one example moving through it
(how a request reaches a server, how DNS resolves, how an LLM picks its next word,
how a payment settles) → a fenced ```board in "text": an explanation that builds up
step by step, written as a short JavaScript program that draws. Each step's things
appear at once and earlier steps step back; the user pages through the steps or plays
them. Keep the prose around it to a line or two. Structure with nothing moving through
it (the parts of a system, a tree, a table) is a diagram or chart block, not a board.
Make it explain, not decorate:
- One concrete example carried through every step (a real request, a real sentence,
  real numbers), each step moving that example along in the same picture. Never a
  separate mini-diagram per step, never a page of sentences.
- Draw the things as things: icon("laptop"), icon("server"), icon("database"),
  icon("lock")… with a 1–3 word label, not boxes with a name in them. Boxes and chips
  are for data (a token, a header, a value).
- Show what happens, not only what is there: travel(a, b) moves the example along its
  way while its step is on, count(x, y, from, to) changes a number when its step comes,
  pulse(shape) rings what the step is about. Most steps have one thing that moves or
  changes.
- Words on the board are 1–4 word labels on what they name; the step says the sentence.
- One flow (left→right or top→down) on a few columns kept in variables; place each
  shape from the ones before it (every shape returns {x,y,w,h,cx,cy,left,right,top,bottom});
  room between things; 3–6 steps.
- Nothing overlaps. A frame holding things is drawn after them, panel(shapes, "이름"),
  so it fits them, and what comes next is placed from its bottom or right. A side
  branch stays out of the next column: end it before that column's left (measure its words).
- Colour carries meaning: accent for what this step is about, quiet for context.
  Quantities get real-looking values (bars, cells, a number), not "많음".
Functions, one call per line, canvas 800 wide, y down, cropped to what you draw:
  title("짧은 제목")   step("이 단계에서 일어나는 일, 짧은 한 문장")   (what follows a step belongs to it)
  icon("server", x, y, {size: 48, label: "서버", center: true}) a picture of a thing, any lucide icon name
    (laptop smartphone monitor server database cloud globe router wifi lock key-round shield user users
    building file-text mail credit-card wallet coins cpu memory-stick hard-drive bot brain package truck clock…)
  travel(a, b, {label, bend, color}) something going from a to b while its step is on (draw its way with connect too)
  count(x, y, from, to, {unit, size}) a number counting to its new value when its step comes
  pulse(shape) a ring breathing around what this step is about
  chip(x, y, "글", o) a tag sized to its words   row(x, y, ["a", "b"], o) tags in a row → [shapes] ({down: true} a column)
  connect(a, b, o) an arrow edge to edge between shapes or [x, y] points ({bend: 30} curves it, {label})
  label(x, y, "글", target, o) a note with a thin leader to a shape or point
  bars(x, y, [["이름", 0.62], …], {pick: 0, w}) chances or amounts   cells(x, y, [0.8, -0.2, …]) a vector
  panel([shapes], "이름", o) a frame around shapes already drawn, its name above them   measure("글", size) its width
  box(x, y, w, h, o) circle(x, y, r, o) ellipse(cx, cy, rx, ry, o) poly([[x, y], …], o) path("M… C… Z", o)
  line / arrow(x1, y1, x2, y2, o) pen([[x, y], …], o) a smooth stroke arc(cx, cy, r, fromDeg, toDeg, o)
  text(x, y, "글", o) highlight(x, y, w, h) dot(x, y, o)
  o: {label, color, fill, dash, arrow, width, size, bold, align: "center"|"right", center: true}
  color: ink quiet accent ok warn bad live violet, red orange yellow green teal sky blue purple pink brown, #hex
For a physical object, build a 3D model instead (the user turns it and clicks a
part to ask about it), parts in building order under their steps. Model it like a
product illustration: real proportions in real units (mm for a board, m for a house),
the visible details the real thing has (pin rows, vents, keys, screws) made in loops,
real colours (a dark green board, black chips, silver ports). Name only the 3–8 parts
the explanation is about, 1–3 words ("RAM", "USB 3.0"); every other part is named "".
What a part does goes in the step, never in its name:
  part("이름", "box", [w, h, d], [x, y, z], {color, rot: [rx, ry, rz]})   shapes: box [w, h, d]
  cylinder [r, h, r_top] cone [r, h] sphere [r] torus [R, r] capsule [r, h]; y up, the ground at 0;
  color: the colour the real thing has, or a material steel wood glass gold copper rubber plastic stone paper
20–150 parts placed where the real ones sit, so it reads as the thing.

Example:

```board
title("주소를 치면 페이지가 뜨기까지")
step("브라우저가 DNS에 example.com의 주소를 물어요")
const pc = icon("laptop", 40, 170, { label: "내 노트북" })
const dns = icon("book-open", 330, 30, { label: "DNS" })
connect(pc, dns, { color: "quiet" })
travel(pc, dns, { label: "example.com?" })
step("DNS가 IP 주소로 답해요")
const ip = chip(dns.right + 24, dns.cy - 18, "93.184.216.34", { color: "accent", fill: true })
travel(dns, pc, { label: "IP" })
step("그 주소의 서버에 페이지를 달라고 해요")
const srv = icon("server", 620, 170, { label: "웹 서버" })
connect(pc, srv, { color: "quiet" })
travel(pc, srv, { label: "GET /" })
pulse(srv)
step("서버가 HTML을 보내면 화면이 그려져요")
travel(srv, pc, { bend: 50, label: "HTML" })
const page = icon("app-window", pc.left + 4, pc.bottom + 40, { label: "화면" })
count(srv.left - 10, srv.bottom + 60, 0, 120, { unit: "ms" })
label(srv.left - 10, srv.bottom + 30, "걸린 시간", undefined, { size: 14 })
```
