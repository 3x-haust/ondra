# Fonts for wordmarks

A wordmark ships as outlines, so the font's licence must allow turning its
glyphs into a logo. Use fonts under the SIL Open Font License (OFL) or
Apache 2.0, keep the licence file in `final/fonts/`, and name the font in
`brand.json`. Never outline system or commercial fonts (SF Pro, New York,
Apple SD Gothic Neo, Helvetica, Avenir…): their licences forbid it.

## Where to get them

- Google Fonts' repository: `https://raw.githubusercontent.com/google/fonts/main/ofl/<family>/<File>[axes].ttf`
  plus `OFL.txt` in the same folder (`apache/` for Apache-licensed ones).
  Variable fonts take `--axes wght=…,wdth=…` in `outline.py`.
- npm packages through jsDelivr, e.g. Pretendard:
  `https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2`
  and `…/dist/LICENSE.txt`. `outline.py` reads TTF/OTF/WOFF2 (WOFF2 needs `brotli`).
- Download each into its own folder; record the URL and licence in `refs/notes.md`.

## Starting points by tone (all OFL)

| tone | Latin | Hangul |
|---|---|---|
| precise, geometric | Sora, Manrope, Outfit, Plus Jakarta Sans | Pretendard, SUIT |
| neutral grotesque | Inter, Instrument Sans, Geist, Schibsted Grotesk | Pretendard, IBM Plex Sans KR |
| warm, humanist | Figtree, Nunito Sans, Source Sans 3 | Gowun Dodum, Noto Sans KR |
| editorial serif | Fraunces, Newsreader, Instrument Serif | Noto Serif KR, Gowun Batang |
| technical, mono | JetBrains Mono, IBM Plex Mono, Geist Mono | D2Coding (OFL) |

Check the actual name in the actual font: one odd letter (a, g, r, y, 가/ㅎ)
can decide it.

## Outlining

```bash
python3 $SKILL/scripts/outline.py <font> "Name" out.svg --info            # metrics, licence, axes
python3 $SKILL/scripts/outline.py <font> "Name" out.svg --axes wght=640 --tracking -10 --kern "Na:-15,am:5"
```

- `--tracking` and `--kern` are in 1/1000 em; the font's own kerning (GPOS
  pair kerning and the old `kern` table) is applied first. Ligatures and
  contextual alternates are not: set those letters by hand.
- One `<path>` per glyph (`id="g<i>"`, `data-char`), so a letter can be
  edited, replaced by a drawn one, or nudged. Then `union.py` for the final file.
- Display sizes want tighter tracking (−1 to −3% for lowercase); all caps
  want looser (+3 to +8%).
