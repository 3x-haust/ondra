---
name: motion-graphics
description: >
  Making a motion graphic film: a product promo, launch film, teaser, reel or
  kinetic type video (모션그래픽, 홍보 영상, 프로모 영상, 런칭 영상, 소개 영상, 릴스,
  키네틱 타이포, 티저, promo video, launch film, product film). Strong product
  films as references, storylines and a numeric spec, a beat-timed storyboard,
  scenes built as deterministic HTML rendered frame by frame to MP4 with motion
  blur, synthesized sound, and measured checks for seams, pops, flicker and
  loudness. Delivered as a video file.
metadata:
  ondra-writes: '\.src\.html$|/promo-film/|/film/'
  ondra-commands: '\bexport-film\.mjs\b|\bfilm-snap\.mjs\b'
---

# Motion graphics

A short film that makes a product feel made by a studio, not by AI. The
product (its UI, its input → result moment) is the hero; 3D, glow and
particles only support it. This skill comes from making promo films over
many review rounds, frame-by-frame study of official launch films, and the
methods of public motion skills (sources at the end of
`references/craft.md`). The numbers are defaults; the brief and the
reviewer's notes on this film come first.

| file | what it holds |
|---|---|
| `references/craft.md` | defaults with numbers that usually work: text, composition, motion and timing, transitions, camera, cursor, color, sound |
| `references/story.md` | storylines, beat shares, `SPEC.md` and storyboard templates, generic defaults to watch for |
| `references/films.md` | kinds of product film and what each does, with timings |
| `references/pipeline.md` | render contract, folder layout, commands, the checks and the review protocol |
| `scripts/film.html` | working film skeleton: scenes, easing, typing, player, export hooks |
| `scripts/export-film.mjs` | parallel render with motion blur and cut-aware sub-frames → MP4 |
| `scripts/film-snap.mjs` | stills at chosen times or around every cut, for boards and review |
| `scripts/frames.py` | pops, one-frame flashes and dead stretches in a render |
| `scripts/sheet.sh` | contact sheet of a video (a reference or your render) |
| `scripts/loudness.sh` | loudness per section |
| `scripts/sfx.py` | numpy instruments, buses, reverb, sidechain |

## 0. Brief and facts

- Product, the one sentence the film must leave, audience, where it plays
  (reel 9:16, YouTube 16:9, feed 1:1), length, language(s).
- Real material only: real UI, copy from the site or README, real CLI
  syntax and output. Write `facts.md`: every on-screen number or claim
  with its source. No source, no number. Staged output is said to be staged.
- Brand: real mark, fonts (only the weights it ships), colors. The accent
  is the color that recurs across the most brand roles. Never invent a
  mascot or logo; if none exists, ask, or draw one plain mark and say so.
- If the user names a reference ("이 릴스처럼", "그대로 내용만 바꿔서"), it
  sets the structure. Don't blend in others until asked.
- Deliver a video file. No artifact or web page of the film unless asked.

## 1. References: watch frames, not thumbnails

`references/films.md` already breaks down common kinds of product film. For anything new:

- Download (`yt-dlp -f "bv*+ba" --merge-output-format mp4 <url>`) into its
  own folder; Instagram needs a signed-in browser (see `browser-use`).
- `scripts/sheet.sh <video> <out.jpg> 2` for the whole film, then `10` fps
  over the 2–4 s you want to copy; `scripts/frames.py <video> --cuts` lists
  its cuts. Step through consecutive frames around each cut and entrance:
  1-second samples miss 1–3-frame timing. Graphics that are fully there on
  frame N were set, not faded.
- Write `refs/style_guide.md`: palette hex, type sizes (% of frame height,
  from the ink box), shot lengths, cuts per minute, transitions, camera,
  how text enters and leaves, sound and silences; then a table
  `technique | how the reference does it | adopt / reject`. Mark what you
  measured apart from what you guessed. Take the grammar, never the content.
- Official company films teach more than influencer or AI-skill reels.
- Show the most relevant sheets as `shot` blocks.

## 2. Story, spec, storyboard (see `references/story.md`)

1. **A few storylines** (three is a good number), each a different film
   (device + form + first 2 s + one-line beat chain + look + sound). Ask the
   user to pick with an `ask` block unless the brief already fixes the story.
