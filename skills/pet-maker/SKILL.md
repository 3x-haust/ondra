---
name: pet-maker
description: >
  Making an Ondra desktop pet from a character (펫, 펫 만들기, 데스크톱 펫, 캐릭터
  펫, "피카츄로 펫 만들어줘", /pet, desktop pet, shimeji): every act really
  animated (legs stepping, arms swinging, lying down to sleep, waving), from the
  character's own animations found on the web, or drawn pose by pose by GPT image
  (the image tool), or a Grok video, or as pixel art; as the character looks or as
  pixel art. Transparent looping GIFs per act (idle, walk, sit, sleep, fall, drag,
  happy, alert, sad, work, climb, cling, poke, play, greet), checked, then the pet
  is put on the screen.
metadata:
  ondra-commands: 'pet-maker/scripts/|\bpetkit\.py\b|\bsprite-gen\b|\.sprite-gen/|codex login status'
  ondra-writes: '(^|/)pets/[^/]+/.+\.(gif|png|webp|json|py|md)$'
---

# Pet maker

Ondra's pet lives on the user's screen: it walks the bottom of the screen and
the tops of windows, climbs their sides, falls when its window goes away, is
picked up and thrown, sits, lies down to sleep when nothing happens, waves at the
other pets it meets, and reacts when a job ends (happy), needs the user (alert)
or fails (sad). Your job is its pictures. The app does the moving across the
screen; **the pictures must move by themselves**: legs that step, arms that swing,
a body that lies down. One picture slid, tilted or stretched around is not an
animation, and the user will see it at once.

A pet is a folder in `$APP_PETS_DIR`:

```
$APP_PETS_DIR/<id>/          id: lowercase letters, digits, - (e.g. pikachu, black-cat)
  pet.json
  idle.gif walk.gif …        one looping transparent GIF per act
  source/                    what you downloaded, generated or drew from (kept, not shown)
```

```json
{ "name": "피카츄", "faces": "right", "source": "<page URL, 'gpt', 'grok' or 'drawn'>",
  "actions": { "idle": "idle.gif", "walk": "walk.gif", "sit": "sit.gif", "sleep": "sleep.gif",
               "fall": "fall.gif", "drag": "drag.gif", "happy": "happy.gif", "alert": "alert.gif",
               "sad": "sad.gif", "work": "work.gif", "climb": "climb.gif", "cling": "cling.gif",
               "poke": "poke.gif", "play": "play.gif", "greet": "greet.gif" } }
```

## The acts: what each one shows

Make all fifteen, each one moving. Frames: 4–8 (walk 6–8).

| act | when | the picture |
|---|---|---|
| idle | standing, nothing going on | standing, breathing (chest and shoulders rise), blinking |
| walk | walking the screen and windows | side view, legs taking turns stepping (a foot lifts and swings forward), arms swinging the other way, a small bob; loops seamlessly |
| sit | resting | sitting down on the ground, legs out in front, hands on knees or in its lap; now and then swings its feet |
| sleep | nothing happened for minutes | **lying down on its side** (or curled up), eyes closed, slow breathing, Zz rising. Never asleep standing |
| play | nothing to do, now and then | stretching both arms up with a yawn, looking around, a little dance |
| greet | another pet came by | waving one hand over its head, smiling |
| poke | the user clicked it | startled hop, eyes squeezed shut, giggling, blushing, a heart |
| happy | a job finished | crouch, jump with both arms up, land; cheering |
| alert | a job needs the user | waving both arms over its head, surprised face, "!" |
| sad | a job failed | slumped, head down, arms hanging, a tear |
| work | jobs are running | sitting at a laptop, typing (hands taking turns), looking at the screen |
| fall | in the air (dropped, thrown) | arms and legs flailing, mouth open |
| drag | held by the mouse | held up, legs kicking and dangling |
| climb | climbing a wall | upright, side view facing the wall (`faces`), reaching up hand over hand, a knee lifting, the other leg pushing |
| cling | holding on to a wall | upright, side view facing the wall, both hands up holding on, legs hanging and swaying |

Every GIF: transparent background, feet on the bottom edge (sleep: lying on it),
facing `faces`, the character at the same size in every act (about 96 px tall
standing; pixel art 64–128), looping, under 2 MB. The app draws every GIF at one
scale (idle's height is the pet's size), so a GIF may have room above for Zz or
sparkles, but the character itself must not change size. The app mirrors it to
walk the other way and to face the wall it climbs; it never turns a picture on its side, so draw climb
and cling upright, as if the wall were just in front of it.

## The style

The ask says which (if not: as the character looks):

- **as it looks**: the character's own look (smooth, full colour).
- **pixel art**: still find the character first (its shapes and colours make it
  recognizable), then make it pixel art. Don't mix styles between acts.

## How: the first way that works

Find a good picture of the character first (step 1). Then make the motion with the
first of these that works here, and say in your answer which one you used:

1. **Its own animations, found** (free, best when complete): sprite sheets, GIF sets
   or official animated stickers of the character that really move. Use them for the
   acts they cover; make the rest with the next way that works.
2. **GPT image**: the `image` tool (call it through use). It draws on the user's
   GPT login in Ondra, from your picture of the character, keeping it the same
   character. It says so when there is no GPT login: then the next way.
3. **Grok video**, only when `grok` is installed and signed in: sprite-gen (below).
4. **Draw it** as pixel art, pose by pose (always works): `scripts/pixel-pet-example.py`.

