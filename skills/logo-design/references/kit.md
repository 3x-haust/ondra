# The brand kit

`node $SKILL/scripts/kit.mjs final/ brand-kit/` reads `final/` and writes
`brand-kit/`. Everything is rebuilt from the sources each time: change
`final/`, run it again.

## Inputs (`final/`)

| file | |
|---|---|
| `mark.svg` | required; final outlines (`union.py`), any `#construction` layer is dropped |
| `wordmark.svg` | outlines; without it there are no lockups |
| `mark-dark.svg` | drawn for dark backgrounds (else the mark in white) |
| `mark-small.svg` | the 16–48px drawing used for favicons (else the mark) |
| `fonts/…` | the font files named in `brand.json` and their licence files |
| `brand.json` | below |

```json
{
  "name": "Ondra",
  "tagline": "Don't manage AI. Delegate the work.",
  "story": "Two or three sentences: the idea and how mark and name share it.",
  "colors": [
    {"name": "Ink", "hex": "#15161a", "role": "primary · text"},
    {"name": "Ondra Blue", "hex": "#1f6fd8", "role": "accent"},
    {"name": "Paper", "hex": "#f6f5f1", "role": "background"}
  ],
  "ink": "#15161a", "paper": "#f6f5f1", "night": "#121316",
  "fonts": {
    "display": {"family": "Instrument Sans", "file": "fonts/InstrumentSans.ttf", "weight": 620, "licence": "OFL 1.1", "sample": "…"},
    "text": {"family": "Pretendard Variable", "file": "fonts/PretendardVariable.woff2", "weight": 450, "licence": "OFL 1.1", "sample": "…"}
  },
  "lockup": {"markScale": 1.0, "gap": 0.34, "stackScale": 1.7, "stackGap": 0.4, "wordShift": 0},
  "clearSpace": 0.33,
  "minSize": {"mark": 16, "lockup": 88},
  "favicon": {"style": "tile", "bg": "#15161a", "fg": "#ffffff", "radius": 0.24, "inset": 0.2, "art": "dark"},
  "og": {"bg": "#15161a", "fg": "#ffffff", "title": "…", "subtitle": "…"}
}
```

- `lockup`: units of the wordmark's ink height. `markScale` 1.0 makes the
  mark as tall as the wordmark (ascender to baseline); `gap` is the space
  between them; `wordShift` nudges the wordmark down (+) or up (−).
- `favicon.style`: `tile` (mark reversed out of a rounded square, works on
  light and dark tabs) or `bare` (the mark itself, with a dark-mode style in
  `favicon.svg`). `art: "dark"` lets the big icons (apple-touch, 192/512,
  maskable, avatar) keep `mark-dark.svg`'s colours on the tile; 16–48px
  stay one colour.
- `clearSpace`: share of the mark height kept clear on every side.

## Outputs (`brand-kit/`)

| folder | files |
|---|---|
| `svg/` | `mark`, `mark-cropped`, `mark-black`, `mark-white`, `mark-dark`, `wordmark`(-black/-white), `lockup-horizontal`(-white), `lockup-stacked`(-white) |
| `png/` | mark 64–1024, mark white/black 512, wordmark 600/1200, each lockup 600/1200 wide |
| `favicon/` | `favicon.ico` (16, 32, 48), `favicon.svg`, `favicon-16/32.png`, `apple-touch-icon.png` (180, opaque), `icon-192/512.png`, `icon-maskable-512.png` (mark inside the 80% safe zone), `site.webmanifest`, `head.html` |
| `social/` | `og.png` 1200×630 (lockup, title, subtitle in the brand fonts), `avatar-400.png` |
| `palette/` | `palette.json` (hex, rgb, role, contrast to white, black and every other colour), `tokens.css` |
| | `guide.html` / `guide.pdf` (A4 landscape) / `guide.png`, `README.txt` |

The guide: the logo on light and dark, mark / stacked / wordmark, the story,
clear space and minimum sizes with the real 16/32px favicon pixels, colour
swatches with a contrast matrix (AA / AAA / large), type samples with
licences, six don'ts (stretched, rotated, off-palette, effects, busy
background, outlined), the measured checks of what ships, the file list.

## After building

Look at `guide.png`, `social/og.png`, `favicon/favicon-16.png` (zoomed) and
one lockup on dark. Fix in `final/` and rebuild — never hand-edit the kit.
To install on a site: copy `favicon/*` to the web root and paste `head.html`.
