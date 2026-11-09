---
name: web-design
description: >
  Designing a site, app screen, landing page or portfolio that should look made
  by a good designer, not by AI. Use for concepts, design directions, mockups and
  building or refining the chosen design. Covers real references, live concept
  prototypes, design-system notes in DESIGN.md, design tokens, visual hierarchy,
  responsive layouts, UI states and accessibility checks. Use for 웹 디자인,
  디자인 시스템, 디자인 토큰, 디자인 규칙, 랜딩 페이지 and 포트폴리오.
---

# Web design

For implementing a supplied design (a Figma link, 피그마 그대로, 디자인 그대로),
read and follow the `mimikyu` skill instead. Do not run concept selection or
redesign a reference the user already chose. This skill is for creating a new
design direction and carrying an approved direction into later work.

## 0. Read the project and the brief

- Establish the page's purpose, audience, main action, real content and existing
  brand assets. Say your interpretation briefly in the report, not on the page.
- Read repository instructions, existing design notes (including `DESIGN.md`
  when present), tokens, components and nearby screens before proposing changes.
  Keep the project's stack, icon family and design system; do not install a new
  framework, font or animation library just to follow a style example.
- User choices and established project rules outrank aesthetic heuristics here.
  Do not guess a new direction or ask the user to choose one they already chose.
  For a focused change in an established design, go to steps 3, 5 and 6; do not
  restart reference gathering or produce concepts for an unchanged direction.
- Ask only when missing intent or content would materially change the result.
  Do not infer permission to rewrite supplied copy, invent facts or replace a
  brand. A design-system documentation task does not require a new UI prototype.

## 1. References first (before a new layout)

- Open what the user pointed at and 4–6 more of the best real examples of the
  same kind (personal sites the user named, awwwards / siteinspire / godly.website
  winners, the products they admire). Use the browser; take screenshots.
- For each, write down the 2–3 concrete moves that make it good: the type pairing
  and sizes, the grid, one signature interaction, how motion responds to the
  user, what is real content (video, photos, product) vs decoration.
- Use brand names and style catalogs as search leads, not authoritative rules.
  Inspect the current site or official guidelines before describing its design.
  Extract useful principles rather than copying branding or a whole page.
- Save screenshots and notes in the project's existing reference location
  (`docs/refs/` if none). Record source URLs and what each reference informs.
  Show the best 3–4 as `shot` blocks so the user sees what you saw.

## 2. Concepts as live prototypes, not boards

