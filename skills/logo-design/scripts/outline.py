#!/usr/bin/env python3
"""Set text in a font and write it as SVG outlines (no <text>, no font needed to view it).

    python3 outline.py <font.ttf|otf|ttc> "Text" <out.svg> [--axes wght=650,opsz=32]
        [--tracking 20] [--kern "Ta:-40,ra:-10"] [--index 0] [--fill "#111"] [--info]

--tracking and --kern are in thousandths of an em (tracking is added between every pair,
--kern adds to one pair on top of the font's own kerning). --axes instantiates a variable
font. One <path> per glyph, id "g<i>" and data-char, so letters can be edited one by one.
The viewBox is the ink box with no margin. --info prints the font's metrics and names.

Needs fontTools (`python3 -m pip install --user fonttools`). Use fonts whose licence
allows it (OFL / Apache, e.g. from github.com/google/fonts) and keep the licence with the kit.
"""
import argparse
import sys

try:
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.transformPen import TransformPen
except ImportError:
    sys.exit("fontTools is missing: python3 -m pip install --user fonttools")


def gpos_kerning(font):
    """Pair kerning from GPOS 'kern' (PairPos format 1 and 2), as {(left, right): x_advance}."""
    pairs, classes = {}, []
    if "GPOS" not in font:
        return pairs, classes
    table = font["GPOS"].table
    lookups = set()
    for rec in table.FeatureList.FeatureRecord if table.FeatureList else []:
        if rec.FeatureTag == "kern":
            lookups.update(rec.Feature.LookupListIndex)
    for li in sorted(lookups):
        lookup = table.LookupList.Lookup[li]
        if lookup.LookupType not in (2, 9):
            continue
        for sub in lookup.SubTable:
            if lookup.LookupType == 9:
                if sub.ExtensionLookupType != 2:
                    continue
                sub = sub.ExtSubTable
            if sub.Format == 1:
                for first, pset in zip(sub.Coverage.glyphs, sub.PairSet):
                    for rec in pset.PairValueRecord:
                        v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                        if v and (first, rec.SecondGlyph) not in pairs:
                            pairs[(first, rec.SecondGlyph)] = v
            elif sub.Format == 2:
                classes.append(sub)
    return pairs, classes


def class_kern(subs, left, right):
    for sub in subs:
        if left not in sub.Coverage.glyphs:
            continue
        c1 = sub.ClassDef1.classDefs.get(left, 0)
        c2 = sub.ClassDef2.classDefs.get(right, 0)
        rec = sub.Class1Record[c1].Class2Record[c2]
        v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
        if v:
            return v
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("font")
    ap.add_argument("text")
    ap.add_argument("out")
    ap.add_argument("--axes", default="")
    ap.add_argument("--tracking", type=float, default=0)
    ap.add_argument("--kern", default="")
    ap.add_argument("--index", type=int, default=0)
    ap.add_argument("--fill", default="#111111")
    ap.add_argument("--info", action="store_true")
    a = ap.parse_args()

    font = TTFont(a.font, fontNumber=a.index)
    if a.info:
        os2 = font["OS/2"] if "OS/2" in font else None
        lic = font["name"].getDebugName(13) or ""
        print(f"{font['name'].getDebugName(4)} · upm {font['head'].unitsPerEm} · cap {getattr(os2, 'sCapHeight', '?')} · x {getattr(os2, 'sxHeight', '?')}")
        print("licence:", lic[:200].replace("\n", " "))
        if "fvar" in font:
            print("axes:", ", ".join(f"{ax.axisTag} {ax.minValue:g}-{ax.maxValue:g}" for ax in font["fvar"].axes))
    if a.axes:
        from fontTools.varLib.instancer import instantiateVariableFont
        loc = {k: float(v) for k, v in (p.split("=") for p in a.axes.split(","))}
        font = instantiateVariableFont(font, loc)
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]

    extra = {}
    for item in filter(None, a.kern.split(",")):
        pair, val = item.rsplit(":", 1)
        extra[pair] = float(val) * upm / 1000
    pairs, class_subs = gpos_kerning(font)
    legacy = {}
    if "kern" in font:
        for t in font["kern"].kernTables:
            legacy.update(getattr(t, "kernTable", {}))

    names = []
    for ch in a.text:
        g = cmap.get(ord(ch))
        if g is None:
            sys.exit(f"the font has no glyph for {ch!r}")
        names.append((ch, g))

    x = 0.0
    paths = []
    bounds = None
    for i, (ch, g) in enumerate(names):
        if i:
            prev_ch, prev = names[i - 1]
            k = pairs.get((prev, g)) or class_kern(class_subs, prev, g) or legacy.get((prev, g), 0)
            x += k + a.tracking * upm / 1000 + extra.get(prev_ch + ch, 0)
        pen = SVGPathPen(gs)
        tpen = TransformPen(pen, (1, 0, 0, -1, x, 0))
        gs[g].draw(tpen)
        bp = BoundsPen(gs)
        gs[g].draw(TransformPen(bp, (1, 0, 0, -1, x, 0)))
        if bp.bounds:
            b = bp.bounds
            bounds = b if bounds is None else (min(bounds[0], b[0]), min(bounds[1], b[1]), max(bounds[2], b[2]), max(bounds[3], b[3]))
        d = pen.getCommands()
        if d:
            paths.append(f'<path id="g{i}" data-char="{ch}" d="{d}"/>')
        x += hmtx[g][0]
    if bounds is None:
        sys.exit("nothing to draw")
    x0, y0, x1, y1 = bounds
    w, h = x1 - x0, y1 - y0
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.1f} {y0:.1f} {w:.1f} {h:.1f}" '
           f'fill="{a.fill}">\n' + "\n".join(paths) + "\n</svg>\n")
    with open(a.out, "w") as f:
        f.write(svg)
    print(f"{a.out}  ({len(paths)} glyphs, {w:.0f}×{h:.0f} font units, upm {upm})")


if __name__ == "__main__":
    main()
