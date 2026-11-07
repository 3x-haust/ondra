# Charts: comparison, change over time, part of a whole, finance and KPIs

Every block also takes `label` (2–5 word title) and `say` (one-sentence takeaway).
Numbers are plain JSON numbers; `unit` is shown after values ("명", "ms", "%", "억 원").
Missing or bad values are skipped, so leave a gap as `null` rather than inventing one.
Use only numbers you really have.

Shared shapes:
- **series over x**: `"x": ["1월","2월",…]` (labels, numbers or ISO dates "2026-03-01"),
  `"series": [{"label","values":[…],"em"?:true,"dash"?:true}]`, values line up with x.
  One series may be written as `"values": [...]`. `em: true` highlights that series and greys the rest.
- **items**: `"items": [{"label","value","note"?,"highlight"?:true}]`.

## Change over time

- `line` — how values changed over time, one or many series.
  `{"type":"line","label","unit","x":[…],"series":[…],"log"?:true,"markers"?:true,"curve"?:"smooth","target"?:{"value","label"},"events"?:[{"x","label","series"?}]}`
  `events` without `series` draw a dated rule; with `series` they mark that point. Ends are labelled directly.
- `stepLine` — a value that jumps at moments (price, plan, setting). Same fields as `line`.
- `area` — one quantity (1–3 series) rising and falling over time. Same fields as `line`.
- `stackedArea` — the total and its parts over time. `{x, series, unit}`
- `percentArea` — how the mix (shares) changed over time. `{x, series, unit}`
- `stream` — the flow of many categories over time, shape over exact values. `{x, series, unit}`
- `fan` — a forecast and its uncertainty.
  `{"type":"fan","x":[…],"values":[actual…,null…],"forecast":[null…,f…],"lo":[…],"hi":[…],"lo2"?:[…],"hi2"?:[…],"band"?:"80% 구간","band2"?:"95% 구간","unit"}`
  lo/hi is the inner interval, lo2/hi2 the outer; all aligned with x.
- `surplus` — when a value was above or below a baseline. `{x, values, base?:0, above?:"흑자", below?:"적자", unit}`
- `cumulative` — running total so far, against a goal. `{x, series (per-period values), target?:{value,label}, unit}`
- `burnup` — done work climbing toward a scope that may grow. `{x, scope:[…], done:[…cumulative, null for future], unit, events?}`
- `burndown` — remaining work vs. the ideal line. `{x, remaining:[…, null for future], unit}` (or `scope` + `done`)
- `smallMultiples` — many series, each in its own mini chart on one shared scale. `{x, series, unit, cols?}`
- `slope` — change between two points in time per item. `{"x":["2024년","2026년"],"items":[{"label","values":[a,b],"em"?}],"unit"}`
- `bump` — how rankings swapped over time. `{x, series:[{label, values}], "rank"?:true}` — `rank: true` when values are ranks (1 = top); otherwise ranks are computed (largest = 1).
- `connected` — how two measures moved together over time. `{"items":[{"label":"2024","x","y"}],"xLabel","yLabel","xUnit","yUnit"}` (in time order)
- `calendar` — activity per day, GitHub-style. `{"days":[{"date":"2026-05-11","value"}],"unit"}`
- `heatmap` — a value at every row × column (weekday × hour, month × product). `{"x":[cols],"y":[rows],"values":[[row1…],[row2…]],"unit","diverging"?:true,"mid"?:0}`
- `sparkTable` — rows of name, sparkline, latest value and change. `{"items":[{"label","values":[…],"value"?,"change"?}],"unit","better"?:"up"|"down","changeUnit"?:"%"}` (change defaults to % from first to last)

## Comparison

(Survey answers on an agree–disagree scale: `likert` in stat.md.)

- `groupedBars` — sizes per category, several series side by side (one series = simple bars).
  `{x, series, unit, "dir"?:"v"|"h", "target"?:number}` or `{items, unit, dir}`. Long labels switch to horizontal on their own.