2 and 3 spend the user's GPT or Grok plan (one picture per act). Go ahead (the user
asked for a pet), but never use an API key billed per call (`OPENAI_API_KEY`,
`XAI_API_KEY`) unless the user said so: go to the next way instead.

### 1. Find it

Search the web, best first: sprite sheets or GIF sets made for the character
(`<name> sprite sheet`, `<name> pixel gif`, `<name> walking gif transparent`,
`<name> shimeji`); official animated stickers or emotes; single GIFs per act from
one source. Also find **one clean full-body standing picture** (front or side view,
whole body, plain background): the base for ways 2–4.

Download into `<id>/source/` with curl (`-L`, a normal browser User-Agent), then
**look at every file** before using it. Reject: scenes, text or watermarks over the
character, other characters in the frame, a character cut off at the edges, very low
resolution scaled up. One artist's set beats a patchwork of styles. Note where each
file came from in `pet.json` `source`. This is for the user's own desktop; do not put
the files anywhere public.

### 2. GPT image: one strip per act

First the base: `image` with your found picture as `refs`, asking for the character
full-body, standing, side view facing right, on a flat magenta (#FF00FF) background
(pixel style: "as clean pixel art, a dark outline, few flat colours"). Look at it;
redo until it is right: everything after copies it. Save it as `source/base.png`.

Then **one call per act**, refs `[source/base.png]`, out `source/<act>.png`:

> A horizontal sprite strip of N frames of this exact character (same face, hair,
> clothes, colours, proportions and size in every frame), side view facing right:
> <the act's picture column above>. Frame by frame, the motion changes clearly
> (legs, arms, body). Every frame the whole body, feet on one ground line, evenly
> spaced with wide empty gaps between frames, nothing overlapping or cut off. Flat
> solid magenta #FF00FF background, no shadow, no text, no ground.

(sleep: "lying down on its side" so the frames are wide; N: walk 6–8, others 4–6.)
Look at each strip: wrong character, frames touching, a pose that doesn't move: ask
again (say what was wrong). Then cut it into the act's GIF:

```bash
python3 $K strip "$D/source/walk.png" "$D/walk.gif" --count 8 --height 96 --ms 110
#   --pixelate 40 for the pixel style; a strip of a GIF-ready pixel character: --pixel
```

### 3. Grok video (sprite-gen)

Only when `grok` is signed in. sprite-gen (Apache-2.0, github.com/aldegad/sprite-gen):
`git clone` it into `$APP_PETS_DIR/.sprite-gen`, `git checkout 35a27e137bfd72440cc856b080913c66f69c772e`,
`python3 -m venv .venv && .venv/bin/pip install -e .`, read its `SKILL.md` and
`docs/video-pipeline.md`, then `video-set --base side=source/base.png --states idle,walk
--facing right` (other acts with `--motion "<the picture column>"`). It asks before
choices that are the user's (exit code 75): never answer those yourself. Turn each
loop's frames into the act's GIF with `petkit.py clean <frames folder> …`.

### 4. Draw it

`scripts/pixel-pet-example.py` is Ondra's own pet, drawn pose by pose: read it,
copy it to `<id>/source/draw.py`, and change the body, colours and features to the
character's (a person: a head with its hair, a body in its clothes, arms and legs
as limbs; an animal: its ears, tail, muzzle), keeping how every act is posed. Look
at the base picture while you draw: its few features that make it recognizable
(hair, colours, clothes, ears, a tail, a hat). `python3 source/draw.py "$D"` writes
the GIFs.

## Tools

`scripts/petkit.py` (Pillow; `python3 -m pip install --user pillow` if missing):

```bash
K=<baseDir>/scripts/petkit.py
D="$APP_PETS_DIR/<id>"
# a found GIF or a folder of frames: background off, cut to the character, 96 px high
python3 $K clean "$D/source/walk.gif" "$D/walk.gif" --height 96
#   --frames 0-7 keeps only those frames · --tol 40 for a noisier background
#   --pixel: it is pixel art already (kept sharp) · --pixelate 40: make it pixel art
# GPT's strip of an act (poses side by side on a flat background): cut into frames
python3 $K strip "$D/source/walk.png" "$D/walk.gif" --count 8 --height 96 --ms 110
# a sprite sheet: which cells make one act (row by row from 0)
python3 $K sheet "$D/source/sheet.png" "$D/walk.gif" --grid 8x4 --cells 8-15 --height 96 --pixel
# only for fall, drag and cling when nothing better is at hand: one pose moved around
python3 $K still "$D/source/pose.png" "$D" --height 96 --only fall,drag,cling
```

`still` moves one picture around; it is no animation. Never use it for the acts
that must move (walk, happy, alert, work, poke, play, greet, climb) or for sleep.

## Check, then put it on

```bash
python3 $K check "$D"     # sizes, frames, movement, lying asleep; writes $D/preview.png
```

`check` says PROBLEM when an act doesn't really move (one picture slid around),
when it sleeps standing, when a size jumps, or a background is left. Then open
`preview.png` and look, act by act: the same character at the same size, feet on
the bottom, no halo or box around it, **the walk's legs stepping**, sleep lying
down. Fix and check again until there is no PROBLEM line and it looks right. Then,
at the end of your answer:

```json
{"type":"pet","id":"<id>"}
```

That puts the new pet on the user's screen, next to the ones already out. In your
answer, say in a line or two where its pictures came from and which way made the
motion (found, GPT, Grok or drawn), and show `preview.png`.
