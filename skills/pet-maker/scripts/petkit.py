"""petkit: make an Ondra pet's GIFs from pictures found on the web, a sprite sheet, or one image.

usage (python3, needs Pillow: python3 -m pip install --user pillow):
  petkit.py clean  <in.gif|png|webp> <out.gif> [--height 96] [--tol 28] [--pixel] [--pixelate 48] [--ms 120] [--frames 0-7]
        background off (transparent kept; else the border colour flood-filled away), every frame cut
        to one shared box, scaled to --height, written as a looping transparent GIF.
        --pixel: it already is pixel art (kept sharp). --pixelate N: make it pixel art, N pixels high
        (32-64), --colors shared colours (24), outlined, then scaled up sharp
  petkit.py sheet  <sheet.png> <out.gif> --grid 8x4 --cells 0-7 [--height 96] [--tol 28] [--pixel] [--ms 120]
        cells of a sprite sheet (row by row, from 0) as one animation, then cleaned like `clean`
  petkit.py still  <image> <outdir> [--height 96] [--tol 28] [--pixel] [--pixelate 40] [--only walk,sleep]
        one picture (a pose) made into every act by moving it: idle breathes, walk bobs and leans,
        sit and sleep squash (sleep with Zz), fall and drag swing, happy hops with sparkles,
        alert shakes with a "!", sad droops with a drop, work bobs at a little laptop, poke wiggles
        with a heart, play looks around and stretches, climb and cling for walls
  petkit.py check  <petdir>
        pet.json and its GIFs: idle present, files there, transparent corners, frames, sizes;
        writes <petdir>/preview.png (every act's frames side by side) to look at. Exit 1 on problems.

Acts: idle walk sit sleep fall drag happy alert sad work climb cling poke play greet. Pictures face right unless pet.json says
"faces": "left". The feet are on the bottom edge of every frame.
"""
import argparse, json, math, sys
from collections import Counter
from pathlib import Path
from PIL import Image, ImageDraw, ImageSequence

ACTS = ["idle", "walk", "sit", "sleep", "fall", "drag", "happy", "alert", "sad", "work", "climb", "cling", "poke", "play", "greet"]
# acts that must really move (arms, legs, face), not one picture slid, tilted or stretched around
MOVING = ["walk", "happy", "alert", "work", "poke", "play", "greet", "climb"]


# ───────────── reading

def frames_of(path, pick=None):
    """an animation's frames and their times: a GIF or animated WebP, or a folder of frame pictures
    (in name order, 100 ms each; sprite-gen's frame folders, a video cut into PNGs)"""
    path = Path(path)
    out, ms = [], []
    if path.is_dir():
        for f in sorted(x for x in path.iterdir() if x.suffix.lower() in (".png", ".webp", ".gif")):
            out.append(Image.open(f).convert("RGBA"))
            ms.append(100)
    else:
        im = Image.open(path)
        for f in ImageSequence.Iterator(im):
            out.append(f.convert("RGBA").copy())
            ms.append(f.info.get("duration", im.info.get("duration", 100)) or 100)
    if pick:
        a, b = pick
        out, ms = out[a:b + 1], ms[a:b + 1]
    return out, ms


def parse_range(s):
    if not s:
        return None
    a, _, b = s.partition("-")
    return int(a), int(b or a)


# ───────────── background off

def has_alpha(im):
    a = im.getchannel("A")
    w, h = im.size
    corners = [a.getpixel((0, 0)), a.getpixel((w - 1, 0)), a.getpixel((0, h - 1)), a.getpixel((w - 1, h - 1))]
    return sum(1 for c in corners if c < 40) >= 3


def dist(a, b):
    return math.sqrt(sum((int(x) - int(y)) ** 2 for x, y in zip(a[:3], b[:3])))


