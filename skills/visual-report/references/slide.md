# Slide figures (발표·업무 도식)

Presentation and business figures. Each line: the question it answers, then
the exact shape. Shared fields: `label` (2–5 word title), `say` (one-line
takeaway under the picture), `note` (≤ ~6 words), `em: true` (the one thing
that answers the question), `state`: done / now / todo / risk / late / new /
changed / gone / off. A list item may be a plain string where it only has a
label. Items that can't be drawn are left out, the rest still draws.
Use only facts you have; never fill a frame with invented points.

## Strategy

- `quadrant`: two criteria split things into 4 (or 9) boxes; where is each item? (BCG, Eisenhower, impact–effort, 9-box)
  `{"type":"quadrant","x":{"label":"노력","lo":"적음","hi":"많음"},"y":{"label":"영향","lo":"작음","hi":"큼"},"quads":[{"label":"빠른 성과","em":true},{"label":"큰 과제"},{"label":"자투리"},{"label":"보류"}],"items":[{"label":"결제 재시도","x":3.5,"y":9,"em":true}]}`
  quads in reading order (top-left, top-right, bottom-left, bottom-right; 9 with `"n":3`). items: x, y on 0–1, 0–5, 0–10 or 0–100 (or set `x.min`/`x.max`); `size?`, `group?` (colour + legend). No items → quads with `items: string[]` lists each box's contents.
- `positioning`: on two attribute axes, where do we and competitors stand?
  `{"type":"positioning","x":{"lo":"저가","hi":"고가"},"y":{"lo":"간편함","hi":"전문성"},"items":[{"label":"우리 제품","x":0.2,"y":0.55,"em":true,"size":12}]}` x, y on −1..1 (or 0..max, centre is the middle); `size?` = market share etc.
- `swot`: strengths, weaknesses, opportunities, threats (and the strategies from them).
  `{"type":"swot","s":[…],"w":[…],"o":[…],"t":[…],"so?":[…],"st?":[…],"wo?":[…],"wt?":[…]}`
- `pest`: political / economic / social / technological (+ legal, environmental) changes outside.
  `{"type":"pest","p":[…],"e":[…],"s":[…],"t":[…],"l?":[…],"env?":[…]}`
- `frame`: any fixed framework of named boxes: 3C, 4P, 4C, STP (arrows), or your own.
  `{"type":"frame","preset":"3c|4p|4c|stp","items":[{"points":[…]},{"label":"고객","points":[…],"em":true}],"flow?":true}` labels come from the preset when left out; without a preset give each `label` (and `key?`, a letter).
- `forces`: Porter's five forces, how strong is each?
  `{"type":"forces","rivalry":{"level":5,"points":[…]},"entrants":{…},"suppliers":{…},"buyers":{…},"substitutes":{…}}` level 1–5 or "낮음|보통|높음".
