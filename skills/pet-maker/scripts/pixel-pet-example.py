"""Ondra's built-in pet, drawn as pixel art pose by pose: one GIF per act. The example to follow when
a pet is drawn (copy it, change the body, colours and features to the character's; keep the way
every act is posed: limbs as outlined capsules from shoulders and hips, the paws on top, lying down
on its side to sleep, legs stepping and arms swinging to walk).

usage: python3 pixel-pet-example.py [out dir]   (needs Pillow; the app's own copy: scripts/make-pet.py)

A round cream creature with little ears ("온디") with real arms and legs: every act is drawn pose by
pose (legs stepping and arms swinging to walk, lying down on its side to sleep, waving, typing,
flailing in the air), 40x40 cells, each cell 3x3 pixels, transparent background, feet on the bottom
row and facing right. Acts: the names src/pet/brain.ts uses.
"""
import math
import sys
from pathlib import Path
from PIL import Image, ImageDraw

W, H, S = 40, 40, 3
GROUND = H - 1
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "pet"

INK = (52, 40, 38, 255)
BODY = (255, 236, 205, 255)
SHADE = (240, 208, 168, 255)
CHEEK = (255, 160, 160, 255)
EAR = (246, 178, 150, 255)
WHITE = (255, 255, 255, 255)
BLUE = (110, 170, 255, 255)
TEAR = (150, 200, 255, 255)
GOLD = (255, 200, 60, 255)
RED = (235, 80, 70, 255)
PINK = (240, 90, 120, 255)
GREY = (120, 128, 140, 255)
DARK = (70, 76, 88, 255)
SCREEN = (180, 220, 255, 255)


def blank():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def dot(d, x, y, r, c):
    d.ellipse([round(x - r), round(y - r), round(x + r), round(y + r)], fill=c)


def limb(d, a, b, r, fill=BODY):
    """an outlined capsule from a to b (an arm or a leg); r: its half thickness in cells"""
    n = max(2, int(math.dist(a, b) * 2))
    pts = [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]
    for x, y in pts:
        dot(d, x, y, r + 1, INK)
    for x, y in pts:
        dot(d, x, y, r, fill)


def face(d, cx, cy, eyes="open", mouth="smile", cheek=True, look=1):
    """eyes and mouth around (cx, cy), shifted a cell the way it looks"""
    lx, rx = cx - 4 + look, cx + 3 + look
    ey = cy
    if eyes == "open":
        for x in (lx, rx):
            d.rectangle([x, ey, x + 1, ey + 2], fill=INK)
            d.point((x, ey), fill=WHITE)
    elif eyes == "closed":
        for x in (lx, rx):
            d.line([(x - 1, ey + 2), (x + 2, ey + 2)], fill=INK)
    elif eyes == "sleep":
        for x in (lx, rx):
            d.line([(x - 1, ey + 1), (x, ey + 2), (x + 1, ey + 2), (x + 2, ey + 1)], fill=INK)
    elif eyes == "happy":
        for x in (lx, rx):
            d.line([(x - 1, ey + 2), (x, ey), (x + 1, ey), (x + 2, ey + 2)], fill=INK)
    elif eyes == "wide":
        for x in (lx, rx):
            d.ellipse([x - 1, ey - 1, x + 2, ey + 2], fill=WHITE, outline=INK)
            d.point((x + (1 if look >= 0 else 0), ey + 1), fill=INK)
    elif eyes == "sad":
        for x, s in ((lx, 1), (rx, -1)):
            d.rectangle([x, ey + 1, x + 1, ey + 2], fill=INK)
            d.line([(x - 1, ey - 1 + (1 if s < 0 else 0)), (x + 2, ey - 1 + (1 if s > 0 else 0))], fill=INK)
    elif eyes == "squeeze":
        for x, s in ((lx, 1), (rx, -1)):
            d.line([(x - 1, ey), (x + 1, ey + 1), (x - 1, ey + 2)] if s > 0 else [(x + 2, ey), (x, ey + 1), (x + 2, ey + 2)], fill=INK)
    my = ey + 5
    mx = (lx + rx) // 2 + 1
    if mouth == "smile":
        d.line([(mx - 2, my), (mx - 1, my + 1), (mx, my + 1), (mx + 1, my)], fill=INK)
    elif mouth == "open":
        d.ellipse([mx - 2, my - 1, mx + 1, my + 2], fill=RED, outline=INK)
    elif mouth == "o":
        d.ellipse([mx - 1, my, mx + 1, my + 2], outline=INK)
    elif mouth == "yawn":
        d.ellipse([mx - 2, my - 1, mx + 1, my + 3], fill=RED, outline=INK)
    elif mouth == "flat":
        d.line([(mx - 1, my + 1), (mx + 1, my + 1)], fill=INK)
    elif mouth == "frown":
        d.line([(mx - 2, my + 1), (mx - 1, my), (mx, my), (mx + 1, my + 1)], fill=INK)
    if cheek:
        for x in (lx - 3, lx - 2, rx + 3, rx + 4):
            d.point((x, ey + 4), fill=CHEEK)


