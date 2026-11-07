// Kinds of the chart family (pure, for types and tests).
export const KINDS = [
  "line", "stepLine", "area", "stackedArea", "percentArea", "stream", "fan", "surplus", "cumulative", "burnup", "burndown", "smallMultiples",
  "groupedBars", "stackedBars", "percentBars", "diverging", "barLine", "popPyramid", "waterfall", "pareto",
  "lollipop", "dotPlot", "dumbbell", "rangeBars", "bullet", "slope", "bump",
  "pie", "donut", "radar", "rose", "radialBars", "gauge", "parliament",
  "calendar", "heatmap", "heatTable", "waffle", "pictogram", "marimekko", "shareBar", "areaCompare", "bubble", "connected",
  "candle", "kpiTiles", "goals", "bigNumber", "sparkTable",
] as const;
