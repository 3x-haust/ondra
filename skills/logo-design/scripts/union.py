#!/usr/bin/env python3
"""Final outlines: strokes expanded, overlaps merged, one clean <path> per colour.

    python3 union.py <in.svg> <out.svg> [--precision 2]

Shapes that only touch or overlap leave faint seams when rendered (each edge is
anti-aliased on its own) and confuse anyone who edits the file later. This turns every
shape (path, circle, ellipse, rect, polygon, polyline, line; transforms applied; strokes
expanded with their width, caps and joins) into filled outlines, merges the ones that
share a colour, and writes them in their first paint order. The #construction layer,
<text>, <image>, gradients and filters are not handled: draw those as outlines first.

Needs skia-pathops and fontTools: python3 -m pip install --user skia-pathops fonttools
"""
import argparse
import re
import sys
import xml.etree.ElementTree as ET

try:
    import pathops
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.svgLib.path import parse_path
except ImportError:
    sys.exit("missing: python3 -m pip install --user skia-pathops fonttools")

NS = "{http://www.w3.org/2000/svg}"
SHAPES = {"path", "circle", "ellipse", "rect", "polygon", "polyline", "line"}


def tag(el):
    return el.tag.replace(NS, "")


def style_of(el):
    st = {}
    for k in ("fill", "stroke", "stroke-width", "fill-rule", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "display"):
        if el.get(k) is not None:
            st[k] = el.get(k).strip()
    for decl in (el.get("style") or "").split(";"):
        if ":" in decl:
            k, v = decl.split(":", 1)
            st[k.strip()] = v.strip()
    return st


def mul(a, b):
    a1, b1, c1, d1, e1, f1 = a
    a2, b2, c2, d2, e2, f2 = b
    return (a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1)


def parse_transform(s):
    import math
    m = (1, 0, 0, 1, 0, 0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(x) for x in re.split(r"[\s,]+", args.strip()) if x]
        if name == "matrix":
            t = tuple(v)
        elif name == "translate":
            t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            a = math.radians(v[0])
            t = (math.cos(a), math.sin(a), -math.sin(a), math.cos(a), 0, 0)
            if len(v) == 3:
                t = mul(mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "skewX":
            t = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewY":
            t = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        else:
            continue
        m = mul(m, t)
    return m


def shape_d(el):
    t, g = tag(el), lambda k, d=0.0: float(el.get(k, d) or d)
    if t == "path":
        return el.get("d", "")
    if t in ("circle", "ellipse"):
        cx, cy = g("cx"), g("cy")
        rx, ry = (g("r"), g("r")) if t == "circle" else (g("rx"), g("ry"))
        return f"M{cx + rx},{cy}A{rx},{ry} 0 1 1 {cx - rx},{cy}A{rx},{ry} 0 1 1 {cx + rx},{cy}Z"
    if t == "rect":
        x, y, w, h = g("x"), g("y"), g("width"), g("height")
        rx = el.get("rx") or el.get("ry")
        r = min(float(rx), w / 2, h / 2) if rx else 0
        if not r:
            return f"M{x},{y}H{x + w}V{y + h}H{x}Z"
        return (f"M{x + r},{y}H{x + w - r}A{r},{r} 0 0 1 {x + w},{y + r}V{y + h - r}A{r},{r} 0 0 1 {x + w - r},{y + h}"
                f"H{x + r}A{r},{r} 0 0 1 {x},{y + h - r}V{y + r}A{r},{r} 0 0 1 {x + r},{y}Z")
    if t in ("polygon", "polyline"):
        pts = re.split(r"[\s,]+", (el.get("points") or "").strip())
        pairs = [f"{pts[i]},{pts[i + 1]}" for i in range(0, len(pts) - 1, 2)]
        return "M" + "L".join(pairs) + ("Z" if t == "polygon" else "")
    if t == "line":
        return f"M{g('x1')},{g('y1')}L{g('x2')},{g('y2')}"
    return ""


def to_path(d, matrix, evenodd):
    p = pathops.Path(fillType=pathops.FillType.EVEN_ODD if evenodd else pathops.FillType.WINDING)
    parse_path(d, TransformPen(p.getPen(), matrix))
    return p


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--precision", type=int, default=2)
    a = ap.parse_args()
    ET.register_namespace("", NS[1:-1])
    root = ET.parse(a.src).getroot()
    layers = {}          # colour → [pathops.Path]
    order = []

    def walk(el, inherited, matrix):
        if el.get("id") == "construction" or tag(el) in ("defs", "style", "title", "desc", "metadata", "clipPath", "mask"):
            return
        st = {**inherited, **style_of(el)}
        if st.get("display") == "none":
            return
        m = mul(matrix, parse_transform(el.get("transform")))
        t = tag(el)
        if t in ("text", "image"):
            sys.exit(f"<{t}> found: convert it to outlines first")
        if t in SHAPES:
            d = shape_d(el)
            fill = st.get("fill", "#000000")
            if fill not in ("none", "transparent") and t not in ("line", "polyline"):
                add(fill, to_path(d, m, st.get("fill-rule") == "evenodd"))
            stroke = st.get("stroke", "none")
            if stroke not in ("none", "transparent"):
                w = float(re.sub(r"[a-z%]+$", "", st.get("stroke-width", "1")))
                cap = {"round": pathops.LineCap.ROUND_CAP, "square": pathops.LineCap.SQUARE_CAP}.get(st.get("stroke-linecap"), pathops.LineCap.BUTT_CAP)
                join = {"round": pathops.LineJoin.ROUND_JOIN, "bevel": pathops.LineJoin.BEVEL_JOIN}.get(st.get("stroke-linejoin"), pathops.LineJoin.MITER_JOIN)
                p = pathops.Path()
                parse_path(d, p.getPen())                  # stroke in the shape's own units, then transform
                p.stroke(w, cap, join, float(st.get("stroke-miterlimit", 4)))
                q = pathops.Path()
                p.draw(TransformPen(q.getPen(), m))
                add(stroke, q)
        for c in el:
            walk(c, {k: v for k, v in st.items() if k != "display"}, m)

    def add(colour, p):
        p.simplify()
        if colour not in layers:
            layers[colour] = []
            order.append(colour)
        layers[colour].append(p)

    walk(root, {}, (1, 0, 0, 1, 0, 0))
    out = ET.Element(f"{NS}svg", {"viewBox": root.get("viewBox") or f"0 0 {root.get('width')} {root.get('height')}"})
    for colour in order:
        merged = pathops.Path()
        for p in layers[colour]:
            merged = pathops.op(merged, p, pathops.PathOp.UNION)
        pen = SVGPathPen(None, ntos=lambda v: (f"{v:.{a.precision}f}".rstrip("0").rstrip(".") or "0"))
        merged.draw(pen)
        ET.SubElement(out, f"{NS}path", {"fill": colour, "d": pen.getCommands()})
    ET.ElementTree(out).write(a.out, encoding="unicode")
    print(f"{a.out}  ({len(order)} colour(s), {sum(len(v) for v in layers.values())} shapes merged)")


if __name__ == "__main__":
    main()
