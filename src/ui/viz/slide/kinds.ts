// The slide family's kinds (presentation and business figures). Pure, for types and tests.
export const KINDS = [
  // strategy
  "quadrant", "positioning", "swot", "pest", "frame", "forces", "valueChain", "bmc", "lean", "ansoff", "risk", "empathy",
  // structure
  "pyramid", "onion", "stack", "hub", "issueTree", "decisionTree", "pillars",
  // process
  "chevrons", "staircase", "cycle", "swimlane", "journey", "fishbone", "funnel",
  // plans and projects
  "roadmap", "gantt", "milestones", "kanban", "okr", "raci",
  // comparison and status
  "features", "prosCons", "harvey", "scorecard", "pricing", "persona", "quote", "agenda", "section", "team", "points", "combine",
  // composition
  "layout", "slide",
] as const;