- `valueChain`: which activities create value, where are we strong?
  `{"type":"valueChain","support":[{"label":"기술 개발","note":"…","em":true}],"primary":[{"label":"운영","points":[…]}],"margin?":"이윤"}` (Porter's default names if left out).
- `bmc`: business model canvas. `{"type":"bmc","partners":[…],"activities":[…],"resources":[…],"value":[…],"relations":[…],"channels":[…],"segments":[…],"costs":[…],"revenue":[…]}`
- `lean`: lean canvas. `{"type":"lean","problem":[…],"solution":[…],"metrics":[…],"value":[…],"advantage":[…],"channels":[…],"segments":[…],"costs":[…],"revenue":[…]}`
- `ansoff`: grow with existing/new products in existing/new markets?
  `{"type":"ansoff","penetration":[…],"product":[…],"market":[…],"diversification":[…],"pick?":"product"}`
- `risk`: which risks are both likely and severe? (5x5 heat grid, numbered)
  `{"type":"risk","x?":"영향도","y?":"발생 가능성","n?":5,"items":[{"label":"이중 결제","impact":5,"likely":3,"note?":"…"}]}`
- `empathy`: what does this user say, think, do, feel?
  `{"type":"empathy","name":"카페 점주 이수진","says":[…],"thinks":[…],"does":[…],"feels":[…],"pains?":[…],"gains?":[…]}`

## Structure

- `pyramid`: levels that narrow upward (or `"invert":true`, widest on top).
  `{"type":"pyramid","unit?":"개","items":[{"label":"E2E 테스트","note":"…","value?":12}]}` top first.
- `onion`: a core wrapped by layers (golden circle, access tiers). `{"type":"onion","items":[{"label":"왜","note":"…"}]}` innermost first.
- `stack`: layers on top of each other and what's in each (tech stack).
  `{"type":"stack","items":[{"label":"API","parts":["Rust axum","GraphQL"],"note?":"…","em?":true}],"side?":[{"label":"모니터링"}]}` top first; `side` = cross-cutting bars.
- `hub`: one centre and what it connects to. `{"type":"hub","center":"CDP","items":[{"label":"앱","note":"행동 로그"}]}` (≤ 10)
- `issueTree`: a question broken down MECE (logic / issue / driver tree).
  `{"type":"issueTree","root":{"label":"영업이익 18% 감소","items":[{"label":"매출 감소","items":[{"label":"고객 수 감소","note":"-22%","em":true}]}]}}`
- `decisionTree`: which choice has the best expected value? Values are rolled back for you.
  `{"type":"decisionTree","unit?":"억","root":{"label":"출시 결정","items":[{"label":"올해 출시","cost?":12,"items":[{"label":"수요 높음","p":0.4,"value":60},{"label":"수요 낮음","p":0.6,"value":-10}]},{"label":"출시 안 함","value":0}]}}`
  branches with `p` make a chance node (p as 0–1 or %), otherwise a decision; leaves carry `value`.
- `pillars`: a goal (roof) held up by pillars on a base (strategy house).
  `{"type":"pillars","roof":"재구매율 45%","items":[{"label":"빠른 배송","points":[…]}],"base?":["고객 데이터 통합"]}`

## Process

- `chevrons`: steps in order and where we are now (presentation arrows).
  `{"type":"chevrons","items":[{"label":"설계","note":"…","state":"done|now|todo"}]}` (≤ 8)
- `staircase`: step-up stages, which step are we on (maturity). `{"type":"staircase","items":[{"label":"대시보드","note":"…"}],"now?":2}`
- `cycle`: a loop that starts over. `{"type":"cycle","center?":"2주마다","items":[{"label":"측정","note":"…"}]}`
- `swimlane`: who hands what to whom, in order.
  `{"type":"swimlane","lanes":["고객","상담원"],"steps":[{"id":"a","lane":"고객","label":"환불 요청","to":["b"]},{"id":"b","lane":"상담원","label":"사유 확인","col?":1}]}`
  without any `to`, steps chain in the order written; `col` puts a step in a given column (parallel steps).
- `journey`: what the customer does, where we meet them, how they feel, stage by stage.
  `{"type":"journey","stages":[{"label":"결제","doing":[…],"touch":["결제창"],"think?":"…","pain?":"…","idea?":"…","feel":-2}]}` feel −2..2 (or 1..5 with `"scale":5`).
- `fishbone`: causes of a problem by category (Ishikawa).
  `{"type":"fishbone","effect":"익일 배송 실패 8%","items":[{"label":"설비","causes":["분류기 정지"]}]}`
- `funnel`: how many remain at each stage and where most drop. `{"type":"funnel","unit?":"명","items":[{"label":"방문","value":48200}]}` (shares between stages are computed)

## Plans and projects

- `roadmap`: what each track does in each period.
  `{"type":"roadmap","periods":["1분기","2분기","3분기","4분기"],"now?":"1분기","lanes":[{"label":"앱","items":[{"label":"오프라인 모드","from":"2분기","to":"3분기","state?":"now"}]}]}` from/to = a period name or index.
- `gantt`: when each task runs, what it waits for, how far along, today.
  `{"type":"gantt","today?":"2026-11-18","tasks":[{"id":"api","label":"API 개발","start":"2026-11-12","end":"2026-12-04","done?":0.3,"dep?":["plan"],"group?":"개발"}],"milestones?":[{"label":"출시","at":"2026-12-18","dep?":["qa"]}]}`
  `days` instead of `end` also works; numbers instead of dates (`"start":0,"end":3,"unit":"주"`) for a relative plan.
- `milestones`: key dates spaced by real time. `{"type":"milestones","dir?":"h|v","today?":"2026-11-08","items":[{"label":"SOC 2 인증","at":"2026-12-01","note?":"…","state?":"done","em?":true}]}` (YYYY-MM-DD; the built-in `timeline` is for order without dates)
- `kanban`: how many cards sit in each column. `{"type":"kanban","columns":[{"label":"진행 중","limit?":2,"cards":[{"label":"결제 재시도 큐","tag?":"결제","who?":"이민지","state?":"done"}]}]}`
- `okr`: objectives, their key results and progress.
  `{"type":"okr","items":[{"label":"신규 고객이 첫 주에 가치를 느낀다","who?":"그로스팀","krs":[{"label":"첫 주 활성화율","start?":31,"value":38,"target":45,"unit":"%"},{"label":"연간 결제 비중","progress":0.25}]}]}` (≥ 70% reads as on track)
- `raci`: who is responsible, accountable, consulted, informed.
  `{"type":"raci","roles":["PM","백엔드","QA"],"rows":[{"label":"결제 API 교체","cells":["I","AR","C"]}]}`

Burndown and burnup charts are line charts: see `chart.md`. Venn diagrams: see `relation.md`.

## Comparison and status

- `features`: which product supports which feature. `{"type":"features","cols":["우리 제품","노션"],"em?":0,"rows":[{"label":"SSO","v":[true,"partial"],"group?":"보안"}]}` v: true / false / "partial" or short text.
- `prosCons`: good and bad sides, which weighs more. `{"type":"prosCons","pros":[{"label":"…","weight?":5}],"cons":[…],"verdict?":"…"}`
- `harvey`: how well each option meets each criterion. `{"type":"harvey","cols":["성능","비용"],"rows":[{"label":"pgvector","v":[2,4]}]}` v: 0–4 quarters.
- `scorecard`: target vs actual per metric with status. `{"type":"scorecard","items":[{"label":"이탈률","target":3,"actual":4.1,"unit":"%","better?":"down","status?":"good|warn|bad"}]}` (status computed when left out)
- `pricing`: tiers, prices and what's included. `{"type":"pricing","unit?":"월","items":[{"label":"팀","price":9000,"note?":"50명까지","plus?":"스타터의 모든 기능, 그리고","features":[…],"em?":true}]}` price: number (원) or text.
- `persona`: who we build for. `{"type":"persona","name":"김하린","role":"34세 · 구매 담당","quote?":"…","tags?":[…],"goals":[…],"pains":[…],"traits?":[{"lo":"가격 우선","hi":"품질 우선","value":0.6}]}`
- `quote`: one sentence shown big, or a number with its sentence (a bare KPI number: `bigNumber` in `chart.md`). `{"type":"quote","text":"…","by?":"인터뷰 P4","role?":"…"}` or `{"type":"quote","value":"38%","text":"…"}`
- `agenda`: today's order and where we are. `{"type":"agenda","now?":1,"items":[{"label":"결제 장애 회고","note?":"…","time?":"15분"}]}`
- `section`: a new chapter starts. `{"type":"section","no":2,"title":"원인 분석","note?":"…"}`
- `team`: who is on it and their role. `{"type":"team","items":[{"label":"오지훈","role":"PM","note?":"일정·범위"}]}`
- `points`: a few key points / takeaways as numbered cards. `{"type":"points","cols?":3,"items":[{"label":"…","note":"…","em?":true}]}` (a `value` replaces the number)
- `combine`: these combine into that (A + B = C). `{"type":"combine","op?":"+|×|→","items":[{"label":"새벽배송"}],"result":{"label":"재구매율 +14%p"}}`

## Composition

Blocks hold blocks: any block (built-in or from any family) can go in `items`.

- `layout`: several blocks side by side in 1–4 columns; collapses to one column when narrow.
  `{"type":"layout","cols":3,"items":[{"type":"metric","label":"월 매출","value":"12.8억"},{"type":"metric",…},{"type":"metric",…}]}`
  an item's `span: 2` widens it. A picture list is a layout of `shot`; for KPI tiles see `kpiTiles` in `chart.md`.
- `slide`: one 16:9 presentation page: title, subtitle, bullets and/or blocks; scales with the column and shrinks its body to fit.
  `{"type":"slide","title":"결제 실패, 재시도로 70%를 되살린다","subtitle?":"…","bullets?":[…],"cols?":2,"items":[{"type":"funnel",…},{"type":"points",…}],"foot?":"출처","no?":7}`
  Keep a slide to one message and ≤ 3 blocks; nesting stops after 3 levels.
