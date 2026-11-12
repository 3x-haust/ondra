---
name: mimikyu
description: >-
  Figma → code → measured verification loop (Mimikyu / 따라큐). Implement a
  supplied design, capture the rendered app, compare pixels and live DOM
  geometry/style against a saved design contract, and fix measured differences.
  Use for figma.com URLs, 피그마 링크, 피그마 그대로, 디자인 구현, 디자인 그대로,
  픽셀 퍼펙트, pixel perfect, or "make it look exactly like the Figma".
  Keep looping until overall_match >= 99%, every region >= 99%, and zero
  structural mismatches; report blocked or incomplete gates honestly.
metadata:
  ondra-urls: 'figma\.com/(design|file|proto|make)/'
---

# Mimikyu (따라큐)

## Design → Code → Measure loop

The supplied design is the source of truth; `figma-data.json` is the
machine-readable contract. Do not judge "looks close" — measure and loop.

```
FIGMA DATA → code → run app → screenshot → pixel diff → structural verify → fix → re-loop
```

Use this workflow for implementing a supplied design. Use `web-design` for
creating a new design or choosing a direction, not for redesigning an existing
reference. Do not ask for new concepts when the design already fixes them.

## What the AI decides vs what is fixed

Follow repository instructions, existing stack, helpers, tests and file layout.
Follow user-provided choices exactly; in a new project, decide unspecified
technical choices yourself. Do not replace an existing stack to match an
example. Geometry, typography, colors, content and interactions come from the
design, not the agent's taste. The measurement gates below are fixed.

## Tools and evidence

This skill is a workflow, not an installed measurement toolchain. `browser-use`
covers driving the browser; use Ondra's shared browser and your own tab. Discover available Figma tools with `tool_search`; use the user's
existing access rather than assuming a particular MCP server is installed.

Inspect the project's measurement tools first. If it already has screenshot,
pixel comparison or DOM verification scripts, read them and their help, then
reuse them with explicit paths. Never assume scripts exist outside the project
or relative to the app's bundled skill folder. Do not write into the app bundle.

If measurement helpers are missing, create only the focused project-local
helpers needed for the checks below, using available browser automation and
image tools (for example Playwright and Python/Pillow). Verify dependencies
before invoking them. Establish that a known mismatch fails and an identical
fixture passes before trusting a checker. Keep thresholds, matching rules and
regions fixed across iterations; do not weaken a checker to make the app pass.
If access, dependencies, fonts or a trustworthy checker are unavailable, report
that gate as blocked, not passed. Skill availability does not imply Figma
access or measurement dependencies are installed.

Save captures, heatmaps and measured reports in `$APP_ARTIFACTS_DIR`. Keep the
stable design contract and real source assets in the project's chosen layout.
Record commands, viewport, device scale, reference node and iteration alongside
results so another worker can reproduce them. Never infer measurements from
screenshots by eye or invent a percentage.

## Steps

### 1. Extract (once)

1. Parse the file key and node ID from the Figma URL.
2. Pull design data with an available Figma tool or API; save the raw result as
   `figma-data.json`. Preserve node IDs, hierarchy, bounds, text and styles.
3. Download real assets (photos, illustrations, logos) and export the target
   frame as a reference PNG. Record viewport dimensions and export scale.
4. During the loop, read the saved contract rather than Figma again, so every
   iteration is measured against the same thing. Re-extract when the user
   changes the reference or the extraction was incomplete; record the change
   and restart measurements against the new contract.

Verify every requested node, or state the user-approved node scope explicitly.
For a supplied screenshot without Figma data, preserve it as the reference and
measure what it actually reveals. Do not fabricate a Figma contract, exact font
metadata, hidden states or a structural pass. Request missing design data when
it blocks a gate and report the remaining limitations.

### 2. Generate code

Work in the project's stack and structure. Read `figma-data.json` for geometry
and styles; use real assets. The agent chooses component structure, but the
rendered result must match the contract. Do not render the reference PNG as
the implementation.

