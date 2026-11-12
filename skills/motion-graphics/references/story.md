# Story, spec and storyboard

## Storylines: three films, then one

Sketch 5+ ideas, each a **device** (result first; before/after on the same
page; one object travelling across apps; the old way failing, then the
product) paired with a **form** (one continuous take; object-to-object
chain; endless zoom; kinetic type with UI wedged between words; a designer's
artboard). Keep three that are genuinely different films. For each write:

- world (ground, light, scale) and device + form
- the exact first 2 s (frame 0 is the thumbnail and must carry the idea;
  never a logo alone, never "Introducing", never typing into an empty box)
- the beat chain in one line
- look and sound in a line each

Save as `STORYLINES.md`, show the three, let the user pick. Pick for story,
not for the most striking frame.

## Beat shares

For a ~30–40 s launch film (shares of the total):

| beat | share | what happens |
|---|---|---|
| Hook | ~8% | the idea in one image |
| Tension | ~12% | the old way failing, on screen (e.g. the generic AI page) |
| Reveal | ~8% | the product appears, 20–30% into the film; music opens here |
| Proof | ~40% | 3–6 verbs shown in real UI (ask, pick, watch it build, compare); one framing held 4–10 s while the UI acts |
| Payoff | ~20% | the result, 60–80% in; before/after on the same page |
| Claim | ~8% | one line naming the feature and a concrete benefit |
| End card | ~8% | mark lands, CTA, held 2–3 s, music resolves |

Alternative arc (feature-heavy): brand open 8–12% → one hero action arc ≥ 3 s
→ feature climb 55–65% alternating high and low energy with 2–4 breathing
title cards → finale at peak energy. Put the densest shot 2nd–3rd from last.

Every core feature gets a shot; every technique is the hero only once. Ask
of each shot "what new information does this give?" and cut repeats.

## SPEC.md

```
GOAL      one sentence the film must leave
OUTPUT    1920×1080 (+ 1080×1920), 30 fps, mp4, ko + en
TIME      38 s · 120 BPM · 15 frames per beat · bars at 0, 2, 4 … s
LOOK      ground #0b0b0c / #f3f2f0, accent #ff6a2a (one word per shot, the payoff, the end card),
          type Pretendard 700 hero 128 px, lines 56 px min, 12-col grid, 96 px margins
OBJECTS   prompt bar, generated page, mark (selection square with 4 handles), cursor (134 px)
MOTION    pops spring ζ 0.75 · moves cubic in-out 0.6–0.9 s · arrivals expo-out ≥ 0.4 s ·
          camera sine in-out ≥ 0.75 s · exits 50–75% of entry · stagger words 60–120 ms
SHOTS     see storyboard
BANNED    (below, plus what each render reveals)
QA        frames.py clean · every cut strip reviewed · loudness within 10 LU · review P0 = 0
```

Every adjective becomes a number: "clean" = 12 columns, 96 px margins, one
accent word per shot; "calm" = camera moves ≥ 0.75 s, no impacts.

## Storyboard

One row per shot; status goes outline → posed → built → animated.

```
## 03 · ask  (5.30–9.30 s, f 159–279)        status: posed
hero move   prompt bar rises 80 px and settles; camera follows the caret at 1.3×
reads       5.6–6.4 "OMD에게 요청하기" (placeholder) · 6.5–9.0 the typed request
sound       bed: pad, filter half open · hits: key ticks on typing times, enter at 9.1 · silence 9.1–9.3
seam out    cut-the-curve upward into 04; carrier: the page thumbnail
notes
```

`reads` windows never overlap: one thing to read at a time. A shot without
a `reads` line is decoration; ask whether it should exist.

## Banned defaults

Each is a tell of generated video. Use one only when the brand or the user
asks for it, and write why in the spec.

- dark void with small floating UI
- glow, bloom, particles, lens flares as decoration
- purple/blue or mesh gradients, glassmorphism cards
- cream paper + serif + mono labels as a default
- everything centred; everything fading and sliding up
- corner labels, HUD readouts, fake metrics
- three cards in a row; logo docked in a corner the whole film
- copy words: "Introducing", "unlock", "seamless", "supercharge",
  "game-changer", "revolutionize", "effortless", "in seconds" (unless measured)
- subtitle chips at the bottom; idle floating/breathing loops on UI or titles

After each render, add any new default you spot to the film's `BANNED` line.
Rewrite the copy once the picture is locked.
