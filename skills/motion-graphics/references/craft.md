# Craft defaults

Starting points that usually work, from rejected versions, measured
reference films and public motion skills (sources at the end). Change a
number when the film calls for it. Render defects (flashes, double images,
drift) are correctness, not taste. 1920×1080 at 30 fps unless noted; f = frames.

## Text

Text is only ever one of three things:

1. **Full-frame type**: kinetic type that is the shot (Apple "Make a beat.",
   I/O "Level up" at ~30% of frame height).
2. **Part of the shot's layout**: a headline placed on the grid, not
   centered at the bottom.
3. **A label on what it points at**: selection box name, dimension, stamp,
   frame name.

Not a caption chip at the bottom of the frame (rejected: "자막처럼 나오는 거 별로").

- **Sizes.** Text to be read: around 56 px rendered or more (font-size ×
  every ancestor scale × cos of any Y rotation), labels around 32 px, so it
  reads on a phone. Hero words (12–30% of frame height) land harder once or
  twice a film. Text is either "to be read" or deliberate texture.
- **Read time.** A hold of about max(1.5 s, 0.5 s + 0.3 s × words) is
  usually enough; give the last line a bit longer; a 1–2-word chapter word
  can flash briefly. Short lines (around six words), one line to read at a time.
- **Accent.** Usually one accent word per line, the rest white or ink.
- **Entrances** (vary them within a film, keep one per element type):
  word rises through its own mask (translateY 105% → 0, words 55–120 ms
  apart); per word blur 6 → 0 px + opacity in 0.13 s, 67 ms apart; per word
  grey → ink; per letter for a name, 0.1 s apart; slot-machine roll ~0.1 s
  per word. Exit with a blur-and-fade over 0.13–0.25 s. A landed title
  usually holds still.
- **Waterfall** (a list cascading in): heavier words rise farther and slower
  than light ones; opacity switches in one frame; gaps shrink along the cascade.