def border_color(im):
    w, h = im.size
    px = im.load()
    edge = [px[x, 0] for x in range(w)] + [px[x, h - 1] for x in range(w)] + [px[0, y] for y in range(h)] + [px[w - 1, y] for y in range(h)]
    edge = [tuple(c[:3]) for c in edge if c[3] > 200]
    if not edge:
        return None
    # the most common colour, rounded so noise in a JPEG-ish edge counts as one
    q = Counter((r // 8, g // 8, b // 8) for r, g, b in edge).most_common(1)[0][0]
    return tuple(v * 8 + 4 for v in q)


def unbackground(im, tol):
    """Flood-fill the border colour to transparent (only what touches the border, so the character's own
    white eyes stay). An image already transparent at its corners is kept as it is."""
    if has_alpha(im):
        return im
    bg = border_color(im)
    if bg is None:
        return im
    im = im.copy()
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    stack = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    while stack:
        x, y = stack.pop()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        c = px[x, y]
        if c[3] < 10 or dist(c, bg) <= tol:
            px[x, y] = (0, 0, 0, 0)
            if x > 0: stack.append((x - 1, y))
            if x < w - 1: stack.append((x + 1, y))
            if y > 0: stack.append((x, y - 1))
            if y < h - 1: stack.append((x, y + 1))
    # a soft edge left over: pixels next to the cleared area and close to the background fade out
    for y in range(h):
        for x in range(w):
            c = px[x, y]
            if c[3] and dist(c, bg) <= tol * 1.6:
                n = sum(1 for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if 0 <= x + dx < w and 0 <= y + dy < h and px[x + dx, y + dy][3] == 0)
                if n >= 2:
                    px[x, y] = (c[0], c[1], c[2], 0)
    return im


def split_strip(im, count):
    """a picture of several poses side by side (GPT's strip of an act), background already off: each pose
    cut out (split where a column is empty), the `count` biggest kept in order, set on one canvas with
    their feet on its bottom and centred, so the frames line up"""
    a = im.getchannel("A").point(lambda v: 255 if v > 40 else 0)
    w, h = im.size
    cols = [any(a.getpixel((x, y)) for y in range(0, h, 2)) for x in range(w)]
    segs, start = [], None
    for x, on in enumerate(cols + [False]):
        if on and start is None:
            start = x
        elif not on and start is not None:
            segs.append((start, x))
            start = None
    # specks (a sparkle, a stray dot) are not poses: the biggest `count` pieces are
    sized = sorted(segs, key=lambda s: -sum(1 for x in range(s[0], s[1]) for y in range(0, h, 2) if a.getpixel((x, y))))
    keep = sorted(sized[:count]) if count else segs
    cuts = []
    for x0, x1 in keep:
        piece = im.crop((x0, 0, x1, h))
        box = piece.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
        if box:
            cuts.append(piece.crop(box))
    if not cuts:
        return []
    cw, ch = max(c.width for c in cuts), max(c.height for c in cuts)
    out = []
    for c in cuts:
        f = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        f.alpha_composite(c, ((cw - c.width) // 2, ch - c.height))
        out.append(f)
    return out


# ───────────── size, place, write

def shared_box(frames):
    boxes = [f.getchannel("A").point(lambda a: 255 if a > 40 else 0).getbbox() for f in frames]
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def fit(frames, height, pixel):
    box = shared_box(frames)
    if box:
        frames = [f.crop(box) for f in frames]
    w, h = frames[0].size
    s = height / h
    small = pixel or h <= 64
    size = (max(1, round(w * s)), height)
    return [f.resize(size, Image.NEAREST if small else Image.LANCZOS) for f in frames]


def pixelate(frames, cells, colors=16):
    """Found art made pixel art: shrunk to `cells` pixels high, a few shared colours, hard edges; scaled back
    up later with NEAREST (fit with pixel=True). Transparency is kept as on/off."""
    w, h = frames[0].size
    size = (max(1, round(w * cells / h)), cells)
    small = [f.resize(size, Image.BOX) for f in frames]
    # one palette for every frame, so colours don't flicker between frames
    strip = Image.new("RGB", (size[0] * len(small), size[1]))
    for i, f in enumerate(small):
        strip.paste(f.convert("RGB"), (i * size[0], 0))
    # octree keeps small bright areas (cheeks, eyes) that median cut folds into the big ones
    pal = strip.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
    rgb = pal.getpalette()[: colors * 3]
    shades = [tuple(rgb[i : i + 3]) for i in range(0, len(rgb), 3)]
    ink = min(shades, key=lambda c: c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) if shades else (40, 30, 30)
    out = []
    for f in small:
        q = f.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE).convert("RGBA")
        a = f.getchannel("A").point(lambda v: 255 if v >= 110 else 0)
        q.putalpha(a)
        # a one-pixel outline in the darkest colour, where the character meets the background
        px, al = q.load(), a.load()
        W, H = q.size
        for y in range(H):
            for x in range(W):
                if al[x, y] and any(not (0 <= x + dx < W and 0 <= y + dy < H) or not al[x + dx, y + dy] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    px[x, y] = (*ink[:3], 255)
        out.append(q)
    return out


def write_gif(frames, ms, out):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pal = []
    for f in frames:
        a = f.getchannel("A")
        q = f.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        p = q.getpalette()[: 255 * 3]
        p += [0, 0, 0] * (256 - len(p) // 3)
        q.putpalette(p)
        mask = a.point(lambda v: 255 if v < 128 else 0)
        q.paste(255, mask=mask)
        pal.append(q)
    if isinstance(ms, int):
        ms = [ms] * len(frames)
    pal[0].save(out, save_all=True, append_images=pal[1:], duration=ms, loop=0, transparency=255, disposal=2, optimize=False)
    return out


# ───────────── one picture, every act

def canvas_for(img, head=0.45, side=0.25):
    w, h = img.size
    return round(w * (1 + 2 * side)), round(h * (1 + head))


def place(img, cw, ch, dx=0, dy=0, sx=1.0, sy=1.0, rot=0.0):
    w, h = img.size
    im = img.resize((max(1, round(w * sx)), max(1, round(h * sy))), Image.NEAREST if w <= 96 else Image.LANCZOS)
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
    c = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    x = (cw - im.width) // 2 + round(dx)
    y = ch - im.height + round(dy)
    c.alpha_composite(im, (x, max(0, y)))
    return c, (x, y, im.width, im.height)


def sparkle(d, x, y, r, col=(255, 200, 60, 255)):
    d.line([(x - r, y), (x + r, y)], fill=col, width=max(1, r // 3))
    d.line([(x, y - r), (x, y + r)], fill=col, width=max(1, r // 3))


def zz(d, x, y, r, col=(110, 170, 255, 255)):
    w = max(1, r // 4)
    d.line([(x, y), (x + r, y), (x, y + r), (x + r, y + r)], fill=col, width=w)


def acts_from(img, only=None):
    img = img.copy()
    w, h = img.size
    cw, ch = canvas_for(img)
    u = h / 24  # one "step" of movement, scaled to the picture
    acts = {}
    acts["idle"] = ([place(img, cw, ch, sy=s, sx=2 - s)[0] for s in (1.0, 0.975, 1.0, 0.975)], [420] * 4)
    acts["walk"] = ([place(img, cw, ch, dy=-u * b, rot=r)[0] for b, r in ((0, -3), (1, 0), (0, 3), (1, 0))], [150] * 4)
    acts["sit"] = ([place(img, cw, ch, sy=0.86, sx=1.06)[0], place(img, cw, ch, sy=0.84, sx=1.07)[0]], [1400, 900])
    sleep = []
    for i in range(4):
        c, (x, y, iw, ih) = place(img, cw, ch, sy=0.82, sx=1.08)
        d = ImageDraw.Draw(c)
        zz(d, x + iw - u, y - u * (1 + i), max(4, round(u * 2.2)))
        if i >= 2:
            zz(d, x + iw + u, y - u * (5 + i), max(5, round(u * 3)))
        sleep.append(c)
    acts["sleep"] = (sleep, [600] * 4)
    acts["fall"] = ([place(img, cw, ch, rot=r, dy=-u * 2)[0] for r in (8, -8)], [120, 120])
    acts["drag"] = ([place(img, cw, ch, rot=r, sy=1.04, dy=-u * 3)[0] for r in (-10, 10)], [220, 220])
    happy = []
    for b in (0, 5, 8, 5):
        c, (x, y, iw, ih) = place(img, cw, ch, dy=-u * b)
        if b >= 5:
            d = ImageDraw.Draw(c)
            sparkle(d, max(4, x - u), y + u * 2, max(3, round(u * 1.5)))
            sparkle(d, min(cw - 4, x + iw + u), y + u * 4, max(3, round(u * 1.5)))
        happy.append(c)
    acts["happy"] = (happy, [110, 110, 140, 110])
    alert = []
    for i in range(4):
        c, (x, y, iw, ih) = place(img, cw, ch, dx=(u * 0.8) * (1 if i % 2 else -1))
        if i % 2 == 0:
            d = ImageDraw.Draw(c)
            bx, by, bw = x + iw - u, max(1, y - u * 7), max(2, round(u * 1.4))
            d.rectangle([bx, by, bx + bw, by + u * 4], fill=(235, 80, 70, 255))
            d.rectangle([bx, by + u * 5, bx + bw, by + u * 6], fill=(235, 80, 70, 255))
        alert.append(c)
    acts["alert"] = (alert, [240] * 4)
    sad = []
    for i in range(2):
        c, (x, y, iw, ih) = place(img, cw, ch, sy=0.94, rot=4)
        d = ImageDraw.Draw(c)
        r = max(2, round(u))
        d.ellipse([x + iw - r * 2, y + u * (3 + i), x + iw, y + u * (3 + i) + r * 3], fill=(150, 200, 255, 255))
        sad.append(c)
    acts["sad"] = (sad, [700, 700])
    work = []
    for i in range(4):
        c, (x, y, iw, ih) = place(img, cw, ch, dy=-u * (i % 2) * 0.5, sy=0.95)
        d = ImageDraw.Draw(c)
        lw, lh = iw * 0.55, u * 4
        lx = (cw - lw) / 2
        d.polygon([(lx + u, ch - lh), (lx + lw - u, ch - lh), (lx + lw, ch - 1), (lx, ch - 1)], fill=(120, 128, 140, 255), outline=(70, 76, 88, 255))
        work.append(c)
    acts["work"] = (work, [160] * 4)
    # clicked: a quick wiggle and a heart
    poke = []
    for i, rot in enumerate((-7, 7, -4, 4)):
        c, (x, y, iw, ih) = place(img, cw, ch, rot=rot, sy=0.96, sx=1.03)
        d = ImageDraw.Draw(c)
        r = max(2, round(u * 1.2))
        hx, hy = min(cw - 3 * r, x + iw), max(1, y - u * (2 + i))
        d.ellipse([hx - r, hy, hx, hy + r], fill=(240, 90, 120, 255))
        d.ellipse([hx, hy, hx + r, hy + r], fill=(240, 90, 120, 255))
        d.polygon([(hx - r, hy + r * 0.6), (hx + r, hy + r * 0.6), (hx, hy + r * 1.8)], fill=(240, 90, 120, 255))
        poke.append(c)
    acts["poke"] = (poke, [120, 120, 140, 160])
    # nothing going on: looks one way, the other, stretches up
    acts["play"] = ([place(img, cw, ch, rot=-6, dx=-u)[0], place(img, cw, ch, rot=6, dx=u)[0], place(img, cw, ch, sy=1.07, sx=0.95)[0], place(img, cw, ch)[0]], [500, 500, 600, 300])
    # on a wall (turned by the app): a step bob, and holding still
    acts["climb"] = ([place(img, cw, ch, dy=-u * b, rot=r)[0] for b, r in ((0, -2), (1, 2))], [180, 180])
    acts["cling"] = ([place(img, cw, ch, sy=0.98)[0], place(img, cw, ch)[0]], [900, 900])
    return {k: v for k, v in acts.items() if not only or k in only}


# ───────────── check

def shape(f, n=40):
    """the character cut to itself and squeezed to n×n: sliding and stretching taken away"""
    box = f.getchannel("A").point(lambda v: 255 if v > 64 else 0).getbbox()
    if not box:
        return None
    b = f.convert("RGBA").crop(box).resize((n, n), Image.BILINEAR).tobytes()
    return [tuple(b[i:i + 4]) for i in range(0, len(b), 4)]


def unlike(p, q):
    """the share of the character's pixels that differ between two shapes"""
    on = diff = 0
    for x, y in zip(p, q):
        if x[3] > 64 or y[3] > 64:
            on += 1
            if (x[3] > 64) != (y[3] > 64) or sum(abs(a - b) for a, b in zip(x[:3], y[:3])) > 120:
                diff += 1
    return diff / max(1, on)


MIN_POSE_CHANGE = 0.12


def pose_change(frames):
    """how much the drawing itself changes (0: one picture slid, tilted or stretched around; arms and
    legs moving: 0.15 or more): for each frame, how unlike the first it is however the first is turned"""
    frames = [f.convert("RGBA") for f in frames]
    base = frames[0]
    turned = [shape(base.rotate(a, resample=Image.BILINEAR, expand=True)) for a in range(-14, 15, 2)]
    turned = [t for t in turned if t]
    best = 0.0
    for f in frames[1:]:
        s = shape(f)
        if s and turned:
            best = max(best, min(unlike(t, s) for t in turned))
    return best


def check(petdir):
    petdir = Path(petdir)
    bad = []
    try:
        spec = json.loads((petdir / "pet.json").read_text())
    except Exception as e:
        print(f"pet.json: {e}")
        return 1
    acts = spec.get("actions") or {}
    if "idle" not in acts:
        bad.append("no idle")
    missing = [a for a in ACTS if not acts.get(a)]
    if missing:
        print(f"missing acts (they borrow another's picture): {', '.join(missing)}. A real pet has them all, each moving: make them")
    rows, heights = [], []
    for a in ACTS:
        f = acts.get(a)
        if not f:
            print(f"{a:6} (none: shows {'idle' if a != 'idle' else '-'})")
            continue
        p = petdir / f
        if "/" in f or not p.exists():
            bad.append(f"{a}: {f} missing")
            continue
        fr, ms = frames_of(p)
        w, h = fr[0].size
        box = shared_box(fr)
        if a not in ("fall", "drag", "happy", "sleep", "sit", "work", "climb", "cling") and box:
            heights.append(box[3] - box[1])
        corner = has_alpha(fr[0])
        kb = p.stat().st_size // 1024
        note = []
        if not corner:
            note.append("corners not transparent")
        if a in ("walk", "idle", "happy", "alert", "poke", "play") and len(fr) < 2:
            note.append("one frame (it won't move)")
        if a in MOVING and len(fr) >= 2:
            ch_ = pose_change(fr)
            if ch_ < MIN_POSE_CHANGE:
                note.append(f"it doesn't really move (pose change {ch_:.2f}): one picture slid, tilted or stretched; draw its frames moving (legs, arms, face)")
        if a == "sleep" and box and (box[2] - box[0]) < (box[3] - box[1]) * 0.9 and not spec.get("sleepsSitting"):
            note.append("asleep standing or sitting: lie it down (on its side, eyes closed)")
        if kb > 2048:
            note.append(f"{kb} KB, over 2 MB")
        if note:
            bad.append(f"{a}: " + ", ".join(note))
        print(f"{a:6} {f}: {len(fr)} frames, {w}x{h}, {sum(ms)} ms, {kb} KB{'  ← ' + ', '.join(note) if note else ''}")
        rows.append((a, fr))
    if heights and max(heights) > min(heights) * 1.5:
        bad.append(f"the character's height differs a lot between acts ({min(heights)}–{max(heights)} px): it will jump in size (the app draws every GIF at one scale)")
    if rows:
        cw = max(f.width for _, fr in rows for f in fr) + 8
        chh = max(f.height for _, fr in rows for f in fr) + 8
        n = max(len(fr) for _, fr in rows)
        sheet = Image.new("RGBA", (cw * min(n, 8) + 80, chh * len(rows)), (214, 226, 214, 255))
        d = ImageDraw.Draw(sheet)
        for r, (a, fr) in enumerate(rows):
            d.text((4, r * chh + 4), a, fill=(40, 40, 40, 255))
            for c, f in enumerate(fr[:8]):
                sheet.alpha_composite(f, (80 + c * cw, r * chh + chh - f.height - 4))
        sheet.save(petdir / "preview.png")
        print(f"preview: {petdir / 'preview.png'}")
    for b in bad:
        print("PROBLEM", b)
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("clean", "sheet", "still", "strip"):
        p = sub.add_parser(name)
        p.add_argument("src")
        p.add_argument("out")
        p.add_argument("--height", type=int, default=96)
        p.add_argument("--tol", type=float, default=28)
        p.add_argument("--pixel", action="store_true")
        p.add_argument("--pixelate", type=int, default=0, help="make found art pixel art, this many pixels high (32-64)")
        p.add_argument("--colors", type=int, default=24)
        if name != "still":
            p.add_argument("--ms", type=int, default=0)
        if name == "clean":
            p.add_argument("--frames", default="")
        if name == "sheet":
            p.add_argument("--grid", required=True)
            p.add_argument("--cells", required=True)
        if name == "still":
            p.add_argument("--only", default="")
        if name == "strip":
            p.add_argument("--count", type=int, default=0, help="how many poses the strip has (the biggest pieces are kept)")
    c = sub.add_parser("check")
    c.add_argument("petdir")
    a = ap.parse_args()

    if a.cmd == "check":
        sys.exit(check(a.petdir))
    if a.cmd == "clean":
        fr, ms = frames_of(a.src, parse_range(a.frames))
    elif a.cmd == "strip":
        im = unbackground(Image.open(a.src).convert("RGBA"), a.tol)
        fr = split_strip(im, a.count)
        if not fr:
            sys.exit("strip: no poses found (is the background one flat colour?)")
        if a.count and len(fr) < a.count:
            print(f"strip: found {len(fr)} poses, not {a.count} (some touch: ask for more space between them)")
        ms = [a.ms or 120] * len(fr)
    elif a.cmd == "sheet":
        cols, rows = (int(v) for v in a.grid.lower().split("x"))
        im = Image.open(a.src).convert("RGBA")
        cw, chh = im.width // cols, im.height // rows
        lo, hi = parse_range(a.cells)
        fr = [im.crop(((i % cols) * cw, (i // cols) * chh, (i % cols + 1) * cw, (i // cols + 1) * chh)) for i in range(lo, hi + 1)]
        ms = [120] * len(fr)
    else:
        fr, _ = frames_of(a.src)
        one = [unbackground(fr[0], a.tol)]
        if a.pixelate:
            one = pixelate(fit(one, one[0].height, False), a.pixelate, a.colors)
        img = fit(one, a.height, a.pixel or bool(a.pixelate))[0]
        only = set(x for x in a.only.split(",") if x)
        out = Path(a.out)
        for act, (frames, ms) in acts_from(img, only).items():
            # every act on one canvas size, feet on the bottom
            write_gif(frames, ms, out / f"{act}.gif")
            print(f"{act}: {out / (act + '.gif')} ({len(frames)} frames)")
        return
    fr = [unbackground(f, a.tol) for f in fr]
    if a.pixelate:
        fr = pixelate(fit(fr, fr[0].height, False), a.pixelate, a.colors)
    fr = fit(fr, a.height, a.pixel or bool(a.pixelate))
    if a.ms:
        ms = [a.ms] * len(fr)
    out = write_gif(fr, ms, a.out)
    print(f"{out}: {len(fr)} frames, {fr[0].width}x{fr[0].height}")


if __name__ == "__main__":
    main()