### 3. Verify loop

Start the app and verify the actual page, not only a build or static markup.
Capture the full page at the reference viewport and scale. Emulate reduced
motion, scroll to trigger in-view content, settle images and fonts, then return
to the capture position. Preserve the actual document dimensions: never resize
or crop a mismatch away. Capture all requested viewports and design states.

Use two independent signals:

- **Pixel comparison:** overall and all nine region match percentages
  (top-left through bottom-right), plus a heatmap. A width or height mismatch
  is a hard failure. Record the comparison algorithm and tolerance; retain the
  same settings for every iteration.
- **Structural verification:** match each Figma TEXT node to a live DOM element
  and compare expected/actual x, y, color, font size, font weight, line height
  and letter spacing. Normalize whitespace and line breaks, not missing text
  or duplicate elements. Account explicitly for frame origin, scrolling and
  export scale. Missing or ambiguous matches are not passes. Flag unintended
  text-box overlap greater than 30% as critical; do not flag intentional
  parent/child containment as two overlapping text nodes.

Persist expected, actual and delta values with node IDs and selectors. A
verifier must fail when required nodes are missing or no nodes were checked.
Check other requested widths against their corresponding design frames rather
than scaling desktop coordinates and calling that a mobile match.

### Optional Builder / read-only Visual Critic handoff

Use an independent visual critic only when the work's size or uncertainty
justifies it. Give it the frozen contract, captures, measured differences and
node-to-selector mapping; it does not edit source. A short ranked list works
best: each issue with expected/actual/delta, confidence, root cause, a bounded
fix and what must not change. When children share an offset, inspect their nearest
common parent first. The owner verifies the combined result; deterministic
pixel and DOM checks, not the critic's opinion, decide acceptance.

### 4. Fix, driven by the numbers

Fix the biggest measured differences first: structure/viewport, position and
spacing, typography and color, then borders, shadows and one-pixel details.
Find the node in `figma-data.json`, make the smallest justified change and
rerun both checks. Protect already matching geometry from regressions. Near
the threshold, re-read exact colors, coordinates and font values instead of
guessing.

### 5. Behaviors

If the design defines interactions, verify them in the real app: click,
capture and compare with the corresponding design state. Toggles toggle,
inputs focus, links navigate and modals open and close. Run the project's
required tests, type checks and lint too; visual fidelity does not replace
functional verification.

## Rules that protect the match

1. Take values from the saved design contract, not from memory.
2. Keep design values exact: convert normalized colors once; preserve
   geometry and typography rather than rounding to convenient values.
3. Don't invent design decisions or add decoration absent from the reference.
4. Reference screenshots are measuring inputs, never app assets. Only real
   photos, illustrations, logos and other design assets belong in the app.
5. Never declare done while a required gate fails or remains unmeasured.

## Completion gates — ALL must pass

```
[ ] figma-data.json extracted and stable
[ ] overall_match >= 99%
[ ] every region >= 99% (all nine)
[ ] structural mismatches == 0
[ ] critical mismatches == 0 (wrong text/asset/color/font/navigation, overlap)
[ ] interactions checked (if the design defines them)
[ ] final screenshot + measured report produced
```

Dynamic/API content that differs from design placeholders is reported as
unmatched, not silently excluded or filled with fake data. Do not loop forever
on unavailable content: show its effect on the gates and hand over incomplete
unless the user explicitly changes the scope.

## Stop condition and report

When several iterations bring no improvement, re-derive the fix list from the
contract instead of nudging values. If that still doesn't move the numbers,
hand over with concrete per-element deltas, failed gates and the next useful
action. Access or
dependency blockers also require an honest incomplete report, not a pass.

Use Ondra's reporting blocks and the user's language. Include the actual overall
match, minimum region match, structural/critical mismatch counts, interaction
checks and links to the final capture and measured report. Use only numbers
produced by executed checks; list every unverified or unmatched part.