- 2–3 directions, each built as a real page (one HTML file each, real fonts,
  real motion, the user's actual content and photos), not a static sketch with
  labels. Each must have one signature interaction the user can try (scroll
  scene, drag, hover reveal, cursor-reactive element, a playful toy).
- Directions must differ in idea, not just color: e.g. "desktop/scrapbook",
  "editorial typography", "single 3D/canvas scene".
- Screenshot each at desktop and phone width, record a short clip of its
  interaction, and send: `shot` blocks + a `link` to the file to open live.
- Ask with options `{label, note}` (note = the feeling in one line) and the shots
  as `context`. Build nothing more until the user picks.

## 3. Keep the chosen design reusable

After the user chooses, update the project's existing design document. If none
exists and the work establishes reusable rules, create a concise `DESIGN.md`
in the project root. For a one-off artifact or a small fix, do not add a design
system or extra exports merely to fill a template.

Record only decisions supported by the approved design or existing code:

- Purpose, audience, visual direction and reference links with their rationale.
- Semantic color roles, actual values and existing token names/source paths;
  distinguish brand accents from success, warning and error colors.
- Typography roles, font families, sizes, weights and line heights; spacing,
  content widths, breakpoints, radius, border and elevation rules.
- Component variants and relevant hover, focus, pressed, disabled, loading,
  empty and error states; responsive behavior and reduced-motion alternatives.
- Asset provenance, usage constraints and a short list of project-specific
  do's and don'ts. Record unknowns as unknowns, not invented exact values.

Keep existing token files authoritative; reference them instead of introducing
an independently maintained second token set. Use the project's document format,
not an assumed external schema or CLI. Export tokens only when the task needs it
and the project has a consumer. Before later work, read these notes again; update
only decisions changed by the user or implementation, without erasing unrelated
rules. Resolve a conflict with the approved direction before changing its look.

## 4. Avoid generic defaults

- The brief leaking into the page: the concept's name or option label
  ("편집형 프로젝트 전시", "A · 간결한 소개문"), the reference sites' names,
  the user's direction words ("차분한", "인터랙티브") printed as copy.
- Explanatory captions inside the design ("사례 전시 도판 · 실제 제품 화면 아님",
  "왜 추천하나요?", "작은 화면" panels). The page is the product, not a pitch.
- Beige/cream + serif numerals + one orange accent by default; purple gradients;
  glassmorphism cards; emoji icons.
- Everything centered in equal boxes; three identical cards in a row; every
  section the same height and rhythm.
- Generic headlines ("불편을 발견하고, 작동하는 흐름으로."), filler copy, fake
  metrics. Use the user's real words, projects, numbers, photos.
- Motion that loops by itself or decorates; fade-up on every block. Motion
  answers the user (scroll, cursor, click) and has one hero moment.
- An arbitrary font pairing or a default font stack chosen without context.
  Keep the brand's fonts, including system fonts when intentional; for a new
  direction, choose typography from the references and verify language coverage.

These are warnings against unthinking defaults, not bans on a user's palette,
font or layout. Do not replace one formula with another: no mandatory asymmetry,
hero line count, card quota, single accent, dark mode or motion intensity.
Hierarchy and density should serve the content; repeated layouts can be right
for comparable data. Keep meaning and readability ahead of novelty.

## 5. Build with the project's pieces

- Use the approved design notes and existing tokens/components. Keep spacing,
  radii, icons, color roles and typography consistent across sections and states.
- Make the primary action and reading order clear. Use whitespace, alignment,
  scale and grouping deliberately; don't wrap every item in a card. Keep labels
  for the same action consistent without changing the user's supplied wording.
- Plan each section's small-screen layout, including navigation, dense content,
  long labels and text expansion. Prevent accidental overflow and clipped text;
  do not hide content or shrink it into illegibility to make it fit.
- Use real photos, product screenshots and videos. Ask for missing factual
  assets rather than fabricating products, endorsements or customer logos.
  If illustration is in scope, choose its purpose and placement first, then use
  available tools to produce or source it with appropriate usage rights. Never
  present a generated illustration as a real product screenshot. For charts or
  infographics, follow `visual-report` and use sourced data, not decorative numbers.
- Implement relevant UI states, not just a successful static screen. Forms need
  persistent labels, useful errors and visible focus. Links navigate and controls
  perform the advertised action; do not add fake interactions to fill a concept.
- Motion should explain an action, transition or hierarchy. Use existing motion
  tools or simple CSS; don't introduce a dependency for ornament. Preserve content
  and operation with reduced motion and without hover on touch devices. Reserve
  media space to avoid layout shifts; keep expensive effects out of routine input.

## 6. Check the rendered result

Read `browser-use` before browser work. Reuse the project's existing checks and
capture the real page, not just source or a successful build.

- Compare the approved direction and implementation side by side at desktop and
  390px phone width (plus requested widths). Inspect hierarchy, alignment,
  wrapping, navigation, asset loading and consistent tokens across sections.
- Exercise the primary action and the states the changed flow can enter. Check
  keyboard order, visible focus, labels and touch access; essential information
  must not depend on color or hover alone. Check reduced motion, and both themes
  only if the project supports them or the task asks for them.
- Measure text and control contrast with an available checker against the actual
  backgrounds, including images and overlays. Report the measured result and
  scope; an attractive screenshot or one contrast check is not an accessibility
  conformance claim. If no checker is available, mark contrast unverified.
- Read visible copy, labels, alt text and errors: remove brief/option labels,
  filler, invented facts and awkward generated wording. Keep the user's content
  and voice intact. Do not add explanatory production notes inside the product.
- Check changed-file tests, types and lint required by the repository. If a
  performance claim is in scope, measure the same workload before and after;
  never invent scores or add a broad audit for a small design change.
- Fix observed defects and recheck only affected paths. Finish with screenshots
  covering the changed sections and a clip when interaction is part of the work.
  Report the design-note path, actual checks and anything unverified separately.
  Updating a skill or design document alone does not prove a rendered UI works.