def body_blob(d, cx, cy, rx, ry, ear_tilt=0):
    """the round body with its ears on top (ear_tilt: the ears lean one way, -1/0/1)"""
    top = cy - ry
    for ex in (cx - 6, cx + 3):
        t = ear_tilt
        d.polygon([(ex, top + 3), (ex + 1 + t, top - 3), (ex + 4, top + 3)], fill=EAR, outline=INK)
    d.ellipse([round(cx - rx), round(cy - ry), round(cx + rx), round(cy + ry)], fill=BODY, outline=INK)
    d.ellipse([round(cx - rx + 5), round(cy + ry - 5), round(cx + rx - 5), round(cy + ry - 2)], fill=SHADE)


def pose(lift=0, squash=0, lean=0, arms=((-11, 4), (11, 4)), legs=((-4, 0), (4, 0)), eyes="open", mouth="smile",
         look=1, cheek=True, ear_tilt=0, under=None, over=None):
    """a standing pose. lift: up (+) off the ground; squash: shorter and wider; lean: the body shifts sideways.
    arms: each hand's place from its shoulder; legs: each foot's place from under its hip (y up is -)."""
    im = blank()
    d = ImageDraw.Draw(im)
    rx, ry = 9.5 + squash * 0.6, 9.5 - squash
    cx = 20 + lean
    feet_y = GROUND - 1 - lift
    cy = feet_y - 4 - ry
    if under:
        under(d, cx, cy, feet_y)
    # legs: hips under the body, feet as little ovals
    for (fx, fy), hx in zip(legs, (cx - 4, cx + 4)):
        foot = (hx + fx * 0.6, feet_y + fy)
        limb(d, (hx, cy + ry - 3), foot, 1.6)
        d.ellipse([round(foot[0] - 2), round(foot[1] - 1), round(foot[0] + 2), round(foot[1] + 1)], fill=BODY, outline=INK)
    # arms: from behind the body's sides, the paw on top (so a paw held in front shows)
    hands = []
    for (hx, hy), sx in zip(arms, (cx - rx + 3, cx + rx - 3)):
        sh = (sx, cy)
        hand = (cx + hx, cy + 1 + hy)
        limb(d, sh, hand, 0.9)
        hands.append(hand)
    body_blob(d, cx, cy, rx, ry, ear_tilt)
    for x, y in hands:
        dot(d, x, y, 2.2, INK)
        dot(d, x, y, 1.3, BODY)
    face(d, cx - 1, round(cy - ry * 0.25), eyes, mouth, cheek, look)
    if over:
        over(d, cx, cy, feet_y)
    return im


def lying(breath=0, eyes="sleep", mouth="flat", z=None):
    """asleep on its side: the body long on the ground, head to the right, an arm under its cheek, feet out the back"""
    im = blank()
    d = ImageDraw.Draw(im)
    cy = GROUND - 7 - breath * 0.5
    # feet sticking out behind
    for fy in (GROUND - 2, GROUND - 5):
        d.ellipse([3, fy - 1, 8, fy + 1], fill=BODY, outline=INK)
    # ears lying back (to the right, along the ground)
    d.polygon([(30, cy - 5), (36, cy - 9 - breath * 0.3), (33, cy - 2)], fill=EAR, outline=INK)
    d.ellipse([6, round(cy - 7 - breath * 0.5), 34, GROUND], fill=BODY, outline=INK)
    d.ellipse([11, GROUND - 4, 26, GROUND - 1], fill=SHADE)
    # its arm folded under its cheek
    limb(d, (26, cy + 2), (30, GROUND - 2), 1.2)
    face(d, 25, round(cy - 3), eyes, mouth, True, 1)
    if z:
        z(d)
    return im


def heart(d, x, y, c=PINK):
    d.point((x, y), fill=c); d.point((x + 2, y), fill=c)
    d.line([(x - 1, y + 1), (x + 3, y + 1)], fill=c)
    d.line([(x, y + 2), (x + 2, y + 2)], fill=c)
    d.point((x + 1, y + 3), fill=c)


def sparkle(d, x, y, c=GOLD):
    d.point((x, y), fill=c)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        d.point((x + dx, y + dy), fill=c)


def zz(d, x, y, size):
    d.line([(x, y), (x + size, y), (x, y + size), (x + size, y + size)], fill=BLUE)


