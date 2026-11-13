---
name: logo-design
description: >
  Designing a logo, brand mark or wordmark (로고, 로고 디자인, 로고 만들어, 심볼,
  브랜드 마크, 워드마크, 모노그램, 파비콘, 앱 아이콘, 브랜드 키트, 브랜딩, BI, CI,
  logo, brand identity, favicon) as hand-built SVG: a short brief, real references, a
  few distinct concepts with their construction, measured checks (16px, one colour,
  light and dark, contrast, likeness to known marks), a comparison page the user
  picks from, then a brand kit: lockups, favicon set, palette, type, OG image and a
  one-page usage guide.
metadata:
  ondra-commands: 'logo-design/scripts/|\b(sheet|kit|contact)\.mjs\b|\bunion\.py\b'
  ondra-writes: '(^|/)(logos?|brand-kit)/[^/]*\.svg$|(^|/)favicon\.(ico|svg)$'
---

# Logo design

A mark that looks drawn by a designer, not generated: one idea, built from
geometry you can show, legible at 16px, working in one colour, and judged
where it will live (a browser tab, an app icon, a header) before anyone picks
it. Every mark is SVG written by you — code is the pen; nothing is traced from
a raster. The numbers here are defaults; the brief and the user's notes come
first.

Not this skill: a supplied logo to put on a page (just use it), a page or app
design (`web-design`), a design to copy exactly (`mimikyu`), a promo film with
the mark (`motion-graphics`, after this one).

| file | what it holds |
|---|---|
| `references/craft.md` | grids and ratios, optical corrections, symbols, monograms, lettering and kerning, colour, the failures that make marks look generic |
| `references/kit.md` | `brand.json` fields, every file the kit writes, sizes, the guide |
| `references/fonts.md` | open-licence fonts (Latin and Hangul), outlining text, licences |
| `scripts/contact.mjs` | contact sheet of many sketches: big, 32px, real 16px zoomed, on dark |
| `scripts/measure.mjs` | measured checks per mark (below), JSON out |
| `scripts/sheet.mjs` | the comparison page the user picks from (HTML + PNG + one PNG per concept) |
| `scripts/render.mjs` | SVG → PNG at exact sizes, one colour, any background |
| `scripts/outline.py` | text in an OFL font → SVG outlines with the font's kerning, plus your own pairs and tracking |
| `scripts/union.py` | final outlines: strokes expanded, overlaps merged, one path per colour |
| `scripts/kit.mjs` | the brand kit from the approved files |

Below, `$SKILL` is this skill's folder. The `.mjs` scripts need only Node
22+ and a Chrome: they find the app's bundled one (`$ONDRA_BROWSER_EXECUTABLE_PATH`), or take `CHROME_PATH`, and
start a private headless instance — never the shared browser. `outline.py`
needs `fonttools`, `union.py` also `skia-pathops`
(`python3 -m pip install --user fonttools skia-pathops`).

Image generation: Ondra jobs have no image tool. If `tool_search` finds one,
use it only for mood or mockup photos, never for the mark: a raster can't be
edited, measured or delivered as a vector, and it may copy someone's logo.

## 0. Brief (`brief.md`)

Write it from the user's words and the product itself (README, site, app),
not from an interview:

- Name exactly as it is written, what the product does in one sentence, who
  uses it, where the mark will live (favicon, app icon, header, merch, print,
  embroidery, signage) and the smallest size it must survive.
- Tone in three words, and three words it must not be. Equity to keep: an
  existing mark, colour or name the users already know.
- Competitors and marks to avoid looking like; scripts the name needs
  (Latin, Hangul — a Korean name needs Hangul lettering too).
- Kind: symbol + wordmark, wordmark only, monogram, emblem. Colour: one colour
  first, unless the user asked for colour.

Ask only what changes the result, as an `ask` block with choices
(`{label, note}`, your recommendation first), never an open interview. Say
your reading of the brief in two lines and go on.

## 1. References (`refs/`)

- The category's marks: competitors and the products the user admires.
  `https://api.iconify.design/simple-icons/<name>.svg` gives many brands'
  silhouettes; save them in `refs/` — they feed the likeness check, they are
  never material to copy. Add the project's old mark and the common symbols
  your idea could slide into (power, refresh, loading ring, ♂/♀, pin,
  record, play, sparkle ✦).
- For marks you admire, write in `refs/notes.md` the concrete moves: which
  geometry, stroke-to-counter ratio, how the wordmark is spaced, what they do
  at 16px. Take principles, never shapes.
- Show the telling ones as `shot` blocks.

## 2. Sketch wide, in code

Ideas first, in words: 4–6 one-line ideas from the brief (what the product
does, its name, a letter, a gesture), each a different idea, not a different
colour. Then draw them as parametric code (a Python or JS file that writes
SVGs, so a variant is one number away) — 10–20 quick sketches:

```bash
node $SKILL/scripts/contact.mjs sketches/ sketches/contact.png --cols 5
```

Look at the sheet. Drop what reads as something else at 16px, what needs
explaining, what any icon set already has. Keep three.

## 3. Concepts (`concepts/<id>/`)

Each concept folder holds:

- `mark.svg` — `viewBox` set, filled shapes, one colour, attributes not
  classes. A `<g id="construction">` layer (direct child of the root,
  `stroke="currentColor"`, hidden in every render) with the circles, grid and
  ratios it is built on: the comparison page shows it, the kit drops it.
