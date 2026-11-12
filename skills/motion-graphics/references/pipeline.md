# Pipeline

HTML scenes → deterministic `render(t)` → Playwright screenshots of sub-frames
→ ffmpeg averages them into motion-blurred frames → MP4 with a synthesized
WAV. No video editor, no timeline app; everything is code and can be
re-rendered from any time.

## Requirements

- Node with `playwright` and its Chromium. Use the project's copy if it has
  one; otherwise install into the worker's scratch folder and run the
  scripts from there: `cd "$APP_SCRATCH_DIR" && npm i playwright && npx playwright install chromium`.
- `ffmpeg`/`ffprobe` (Homebrew builds may lack `drawtext`; `sheet.sh` falls back).
- `python3` with `numpy` and `scipy` for sound; `fonttools` (`pyftsubset`)
  to subset and embed fonts.
- `yt-dlp` to download references.

Check what is missing first and say so instead of improvising a different
pipeline.

## Folder

```
<project>/docs/film/            (or where the user keeps it; often gitignored)
  README.md                     versions, feedback per round, what changed, how to rebuild
  refs/                         downloaded references and their contact sheets
  src/<name>.src.html           the film (copied from scripts/film.html)
  src/sound.py                  cues for this film, importing scripts/sfx.py
  src/build.py|mjs              optional: inline fonts, images, strings per language
  out/                          wav, mp4, stills, sheets
```

## The render contract

```js
window.__film = {
  D,                 // duration in seconds
  CUTS,              // hard cuts in seconds: sub-frames never blur across them; film-snap --cuts reviews them
  render(t),         // draw the frame at time t, from t alone
  exportMode(ar),    // "h" 1920×1080, "v" 1080×1920, "s" 1080×1080; hides the player, stage at 1:1
}
```

- Time: beats from their index (`beatT(k)` rounds once to a frame), seconds
  as floats everywhere, frames only at the end. Graphics that appear "set"
  switch on a frame; don't fade what should snap.
- Scenes: `SC = [{id, a, b}]` on bar lines, `R[id](localTime)` draws one.
  Only the current scene is displayed. Overlapping transitions render both
  scenes for the overlap.
- Per aspect ratio: `pick(h, v, s)` for positions and scales. Design 16:9
  first unless the film is a reel.
- Motion helpers in `film.html`: `prog`, `tw(t, a, b, from, to, ease)`,
  easings `E.sine/cubic/out/back/spring`, `rng(seed)`, `keyTimes(text,
  start, seed)` for human typing, `typed(text, times, t)`.
- The stage background follows the current scene's color so camera moves
  and scale-downs never reveal another color.
- Strings live in one table (`TXT[LANG]`); `?lang=en` or a build flag
  switches language. Sound cues read the same table so key ticks match the
  number of characters in each language.
- Fonts: subset to the glyphs the film uses and inline as woff2 data URIs
  (`pyftsubset Font.otf --text-file=glyphs.txt --flavor=woff2`), or load
  web fonts and wait for `document.fonts.ready` (the scripts do).
- Images: inline as data URIs or load from relative paths next to the HTML.
  Capture product UI at 2× (`deviceScaleFactor: 2`) after `fonts.ready`
  and a 600 ms settle; cut out the pieces a beat animates and keep their
  rects (`layout.json`) so fly-ins land in the real slots.
- Sharp push-ins: lay the UI out at 2–4× its display size and size it with
  CSS `zoom` (layout-level). `transform: scale` rasterizes at layout size
  first, so zoomed text goes soft. Blurry text is a resolution problem,
  never something to hide with depth of field.
- No `transition`, `animation`, `requestAnimationFrame`-driven state, or
  `Date.now()` inside scenes: the frame-by-frame render can't reproduce them. Video elements: set `currentTime` from `t`
  and await `seeked` (slow); prefer image sequences.

## Commands