def bang(d, x, y):
    d.rectangle([x, y, x + 1, y + 5], fill=RED)
    d.rectangle([x, y + 7, x + 1, y + 8], fill=RED)


def laptop(d, cx, feet_y, glow=0):
    """a laptop on the ground in front of it (to its right), its lid up, the screen lit toward it"""
    x0 = cx + 5
    d.rectangle([x0, feet_y - 1, x0 + 12, feet_y + 1], fill=GREY, outline=DARK)
    d.polygon([(x0 + 10, feet_y - 1), (x0 + 13, feet_y - 12), (x0 + 15, feet_y - 12), (x0 + 12, feet_y - 1)], fill=DARK)
    d.line([(x0 + 11, feet_y - 3), (x0 + 13, feet_y - 10)], fill=SCREEN if glow else (150, 200, 240, 255))


FRAMES = {}

# idle: breathing in and out, a blink, the arms moving with the breath
FRAMES["idle"] = (
    [pose(), pose(squash=0.5, arms=((-11, 5), (11, 5))), pose(), pose(eyes="closed"), pose()],
    [420, 420, 380, 140, 300],
)

# walk: eight steps a cycle, each leg lifting and swinging, the arms swinging the other way, the body bobbing
walk = []
for i in range(8):
    a = i / 8 * 2 * math.pi
    s = math.sin(a)
    lf = (s * 5, -max(0, math.cos(a)) * 2.5)
    rf = (-s * 5, -max(0, -math.cos(a)) * 2.5)
    walk.append(pose(lift=abs(math.cos(a)) * 1.2, lean=1, legs=(lf, rf), arms=((-10.5 - s * 1.5, 4 - abs(s)), (10.5 + s * 1.5, 4 - abs(s))), look=2))
FRAMES["walk"] = (walk, [100] * 8)

# sit: down on its bottom, legs out in front, paws on its knees; now and then it swings its feet
sit = []
for i, sw in enumerate((0, 0, 1, 0, -1, 0)):
    sit.append(pose(squash=2.5, lift=-3, legs=((3 + sw, -1), (7 - sw, -1 + abs(sw))), arms=((-6, 6), (8, 6)), eyes="closed" if i == 5 else "open", mouth="smile"))
FRAMES["sit"] = (sit, [900, 260, 260, 260, 260, 160])

# sleep: lying on its side, breathing slowly, Zz rising
sleep = []
for i in range(6):
    b = (0, 1, 2, 2, 1, 0)[i]
    def z(d, i=i):
        zz(d, 30, 14 - i, 2)
        if i >= 2:
            zz(d, 33, 8 - (i - 2), 3)
    sleep.append(lying(b, z=z))
FRAMES["sleep"] = (sleep, [450] * 6)

# fall: arms and legs flailing
fall = []
for i in range(4):
    s = 1 if i % 2 else -1
    fall.append(pose(lift=2, eyes="wide", mouth="o", arms=((-11, -8 + s * 3), (11, -8 - s * 3)), legs=((-3 + s * 2, -2), (3 - s * 2, -1 + s)), ear_tilt=s))
FRAMES["fall"] = (fall, [90] * 4)

# drag: held up, legs kicking and dangling, arms up
drag = []
for i in range(4):
    s = (-1, 0, 1, 0)[i]
    drag.append(pose(lift=3, eyes="wide", mouth="o", arms=((-9, -10), (9, -10)), legs=((-2 + s * 2, 1 + abs(s)), (2 - s * 2, 1 - abs(s) + 1)), lean=s))
FRAMES["drag"] = (drag, [140] * 4)

# happy: crouch, jump with both arms up, land; sparkles
happy = []
for lift, sq, arms in ((0, 1.5, ((-10, 5), (10, 5))), (4, -0.5, ((-10, -10), (10, -10))), (7, -0.5, ((-11, -11), (11, -11))), (4, 0, ((-10, -9), (10, -9))), (0, 1, ((-11, 2), (11, 2)))):
    def over(d, cx, cy, fy, lift=lift):
        if lift >= 4:
            sparkle(d, 4, cy - 6)
            sparkle(d, 35, cy - 3)
    happy.append(pose(lift=lift, squash=sq, eyes="happy", mouth="open", arms=arms, legs=((-2, 0), (2, 0)) if lift else ((-4, 0), (4, 0)), over=over))
FRAMES["happy"] = (happy, [120, 110, 150, 110, 160])

# alert: waving both arms over its head, "!"
alert = []
for i in range(4):
    s = 1 if i % 2 else -1
    def over(d, cx, cy, fy, i=i):
        if i % 2 == 0:
            bang(d, 35, cy - 14)
    alert.append(pose(lift=1 if i % 2 else 0, eyes="wide", mouth="open", arms=((-12 + s * 2, -11), (12 + s * 2, -11)), over=over))
