# Craft notes

Defaults that usually work. Sources at the end; the brief and the user's
notes outrank all of it.

## The idea

- One idea a stranger can say back in five words ("two quarters passing
  work"). If the idea needs the brief to make sense, the mark is a diagram.
- Ideas come from four places: what the product does (a gesture, not an
  object), the name (a letter, a sound, a meaning), the people, a shape the
  brand already owns. Write 4–6 before drawing; draw at least two that are
  not literal.
- The literal object (a robot for AI, a cart for shops, a leaf for green) is
  where every competitor starts. Use it only through a twist you can name.
- Reduce until removing one more part breaks the idea. Two or three parts
  are plenty for a symbol.

## Grids, ratios, construction

- Build on a square artboard (100 × 100 user units is easy to reason in),
  the mark centred, margins equal (the `artboard` check).
- Circles and straight lines tangent to them carry most strong marks. Pick
  a small set of radii and reuse them; derive the rest from those.
- Ratios worth naming: golden (1.618), √2 (1.414, the "白銀比"/A-paper
  ratio), √3 (1.732), silver (1 + √2). Use one for a reason: part-to-part
  (counter to stroke, mark to wordmark), the outer box, or a real spiral for
  big curves. Draw it in `#construction` so the user sees it.
- Angles: 45° and 90° read as stable; 30°/60° as dynamic; avoid 1–3° "almost
  straight" angles — they read as mistakes.
- Construction is a means. Don't keep a shape that looks wrong because the
  grid produced it; correct it optically and say so.

## Optical corrections (what makes a mark look right, not measure right)

- Overshoot: round shapes (o, c, s, circles next to squares) extend 1–3%
  past the line a flat shape sits on, or they look smaller. Keep the
  overshoot inside the `viewBox` (the source check fails when art is cut off).
- Horizontal strokes look thicker than vertical ones of the same width:
  make horizontals ~5–10% thinner.
- Optical centre sits slightly above the geometric centre; a symbol in a tile
  often wants 1–2% upward. Triangles and arrows centre by their mass, not
  their box (the `balance` check shows the ink centre).
- Where a curve meets a stem, thin the junction (an ink trap) or the joint
  looks swollen at small sizes.
- Rounded corners: one radius family across the mark and the wordmark.
  Inner corners need smaller radii than outer ones to look the same.
- Shapes that touch or overlap leave hairline seams when rendered;
  `union.py` merges them into one outline before delivery.

## Small sizes

- At 16px one pixel is ~6% of the mark. Gaps, counters and strokes under
  ~1px at 16px vanish (`thin`, `counters`, `parts` in the 16px check).
- When the full mark can't survive, draw `mark-small.svg`: fewer parts,
  wider gaps, heavier strokes. Real brands ship small-size drawings.
- Favicons: a mark that fills the square reads better than one with wide
  margins; a tile (mark reversed out of a brand-colour square) survives
  both light and dark tabs.

## Symbols and monograms

- A monogram works when the letters share a stroke, a counter or a stem —
  not when two letters are just placed side by side.
- Negative space is a second read, never the only one: the mark must work
  before the hidden shape is noticed.
- Check what the shape already means: ring with gap = loading/power;
  circle with an arrow = refresh; circle + dot on a stick = ♂; two offset
  semicircles = S; quartered circle = pie chart; four-point star = AI
  sparkle; bowtie = hourglass. If it is one of these, change the idea or
  make the difference obvious.

## Wordmarks and lettering

- Start from a typeface whose skeleton fits the tone (geometric = precise,
  grotesque = neutral, humanist = warm, serif = editorial), then make it the
  brand's: adjust one or two letters (a terminal, a join, the dot of an i),
  set weight between the font's instances with variable axes.
- Kern by area, not distance: the white between letters should look even.
  Round–round pairs (o o) sit closest, straight–straight (n d) farthest;
  diagonals (v, w, y, A, V) tuck in. Check in the opposite colour and upside
  down — spacing errors jump out when you can't read the word.
- Lowercase reads friendlier and holds its shape at small sizes;
  all-caps needs +3–8% tracking.
- Built lettering (one ring + one stem, like the trial's "ondra"): keep
  one stroke width, add overshoot to rounds, make arches as wide as stems
  where they join, and let the last round letter overshoot inside the box.
- Hangul: build or pick lettering for 받침 and 모아쓰기 — a Latin-only
  geometric system rarely carries over; test the actual syllables of the name.

## Lockups

- Horizontal: mark height = the wordmark's ink height (ascender to baseline)
  or 1.2–1.5× the x-height for lowercase; gap ≈ the width of the wordmark's
  stem × 1.5–2. Stacked: mark ~1.7–2.4× the wordmark height, centred.
- Clear space as a unit taken from the mark (a part's height, or a share of
  the mark height), shown in the guide.

## Colour

- Design in one colour. Add colour as a decision: what does each colour
  say, and does the mark still work without it?
- One brand colour plus ink and paper covers most kits. An accent earns its
  place by meaning something (a part of the mark, a state in the product).
- Contrast: graphics need ≥ 3:1 against their background, text 4.5:1. The
  kit measures every pair; a colour that fails on dark gets its own
  dark-background version (lighter tint), not a glow.
- Avoid by default: purple-blue gradients, neon on black, rainbow gradients
  for "AI". Gradients don't survive one-colour printing, embroidery or 16px.

## Failures that make marks look generic

- Clip-art metaphors; swooshes; globes; light bulbs; sparkles; brains; nodes.
- A letter in a circle, in a typeface the user could have typed.
- Five ideas in one mark; details that need a caption.
- Thin hairline marks that vanish at 32px; marks that only work in colour.
- A trendy effect (glass, 3D, glow) instead of a shape.
- A shape copied from a reference, or 70%+ silhouette overlap with a known
  mark (the `unlike refs` check is a smoke test, not a trademark search).

## Sources

- Rikyū (rikyu.ai, viewed 2026-11-13): logos split into geometric marks and
  wordmarks, monochrome first, named proportion systems (golden, √2, √3,
  silver), construction and outline sheets, revisions that state what they
  preserve, the mark applied straight away. Ideas only; no text or assets.
- Common type-design practice on overshoot, stroke contrast, spacing by
  area and ink traps (e.g. Tracy, *Letters of Credit*; Briem's notes on
  spacing; the Google Fonts Knowledge glossary on overshoot and spacing).
- WCAG 2.2 contrast ratio (1.4.3, 1.4.11 non-text 3:1).
- Platform icon specs: Apple touch icon 180px; W3C web app manifest and its
  maskable safe zone (80% circle); favicon.ico with PNG entries.
