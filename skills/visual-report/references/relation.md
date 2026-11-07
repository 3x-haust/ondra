# Relations, flows, hierarchies, sets and maps

One JSON object per line in a `blocks` fence, like every other block. Every kind
takes `label?` (2–5 word title), `unit?` (shown after numbers: "명", "%", "MB") and
`say?`. `em: true` on an item, link or node marks what answers the question; the
rest turns grey. Missing optional fields are fine; invalid rows are skipped.
Use only numbers you really have.

Common pieces:
- link: `{from, to, value, em?, note?}` (ids or names)
- node: `{id, label?, group?, value?, em?, note?}` (nodes are optional when links name them)
- tree: `root: {label, value?, note?, em?, children: [...]}`, or `items` as a list of
  tops with `children`, or `items: [{path: "A/B/C", value}]`, or `items: [{id, parent, label?, value?}]`.
  Values go on leaves; parents are summed.
- region: a 시도 ("서울", "서울특별시", "Seoul", "KR-11") or a country ("KR", "KOR", "대한민국", "Japan")
- place: `{label, lat, lon}` or `{label, region}` (drawn at the region's centre)

## Flows: where an amount goes

- `sankey`: how an amount splits and merges across stages (funnels, budgets, energy).
  `{"type":"sankey","unit":"명","links":[{"from":"검색","to":"랜딩","value":4200}],"path":["검색","랜딩","결제"]}`
  `path` (optional) highlights one route. Cycles are dropped.
- `alluvial`: how members move between categories over time (plan changes, cohorts).
  `{"type":"alluvial","stages":["1분기","2분기","3분기"],"items":[{"path":["무료","베이직","프로"],"value":380}]}`
  One item per trajectory; `path` has one category per stage.
- `chord`: who exchanges how much with whom, in both directions (migration, trade).
  `{"type":"chord","links":[{"from":"수도권","to":"충청권","value":182}],"directed":false}`
  or `{"names":["A","B"],"matrix":[[0,5],[3,0]]}` (row → column). `directed: true` draws arrows.
- `arcdiagram`: connections among items laid in one column, grouped (call graphs, co-occurrence).
  `{"type":"arcdiagram","nodes":[{"id":"auth","label":"인증","group":"코어"}],"links":[{"from":"auth","to":"db","value":410}]}`

## Networks: what connects to what

- `network`: clusters and hubs in a graph; force layout, groups coloured, important nodes labelled, link width = value.
  `{"type":"network","nodes":[{"id":"지수","group":"프론트엔드","value":42}],"links":[{"from":"지수","to":"도윤","value":26,"em":true}]}`
- `adjmatrix`: every pair at once, ordered by group; best for dense graphs (up to ~48 nodes).
  Same fields as `network`; `directed: true` keeps rows → columns.
- `bundle`: where connections between groups concentrate (hierarchical edge bundling).
  Same fields; nodes need `group` (the module, team, package). `directed: true` colours in/out on hover.
- `ego`: one entity's direct (ring 1) and second-hand (ring 2) connections.
  Same fields plus `center: "<id>"` and `depth?: 1 | 2` (default 2).

## Hierarchies: what is inside what

- `treemap`: how a total divides into nested parts, by area with labels.
- `sunburst`: the same as rings, when the levels matter more than exact sizes.
- `icicle`: the same as columns read left → right; good for paths (bundles, folders).
- `pack`: nested groups as circles; rough sizes, membership first.
  All four: `{"type":"treemap","unit":"억","items":[{"label":"AI","children":[{"label":"모델","value":820}]}]}`
  (or `root`, `path` or `parent` forms above).
- `dendrogram`: how items cluster by similarity; leaves aligned. Optional `height` on parents
  (merge distance) places the joins. `radial: true` draws it as a circle.
- `tidytree`: what sits under what, level by level (features, outlines, taxonomies).
- `radialtree`: a wide hierarchy spread around a circle.
  All three: a tree as above (`value` optional).
- `orgchart`: who reports to whom and their roles; boxes click open/closed.
  `{"type":"orgchart","depth":2,"root":{"label":"김지현","role":"본부장","children":[{"label":"박서준","role":"리드","children":[...]}]}}`
  `depth` = levels shown at first (default 2).
- `mindmap`: ideas branching from one topic, split left/right automatically.
  `{"type":"mindmap","root":{"label":"오프라인 모드","children":[{"label":"동기화","children":[{"label":"충돌 해결"}]}]}}`

## Sets: what overlaps

- `venn`: how 2–3 groups overlap; area-proportional when sizes are given.
- `euler`: 2–5 sets where some are inside others or apart (a missing pair means apart).
  Both: `{"type":"venn","unit":"명","items":[{"sets":["검색"],"value":18400},{"sets":["추천"],"value":12100},{"sets":["검색","추천"],"value":6200}]}`
  One-set items are set sizes; multi-set items are the size of the intersection
  (everyone in all of them). Give the 3-way intersection too, or the regions that
  depend on it show no number.
- `upset`: counts for every combination of 4+ sets.
  `{"type":"upset","unit":"곳","items":[{"sets":["슬랙","깃허브"],"value":1220}],"sets":[{"label":"슬랙","value":5200}]}`
  Here each `value` counts items in **exactly** those sets and no others.
  `sets` (optional) gives totals; otherwise they are summed.

## Maps (offline: world-atlas countries, 17 시도)

- `worldmap`: a value per country, as colour. `{"type":"worldmap","unit":"명","items":[{"region":"KR","value":412000}]}`
- `koreamap`: a value per 시도, as colour. `{"type":"koreamap","unit":"만","items":[{"region":"서울","value":933}]}`
  Negative and positive values get a diverging scale centred on 0; skewed values (like population) get quantile classes.
- `koreatile`: the same 17 values on equal squares, so small cities count as much as big provinces. Same fields.
- `bubblemap`: how much sits at each place, as circle area.
  `{"type":"bubblemap","map":"korea","unit":"건","items":[{"label":"이천","lat":37.27,"lon":127.44,"value":48200,"group":"수도권"}]}`
  `map`: `korea` | `world` (default: korea when every place is in Korea). `group` colours up to 3 kinds.
- `dotmap`: how a count spreads over regions, one dot per `per` units.
  `{"type":"dotmap","map":"korea","per":2000,"unit":"곳","items":[{"region":"서울","value":820000,"group":"서비스"}]}`
- `connmap`: which places are linked (routes, offices), as great-circle lines.
- `flowmap`: how much moves from where to where, as arrows (width = value).
  Both: `{"type":"flowmap","map":"korea","unit":"천 명","places":[{"id":"ICN","label":"인천","lat":37.46,"lon":126.44}],"links":[{"from":"부산","to":"서울","value":38}]}`
  `from`/`to` = a place id, a region name, or `{lat, lon}`; `places` is only needed for points that aren't regions.