- **Anchor word + swapping word** lists many things in seconds ("SIMULATE
  ___", "plans / builds / tests", "Export directly to ___"), swapping every
  2nd–4th beat.
- **Words become UI**: Canvas underlines "Canvas", a card grows out of the
  word and shrinks into the real chip. Words can open around an image
  ("Brands [image] don't wait.").
- **Copy**: names the feature and a concrete benefit; the brief never leaks
  onto the screen (concept names, "AI가 만든 화면 예시").

## Composition

- The hero (prompt bar, generated page, window) usually fills 40% or more
  of the frame's width or height: prompt bar at ~1.3× camera, generated page
  ~0.9 of the frame. Small UI in a void reads as a screen recording (rejected).
- Isolate the action: rebuild only the piece the beat uses, at 1.6–2× its
  real size, then return it to its place in the workspace.
- One composition per scene; don't jump the hero up and down between shots.
  When something docks (a prompt bar under a page), shrink the old hero.
- Crops: one control at a time at 2–3× (Claude Design, GitHub); the full
  window only briefly, then back in.
- The stage background is the current scene's color, including what a
  camera move or scale-down reveals. Any seam whose summed opacity dips
  below 1 flashes the stage.

## Motion and timing

- **One hero move per shot** keeps the eye on one thing. Secondary moves
  travel about 50–70% as far and start 100–200 ms later. Something new every
  few seconds.
- **Overlap.** The next element starts when the previous is 30–50% done.
  Stagger: letters 1 f, words 60–120 ms, list items 40–80 ms; much past
  ~0.5 s of stagger or ~0.8 s per entrance starts to drag.
- **Exits are shorter** than entrances: 50–75% of the entry duration.
- **Stillness before the payoff**: 0.3–0.75 s between the action (click,
  send) and its result. The payoff itself plays at normal speed.
- **Batch entrances accelerate** (dealt cards), then 0.5 s of stillness.
- **Speed contrast**: montage cuts 0.13–0.8 s; a demo holds one framing
  4–10 s while the UI acts.
- **Zoom** in log space (interpolate `log(scale)`); zooming in and straight
  back out reads as indecision.

### Easing

| motion | curve | notes |
|---|---|---|
| pops, things arriving small | spring, damping ratio 0.7–0.85 (or `back` 1.2–1.6) | position and size may overshoot; opacity and color never |
| arrivals ≥ 0.4 s | expo/quart out, bezier (.16,1,.3,1) or (.22,1,.36,1) | long tail, quick start |
| moves of objects | cubic in-out, bezier (.65,0,.35,1) | |
| camera | sine in-out, ≥ 0.75 s | peak speed ~1.6× average |
| exits | bezier (.7,0,.84,0) | shorter than the entry |
| anticipation | (.5,−.32,.25,1) | pulls back ~5% first |

Spring presets (stiffness/damping): 320/30 snappy UI, 170/26 containers and
camera, 120/24 heavy type and logos. Elastic and bounce eases tend to read as
cheap in a product film; use them on purpose or not at all.

**Avoid quint/expo *in-out* on short moves** (a render defect): peak speed ~5×
average puts the move in 2–3 frames and motion blur turns it into a double
image (measured in this pipeline). Out-only curves on arrivals are fine. Make easing
functions return exactly 0 and 1 at the ends.

### Beat

- Frames per beat = fps × 60 / BPM. Compute beat k as `round(k × fpb)` from
  its index; never add rounded beats (2 f drift in 32 beats at 128 BPM).
- A move that lands on a hit starts 40–190 ms early; a reaction starts
  0–45 ms late; the hit itself is set on its frame, not eased.
- Beat sync sets timing, not size. Whole-frame impacts (pump, shake, flash)
  lose force when repeated: a few per film, well apart, on the strongest hits.
  Per-beat zoom pumping wears the viewer out.

## One motion language per element

Each recurring element moves one way the whole film: the mark always
"draws as a rectangle" (handles pull in / push out); the cursor always
glides on eased arcs; cards always rise the same way. A second style for
the same thing reads as inconsistency (rejected: "네모 커지는 모션 이상").

## Transitions and seams

- A handful of transition kinds (3–5 is typical), each caused by something
  on screen. Mostly motivated seams rather than hard cuts; worlds
  crossfading into each other look muddy.
- **Vector law**: across a cut keep the same axis, direction and speed.
  One dominant direction per film; up = conclusion, zoom in = going deeper,
  zoom out = arrival. A receding exit answered by a grow-from-small entrance
  is the most common violation.
- **Carriers**: hand a concrete object across the cut at matched position
  and velocity (cursor, the page thumbnail, the mark). Text inside a
  morphing shape gets its own mask; a scaled blurred copy of text looks soft.

Starting numbers per seam:

| seam | numbers |
|---|---|
| cut-the-curve (default) | travel ~12% of frame (±230 px); exit power4-in, entry power4-out, same distance and duration; exit fade done by 25–30% of its travel, entry starts at 0.35 opacity; exit 0.2–0.4 s, entry ≥ exit; the cut lands mid-motion on both sides |
| zoom through | exit scale 1 → 1.2, blur 0 → 10 px, opacity → 0.15 over 0.2 s; cut; entry 0.75 → 1 expo-out 0.5 s (inverse: 1 → 0.8, then 1.25 → 1); peak blur 10 px on text, 18–20 px full frame |
| into a button | camera tracks to it 0.6 s, then it scales ~8% → ~250% of frame in 0.35 s, strong ease-in |
| object becomes the world | a card grows past the frame in 0.65 s in-out while its surroundings blur ~15 px |
| circle flood | from the source object; radius must clear the farthest corner (×1.05) in 0.3–0.35 s |
| color flood | 0.4 s |
| dip cut | outgoing frame darkens ~40% for 3 f before the cut |
| rack focus | cut at peak blur 8–12 px with ~1.06 scale; sparingly; not on text being read (depth of field on text was rejected) |
| hidden cut | a foreground occluder sweeps 14 f, cut on the frame it covers the whole frame; or a light-leak burn cut at its peak. One technique per seam |

Whips are rare in a calm film; when used, drive them from one velocity
curve (70% of the distance in 30% of the time, ~48 f ease-out tail) and use
directional blur, not sub-frame blur: accumulated sub-frames on bright UI
show stepped ghosts.

## Camera

- Loop: window on its ground → one pane → push-in on one control. Moves
  arrive where the cursor needs to be, then hold while the UI acts.
- Slow push-ins toward what is being read; pull-backs to reveal. Shake
  fights readable UI; a move without a destination (idle breathing, a late
  creeping push) reads as filler.
- 3D tilt (perspective ~1800–2400 px, 8–20°) while something enters or as a
  hero angle; face the camera before the viewer must read.
- Station tour: fly ~20 f, dwell around 24 f (under ~15 f reads as a scan).
- The camera may follow the caret while typing (Gemini reel) at a fixed
  scale. Close-up moves around 0.75 s or longer; at 0.45 s they smeared.

## Cursor

- One cursor leads the film: arrow → pointing hand on buttons → grabbing
  hand on drag. Size ~7% of frame width (~134 px) over a full-frame UI,
  4.6–5.5% inside a window mock. Use the product's own cursor if it has one.
- Enters from off-screen in one decelerating glide (0.4–0.9 s, power3-out)
  rather than fading in. The tip lands on the target's centre; press scales about
  the tip.
- Click: 0.84× over 0.1 s, back over 0.22 s; the target reacts on the same
  frame (0.94×) and the click starts the next beat on that frame. Keep any
  click ripple subtle and small.
- It drifts aside during beats it doesn't own; exits off the nearest edge.
  Across a cut it heads toward the next scene's first click and the next
  scene continues the same path.

## Typing

- Characters appear one per key time (not eased); per-character spans of
  fixed position so the line doesn't reflow.
- Human rhythm: 55–85 ms per key ±30% seeded jitter, +120–220 ms after a
  space or punctuation, the odd 300 ms pause.
- Caret solid while typing, blinks (~0.13 s half-period) only while waiting;
  after the last character it blinks twice and goes. Hold a moment (~1.7 s)
  after.
- Don't type over text already on screen (rejected); the placeholder
  vanishes on the first key. Retyping: delete back to the change, then type,
  like a person; an error-and-retype beat works once, not as a habit.
- Key sounds land on the key frames, heavier on space and enter.

## Color and look

- One big gradient mass of neighbouring hues (red · vermilion · amber).
  Opposite hues (cobalt + apricot) go muddy in the middle. Radial, not
  full-screen linear, on dark grounds: linear gradients band in H.264. Add
  seeded grain (stepped per frame).
- Accent at full saturation on the focal element; atmosphere tints 15–25%
  opacity (5% vanishes in compression). Ration it: one word, the payoff,
  the end card.
- Grounds: pure black and off-white (#f3f2f0) alternating is enough. Light
  from below the frame for dark scenes. A page's own color may bleed into
  the wall behind it and change with the page.
- The clichéd AI palette (purple/pink/teal) only for showing the "before"
  (rejected as the product's own look).
- One glint or light sweep per hero is plenty, clipped to its radius.
- Several worlds are fine if each is entered through an object on screen and
  there is one home stage to return to.

## Big-tech details worth using

- UI enters tilted and turns to face the camera to be read (Gemini Canvas);
  a thin highlight on panels' top edge.
- While generating: grey skeleton with a light sweep, then the real content
  fills in (Stitch). Status chip with changing verbs (Claude Design).
- A fixed element with the background changing behind it (Claude Design).
- Dot grid behind canvas scenes; rulers, 12-column grid, baselines, red
  dimension lines and a selection box for a designer's-artboard scene.
- Before/after: the same page, comparison slider held ~6 s (center → right →
  left → center), cursor on the handle; ease out over 1 s.
- End card: the mark lands where motion converges, in the last 5–10%,
  lockup 15–30% of frame width, performed not faded; CTA held 1.5–3 s; no
  floating-cards finale after it (rejected).

## Sound

- Visual hits want a sound, peaking ~1 f after the picture, 3–6 dB over
  the bed. Clicks are press + release; pick-up and drop have their own.
  Whooshes pan with the movement.
- Repeated sounds alternate 2–3 takes, step down in gain along a run
  (0.40 → 0.25 over six), and merge into one swoosh when too dense.
- Closing phrase: riser → impact → sparkle, or swell into the final chord.
- The old way sits near silence; the music opens when the product appears.
  Before the drop, 0.1–1.5 s of near silence (Stitch, Canvas).
- Bed energy below ~150 Hz is inaudible on phones; high-pass pads where
  they stack. A mix around −16 to −14 LUFS with sections within ~8–10 LU suits
  most platforms; keep peaks under −1 dBFS so the encode doesn't clip.
- Ending: half-time drums → drums out → bass held, filter closing, plucks
  thinning 8th → quarter → half → the final chord opening slowly. Cutting
  the music to zero and restarting a chord just before the logo was rejected
  (a song that ends with a hard cut).
- AAC adds priming silence (~1 f): check sync by comparing a sharp hit's
  peak in the rendered MP4 with its picture frame.
- Deliver with music and, if asked, an SFX-only master from the same cues.
- Swap only audio: `ffmpeg -i film.mp4 -i new.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest out.mp4`.

## Sources

Own work: the OMD promo film (19 rounds of user feedback) and frame-by-frame
analysis of the films in `films.md`. Methods adapted (ideas and numbers, no
code copied) from public skills:

- HeyGen HyperFrames (Apache-2.0) — https://github.com/heygen-com/hyperframes:
  story and spec templates, seams (cut-the-curve, zoom through, vector law),
  oversized cursor, read-time formula, banned defaults, review protocol.
- video-shotcraft (Apache-2.0) — https://github.com/Vincentwei1021/video-shotcraft:
  motion tokens, text size floor, typing caret, beat-impact limits, sound
  layering and sync offsets, sharp zoom via CSS `zoom`.
- claude-motion-design (MIT) — https://github.com/howseen-ai/claude-motion-design:
  pop and flash detection, cut-aware adaptive sub-frames, deterministic
  Chromium flags, facts file.
- Remotion skills — https://github.com/remotion-dev/skills: perceptual
  (log-space) zoom.