FRAMES["alert"] = (alert, [200] * 4)

# sad: slumped, head down, arms hanging, a tear falling
sad = []
for i in range(4):
    def over(d, cx, cy, fy, i=i):
        d.ellipse([cx + 6, cy + i * 2, cx + 8, cy + 3 + i * 2], fill=TEAR, outline=BLUE)
    sad.append(pose(squash=1.5, eyes="sad", mouth="frown", arms=((-9, 8), (9, 8)), ear_tilt=-1 if i % 2 else 0, look=0, over=over))
FRAMES["sad"] = (sad, [500] * 4)

# work: sitting at a laptop, paws taking turns on the keys, glancing at the screen
work = []
for i in range(6):
    s = i % 2
    work.append(pose(squash=2.5, lift=-3, legs=((-1, -1), (2, -1)), arms=((6 + s * 2, 7 - s * 2), (12 - s * 2, 7 - (1 - s) * 2)), mouth="flat" if i in (2, 3) else "smile", look=2,
                     under=None, over=lambda d, cx, cy, fy, s=s: laptop(d, cx, fy + 1, s)))
FRAMES["work"] = (work, [130] * 6)

# poke: clicked: it jumps a little, squeezes its eyes shut and giggles, a heart pops up, it wiggles
poke = []
for i, (lift, lean) in enumerate(((2, 0), (1, -1), (0, 1), (0, -1), (0, 0))):
    def over(d, cx, cy, fy, i=i):
        heart(d, 33, cy - 13 - i)
    poke.append(pose(lift=lift, lean=lean, eyes="squeeze", mouth="open", arms=((-6, -2), (6, -2)), over=over))
FRAMES["poke"] = (poke, [110, 120, 120, 120, 200])

# play: looks one way, the other, then a big stretch and a yawn
play = []
for look, arms, eyes, mouth, lift in (
    (-1, ((-11, 2), (11, 2)), "open", "smile", 0),
    (3, ((-11, 2), (11, 2)), "open", "smile", 0),
    (1, ((-9, -10), (9, -10)), "closed", "yawn", 1),
    (1, ((-8, -13), (8, -13)), "closed", "yawn", 2),
    (1, ((-9, -10), (9, -10)), "closed", "o", 1),
    (1, ((-11, 2), (11, 2)), "open", "smile", 0),
):
    play.append(pose(look=look, arms=arms, eyes=eyes, mouth=mouth, lift=lift))
FRAMES["play"] = (play, [550, 550, 300, 500, 300, 300])

# greet: another pet came by: it waves one paw over its head
greet = []
for i in range(6):
    s = (-1, 1)[i % 2]
    greet.append(pose(eyes="happy", mouth="open", arms=((-11, 2), (11 + s * 2, -12)), lift=1 if i == 0 else 0, look=2))
FRAMES["greet"] = (greet, [160] * 6)

# on a wall (the app turns the picture so its feet touch the wall): reaching up paw over paw, legs pushing
climb = []
for i in range(4):
    s = 1 if i % 2 else -1
    climb.append(pose(arms=((-8, -11 - s * 3), (8, -11 + s * 3)), legs=((-3, -2 if s > 0 else 0), (3, 0 if s > 0 else -2)), look=0, mouth="flat"))
FRAMES["climb"] = (climb, [170] * 4)
FRAMES["cling"] = (
    [pose(arms=((-7, -12), (7, -12)), legs=((-3, 1), (3, 1)), look=0), pose(arms=((-7, -12), (7, -12)), legs=((-2, 1), (4, 1)), look=0, eyes="closed")],
    [1300, 160],
)


def save(name, frames, ms):
    big = [f.resize((W * S, H * S), Image.NEAREST) for f in frames]
    pal = []
    for f in big:
        p = f.convert("RGBA")
        alpha = p.getchannel("A")
        q = p.convert("RGB").quantize(colors=63, method=Image.Quantize.FASTOCTREE)
        q.info.pop("transparency", None)
        out = q.copy()
        px = out.load()
        a = alpha.load()
        palette = q.getpalette()[: 63 * 3] + [0, 0, 0]
        out.putpalette(palette + [0, 0, 0] * (256 - 64))
        for y in range(out.height):
            for x in range(out.width):
                if a[x, y] < 128:
                    px[x, y] = 63
        pal.append(out)
    pal[0].save(OUT / f"{name}.gif", save_all=True, append_images=pal[1:], duration=ms, loop=0, transparency=63, disposal=2, optimize=False)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (frames, ms) in FRAMES.items():
        save(name, frames, ms)
    print("wrote", ", ".join(f"{n}.gif" for n in FRAMES), "to", OUT)