2. **`SPEC.md`**: turn adjectives into numbers where you can (tempo, frames
   per beat, type sizes, eases by role, durations) so "calm" means the same
   in every scene, plus the film's `BANNED` line.
3. **Storyboard** on the beat: per shot the frame range, the hero move,
   `reads` (what the viewer must understand, in order, one thing at a time)
   and `sound`. Scene changes on bar lines; one or two "오 쩐다" moments
   placed on purpose.
4. **Stills board**: pose each shot at its key moment in the real
   composition with real copy and fonts (`film-snap.mjs`) and show them.
   Stills are cheap to change; a yes before animating saves re-animating.
   A note re-poses only that shot.

## 3. Build: one deterministic HTML page

Copy `scripts/film.html` into the film folder (e.g. `docs/film/src/`).
Details in `references/pipeline.md`:

- `render(t)` draws the whole frame from `t` alone: no CSS transitions or
  animations, no `Date.now()`, no unseeded random. That makes motion blur,
  scrubbing and partial renders possible.
- Scenes `{id, a, b}`, a render function each, `pick(h, v, s)` per ratio,
  hard cuts listed in `CUTS`. Beat times computed from the beat index, not
  by adding rounded beats.
- All on-screen strings in one table per language.
- Fonts embedded or awaited with `document.fonts.ready`. UI that the camera
  pushes into is laid out at 2× and zoomed with CSS `zoom`, not
  `transform: scale`, so text stays sharp.
- `references/craft.md` has motion defaults that usually work.

## 4. Look before the full render

1. Stills per scene and a strip across every cut (`film-snap.mjs --cuts`).
   Check readable text, hero filling the frame, no stage edge showing.
   Downscale a few to 480 px wide: what must be read still reads.
2. Draft render `--sub 1` at full length for rhythm; short `--sub 10`
   renders of the fast parts for smear and double images.
3. Final render `--sub 10`: ~25 s of wall time per film second, 5 workers.
   Run it in the background and do sound meanwhile.

## 5. Sound

Cues in one table on the film's own timeline, each commented with its
picture action, built with `scripts/sfx.py` or the user's track (defaults in
`references/craft.md`). Pure sine pings read as a game; noise-based whooshes,
impacts and modelled clicks don't. Measure with `loudness.sh` (around −16 to
−14 LUFS, peaks under −1 dBFS so it doesn't clip). You cannot hear it: say
so and report the measurements.

## 6. Check, review, deliver

- `scripts/frames.py out.mp4 --known <CUTS>`: one-frame flashes, pops and
  unexpected cuts are render defects; fix them before delivering.
- `sheet.sh` of the render at 2 fps; `ffprobe` for duration, size, fps, audio.
- **Independent review**: a fresh sub-agent given only the sheets and the
  storyboard's `reads` sees the film as a stranger would. An object that
  needs explaining is a P0. Notes as `t=4.2s · where · problem → change ·
  what stays`, ranked P0/P1/P2, not a score (a score finds nothing to fix).
  Fix P0/P1, re-render only what changed (`references/pipeline.md`).
- Frame 0 is the thumbnail, so it works best when it already shows the idea.
- Report with a `link` (kind `video`) to the MP4, the sheet as a `shot`,
  the checks run with results, and what is unverified (the sound by ear).
- Keep `README.md` in the film folder: versions, each round's feedback and
  what changed, how to rebuild. The next round starts from it.

## Choices that tend to fail

- Subtitle-style text at the bottom (reads as captions, not design); small
  UI floating in a big dark void (reads as a screen recording); fake
  simplified UI under huge headlines everywhere (reads as AI-made).
- Mascots with eyes, blue orbs, purple/pink/teal "AI" gradients for the
  product's own look, glass cards; a wall of dozens of identical pages.
  They look generic and hide the real product.
- Blurred frames, depth of field on text, anything too fast to read; 3D
  tilt while the viewer must read; whip pans and sudden zooms in a calm
  film. The viewer loses the one thing they should read.
- An element moving a different way each time it appears; typing over text
  already on screen. Both read as mistakes.
- A song that ends with a hard cut; a floating-cards finale after the
  ending. The film should end once, on the mark.