- `wordmark.svg` — outlines, never `<text>`: an OFL font through
  `outline.py`, then adjusted (`references/fonts.md`), or lettering drawn from
  the mark's own geometry.
- `mark-dark.svg` when the mark needs its own drawing on dark, and
  `concept.json`: `{"title", "idea": "one sentence", "tile": "#hex"}`.

```bash
python3 $SKILL/scripts/outline.py fonts/Inter.ttf "ondra" concepts/a/wordmark.svg --axes wght=620 --tracking -12 --kern "ra:-20"
```

How to build them: `references/craft.md` (grids, golden/√2 ratios, optical
overshoot, stroke contrast, kerning, the failures to avoid).

## 4. Measure, then look as a stranger

```bash
node $SKILL/scripts/sheet.mjs concepts/ review/ --name "Ondra" --refs refs/
```

`measure.json` and the page carry, per concept:

| check | what is measured |
|---|---|
| 16px / 32px | ink lost in features under 1px, blur, counters that close, parts that merge, gaps that close into blobs |
| one colour | regions told apart only by colour; white shapes posing as holes |
| on light / on dark | WCAG contrast of the colours on the mark's edge (3:1 for graphics); `*-dark` files are judged on dark |
| balance / artboard | ink centre vs its box; even margins in the viewBox |
| source | `<text>`, raster images, filters, gradients, strokes, art cut off by the viewBox |
| unlike refs / distinct | best silhouette overlap (with mirror and rotations) against `refs/` and against the other concepts |

Fix every fail. A warning needs a reason to stay. Then the checks numbers
can't do: give a fresh sub-agent only the concept cards (`review/cards/*.png`)
and one line about the product, and ask what each reads as at first glance and
at 16px, what it could be mistaken for, and one ranked note (P0/P1/P2,
`where · problem → change`). A mark that reads as another symbol is a P0
even when every check passes.

## 5. The user picks

Show `review/compare.html` as a `page` block (it is self-contained) and the
cards as `shot` blocks, then an `ask` block: one option per concept (`label`
= its title, `note` = the idea in one line), your recommendation first with
the reason. End the turn and wait. The pick and the user's notes go into
`brief.md` under "Decisions".

## 6. Refine the chosen one (`final/`)

- Write what stays (the user's "keep this") before changing anything, and
  change only what the notes and the checks ask for.
- Optical pass: overshoot of round shapes, stroke contrast, junctions, the
  channel or counter that closes first at small sizes (`references/craft.md`).
- A drawing for small sizes when 16px suffers (`mark-small.svg`: fewer parts,
  wider gaps) and for dark backgrounds (`mark-dark.svg`).
- Colour last, as its own step: the mark must already work in one colour.
  Contrast of every palette pair is measured in the kit.
- Sources (with the construction layer) live in `final-src/<id>/`; the
  final outlines go to `final/`, one call per file:
  `python3 $SKILL/scripts/union.py final-src/<id>/mark.svg final/mark.svg`.
- Measure what will ship, and see it at the sizes that matter:

```bash
node $SKILL/scripts/measure.mjs final/mark.svg final/mark-small.svg final/mark-dark.svg --refs refs/ --json final/measure.json --strict
node $SKILL/scripts/render.mjs final/mark-small.svg review/px --sizes 16,32,48 --pad 0.06
node $SKILL/scripts/sheet.mjs final-src/ review/final --name "Ondra" --refs refs/   # before/after with construction
```

## 7. The kit

Write `final/brand.json` (`references/kit.md`) and build:

```bash
node $SKILL/scripts/kit.mjs final/ brand-kit/
```

It writes SVG variants (colour, black, white, dark), horizontal and stacked
lockups, PNGs, `favicon.ico` (16/32/48) + `favicon.svg` + apple-touch +
PWA/maskable icons + `site.webmanifest` + a `<head>` snippet, `og.png`
1200×630, an avatar, `palette.json` and `tokens.css` with measured contrast,
and `guide.html` / `.pdf` / `.png`: logo on light and dark, clear space,
minimum sizes, colour with contrast, type, don'ts, the checks, the file list.

Open `guide.png`, `social/og.png` and the favicons and look at them: seams
where shapes meet, letters cut off, a lockup out of balance are fixed in the
source and the kit built again.

## 8. Report

`shot` of the guide and of the chosen mark in context, `link` to the kit
folder and the guide PDF, a `checklist` of the measured checks, and what is
unverified (no trademark search was done: say so — the likeness check only
compares against `refs/`). Suggest the next uses in one line each: the mark in
the app or site, an intro for a film (`motion-graphics`), stickers or merch.

## Choices that tend to fail

- Sparkles ✦, orbs, gradients, neural-network nodes, robot heads for anything
  AI; a lightbulb for ideas; a globe for global. Read as clip art.
- A ring with a gap (reads as loading/power/refresh), an o with a dot on a
  stick (♂), two shifted halves of a circle (reads as S).
- Thin lines, small gaps and detail that close up at 16px; marks that only
  work in colour; white shapes as fake holes.
- `<text>` or a system font in the delivered files; outlining fonts whose
  licence forbids it (SF Pro, Apple SD Gothic Neo, most commercial fonts).
- A wall of twenty options. Three different ideas beat twenty variations.
- Judging on a white square at 512px only. A mark is judged in the tab, on
  the icon, in the header, on dark.