- `stackedBars` — totals per category and what they are made of. `{x, series, unit, dir?}`
- `percentBars` — the mix per category (each bar = 100%). `{x, series, unit, dir?}`
- `diverging` — above or below zero per item (growth, profit, deviation). `{items:[{label, value}], unit, "sort"?:false}`
- `barLine` — bars and a line in the SAME unit on one axis (actual vs plan/average). `{x, series:[{label, values}, {label, values, "as":"line"}], unit}`. Never two units.
- `lollipop` — many items ranked, lighter than bars. `{items, unit, sort?:false}`
- `dotPlot` — several groups per item as dots on one line (Cleveland). `{"series":["신입","5년 차"],"items":[{"label","values":[…]}],"unit"}`
- `dumbbell` — before → after per item. `{"from":"이전","to":"이후","items":[{"label","values":[before, after]}],"unit"}`
- `rangeBars` — min–max span per item, optional current dot. `{"items":[{"label","min","max","value"?}],"unit","valueLabel"?}`
- `bullet` — each measure against its target and poor/ok/good bands. `{"items":[{"label","value","target"?,"bands"?:[poor_to, ok_to, good_to],"max"?,"unit","note"?}]}`
- `radar` — strengths of 1–3 options across criteria. `{"axes":[…],"series":[{"label","values":[…]}],"max"?}`
- `rose` — amount per period/direction around a circle (Nightingale), stackable. `{x, series, unit}`
- `radialBars` — a few items' progress or size on round tracks. `{items, "max"?:100, unit}`
- `bubble` — three numbers per item (x, y, size) plus a group. `{"items":[{"label","x","y","size","group"?}],"xLabel","yLabel","sizeLabel","xUnit","yUnit","sizeUnit"}` (≤ 3 groups)
- `areaCompare` — big differences felt as circle areas. `{items, unit, "shape"?:"square"}`
- `popPyramid` — two groups' distributions back to back (men/women by age). `{"x":["10대",…] (youngest first),"series":[{"label":"남성","values"},{"label":"여성","values"}],"unit"}`
- `heatTable` — a number table with each column coloured from low to high. `{"columns":[…],"rows":[{"label","values":[…]}],"better"?:["up","down",…],"units"?:[…],"scale"?:"col"|"all","diverging"?:true,"corner"?}`

## Part of a whole

- `pie` — one whole split into a few parts. `{items, unit}` More than 6 parts: the largest 5 stay and the rest fold into 기타.
- `donut` — the same with the total in the middle. `{items, unit, "center"?}` (same 6-part rule)
- `shareBar` — one whole as a single 100% bar. `{items, unit, "show"?:"value"}` (same 6-part rule)
- `waffle` — shares counted as 100 squares. `{items, unit, "cells"?:100}` (same 6-part rule)
- `pictogram` — "7 of 10 people". `{"value":7,"total":10,"unit":"명","valueLabel"?}` or `{"total":100,"items":[{label, value}]}` (over 100, one icon stands for several)
- `marimekko` — category size (width) and its mix (height) at once (marimekko). `{x, series, unit}`
- `parliament` — fixed seats split among groups. `{items, "total"?, "majority"?:number|false}`
- `waterfall` — how a start value became the end value through gains and losses.
  `{"items":[{"label":"전년","value":120,"total":true},{"label":"매출 증가","value":64},{"label":"원가","value":-38},{"label":"소계","total":true},…],"unit"}`
  `total: true` draws a subtotal bar (its `value` optional: the running sum is used).
- `pareto` — which few causes make up most of the total. `{items, unit, "valueLabel"?:"건수", "rule"?:80}`
  The cumulative-% line uses a second axis drawn 0–100% at the right. This is the one allowed second axis; never add one elsewhere.

## Finance and KPIs

- `candle` — price open/high/low/close per period with volume below. `{"items":[{"x":"10/1","o","h","l","c","v"?}],"unit","style"?:"ohlc","ma"?:[5,20]}` (up warm, down blue)
- `gauge` — one value within a range and its bands. `{"value","min"?:0,"max"?:100,"unit","target"?,"bands"?:[{"to","status":"good"|"warn"|"serious"|"bad","label"}]}`
- `kpiTiles` — several headline metrics with change, trend and target. `{"vs"?:"전월 대비","items":[{"label","value","unit","delta"?,"deltaUnit"?:"%","better"?:"up"|"down","trend"?:[…],"target"?}]}`
- `goals` — progress of several goals. `{"items":[{"label","value","target","unit","note"?}]}`
- `bigNumber` — the one number that matters and its comparison. `{"label","value","unit","compare"?:{"label":"작년 3분기","value"},"delta"?,"better"?,"vs"?,"trend"?:[…],"note"?}`
