#!/usr/bin/env python3
"""Read Word, Excel, PowerPoint and Hangul (HWPX) files with nothing but Python.

    office.py outline <file>              what is inside: parts, sheets, slides, counts
    office.py text <file> [--rows 200]    the content as plain markdown-like text

.docx  paragraphs (headings as #), lists, tables as rows, headers and footers;
       text deleted in tracked changes is left out, inserted text is kept
.xlsx  every sheet (hidden ones marked), one row per line, formulas shown as
       `=SUM(B2:B3) → 350` with the value Excel saved; dates stay as serial numbers
.pptx  slides in order: title, text, and the speaker notes
.hwpx  paragraphs and tables of every section (binary .hwp is not readable here)

Office files are zip archives of XML: this only reads them, never writes, and
prints nothing it did not find in the file.
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from posixpath import dirname, join, normpath

R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def attr(el, name):
    """An attribute by its local name, whatever its namespace."""
    for k, v in el.attrib.items():
        if local(k) == name:
            return v
    return None


class Package:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        self.names = set(self.zip.namelist())

    def xml(self, name):
        return ET.fromstring(self.zip.read(name)) if name in self.names else None

    def rels(self, part):
        """{relationship id: (target part, type)} for one part."""
        rel = join(dirname(part), "_rels", part.rsplit("/", 1)[-1] + ".rels")
        root = self.xml(rel)
        out = {}
        for r in [] if root is None else root:
            target = r.get("Target", "")
            if r.get("TargetMode") != "External":
                target = normpath(join(dirname(part), target)).lstrip("/") if not target.startswith("/") else target[1:]
            out[r.get("Id")] = (target, r.get("Type", "").rsplit("/", 1)[-1])
        return out


# ─────────────────────────────── Word

def word_styles(pkg):
    """styleId → style name ("heading 1", "Title", "List Bullet"…), so localized ids still read."""
    root = pkg.xml("word/styles.xml")
    out = {}
    for s in [] if root is None else root:
        if local(s.tag) != "style":
            continue
        name = next((attr(c, "val") for c in s if local(c.tag) == "name"), None)
        out[attr(s, "styleId")] = (name or "").lower()
    return out


def word_runs(p):
    parts = []
    for el in p.iter():
        t = local(el.tag)
        if t == "t":
            parts.append(el.text or "")
        elif t == "tab":
            parts.append("\t")
        elif t in ("br", "cr"):
            parts.append("\n")
    return "".join(parts)


def word_para(p, styles):
    # text inside <w:del> is gone from the document; drop it before reading
    for parent in p.iter():
        for child in list(parent):
            if local(child.tag) == "del":
                parent.remove(child)
    text = word_runs(p).strip()
    if not text:
        return ""
    ppr = next((c for c in p if local(c.tag) == "pPr"), None)
    style, listed = "", False
    if ppr is not None:
        for c in ppr:
            if local(c.tag) == "pStyle":
                style = styles.get(attr(c, "val"), attr(c, "val") or "").lower()
            if local(c.tag) == "numPr":
                listed = True
    m = re.match(r"heading (\d)", style)
    if m:
        return "#" * min(int(m.group(1)) + 1, 6) + " " + text
    if style == "title":
        return "# " + text
    if listed or style.startswith("list"):
        return "- " + text
    return text


def word_block(el, styles, out):
    for c in el:
        t = local(c.tag)
        if t == "p":
            line = word_para(c, styles)
            if line:
                out.append(line)
        elif t == "tbl":
            out.append("")
            for tr in (x for x in c if local(x.tag) == "tr"):
                cells = []
                for tc in (x for x in tr if local(x.tag) == "tc"):
                    inner = []
                    word_block(tc, styles, inner)
                    cells.append(" ".join(inner).replace("|", "\\|"))
                out.append("| " + " | ".join(cells) + " |")
            out.append("")
        elif t in ("sdt", "sdtContent", "customXml", "ins"):
            word_block(c, styles, out)


def word_text(pkg):
    styles = word_styles(pkg)
    out = []
    for kind in ("header", "footer"):
        for name in sorted(n for n in pkg.names if re.match(rf"word/{kind}\d*\.xml$", n)):
            lines = []
            word_block(pkg.xml(name), styles, lines)
            if any(lines):
                out.append(f"[{kind}] " + " / ".join(l for l in lines if l))
    body = pkg.xml("word/document.xml")
    body = next((c for c in body if local(c.tag) == "body"), body)
    if out:
        out.append("")
    word_block(body, styles, out)
    return out


def word_outline(pkg):
    doc = pkg.xml("word/document.xml")
    count = lambda name: sum(1 for e in doc.iter() if local(e.tag) == name)
    styles = word_styles(pkg)
    heads = [l for l in word_text(pkg) if l.startswith("#")]
    comments = pkg.xml("word/comments.xml")
    lines = [
        f"paragraphs {count('p')}, tables {count('tbl')}, pictures {count('drawing') + count('pict')}, sections {count('sectPr')}",
        f"tracked changes: {count('ins')} insertions, {count('del')} deletions" if count("ins") or count("del") else "tracked changes: none",
        f"comments: {0 if comments is None else sum(1 for c in comments if local(c.tag) == 'comment')}",
        f"headers/footers: {sum(1 for n in pkg.names if re.match(r'word/(header|footer)\d*\.xml$', n))}",
        f"styles defined: {len(styles)}",
    ]
    if heads:
        lines += ["headings:"] + ["  " + h for h in heads[:60]]
    return lines


# ─────────────────────────────── Excel

def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n


def excel_sheets(pkg):
    wb = pkg.xml("xl/workbook.xml")
    rels = pkg.rels("xl/workbook.xml")
    sheets = []
    for s in wb.iter():
        if local(s.tag) == "sheet":
            target = rels.get(s.get(R_ID), ("", ""))[0]
            sheets.append((s.get("name"), s.get("state", "visible"), target))
    return sheets, wb


def shared_strings(pkg):
    root = pkg.xml("xl/sharedStrings.xml")
    if root is None:
        return []
    return ["".join(t.text or "" for t in si.iter() if local(t.tag) == "t") for si in root if local(si.tag) == "si"]


def excel_cell(c, strings):
    kind = c.get("t", "n")
    f = next((x.text for x in c if local(x.tag) == "f"), None)
    v = next((x.text for x in c if local(x.tag) == "v"), None)
    if kind == "s" and v is not None:
        v = strings[int(v)] if int(v) < len(strings) else v
    elif kind == "inlineStr":
        v = "".join(t.text or "" for t in c.iter() if local(t.tag) == "t")
    elif kind == "b" and v is not None:
        v = "TRUE" if v == "1" else "FALSE"
    if f is not None:
        return f"={f} → {v if v is not None else '(no saved value)'}"
    return v or ""


def excel_text(pkg, max_rows):
    strings = shared_strings(pkg)
    sheets, _ = excel_sheets(pkg)
    out = []
    for name, state, target in sheets:
        root = pkg.xml(target)
        out.append(f"## {name}" + ("" if state == "visible" else f" ({state})"))
        if root is None:
            out.append("(not a worksheet: a chart sheet or missing part)")
            continue
        rows = [r for r in root.iter() if local(r.tag) == "row"]
        for r in rows[:max_rows]:
            cells = {}
            for c in r:
                if local(c.tag) == "c":
                    val = excel_cell(c, strings)
                    if val != "":
                        cells[col_index(c.get("r", "A"))] = val.replace("|", "\\|")
            if cells:
                width = max(cells)
                out.append(f"{r.get('r', '?'):>4} | " + " | ".join(cells.get(i, "") for i in range(1, width + 1)))
        if len(rows) > max_rows:
            out.append(f"… {len(rows) - max_rows} more rows (--rows to raise)")
        out.append("")
    return out


def excel_outline(pkg):
    sheets, wb = excel_sheets(pkg)
    lines = []
    for name, state, target in sheets:
        root = pkg.xml(target)
        if root is None:
            lines.append(f"{name}: not a worksheet")
            continue
        dim = next((attr(d, "ref") for d in root.iter() if local(d.tag) == "dimension"), "?")
        cells = [c for c in root.iter() if local(c.tag) == "c"]
        formulas = sum(1 for c in cells for x in c if local(x.tag) == "f")
        merged = sum(1 for m in root.iter() if local(m.tag) == "mergeCell")
        drawings = sum(1 for d in root.iter() if local(d.tag) == "drawing")
        lines.append(
            f"{name}{'' if state == 'visible' else f' ({state})'}: range {dim}, {len(cells)} cells, "
            f"{formulas} formulas, {merged} merged ranges{', has drawings/charts' if drawings else ''}"
        )
    names = [(d.get("name"), d.text) for d in wb.iter() if local(d.tag) == "definedName"]
    if names:
        lines += ["defined names:"] + [f"  {n} = {v}" for n, v in names[:40]]
    if "xl/vbaProject.bin" in pkg.names:
        lines.append("has macros (xl/vbaProject.bin): keep the .xlsm extension when saving")
    if any(n.startswith("xl/externalLinks/") for n in pkg.names):
        lines.append("links to other workbooks (xl/externalLinks/)")
    return lines


# ─────────────────────────────── PowerPoint

def slide_parts(pkg):
    pres = pkg.xml("ppt/presentation.xml")
    rels = pkg.rels("ppt/presentation.xml")
    return [rels[s.get(R_ID)][0] for s in pres.iter() if local(s.tag) == "sldId" and s.get(R_ID) in rels]


def shape_paras(sp):
    return ["".join(t.text or "" for t in p.iter() if local(t.tag) == "t") for p in sp.iter() if local(p.tag) == "p"]


def slide_read(pkg, part):
    root = pkg.xml(part)
    title, body = "", []
    for sp in root.iter():
        if local(sp.tag) not in ("sp", "graphicFrame"):
            continue
        ph = next((e for e in sp.iter() if local(e.tag) == "ph"), None)
        paras = [p for p in shape_paras(sp) if p.strip()]
        if ph is not None and ph.get("type") in ("title", "ctrTitle") and not title:
            title = " ".join(paras)
        elif ph is not None and ph.get("type") in ("sldNum", "dt", "ftr"):
            continue
        else:
            body += paras
    rels = pkg.rels(part)
    notes, layout = [], ""
    for target, kind in rels.values():
        if kind == "notesSlide":
            for sp in pkg.xml(target).iter():
                ph = next((e for e in sp.iter() if local(e.tag) == "ph"), None) if local(sp.tag) == "sp" else None
                if ph is not None and ph.get("type") == "body":
                    notes += [p for p in shape_paras(sp) if p.strip()]
        if kind == "slideLayout":
            cs = next((e for e in pkg.xml(target).iter() if local(e.tag) == "cSld"), None)
            layout = cs.get("name", "") if cs is not None else ""
    pictures = sum(1 for e in root.iter() if local(e.tag) == "pic")
    return title, body, notes, layout, pictures


def slides_text(pkg):
    out = []
    for i, part in enumerate(slide_parts(pkg), 1):
        title, body, notes, _, _ = slide_read(pkg, part)
        out.append(f"## {i}. {title or '(no title)'}")
        out += ["- " + b for b in body]
        if notes:
            out.append("notes: " + " / ".join(notes))
        out.append("")
    return out


def slides_outline(pkg):
    lines = []
    for i, part in enumerate(slide_parts(pkg), 1):
        title, body, notes, layout, pics = slide_read(pkg, part)
        lines.append(f"{i:>3}. [{layout or '?'}] {title or '(no title)'}: {len(body)} text lines, {pics} pictures{', notes' if notes else ''}")
    media = [n for n in pkg.names if n.startswith("ppt/media/")]
    lines.append(f"layouts {sum(1 for n in pkg.names if re.match(r'ppt/slideLayouts/slideLayout\d+\.xml$', n))}, media files {len(media)}")
    return lines


# ─────────────────────────────── Hangul (HWPX)

def hwpx_walk(el, out):
    for c in el:
        t = local(c.tag)
        if t == "tbl":
            out.append("")
            for tr in (x for x in c.iter() if local(x.tag) == "tr"):
                cells = []
                for tc in (x for x in tr if local(x.tag) == "tc"):
                    inner = []
                    hwpx_walk(tc, inner)
                    cells.append(" ".join(i for i in inner if i).replace("|", "\\|"))
                out.append("| " + " | ".join(cells) + " |")
            out.append("")
        elif t == "p":
            text, nested = [], []
            for run in c:
                for x in run:
                    if local(x.tag) == "t":
                        text.append("".join(x.itertext()))
                    elif local(x.tag) == "tbl":
                        hwpx_walk(run, nested)
                        break
            if "".join(text).strip():
                out.append("".join(text).strip())
            out += nested
        else:
            hwpx_walk(c, out)


def hwpx_sections(pkg):
    key = lambda n: int(re.search(r"(\d+)", n.rsplit("/", 1)[-1]).group(1))
    return sorted((n for n in pkg.names if re.match(r"Contents/section\d+\.xml$", n)), key=key)


def hwpx_text(pkg):
    out = []
    for name in hwpx_sections(pkg):
        hwpx_walk(pkg.xml(name), out)
    return out


def hwpx_outline(pkg):
    lines = []
    for name in hwpx_sections(pkg):
        root = pkg.xml(name)
        n = lambda tag: sum(1 for e in root.iter() if local(e.tag) == tag)
        lines.append(f"{name}: {n('p')} paragraphs, {n('tbl')} tables, {n('pic')} pictures")
    return lines


# ─────────────────────────────── main

READERS = {
    "docx": (word_outline, word_text),
    "docm": (word_outline, word_text),
    "xlsx": (excel_outline, excel_text),
    "xlsm": (excel_outline, excel_text),
    "pptx": (slides_outline, slides_text),
    "pptm": (slides_outline, slides_text),
    "hwpx": (hwpx_outline, hwpx_text),
}


def main(argv):
    if len(argv) < 2 or argv[0] not in ("outline", "text"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    cmd, path = argv[0], argv[1]
    rows = int(argv[argv.index("--rows") + 1]) if "--rows" in argv else 200
    ext = path.rsplit(".", 1)[-1].lower()
    if ext in ("doc", "xls", "ppt", "hwp"):
        print(f".{ext} is the old binary format: convert it first (office-docs SKILL.md, 'Old formats').", file=sys.stderr)
        return 1
    if ext not in READERS or not zipfile.is_zipfile(path):
        print(f"not a readable .docx/.xlsx/.pptx/.hwpx file: {path}", file=sys.stderr)
        return 1
    pkg = Package(path)
    bad = pkg.zip.testzip()
    if bad:
        print(f"damaged archive member: {bad}", file=sys.stderr)
    outline, text = READERS[ext]
    if cmd == "outline":
        print("\n".join(outline(pkg)))
    else:
        lines = text(pkg, rows) if text is excel_text else text(pkg)
        print(re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