```sh
S=<this skill>/scripts
node $S/film-snap.mjs src/film.src.html out/board h 1,3.5,8,12       # stills board (board.jpg); omit times for one per second
node $S/film-snap.mjs src/film.src.html out/cuts h --cuts             # strip across every cut: -0.2 s, last frame, cut, +0.2 s
node $S/export-film.mjs src/film.src.html out/draft.mp4 --sub 1      # full-length draft for rhythm
node $S/export-film.mjs src/film.src.html out/clip.mp4 --start 12 --dur 3 --sub 10    # check a fast part
python3 src/sound.py out/film.wav                                      # cues → wav
node $S/export-film.mjs src/film.src.html out/film-16x9.mp4 --sub 10 --workers 5 --wav out/film.wav
node $S/export-film.mjs src/film.src.html out/film-9x16.mp4 --ar v --sub 10 --wav out/film.wav
python3 $S/frames.py out/film-16x9.mp4 --known 5.3,16.5,25.8          # flashes, pops, unexpected cuts, dead stretches
python3 $S/frames.py refs/reference.mp4 --cuts                             # a reference's cuts and shot lengths
bash $S/sheet.sh out/film-16x9.mp4 out/sheet.jpg 2                     # whole film at a glance
bash $S/loudness.sh out/film.wav 0,5.3,16.5,25.8,39.2                  # per-section loudness
ffmpeg -i out/film-16x9.mp4 -i out/new.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest out/film-v2.mp4   # swap audio only
```

Render time: ~25 s of wall time per film second at `--sub 10 --workers 5`
(39 s film ≈ 18 min). Use `--sub 1` for drafts, 4 for review, 8–10 final.
Run long renders in the background and keep working on sound meanwhile.

## Checks and what they catch

| check | catches | how |
|---|---|---|
| stills per scene | small hero, unreadable text, wrong layout per ratio, edge showing | `film-snap.mjs`, look at each |
| short clip of fast moves | smear, double images from quint/expo, moves < 0.75 s | `--start/--dur`, step through frames |
| flashes | stage color or a stray element for one frame | `frames.py`: frame n differs from both neighbours, n−1 ≈ n+1 |
| pops | an element jumping, a scene starting a frame late | `frames.py`: change > 3× both neighbours |
| unexpected cuts | a scene switching where no cut was planned | `frames.py --known <CUTS>` |
| dead stretches | > 3 s with nothing changing | `frames.py --dead 3` |
| cut strips | seams: direction, carrier continuity, mid-motion on both sides | `film-snap.mjs --cuts` |
| phone read | text too small on a phone | stills downscaled to 480 px wide |
| contact sheet | rhythm, composition jumping between shots, repeated looks | `sheet.sh` at 2 fps |
| loudness | inaudible build-up, drop too loud, ending level | `loudness.sh`, neighbours within 8–10 LU |
| ffprobe | duration, resolution, audio present | `ffprobe -show_streams` |
| page errors | broken scene code | printed by the scripts |

Report each check you ran with its result; the sound by ear is always
unverified.

## Review protocol

1. Sheets: each scene just after it starts and at its middle; the cut
   strip; the beat frames at 480 px wide.
2. A fresh sub-agent gets only the sheets, `SPEC.md` and the storyboard's
   `reads` lines. It describes each beat in one sentence as a stranger
   would, then restates the film's message from the frames alone. An object
   that needs explaining, or a message it cannot restate, is a P0. Cover the
   words: the pictures alone should still tell it.
3. It checks the film against `craft.md` where it bears on what it sees,
   with frame numbers, and lists what it could not verify.
4. Notes are `t=4.2s · where · problem → exact change · what stays`, ranked
   P0/P1/P2, not a score: a score finds nothing to fix. A busy film usually
   gets better by removing motion, not adding it.
5. Compare your numbers with the reference's style guide: cuts per minute,
   longest hold, loudness, sounds per picture change.
6. Fix P0/P1, re-render only the changed range (`--start/--dur`), re-check.
